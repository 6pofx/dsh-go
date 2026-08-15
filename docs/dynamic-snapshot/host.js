// OpenCode GO 用量插件 — Host 半（动态插件快照 v11，pkg-26）
//
// 这是当前运行的动态 Cordis 插件代码快照，通过 cordis_define 的 code.host 加载。
// 功能：
//  - 官方接口 GET https://opencode.ai/zen/go/v1/usage（curl 经 subprocess 调用）
//  - Key 解析：DSH 凭据 OPENCODE_GO_API_KEY → auth.json（fs 或 cmd /c type）
//  - DSH 会话日志聚合：readSession 扫描近 30 天会话，按 opencode-go 模型统计
//    token（输入/输出/缓存）与估算金额（官方 GO 单价表），后台扫描 + 5 分钟缓存
//  - RPC：ocg-usage（快照）/ ocg-refresh（强制重扫）
//
// 正式版安装时需转为 dsh 插件包结构（package.json + Typert/模块清单）。

return {
  apply(ctx) {
    const API_URL = 'https://opencode.ai/zen/go/v1/usage'
    const CACHE_MS = 60000
    const DSH_DAYS = 30
    const DSH_INTERVAL = 300000
    let cache = null

    const GO_PRICES = {
      'deepseek-v4-flash': { in: 0.14, out: 0.28, cache: 0.0028 },
      'deepseek-v4-pro': { in: 0.435, out: 0.87, cache: 0.003625 },
      'kimi-k3': { in: 3.0, out: 15.0, cache: 0.30 },
      'kimi-k2.7-code': { in: 0.95, out: 4.0, cache: 0.19 },
      'kimi-k2.6': { in: 0.95, out: 4.0, cache: 0.16 },
      'mimo-v2.5': { in: 0.14, out: 0.28, cache: 0.0028 },
      'mimo-v2.5-pro': { in: 0.435, out: 0.87, cache: 0.003625 },
      'minimax-m3': { in: 0.30, out: 1.20, cache: 0.06 },
      'minimax-m2.7': { in: 0.30, out: 1.20, cache: 0.06 },
      'minimax-m2.5': { in: 0.30, out: 1.20, cache: 0.06 },
      'glm-5.3': { in: 1.40, out: 4.40, cache: 0.26 },
      'glm-5.2': { in: 1.40, out: 4.40, cache: 0.26 },
      'glm-5.1': { in: 1.40, out: 4.40, cache: 0.26 },
      'qwen3.8-max': { in: 2.0, out: 6.0, cache: 0.25 },
      'qwen3.7-max': { in: 2.5, out: 7.5, cache: 0.50 },
      'qwen3.7-plus': { in: 0.40, out: 1.60, cache: 0.04 },
      'qwen3.6-plus': { in: 0.50, out: 3.0, cache: 0.05 },
      'gpt-5.6-luna': { in: 0.20, out: 1.20, cache: 0.02 },
      'grok-4.5': { in: 2.0, out: 6.0, cache: 0.30 },
      'hy3': { in: 0.14, out: 0.58, cache: 0.035 },
    }

    const getSub = () => ctx.get('subprocess')
    const getCreds = () => ctx.get('credentials')
    const getFs = () => ctx.get('fs')
    const getTimer = () => ctx.get('timer')
    const getSettings = () => ctx.get('settings')
    const getSq = () => ctx.get('sessionQuery')

    let dshState = { data: null, scanning: false, nextScan: 0 }

    function runCmd(argv, timeoutMs) {
      const sub = getSub()
      if (sub === undefined) return Promise.reject(new Error('subprocess unavailable'))
      return Promise.resolve().then(() => sub.resolveExecutable(argv[0])).then((exe) => {
        return new Promise((resolve) => {
          const timer = getTimer()
          let guard = null
          const h = sub.spawn({
            argv: [exe].concat(argv.slice(1)),
            cwd: 'C:\\',
            stdio: { stdin: 'ignore', stdout: { maxBytes: 1048576 }, stderr: { maxBytes: 65536 } },
            graceMs: 15000,
          })
          if (timer !== undefined) guard = timer.timeout(() => h.terminate(), timeoutMs)
          h.done.then((out) => {
            if (guard) guard()
            const r = h.collected.stdout ? h.collected.stdout.readFrom(0) : null
            const er = h.collected.stderr ? h.collected.stderr.readFrom(0) : null
            resolve({ exitCode: out.exitCode, stdout: r ? r.text : '', stderr: er ? er.text : '' })
          }).catch((e) => {
            if (guard) guard()
            resolve({ exitCode: -1, stdout: '', stderr: String(e && e.message || e) })
          })
        })
      }).catch((e) => Promise.resolve({ exitCode: -1, stdout: '', stderr: String(e && e.message || e) }))
    }

    let homePromise = null
    function getHomeDir() {
      if (homePromise) return homePromise
      homePromise = runCmd(['cmd.exe', '/c', 'echo', '%USERPROFILE%'], 15000).then((r) => {
        const t = (r.stdout || '').trim()
        return t ? t : null
      })
      return homePromise
    }

    function readAuthJsonViaFs(home) {
      const fss = getFs()
      if (fss === undefined) return Promise.resolve(null)
      const p = home + '\\.local\\share\\opencode\\auth.json'
      return Promise.resolve().then(() => fss.resolve(p, undefined))
        .then((t) => fss.readText(t, undefined))
        .then((txt) => { try { return JSON.parse(txt) } catch (e) { return null } })
        .catch(() => null)
    }

    function readAuthJsonViaCmd(home) {
      return runCmd(['cmd.exe', '/c', 'type', home + '\\.local\\share\\opencode\\auth.json'], 15000).then((r) => {
        if (r.exitCode !== 0) return null
        try { return JSON.parse(r.stdout) } catch (e) { return null }
      })
    }

    function resolveKey(home) {
      const creds = getCreds()
      if (creds !== undefined) {
        return Promise.resolve().then(() => creds.resolve('OPENCODE_GO_API_KEY')).then((r) => {
          if (r && r.value) return { key: r.value, source: 'credentials' }
          return readAuth(home)
        }).catch(() => readAuth(home))
      }
      return readAuth(home)
    }

    function readAuth(home) {
      return readAuthJsonViaFs(home).then((auth) => {
        if (auth) return pickKey(auth, 'auth.json')
        return readAuthJsonViaCmd(home).then((auth2) => {
          if (auth2) return pickKey(auth2, 'auth.json')
          return { key: null, source: null }
        })
      })
    }

    function pickKey(auth, source) {
      const e = auth['opencode-go'] || auth['opencode']
      if (e && e.type === 'api' && typeof e.key === 'string' && e.key.length > 0) return { key: e.key, source: source }
      return { key: null, source: null }
    }

    function pickWindow(w) {
      if (!w || typeof w !== 'object') return null
      const percent = typeof w.percent === 'number' ? w.percent : Number(w.percent)
      return {
        status: typeof w.status === 'string' ? w.status : null,
        percent: Number.isFinite(percent) ? percent : null,
        resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
      }
    }

    function fetchAccount(key) {
      return runCmd(['curl.exe', '-sS', '-m', '20', '-H', 'Authorization: Bearer ' + key, '-H', 'Accept: application/json', '-w', '\n__HTTP__%{http_code}__', API_URL], 30000).then((r) => {
        if (r.exitCode !== 0) return { account: null, error: 'network' }
        const m = r.stdout.match(/__HTTP__(\d+)__\s*$/)
        const status = m ? Number(m[1]) : 0
        const body = r.stdout.replace(/__HTTP__\d+__\s*$/, '')
        if (status === 401) return { account: null, error: 'unauthorized' }
        if (status === 403) return { account: null, error: 'no-subscription' }
        if (status !== 200) return { account: null, error: 'http-' + status }
        let parsed = null
        try { parsed = JSON.parse(body) } catch (e) { parsed = null }
        if (!parsed) return { account: null, error: 'bad-json' }
        const usage = parsed && typeof parsed === 'object' && parsed.usage ? parsed.usage : parsed
        return {
          account: { rolling: pickWindow(usage && usage.rolling), weekly: pickWindow(usage && usage.weekly), monthly: pickWindow(usage && usage.monthly) },
          error: null,
        }
      })
    }

    function aggregateDsh() {
      const sq = getSq()
      if (sq === undefined) return Promise.resolve(null)
      const cutoff = Date.now() - DSH_DAYS * 24 * 3600 * 1000
      const byModel = {}
      const dayCosts = {}
      let scanned = 0
      const started = Date.now()
      return sq.listSessions().then((sessions) => {
        const recent = sessions.filter((s) => (s.header && s.header.createdAt || 0) >= cutoff).slice(0, 15)
        const readOne = (rec) => {
          const sid = rec.header && rec.header.id
          return sq.readSession(sid).then((snap) => {
            const events = snap.events || []
            for (const ev of events) {
              if (ev.type !== 'assistant/message' || !ev.data || !ev.data.usage) continue
              const t = ev.time || 0
              if (t < cutoff) continue
              const src = ev.data.message && ev.data.message.source
              const provider = src && typeof src.provider === 'string' ? src.provider : 'unknown'
              if (provider !== 'opencode-go') continue
              const model = src && typeof src.model === 'string' ? src.model : 'unknown'
              const u = ev.data.usage
              const b = byModel[model] || (byModel[model] = { count: 0, input: 0, output: 0, cacheRead: 0 })
              b.count++
              b.input += u.inputTokens || 0
              b.output += u.outputTokens || 0
              b.cacheRead += u.cacheReadTokens || 0
              const price = GO_PRICES[model]
              if (price) {
                const d = new Date(t)
                const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
                const cost = (u.inputTokens || 0) * price.in / 1000000 + (u.outputTokens || 0) * price.out / 1000000 + (u.cacheReadTokens || 0) * price.cache / 1000000
                dayCosts[day] = (dayCosts[day] || 0) + cost
              }
            }
          }).catch(() => {})
        }
        return Promise.all(recent.map(readOne)).then(() => {
          scanned = recent.length
          const models = Object.keys(byModel).map((model) => {
            const b = byModel[model]
            const totalTokens = b.input + b.output + b.cacheRead
            const price = GO_PRICES[model]
            const estRaw = price ? (b.input * price.in + b.output * price.out + b.cacheRead * price.cache) / 1000000 : null
            const estCost = estRaw === null ? null : Math.round(estRaw * 10000) / 10000
            return { model: model, count: b.count, inputTokens: b.input, outputTokens: b.output, cacheReadTokens: b.cacheRead, totalTokens: totalTokens, estCost: estCost }
          }).sort((a, b) => (b.estCost || 0) - (a.estCost || 0))
          const days = Object.keys(dayCosts).sort().map((day) => ({ day: day, cost: Math.round(dayCosts[day] * 10000) / 10000 }))
          return { models: models, byDay: days, scannedSessions: scanned, durationMs: Date.now() - started }
        })
      }).catch(() => null)
    }

    function ensureScan(force) {
      const now = Date.now()
      if (dshState.scanning) return
      if (!force && dshState.data && now < dshState.nextScan) return
      dshState.scanning = true
      aggregateDsh().then((data) => {
        dshState.data = data
        dshState.nextScan = Date.now() + DSH_INTERVAL
      }).catch(() => {}).then(() => { dshState.scanning = false })
    }

    const timer = getTimer()
    ctx.effect(() => {
      ensureScan(true)
      if (timer !== undefined) return timer.interval(() => ensureScan(false), DSH_INTERVAL)
      return () => {}
    })

    function fetchAll() {
      const now = Date.now()
      if (cache && now - cache.at < CACHE_MS) {
        const cached = cache.data
        return Promise.resolve({ ...cached, dsh: { ...(cached.dsh || {}), scanning: dshState.scanning } })
      }
      let goInModels = null
      const settings = getSettings()
      if (settings !== undefined) {
        try {
          const pi = settings.get('llm-pi-ai')
          goInModels = !!(pi && pi.providers && pi.providers['opencode-go'])
        } catch (e) { goInModels = null }
      }
      return getHomeDir().then((home) => {
        if (!home) return { fetchedAt: now, keySource: null, goInModels: goInModels, account: null, accountError: 'no-key', dsh: { ...(dshState.data || {}), scanning: dshState.scanning }, dshError: dshState.data ? null : 'scanning' }
        return resolveKey(home).then((ki) => {
          const pAcc = ki.key ? fetchAccount(ki.key) : Promise.resolve({ account: null, error: 'no-key' })
          return pAcc.then((res) => {
            const data = { fetchedAt: now, keySource: ki.source, goInModels: goInModels, account: res.account, accountError: res.error, dsh: { ...(dshState.data || {}), scanning: dshState.scanning }, dshError: dshState.data ? null : 'scanning' }
            cache = { at: now, data: data }
            return data
          })
        })
      })
    }

    ctx.effect(() => harness.handle('ocg-usage', (args) => fetchAll()))
    ctx.effect(() => harness.handle('ocg-refresh', (args) => { ensureScan(true); return { triggered: true } }))
  }
}
