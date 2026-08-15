# dsh-go-usage

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 中查看 **OpenCode GO 套餐**用量：

- **账户级三窗口**：5 小时滚动（$12）/ 每周（$30）/ 每月（$60）——环形图、已用 %、剩余约 $、重置倒计时、阈值变色（≥80% 黄、≥90% 红）
- **GO 套餐模型用量**：从 DSH 会话日志聚合 provider 为 `opencode-go` 的请求，按模型统计 **Token 用量**（输入/输出/缓存命中，简洁/详细模式切换）与**估算金额**（OpenCode 官方 GO 单价）
- **输入框迷你条**：仅当对话模型来自 GO 时显示 `5h/周/月` 百分比，悬浮查看三窗口详情，**点击刷新**
- 入口：设置侧边栏「OpenCode GO 用量」+ 输入框下方迷你条

## 安装

> ⚠️ Windows 注意：pnpm 对跨盘符目录依赖（`link:G:/dsh-go`）存在路径解析 bug（会把盘符当相对路径），
> 本地安装请走 **tarball 流程**（见下）。

```sh
# 1. 打包（在插件仓库目录）
npm pack

# 2. 把 tarball 拷到 profile 目录
cp dsh-go-usage-0.1.0.tgz $DSH_HOME/profiles/web/

# 3. 加入依赖（触发 pnpm 物化 + bundle 层 reconcile）
dsh plugin --profile web install
# 若首次安装，先手动在 $DSH_HOME/profiles/web/package.json 的 dependencies 加入：
#   "dsh-go-usage": "file:dsh-go-usage-0.1.0.tgz"
# （reconcile 会把声明了 dsh.bundle 的包自动加入 dsh.profile.bundles）

# 4. 重启 dsh web 使 host 半与客户端 bundle 生效
```

插件通过 `dsh.bundle.patch`（`cordis.patch.yml`）自动注入插件行，无需手改 `cordis.patch.yml` 用户层。

### 更新流程

改代码后：`npm pack` → 覆盖拷贝 tarball 到 profile → `dsh plugin --profile web install` → 重启 `dsh web`。

## 配置

Host 端参数写在 `cordis.patch.yml` 的插件行上：

```yaml
- insert:
    - id: opencode-go-usage
      name: dsh-go-usage
      config:
        baseUrl: https://opencode.ai/zen/go/v1/usage   # 默认
        timeoutMs: 15000                                # 默认
```

## 数据通路

| 数据 | 来源 | 说明 |
|---|---|---|
| 账户级百分比 | `GET https://opencode.ai/zen/go/v1/usage`（Bearer key，Host `fetch`） | 官方接口，未公开文档；401=key 失效、403=无订阅 |
| 按模型 Token/金额 | DSH 会话日志（`ctx.sessionQuery.readSession`，后台扫描 + 5 分钟缓存） | token 精确；金额按 [go.mdx 单价表](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx) 估算（非账单） |
| API Key | `OPENCODE_GO_API_KEY` 凭据 → `~/.local/share/opencode/auth.json`（opencode-go → opencode 条目） | 自动解析 |

## 结构

- `index.js` — Host 半：`OpencodeUsageGateway`（`TypertRemoteService`，服务键 `opencodeUsage`，方法 `usage`/`refresh`）
- `typert.host.js` — 手写 Typert host 清单（zod 结果 schema），经 `exports["./typert"]` 注册
- `client.js` — 浏览器 bundle（`window.__ModuleLoader__.load` lazy-CJS 格式）：挂载 Remote、注册 `settings.section` 与 `conversation.composer.dock`、渲染页面与迷你条
- `package.json` — 双面声明：`main` + `exports["./client"]` + `exports["./typert"]` + `dsh.client`
- `docs/dynamic-snapshot/` — 早期动态 Cordis 插件版本代码快照（进程内预览用，已由正式版取代）

## 已知限制

- 用量接口未公开文档、可能变动；解析做了防御式处理，非 200 响应显示友好状态
- 限额（$12 / $30 / $60）仅作展示参考，官方接口只返回百分比
- 模型金额为按官方 GO 单价估算，非账单金额；DSH 日志仅覆盖本机 DSH 产生的用量

## 参考

- [xiaoqi20/dsh-opencode-go-usage](https://github.com/xiaoqi20/dsh-opencode-go-usage) — 同款 DSH 插件（设置页三窗口），本包结构参考其 Host/Client 双面与 Typert 清单写法
- [andywang425/opencode-go-usage-api](https://github.com/andywang425/opencode-go-usage-api) — 工作区页面抓取方案
- [tddworks/ClaudeBar](https://github.com/tddworks/ClaudeBar/commit/4ca0426f988c81d3a8c39610085be1c585bd6915) — 5hr/周/月配额 + 本地 DB 成本查询
- [Ychris12138/dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats) — DSH 会话日志按模型聚合参考
