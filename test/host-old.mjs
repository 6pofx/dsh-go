// Compatibility check: the SAME plugin artifact against a SIMULATED OLD DSH,
// where `@deepseek-ai/dsh-settings` still exports the `settingsNamespace()`
// brand helper. Proves the feature-detection branch keeps old builds working.
//
// `node test/compat.mjs` materializes this file in a harness whose
// dsh-settings is a shim re-exporting the installed module plus the helper.
import { Context } from "@deepseek-ai/cordis";

const FAKE_MDX = [
  "| Model | Input | Output | Cached Read | Cached Write | Usage |",
  "| ----- | ----- | ------ | ----------- | ------------ | ----- |",
  "| DeepSeek V4 Flash (Off-Peak) | $0.22 | $0.66 | $0.007 | - | $30 |",
  "| DeepSeek V4 Flash (Peak) | $0.44 | $1.32 | $0.014 | - | $30 |",
  "",
].join("\n");

globalThis.fetch = async (url) => {
  if (String(url).includes("go.mdx")) {
    return { ok: true, status: 200, text: async () => FAKE_MDX, json: async () => ({}) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ usage: { rolling: { status: "ok", percent: 7, resetsAt: "2026-09-22T12:00:00.000Z" } } }),
    text: async () => "",
  };
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + detail : ""}`);
};

const mod = await import("./index.js");
check("index.js links on old DSH too", true);

const app = new Context();
const usedNamespaces = [];
app.provide("credentials", { resolve: async () => ({ value: "fake-key" }) });
app.provide("settings", { get: (ns) => { usedNamespaces.push(ns); return { providers: { "opencode-go": {} } }; } });
const t = Date.UTC(2026, 8, 20, 2, 0, 0);
const sessions = [{ header: { id: "s1", createdAt: Date.now() - 1000 }, events: [{ type: "assistant/message", time: t, data: { message: { source: { provider: "opencode-go", model: "kimi-k3" } }, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 } } }] }];
app.provide("sessionQuery", { listSessions: async () => sessions, readSession: async () => sessions[0] });
app.provide("timer", { interval: () => () => {}, timeout: () => () => {} });

const gw = new mod.OpencodeUsageGateway(app, {});
await gw.aggregateDsh(false);
const usage = await gw.usage();

check("old settingsNamespace() helper is used when present", Array.isArray(globalThis.__nsCalls) && globalThis.__nsCalls.includes("llm-pi-ai"), JSON.stringify(globalThis.__nsCalls || null));
check("settings service receives the same namespace value", usedNamespaces.includes("llm-pi-ai"), JSON.stringify(usedNamespaces));
check("aggregation still works on old DSH", (gw.dshState.data.models || []).some((m) => m.model === "kimi-k3"), JSON.stringify((gw.dshState.data.models || []).map((m) => m.model)));
check("usage() returns account on old DSH", !!(usage.account && usage.account.rolling) && usage.account.rolling.percent === 7, JSON.stringify(usage.account && usage.account.rolling));
check("goInModels detected on old DSH", usage.goInModels === true, String(usage.goInModels));

const failed = results.filter((r) => !r.ok);
console.log(`--- host/old: ${results.length - failed.length}/${results.length} passed ---`);
process.exit(failed.length === 0 ? 0 : 2);
