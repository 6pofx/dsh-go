// Compatibility check: dsh-go-usage CLIENT half against the current module
// loader contract (window.__ModuleLoader__.load) and the current client
// services/Slots (slots, remote, timer, theme/change).
//
// Runs the real bundle body with a minimal React + cordis + browser stub, then
// renders the settings page and the composer dock to settle their effects.
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + detail : ""}`);
};

globalThis.window = globalThis.window || {};
globalThis.document = { querySelectorAll: () => [], body: null, documentElement: null };

// ---- minimal React runtime: working hooks + bounded re-render loop --------
function makeReact() {
  let hookIndex = 0;
  let current = null;
  const loop = { dirty: false };
  const React = {
    Fragment: Symbol("Fragment"),
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length ? children : undefined } };
    },
    useState(init) {
      const inst = current;
      const i = hookIndex++;
      if (inst.states.length <= i) inst.states[i] = typeof init === "function" ? init() : init;
      return [inst.states[i], (v) => { inst.states[i] = typeof v === "function" ? v(inst.states[i]) : v; loop.dirty = true; }];
    },
    useRef(init) {
      const inst = current;
      const i = hookIndex++;
      if (!(i in inst.refs)) inst.refs[i] = { current: init };
      return inst.refs[i];
    },
    useCallback(fn) { hookIndex++; return fn; },
    useMemo(fn) { hookIndex++; return fn(); },
    useEffect(fn) { current.effects.push(fn); hookIndex++; },
  };
  const renderTree = async (element, rounds = 8) => {
    const instances = new Map();
    const walk = (node, fresh) => {
      if (node === null || node === undefined || typeof node !== "object") return node;
      if (Array.isArray(node)) return node.map((n) => walk(n, fresh));
      if (typeof node.type === "function") {
        let inst = instances.get(node.type);
        const isNew = inst === undefined;
        if (isNew) {
          inst = { states: [], refs: {}, effects: [] };
          instances.set(node.type, inst);
          fresh.push(inst);
        } else {
          inst.effects = [];
        }
        const prev = current;
        current = inst;
        hookIndex = 0;
        const out = walk(node.type({ ...node.props }), fresh);
        current = prev;
        return out;
      }
      const kids = node.props && node.props.children;
      return { type: node.type, props: { ...node.props, children: kids === undefined ? undefined : (Array.isArray(kids) ? kids.map((n) => walk(n, fresh)) : walk(kids, fresh)) } };
    };
    let out;
    for (let r = 0; r < rounds; r++) {
      loop.dirty = false;
      const fresh = [];
      out = walk(element, fresh);
      for (const inst of fresh) for (const fn of inst.effects) await fn();
      await new Promise((res) => setTimeout(res, 10));
      if (!loop.dirty) return out;
    }
    return out;
  };
  return { React, renderTree };
}
const { React, renderTree } = makeReact();

const textOf = (node) => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (node.props) return textOf(node.props.children);
  return "";
};

// ---- module loader stub --------------------------------------------------
let registration = null;
globalThis.window.__ModuleLoader__ = { load: (reg) => { registration = reg; } };
await import("./client.js");
check("client bundle registers via __ModuleLoader__.load", !!registration && registration.id === "dsh-go-usage", registration && registration.id);

const exportsObj = registration.factory((name) => {
  if (name === "react") return React;
  throw new Error("unexpected require: " + name);
});
check("client exports apply() and inject[]", typeof exportsObj.apply === "function" && Array.isArray(exportsObj.inject), JSON.stringify(exportsObj.inject));

// ---- cordis client ctx stub ---------------------------------------------
const registered = [];
const mounted = [];
const listened = [];
const usagePayload = {
  fetchedAt: Date.now(),
  keySource: "credentials",
  goInModels: true,
  account: { rolling: { status: "ok", percent: 42, resetsAt: new Date(Date.now() + 3600e3).toISOString() }, weekly: { status: "ok", percent: 11, resetsAt: null }, monthly: { status: "ok", percent: 64, resetsAt: null } },
  accountError: null,
  price: { source: "remote", fetchedAt: Date.now(), error: null, models: 23 },
  prices: [{ model: "kimi-k3", tiered: false, in: 3, out: 15, cache: 0.3, peakIn: null, peakOut: null, peakCache: null }],
  dsh: {
    models: [{ model: "deepseek-v4-flash", count: 12, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, totalTokens: 6000, estCost: 0.0123, tiered: true, costPeak: 0.004, costOff: 0.0083 }],
    byDay: [{ day: "2026-09-20", cost: 0.0123 }, { day: "2026-09-21", cost: 0.02 }],
    scannedSessions: 3,
    durationMs: 120,
    scanning: false,
  },
  dshError: null,
};

const slots = {
  inject: (key, cb) => { cb(); return () => {}; },
  register: (options, component) => { registered.push({ options, component }); return () => {}; },
};
const remoteNamespace = { usage: async () => ({ ok: true, value: usagePayload }), refresh: async () => ({ ok: true, value: { triggered: true } }) };
const ctx = {
  get: (name) => {
    if (name === "slots") return slots;
    if (name === "timer") return { timeout: () => () => {}, interval: () => () => {} };
    if (name === "remote.opencodeUsage") return remoteNamespace;
    return undefined;
  },
  on: (evt) => { listened.push(evt); return () => {}; },
  effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
};
ctx.remote = { $mount: async (contribution) => { mounted.push(contribution); return () => {}; } };

exportsObj.apply(ctx);

check("mounts the opencodeUsage Remote contribution", mounted.length === 1 && mounted[0].package === "dsh-go-usage" && mounted[0].descriptors.length === 2, JSON.stringify(mounted.map((m) => m.package)));
check("registers settings.section page", registered.some((r) => r.options.name === "settings.section" && r.options.id === "opencode-go-usage"), JSON.stringify(registered.map((r) => r.options.name)));
check("registers conversation.composer.dock line", registered.some((r) => r.options.name === "conversation.composer.dock"), JSON.stringify(registered.map((r) => r.options.name)));
check("subscribes theme/change for corner sync", listened.includes("theme/change"), JSON.stringify(listened));

// ---- render smoke test: settings page must produce the usage UI ----------
const page = registered.find((r) => r.options.name === "settings.section");
try {
  const tree = await renderTree(page.component({}));
  const text = textOf(tree).replace(/\s+/g, " ");
  check("settings page renders title + account + model row", text.includes("OpenCode GO 用量") && text.includes("42%") && text.includes("deepseek-v4-flash"), text.slice(0, 200));
  check("settings page renders price badge and daily trend", text.includes("价格表") && text.includes("每日"), text.slice(0, 200));
} catch (e) {
  check("settings page renders title + account + model row", false, String((e && e.stack) || e));
}

const dock = registered.find((r) => r.options.name === "conversation.composer.dock");
try {
  const dockTree = await renderTree(dock.component({ sessionId: "session-1" }));
  check("composer dock renders without throwing", dockTree !== undefined, "");
} catch (e) {
  check("composer dock renders without throwing", false, String((e && e.stack) || e));
}

const failed = results.filter((r) => !r.ok);
console.log(`--- client: ${results.length - failed.length}/${results.length} passed ---`);
process.exit(failed.length === 0 ? 0 : 2);
