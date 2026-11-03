# MCP 对拍

对照 `xxww0098/podhub` @ `7df856a`（v0.0.112）。Rust 源码按 `uploads/spec-aomt-mcp.md` 摘录。当前 `GET` / `POST` / `DELETE /mcp` 已在 `api/openapi.yaml` 与路由清单中；早期「不在 OpenAPI」的盘点已失效。

层级：L6。`internal/mcp` 只依赖 `identity/contract` 的会话形状，不导入 identity 的 service 或 domain。执行表用 `app.automation_grant_id`，工作区读名时再 `tenantx.EnterApp`。

## 端点

`opa_` 路径先检查 Bearer 形状，再看方法、Host / Origin，最后解析 grant 并处理 JSON-RPC。普通用户会话走 `serveSession`：先解析会话，再检查方法与 Host / Origin。两条入口不能混为只有 Bearer 一种鉴权。

- 自动化令牌必须是去掉首尾空白后以 `opa_` 开头、后缀非空且内部没有空白的 Bearer。无法解析有效 grant 或会话时是 HTTP 401，正文 `{"error":"invalid or expired automation grant token"}`，头 `WWW-Authenticate: Bearer realm="mcp"`。数据库错误同样 401，日志不写令牌。
- 形状合法的 `Bearer opa_...` 对非 POST 直接返回 405，此时尚未解析 grant，即使 grant 不存在或已过期也一样；`Allow: POST`，正文 `Method Not Allowed`。没有合法 `opa_` 形状时先解析普通用户会话，失败返回 401，成功后非 POST 才返回 405。POST 的 grant 路径会继续检查 Host / Origin 和有效 grant。
- Host 不允许是 403 纯文本 `Forbidden: Host header is not allowed`。Origin 不允许是 403 `Forbidden: Origin header is not allowed`。坏 Host 是 400 纯文本。
- 未设置或空的 `CLOUD_MCP_ALLOWED_HOSTS` 使用 loopback 默认 `localhost`、`127.0.0.1`、`::1`，不是全部拒绝。空 Origin 列表不检查 Origin。Host 大小写不敏感；允许项不带端口则任意端口通过，带端口则必须相等。
- 非空 Origin 列表按协议、主机和有效端口比较；省略端口的 `https` 等于 443，`http` 等于 80，不使用 Host 的任意端口规则。缺 Origin 仍通过；带用户信息、路径、查询或片段等非法 Origin 返回 400，合法但不在列表中返回 403。依据 `internal/mcp/domain/allow.go`。
- `CLOUD_MCP_RUNNER_PATH` 空白时是 `podhub-mcp-runner`。非绝对路径按原样保存。本进程不拉起 runner。

协议版本 `2025-11-25`。服务名 `podhub-mcp`，版本 `0.0.0`。对拍工具是 `search` 与 `execute`。激活码与额度卡工具是后来加在同一条 `/mcp` 上的，不在这次对拍范围内，见下文。

## 激活码与额度卡

当前只发行 `wallet_credits` 钱包额度卡（`POD-WALLET-`，面额 `wallet_cents`）。`member_seats` 激活码已停发；`generateActivationCodes` 虽仍在工具目录中，但有效请求也会被共享校验拒绝，不能把列出工具视为可用发行能力。`generateQuotaCards` 与管理端共用 `ParseRedeemBody`、`ValidateRedeemCreate`、`Entitlement.CreateRedeem`，数量为 1–500、面额为 100–1,000,000 分；成员和识别额度必须为 0，tier 必须为空。请求仍要求 `member_seats`、`quantity`、`duration_days` 三个键，钱包卡入库的 duration 固定为 1。省略兑换截止时间时默认 30 天。

`listRedeemCodes` 仍可列出历史激活码；列表只有 `code_preview`。明文码按原表存储，只在创建响应中返回。当前实现见 `internal/app/mcp_codes.go`、`internal/admin/domain/redeem_rules.go` 与 `internal/mcp/service/codes.go`。

`opa_` 授权令牌仍只跑 `search` / `execute`。这三个工具认的是和管理端相同的用户会话，并且只要求平台角色 `super_admin`；验证器和 step-up 已删除，没有二次验证环节。令牌路径调用会被拒绝。`tools/list` 对已登录调用者仍列出全部工具，调用时再拒绝，这和原来的 `tools/list` 不按能力过滤是同一做法。没有新增 HTTP 路由。

## 提示词构建工具

`promptBuild.getInputs`、`promptBuild.getSample`、`promptBuild.testCandidate`、`promptBuild.getRun` 让用户自己的构建环境为商品迭代提示词：读商品事实和试用图片，自己改稿，提交后由服务端用生产识别模型实测，再读回真实输出。它们和激活码工具一样走用户会话，只要求平台角色 `super_admin`；`opa_` 令牌路径和其他角色被拒绝。没有新增 HTTP 路由。

工具目录里没有采用与发布。采用仍由人在商品页面完成，外部候选与页面里的候选走同一条采用路径。`testCandidate` 的候选先过与模型提案相同的程序检查（六行格式、规格、固定标签、受限词、与已有候选重复），失败时不调用识别模型，不扣费。商品已有固定标签时，提交不同的列表会被拒绝，不会被静默替换。预算、模型和账号不能由调用方指定。

实现见 `internal/mcp/service/prompts.go`、`internal/app/mcp_prompts.go` 与 `internal/admin/x1/service/prompt_build.go`。调用方的使用步骤见 `skills/prompt-build-iterate/SKILL.md`。

## 规格与测试

| 规格 | 测试 |
| --- | --- |
| 1.3 / 1.4 grant 路径先 Bearer 形状再方法；会话路径先解析会话；401 正文与 `WWW-Authenticate` | `TestBearer`，`TestMCPGateOrder` |
| 2.4 Host / Origin；Host 默认 loopback，空 Origin 列表不检查，非空列表比较有效端口 | `TestAllowList`，`TestMCPGateOrder` |
| 配置：缺省、逗号切分、空白 runner | `TestMCPDefaults`，`TestMCPParsesCommaListsAndBlankRunner` |
| 2.1 `initialize` 的 `protocolVersion` | `TestMCPGrantContextAndReplay` |
| 3 `tools/list` 仍含 search 与 execute；`catalog_changed` 在 `Begin` 之前。激活码、额度卡和列表工具不在对拍范围 | `TestMCPSearchAndCatalogChanged` |
| 4 `workspace.getContext` 完成；重放省略 `value` | `TestMCPGrantContextAndReplay` |
| 指定方案、商品和店铺的 `workspace.listingRows.getState`，含最新提交回执和授权隔离 | `TestListingStateRequiresVisibleExactStoreAndLiveGrant` |
| 8.3 另一 grant 的 GUC 看不到执行行 | `TestMCPGrantContextAndReplay` |

## 改了哪个流程、结果为什么不变

1. 只解释 `return await sdk.<method>(input);` 这一种调用。其它代码返回 `sandbox_unavailable` / `An operating system sandbox is required`，不执行任意 JavaScript，也不拉起 `podhub-mcp-runner`。成功路径只有这一条调用形式；`workspace.getContext` 的完成值与重放省略 `value` 由 `TestMCPGrantContextAndReplay` 核对。
2. 目录收录 7 个 workspace 方法和 `automation.executions.get`。37 个 business 方法的 schemars 与 store SQL 未导出，所以不进目录。`catalogVersion` 由本进程的 canonical 方法表与授权摘要算出，不声称与 Rust 字节相同。
3. 已收录但没有导出 SQL 的 workspace 方法（`stores.list`、`cards.list`、`assets.list`、`listingIntents.list`、`createDraftFromCatalogProduct`）返回 `method_not_found` / `SDK method is not available`。`getContext` 读 `organizations.name`。`listingRows.getState` 按方案、商品、店铺和当前授权精确读取商品状态及最新提交证据。`executions.get` 读本 grant 的执行与收据。

## 租户

`automation_executions` / `automation_call_receipts` 的策略是 `grant_owner_isolation`。事务设置 `role=podhub_app` 和 `app.automation_grant_id`。换一个 grant id 时 `count(*)` 为 0。工作区名称在 `tenantx.EnterApp` 之后再设 grant GUC。非 staff 的 `supplier_catalog` grant 解析为拒绝。

## 对照测试

无数据库：

```text
go test ./internal/mcp/... ./internal/platform/config/ ./internal/app/ ./tests/archtest/ -count=1
```

loopback Postgres：

```text
go test ./tests/integration/ -count=1 -run 'TestMCPGrantContextAndReplay' -timeout 180s
```

原移植验证记录：上述包当时通过；本次文档复核没有重跑数据库对拍。`TestMCPGrantContextAndReplay` 为 `ok`（initialize 含 `2025-11-25`，首次 `workspaceName` 为 `MCP Space`，重放正文不含 `"value"`，另一 grant 看到 0 行）。

## 需要用户决定

1. 37 个 business 方法的输入 schema 与 SQL 未导出，目录里没有它们。`catalogVersion` 不声称与 Rust 字节相同。
2. 没有 QuickJS，也不拉起 runner。不是 `return await sdk.<method>(input);` 的代码一律 `sandbox_unavailable`。
3. 工具 `inputSchema` 是手写的、`additionalProperties: false`，不是 schemars 1.2.2 的转储。`initialize` 的 `capabilities.tools` 没有 `listChanged`。`server/discover` 的正文，以及未实现方法的 `-32601 Method not found`，按 rmcp 默认处理，原文未导出。缺少 `Accept` / `Content-Type` 的 POST 不因此拒绝。
4. 外层正文超过 2MiB 时是空正文 413。axum 的 413 文本未导出。
5. `db/schema` 没有 automation 表。SQL 写在 `internal/mcp/repo`，没有改 migration。
