# agent 域（代理分佣）

对照 `xxww0098/podhub` @ `7df856a`（v0.0.112）。Rust 源码按 `uploads/spec-dsa.md` 与 `uploads/spec-dsa-agent.md` 摘录。本域 7 个 `/api/agent/**` 路由已按摘录实现。管理端 `/api/admin/agents*` 仍不在本域。

这 7 个路由只认会话，不调用 `require_tenant`，也不开 `tenant.BeginApp`。`org_id` 可以为 0。实现说明里要求租户事务和「缺 GUC 必失败」；规格写明 `agents`、`agent_commissions`、`agent_commission_wallets`、`agent_commission_ledger`、`agent_withdrawals`、`agent_rebate_policy` 没有 RLS。本端口按规格做。写事务整段 `SET ROLE podhub_app`。`user_wallets` / `wallet_ledger` 有 RLS，只在佣金转入钱包时设置 org 与 wallet user 两个 GUC。

未登录正文是 `{"error":"未登录","code":"AUTH_REQUIRED"}`。错误带 `X-Content-Type-Options: nosniff`。成功响应不带这个头。JSON 紧凑、按结构体字段顺序、不转义 HTML、没有结尾换行。

## 端点

| 方法 | 路径 | operationId | 本端口 |
| --- | --- | --- | --- |
| GET | `/api/agent` | `agent_workbench` | 200 工作台。非代理 404 `你不是代理` |
| POST | `/api/agent/claim` | `claim_agent_invite` | 200 `{"data":{"agent_name":...}}`。写归因与审计 |
| GET | `/api/agent/ledger` | `list_agent_ledger` | 200。只留 `commission` 与 `transfer_out` |
| PUT | `/api/agent/payout-account` | `save_agent_payout_account` | 200。三字段皆 null 时 `{"data":null}` |
| POST | `/api/agent/wallet-transfers` | `transfer_agent_commission` | 200。同一 `operation_id` 与金额重放不再入账 |
| GET | `/api/agent/withdrawals` | `list_agent_withdrawals` | 200。空的 reference / reject_reason / decided_at 省略 |
| POST | `/api/agent/withdrawals` | `request_agent_withdrawal` | 200 pending。冻结 `held_cents` |

四个写路由在鉴权之后才解析 JSON。缺 Content-Type、语法错误、缺键、未知字段、类型不符、超过 2 MiB，都是 400 `{"error":"请求格式无效","code":"VALIDATION"}`。领域校验在 auth 写事务里，所以认证域未启用时先返回 503，而不是 400。

## 规格与测试

| 规格 | 测试 |
| --- | --- |
| 未登录 401 `AUTH_REQUIRED`，且先于 JSON | `TestAnonymousIsAuthRequiredBeforeTheBody`，`TestAgentRoutesAreMounted` |
| 403 保留解析器原文；错误不转义 HTML | `TestRefusalKeepsTheResolverMessage`，`TestHTMLInTheErrorIsNotEscaped` |
| 工作台字段顺序；未设置收款方式时省略键；`commissions` 为 `[]` | `TestWorkbenchBytesOmitAnEmptyPayout`，`TestWorkbenchIncludesPayoutWhenSet` |
| JSON 拒绝不进库 | `TestJSONRejectionDoesNotCallTheStore`，`TestOversizeBodyIsValidation` |
| 清除收款方式是 `{"data":null}` | `TestPayoutNullClearsAndPartialIsRejected` |
| 认领、转入、提现的成功字节；提现列表省略空键 | `TestClaimAndTransferAndWithdrawalBytes` |
| 400 / 409 / 500 / 503，`55P03` 的 `Retry-After: 1` | `TestFailureKinds` |
| 未登录不碰仓库；org 0 仍可读 | `TestLoggedOutDoesNotTouchTheStore`，`TestOrgZeroStillReads` |
| 邀请码、掩码、收款方式、提现公开号、账本与提现边 | `TestNormalizeInviteCode`，`TestMaskEmail`，`TestNormalizePayoutMessages`，`TestWithdrawalPublicIDAlphabet`，`TestLedgerShapesMatchChecks`，`TestWithdrawalEdgesFromSchema` |
| 六张代理表无 RLS；`podhub_app` 仍看见两行；缺 GUC 不藏代理行 | `TestAgentTenantAndLedger` 前三个子测试 |
| 按会话用户过滤；org 0 可读；收款方式不串用户 | `service_scopes_by_session_user_and_allows_org_0`，`payout_update_does_not_cross_users` |
| 账本不可改；提现 CHECK；归因写一次 | `ledger_trigger_rejects_rewrite`，`withdrawal_check_and_one_pending`，`attribution_is_write-once` |
| 账本列表丢掉 `withdrawal_hold` | `ledger_hides_withdrawal_holds` |
| 认领、重放、异参冲突、停用码、已付款拒绝、无工作空间、写租约 503、钱包缺 GUC | `TestAgentFlows` |
| `podhub_app` 下空域允许、匹配行心跳、异实例 503 | `TestWriterLeaseHeartbeatsAsPodhubApp` |
| 24 小时内归因超过 20 次打标 | `TestAgentReviewFlag` |

## 改了哪个流程、结果为什么不变

1. 旧端口把工作台收成一个 `tenant.BeginApp` 事务，并且 `org_id <= 0` 直接失败。规格是多次自动提交，且不要求当前组织。现已改成按会话 `user_id` 的多次自动提交。没有并发写入时，读到的行与一次快照相同。`TestAgentFlows` 在无并发下核对政策默认值、余额、掩码佣金和 `wallet_transfer_available`。
2. 四个写路由的形状校验放在拿到 auth 顾问锁之后，与 Rust 把校验放进 `write_under_authority` 闭包一致。JSON 拒绝仍在开事务之前。
3. 迁移 `m20260920_000329`（`db/migrations/00191_platform_runtime_grants.sql`）已经把 `account_users`、`audit_logs`、`writer_leases` 的 `SELECT, INSERT, UPDATE, DELETE` 授给 `podhub_app` 和 `podhub_worker`。写事务整段 `set_config('role', 'podhub_app', true)`，不再在钱包语句之后 `RESET ROLE`。`TestAgentFlows` 走这条生产角色路径。

## 租户

代理六表 `relrowsecurity` 与 `relforcerowsecurity` 都是 false。缺 GUC 时 `podhub_app` 仍能按 `user_id` 读到账本。隔离是 `WHERE user_id = 会话用户`，不是 RLS。

`user_wallets` 在 `podhub_app` 且未设 wallet GUC 时行数为 0，插入失败。转入路径在已经是 `podhub_app` 的事务里再设两个 GUC。

## 对照测试

无数据库：

```text
go test ./internal/agent/domain ./internal/agent/service ./internal/agent/http ./internal/app ./tests/archtest ./tests/parity
```

有数据库（`PODHUB_PARITY_DSN` 指向回环 Postgres 16）：

```text
PODHUB_PARITY_DSN=postgres://postgres:postgres@127.0.0.1:5432/podhub?sslmode=disable \
  go test ./tests/integration/ -run 'TestAgent' -count=1
```

本地这次结果：`internal/agent/...`、`internal/app`、`tests/archtest`、`tests/parity` 通过。`TestAgentFlows`、`TestAgentReviewFlag`、`TestAgentTenantAndLedger` 通过。成功体与错误体用 `tests/parity.DiffHTTP` 按字节比较。Web 夹具里的 `"payout_account": null` 与 `"reference": null` 不是线上 serde 输出，没有当成 golden。

## 需要用户决定

1. `COMMISSION_PROJECTION` 的 SQL 正文没有贴出。工作台佣金列表按 `AgentCommissionView` 的列，从 `agent_commissions c` 连接 `account_users`（被邀邮箱）、`organizations`（工作空间名）、`payment_orders`（product），`ORDER BY c.created_at DESC, c.id DESC LIMIT 200`，再在 Go 里 `mask_email`。`TestAgentFlows/workbench_masks_the_invitee_from_the_commission_row` 只证明这套重建能读出掩码行。
2. `cloud_billing::wallet::view` 的正文没有贴出。重放路径是 ensure 之后 `SELECT balance_microfen`，不加 `FOR UPDATE`。
3. `existing_movement` 的 SQL 没有贴出。列按调用处使用的金额、冻结、余额和 `withdrawal_id` 推断。
4. 已确认。`LEASE_TTL_MS = 60_000`，holder 固定 `axum`，实例是 `CLOUD_INSTANCE_ID`（空白则 `axum-{pid}`），经 `internal/platform/config`。匹配且未过期的 `auth` 行允许写入并刷新 `heartbeat_at_ms` / `expires_at_ms`。曾经租过但当前无行、过期、心跳窗口已死、holder 或实例不符，返回 503 `认证域写入未启用`。空表允许写入，审计租约列为 NULL。依据是规格 X3-B `write_under_authority` / `assert_authority`，测试 `TestDecideMatchesRustNotTheOldChecks`。
5. 并发转入撞上 `wallet_ledger_key_uidx` 时驱动返回的 23505 文本未确认。第二笔在佣金转出重放成功之后再 `adjust`，唯一索引失败走 500 `服务暂不可用` 并回滚。没有单独映射成 409。
6. 已确认。不需要新迁移。`m20260920_000329` 已授权。写路径整段使用 `podhub_app`。
7. Caddy 1MB 正文的对外文案未确认。这四个写路由超过 2 MiB 时返回 400 `请求格式无效`，不返回 413。
8. sqlc v1.31.1 不在本环境。新 SQL 留在 `internal/agent/repo` 的参数化语句里。`db/queries/agent/agent.sql` 里原有的查询没有覆盖这些语句，生成包未被这些路由调用。
