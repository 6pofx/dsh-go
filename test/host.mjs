// Compatibility check: dsh-go-usage HOST half against the installed DSH 0.2.x
// packages — module linking, Config, the Typert host manifest against the real
// loader validator, session aggregation, pricing, and the settings probe.
//
// Hermetic: global fetch is stubbed, so no network and no real API key.
// Imported by `node test/compat.mjs` from a harness whose `@deepseek-ai/*`
// re-export shims point at the installed DSH; runnable standalone too.
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";

const FAKE_MDX = [
  "| Model | Input | Output | Cached Read | Cached Write | Usage |",
  "| ----- | ----- | ------ | ----------- | ------------ | ----- |",
  "| DeepSeek V4 Flash (Off-Peak) | $0.22 | $0.66 | $0.007 | - | $30 |",
  "| DeepSeek V4 Flash (Peak) | $0.44 | $1.32 | $0.014 | - | $30 |",
  "| Kimi K3 | $3.00 | $15.00 | $0.30 | - | $15 |",
  "",
].join("\n");

globalThis.fetch = async (url) => {
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

// 1) Module linking — the host half must import from the 0.2.x packages only.
let mod;
try {
  mod = await import("./index.js");
  check("index.js links against the 0.2.x packages", true);
} catch (e) {
  check("index.js links against the 0.2.x packages", false, String((e && e.message) || e));
  throw e;
}

// 2) Config (schemastery) parses with defaults.
try {
  const cfg = mod.Config({});
  check("Config parses defaults", cfg.baseUrl === "https://opencode.ai/zen/go/v1/usage" && cfg.timeoutMs === 15000, JSON.stringify(cfg));
} catch (e) {
  check("Config parses defaults", false, String((e && e.message) || e));
}

// 3) Typert host manifest: the loader validator plus the registry's strict
//    codec rule (`{ mode, typeSymbol, create() }`) that 0.2.x enforces.
try {
  const { validateTypertManifest } = await import("@deepseek-ai/dsh-typert-loader");
  const { TYPERT } = await import("./typert.host.js");
  const contribution = validateTypertManifest("dsh-go-usage", TYPERT);
  check("TYPERT manifest passes validateTypertManifest", !!contribution && contribution.invocations.length === 2, `${contribution.invocations.length} invocations`);

  const strictCodec = (codec) =>
    !!codec &&
    codec.mode === "strict" &&
    typeof codec.typeSymbol === "string" &&
    codec.typeSymbol.length > 0 &&
    typeof codec.create === "function";
  const offenders = TYPERT.invocations.filter((invocation) => !strictCodec(invocation.result)).map((invocation) => invocation.id);
  check("every result codec has a create() factory (0.2.x registry rule)", offenders.length === 0, offenders.join(", "));

  // The factory must materialize a working zod parser, not just exist: the
  // Gateway calls `create().parse(result)` on every unary reply.
  const SAMPLES = {
    "dsh-go-usage#opencodeUsage/usage": {
      fetchedAt: 1,
      keySource: null,
      goInModels: null,
      account: null,
      accountError: null,
      price: null,
      prices: [],
      dsh: null,
      dshError: null,
    },
    "dsh-go-usage#opencodeUsage/refresh": { triggered: true },
  };
  const parses = TYPERT.invocations.every((invocation) => {
    const sample = SAMPLES[invocation.id];
    const parsed = invocation.result.create().parse(sample);
    return JSON.stringify(parsed) === JSON.stringify(sample);
  });
  check("result codecs materialize a working parser", parses, `${TYPERT.invocations.length} codecs`);

  // The real registry is what threw in 0.2.1 (`strict codec has no create()
  // factory`), and one bad codec withdraws the whole package face there — so
  // register the manifest through it rather than trusting validation alone.
  const { TypertRegistry } = await import("@deepseek-ai/dsh-typert-registry");
  const registryApp = new Context();
  const registry = new TypertRegistry(registryApp);
  const dispose = registry.register(contribution);
  const registered = registry.local.list();
  check("registers into the real TypertRegistry", registered.length === 2, registered.map((d) => d.id).join(", "));
  check("registry exposes the package face", !!registry.getPackage("dsh-go-usage", "host"), "dsh-go-usage#host");
  if (typeof dispose === "function") await dispose();
  else if (dispose && typeof dispose.dispose === "function") dispose.dispose();
  check("unregisters cleanly", registry.local.list().length === 0, "");
} catch (e) {
  check("TYPERT manifest passes validateTypertManifest", false, String((e && e.message) || e));
}

// 4) Live behaviour against a real cordis Context and stub services.
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

/** Build a Context carrying the services the gateway injects. */
function makeApp(extra) {
  const app = new Context();
  app.provide("credentials", { resolve: async () => ({ value: "fake-key" }) });
  app.provide("sessionQuery", { listSessions: async () => sessions, readSession: async () => sessions[0] });
  app.provide("timer", { interval: () => () => {}, timeout: () => () => {} });
  extra(app);
  return app;
}

const app = makeApp((a) => {
  // DSH 0.2.x SettingsForms: describe() carries `{ ns, value }` descriptors and
  // there is no raw get(). The live LLM route directory is the primary probe.
  a.provide("settings", {
    describe: () => [{ ns: "llm-pi-ai", value: { providers: { "opencode-go": { apiKey: "x" } } } }],
  });
  a.provide("llm", {
    listProviders: () => [{ id: "opencode-go", name: "OpenCode GO" }],
    listConfigurableProviders: () => [],
  });
});

const gw = new mod.OpencodeUsageGateway(app, {});
await gw.aggregateDsh(false);
const data = gw.dshState.data || {};
const flash = (data.models || []).find((m) => m.model === "deepseek-v4-flash");
check("aggregateDsh counts only opencode-go events", !!flash && flash.count === 2, flash ? `count=${flash.count}` : "no model row");
check("peak/off-peak split computed (priceTierAt wired)", !!flash && flash.tiered === true && flash.costPeak > 0 && flash.costOff > 0, flash ? `peak=${flash.costPeak} off=${flash.costOff}` : "");
check("daily cost series present", Array.isArray(data.byDay) && data.byDay.length === 1, JSON.stringify(data.byDay));

const usage = await gw.usage();
check("usage() returns account windows", !!(usage.account && usage.account.rolling) && usage.account.rolling.percent === 42, JSON.stringify(usage.account && usage.account.rolling));
check("usage() reports goInModels from the live LLM routes", usage.goInModels === true, String(usage.goInModels));

// SettingsForms fallback: no `llm` service at all, only the 0.2.x descriptors.
const formsApp = makeApp((a) => {
  a.provide("settings", { describe: () => [{ ns: "llm-pi-ai", value: { providers: { "opencode-go": {} } } }] });
});
const formsGw = new mod.OpencodeUsageGateway(formsApp, {});
const formsUsage = await formsGw.usage();
check("goInModels falls back to SettingsForms.describe()", formsUsage.goInModels === true, String(formsUsage.goInModels));

// Absent everywhere: the advisory hint must stay null, never throw.
const bareApp = makeApp((a) => {
  a.provide("settings", { describe: () => [{ ns: "llm-pi-ai", value: { providers: {} } }] });
});
const bareGw = new mod.OpencodeUsageGateway(bareApp, {});
const bareUsage = await bareGw.usage();
check("goInModels is false when no opencode-go profile exists", bareUsage.goInModels === false, String(bareUsage.goInModels));

await gw.syncPrices();
check("price table refreshed from remote markdown", gw.priceState.source === "remote" && !!gw.priceState.entries["deepseek-v4-flash"], `source=${gw.priceState.source} models=${Object.keys(gw.priceState.entries).length}`);
const priceRow = (usage.prices || []).find((p) => p.model === "kimi-k3");
check("prices list exposed for the UI", !!priceRow && priceRow.in === 3 && priceRow.out === 15, JSON.stringify(priceRow));

const failed = results.filter((r) => !r.ok);
console.log(`--- host: ${results.length - failed.length}/${results.length} passed ---`);
export const summary = { passed: results.length - failed.length, failed: failed.length, failedNames: failed.map((r) => r.name) };
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) process.exitCode = failed.length === 0 ? 0 : 2;
