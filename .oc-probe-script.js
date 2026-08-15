// One-shot probe runner executed by the dynamic plugin via subprocess.
// Writes incremental results to .oc-probe.json (session workspace).
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const OUT = 'G:\\dsh-go\\.oc-probe.json'
const results = {}
const write = () => { try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)) } catch (e) { try { fs.writeFileSync(OUT, JSON.stringify({ fatal: String(e) })) } catch {} } }
const note = (k, v) => { results[k] = v; console.log('[probe-script]', k, JSON.stringify(v)); write() }

note('scriptStarted', true)

// 1. auth.json key extraction
try {
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE || 'C:\\Users\\fansile', '.local', 'share', 'opencode', 'auth.json'), 'utf8'))
  const entries = Object.keys(auth)
  const go = auth['opencode-go']
  const zen = auth['opencode']
  note('authEntries', entries)
  note('keySources', {
    opencodeGo: !!(go && go.type === 'api' && go.key),
    opencodeZen: !!(zen && zen.type === 'api' && zen.key),
  })
} catch (e) { note('authReadFail', String(e && e.message || e)) }

// 2. curl to the official usage API with the Zen key (masked output)
try {
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE || 'C:\\Users\\fansile', '.local', 'share', 'opencode', 'auth.json'), 'utf8'))
  const key = (auth['opencode-go'] || auth['opencode'] || {}).key
  if (key) {
    const r = spawnSync('curl.exe', ['-sS', '-m', '25', '-H', 'Authorization: Bearer ' + key, '-H', 'Accept: application/json', 'https://opencode.ai/zen/go/v1/usage'], { encoding: 'utf8', timeout: 30000 })
    note('usageApi', { status: r.status, stdoutLen: r.stdout ? r.stdout.length : -1, stdoutHead: r.stdout ? r.stdout.slice(0, 300) : '', stderr: r.stderr ? r.stderr.slice(0, 200) : '' })
  } else {
    note('usageApi', { skip: 'no key' })
  }
} catch (e) { note('usageApiFail', String(e && e.message || e)) }

// 3. opencode db window query via cmd /c
try {
  const now = Date.now()
  const five = now - 5 * 3600 * 1000
  const d = new Date()
  const dow = (d.getUTCDay() + 6) % 7
  const weekStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const sql = 'SELECT COALESCE(SUM(CASE WHEN time_created >= ' + five + " THEN CAST(json_extract(data, '$.cost') AS REAL) ELSE 0 END), 0) as five_hour_cost, COALESCE(SUM(CASE WHEN time_created >= " + weekStart + " THEN CAST(json_extract(data, '$.cost') AS REAL) ELSE 0 END), 0) as weekly_cost, COALESCE(SUM(CASE WHEN time_created >= " + monthStart + " THEN CAST(json_extract(data, '$.cost') AS REAL) ELSE 0 END), 0) as monthly_cost FROM message WHERE json_extract(data, '$.role') = 'assistant' AND time_created >= " + monthStart
  const r = spawnSync('cmd.exe', ['/c', 'opencode', 'db', sql, '--format', 'json'], { encoding: 'utf8', timeout: 40000 })
  note('ocDbQuery', { status: r.status, stdoutLen: r.stdout ? r.stdout.length : -1, stdoutHead: r.stdout ? r.stdout.slice(0, 300) : '', stderr: r.stderr ? r.stderr.slice(0, 200) : '' })
} catch (e) { note('ocDbFail', String(e && e.message || e)) }

// 4. per-model + daily breakdown probe
try {
  const r = spawnSync('cmd.exe', ['/c', 'opencode', 'db', "SELECT json_extract(data, '$.providerID') as provider, COUNT(*) as n, ROUND(SUM(CAST(json_extract(data, '$.cost') AS REAL)), 4) as cost FROM message WHERE json_extract(data, '$.role') = 'assistant' GROUP BY provider", '--format', 'json'], { encoding: 'utf8', timeout: 40000 })
  note('byProvider', { status: r.status, out: r.stdout ? r.stdout.slice(0, 400) : '', err: r.stderr ? r.stderr.slice(0, 200) : '' })
} catch (e) { note('byProviderFail', String(e && e.message || e)) }

note('scriptDone', true)
write()
