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
import { FALLBACK_PRICES, fetchGoPrices, priceFor } from "./go-prices.js";

const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1/usage";
const DEFAULT_TIMEOUT_MS = 15000;
const DSH_DAYS = 30;
const DSH_INTERVAL = 300000;
const PRICE_INTERVAL = 24 * 3600 * 1000;
const QUICK_SCAN_LIMIT = 4;

// Official OpenCode GO per-1M-token prices (go.mdx). Values in USD.
// Start from the static fallback; refresh from the official docs every 24h.
const GO_PRICES = FALLBACK_PRICES;

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
    // Live price table: starts from the static fallback, refreshed from the
    // official go.mdx every 24h. { entries, source: "remote"|"fallback", fetchedAt, error }.
    this.priceState = { entries: GO_PRICES, source: "fallback", fetchedAt: null, error: null };
    this.priceSyncing = false;
    ctx.effect(() => {
      this.ensureScan("full");
      this.syncPrices();
      const timer = this.ctx.timer;
      if (timer !== undefined) {
        const stopScan = timer.interval(() => this.ensureScan("full"), DSH_INTERVAL);
        const stopPrice = timer.interval(() => this.syncPrices(), PRICE_INTERVAL);
        return () => { stopScan(); stopPrice(); };
      }
      return () => {};
    });
  }

  // Refresh the price table from the official docs (fire-and-forget; the
  // fallback table keeps estimates working while unrefreshed).
  async syncPrices() {
    if (this.priceSyncing) return;
    this.priceSyncing = true;
    try {
      const r = await fetchGoPrices({ timeoutMs: this.config.timeoutMs || DEFAULT_TIMEOUT_MS });
      if (r.entries && Object.keys(r.entries).length > 0) {
        this.priceState = {
          entries: { ...GO_PRICES, ...r.entries }, // remote wins; fallback fills models the docs dropped
          source: "remote",
          fetchedAt: Date.now(),
          error: null,
        };
      } else {
        this.priceState = { ...this.priceState, source: "fallback", error: r.error || "empty-table" };
      }
    } catch {
      this.priceState = { ...this.priceState, source: "fallback", error: "fetch-failed" };
    } finally {
      this.priceSyncing = false;
    }
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
    const ps = this.priceState;
    return {
      fetchedAt: Date.now(),
      keySource: ki.source,
      goInModels,
      account: accountResult.account,
      accountError: accountResult.error,
      price: {
        source: ps.source,
        fetchedAt: ps.fetchedAt,
        error: ps.error,
        models: Object.keys(ps.entries).length,
      },
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
      const b = byModel[model] || (byModel[model] = { count: 0, input: 0, output: 0, cacheRead: 0, cost: 0, costPeak: 0, costOff: 0 });
      b.count++;
      b.input += u.inputTokens || 0;
      b.output += u.outputTokens || 0;
      b.cacheRead += u.cacheReadTokens || 0;
      // Time-aware pricing: DeepSeek peaks (01:00-04:00 / 06:00-10:00 UTC)
      // are billed 2x; pick the tier by this event's timestamp and keep the
      // split so the UI can show peak vs off-peak contributions.
      const tiered = priceTierAt(this.priceState.entries, model, t);
      if (tiered) {
        const price = tiered.price;
        const d = new Date(t);
        const day = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
        const cost = (u.inputTokens || 0) * price.in / 1e6 + (u.outputTokens || 0) * price.out / 1e6 + (u.cacheReadTokens || 0) * price.cache / 1e6;
        b.cost += cost;
        if (tiered.tier === "peak") b.costPeak += cost;
        else if (tiered.tier === "offPeak") b.costOff += cost;
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
        const s = totals.byModel[model] || (totals.byModel[model] = { count: 0, input: 0, output: 0, cacheRead: 0, cost: 0, costPeak: 0, costOff: 0 });
        const b = agg.byModel[model];
        s.count += b.count;
        s.input += b.input;
        s.output += b.output;
        s.cacheRead += b.cacheRead;
        s.cost += b.cost || 0;
        s.costPeak += b.costPeak || 0;
        s.costOff += b.costOff || 0;
      }
      for (const day in agg.dayCosts) {
        totals.dayCosts[day] = (totals.dayCosts[day] || 0) + agg.dayCosts[day];
      }
    }
    const models = Object.keys(totals.byModel)
      .map((model) => {
        const b = totals.byModel[model];
        const totalTokens = b.input + b.output + b.cacheRead;
        // estCost was accumulated per-event with time-aware pricing in scanSession.
        const estCost = b.cost > 0 ? Math.round(b.cost * 10000) / 10000 : null;
        const tiered = b.costPeak > 0 || b.costOff > 0;
        return {
          model,
          count: b.count,
          inputTokens: b.input,
          outputTokens: b.output,
          cacheReadTokens: b.cacheRead,
          totalTokens,
          estCost,
          tiered,
          costPeak: tiered ? Math.round(b.costPeak * 10000) / 10000 : null,
          costOff: tiered ? Math.round(b.costOff * 10000) / 10000 : null,
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
