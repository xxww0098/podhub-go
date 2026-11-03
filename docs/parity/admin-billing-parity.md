# 管理端账单与观察对拍

范围：`/api/admin` 下的套餐、订单、兑换码、支付配置、工作区钱包，以及平台观察和错误日志。当前订单详情 GET、兑换码详情 GET 和 `/redeem-codes/{id}/revoke` 未在路由表注册；兑换码删除使用 `DELETE /api/admin/redeem-codes/{id}`，不能从残留 dispatch 分支推断入口仍可用。未列入本文件的管理路由写在 `admin-parity.md`、`adminb-misc-parity.md` 和 `admin-users-ai-auth-parity.md`。那些生产成功路径已经不是整段 501。

规格来源是任务附带的 Rust v0.0.112 摘录（HEAD `7df856a`），不是私有 Rust 仓库。没有读到的句子保持 501 `not_ported`，或写在文末「需要用户决定」。

写闸与规格 X3-B 相同：匹配本进程 `axum` + `CLOUD_INSTANCE_ID` 的未过期行允许并心跳。权益文案「权益域写入未启用」，兑换与席位「管理域写入未启用」，支付与连接配置「平台连接配置写入未启用」，错误日志删除走 telemetry「遥测域写入未启用」。曾经租过但当前无有效行、过期或身份不符仍是 503 `WRITES_DISABLED`。

## 规格章节与测试

| 规格 | 测试 |
| --- | --- |
| 账单 0.5 超管门（只按 `super_admin` 角色，无验证器与 step-up） | `TestAdminBAuthFamilies` |
| 账单 0.3 CSRF | `TestAdminBCSRFAndValidation` `TestCrossOriginWrite` |
| 账单 1 套餐列表 | `TestAdminBillingOps`（`GET /api/admin/plans` 与 `plans_listed`） |
| 账单 4 确认钱包充值、第二次 409 | `TestAdminBillingOps` |
| 账单 4.5 `credit_cents>0` 入账、席位、佣金、通知 | `TestOrderConfirmCredit` `TestSeatCreditLineHandFixture` `TestCommissionDecisionAndPayload` `TestAdminBillingOps` |
| 账单 6–10 兑换码 | `TestRedeemStatusPriority` `TestCodePreview` `TestValidateRedeemCreate` `TestOperationID` `TestAdminBillingOps` |
| 账单 11–12 支付配置与渠道 `try_new` | `TestIntegrationKey` `TestPaymentNormalizeAndPending` `TestProviderFromConfigChannels` `TestStoredPaymentOptionalAndStrict` `TestPaymentReadsAdminCamelAndRewrittenSnake` `TestAdminBillingOps` |
| 账单 13–15 手动赠送与撤回 | `TestAdminBillingOps` |
| 账单钱包 RLS、缺 GUC、跨所有者 | `TestAdminBillingOps` |
| 观察读事务与 `platform_observation_select` | `TestAdminBillingOps` |
| 观察 scopes | `TestAdminBillingOps` |
| 观察商品 URL 分类 | `TestClassifyImageFixture` |
| 观察新鲜度、游标、名额峰值 | `TestNormalizeUUID` `TestStoreFreshness` `TestCursorAndNeedle` `TestPeakSeats` |
| 错误日志查询校验 | `TestErrorQueryAndLabels` `TestAdminBCSRFAndValidation` `TestAdminBillingOps` |
| 兑换码路径不是 i64 | `TestRedeemNonIntegerID` `TestAdminBCSRFAndValidation` `TestRouteTableMatchesGolden` |

领域测试：

```
go test ./internal/admin/... -count=1
```

集成测试（回环 Postgres 16，`PODHUB_PARITY_DSN`）：

```
PODHUB_PARITY_DSN='postgres://postgres:postgres@127.0.0.1:5432/podhub?sslmode=disable' \
  go test -count=1 -timeout 15m -run 'TestAdminBillingOps|TestOrderConfirmCredit' ./tests/integration/
```

2026-10-17 在本机 PostgreSQL 16 上，`TestAdminBillingOps` 与 `TestOrderConfirmCredit` 覆盖：`credit_cents>0` 且 `credit_lots` 为空时确认成功并写入一条新批次，实付低于 `min_order_cents` 不写佣金；手算抵扣行（lot 替换为真实 id，`starter` / consumed 2000）写入 `member_seat_lot_credits`；同一订单再次确认为 409；同一 `lot_id` 再次入账为 503 且订单回到 `pending`，入账行仍为一行；并发确认只有一个 200。成功响应没有 `credit_lots`。非法兑换码路径是 400 纯文本，空段是 API JSON 404。这些路径不再返回 501 `not_ported`。

## 当前变化与保留的历史结算

- 当前兑换码支持钱包额度和套餐；`member_seats` 与识图额度不再发放。`ParseRedeemBody` / `ValidateRedeemCreate` 是 HTTP 与 MCP 共用的验证入口，MCP 工具仍只暴露钱包额度生成，见 [MCP 对拍](mcp-parity.md)。
- 当前 `ConfirmOrder` 在 pending → paid 的 CAS 后调用首单佣金结算；`product=subscription` 经 `FulfillSubscriptionOrder` 履约并记录 `subscription_payment_settled`。旧席位订单的两套结算分支仍存在，用于已有订单，不能据此宣称仍可新购席位批次。实现位于 `internal/admin/billing/repo/plans_orders.go`。
- 钱包入账自己写 `workspace_wallets` / `wallet_ledger`，不调用 `billing/repo.TopupTx`。后者对相同幂等键会重放成功；本确认路径要让唯一约束失败并回滚整笔结算。重复确认先被 `pending` 的 CAS 挡成 409。
- 旧席位订单中，`credit_cents==0` 的 `settleSeats` 局部分支仍以本单名额设置 `seat_limit`，不额外入账或 reconcile；首单佣金已由外层 `ConfirmOrder` 统一处理，不能解读为零抵扣订单完全无佣金。`credit_cents>0` 的 `settleCredit` 保留抵扣入账、投影与 reconcile。见文末。
- 缩略图生产接线只访问回环地址。规格里的 Rust 会请求公网 CDN。这是有意收窄，见文末。
- 观察路由的 `Cache-Control: private, no-store` 与 `Vary` 由处理器写出。现有边缘没有 UserAdmission，本处理器不再加第二套限流。

`OZON_WRITE_KILL_SWITCH` 与 `CLOUD_MEDIA_GC_DELETE` 的解析点没有改。这些路由不读这两个开关。

## 仍返回 501 的相关项

本文件范围内，`PUT /api/admin/orders/{public_id}/confirm` 在 `credit_cents>0` 时不再返回 501。兑换码路径不是整数时不再返回 501。支付配置渠道校验不再因 `try_new` 原文未确认而停在缺字段检查。其余管理路由里仍为 501 的项写在 `admin-parity.md`、`adminb-misc-parity.md` 和 `admin-users-ai-auth-parity.md`，这次没有改那些清单。

## 需要用户决定

1. 确认成功响应里的工作区名、创建人邮箱、`paid_at` 瞬时值依赖真实订单行，规格标为未确认。测试只钉形状：`paid`、`canceled_at=null`、没有 `credit_lots`、`paid_at` 为毫秒 Z。
2. `抵扣快照无法解析：` 后面的 serde 错误后缀未导出。Go 使用 encoding/json 的错误文本，HTTP 正文不包含这段内部原因。
3. `max_seats_in_window` 的两条 SELECT 原文没有导出。待支付席位单按 `[now, now+该单 duration_days)` 计入峰值，排除的 lot id 为空。若与 Rust 窗口不一致，以用户核对为准。
4. `load_active_seat_state` 没有导出。店铺上限取 `store_limit_override`，否则 `plans.max_stores`，再 `max(1, n)`。
5. `find_plan` 无行才是「未开放」。这里把 `active=false` 也当成同一句。
6. `credit_cents==0` 的席位确认没有改成与 `credit_cents>0` 相同的投影和 reconcile。规格说 0 只是跳过入账。本任务只替换原来的 501 分支。
7. `lifecycle.rs` 把 `apply_*` 的全部错误包成 Fulfillment。HTTP 表把档位、数量、解散、20 席、续费批次、加购项写成 400。实现跟 HTTP 表。只有解析失败、重复入账、`Workspace 不存在` 走 503 和事务外审计。
8. 规格散文写 `" "` 能过 `validate_config` 再在 `https_url` 失败。导出的 Rust 用 `trim().is_empty()`，空白会先报「缺少配置字段」。实现跟导出的 Rust。直接 `try_new` 仍不 trim。
9. Go 的 `try_new` / `from_parts` 不构造 HTTP 客户端。`reqwest` 失败原文不是封闭集合。
10. 佣金审计的 `entity_id` 规格没有写明，这里用佣金行 id 的十进制文本。账本 `note` 用佣金那句「代理佣金 · 订单 …」。
11. 管理端确认先经 `billing_payment_order_org` 查询组织；该 lookup 不锁订单。随后 `tenantx.EnterApp` 切换 `podhub_app` 与组织 GUC，通过写门、锁定有效组织，再用 `pending → paid` CAS 更新订单。这一点已由 [S1](security-hardening.md) 改变，不再沿用连接所有者完成订单写入。`workspace_wallets` 与 `wallet_ledger` 的 RLS 看组织 GUC（迁移 `00013` 起不再有钱包用户 GUC）。缺 GUC 时 `RequireOrg` 失败，且 `podhub_app` 既看不到也插不进 `workspace_wallets`。两个组织的名额互不影响由确认测试覆盖。
12. 通知列是 jsonb，读回的文本不一定等于插入前的紧凑 JSON。插入前的字节由 `TestCommissionDecisionAndPayload` 对拍夹具。
13. 缩略图生产环境拒绝非回环主机并返回 502 `商品图片暂时无法读取`。Rust 会请求公网 Ozon CDN。
14. v3 错误日志的私有维度拒绝没有规格中的 codec，投影只去掉 `rawPayload` 与 `payloadSha256`。
15. 错误日志删除与支付配置的未知 JSON 字段，本端口返回 400 `请求格式无效`。axum 默认拒绝体未确认。
16. 准入 429/503 不在本处理器实现。Go 边缘目前没有对应的 UserAdmission。
17. 套餐列表、订单列表对未知 query 忽略。规格未确认 axum 是否忽略。
18. 观察名册的 `permissions` 序列化为空对象。规格夹具只要求每个值都是 false。
19. 账单查询现位于 `internal/admin/billing/repo`，共享写门和审计在 `internal/admin/core/repo`，没有为这些手写 SQL 新增 sqlc 文件。`credit_cents==0` 的 `seat_limit` 仍取本单名额。
