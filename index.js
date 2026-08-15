// Host half of the dsh-go-usage plugin.
// Publishes the "opencodeUsage" Typert Remote service, callable from the
// browser settings page over the /api RPC carrier.
//
// Data sources:
//  1. Official usage API GET https://opencode.ai/zen/go/v1/usage (Bearer key)
//     -> three windows (5h rolling / weekly / monthly) percent + resetsAt
//  2. DSH session logs (ctx.sessionQuery.readSession): aggregate assistant
//     messages whose provider is "opencode-go", per model: token buckets +
//     estimated cost from the official GO price table (go.mdx).
//
// Key resolution: DSH credentials OPENCODE_GO_API_KEY -> ~/.local/share/opencode/auth.json
// (opencode-go entry, falling back to opencode).
import z from "@deepseek-ai/schemastery";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1/usage";
const DEFAULT_TIMEOUT_MS = 15000;
const DSH_DAYS = 30;
const DSH_INTERVAL = 300000;
const QUICK_SCAN_LIMIT = 4;

// Official OpenCode GO per-1M-token prices (go.mdx). Values in USD.
const GO_PRICES = {
  "deepseek-v4-flash": { in: 0.14, out: 0.28, cache: 0.0028 },
  "deepseek-v4-pro": { in: 0.435, out: 0.87, cache: 0.003625 },
  "kimi-k3": { in: 3.0, out: 15.0, cache: 0.30 },
  "kimi-k2.7-code": { in: 0.95, out: 4.0, cache: 0.19 },
  "kimi-k2.6": { in: 0.95, out: 4.0, cache: 0.16 },
  "mimo-v2.5": { in: 0.14, out: 0.28, cache: 0.0028 },
  "mimo-v2.5-pro": { in: 0.435, out: 0.87, cache: 0.003625 },
  "minimax-m3": { in: 0.3, out: 1.2, cache: 0.06 },
  "minimax-m2.7": { in: 0.3, out: 1.2, cache: 0.06 },
  "minimax-m2.5": { in: 0.3, out: 1.2, cache: 0.06 },
  "glm-5.3": { in: 1.4, out: 4.4, cache: 0.26 },
  "glm-5.2": { in: 1.4, out: 4.4, cache: 0.26 },
  "glm-5.1": { in: 1.4, out: 4.4, cache: 0.26 },
  "qwen3.8-max": { in: 2.0, out: 6.0, cache: 0.25 },
  "qwen3.7-max": { in: 2.5, out: 7.5, cache: 0.5 },
  "qwen3.7-plus": { in: 0.4, out: 1.6, cache: 0.04 },
  "qwen3.6-plus": { in: 0.5, out: 3.0, cache: 0.05 },
  "gpt-5.6-luna": { in: 0.2, out: 1.2, cache: 0.02 },
  "grok-4.5": { in: 2.0, out: 6.0, cache: 0.3 },
  "hy3": { in: 0.14, out: 0.58, cache: 0.035 },
};

export const Config = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
});

/**
 * Resolve the OpenCode GO API key, most-trusted first:
 *   1. DSH credentials / env reference OPENCODE_GO_API_KEY
 *   2. OpenCode's own auth.json: opencode-go (fallback opencode) type=api key
 */
async function resolveApiKey(ctx) {
  try {
    const cred = await ctx.credentials.resolve(credentialRef("OPENCODE_GO_API_KEY"));
    if (cred && cred.value) return { key: cred.value, source: "credentials" };
  } catch {
    /* fall through */
  }
  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    if (!existsSync(authPath)) return { key: null, source: null };
    const raw = JSON.parse(await readFile(authPath, "utf8"));
    const entry = raw["opencode-go"] ?? raw["opencode"];
    const ok = entry && entry.type === "api" && typeof entry.key === "string" && entry.key.length > 0;
    if (ok) return { key: entry.key, source: "auth.json" };
  } catch {
    /* fall through */
  }
  return { key: null, source: null };
}

function pickWindow(w) {
  if (!w || typeof w !== "object") return null;
  const percent = typeof w.percent === "number" ? w.percent : Number(w.percent);
  return {
    status: typeof w.status === "string" ? w.status : null,
    percent: Number.isFinite(percent) ? percent : null,
    resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
  };
}

export class OpencodeUsageGateway extends TypertRemoteService {
  static inject = ["credentials", "settings", "sessionQuery", "timer"];
  static Config = Config;

  constructor(ctx, config) {
    super(ctx, "opencodeUsage");
    this.config = config ?? {};
    this.sessionAggs = new Map();
    this.dshState = { data: null, scanning: false, nextScan: 0 };
    ctx.effect(() => {
      this.ensureScan("full");
      const timer = this.ctx.timer;
      if (timer !== undefined) return timer.interval(() => this.ensureScan("full"), DSH_INTERVAL);
      return () => {};
    });
  }

  async usage() {
    let goInModels = null;
    try {
      const pi = this.ctx.settings.get(settingsNamespace("llm-pi-ai"));
      goInModels = !!(pi && pi.providers && pi.providers["opencode-go"]);
    } catch {
      goInModels = null;
    }

    // No account cache: every call refetches the official API so fetchedAt is
    // always fresh (the account call is cheap; the DSH aggregate stays cached).
    const ki = await resolveApiKey(this.ctx);
    const accountResult = ki.key
      ? await this.fetchAccount(ki.key)
      : { account: null, error: "no-key" };

    const dshPayload = this.dshState.data || { models: [], byDay: [], scannedSessions: 0, durationMs: 0 };
    return {
      fetchedAt: Date.now(),
      keySource: ki.source,
      goInModels,
      account: accountResult.account,
      accountError: accountResult.error,
      dsh: { ...dshPayload, scanning: this.dshState.scanning },
      dshError: this.dshState.data ? null : "scanning",
    };
  }

  async refresh() {
    this.ensureScan("quick");
    return { triggered: true };
  }

  async fetchAccount(key) {
    const baseUrl = this.config.baseUrl || DEFAULT_BASE_URL;
    const timeoutMs = this.config.timeoutMs || DEFAULT_TIMEOUT_MS;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
      let res;
      try {
        res = await fetch(baseUrl, {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json", Connection: "close" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        continue;
      }
      if (res.status === 401) return { account: null, error: "unauthorized" };
      if (res.status === 403) return { account: null, error: "no-subscription" };
      if (!res.ok) return { account: null, error: `http-${res.status}` };
      let body;
      try {
        body = await res.json();
      } catch {
        return { account: null, error: "bad-json" };
      }
      const usage = body && typeof body === "object" && body.usage ? body.usage : body;
      return {
        account: {
          rolling: pickWindow(usage && usage.rolling),
          weekly: pickWindow(usage && usage.weekly),
          monthly: pickWindow(usage && usage.monthly),
        },
        error: null,
      };
    }
    return { account: null, error: "network" };
  }

  ensureScan(mode) {
    const now = Date.now();
    if (this.dshState.scanning) return;
    if (mode !== "quick" && this.dshState.data && now < this.dshState.nextScan) return;
    this.dshState.scanning = true;
    this.aggregateDsh(mode === "quick")
      .then((data) => {
        this.dshState.data = data;
        this.dshState.nextScan = Date.now() + DSH_INTERVAL;
      })
      .catch(() => {})
      .then(() => {
        this.dshState.scanning = false;
      });
  }

  // Scan one session's events into per-session aggregates (models + daily cost).
  async scanSession(sid, cutoff) {
    const sq = this.ctx.sessionQuery;
    const byModel = {};
    const dayCosts = {};
    const snap = await sq.readSession(sid);
    const events = snap.events || [];
    for (const ev of events) {
      if (ev.type !== "assistant/message" || !ev.data || !ev.data.usage) continue;
      const t = ev.time || 0;
      if (t < cutoff) continue;
      const src = ev.data.message && ev.data.message.source;
      const provider = src && typeof src.provider === "string" ? src.provider : "unknown";
      if (provider !== "opencode-go") continue;
      const model = src && typeof src.model === "string" ? src.model : "unknown";
      const u = ev.data.usage;
      const b = byModel[model] || (byModel[model] = { count: 0, input: 0, output: 0, cacheRead: 0 });
      b.count++;
      b.input += u.inputTokens || 0;
      b.output += u.outputTokens || 0;
      b.cacheRead += u.cacheReadTokens || 0;
      const price = GO_PRICES[model];
      if (price) {
        const d = new Date(t);
        const day = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
        const cost = (u.inputTokens || 0) * price.in / 1e6 + (u.outputTokens || 0) * price.out / 1e6 + (u.cacheReadTokens || 0) * price.cache / 1e6;
        dayCosts[day] = (dayCosts[day] || 0) + cost;
      }
    }
    return { byModel, dayCosts };
  }

  // aggregateDsh(quick): quick scans only the newest sessions and merges them
  // with per-session caches from the last full scan, so a user-triggered
  // refresh stays fast (~a few seconds) without losing older sessions' data.
  async aggregateDsh(quick) {
    const sq = this.ctx.sessionQuery;
    if (sq === undefined) return null;
    const cutoff = Date.now() - DSH_DAYS * 24 * 3600 * 1000;
    const started = Date.now();
    let sessions;
    try {
      sessions = await sq.listSessions();
    } catch {
      return null;
    }
    const recent = sessions.filter((s) => (s.header && s.header.createdAt || 0) >= cutoff);
    const targets = quick ? recent.slice(0, QUICK_SCAN_LIMIT) : recent;
    await Promise.all(targets.map(async (rec) => {
      const sid = rec.header && rec.header.id;
      if (!sid) return;
      try {
        this.sessionAggs.set(sid, await this.scanSession(sid, cutoff));
      } catch {
        /* keep the previous aggregate for this session */
      }
    }));
    const totals = { byModel: {}, dayCosts: {} };
    for (const agg of this.sessionAggs.values()) {
      for (const model in agg.byModel) {
        const s = totals.byModel[model] || (totals.byModel[model] = { count: 0, input: 0, output: 0, cacheRead: 0 });
        const b = agg.byModel[model];
        s.count += b.count;
        s.input += b.input;
        s.output += b.output;
        s.cacheRead += b.cacheRead;
      }
      for (const day in agg.dayCosts) {
        totals.dayCosts[day] = (totals.dayCosts[day] || 0) + agg.dayCosts[day];
      }
    }
    const models = Object.keys(totals.byModel)
      .map((model) => {
        const b = totals.byModel[model];
        const totalTokens = b.input + b.output + b.cacheRead;
        const price = GO_PRICES[model];
        const estRaw = price ? (b.input * price.in + b.output * price.out + b.cacheRead * price.cache) / 1e6 : null;
        const estCost = estRaw === null ? null : Math.round(estRaw * 10000) / 10000;
        return {
          model,
          count: b.count,
          inputTokens: b.input,
          outputTokens: b.output,
          cacheReadTokens: b.cacheRead,
          totalTokens,
          estCost,
        };
      })
      .sort((a, b) => (b.estCost || 0) - (a.estCost || 0));
    const days = Object.keys(totals.dayCosts)
      .sort()
      .map((day) => ({ day, cost: Math.round(totals.dayCosts[day] * 10000) / 10000 }));
    return {
      models,
      byDay: days,
      scannedSessions: targets.length,
      durationMs: Date.now() - started,
    };
  }
}

export default OpencodeUsageGateway;
