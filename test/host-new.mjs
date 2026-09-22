// Compatibility check: dsh-go-usage HOST half against the CURRENT DSH packages
// (0.1.5-rc line, where `settingsNamespace` no longer exists).
//
// Hermetic: global fetch is stubbed, so no network and no real API key.
// Run through `node test/compat.mjs`, which materializes this file inside a
// harness whose node_modules resolve to the installed DSH packages.
import { Context } from "@deepseek-ai/cordis";

const FAKE_MDX = [
  "| Model | Input | Output | Cached Read | Cached Write | Usage |",
  "| ----- | ----- | ------ | ----------- | ------------ | ----- |",
  "| DeepSeek V4 Flash (Off-Peak) | $0.22 | $0.66 | $0.007 | - | $30 |",
  "| DeepSeek V4 Flash (Peak) | $0.44 | $1.32 | $0.014 | - | $30 |",
  "| Kimi K3 | $3.00 | $15.00 | $0.30 | - | $15 |",
  "",
].join("\n");

let fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  if (String(url).includes("go.mdx")) {
    return { ok: true, status: 200, text: async () => FAKE_MDX, json: async () => ({}) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      usage: {
        rolling: { status: "ok", percent: 42, resetsAt: "2026-09-22T12:00:00.000Z" },
        weekly: { status: "ok", percent: 11, resetsAt: "2026-09-28T00:00:00.000Z" },
        monthly: { status: "ok", percent: 64, resetsAt: "2026-10-15T12:00:00.000Z" },
      },
    }),
    text: async () => "",
  };
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + detail : ""}`);
};

// 1) Module linking — the breakage this suite exists for.
let mod;
try {
  mod = await import("./index.js");
  check("index.js links without the removed settingsNamespace named import", true);
} catch (e) {
  check("index.js links without the removed settingsNamespace named import", false, String((e && e.message) || e));
  process.exit(1);
}

// 2) Config (schemastery) parses with defaults.
try {
  const cfg = mod.Config({});
  check("Config parses defaults", cfg.baseUrl === "https://opencode.ai/zen/go/v1/usage" && cfg.timeoutMs === 15000, JSON.stringify(cfg));
} catch (e) {
  check("Config parses defaults", false, String((e && e.message) || e));
}

// 3) Typert manifest validates against the CURRENT loader validator.
try {
  const { validateTypertManifest } = await import("@deepseek-ai/dsh-typert-loader");
  const { TYPERT } = await import("./typert.host.js");
  const contribution = validateTypertManifest("dsh-go-usage", TYPERT);
  check("TYPERT manifest passes current validateTypertManifest", !!contribution && contribution.invocations.length === 2, `${contribution.invocations.length} invocations`);
} catch (e) {
  check("TYPERT manifest passes current validateTypertManifest", false, String((e && e.message) || e));
}

// 4) Live behavior with a real cordis Context and stub services.
const app = new Context();
const usedNamespaces = [];
app.provide("credentials", { resolve: async () => ({ value: "fake-key" }) });
app.provide("settings", {
  get: (ns) => {
    usedNamespaces.push(ns);
    return { providers: { "opencode-go": { apiKey: "x" } } };
  },
});
const peakHour = Date.UTC(2026, 8, 20, 2, 0, 0); // 02:00 UTC -> peak
const offHour = Date.UTC(2026, 8, 20, 12, 0, 0); // 12:00 UTC -> off-peak
const sessions = [
  {
    header: { id: "session-fake-1", createdAt: Date.now() - 3600_000 },
    events: [
      { type: "assistant/message", time: peakHour, data: { message: { source: { provider: "opencode-go", model: "deepseek-v4-flash" } }, usage: { inputTokens: 10000, outputTokens: 8000, cacheReadTokens: 50000 } } },
      { type: "assistant/message", time: offHour, data: { message: { source: { provider: "opencode-go", model: "deepseek-v4-flash" } }, usage: { inputTokens: 10000, outputTokens: 8000, cacheReadTokens: 50000 } } },
      { type: "assistant/message", time: offHour, data: { message: { source: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 999999, outputTokens: 999999, cacheReadTokens: 0 } } },
    ],
  },
];
app.provide("sessionQuery", { listSessions: async () => sessions, readSession: async () => sessions[0] });
app.provide("timer", { interval: () => () => {}, timeout: () => () => {} });

const gw = new mod.OpencodeUsageGateway(app, {});
await gw.aggregateDsh(false);
const data = gw.dshState.data || {};
const flash = (data.models || []).find((m) => m.model === "deepseek-v4-flash");
check("aggregateDsh counts only opencode-go events", !!flash && flash.count === 2, flash ? `count=${flash.count}` : "no model row");
check("peak/off-peak split computed (priceTierAt wired)", !!flash && flash.tiered === true && flash.costPeak > 0 && flash.costOff > 0, flash ? `peak=${flash.costPeak} off=${flash.costOff}` : "");
check("daily cost series present", Array.isArray(data.byDay) && data.byDay.length === 1, JSON.stringify(data.byDay));

const usage = await gw.usage();
check("usage() returns account windows", !!(usage.account && usage.account.rolling) && usage.account.rolling.percent === 42, JSON.stringify(usage.account && usage.account.rolling));
check("usage() reports goInModels from settings", usage.goInModels === true, String(usage.goInModels));
check("settings namespace stays a plain string on new DSH", usedNamespaces.includes("llm-pi-ai"), JSON.stringify(usedNamespaces));

await gw.syncPrices();
check("price table refreshed from remote markdown", gw.priceState.source === "remote" && !!gw.priceState.entries["deepseek-v4-flash"], `source=${gw.priceState.source} models=${Object.keys(gw.priceState.entries).length}`);
const priceRow = (usage.prices || []).find((p) => p.model === "kimi-k3");
check("prices list exposed for the UI", !!priceRow && priceRow.in === 3 && priceRow.out === 15, JSON.stringify(priceRow));

const failed = results.filter((r) => !r.ok);
console.log(`--- host/new: ${results.length - failed.length}/${results.length} passed ---`);
process.exit(failed.length === 0 ? 0 : 2);
