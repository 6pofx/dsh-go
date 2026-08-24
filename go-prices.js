// OpenCode GO official price table loader (go.mdx).
//
// The official docs page (packages/web/src/content/docs/go.mdx) ships a
// Markdown table with per-1M-token prices:
//
//   | Model                                   | Input  | Output | Cached Read | ... |
//   | DeepSeek V4 Flash (Off-Peak)            | $0.22  | $0.66  | $0.007      | ... |
//
// We fetch it at startup and refresh every 24h; the static FALLBACK_PRICES
// below is only used when every source is unreachable/unparseable.
//
// Tier handling:
//  - DeepSeek models have (Off-Peak) / (Peak) rows -> two tiers selected by
//    request time (peak hours 01:00-04:00 and 06:00-10:00 UTC).
//  - Long-context tiers like "(≤ 272K tokens)" cannot be detected from DSH
//    logs; the first (cheaper) tier wins.
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";

// Mirror sources so a single host going down does not break the refresh.
export const PRICE_SOURCES = [
  "https://raw.githubusercontent.com/sst/opencode/dev/packages/web/src/content/docs/go.mdx",
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx",
];

// Static fallback: last-known official prices (go.mdx), USD per 1M tokens.
// DeepSeek models keep { offPeak, peak }; everything else is flat.
export const FALLBACK_PRICES = {
  "deepseek-v4-flash": { offPeak: { in: 0.22, out: 0.66, cache: 0.007 }, peak: { in: 0.44, out: 1.32, cache: 0.014 } },
  "deepseek-v4-pro": { offPeak: { in: 0.66, out: 1.98, cache: 0.022 }, peak: { in: 1.32, out: 3.96, cache: 0.044 } },
  "kimi-k3": { in: 3.0, out: 15.0, cache: 0.3 },
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
  "deepseek-v4-flash-vision-exp": { offPeak: { in: 0.22, out: 0.66, cache: 0.007 }, peak: { in: 0.44, out: 1.32, cache: 0.014 } },
  "muse-spark-1.2-contributor": { in: 0.1, out: 0.2, cache: 0.002 },
  "ox-alpha-free": { in: 0, out: 0, cache: 0 },
};

// Peak hours are 01:00-04:00 and 06:00-10:00 UTC (per official docs).
export function isPeakHour(t) {
  const h = new Date(t).getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

// Pick the effective flat price for modelId at time t.
export function priceFor(entries, modelId, t) {
  const r = priceTierAt(entries, modelId, t);
  return r ? r.price : null;
}

// Like priceFor but also reports the applied tier:
// "peak" / "offPeak" for dual-tier models, "flat" for the rest.
export function priceTierAt(entries, modelId, t) {
  const e = entries[modelId];
  if (!e) return null;
  if (e.offPeak || e.peak) {
    const has = { offPeak: !!e.offPeak, peak: !!e.peak };
    if (has.offPeak && has.peak) {
      const peak = isPeakHour(t);
      return { price: peak ? e.peak : e.offPeak, tier: peak ? "peak" : "offPeak" };
    }
    return { price: e.offPeak || e.peak, tier: "flat" }; // single-tier entry
  }
  return { price: e, tier: "flat" };
}

// "DeepSeek V4 Flash (Off-Peak)" -> "deepseek-v4-flash"
function toModelId(rawName) {
  return rawName
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // drop "(Off-Peak)", "(≤ 272K tokens)", ...
    .replace(/[^a-z0-9.]+/g, "-") // spaces / punctuation -> "-"
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Parse the go.mdx Markdown into { [modelId]: {in,out,cache} | {offPeak,peak} }.
export function parseGoPrices(md) {
  const entries = {};
  for (const line of String(md).split(/\r?\n/)) {
    // Price rows: first cell = model name, then 3 $-prefixed numbers.
    const m = /^\|\s*([^|]+?)\s*\|\s*\$([0-9.]+)\s*\|\s*\$([0-9.]+)\s*\|\s*\$([0-9.]+)\s*\|/.exec(line);
    if (!m) continue;
    const rawName = m[1].trim();
    const tier = /\((Off-Peak|Peak)\)$/i.exec(rawName);
    const id = toModelId(rawName);
    if (!id) continue;
    const price = { in: Number(m[2]), out: Number(m[3]), cache: Number(m[4]) };
    if (!Number.isFinite(price.in) || !Number.isFinite(price.out) || !Number.isFinite(price.cache)) continue;
    const existing = entries[id];
    if (tier) {
      const key = tier[1].toLowerCase() === "peak" ? "peak" : "offPeak";
      const cur = existing && typeof existing === "object" && (existing.offPeak || existing.peak)
        ? existing
        : existing ? { offPeak: existing, peak: null } : { offPeak: null, peak: null };
      cur[key] = price;
      entries[id] = cur;
    } else if (!existing) {
      entries[id] = price; // first (cheaper) tier wins for long-context rows
    }
  }
  return entries;
}

// curl fallback: Windows hosts that route GitHub through a local TLS proxy
// (e.g. FastGithub via hosts/127.0.0.1) fail the undici CA check even though
// Windows' schannel trusts the injected root. curl.exe --ssl-no-revoke uses
// the system store, so it works there.
async function fetchWithCurl(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl.exe",
      ["-sS", "--ssl-no-revoke", "-L", "--max-time", String(Math.max(10, Math.ceil(timeoutMs / 1000))), url],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

// Fetch + parse from the mirror sources. Returns null when every source fails.
export async function fetchGoPrices({ timeoutMs = 10000 } = {}) {
  let lastError = null;
  for (const url of PRICE_SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "text/plain" } });
      if (!res.ok) {
        lastError = `http-${res.status}`;
        continue;
      }
      const md = await res.text();
      const entries = parseGoPrices(md);
      if (Object.keys(entries).length === 0) {
        lastError = "empty-table";
        continue;
      }
      return { entries, source: "remote", error: null };
    } catch (e) {
      lastError = String((e && e.cause && e.cause.code) || (e && e.name) || e || "fetch-failed");
    }
    if (process.platform === "win32") {
      try {
        const md = await fetchWithCurl(url, timeoutMs);
        const entries = parseGoPrices(md);
        if (Object.keys(entries).length > 0) return { entries, source: "remote", error: null };
        lastError = "empty-table";
      } catch {
        /* keep lastError from the fetch attempt */
      }
    }
  }
  return { entries: null, source: "remote", error: lastError || "fetch-failed" };
}

// Read + parse a local go.mdx file (used by tests / offline inspection).
export async function parseGoPricesFile(p) {
  return parseGoPrices(await readFile(p, "utf8"));
}