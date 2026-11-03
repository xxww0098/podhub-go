# S1 安全收紧

只做 R4 的三项建议。当时新增的 `00294_billing_order_rls.sql` 现已并入基线 `db/migrations/00002_schema.sql`，账单与平台订单的 RLS 策略在基线里。`OZON_WRITE_KILL_SWITCH` 与 `CLOUD_MEDIA_GC_DELETE` 没有动，解析仍只在 `internal/platform/config`。

本仓库的 Rust 覆盖上架、标签与渲染等内核，不含原服务端的身份、计费与卖家代码。对照依据是规格里已经写明的行为，以及本仓库里原有的确认、回调、兑换、卖家确认测试。空租约从「放行」改成「拒绝」是用户在 2026-10-17 确认的行为变化，不假装和既有实现相同。

## 做了什么

1. **登录角色。** `db.Connect` 在 `AfterConnect` 里读 `current_user`。是 superuser 或 `BYPASSRLS` 就拒绝这次连接，`Ping` 让进程启动时失败。唯一的例外是环境变量 `PODHUB_ALLOW_SUPERUSER_DB` 的值正好为 `1`。环境变量读取集中在 `internal/platform/config/env.go` 的 `AllowSuperuserDB`；`internal/platform/db/login_role.go` 的 `allowSuperuserDB` 只调用该配置函数。测试里的 postgres 角色在 `db.Connect` 之前设置它。生产调用 `internal/app` 与 `internal/app/worker` 不设置。

   订单确认、支付回调、兑换、`auditFailed` 先按 `public_id` 或兑换码查出组织，再 `tenantx.EnterApp` / `BeginApp`。API 登录角色是 `podhub_login_api`，它可以切换 `podhub_app`，没有 `podhub_worker`，也不能靠 `BeginWorker` 跨组织查找。查找放在 `SECURITY DEFINER` 函数里，属主是 `podhub_billing_lookup`（`NOLOGIN`、无 `BYPASSRLS`、不授给登录角色）。`payment_orders` 与 `redeem_codes` 上有只给这个角色的 `billing_lookup` 策略。函数执行完，同一事务 `SET ROLE podhub_app` 并设置 `app.current_org_id`，后面的更新走 RLS。

2. **RLS。** 基线 `00002_schema.sql` 对 `payment_orders`、`member_seat_lots`、`member_seat_lot_credits`、`ai_requests`、`sc_orders`、`sc_order_lines` 打开并 `FORCE ROW LEVEL SECURITY`。`podhub_app` 的 `tenant_isolation` 要求 `org_id` 等于 `app.current_org_id`。`podhub_worker` 另有 `worker_claim`（`USING (true)`）。`podhub_worker` 今天仍是 `BYPASSRLS`，这条策略在去掉该属性之后才生效，现在不改变 worker 的可见行。

   `redeem_codes` 没有 `org_id`。`used_by_org_id` 只在核销时写入，不能拿来做租户隔离。因此没有 `podhub_app` 策略，直接 `SELECT`/`UPDATE` 看不到行。查找用 `billing_lock_redeem_code`，核销用 `billing_consume_redeem_code`。核销函数要求当前 GUC 等于传入的组织，否则 `42501`。

   管理端确认与支付回调当前都先用不加锁的 `billing_payment_order_org` 查询组织，再 `EnterApp`。管理端随后锁定有效组织并用 pending 状态 CAS 更新订单；支付回调则先 `FOR UPDATE` 锁组织，再 `FOR UPDATE` 读取订单。迁移中仍定义带订单锁的 `billing_lock_payment_order`，但这两条当前路径均未调用它。对账扫描用 `billing_replay_candidates`，每笔再 `BeginApp`。代理认领要数该用户名下全部组织的已支付订单，不能只看当前 GUC，所以用 `billing_owner_paid_orders`。管理端佣金列表和代理工作台按订单 id 取 `public_id` 与 `product`，用 `billing_payment_order_brief`。这几条函数都 `REVOKE ALL FROM PUBLIC`，再按调用方授予 `EXECUTE`。

3. **空租约拒绝。** `writer.Decide` 在域内没有未撤销行时返回拒绝。`writer.Assert` 因此返回 503。`writer.Bootstrap` 不经过 `Decide`，插入第一条未撤销行，并在同一事务写入 `writer_lease_events`；本实例持有且仍有效时返回原 id；本实例租约过期返回 `ErrLeaseExpired`，别的实例持有则 `ErrLeaseHeld`，不自动续活或抢占。命令是 `writer-lease bootstrap <domain>`（`cmd/writer-lease`）。

## 改了哪个流程，结果为什么不变

| 流程 | 改了什么 | 为什么结果不变 |
| --- | --- | --- |
| 管理端确认订单 | 先 `billing_payment_order_org` 查询组织，再 `EnterApp`；通过 `admit` 后锁有效组织，以 `pending → paid` CAS 更新订单并结算。缺 `public_id` 在租约检查之前返回 404 | 组织与订单行一致。钱包结算在 `withWallet` 之后把角色设回 `podhub_app`，审计仍在同一事务。`TestOrderConfirmCredit`、`TestAdminBillingOps`、`TestSecurityCutover` 的已支付状态、名额批次和钱包分录与改前断言相同 |
| 支付回调 | `apply` 先查询组织并 `EnterApp`，再依次 `FOR UPDATE` 锁组织和订单。对账列表改走 `billing_replay_candidates`，条件与原来的 `SELECT` 相同，再 `BeginApp` 调用原来的 `TopupTx` | 金额、币种、商品不匹配仍失败。`wallet_topup` 入账金额仍是 `topup_microfen`。成员名额订单仍保持 `pending`。`TestSecurityCutover` 用 `podhub_login_api` 打 EasyPay 回调，只把对应组织的订单改成 `paid` |
| 兑换 | `BeginApp` 之后用 `billing_lock_redeem_code` / `billing_consume_redeem_code`。名额与钱包的发放语句没改 | 无效、已用、已作废、过期、组织不匹配的句子不变。成功时 `used_by_org_id` 仍是调用方组织，钱包增加 `wallet_cents * 1_000_000` |
| 代理认领 | 已支付订单的计数从直接 `SELECT payment_orders` 改为 `billing_owner_paid_orders`。计数条件仍是属主用户的 `status = 'paid'` | `TestAgentFlows` 的「已有订单，无法绑定」仍是 409。佣金列表的 `public_id` 与 `product` 改走 `billing_payment_order_brief`，列不变 |
| 卖家确认平台订单 | 仍是 `BeginApp` 与 `writer.Assert(entitlement)`。`sc_orders` / `sc_order_lines` 现在受 RLS 约束，GUC 就是这笔订单的 `org_id` | 报价金额、`awaiting_payment`、幂等重放与改前相同。另一组织读到 0 行。管理端再确认后状态是 `awaiting_procurement`，与 `settlePlatform` 原来的更新相同 |
| 写租约 | 空域从允许改为拒绝。匹配的 `axum` + 实例仍心跳，过期和他实例仍拒绝 | 这是用户确认的差异。成功写入必须先有租约，审计里的租约 id 与 fence 因此非空。相同 `CLOUD_INSTANCE_ID` 两次 `Assert` 都允许；不同实例拒绝 |

指纹比较曾在 `tests/testkit/fingerprint.go`，该文件已随迁移压缩删除。压缩后的 `00002_schema.sql` 就是 head 库的 `pg_dump`，函数、表结构、策略与 ACL 直接来自 head，不再需要差异登记；新增改动走 `00003` 之后的迁移。

## 如何验证

```text
gofmt -l <改过的 Go 文件>
go vet ./...
go build ./...
PODHUB_ALLOW_SUPERUSER_DB=1 PODHUB_PARITY_DSN=postgres://postgres:postgres@127.0.0.1:5432/<空库>?sslmode=disable go test -count=1 -p 1 -timeout 20m ./tests/integration/ -run '^TestResultConsistency$'
```

本地没有 Docker。`TestResultConsistency` 在迁到 00307 的空库上通过。集成测试、`internal/admin/repo`、`internal/supply/repo` 各用一份从该空库复制的数据库单独跑过，包含 `TestSecurityCutover`、`TestAIBillingParity`、`TestChatWalletRaceAndLease`、`TestOrderConfirmCredit`。`go vet ./...` 与 `go build ./...` 通过。

`TestSecurityCutover` 在取消 `PODHUB_ALLOW_SUPERUSER_DB` 后拒绝 postgres 登录，并用 `podhub_login_api` 跑双组织 RLS、兑换、回调、卖家确认、管理端确认，以及空租约 / 相同实例 / 不同实例。

## 第一条租约

```text
PODHUB_ALLOW_SUPERUSER_DB=1   # 仅当 DATABASE_URL 是 superuser 或 BYPASSRLS
writer-lease bootstrap entitlement
```

引导命令要求执行角色能 `SET ROLE podhub_app`。不要用只插入 `writer_leases` 的简化 SQL 替代它：那会遗漏 `writer_lease_events`，也没有已有租约和过期检查。

域用 `auth`、`entitlement`、`catalog`、`recipe`、`telemetry`、`admin`、`release`、`billing` 之一。`billing` 由迁移 00305 加进约束。已有未撤销行且实例不同时，命令退出，不覆盖。

## 需要用户决定

- 生产 `DATABASE_URL` 改为 `podhub_login_api`（或另一个非 superuser、非 `BYPASSRLS` 的登录角色）的时机。在此之前进程必须设置 `PODHUB_ALLOW_SUPERUSER_DB=1`，否则启动失败。
- 聊天占用、结算、释放、幂等回读、识图读取和用量列表在知道 `org_id` 之后 `tenantx.EnterApp` / `BeginApp`，所以 `ai_requests` 的 RLS 能看见本组织的行。钱包仍由 `withWallet` 设置 `app.current_wallet_user_id` 并 `SET ROLE podhub_app`；外层已经是 `podhub_app` 时，结束后设回 `podhub_app`。`ai_consume_logs` 用自己的 RLS 和 `EnterApp`，账单策略不改这张表。
- 滞留扫描、过期 `response_body` 清理、预留释放扫描与客户端日志清理已改由 00368 的 `podhub_maintenance` 执行（NOLOGIN、NOBYPASSRLS、NOINHERIT，只授到 `podhub_login_api`），关闭单行时仍 `EnterApp` 切到该组织的 `podhub_app` 写。该角色只能跨组织读、清空 `response_body`、锁预留行和删旧日志；不能结算、扣费或删 `ai_requests`。错误摘要改由 `podhub_digest_platform` 读 `event_inbox_events`。
- 管理端兑换码的创建和列表、管理端订单列表仍走连接属主。superuser 测试能看见行；`podhub_login_api` 对 `redeem_codes` 没有策略，列表是 0 行。
- S1 的旧范围说明已过期。基线 `00002_schema.sql` 已给 `sc_products`、`sc_skus` 等目录表启用并强制 RLS；`00024_org_scope_rls.sql` 又给 `organization_stores`、`organization_members`、`org_invitations`、`organization_store_groups`、`organization_store_tags`、`store_tag_links`、`store_tombstone_consumptions`、`store_seller_credentials`、`store_credential_verifications`、`sc_listing_bindings`、`sc_order_quotes`、`sc_procurements`、`shipping_inject_operations`、`shipping_shop_injections`、`support_grants` 加上 `tenant_isolation` / `staff_all`，并给账单函数所有者补了 `billing_lookup` 只读策略。`00025_sc_orders_staff_access.sql` 再给 `sc_orders` / `sc_order_lines` 补 `staff_all`，让管理端采购台在无租户 GUC 时也能跨组织读取；普通 app 会话仍只走 `tenant_isolation`。`00026_shipping_inject_org_positive.sql` 给 `shipping_inject_operations` / `shipping_shop_injections` 补 `org_id > 0` 约束，避免 GUC 0 误匹配。
- 仍未加 RLS 的 11 张 org 表：`agent_commissions`、`audit_logs`、`automation_grants`、`billable_usage_events`、`billable_usage_rollups`、`event_inbox_events`、`media_object_leases`、`ozon_listing_field_templates`、`ozon_listing_schema_snapshots`、`payment_callback_ledger`、`storage_uploads`。这些表的访问目前依赖显式 `org_id` 条件或平台/维护角色；加策略前要逐表确认 worker、digest 与媒体角色的读路径，不能直接套 tenant 策略。
- `podhub_worker` 仍是 `BYPASSRLS`。`worker_claim` 目前不改变它能看见的行。
- 名额的 `credit_cents = 0` 与 `> 0` 两套 `seat_limit` 公式没有改。
- 空租约拒绝已经按用户决定落地。双写之前要对每个会写的域执行一次 `writer-lease bootstrap`。

## 上线检查清单（Ozon 错误目录）

迁移 00340 与 00341 之后核对。两个 `NOLOGIN` 角色都不是超级用户，也没有 `BYPASSRLS`。成员关系是 `SET TRUE`、`INHERIT FALSE`，和 writer-lease 一样要显式 `SET ROLE`，不能靠继承写表。不要把它们授给 `PUBLIC` 或 `podhub_worker`。

```sql
SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin
  FROM pg_roles r
 WHERE r.rolname IN ('podhub_ozon_catalog', 'podhub_ozon_sample_prune', 'podhub_login_api');

SELECT pg_has_role('podhub_login_api', 'podhub_ozon_catalog', 'SET') AS catalog_set,
       pg_has_role('podhub_login_api', 'podhub_ozon_catalog', 'USAGE') AS catalog_inherit;

SELECT pg_has_role('podhub_login_api', 'podhub_ozon_sample_prune', 'SET') AS api_prune,
       pg_has_role('podhub_login_listing_worker', 'podhub_ozon_sample_prune', 'SET') AS listing_prune,
       pg_has_role('podhub_login_ai_media_worker', 'podhub_ozon_sample_prune', 'SET') AS media_prune,
       pg_has_role('podhub_login_reconciler', 'podhub_ozon_sample_prune', 'SET') AS reconcile_prune;
```

`catalog_set` 以及四个 prune 列必须为 true，`catalog_inherit` 必须为 false。`catalog_set` 为 false 时，API 进程的全局目录写入失败并只打日志，上架状态保持报回已经提交的结果。00340 就是这条授权。不要改成超级用户，不要改成 `INHERIT TRUE`。

样本清理由 worker 里已有的 River 周期任务 `podhub.error_digest` 调用。上面三个 worker 登录角色和 `podhub_login_api` 都要能 `SET ROLE podhub_ozon_sample_prune`。该角色只能把 `sample_description` 更新成空串。

## 不在这次

R4 其余项只登记，不实现：

- 出站重定向与代理解密（AI 探测、Seller/AI 客户端、已接受的扫描、委托卖家读）。
- 影子流量、组织金丝雀、回滚演练、Mode R 容量。
- staff GUC 的 `OR` 策略。
- 对账 0 行与归档不写 `store_products`。
- 委托 `body_not_ported` 与已接受未释放。
