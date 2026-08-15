// Client half of the dsh-go-usage plugin.
// Hand-written browser bundle in the lazy-CJS format the client module loader
// expects: it only REGISTERS the factory; the body runs at materialization.
// It mounts the opencodeUsage Remote, registers a settings.section sidebar
// entry ("OpenCode GO 用量") and the composer dock mini-line, and renders
// the usage page / dock readout.
window.__ModuleLoader__.load({
  id: "dsh-go-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    const LIMITS = { rolling: 12, weekly: 30, monthly: 60 };
    const GO_PROVIDER = "opencode-go";

    // Client-side Remote contribution. The result codec is a pass-through
    // parser: the Host already validates the business result against its own
    // zod schema before it crosses the wire, and this side only needs the
    // descriptor's strict shape to mount and call.
    const TYPERT_REMOTE = {
      package: "dsh-go-usage",
      descriptors: [
        {
          id: "dsh-go-usage#opencodeUsage/usage",
          service: "opencodeUsage",
          namespace: "opencodeUsage",
          method: "usage",
          invocation: { kind: "direct" },
          parameters: [],
          result: {
            mode: "strict",
            typeSymbol: "dsh-go-usage#OpencodeUsageResult",
            schema: { parse(value) { return value; } },
          },
        },
        {
          id: "dsh-go-usage#opencodeUsage/refresh",
          service: "opencodeUsage",
          namespace: "opencodeUsage",
          method: "refresh",
          invocation: { kind: "direct" },
          parameters: [],
          result: {
            mode: "strict",
            typeSymbol: "dsh-go-usage#RefreshResult",
            schema: { parse(value) { return value; } },
          },
        },
      ],
    };

    const fmtMoney = (v) => "$" + (Math.round(v * 100) / 100).toFixed(2);
    const fmtMoney4 = (v) => v === null || v === undefined ? "—" : "$" + (Math.round(v * 10000) / 10000).toFixed(4);
    const fmtTokens = (v) => {
      if (v === null || v === undefined) return "—";
      if (v >= 1000000) return (v / 1000000).toFixed(2) + "M";
      if (v >= 1000) return (v / 1000).toFixed(1) + "K";
      return String(v);
    };
    const fmtCountdown = (iso) => {
      if (!iso) return "未知";
      const d = new Date(iso).getTime() - Date.now();
      if (!isFinite(d)) return iso;
      if (d <= 0) return "已重置";
      const h = Math.floor(d / 3600000);
      const m = Math.floor((d % 3600000) / 60000);
      if (h >= 48) return Math.floor(h / 24) + " 天后重置";
      if (h >= 1) return h + " 小时 " + m + " 分后重置";
      return m + " 分钟后重置";
    };
    const barColor = (p) => {
      if (p >= 90) return "var(--dsw-alias-state-error-primary)";
      if (p >= 80) return "var(--dsw-alias-state-warn-primary)";
      return "var(--dsw-alias-brand-primary)";
    };
    const pctText = (w) => (w && typeof w.percent === "number" ? w.percent + "%" : "—");

    function Ring(props) {
      const { percent, size, strokeWidth, textSize, trackColor } = props;
      const p = Math.max(0, Math.min(100, typeof percent === "number" ? percent : 0));
      const s = size || 56;
      const sw = strokeWidth || 5;
      const r = (s - sw) / 2;
      const c = 2 * Math.PI * r;
      const offset = c * (1 - p / 100);
      const center = s / 2;
      const trackCol = trackColor || "var(--dsw-alias-border-l2)";
      return React.createElement("svg", { width: s, height: s, viewBox: "0 0 " + s + " " + s, style: { flexShrink: 0 } },
        React.createElement("circle", { key: "track", cx: center, cy: center, r: r, fill: "none", stroke: trackCol, strokeWidth: sw }),
        React.createElement("circle", { key: "arc", cx: center, cy: center, r: r, fill: "none", stroke: barColor(p), strokeWidth: sw, strokeLinecap: "round", strokeDasharray: c, strokeDashoffset: offset, transform: "rotate(-90 " + center + " " + center + ")" }),
        textSize !== 0 ? React.createElement("text", { key: "label", x: "50%", y: "50%", textAnchor: "middle", dominantBaseline: "central", fontSize: textSize || Math.round(s * 0.24), fontWeight: 600, fill: "var(--dsw-alias-label-primary)" }, Math.round(p) + "%") : null
      );
    }

    const styles = {
      wrap: { maxWidth: 720, display: "flex", flexDirection: "column", gap: 14, padding: "8px 0" },
      title: { fontSize: 16, fontWeight: 600, margin: 0 },
      hint: { color: "var(--dsw-alias-label-secondary)", fontSize: 13, lineHeight: 1.6, margin: 0 },
      error: { color: "var(--dsw-alias-state-error-primary)", fontSize: 13, lineHeight: 1.6, margin: 0 },
      card: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", borderRadius: 10, padding: "14px 16px", display: "flex", gap: 14, alignItems: "center" },
      cardBody: { display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 },
      cardHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
      cardName: { fontSize: 14, fontWeight: 600, margin: 0 },
      cardMeta: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, margin: 0 },
      row: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--dsw-alias-label-secondary)", gap: 8, flexWrap: "wrap" },
      button: { alignSelf: "flex-start", border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", background: "transparent", borderRadius: 6, padding: "5px 12px" },
      sectionTitle: { fontSize: 14, fontWeight: 600, margin: "8px 0 0 0" },
      toggleRow: { display: "flex", gap: 4, alignItems: "center", margin: "2px 0" },
      toggleBtn: { border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", font: "inherit", fontSize: 12, cursor: "pointer", borderRadius: 6, padding: "2px 10px" },
      toggleOn: { border: "1px solid var(--dsw-alias-brand-primary)", color: "var(--dsw-alias-label-primary)", fontWeight: 600, background: "transparent" },
      table: { borderCollapse: "collapse", width: "100%", fontSize: 12 },
      th: { textAlign: "left", color: "var(--dsw-alias-label-secondary)", fontWeight: 500, padding: "4px 8px", borderBottom: "1px solid var(--dsw-alias-border-l1)", whiteSpace: "nowrap" },
      td: { padding: "5px 8px", borderBottom: "1px solid var(--dsw-alias-border-l1)", color: "var(--dsw-alias-label-primary)", verticalAlign: "middle" },
      tdTotal: { padding: "6px 8px", borderTop: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", fontWeight: 600, verticalAlign: "middle" },
      modelName: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      modelSub: { fontSize: 10, color: "var(--dsw-alias-label-secondary)", fontWeight: 400 },
      shareCell: { display: "flex", alignItems: "center", gap: 6 },
      shareTrack: { width: 56, height: 5, borderRadius: 3, background: "var(--dsw-alias-border-l1)", overflow: "hidden", flexShrink: 0 },
      shareFill: { height: "100%", borderRadius: 3, background: "var(--dsw-alias-brand-primary)" },
      sharePct: { fontSize: 11, color: "var(--dsw-alias-label-secondary)", minWidth: 34, textAlign: "right" },
      spark: { display: "flex", alignItems: "flex-end", gap: 2, height: 40, marginTop: 6 },
      bar: { flex: 1, minWidth: 2, background: "var(--dsw-alias-brand-primary)", borderRadius: "2px 2px 0 0" },
      metaRow: { display: "flex", gap: 12, alignItems: "center", fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
      badge: { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 999, padding: "1px 8px", fontSize: 11 },
      dock: { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--dsw-alias-label-secondary)", lineHeight: 1, position: "relative", cursor: "pointer" },
      dockTag: { fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      dockItem: { marginLeft: 6 },
      popup: { position: "absolute", bottom: "calc(100% + 10px)", right: 0, zIndex: 60, background: "var(--dsw-alias-bg-overlay)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, padding: "4px 12px 10px", width: 300, boxShadow: "0 8px 24px rgba(0,0,0,.3)" },
      popupHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "8px 0 6px", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
      popupTitle: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary)", margin: 0 },
      popupMeta: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
      popupRow: { display: "flex", flexDirection: "column", gap: 5, padding: "8px 0", borderBottom: "1px solid var(--dsw-alias-border-l1)" },
      popupRowLast: { display: "flex", flexDirection: "column", gap: 5, padding: "8px 0 2px" },
      popupRowTop: { display: "flex", justifyContent: "space-between", alignItems: "baseline" },
      popupRowName: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      popupRowStats: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
      popupRowPct: { color: "var(--dsw-alias-label-primary)", fontWeight: 600 },
      popupRowBottom: { display: "flex", alignItems: "center", gap: 8 },
      popupTrack: { flex: 1, height: 6, borderRadius: 3, background: "var(--dsw-alias-border-l1)", overflow: "hidden" },
      popupFill: { height: "100%", borderRadius: 3, transition: "width .2s ease" },
      popupReset: { fontSize: 11, color: "var(--dsw-alias-label-secondary)", flexShrink: 0, minWidth: 64, textAlign: "right" },
    };

    function WindowCard(props) {
      const { name, limitUsd, w } = props;
      const percent = w && typeof w.percent === "number" ? w.percent : null;
      const pct = percent === null ? 0 : Math.max(0, Math.min(100, percent));
      const remain = percent === null ? null : Math.max(0, (100 - percent) / 100 * limitUsd);
      return React.createElement("div", { style: styles.card },
        React.createElement(Ring, { percent: pct, size: 56, strokeWidth: 5 }),
        React.createElement("div", { style: styles.cardBody },
          React.createElement("div", { style: styles.cardHead },
            React.createElement("h3", { style: styles.cardName }, name),
            React.createElement("p", { style: styles.cardMeta }, "限额 " + fmtMoney(limitUsd))
          ),
          React.createElement("div", { style: styles.row },
            React.createElement("span", null, percent === null ? "已用未知" : "已用 " + percent + "%"),
            React.createElement("span", null, remain === null ? "剩余未知" : "剩余约 " + fmtMoney(remain)),
            React.createElement("span", null, "重置：" + fmtCountdown(w && w.resetsAt))
          )
        )
      );
    }

    function GoModelSection(props) {
      const { dsh } = props;
      const [detail, setDetail] = React.useState(false);
      if (!dsh) return null;
      const scanning = dsh.scanning === true;
      const models = dsh.models && dsh.models.length ? dsh.models : [];
      const totalCost = models.reduce((s, m) => s + (m.estCost || 0), 0);
      const totalTokens = models.reduce((s, m) => s + m.totalTokens, 0);
      const totalInput = models.reduce((s, m) => s + m.inputTokens, 0);
      const totalOutput = models.reduce((s, m) => s + m.outputTokens, 0);
      const totalCache = models.reduce((s, m) => s + m.cacheReadTokens, 0);
      const maxDay = dsh.byDay && dsh.byDay.length ? Math.max.apply(null, dsh.byDay.map(d => d.cost)) : 0;
      const toggle = React.createElement("div", { style: styles.toggleRow },
        React.createElement("button", { style: { ...styles.toggleBtn, ...(detail ? {} : styles.toggleOn) }, onClick: () => setDetail(false) }, "简洁"),
        React.createElement("button", { style: { ...styles.toggleBtn, ...(detail ? styles.toggleOn : {}) }, onClick: () => setDetail(true) }, "详细")
      );
      if (!scanning && models.length === 0) {
        return React.createElement("div", null,
          React.createElement("h3", { style: styles.sectionTitle }, "GO 套餐模型用量（DSH 会话 · 近 30 天）"),
          React.createElement("p", { style: styles.hint }, "统计自 DSH 会话日志中 provider 为 opencode-go 的请求。金额按 OpenCode 官方 GO 单价估算，非账单金额。")
        );
      }
      const headCells = detail
        ? [
            React.createElement("th", { key: "m", style: styles.th }, "模型"),
            React.createElement("th", { key: "i", style: styles.th }, "输入"),
            React.createElement("th", { key: "o", style: styles.th }, "输出"),
            React.createElement("th", { key: "c", style: styles.th }, "缓存命中"),
            React.createElement("th", { key: "amt", style: styles.th }, "估算金额"),
            React.createElement("th", { key: "share", style: styles.th }, "金额占比"),
          ]
        : [
            React.createElement("th", { key: "m", style: styles.th }, "模型"),
            React.createElement("th", { key: "t", style: styles.th }, "Token 用量"),
            React.createElement("th", { key: "amt", style: styles.th }, "估算金额"),
            React.createElement("th", { key: "share", style: styles.th }, "金额占比"),
          ];
      const rows = models.map((m, i) => {
        const cells = [];
        cells.push(React.createElement("td", { key: "m", style: styles.td },
          React.createElement("span", { style: styles.modelName }, m.model),
          React.createElement("span", { style: styles.modelSub }, " · " + m.count + " 条")
        ));
        if (detail) {
          cells.push(React.createElement("td", { key: "i", style: styles.td }, fmtTokens(m.inputTokens)));
          cells.push(React.createElement("td", { key: "o", style: styles.td }, fmtTokens(m.outputTokens)));
          cells.push(React.createElement("td", { key: "c", style: styles.td }, fmtTokens(m.cacheReadTokens)));
        } else {
          cells.push(React.createElement("td", { key: "t", style: styles.td, title: "输入 " + fmtTokens(m.inputTokens) + " · 输出 " + fmtTokens(m.outputTokens) + " · 缓存 " + fmtTokens(m.cacheReadTokens) }, fmtTokens(m.totalTokens)));
        }
        cells.push(React.createElement("td", { key: "amt", style: styles.td }, fmtMoney4(m.estCost)));
        cells.push(React.createElement("td", { key: "share", style: styles.td },
          React.createElement("div", { style: styles.shareCell },
            React.createElement("div", { style: styles.shareTrack },
              React.createElement("div", { style: { ...styles.shareFill, width: (totalCost > 0 ? Math.round((m.estCost || 0) / totalCost * 100) : 0) + "%" } })
            ),
            React.createElement("span", { style: styles.sharePct }, totalCost > 0 ? Math.round((m.estCost || 0) / totalCost * 100) + "%" : "—")
          )
        ));
        return React.createElement("tr", { key: i }, cells);
      });
      const totalCells = [];
      totalCells.push(React.createElement("td", { key: "m", style: styles.tdTotal }, "总计"));
      if (detail) {
        totalCells.push(React.createElement("td", { key: "i", style: styles.tdTotal }, fmtTokens(totalInput)));
        totalCells.push(React.createElement("td", { key: "o", style: styles.tdTotal }, fmtTokens(totalOutput)));
        totalCells.push(React.createElement("td", { key: "c", style: styles.tdTotal }, fmtTokens(totalCache)));
      } else {
        totalCells.push(React.createElement("td", { key: "t", style: styles.tdTotal }, fmtTokens(totalTokens)));
      }
      totalCells.push(React.createElement("td", { key: "amt", style: styles.tdTotal }, fmtMoney4(totalCost)));
      totalCells.push(React.createElement("td", { key: "share", style: styles.tdTotal }, "—"));
      return React.createElement("div", null,
        React.createElement("h3", { style: styles.sectionTitle }, "GO 套餐模型用量（DSH 会话 · 近 30 天）"),
        React.createElement("p", { style: styles.hint }, "统计自 DSH 会话日志中 provider 为 opencode-go 的请求。金额按 OpenCode 官方 GO 单价估算，非账单金额。" + (scanning ? "（正在统计…）" : "")),
        toggle,
        React.createElement("div", { style: styles.card },
          React.createElement("div", { style: styles.cardBody },
            scanning && models.length === 0 ? React.createElement("p", { style: styles.hint }, "正在统计 GO 用量…（首次扫描会话日志约需 10-30 秒，完成后自动显示）") : React.createElement("table", { style: styles.table },
              React.createElement("thead", null, React.createElement("tr", null, headCells)),
              React.createElement("tbody", null, rows, models.length > 1 ? React.createElement("tr", { key: "total" }, totalCells) : null)
            )
          )
        ),
        dsh.byDay && dsh.byDay.length > 1 && React.createElement("div", { style: styles.card },
          React.createElement("div", { style: styles.cardBody },
            React.createElement("p", { style: styles.cardMeta }, "近 30 天每日 GO 花费（估算）"),
            React.createElement("div", { style: styles.spark },
              dsh.byDay.map((d, i) => React.createElement("div", {
                key: i,
                style: { ...styles.bar, height: maxDay > 0 ? Math.max(2, Math.round(d.cost / maxDay * 38)) : 2, background: d.cost > 0 ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-bg-layer-2)" },
                title: d.day + " " + fmtMoney4(d.cost),
              }))
            )
          )
        )
      );
    }

    function UsagePage(props) {
      const [state, setState] = React.useState({ kind: "loading" });
      const [dshData, setDshData] = React.useState(null);
      const pollRef = React.useRef(null);
      const refresh = React.useCallback((force) => {
        setState({ kind: "loading" });
        if (force) {
          Promise.resolve().then(() => refreshRemote()).catch(() => {}).then(() => doLoad());
          return;
        }
        doLoad();
      }, []);
      const doLoad = React.useCallback(() => {
        Promise.resolve().then(() => query()).then((data) => {
          if (data && data.dsh && data.dsh.scanning === true) {
            setState({ kind: "done" });
            setDshData(data);
            if (pollRef.current === null && timer !== undefined) {
              pollRef.current = timer.interval(() => {
                Promise.resolve().then(() => query()).then((d2) => {
                  if (!(d2 && d2.dsh && d2.dsh.scanning === true)) {
                    if (pollRef.current) { pollRef.current(); pollRef.current = null; }
                    setState({ kind: "done" });
                    setDshData(d2);
                  } else {
                    setDshData(d2);
                  }
                }).catch(() => {});
              }, 3000);
            }
          } else {
            if (pollRef.current) { pollRef.current(); pollRef.current = null; }
            setState({ kind: "done" });
            setDshData(data);
          }
        }).catch((e) => setState({ kind: "error", message: String(e && e.message || e) }));
      }, []);
      React.useEffect(() => () => { if (pollRef.current) { pollRef.current(); pollRef.current = null; } }, []);
      React.useEffect(() => { refresh(false); }, [refresh]);

      if (state.kind === "loading") return React.createElement("div", { style: styles.wrap }, React.createElement("p", { style: styles.hint }, "查询中…"));
      if (state.kind === "error") return React.createElement("div", { style: styles.wrap },
        React.createElement("p", { style: styles.error }, "请求失败：" + state.message),
        React.createElement("button", { style: styles.button, onClick: () => refresh(true) }, "重试"));

      const d = dshData || {};
      const acc = d.account;
      const errMsg = (() => {
        if (d.accountError === "no-key") return "未找到 OpenCode API Key（凭据 OPENCODE_GO_API_KEY 或 auth.json）。";
        if (d.accountError === "unauthorized") return "API Key 无效或已过期（401）。";
        if (d.accountError === "no-subscription") return "该账号没有 OpenCode GO 订阅（403）。";
        if (d.accountError === "network") return "网络请求失败，请稍后重试。";
        if (d.accountError && String(d.accountError).indexOf("http-") === 0) return "接口返回 HTTP " + String(d.accountError).slice(5) + "。";
        if (d.accountError === "bad-json") return "接口响应解析失败。";
        return null;
      })();
      return React.createElement("div", { style: styles.wrap },
        React.createElement("div", { style: styles.metaRow },
          React.createElement("h2", { style: styles.title }, "OpenCode GO 用量"),
          React.createElement("span", { style: styles.badge }, d.keySource === "credentials" ? "Key: DSH 凭据" : d.keySource === "auth.json" ? "Key: auth.json" : "Key: 未配置"),
          React.createElement("span", { style: styles.badge }, "更新于 " + (d.fetchedAt ? new Date(d.fetchedAt).toLocaleTimeString() : "-"))
        ),
        React.createElement("button", { style: styles.button, onClick: () => refresh(true) }, "刷新"),
        d.goInModels === false ? React.createElement("p", { style: styles.hint }, "提示：设置 → 模型 中未配置 opencode-go 提供方（仅提示，不影响本页查询）。") : null,
        errMsg ? React.createElement("p", { style: styles.error }, errMsg) : null,
        acc ? React.createElement("div", { style: styles.wrap },
          React.createElement(WindowCard, { name: "5 小时滚动（$12）", limitUsd: LIMITS.rolling, w: acc.rolling }),
          React.createElement(WindowCard, { name: "每周（$30，周一重置）", limitUsd: LIMITS.weekly, w: acc.weekly }),
          React.createElement(WindowCard, { name: "每月（$60，账单周期）", limitUsd: LIMITS.monthly, w: acc.monthly })
        ) : null,
        d.dshError && !(d.dsh && d.dsh.scanning) ? React.createElement("p", { style: styles.hint }, "DSH 用量统计不可用：" + d.dshError) : null,
        React.createElement(GoModelSection, { dsh: d.dsh }),
        React.createElement("p", { style: styles.hint }, "限额 $12/$30/$60 为展示参考，官方接口只返回百分比；账户级百分比包含所有设备的用量。")
      );
    }

    function DockLine(props) {
      const [data, setData] = React.useState(null);
      const [dirState, setDirState] = React.useState(null);
      const [hover, setHover] = React.useState(false);
      const [clicked, setClicked] = React.useState(false);
      const sessionId = props && props.sessionId;
      const refresh = React.useCallback(() => {
        Promise.resolve().then(() => query()).then((d) => setData(d)).catch(() => setData(null));
      }, []);
      const onDockClick = React.useCallback(() => {
        setClicked(true);
        Promise.resolve().then(() => refreshRemote()).catch(() => {}).then(() => refresh()).catch(() => setClicked(false));
        setClicked(false);
      }, [refresh]);
      React.useEffect(() => {
        if (sessionId === undefined) {
          console.log("[ocg] dock: no sessionId prop");
          return;
        }
        let store = null;
        try {
          const svc = ctxRef.get("modelDirectories");
          if (svc !== undefined && typeof svc.directoryFor === "function") store = svc.directoryFor(sessionId).store;
        } catch (e) { store = null; }
        if (!store) {
          console.log("[ocg] dock: modelDirectories unavailable");
          return;
        }
        setDirState(store.getSnapshot());
        return store.subscribe(() => setDirState(store.getSnapshot()));
      }, [sessionId]);
      const isGo = !!(dirState && dirState.current && dirState.current.provider === GO_PROVIDER);
      React.useEffect(() => {
        if (!isGo) return;
        refresh();
        let dispose = null;
        if (timer !== undefined) dispose = timer.interval(refresh, 300000);
        return () => { if (dispose) dispose(); };
      }, [isGo]);
      if (!isGo) return null;
      const acc = data && data.account;
      if (!acc) return React.createElement("span", { style: styles.dock, onClick: onDockClick, title: "点击刷新" }, "GO 用量接通中…");
      const rollPct = acc.rolling && typeof acc.rolling.percent === "number" ? acc.rolling.percent : null;
      const popupRows = [
        [acc.rolling, "5 小时", LIMITS.rolling],
        [acc.weekly, "本周", LIMITS.weekly],
        [acc.monthly, "本月", LIMITS.monthly],
      ];
      return React.createElement("span", {
        style: styles.dock,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: onDockClick,
        title: "点击刷新用量",
      },
        React.createElement(Ring, { percent: rollPct === null ? 0 : rollPct, size: 20, strokeWidth: 3.5, textSize: 0, trackColor: "var(--dsw-alias-border-l2)" }),
        React.createElement("span", { style: styles.dockTag }, "GO"),
        React.createElement("span", { style: styles.dockItem }, clicked ? "刷新中…" : "5h " + pctText(acc.rolling)),
        React.createElement("span", { style: styles.dockItem }, "周 " + pctText(acc.weekly)),
        React.createElement("span", { style: styles.dockItem }, "月 " + pctText(acc.monthly)),
        hover ? React.createElement("div", { style: styles.popup },
          React.createElement("div", { style: styles.popupHead },
            React.createElement("p", { style: styles.popupTitle }, "OpenCode GO 套餐额度"),
            React.createElement("span", { style: styles.popupMeta }, "更新 " + (data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString() : "-"))
          ),
          popupRows.map((x, i) => {
            const w = x[0];
            const p = w && typeof w.percent === "number" ? Math.max(0, Math.min(100, w.percent)) : null;
            const remain = p === null ? null : Math.max(0, (100 - w.percent) / 100 * x[2]);
            return React.createElement("div", { key: i, style: i === popupRows.length - 1 ? styles.popupRowLast : styles.popupRow },
              React.createElement("div", { style: styles.popupRowTop },
                React.createElement("span", { style: styles.popupRowName }, x[1]),
                React.createElement("span", { style: styles.popupRowStats },
                  p === null ? "未知" : React.createElement("span", null,
                    React.createElement("span", { style: styles.popupRowPct }, "已用 " + w.percent + "%"),
                    " · 剩 " + fmtMoney(remain)))
              ),
              React.createElement("div", { style: styles.popupRowBottom },
                React.createElement("div", { style: styles.popupTrack },
                  React.createElement("div", { style: { ...styles.popupFill, background: barColor(p === null ? 0 : p), width: (p === null ? 0 : p) + "%" } })
                ),
                React.createElement("span", { style: styles.popupReset }, fmtCountdown(w && w.resetsAt))
              )
            );
          })
        ) : null
      );
    }

    // Module-scope data layer: components are defined at factory scope, so
    // the RPC bindings must live here too. ctxRef/mountReady/timer are set by
    // apply() before any component renders (slots register inside apply).
    let ctxRef = null;
    let mountReady = null;
    let timer = undefined;
    const query = async () => {
      await mountReady;
      const api = ctxRef.get("remote.opencodeUsage");
      if (!api) throw new Error("opencodeUsage remote is unavailable");
      const result = await api.usage();
      if (!result || result.ok === false) {
        throw new Error((result && result.error && result.error.message) || "remote failed");
      }
      return result.value;
    };
    const refreshRemote = async () => {
      await mountReady;
      const api = ctxRef.get("remote.opencodeUsage");
      if (!api) return null;
      const result = await api.refresh();
      return result && result.value !== undefined ? result.value : result;
    };

    function apply(ctx) {
      ctxRef = ctx;
      mountReady = ctx.remote.$mount(TYPERT_REMOTE);
      timer = ctx.get("timer");
      const slots = ctx.get("slots");
      if (slots === undefined) return;

      slots.inject("settings.section", () => slots.register(
        { name: "settings.section", id: "opencode-go-usage", order: 40, label: () => "OpenCode GO 用量" },
        (props) => React.createElement(UsagePage, {})
      ));
      slots.inject("conversation.composer.dock", () => slots.register(
        { name: "conversation.composer.dock", id: "opencode-go-dock", order: 5 },
        (props) => React.createElement(DockLine, { sessionId: props && props.sessionId })
      ));
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  }
});
