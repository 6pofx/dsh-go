// Compatibility suite for dsh-go-usage: proves ONE artifact serves both the
// current DSH (0.1.5-rc line, no `settingsNamespace` export) and older builds
// (0.1.0-rc line, where that helper exists and must be called).
//
//   node test/compat.mjs            # run every suite
//   node test/compat.mjs --keep     # keep the generated harnesses for inspection
//
// The suites must run from a directory whose node_modules resolve to the
// installed DSH packages, so this runner materializes two throwaway harnesses
// in the OS temp dir (symlinks only — the plugin files are copied):
//
//   harness-new/  -> the real installed DSH packages  (host-new.mjs, client.mjs)
//   harness-old/  -> dsh-settings shimmed with the old settingsNamespace()
//                    helper                            (host-old.mjs)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");
const keep = process.argv.includes("--keep");

const PACKAGES = ["schemastery", "dsh-typert-protocol", "dsh-credentials", "dsh-settings", "cordis", "dsh-typert-loader"];
const PLUGIN_FILES = ["index.js", "go-prices.js", "typert.host.js", "client.js", "package.json"];

/** Locate the `@deepseek-ai/*` packages the running DSH resolves for plugins. */
function locateDshPackages() {
  const explicit = process.env.DSH_NODE_MODULES;
  const binDir = dirname(process.execPath);
  const candidates = [];
  if (explicit) candidates.push(explicit);
  try {
    const root = execFileSync("npm root -g", { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (root) candidates.push(join(root, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"));
  } catch {
    /* npm unavailable — fall back to the running interpreter's tree */
  }
  // nvm-for-windows layout: <nodeDir>/node_modules/... ; POSIX: <nodeDir>/../lib/node_modules/...
  candidates.push(join(binDir, "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"));
  candidates.push(join(binDir, "..", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"));
  candidates.push(join(binDir, "..", "lib", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"));
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, "dsh-settings", "package.json"))) return resolve(candidate);
  }
  console.error("compat: cannot locate the installed @deepseek-ai packages.");
  console.error("        Set DSH_NODE_MODULES to the directory holding dsh-settings, dsh-typert-protocol, …");
  process.exit(1);
}

const dshPackages = locateDshPackages();

/**
 * Locate the `zod` the plugin declares as its own dependency. In a real install
 * pnpm places it beside the plugin; the harness must link it explicitly.
 */
function locateZod() {
  const binDir = dirname(process.execPath);
  const dshRoot = resolve(dshPackages, "..", "..");
  const candidates = [
    process.env.DSH_ZOD,
    join(dshPackages, "zod"),
    join(dshRoot, "zod"),
    process.env.DSH_HOME ? join(process.env.DSH_HOME, "profiles", "web", "node_modules", "zod") : undefined,
    join(binDir, "node_modules", "@deepseek-ai", "dsh", "node_modules", "zod"),
    join(binDir, "node_modules", "zod"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return resolve(candidate);
  }
  return undefined;
}

const zod = locateZod();

function linkPackages(nodeModulesDir) {
  mkdirSync(join(nodeModulesDir, "@deepseek-ai"), { recursive: true });
  for (const pkg of PACKAGES) {
    const target = join(dshPackages, pkg);
    if (!existsSync(target)) continue;
    const link = join(nodeModulesDir, "@deepseek-ai", pkg);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  }
  if (zod !== undefined) {
    symlinkSync(zod, join(nodeModulesDir, "zod"), process.platform === "win32" ? "junction" : "dir");
  }
}

function buildHarness(name, { settingsShim }) {
  const root = join(tmpdir(), `dsh-go-usage-${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  linkPackages(join(root, "node_modules"));
  for (const file of PLUGIN_FILES) cpSync(join(pluginRoot, file), join(root, file));
  if (!settingsShim) {
    cpSync(join(here, "host-new.mjs"), join(root, "host-new.mjs"));
    cpSync(join(here, "client.mjs"), join(root, "client.mjs"));
  } else {
    // Simulated OLD DSH: re-export the installed module plus the brand helper
    // the 0.1.0-rc line shipped and the 0.1.5-rc line removed.
    const shimDir = join(root, "node_modules", "@deepseek-ai", "dsh-settings");
    rmSync(shimDir, { recursive: true, force: true });
    mkdirSync(shimDir, { recursive: true });
    const real = join(dshPackages, "dsh-settings", "lib", "index.js");
    const realUrl = "file:///" + real.replace(/\\/g, "/");
    writeFileSync(join(shimDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-settings", version: "0.1.0-rc.6-sim", type: "module", main: "index.js" }, null, 2));
    writeFileSync(join(shimDir, "index.js"), [
      `export * from ${JSON.stringify(realUrl)};`,
      `export { default } from ${JSON.stringify(realUrl)};`,
      "export function settingsNamespace(name) {",
      "  (globalThis.__nsCalls ||= []).push(name);",
      "  return name;",
      "}",
      "",
    ].join("\n"));
    cpSync(join(here, "host-old.mjs"), join(root, "host-old.mjs"));
  }
  return root;
}

const suites = [
  { name: "host/current-DSH", harness: buildHarness("new", { settingsShim: false }), script: "host-new.mjs" },
  { name: "client/current-DSH", harness: buildHarness("new", { settingsShim: false }), script: "client.mjs" },
  { name: "host/legacy-DSH", harness: buildHarness("old", { settingsShim: true }), script: "host-old.mjs" },
];

console.log(`compat: DSH packages = ${dshPackages}\n`);
let failed = 0;
for (const suite of suites) {
  console.log(`=== ${suite.name} ===`);
  try {
    const out = execFileSync(process.execPath, [suite.script], { cwd: suite.harness, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    process.stdout.write(out);
  } catch (e) {
    const out = `${e.stdout || ""}${e.stderr || ""}`;
    process.stdout.write(out);
    failed += 1;
  }
  console.log("");
}

for (const suite of suites) {
  if (!keep) rmSync(suite.harness, { recursive: true, force: true });
}
if (keep) console.log(`compat: harnesses kept at ${suites.map((s) => s.harness).filter((v, i, a) => a.indexOf(v) === i).join(", ")}`);
console.log(failed === 0 ? "compat: ALL SUITES PASSED" : `compat: ${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
