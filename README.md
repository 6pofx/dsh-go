# dsh-opencode-go-usage

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 中查看 **OpenCode GO 套餐**用量：

- **账户级三窗口**：5 小时滚动（$12）/ 每周（$30）/ 每月（$60）——环形图、已用 %、剩余约 $、重置倒计时、阈值变色（≥80% 黄、≥90% 红）
- **GO 套餐模型用量**：从 DSH 会话日志聚合 provider 为 `opencode-go` 的请求，按模型统计 **Token 用量**（输入/输出/缓存）与**估算金额**（OpenCode 官方 GO 单价）
- **输入框迷你条**：仅当对话模型来自 GO 时显示 `5h/周/月` 百分比，悬浮查看三窗口详情，**点击刷新**
- 入口：设置侧边栏「OpenCode GO 用量」+ 输入框下方迷你条

## 数据通路

| 数据 | 来源 | 说明 |
|---|---|---|
| 账户级百分比 | `GET https://opencode.ai/zen/go/v1/usage`（Bearer key） | 官方接口，未公开文档；401=key 失效、403=无订阅 |
| 按模型 Token/金额 | DSH 会话日志（`sessionQuery.readSession`） | 精确 token；金额按 [go.mdx 单价表](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx) 估算（非账单） |
| API Key | `OPENCODE_GO_API_KEY` 凭据 → `~/.local/share/opencode/auth.json`（opencode-go → opencode 条目） | 自动解析 |

## 现状与结构

当前为**动态 Cordis 插件**（进程内生效，重启后需重新 `cordis_define` + `cordis_run`）。代码快照：

- `src/host.js` — Host 半（curl 调官方接口、DSH 会话聚合、缓存、`ocg-usage`/`ocg-refresh` RPC）
- `src/client.js` — Client 半（设置页 + 迷你条 + 悬浮面板 + 点击刷新）

## 后续计划

- [x] 账户级三窗口（环形图、阈值变色、悬浮详情、点击刷新）
- [x] 按模型 Token 用量（DSH 会话聚合）
- [ ] **简洁/详细模式切换**（详细模式拆分输入/输出/缓存命中）
- [ ] 落成正式插件包（`package.json` + 浏览器 bundle 格式 + `dsh plugin` 安装），持久生效

## 参考

- [xiaoqi20/dsh-opencode-go-usage](https://github.com/xiaoqi20/dsh-opencode-go-usage) — 同款 DSH 插件（设置页三窗口）
- [andywang425/opencode-go-usage-api](https://github.com/andywang425/opencode-go-usage-api) — 工作区页面抓取方案
- [tddworks/ClaudeBar](https://github.com/tddworks/ClaudeBar/commit/4ca0426f988c81d3a8c39610085be1c585bd6915) — 5hr/周/月配额 + 本地 DB 成本查询
- [Ychris12138/dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats) — DSH 会话日志按模型聚合参考
