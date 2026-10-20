# MCP 对拍

对照 `xxww0098/podhub` @ `7df856a`（v0.0.112）。Rust 源码按 `uploads/spec-aomt-mcp.md` 摘录。`/mcp` 不在 OpenAPI 425 个 operation 里，路径本来就在路由表中（`GET` / `POST` / `DELETE`）。

层级：L6。`internal/mcp` 只依赖 `identity/contract` 的会话形状，不导入 identity 的 service 或 domain。执行表用 `app.automation_grant_id`，工作区读名时再 `tenantx.EnterApp`。

## 端点

`POST /mcp` 先认 Bearer，再看方法，再查 Host / Origin，再解析 grant，再处理 JSON-RPC。

- 令牌必须是去掉空白后以 `opa_` 开头的 Bearer。失败是 HTTP 401，正文 `{"error":"invalid or expired automation grant token"}`，头 `WWW-Authenticate: Bearer realm="mcp"`。数据库错误同样 401，日志不写令牌。
- 未登录的 `GET` / `DELETE` 也是 401，不是 405。登录之后只有 `POST`：`GET` / `DELETE` 为 405，`Allow: POST`，正文 `Method Not Allowed`。
- Host 不允许是 403 纯文本 `Forbidden: Host header is not allowed`。Origin 不允许是 403 `Forbidden: Origin header is not allowed`。坏 Host 是 400 纯文本。
- 未设置或空的 `CLOUD_MCP_ALLOWED_HOSTS` 使用 loopback 默认 `localhost`、`127.0.0.1`、`::1`，不是全部拒绝。空 Origin 列表不检查 Origin。Host 大小写不敏感；允许项不带端口则任意端口通过，带端口则必须相等。
- `CLOUD_MCP_RUNNER_PATH` 空白时是 `podhub-mcp-runner`。非绝对路径按原样保存。本进程不拉起 runner。

协议版本 `2025-11-25`。服务名 `podhub-mcp`，版本 `0.0.0`。对拍工具是 `search` 与 `execute`。激活码与额度卡工具是后来加在同一条 `/mcp` 上的，不在这次对拍范围内，见下文。

## 激活码与额度卡

管理端兑换码就是这两样东西：`member_seats` 是激活码（`POD-PLAN-`，档位、名额、有效期），`wallet_credits` 是额度卡（`POD-WALLET-`，面额 `wallet_cents`）。生成、校验、审计和列表掩码仍走 `Entitlement.CreateRedeem` / `ListRedeem` 与 `ParseRedeemBody`。明文码按原表存原文，只在创建响应里出现；列表是 `code_preview`。

`opa_` 授权令牌仍只跑 `search` / `execute`。这三个工具认的是和管理端相同的用户会话，并且要过 `SuperAdmin` 与 TOTP step-up。令牌路径调用会被拒绝，不能绕过二次验证。`tools/list` 对已登录调用者仍列出全部工具，调用时再拒绝，这和原来的 `tools/list` 不按能力过滤是同一做法。没有新增 HTTP 路由。

## 规格与测试

| 规格 | 测试 |
| --- | --- |
| 1.3 / 1.4 先 Bearer，再方法；401 正文与 `WWW-Authenticate` | `TestBearer`，`TestMCPGateOrder` |
| 2.4 Host / Origin；空列表是 loopback，空 Origin 不检查 | `TestAllowList`，`TestMCPGateOrder` |
| 配置：缺省、逗号切分、空白 runner | `TestMCPDefaults`，`TestMCPParsesCommaListsAndBlankRunner` |
| 2.1 `initialize` 的 `protocolVersion` | `TestMCPGrantContextAndReplay` |
| 3 `tools/list` 仍含 search 与 execute；`catalog_changed` 在 `Begin` 之前。激活码、额度卡和列表工具不在对拍范围 | `TestMCPSearchAndCatalogChanged` |
| 4 `workspace.getContext` 完成；重放省略 `value` | `TestMCPGrantContextAndReplay` |
| 8.3 另一 grant 的 GUC 看不到执行行 | `TestMCPGrantContextAndReplay` |

## 改了哪个流程、结果为什么不变

1. 只解释 `return await sdk.<method>(input);` 这一种调用。其它代码返回 `sandbox_unavailable` / `An operating system sandbox is required`，不执行任意 JavaScript，也不拉起 `podhub-mcp-runner`。成功路径只有这一条调用形式；`workspace.getContext` 的完成值与重放省略 `value` 由 `TestMCPGrantContextAndReplay` 核对。
2. 目录只收录 6 个 workspace 方法（规格里的 `json!`，键已排序）和 `automation.executions.get`。37 个 business 方法的 schemars 与 store SQL 未导出，所以不进目录。`catalogVersion` 由本进程的 canonical 方法表与授权摘要算出，不声称与 Rust 字节相同。
3. 已收录但没有导出 SQL 的 workspace 方法（`stores.list`、`cards.list`、`assets.list`、`listingIntents.list`、`createDraftFromCatalogProduct`）返回 `method_not_found` / `SDK method is not available`。`getContext` 读 `organizations.name`。`executions.get` 读本 grant 的执行与收据。

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

本机结果：上述包通过。`TestMCPGrantContextAndReplay` 为 `ok`（initialize 含 `2025-11-25`，首次 `workspaceName` 为 `MCP Space`，重放正文不含 `"value"`，另一 grant 看到 0 行）。

## 需要用户决定

1. 37 个 business 方法的输入 schema 与 SQL 未导出，目录里没有它们。`catalogVersion` 不声称与 Rust 字节相同。
2. 没有 QuickJS，也不拉起 runner。不是 `return await sdk.<method>(input);` 的代码一律 `sandbox_unavailable`。
3. 工具 `inputSchema` 是手写的、`additionalProperties: false`，不是 schemars 1.2.2 的转储。`initialize` 的 `capabilities.tools` 没有 `listChanged`。`server/discover` 的正文，以及未实现方法的 `-32601 Method not found`，按 rmcp 默认处理，原文未导出。缺少 `Accept` / `Content-Type` 的 POST 不因此拒绝。
4. 外层正文超过 2MiB 时是空正文 413。axum 的 413 文本未导出。
5. `db/schema` 没有 automation 表。SQL 写在 `internal/mcp/repo`，没有改 migration。
