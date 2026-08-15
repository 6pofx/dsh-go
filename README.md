# dsh-go

> OpenCode GO 套餐用量监控插件 · 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 而生

在 DSH 里一眼看清你的 **OpenCode GO 套餐**还剩多少：账户级三窗口额度（5 小时 / 每周 / 每月）环形图，加上从 DSH 会话日志聚合出的**按模型 Token 消耗与估算金额**，输入框下方还有一条随用随刷新的迷你指示。

![license](https://img.shields.io/badge/license-MIT-blue.svg)

---

## ✨ 功能一览

| 功能 | 说明 |
| --- | --- |
| 🍩 **三窗口环形图** | 5 小时滚动（$12）/ 每周（$30）/ 每月（$60）：已用 %、剩余约 $、重置倒计时，阈值变色（≥80% 黄、≥90% 红） |
| 📊 **按模型用量** | 从 DSH 会话日志聚合 provider 为 `opencode-go` 的请求：每个模型的 Token 用量与估算金额；**简洁 / 详细**模式切换（详细拆分输入 / 输出 / 缓存命中） |
| 📈 **每日趋势** | 近 30 天每日 GO 花费（估算）迷你趋势图 |
| 🪟 **输入框迷你条** | 仅当对话模型来自 GO 时显示 `5h / 周 / 月` 百分比；悬浮查看三窗口详情；**点击立即刷新** |
| 🔑 **Key 自动解析** | `OPENCODE_GO_API_KEY` 凭据 → `auth.json`（opencode-go → opencode），无需手动配置 |

入口：**设置侧边栏 →「OpenCode GO 用量」** + **对话输入框下方迷你条**。

## 📸 截图

*（待补充）*

---

## 🚀 安装

插件已发布到 GitHub，推荐直接用 git 源安装（`dsh plugin` 走 pnpm，git 源没有 Windows 跨盘符路径问题）：

```sh
dsh plugin --profile web add github:6pofx/dsh-go
```

本地开发 / 离线安装（tarball 流程，Windows 上 `link:` 目录依赖有 pnpm 盘符 bug，勿用目录直连）：

```sh
# 1. 打包
npm pack

# 2. 拷到 profile 目录
cp dsh-go-0.1.0.tgz $DSH_HOME/profiles/web/

# 3. 首次安装需在 $DSH_HOME/profiles/web/package.json 的 dependencies 加入：
#    "dsh-go": "file:dsh-go-0.1.0.tgz"

# 4. 物化依赖 + 自动注册 bundle 层（reconcile）
dsh plugin --profile web install

# 5. 重启 dsh web
```

插件通过包内 `cordis.patch.yml` + `dsh.bundle.patch` 声明**自动注入插件行**，无需手改 profile 的 `cordis.patch.yml` 用户层。

### 更新

```sh
npm pack
cp dsh-go-0.1.0.tgz $DSH_HOME/profiles/web/
dsh plugin --profile web install   # 或 git 源：dsh plugin --profile web update dsh-go
# 重启 dsh web
```

---

## ⚙️ 配置

Host 端参数写在插件行上（`dsh plugin` 安装后如需自定义，编辑 profile 的 `cordis.patch.yml` 用户层）：

```yaml
- insert:
    - id: opencode-go-usage
      name: dsh-go
      config:
        baseUrl: https://opencode.ai/zen/go/v1/usage   # 默认
        timeoutMs: 15000                                # 默认
```

---

## 🔬 数据通路

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| 账户级三窗口百分比 | `GET https://opencode.ai/zen/go/v1/usage`（Host `fetch` + Bearer key） | OpenCode 官方接口（未公开文档）；401=key 失效、403=无订阅。百分比含所有设备的用量 |
| 按模型 Token / 金额 | DSH 会话日志（`ctx.sessionQuery.readSession`，后台扫描 + 5 分钟缓存） | Token 精确；金额按 OpenCode 官方 [GO 单价表](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx) 估算，**非账单金额** |
| API Key | `OPENCODE_GO_API_KEY` 凭据 → `~/.local/share/opencode/auth.json`（opencode-go → opencode 条目） | 自动解析，页面显示来源 |

**重要说明**：官方接口只提供账户级百分比，不提供按模型拆分；按模型数据来自本机 DSH 会话日志，仅覆盖本机 DSH 产生的 GO 用量（其他设备 / opencode CLI 的用量不在此统计内）。

---

## 🏗️ 结构

```
dsh-go/
├── index.js          # Host 半：OpencodeUsageGateway（TypertRemoteService，方法 usage/refresh）
├── typert.host.js    # 手写 Typert host 清单（zod 结果 schema），exports["./typert"]
├── client.js         # 浏览器 bundle（window.__ModuleLoader__.load），挂载 Remote + 两个槽位
├── cordis.patch.yml  # 插件行（dsh.bundle.patch 自动注入）
├── package.json      # 双面声明：main + exports ./client ./typert + dsh.client + dsh.bundle
└── docs/dynamic-snapshot/   # 早期动态 Cordis 插件版本代码快照（已由正式版取代）
```

## 🧩 开发

- **Host 半**：`index.js` 是纯 Node ESM，`fetch` / `node:fs` 原生可用；RPC 通过 Typert Remote（`opencodeUsage/usage`、`opencodeUsage/refresh`）
- **Client 半**：`client.js` 是手写 lazy-CJS bundle，`React.createElement` 渲染、主题 CSS 变量适配明暗
- 本地改动后按「更新」流程重新打包安装

## ⚠️ 已知限制

- 用量接口未公开文档，可能变动；解析已做防御式处理，非 200 响应显示友好状态而非崩溃
- 限额（$12 / $30 / $60）仅作展示参考，官方接口只返回百分比
- 模型金额为按官方 GO 单价估算；DSH 日志仅覆盖本机 DSH 产生的用量
- 迷你条仅在当前对话模型 provider 为 `opencode-go` 时显示

## 📚 参考

- [xiaoqi20/dsh-opencode-go-usage](https://github.com/xiaoqi20/dsh-opencode-go-usage) — 同款 DSH 插件（设置页三窗口），本包参考其 Host/Client 双面与 Typert 清单写法
- [andywang425/opencode-go-usage-api](https://github.com/andywang425/opencode-go-usage-api) — OpenCode Go 工作区页面抓取方案
- [tddworks/ClaudeBar](https://github.com/tddworks/ClaudeBar/commit/4ca0426f988c81d3a8c39610085be1c585bd6915) — 5hr/周/月配额 + 本地 DB 成本查询
- [Ychris12138/dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats) — DSH 会话日志按模型聚合参考

## 📄 License

[MIT](./LICENSE)
