# 账号与权限模型：平台账号、供应商账号、商品负责人与履约人

- 状态：待拍板（第 12 节 5 个问题未定前不动工）
- 日期：2026-10-21
- 输入材料：v1 方案（`account_users.account_kind`、`must_change_password`、`can_view_global`、`delegate_dispatches.fulfiller_member_id`、`sc_source_members.can_manage_catalog`、「履约账号完全无资金权限」）＋ 四路对抗审查（31 条 P0 / 27 条 P1 / 22 条 P2，另单列 18 条 v1 不准确断言）。本文只吸收结论，不重贴原始清单。
- 基线：用户引用提交 `9ce0ca2293fc8b75db091ac171fc758a5767cceb`，工作树 HEAD 为 `6c8acbc6d836cdd9ab87fcfc616668d15fd3cc16`（2026-10-21「feat(billing): 订阅改为购买日账期并统一店铺续费」），`9ce0ca22` **不是** HEAD 的祖先。`git diff 6c8acbc 9ce0ca22 -- <13 个被引文件>` 为空，故 v1 引用的行号在 HEAD 上仍然有效；本文所有行号以 HEAD 为准；唯一例外是 `internal/app/testdata/routes.txt`——工作树比 HEAD 多 4 条未提交路由（`GET /api/notifications`、`GET /api/view/account-overview`、`POST /api/notifications/read-all`、`POST /api/notifications/{uuid}/read`），本文引用的是**工作树**行号（如 `:189`、`:205`、`:113-120`、`:291-293`），在 HEAD 上对应行号各小 2-4 行。
- 检查归属：**本 session 只做静态读码与 grep**。`go build`、`go test`、`go vet`、`tests/integration`（无 Docker）、`bun test`、生产库普查**均未运行**。RLS 与 SECURITY DEFINER 的结论全部来自 SQL 文本阅读，不是执行结果。

---

## 1. v1 到 v2：改了什么

v1 的方向是对的（账号分用途、商品负责人按库授权、履约人固定、履约账号不给钱），但落地方式把「权限」放在了三个错误的位置：放在 `sc_source_members`（会被物理删除的行）上、放在 `role` 字符串上、放在 Go 层的 if 上。v2 把这三处都搬到数据库约束与 RLS 谓词里。

| # | v1 做法 | v2 做法 | 为什么必须改 |
| --- | --- | --- | --- |
| M1 | 在 `sc_source_members` 加 `can_fulfill_orders` / `can_manage_catalog` 两个布尔 | 新建 `sc_source_fulfillers` 与 `sc_catalog_managers` 两张授权表，各带 `status` / `created_by` / `revoked_at_ms` | `sc_source_members` 的行会被**物理删除**（`accounts.go:161` 按 `member_id` 删、`:296` 在换绑时删其他成员）。拿它当权限载体和当外键目标，等于「换个绑定就把历史包的所有权链打断」 |
| M2 | `fulfiller_member_id` 直接引用 `sc_source_members.member_id` | `delegate_dispatches.fulfiller_id` 引用 `sc_source_fulfillers.fulfiller_id`，且**可空** | 同上；另外 NOT NULL 会把「这单还没有履约人」从业务状态变成 500 |
| M3 | 一个货源库「最多一条启用的履约绑定」靠服务层保证 | `CREATE UNIQUE INDEX ux_sc_source_fulfillers_one_active ON sc_source_fulfillers(source_id) WHERE status='active'` | 服务层保证在并发下会漏；这是第 12 节 O11 的默认前提，不是已经定下的事实 |
| M4 | 供应商账号固定 `role='user'`（约定） | `account_users.account_kind` + `CHECK (account_kind='platform' OR role='user')` | `SetRole`（`users.go:547-585`）只做 `Authorize(actor.Role, assign, role, last)`，不看账号用途；`Authorize`/`assignRank` 只比较 rank 字符串。约定拦不住超级管理员把供应商号提升为 admin |
| M5 | `must_change_password` 由各接口自己判断 | 在 `identity.Middleware`（`app.go:51` 唯一一处全局中间件）做 deny-by-default 闸 | 现有中间件只做 admission（`middleware.go:5-28`），没有任何授权；逐个 mount 加检查会漏掉 SSE、listing 读、admin 各 family 的 resolver |
| M6 | 新增 `can_view_global` 布尔打开跨租户观察 | **砍掉**。观察面继续只认 `role='super_admin'` | 它要同时降级 9 处硬编码的 `super_admin` 判定（`observe/repo/observe.go:77-78` 的 `EXISTS(... role='super_admin')`、`00275` 的 6 条 `platform_observation_select`（L5-51，`role='super_admin'` 在 L10/18/26/34/42/50）、`00300:85-92` 的 `error_digest` 观察臂、`00320:165-173` 的 `ozon_error_catalog_observe`），收益是「多一个能看全平台金额的角色」，代价是 9 处全都要重审 |
| M7 | 商品负责人复用 `/api/admin/supplier-dbs/*`，只把 guard 放宽 | 新建 `/api/catalog/*` 界面 + 新会话 `db.CatalogManager` + 新 GUC，**不动** `supply.WithTx` | `WithTx`（`supply.go:84-107`）无条件 `set_config('app.staff_access','1')`。guard 一放宽，普通平台账号立刻拿到全站 staff RLS 豁免 |
| M8 | 「平台售价仍由超管」当作现状 | 现状是**假的**：`POST /api/admin/supplier-dbs/{source_id}/rows/{product_id}/price` 的 guard 是 `GuardStaff`（`suppliers.go:61`） | 要真正做到「只有超管改平台价」，这条得改成 `GuardSuper`；这是一条独立的 P0 修复，与本方案并行 |
| M9 | 资金边界靠「不挂供应商路由」 | 还要 **DROP** `00258` 四条 `supplier_source_isolation` 策略 | 策略在库里，路由只是调用点。任何走 `db.Supplier` 的代码（含未来的内部任务）都还能读到本厂钱包与提现单 |
| M10 | 历史包按 source 级策略放行 | 历史包 `fulfiller_id IS NULL`，**只有 staff 能看**；另加一条 6 周过渡臂 | 历史包无法反推真实收件人（`rebound` 的审计正文是字面量 `{}`，且没有审计触发器），只能 fail-closed。过渡臂见第 7.4 节 |
| M11 | `delegate_order_lines.last_rejected_source_id` 保持不变 | 改为 `last_rejected_fulfiller_id` | 它是 source 级闩。同一库内换履约人后，`IS DISTINCT FROM <source>` 恒假，该行**永久**不再自动派发 |
| M12 | 三个 SECURITY DEFINER 函数只查成员身份 | 按 `sc_source_fulfillers` 重写，并 `DROP` 旧签名 + 逐函数 `REVOKE/GRANT` | `00205`/`00259` 的函数只 `EXISTS sc_source_members`。同库新成员能接旧包，直接把「固定收件人」绕过去 |

---

## 2. 现状事实（本文所有判断的基座）

### 2.1 账号与角色

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| `account_users` 有 `role varchar(32) DEFAULT 'user'`、`target varchar(64) DEFAULT '/workspace'`、`supplier_id varchar(64) DEFAULT ''`、`plan`、`disabled_at` | `00001_schema_source_baseline.sql:48-63` | 没有「账号用途」这一维；`target` 与 `supplier_id` 被拿来当事实源 |
| `account_users_single_super_admin` 是 `(role) WHERE role='super_admin'` 的唯一索引 | `00001:834-837` | 全库只能有一个 super_admin |
| `uq_account_users_email` 是 `UNIQUE (email)`，**没有 `lower()`** | `00001:946-949` | `provision` 用 `WHERE lower(email)=$1` 查（`accounts.go:207-214`），大小写变体可绕过唯一索引重复注册 |
| `PlatformStaff` = admin / super_admin（trim + ASCII lower）；`SuperAdmin` = 只有 super_admin | `admin/domain/role.go:8-20` | 平台权限只有两档 |
| `Authorize` 的决策表只比较 rank 字符串，kind 只有 `create/assign/edit/disable`；`protectLast` 只保护最后一个 super_admin | `admin/users/contract/rank.go:68-92` | 提升一个 supplier 账号为 admin 在 rank 代数里是**合法**的 |

### 2.2 会话与 GUC

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| GUC：`app.current_org_id`(L38)、`app.staff_access`(L40)、`app.platform_observer_id`(L42)、`app.current_wallet_user_id`(L44)、`app.current_supplier_user_id`(L46)、`app.automation_grant_id`(L48) | `tenantx/tenantx.go` | 没有「商品负责人」这一维 |
| `EnterApp` = `set_config('role'=podhub_app) + set_config('app.current_org_id', orgID)` | `tenantx.go:54-60` | |
| `EnterAppRole` 只设角色、不设 org | `tenantx.go:73` | 给没有 `org_id` 的平台表用 |
| `RequireOrg` 在 GUC 为空时返回 `ErrOrgUnset` | `tenantx.go:94-103` | |
| `EnterSupplier` 设角色 + supplier GUC，**不设 org GUC**；注释明说「unset 与 '0' 匹配同样的行，只要没有行的 org_id 是 0」 | `tenantx.go:161-170` | 供应商事务里 org 谓词形同虚设 |
| 会话构造：`App`(L46)、`Worker`(L49)、`Staff`(L52)、`Observer`(L55)、`WalletUser`(L58)、`SupplierUser`(L63)、`Supplier`(L70)、`AutomationGrant`(L74)、`Catalog`(L77)、`AppRole`(L82) | `platform/db/tx.go` | 新增会话要同时改 `ready()`(L127-154) 与 `enter()`(L156-180)；`ready()` 里 `sessWorker/sessStaff/sessCatalog/sessAppRole` 直接 `return nil`，**不要求 org** |
| `db.App(orgID)` 在 `orgID<=0` 时于开事务前返回 `ErrOrgUnset` | `tx.go:129-132` | |

### 2.3 三条「事务默认打开 staff 豁免」的路径

| 函数 | 行为 | 位置 |
| --- | --- | --- |
| `WithRead` | `Gate(staff=true, write=false)` | `core/repo/supply.go:74-76` |
| `WithWrite` | `Gate(staff=false, write=true)`（要 writer lease） | `supply.go:79-81` |
| `WithTx` | 开事务后**无条件** `set_config('app.staff_access','1',true)`，不 `RequireOrg`、不取 lease | `supply.go:84-107` |
| `Gate` | `RequireOrg` → 可选 staff GUC → 可选 `AssertWrite`（失败文案「平台货源写入未启用」） | `supply.go:111-144` |
| `Identity` | 从 `account_users.public_id` 取 owner，**除 `actor.Role == "super_admin"` 外都设 owner 过滤** | `supply.go:147-160` |

22 条 `/api/admin/supplier-dbs/*` 路由的事务入口按实现文件分三类：

- 行/提示词/Ozon 配置/改价/上下架（`internal/admin/x1/repo/x1.go`、`x1_prompt.go`）走 `X1.withRead` / `withWrite`（`x1_store.go:24-30`）⇒ `Gate(staff=true, write=false)` / `Gate(staff=false, write=true)`。**读与 `Detail` 都设 `app.staff_access='1'`**。
- 库与属性、`DeleteRow`（`internal/admin/supplier/repo/dbs.go`）走 `Portal.withTx`（`portal.go:30-32`）⇒ `WithTx`（`supply.go:84-107`），**无条件下 `app.staff_access='1'`、不取 lease**。
- `POST .../prompt/preview` 与 `POST .../uploads/abort`、`POST .../uploads/confirm` 三条**完全不碰库**：`PreviewPrompt`（`admin/service/x1.go:149-155`）只做字符串拼装；`AbortRowUpload`（`x1storage.go:534-558`）与 `ConfirmRowUpload`（L560-607）只碰对象存储，靠密封票据里的 `actor.UserID` 与 key 前缀（L622-631）自证。
- 但 `POST .../uploads`（发票据）在做任何事之前先调 `s.catalog().Detail(...)` 做归属校验（`x1storage.go:451-466`）⇒ 仍落 `X1.withRead` ⇒ `app.staff_access='1'`。

结论：**22 条里 19 条落到数据库事务，无一例外要么显式设 `staff_access='1'`（读、`Detail`、`WithTx`），要么走 writer lease + `AssertWrite`（写）**；只有 `prompt/preview`、`uploads/abort`、`uploads/confirm` 三条不碰库。所以 guard 一放宽，非 staff 的普通平台账号立刻拿到全站 staff RLS 读豁免，写路径则受 writer lease 限制——这正是 M7 的全部理由：**读豁免本身就足够把 22 条路由背后的全站货源库读空**。

### 2.4 目录表没有任何 RLS

`sc_sources`（`00143:5-18`）、`sc_source_prop_defs`（`00143:20-34`）、`sc_products`（`00119:5-19` + `00143:52-66` 加列）、`sc_skus`（`00119:21-39`）、`sc_source_offers`（`00143:39-50`，`00157:9-11` 加 `shipping_cost_cents` 并把 `cost_cents` 改为可空，`00157:19-29` 重建三条 CHECK）、`sc_price_versions`（`00119:41-49`）**全部没有 `ENABLE/FORCE ROW LEVEL SECURITY`**，也没有 `CREATE POLICY`。

这意味着：目录的「谁能看哪一行」今天完全由 Go 层的 `WHERE` 决定，而且粒度是**货源库级**，不是行级。非超管的 owner 过滤写在 `corerepo.RequireSource`（`supply.go:321-330`，`created_by_account_uuid = $2`）和 `corerepo.ListDbs`（`supply.go:292`，`s.created_by_account_uuid = $1`）里；一旦进到某个 `source_id` 内部，`loadRows`（`x1_write.go:121-125`）只按 `p.source_id` 与 `NOT p.archived` 过滤，**不看 `created_by_account_uuid`**。`x1.go:64-67` 那段 `creator.public_id = p.created_by_account_uuid` 是「创建者名字」的展示子查询，不是权限谓词。

后果有两条：(a) 只要拿到某个 `source_id`，就能看到这个库的**全部**行，没有「只看自己录的」这回事；(b) 归属权挂在 `sc_sources.created_by_account_uuid` 的单个用户身上，换人以后整个库连同全部行对新负责人不可见。v2 用 `sc_catalog_managers` 把这条单点归属换成一组授权。

### 2.5 派单与资金

| 事实 | 位置 |
| --- | --- |
| `delegate_dispatches` 有 `source_id text NOT NULL REFERENCES sc_sources RESTRICT`、`state text NOT NULL DEFAULT 'dispatched'`、`ux_delegate_dispatches_live UNIQUE(order_id, source_id) WHERE state='dispatched'` | `00203:91-107`（表）、`00203:111-113`（唯一索引） |
| `delegate_order_lines.last_rejected_source_id text REFERENCES sc_sources ON DELETE SET NULL` | `00203:77-89`（L86） |
| `sc_source_members` RLS = `supplier_member_self_isolation`（`user_id = app.current_supplier_user_id`，L150-153）+ `supplier_member_staff_isolation`（`app.staff_access='1'`，L155-159） | `00203:148-159` |
| `delegate_dispatches.delegate_source_isolation` 用 `EXISTS (SELECT 1 FROM sc_source_members m WHERE m.source_id=delegate_dispatches.source_id AND m.user_id=current_setting('app.current_supplier_user_id') AND m.status='active')`，`USING` 与 `WITH CHECK` 是同一段谓词 | `00203:229-243`，注释 L225-228 明说与 self 臂「compose」 |
| `delegate_source_active_member_count(text)` 是 `LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public`，只返回 count；`GRANT EXECUTE` 给 app/worker，**没有 `REVOKE`** | `00203:260-264`（`GRANT` 在 L277-278）；调用点 `delegate/repo/seller_bind.go:301`（所在函数 `loadBindings` 起于 L296） |
| `00205` 的 `delegate_supplier_accept/reject/ship` 与 `delegate_supplier_recompute_order_state` | 函数体 `00205:5-234`（recompute 5-72、accept 78-126、reject 128-182、ship 184-234）；ACL 收口在 `00205:236-249`（recompute 的 `REVOKE` 单独在 L74-76） |
| `00259` 用**同签名** `CREATE OR REPLACE` 覆盖 accept/reject/ship，加 `FOR UPDATE` 后复检；**全文 0 条 REVOKE / GRANT**（ACL 沿用 00205） | `00259:5/75/149` |
| `00259` 的 accept 只 `EXISTS sc_source_members ... status='active'`，失败 `RAISE EXCEPTION 'DELEGATE_FORBIDDEN'` | `00259:17-31`，复检 `L44-51` |
| `00258` 的四张表（`delegate_settlements`、`supplier_wallets`、`supplier_wallet_ledger`、`supplier_withdrawals`）各自的 supplier 臂都是 **source 级** `sc_source_members` 判定 | `00258:93-179`（策略名 `delegate_source_isolation` L103-116，`supplier_source_isolation` L120-133 / L141-154 / L162-175，三张表各配一条 `supplier_staff_isolation` L134/L155/L176） |
| `supplier_wallet_ledger` 只有 `GRANT SELECT, INSERT`（append-only），注释写明「no UPDATE or DELETE for the application roles」 | `00258:180-190` |
| `Accept`(L21) → `act`(L97) → `holdOnAccept`(L149) → `bill.HoldTx`；`Ship`(L65) → `settleDispatch`(L216) → `HoldTx`/`SettleTx` + `creditDispatch`(L275) | `supplier/repo/write.go:21-41 / 65-95 / 149-183 / 216-273` |
| `Catalog` 用 `r.begin(ctx, r.pool.Begin, 0)` 开事务（L19），**不查成员、不设 staff**，`listedSources`(L44) / `propDefs`(L65) / `sellerRows`(L100) 全在同一事务里 | `supplier/repo/catalog.go:13-42` |
| `/api/supplier/*` 只挂 11 条（2 条目录 + dispatch 列表/详情/accept/reject/assets + me + wallet + withdrawals GET/POST）；**`Ship` 有实现但没有路由** | `supplier/http/handler.go:69-81`；`routes.txt:113-120/291-293` |

### 2.6 迁移守卫的硬约束

| 约束 | 位置 | 值 |
| --- | --- | --- |
| `baselineMax` | `migrate_guard_test.go:25` | `341` |
| `baselineCount` | `:29` | `313` |
| 新文件必须 version > 341 **且** sha256 追加进 `db/migrations.sha256` | 同文件 | |
| `db/migrations.sha256` | — | 327 行 = 5 行 `#` 注释 + **322** 条 sha256；`db/migrations/` 有 **322** 个 `.sql`，两边逐条对齐 |
| 现有最高版本 | — | `00350_subscription_periods.sql`（manifest 尾行已收录） |
| `postRustTables` / `postRustColumns` / `intentionalFunctions` / `intentionalRLSPolicies` | `tests/testkit/fingerprint.go:171-195 / 200-240 / 265-284 / 290+` | 新表、新列、新函数、新策略都要登记 |
| `intentionalRLSPolicies` 的跳过逻辑 | `fingerprint.go:518-521` | **登记进这张表的策略，其 `relrowsecurity`/`relforcerowsecurity` 差异被整体跳过**——这是现有的最大盲点 |
| `diffTable` 的列比较 | `fingerprint.go:448+` | `len(gotColumns) == len(want.Columns)+len(extra)`，且只比**物理尾部切片** `gotColumns[len(want.Columns):]`，所以 `Ordinal` 必须是物理尾序 |

---

## 3. v2 数据模型

### 3.1 `account_users` 加两列

```sql
ALTER TABLE public.account_users
    ADD COLUMN IF NOT EXISTS account_kind text NOT NULL DEFAULT 'platform';
ALTER TABLE public.account_users
    ADD CONSTRAINT ck_account_users_kind CHECK (account_kind IN ('platform','supplier'));
ALTER TABLE public.account_users
    ADD CONSTRAINT ck_account_users_supplier_is_user CHECK (account_kind = 'platform' OR role = 'user');
ALTER TABLE public.account_users
    ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
```

要点：

- `ck_account_users_supplier_is_user` 是本方案里**唯一**能真正保证「供应商号永远不是 admin」的地方。`SetRole`（`users.go:564`）的 `UPDATE` 会撞这个 CHECK，即使 `Authorize` 放行也存不进去。
- 回填：`UPDATE account_users SET account_kind='supplier' WHERE target='/supplier' AND role='user'`。`target` 是 `provision`（`accounts.go:232-233`）写死的 `'/supplier'`，登录响应经 `identity/wire.go:55` 的 `loginWire.Data.Target` 透出（`wire.go:66`，4 个调用点在 `login.go:132`、`password.go:103`、`register.go:141/171`）。但前端今天**不读这个字段**：`App.tsx` 判供应商界面靠 `isSupplierPath(address.pathname)`（`supplier-surface.ts:13-19`，`App.tsx:263` 匿名、`:295` 已登录两处），身份靠 `/api/auth/session` 的 `account_mode`。所以 `target` 是**服务端单方面写、前端从不回读**的悬空字段——它既不是前端事实源，也不能靠它判断界面。回填后 `account_kind` 成为唯一事实源，`target` 只剩「登录接口的默认落地页提示」一个纯展示含义。
- 回填必须幂等且可重跑；若生产里存在 `target='/supplier'` 但 `role<>'user'` 的行（理论上不该有），迁移要 `RAISE EXCEPTION` 停下来，不要静默归类。
- 不建议用 `supplier_id` 判用途：`00001:57` 的默认值是空串，且 `wire.go:48/59-64/100` 把它当响应字段透出，业务含义是「这个账号绑在哪个厂家」而不是「这个账号是什么」。

### 3.2 `sc_source_fulfillers`（履约人）

```sql
CREATE TABLE IF NOT EXISTS public.sc_source_fulfillers (
    fulfiller_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id    text NOT NULL REFERENCES public.sc_sources(source_id) ON DELETE RESTRICT,
    user_id      bigint NOT NULL REFERENCES public.account_users(id) ON DELETE RESTRICT,
    status       text NOT NULL DEFAULT 'active',
    created_by   bigint REFERENCES public.account_users(id) ON DELETE RESTRICT,
    created_at_ms bigint NOT NULL,
    revoked_by   bigint REFERENCES public.account_users(id) ON DELETE RESTRICT,
    revoked_at_ms bigint,
    CONSTRAINT ck_sc_source_fulfillers_status CHECK (status IN ('active','disabled')),
    CONSTRAINT ux_sc_source_fulfillers_user UNIQUE (source_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sc_source_fulfillers_one_active
    ON public.sc_source_fulfillers (source_id) WHERE status = 'active';
```

- 外键指向 `account_users`，不是 `sc_source_members`：成员行会被物理删除，履约授权不应该跟着消失（历史包的 `fulfiller_id` 必须仍能解析）。
- `ux_sc_source_fulfillers_one_active` 实现「一库一履约人」。这是默认前提，不是定论——见第 12 节 O11。
- `status` 用 `disabled` 而不是删行：撤授权要留下 `revoked_by/revoked_at_ms`，否则「谁在什么时候撤的」不可查。

### 3.3 `sc_catalog_managers`（商品负责人）

```sql
CREATE TABLE IF NOT EXISTS public.sc_catalog_managers (
    manager_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id  text NOT NULL REFERENCES public.sc_sources(source_id) ON DELETE RESTRICT,
    user_id    bigint NOT NULL REFERENCES public.account_users(id) ON DELETE RESTRICT,
    status     text NOT NULL DEFAULT 'active',
    created_by bigint REFERENCES public.account_users(id) ON DELETE RESTRICT,
    created_at_ms bigint NOT NULL,
    revoked_by bigint REFERENCES public.account_users(id) ON DELETE RESTRICT,
    revoked_at_ms bigint,
    CONSTRAINT ck_sc_catalog_managers_status CHECK (status IN ('active','disabled')),
    CONSTRAINT ux_sc_catalog_managers_user UNIQUE (source_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_sc_catalog_managers_user_active
    ON public.sc_catalog_managers (user_id) WHERE status = 'active';
```

与履约人刻意分开：**一个库可以有多个商品负责人，只能有一个履约人**。两张表、两套索引、两套谓词，不共用一个 `role` 列——共用就会重演 v1 的错误（用一个可空字符串同时表达两种完全不同的授权密度）。

### 3.4 `delegate_dispatches` / `delegate_order_lines`

```sql
ALTER TABLE public.delegate_dispatches
    ADD COLUMN IF NOT EXISTS fulfiller_id uuid;
ALTER TABLE public.delegate_dispatches
    ADD CONSTRAINT fk_delegate_dispatches_fulfiller
        FOREIGN KEY (source_id, fulfiller_id)
        REFERENCES public.sc_source_fulfillers (source_id, fulfiller_id)
        ON DELETE RESTRICT;

ALTER TABLE public.delegate_order_lines
    ADD COLUMN IF NOT EXISTS last_rejected_fulfiller_id uuid
        REFERENCES public.sc_source_fulfillers(fulfiller_id) ON DELETE SET NULL;
```

- 复合外键 `(source_id, fulfiller_id)` 需要 `sc_source_fulfillers` 上有 `UNIQUE (source_id, fulfiller_id)`；`fulfiller_id` 已是主键，加一条 `ux_sc_source_fulfillers_source` 显式满足复合 FK 的引用要求。
- **`fulfiller_id` 必须可空**：`MATCH SIMPLE` 下 `fulfiller_id IS NULL` 时复合 FK 不校验，正好表达「历史包 / 还没定履约人」。NOT NULL 会让「新建订单但还没算履约人」直接 500。
- `last_rejected_fulfiller_id` 不做复合外键：它是一个「闩」，只需要能判等，`source_id` 已由 `delegate_dispatches` 那边保证。
- v1 的 `fulfiller_member_id` 字段名与 `sc_source_members` 引用**全部作废**。

### 3.5 订单状态：不新增 `unassigned`

`ComputeOrderState`（`delegate/domain/order.go:17-56`）/ `delegate_supplier_recompute_order_state`（`00205:5-72`）的输入是每行的 packet state，输出是 6 个订单状态之一（`ck_delegate_orders_state` 的 7 个取值里 `done`/`cancelled` 只由人工流转，不由函数产出）。加第 7 个状态要同步改 6 处：Go 纯函数（`order.go:44-56`）、SQL 函数（`00205:54-69`）、`admin/domain/delegateadmin.go:10` 的 `orderStates` 白名单、前端 `delegate-model.ts:41-48` 的 `ORDER_STATE_LABELS` + `:56-68` 的 `orderStateTone` + `delegate-orders-view.tsx:52` 与 `admin-delegate-orders-screen.tsx:73-83` 两份筛选项，以及 `00203:71-74` 的 `ck_delegate_orders_state`（冻结迁移，改它等于改 Rust 指纹的约束定义）。

v2 改为**不动状态机**，只在 `delegate_orders` 加一列：

```sql
ALTER TABLE public.delegate_orders
    ADD COLUMN IF NOT EXISTS dispatch_blocked_reason text;
ALTER TABLE public.delegate_orders
    ADD CONSTRAINT ck_delegate_orders_blocked_reason
        CHECK (dispatch_blocked_reason IS NULL
               OR dispatch_blocked_reason IN ('no_fulfiller','ambiguous_fulfiller'));
```

派发器算不出收件人时写 `dispatch_blocked_reason`，订单状态仍是 `awaiting_setup`/`ready` 的既有语义。卖家看到的是「已就绪但缺履约人」，而不是一个需要新枚举的新状态。

---

## 4. 身份与认证

### 4.1 `account_kind` 是唯一事实源

| 判定 | 今天的依据 | v2 依据 |
| --- | --- | --- |
| 登录后落到哪个界面 | `/supplier` 前缀（`supplier-surface.ts:13-19`）+ `/api/auth/session` 的 `account_mode`；`account_users.target` 只出现在登录响应里，前端不回读 | `account_kind`；`target` 只做默认落地页，且不再参与任何判断 |
| 能不能进 `/api/supplier/*` | 有 `sc_source_members` 行（`Catalog` 甚至不查） | `account_kind='supplier'` **且** 有 active 履约人/成员行 |
| 能不能进 `/api/admin/*` | `role ∈ {admin,super_admin}` | 同上 **且** `account_kind='platform'`（DB CHECK 兜底） |
| 前端身份推断 | `supplier-surface.ts:13-19` 的 `/supplier` 前缀（纯 pathname，不看身份）+ `app-route.ts:59` 的 `accountMode !== 'unaffiliated' \|\| isPlatformSuperAdminRole(role)` | `routeAudienceFor` 增加 `accountKind` 入参；`hasWorkspace` 改为 `accountKind === 'platform' && (accountMode !== 'unaffiliated' \|\| isSuperAdmin)` |

`app-route.ts:106` 的 `if (!audience.hasWorkspace) return {kind:'workspace-required'}` 是今天的隐式门：供应商账号的 `accountMode` 是 `unaffiliated`（`email.go:66` 的 `projectAccountMode(0,0)`），所以进不去工作台。v2 把它显式化——`hasWorkspace = authenticated && accountKind === 'platform' && (accountMode !== 'unaffiliated' || isSuperAdmin)`。

### 4.2 `must_change_password` 的强制执行点

唯一正确的位置是 `identity.Middleware`（`middleware.go:5-28`，装配在 `app.go:44-51`）。它今天只做 admission：

```go
if r.URL.Path == "/api/health" || (Cookie=="" && Authorization=="") { next; return }
class := Classify(r.URL.Path, r.Method)
_, token, acc, err := s.resolveRequest(r)
if err != nil { 503 }
if token == "" { next; return }
release, status, message, retry := s.admission.Admit(acc.id, class)
...
```

改动是在 `token != ""` 之后、`Admit` 之前插入一个 **deny-by-default 白名单闸**：`acc.mustChangePassword && !allowWhileLocked(path, method)` → 403 `{"code":"PASSWORD_CHANGE_REQUIRED"}`。

白名单必须**恰好**是这 6 条，多一条就是漏洞：

| 方法 + 路径 | 理由 |
| --- | --- |
| `POST /api/auth/login` | 登录本身 |
| `POST /api/auth/logout` | 否则锁死无法登出 |
| `GET /api/auth/session` | 前端要读 `mustChangePassword` 才能弹窗 |
| `POST /api/auth/password` | 改密入口（`routes.txt:205`） |
| `GET /api/health` | 健康检查（已在 L6 短路） |
| 静态资源 / CSRF 预检 | 由 `Classify` 之前的短路处理 |

> **实现期更正（已核实）**：第 6 行不是一条 HTTP 路由。本进程不 serve 任何静态资源（`internal/`、`cmd/` 下 `FileServer`/`embed`/`http.Dir` 零命中），CSRF 是独立中间件、在 `app.go:50` 装配且**早于** `app.go:51` 的 `svc.Middleware`。所以代码里只实现**前 5 条**的 method+path 精确匹配，第 6 条以「CSRF 在闸之前」的注释 + 单测断言体现，**不得**为了凑 6 条而放行任何非 `/api/` 路径。

**不要**把 `POST /api/admin/users/{uuid}/password`（`routes.txt:189`）放进白名单：那是员工改别人的密码，与「本人必须改密」是两件事。也不要放行任何 SSE / listing 读 / `/api/supplier/*`：v1 曾提议「只拦写」，实测拦不住 `GET /api/supplier/wallet` 这种纯读泄漏。

`must_change_password` 的写入点只有三个：`provision` 建号时设 `true`（首次登录必须改）、员工重置密码（`SetPassword`）时设 `true`、本人改密成功后设 `false`。三处都要审计。

### 4.3 账号的生命周期是闭集

`provision`（`accounts.go:192-272`）今天的行为链：`super_admin` 门（L193-195）→ 厂家存在性（L197-205）→ `SELECT ... WHERE lower(email)=$1`（L207-214）→ 新用户分支（bcrypt cost 12、`target='/supplier'`、`supplier_id=''`、`plan='free'`）或 复用分支（拒绝 `role != 'user'`「不能绑定管理员邮箱」、拒绝 `disabled_at`「该邮箱的账号已停用」）→ `INSERT sc_source_members ... ON CONFLICT DO NOTHING RETURNING member_id`，`ErrNoRows` → `Conflict("该邮箱已是这家厂家的成员")`。

v2 要补三件事：

1. 新用户分支写 `account_kind='supplier'`，并且**不允许**一个已存在的 `account_kind='platform'` 账号被「复用」成供应商。现状是复用分支只看 `role`，一个普通平台用户（`role='user'`）会被静默绑成某厂家的供应商成员，同时保留它原有的工作区成员身份。
2. 邮箱比较改成一致的大小写口径。两个选项：(a) 增加 `UNIQUE INDEX uq_account_users_email_lower ON account_users (lower(email))`，所有查询统一 `lower(email)`；(b) 在写入口把 `email` 统一 `lower(trim(...))` 后存。**推荐 (a)**，因为它同时修掉历史脏数据下的竞态。这是一条独立迁移，可以并到 00360。
3. `DeleteAccount`（`accounts.go:156-170`）今天只 `DELETE FROM sc_source_members`（`accounts.go:161`）。v2 还要把 `sc_source_fulfillers` / `sc_catalog_managers` 的同用户 active 行置 `disabled`（不是删），否则「删了成员但仍是履约人」。DB 层用 `ON DELETE RESTRICT` 让忘记清理的路径直接报错，而不是静默留下悬空授权。

---

## 5. 授权矩阵（HTTP 层）

四个界面，四条独立的准入路径。**没有任何一条可以靠另一条推导出来**。

| 界面 | 前缀 | 会话 | 准入判定 | 拒绝文案 | 事务入口 |
| --- | --- | --- | --- | --- | --- |
| 工作台 | `/api/*`（除 admin/supplier/catalog） | `db.App(orgID)` | `account_kind='platform'` + 工作区角色 | 现有 | `tenantx.BeginApp` |
| 管理端 | `/api/admin/*` | `db.Staff()` | `account_kind='platform'` **且** `role ∈ {admin,super_admin}` | `msgSuperAdmin` / `ErrStaffDenied` | `Gate(staff)` / `Gate(write)` / `WithTx`（经 `x1repo.withRead·withWrite`（`x1_store.go:24-30`）、`Portal.withTx`（`portal.go:30-32`）、`internal/admin/repo/repo.go:128-140` 三处包装） |
| 商品管理 | `/api/catalog/*`（新） | `db.CatalogManager(userID)`（新） | `account_kind='platform'` 且 该用户在本库有 active `sc_catalog_managers` 行 | 新增「没有这家货源库的商品维护权限」 | 新 `Gate`，**永不设 `staff_access`** |
| 供应商门户 | `/api/supplier/*` | `db.Supplier(userID)` | `account_kind='supplier'` 且 有 active 授权行 | 现有 | `supplier.withTx(0, userID)` |

### 5.1 今天的 guard 分派（`mount.go`）

`serveUsers`（L186-229）与 `allow`（L293-324，由 `serveSupplier` 在 L281 调用）各有一份 switch，语义相同：

| `rt.Guard` | 判定 | 行号 |
| --- | --- | --- |
| `GuardWorkspace` | `p.OrgID == 0` → 403 `msgNoWorkspace` | L193/L295 |
| `GuardLogin` | 无 | L198/L300 |
| `GuardStaff` | `domain.PlatformStaff(p.PlatformRole)` | L199/L301 |
| `GuardSuper`, `GuardInferred`, `GuardPrice` | `domain.SuperAdmin(p.PlatformRole)` → 403 `msgSuperAdmin` | L204-208 / L310-317 |
| default | 501 `not_ported` | L209-214 / L319-320 |

然后 `serveUsers` 在 L221-226 调 `wantsStepUp(rt.Method, rt.Path)`（`dispatch.go:58-65`），对**所有 `implemented()` 为真的路由**要求 TOTP 提升，只有 `POST /api/admin/totp/{enroll,confirm,step-up}` 例外（`dispatch.go:60`）。注意这条路径只覆盖 `serveUsers`，`serveSupplier`（L230-291）**没有 step-up 调用**。`serveSupplier` 另有两条按 body 内容的覆盖：`PATCH /api/admin/supplier-accounts/{member_id}` → `domain.PatchWantsSuper(body)`（`mount.go:250`，判定实现在 `domain/accountinput.go:108-112`，「body 里带密码」即升级为 super）决定 `GuardSuper` 还是 `GuardStaff`；`POST /api/admin/supplier-withdrawals/{withdrawal_id}/pay|reject`（`mount.go:256-263`）同理。

### 5.2 必须改的 guard（P0，与本方案并行）

| 路由 | 现在 | 应改为 | 理由 |
| --- | --- | --- | --- |
| `POST /api/admin/supplier-dbs/{source_id}/rows/{product_id}/price`（`suppliers.go:61`） | `GuardStaff` | `GuardSuper` | 「平台售价只有超管能改」今天不成立 |
| `DELETE /api/admin/supplier-accounts/{member_id}`（`suppliers.go:38`） | `GuardStaff` | `GuardSuper` | 删账号会连带解除履约授权，是破坏性操作 |
| `POST /api/admin/supplier-automation/grants` 及其 `/revoke`（`suppliers.go:41-42`） | `GuardStaff` | `GuardSuper` | 自动化授权对等于「以平台身份代操作」，和 `WithTx` 的 staff 豁免同级 |

`GuardInferred` / `GuardPrice` 现在都 fail-closed 到 `super_admin`（`suppliers.go:12-18` 的注释写明），语义没问题，但名字误导：`GuardPrice` 被 `platform.go:19-20` 的两条 AI 价格路由使用，与「货源价格」无关。建议在 `docs/decisions.md` 补一条命名决定，不要在本次一起改（改了会动 `routes.txt` 之外的黄金表）。

---

## 6. RLS 与 SECURITY DEFINER 谓词矩阵

### 6.1 目标矩阵

「写」列指 `WITH CHECK` 的谓词，与 `USING` 相同，除非另注。

> **实现期发现（O16，已登记 `docs/decisions.md`）**：本节所述的六张表（`sc_sources`/`sc_source_prop_defs`/`sc_products`/`sc_skus`/`sc_source_offers`/`sc_price_versions`）在 00365 之前**没有任何 RLS 策略**，因此**不能只加上面两臂就上线**。前置审计（§10.2 要求的「确认所有既有 `podhub_app` 读路径都带 `staff_access`」）**不成立**：
>
> | 既有读路径 | 会话 | 是否带 `staff_access` |
> | --- | --- | --- |
> | `admin/catalog/repo/catalog.go` `read()` | `corerepo.BeginAdmin` → **已改** `BeginStaff` | ❌ → ✅（`admin/core/repo/staff.go:15-25` 只设 role，故必须换） |
> | `admin/shipping/repo/shipping.go` | `corerepo.BeginAdmin` → **已改** `BeginStaff` | ❌ → ✅ |
> | `supply/repo/catalog.go:33` `PublicCatalog`（公开路由 `/api/public/platform-catalog`） | `BeginApp(..., 0)` | ❌ |
> | `supplier/repo/catalog.go` `Catalog()` | `BeginApp(..., 0)` | ❌ |
> | `listing/read/http/*`（`http.go:138`） | `BeginApp(orgID)` | ❌ |
> | `delegate/repo/seller_order.go:250,515` JOIN `sc_sources` | app 会话 | ❌ |
>
> `ENABLE` + `FORCE` 之后这七条全部读空。
>
> **实现期修正（2026-10-21）：本段原定的「过渡兼容臂」`sc_<表>_app_compat` 已撤销，不实施。**
>
> 撤销理由是仓库根 `AGENTS.md` 的硬约束：「把本项目当新工程改，允许破坏性变更，不旧兼容」。那条兼容臂的谓词是「`app.staff_access='1'` OR catalog-manager 命中 OR 会话为 app 角色 / `current_org_id` GUC 已设置」——最后一项等于「任何工作区会话都能读全平台目录」，也就是**在关洞的同一条迁移里把洞按原样留着**。它会让本节的 §6.1 矩阵在 00365 之后到 00366 之间形同虚设，且没有任何测试会失败来提醒「兼容臂该摘了」。
>
> 改为**按上表七条读路径各自的真实语义给臂**，一次到位：
>
> - `staff_access='1'` —— 全权读写（admin 屏幕）。这要求把 `admin/catalog/repo/catalog.go` 与 `admin/shipping/repo/shipping.go` 的 `BeginAdmin` 换成 `BeginStaff`（**已落地**）：`BeginAdmin` 只设 `role=podhub_app`，**不设** `staff_access`，所以不换的话后台目录页自己读不到数据（这正是实现期 `catalog_whitelist_test.go` 报 500 的原因）。
> - **`published` 的目录是平台共享参考数据，对任意 app 会话可读。** 这条是本节 v2 论断里最需要修正的一点：v2 曾把商品目录当租户数据，按「只读自己绑定的 source」收口，实测直接打挂了卖家建 listing 卡片（`listing_hot_test.go` 要读**别的** source 的 `sc_products`/`sc_skus`）与公共目录页。目录不是租户数据——卖家挑商品时看的是平台货盘。
> - 供应商经 `sc_source_members` 读**自己** source 的全部商品（含未发布草稿，供应商门户要列草稿）。
> - 卖家经 `delegate_bindings` 读自己绑定的 source。
> - 商品负责人经 `sc_catalog_managers` 读写自己的 source。
> - **`sc_source_offers`（工厂成本）不开放通用读臂。** 它是唯一真正敏感的一张：`cost_cents` 泄露即可反推平台毛利，卖家与匿名访问者都不能读。只有 staff、商品负责人、以及「本工作区自己的派单结算」三种读者。`sc_price_versions` 的 manager 臂仍然只给 `FOR SELECT`（价格历史是审计记录，负责人可读不可改写），价格写入留在 staff。
>
> 落点：`db/migrations/00365_catalog_rls.sql`；策略名与谓词逐条登记在 `tests/testkit/fingerprint.go` 的 `intentionalRLSPolicies`，删/改名策略必须在那张表的 `removedRLSPolicies` / `renamedRLSPolicies` 里显式登记，否则指纹测试失败。

| 表 | staff 臂 | org 臂 | supplier/fulfiller 臂（v2） | 备注 |
| --- | --- | --- | --- | --- |
| `sc_sources` | 新：`app.staff_access='1'` | — | 新：active `sc_catalog_managers` 命中 `source_id`（`FOR ALL`，但 `listed`/`accepts_delegate` 由 `trg_sc_sources_manager_pin_flags` 钉住） | 00365 前**零策略** |
| `sc_source_prop_defs` | 同上 | — | 同上（继承 `sc_sources.listed` 仍由查询过滤） | 00365 前零策略 |
| `sc_products` | 同上 | — | 同上 | 00365 前零策略 |
| `sc_skus` | 同上 | — | 同上（`sku → product → source`） | 00365 前零策略 |
| `sc_source_offers` | 同上 | — | **manager 臂是 `SELECT` + `UPDATE` 两条，不是 `FOR ALL`**：§8.2 只给「改 `cost_cents`」，不给建/删工厂供给行。**settlement 读臂已删除**（按 `source_id` 关联会让卖家经一单读到全厂成本表） | 含 `cost_cents` / `shipping_cost_cents`；00365 前零策略 |
| `sc_price_versions` | 同上 | — | **只读**（写只允许 staff） | 价格历史不可被商品负责人改写；00365 前零策略 |
| `sc_source_members` | 保留（`00203:155-159`） | — | 保留 self 臂（`00203:150-153`） | |
| `sc_source_fulfillers` | 新增 staff 臂 | — | 新增 self 臂（`user_id = app.current_supplier_user_id`） | 只读自己的授权行 |
| `sc_catalog_managers` | 新增 staff 臂 | — | 新增 self 臂（`user_id = app.current_org_user_id`，见 6.2） | |
| `delegate_bindings` / `delegate_assets` / `delegate_orders` / `delegate_order_lines` / `delegate_dispatch_assets` | 保留 | 保留 | 保持 source 级（卖家侧） | 这五张是**卖家**视角，不是供应商视角 |
| `delegate_dispatches` | 保留 | 保留 | **改为 fulfiller 级**：`fulfiller_id IN (SELECT fulfiller_id FROM sc_source_fulfillers WHERE user_id = app.current_supplier_user_id AND status='active')` + 6 周过渡臂 | 见 7.4 |
| `delegate_settlements` | 保留 | 保留 | **删掉** `delegate_source_isolation`（`00258:103-116`） | 结算属于买家/平台，不属于供应商 |
| `supplier_wallets` | 保留 | — | **删掉** `supplier_source_isolation`（`00258:120-133`） | 供应商零资金 |
| `supplier_wallet_ledger` | 保留 | — | **删掉** `supplier_source_isolation`（`00258:141-154`） | 同上 |
| `supplier_withdrawals` | 保留 | — | **删掉** `supplier_source_isolation`（`00258:162-175`） | 同上 |

### 6.2 新 GUC 与会话

| 新增 | 值 | 谁设 |
| --- | --- | --- |
| `app.current_org_user_id` | 平台账号的 `account_users.id`（**不是** `org_id`） | 新 `tenantx.EnterCatalogManager` |
| `db.CatalogManager(userID)` | `kind=sessCatalogManager` | 新 `Gate`，走 `tenantx.EnterAppRole` + 上述 GUC |

命名要带着 `_org_user_` 前缀，避免和 `app.current_org_id` 混淆——两者的值域完全重叠（都是 bigint），混用不会报错，只会静默越权。

**绝不复用 `db.Catalog()`**：那是 `podhub_ozon_catalog` 角色（`00320:10`），只授权给 `podhub_login_api`（`00340`），只服务全平台 Ozon 错误目录。拿它跑供应商目录会把两套完全不同的权限模型焊在一起。

### 6.3 SECURITY DEFINER 的三条纪律

1. **改签名必须 `DROP` 旧函数**。`CREATE OR REPLACE FUNCTION` 换参数列表只会**新增一个重载**，旧签名连同它的 ACL 与旧行为继续可达。`00259` 之所以安全，正是因为它与 `00205` 参数列表**完全一致**——一旦 v2 要加 `p_fulfiller_id`，就必须：

   ```sql
   DROP FUNCTION IF EXISTS public.delegate_supplier_accept(uuid, bigint);
   -- 然后 CREATE FUNCTION public.delegate_supplier_accept(uuid, bigint, uuid) ...
   ```

   并且**同时** `DROP` `00205` 与 `00259` 两个版本的旧签名（同签名，`DROP` 一次即可）。

2. **每个新函数都要逐函数 `REVOKE EXECUTE ... FROM PUBLIC` + `GRANT ... TO podhub_app, podhub_worker`**。`00191:40` 有 `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO podhub_app, podhub_worker`，`00191:42-47` 的 `ALTER DEFAULT PRIVILEGES` 还会让**未来**的函数自动带上 app/worker 的 EXECUTE——再加上 PG 默认的 `PUBLIC` EXECUTE，等于「新建 definer 函数默认全库可执行」。`00203:260-264` 的 `delegate_source_active_member_count` 就是现存的反例：它是 `SECURITY DEFINER`，**没有任何 `REVOKE`**。

3. **定义者函数里的权限判定要与 RLS 谓词同一口径**。函数以属主身份运行，绕过 RLS，所以 Go 层或表上的策略都管不住它。`00259` 的 accept 在 `FOR UPDATE` 前后各查了一次成员身份（`L17-31`、`L44-51`），这个「锁前后各查一次」的模式必须保留，但谓词要换成 `sc_source_fulfillers` 且命中 `delegate_dispatches.fulfiller_id`。

### 6.4 首个只读审计 SQL

上生产前先跑这条，确认没有「PUBLIC 可执行的 `delegate_*` 函数」：

```sql
SELECT p.oid::regprocedure AS fn, p.prosecdef, p.proacl
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname LIKE 'delegate_%'
   AND (p.proacl IS NULL
        OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0));
```

`proacl IS NULL` 意味着「沿用默认 ACL」，而默认 ACL 里 `PUBLIC` 有 EXECUTE——所以 NULL 也是问题，不是「没配置」。

---

## 7. 派发与履约

### 7.1 两条派发路径

| 路径 | 位置 | v2 行为 |
| --- | --- | --- |
| 自动派发 | `delegate/repo/seller_order.go` 的 `dispatchReady` | 按 `binding.source_id` 找 active `sc_source_fulfillers`；恰好 1 条则写 `fulfiller_id`，0 条写 `dispatch_blocked_reason='no_fulfiller'` |
| 手动派发 | `delegate/repo/admin.go` | 同上；员工可显式指定 `fulfiller_id`（必须属于同一 `source_id`） |

分组键今天只有 `source_id`。v2 增加 `fulfiller_id`，但**分组仍然按 `source_id`**：一个包对应一个厂家，履约人在包内唯一。这样 `ux_delegate_dispatches_live UNIQUE(order_id, source_id) WHERE state='dispatched'` 不需要改。

> 「恰好 1 条」这个判断依赖 `ux_sc_source_fulfillers_one_active`。若第 12 节 O11 决定改成「一库多履约人」，这唯一索引要换成按商品/SKU 分配的规则，`ambiguous_fulfiller` 这个取值才会真正被用到。本方案保留它就是为了让 O11 的两种答案都能落地。

### 7.2 驳回闩改为履约人级

`last_rejected_source_id` 的现有语义（`00203:86`）在三个地方被读：

| 位置 | 语义 |
| --- | --- |
| `delegate/repo/seller_order.go:33-39` | 换绑时的**清闩**逻辑：`last_rejected_source_id = CASE WHEN l.last_rejected_source_id IS NOT NULL AND l.last_rejected_source_id IS DISTINCT FROM (SELECT b.source_id FROM delegate_bindings b WHERE b.binding_id = $4) THEN NULL ELSE l.last_rejected_source_id END`——同源换绑不清、跨源换绑才清 |
| `delegate/repo/admin.go:88` | 手动派发时**无条件清零** |
| `delegate/repo/seller_order.go:257` | live-packet 查询里 `AND (l.last_rejected_source_id IS NULL OR l.last_rejected_source_id <> b.source_id)` |

问题是它是 source 级。同一个厂里换了履约人（或原履约人被撤、新履约人上岗），`source_id` 没变，第 33-39 行的 `IS DISTINCT FROM` 恒假 ⇒ 这一行**永远不会再自动派发**，只能等员工手动派发（而手动派发会清零，于是变成「必须有人记得点一下」）。

v2 改成 `last_rejected_fulfiller_id`，三处同步：

1. 第 33-39 行改为**换绑即清闩**：`SET last_rejected_fulfiller_id = NULL`，不再写 CASE。理由：闩改成履约人级之后，「保留旧闩」只在一个情况下有意义——新 binding 仍路由到同一个履约人；而这个判断要额外 JOIN `sc_source_fulfillers` 才能算出来，算错的代价是「该行永久不再派发」。无条件清零与 `admin.go:88` 手动派发的既有行为一致，且最坏结果只是多重派一次（外层还有 `ux_delegate_dispatches_live` 与 live-packet 的 `NOT EXISTS` 兜住）。
2. `admin.go:88` 的清零改为清 `last_rejected_fulfiller_id`。
3. 第 257 行的 live-packet 查询改判 `l.last_rejected_fulfiller_id IS NULL OR l.last_rejected_fulfiller_id <> b.fulfiller_id`。

旧列**保留但不再读写**（`ALTER TABLE ... DROP COLUMN` 会撞 `postRustColumns` 的尾切片比较，且历史值还有对账价值）。在 00362 里加注释说明它是遗留列。

> **实现期修正（2026-10-22）：00363 的 USING 采用「读宽写严」，且 Ship 的资金落地改走 definer。**
>
> 本节原方案只写「supplier 臂改 fulfiller 级」，没有区分 USING 与 WITH CHECK。实现时发现「撤销履约人」会把在途包一起藏掉：`00361:159` 用 `status='disabled'` 而不是删行，就是为了保住归属链（历史包的 `fulfiller_id` 必须仍能解析）；但 `delegate_fulfiller_isolation` 的 USING 若带 `status='active'`，员工点下撤销的瞬间，那个人手上的包就从他自己眼前消失——读不到、发不了，只能由员工代操作。这与「保留行是为了保住归属」自相矛盾。
>
> 因此 `delegate_dispatches` 与 `delegate_settlements` 两条策略都拆成：
> - `USING` 只判 `user_id = current_supplier_user_id`（**不含 status**）——撤销授权终止的是「再接新活」的资格，不是「看自己在途的活」的资格；
> - `WITH CHECK` 保留 `status='active'`——被撤授权的人不能新建或改派包。
>
> 这个二分同时决定了动作函数的错误语义，并已被 `tests/integration` 的两个用例钉住：非收件人读到 0 行 → `DELEGATE_NOT_FOUND`（不构成存在性探测）；被撤授权的履约人读得到、但 00364 的门拒 → `DELEGATE_FORBIDDEN`。若有人把 `status='active'` 加回 USING，第二个用例立即退回 NOT_FOUND。
>
> **另**：本节与 §9 都要求「钱仍然要动」，而 §9.2 把三张资金表的 supplier 臂删掉（F2）。这两条在实现时互相打架——`Ship` 在 `db.Supplier` 会话里调 `creditDispatch` 给厂家钱包入账，F2 之后该会话对 `supplier_wallets` / `supplier_wallet_ledger` 已无任何策略臂，写入必抛 42501，`Ship` 整个事务回滚，包永远停在 `accepted`。修法是新增 `delegate_credit_fulfiller_wallet(p_dispatch_id uuid, p_now_ms bigint)`（SECURITY DEFINER，`REVOKE PUBLIC` + GRANT `podhub_app, podhub_worker`），**只收 dispatch_id**：source 与金额都从 `delegate_settlements` 现取，调用方无法自报金额；函数内再用 `COALESCE(current_setting('app.staff_access', true) = '1', false) OR 调用者=该包 pin 的 fulfiller` 复检一次。`COALESCE` 是承重的：GUC 未设时 `current_setting(..., true)` 返回 NULL，`NULL OR false` 是 NULL，而 plpgsql 的 `IF` 对 NULL 不执行——去掉它，这道门会对「从未设置 staff_access 的供应商会话」静默放行。`internal/admin/supplier/repo/cash.go` 有另一个同名的平台侧 `moveCash`，不在本条范围内。
### 7.3 三个动作函数

`00259` 是 `00205` 的同签名覆盖，所以「旧版本是否仍生效」的答案是：只有一份函数对象，最后 `CREATE OR REPLACE` 的版本生效。v2 重建时：

```sql
-- 1) 旧签名必须显式删掉，否则 CREATE 新签名只是加了个重载
DROP FUNCTION IF EXISTS public.delegate_supplier_accept(uuid, bigint);
DROP FUNCTION IF EXISTS public.delegate_supplier_reject(uuid, bigint, text);
DROP FUNCTION IF EXISTS public.delegate_supplier_ship(uuid, bigint, text, text, bigint);

-- 2) 新签名带 p_fulfiller_id
CREATE FUNCTION public.delegate_supplier_accept(
    p_dispatch_id uuid, p_supplier_user_id bigint, p_fulfiller_id uuid
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE ...
BEGIN
    SELECT d.source_id, d.state, d.fulfiller_id INTO v_source, v_state, v_fulfiller
      FROM public.delegate_dispatches d WHERE d.dispatch_id = p_dispatch_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'DELEGATE_NOT_FOUND'; END IF;
    IF v_fulfiller IS DISTINCT FROM p_fulfiller_id THEN
        RAISE EXCEPTION 'DELEGATE_FORBIDDEN';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.sc_source_fulfillers f
         WHERE f.fulfiller_id = p_fulfiller_id
           AND f.source_id = v_source
           AND f.user_id = p_supplier_user_id
           AND f.status = 'active'
    ) THEN RAISE EXCEPTION 'DELEGATE_FORBIDDEN'; END IF;
    ...
    -- FOR UPDATE 之后按同一谓词复检（保留 00259 的锁后复检模式）
END;
$$;

-- 3) 逐函数收口 ACL
REVOKE EXECUTE ON FUNCTION public.delegate_supplier_accept(uuid, bigint, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.delegate_supplier_accept(uuid, bigint, uuid)
    TO podhub_app, podhub_worker;
```

reject / ship 同形。三处 `RAISE EXCEPTION` 文案保持 `DELEGATE_NOT_FOUND` / `DELEGATE_FORBIDDEN` / `DELEGATE_TERMINAL` 不变——它们已经是对外错误码的一部分（`supplier/repo/write.go` 读的是返回值，不是异常文本，但集成测试里有断言）。

### 7.4 历史包

**历史包定义为 `delegate_dispatches.fulfiller_id IS NULL`。**

- 默认（Phase 2 起）：只有 staff 臂能看见。供应商**看不到任何** `fulfiller_id IS NULL` 的包。
- 理由：历史包的收件人不可重建。`rebind`（`accounts.go:275-305`）的审计正文是字面量 `{}`，没有任何审计触发器记录「这个包当时发给谁」，`sc_source_members` 的行也已经被删。
- 过渡（Phase 2 上线后 6 周）：加一条**带过期日期注释**的过渡臂，让 active 成员按 source 级**只读**看到 `fulfiller_id IS NULL` 的包。6 周后由 00366 删除。00366 **不在本批**（见第 10 节）。

**过渡期这批包是「只看不能动」的，必须说清楚**：三个动作函数（§7.3）以属主身份运行、绕过 RLS，而它们对 `fulfiller_id IS NULL` 一律 `RAISE EXCEPTION 'DELEGATE_FORBIDDEN'`。所以过渡臂能给的只是「看得见」，`accept`/`reject`/`ship` 全部会失败，员工必须手动代操作。二选一：(a) 接受「过渡期旧包只读 + 员工代收代发」；(b) 在三个函数里加一条 legacy 分支（`p_fulfiller_id IS NULL AND fulfiller_id IS NULL` 时回落到 `sc_source_members` 的 active 判定），代价是**函数里永久多一条 source 级逃生门**，而它恰恰是 v2 要拆掉的那个模型。默认取 (a)，这也是 O12 的一部分。

```sql
-- 过渡臂：仅 fulfiller_id IS NULL 的历史包，6 周后由 00366 删除
CREATE POLICY delegate_legacy_source_isolation ON public.delegate_dispatches
    FOR ALL TO podhub_app
    USING (
        fulfiller_id IS NULL
        AND EXISTS (SELECT 1 FROM public.sc_source_members m
                     WHERE m.source_id = delegate_dispatches.source_id
                       AND m.user_id = NULLIF(current_setting('app.current_supplier_user_id', true), '')::bigint
                       AND m.status = 'active')
    )
    WITH CHECK (false);   -- 只读，写入一律拒绝
```

`WITH CHECK (false)` 是关键：`FOR ALL` 的策略如果不写 `WITH CHECK`，会继承 `USING` 谓词，等于允许对历史包做写操作。

### 7.5 `delegate_source_active_member_count`

`seller_bind.go:301` 用它给卖家出「无活跃成员」警告（spec §E.28）。v2 之后「活跃成员」不再是派发成功率的指标，要改成「活跃履约人」：

```sql
CREATE FUNCTION public.delegate_source_active_fulfiller_count(p_source_id text)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT count(*)::bigint FROM public.sc_source_fulfillers
     WHERE source_id = p_source_id AND status = 'active';
$$;
REVOKE EXECUTE ON FUNCTION public.delegate_source_active_fulfiller_count(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.delegate_source_active_fulfiller_count(text)
    TO podhub_app, podhub_worker;
```

旧函数保留（还有别的调用点就不删；只有 `seller_bind.go:301` 一处的话可以一起 `DROP`）。无论删不删，都要给它补上 `REVOKE EXECUTE ... FROM PUBLIC`——这是 `00203` 留的洞。

---

## 8. 商品负责人

### 8.1 为什么必须新开 `/api/catalog/*`

三个理由，任何一个单独成立都够：

1. `/api/admin/*` 的 22 条 `supplier-dbs` 路由里 19 条落进数据库事务，入口是 `X1.withRead/withWrite`（`x1_store.go:24-30`）与 `Portal.withTx`（`portal.go:30-32`），最终落进 `Gate(staff=true…)`（读）、`Gate(write=true…)`（写，要 writer lease，`AssertWrite` 失败文案是「平台货源写入未启用」）或 `WithTx`（`supply.go:84-107`，**无条件** `set_config('app.staff_access','1')`、不取 lease）。放宽 guard 等于把全站 staff 读豁免发给普通平台账号（详见 §2.3）。
2. 库的归属权是 `sc_sources.created_by_account_uuid` 上的**单个用户**（`supply.go:292`、`:325`），而库内所有行对任何能进入该 `source_id` 的调用者一律可见（`x1_write.go:121-125` 不按创建者过滤）。这套「单点归属 + 库内全可见」的形状无法表达「多个商品负责人」，换人后整库对新人不可见。这是归属模型错位，不是 guard 能修的。
3. `/admin` 前端路由整体 staff-only（`routeAudienceFor` 的 `isStaff`），复用会让普通账号进不去，改了又影响整个 admin 壳。

### 8.2 新 surface 的能力边界

| 能力 | 允许 | 说明 |
| --- | --- | --- |
| 读本库的 `sc_products` / `sc_skus` / `sc_source_offers` / `sc_source_prop_defs` | ✅ | 走 RLS，不是 `WHERE` |
| 增删改 `sc_products` / `sc_skus` | ✅ | |
| 改 `sc_source_offers.cost_cents` / `shipping_cost_cents` | ✅ | 供货价是厂家的，商品负责人本来就该能改 |
| 改 `sc_price_versions`（平台售价） | ❌ | 只 `GuardSuper` 可写；商品负责人只读 `platformPriceCents` |
| 改 `sc_sources.listed` | ❌ | 上架到卖家可见是平台决定 |
| 改 `sc_sources.accepts_delegate` | ❌ | 是否接派单是平台决定 |
| 改 `sc_source_members` / `sc_source_fulfillers` / `sc_catalog_managers` | ❌ | 授权管理只走 `/api/admin/*` + `GuardSuper` |
| 读 `supplier_wallets` / `supplier_withdrawals` | ❌ | 见第 9 节 |

### 8.3 `RowData` 的成本泄漏

`admin/x1/contract/supplier_row.go:42` 起的 `RowData` 同时带 `CostCents`(L56)、`ShippingCostCents`(L57)、`PlatformPriceCents`(L58)。这是 staff 视角的形状，**不要**给商品负责人复用。

对照 `supplier/contract/views.go:204-235` 的 `CatalogRow`：它有 `PlatformPriceCents`(L214)、`SuggestedRetailCents`(L215)、`SuggestedOldPriceCents`(L216)、`ShippingCostCents`(L217)，**没有 `CostCents`**——这就是「该隐藏哪个字段」的现成先例。商品负责人应该拿 `CatalogRow` 形状（他自己录的成本当然能看，但不能从平台售价反推毛利），而不是 `RowData`。

---

## 9. 资金边界

### 9.1 「供应商零资金访问」的完整含义

v1 只写「不挂供应商的资金路由」。实际要同时做四件事：

| # | 动作 | 落点 |
| --- | --- | --- |
| F1 | 卸载 `GET /api/supplier/wallet`、`GET /api/supplier/withdrawals`、`POST /api/supplier/withdrawals` | `supplier/http/handler.go:69-81` 的 3 条 |
| F2 | `DROP POLICY supplier_source_isolation` on `supplier_wallets` / `supplier_wallet_ledger` / `supplier_withdrawals` | `00258:120` / `:141` / `:162` |
| F3 | `DROP POLICY delegate_source_isolation` on `delegate_settlements` | `00258:103` |
| F4 | 清理残留：`supplier_wallets.balance_microfen != 0` 与 `supplier_withdrawals.status='requested'` | 见 9.2 |

只做 F1 是**假的安全**：策略还在库里，任何走 `db.Supplier` 的代码路径（包括未来新写的内部任务）都能读到本厂钱包和提现单。F2/F3 之后，即便代码写错也读不到。

### 9.2 残留必须人工清算

这两类残留无法用迁移自动处理：

- `supplier_wallets.balance_microfen != 0`：余额是真的欠厂家的钱。迁移不能凭空清零。
- `supplier_withdrawals.status='requested'`：有一条 `ux_supplier_withdrawals_one_open UNIQUE(source_id) WHERE status='requested'`（`00258:89`），说明一个厂同时最多一条待审提现。不处理就永远挂着。

处置建议（第 12 节 O15）：先出报表，逐厂确认余额与待审提现，走线下打款或 `pay`/`reject` 收口后再执行 F2/F3 的迁移。**迁移本身不做数据订正**，只在 `DO $$ ... $$ ` 块里 `RAISE EXCEPTION` 拦住「还有非零余额」的库，强制先清算。

### 9.3 钱仍然要动，但只由平台侧动

供应商不再有资金界面，但 `Accept` 仍是钱事件：`Accept`(L21) → `act`(L97) → `holdOnAccept`(L149-183) → `bill.HoldTx`；`Ship`(L65) → `settleDispatch`(L216-273) → `SettleTx` + `creditDispatch`(L275-337)。

关键顺序：**验收必须先于冻结**。`holdOnAccept` 里如果结算行不存在会先 `quoteDispatch` 再 `INSERT state='held'`，然后 `HoldTx`。所以 `delegate_supplier_accept` 的履约人校验必须发生在**函数最前面**，绝不能等 `holdOnAccept` 之后再判——否则一个没有履约权限的账号能触发买家钱包冻结。

---

## 10. 迁移编排

### 10.1 编号冲突是真实存在的

| 号 | 状态 |
| --- | --- |
| `00350_subscription_periods.sql` | **已合并**，已在 `db/migrations.sha256` 尾行 |
| `00351_subscription_capacity_overrides.sql` | 在分支 `fix/billing-capacity-quote-scope` @ `8928475`（该提交的迁移数为 323），尚未合并但**已占用** |
| `00352`–`00357` | `docs/architecture/supplier-db-minimal.md` 第 28 行与第 50-63 行声称要用（该文档本身是「待拍板」状态；第 86 行 C5 与第 144 行第 6 条又自认「树未前进即 00358」） |

而 `supplier-db-minimal.md` 第 28 行写「已到 00349 … 新开 00350–00357」，这句在 `00350` 已合并之后**已经过期**。

### 10.2 本批取 00360–00365

理由：`00358`/`00359` 留给 `supplier-db-minimal` 的 C5 追加号与其重排后的余量；本方案的 6 个文件从 `00360` 起，与任何已合并、已占用、已声称的号都不重叠。`supplier-db-minimal` 拍板落地时必须整体重排到 `00366+`——这一点要在那份文档里改，不在本文改。

| 文件 | 内容 | 关键约束 |
| --- | --- | --- |
| `00360_account_kind.sql` | `account_users.account_kind` + 2 个 CHECK；`must_change_password`；`target='/supplier' AND role='user'` 回填；`uq_account_users_email_lower` | 回填遇 `target='/supplier'` 但 `role<>'user'` 要 `RAISE EXCEPTION`；加 `lower(email)` 唯一索引前先查重，冲突要报出具体行 |
| `00361_source_roles.sql` | `sc_source_fulfillers` + `sc_catalog_managers`（DDL、索引、RLS、GRANT） | 两张表的 `source_id` 都 `ON DELETE RESTRICT`；`user_id` 都 `ON DELETE RESTRICT` |
| `00362_dispatch_fulfiller.sql` | `delegate_dispatches.fulfiller_id` + 复合 FK；`delegate_order_lines.last_rejected_fulfiller_id`；`delegate_orders.dispatch_blocked_reason` | `fulfiller_id` 可空；复合 FK 需 `ux_sc_source_fulfillers_source` |
| `00363_policy_rewrite.sql` | `delegate_dispatches` 的 supplier 臂改 fulfiller 级 + 过渡臂；`delegate_settlements` 删 source 臂；三张资金表删 supplier 臂 | 过渡臂必须 `WITH CHECK (false)`；删策略前先 `DROP POLICY IF EXISTS` |
| `00364_fulfiller_functions.sql` | `DROP` 三个旧签名 → `CREATE` 三个新签名（带 `p_fulfiller_id`）→ 逐函数 `REVOKE/GRANT`；新增 `delegate_source_active_fulfiller_count`；给旧 count 函数补 `REVOKE` | 新函数体必须**同时**出现在 goose SQL 与 `intentionalFunctions` 里 |
| `00365_catalog_rls.sql` | 六张目录表的 `ENABLE/FORCE RLS` + staff/manager 臂；`tenantx` 加 `app.current_org_user_id`；`db.CatalogManager` 会话 | 加 RLS 前必须先确认`podhub_app` 的所有既有读路径都带 `staff_access`，否则线上直接读空 |

`00366_legacy_window_drop.sql`（过渡臂到期拆除）**不在本批**，最早在 Phase 2 上线满 6 周后提交。

### 10.3 每个文件的验收清单（漏一条就是红 CI）

1. version > 341；不与 `00350`、`00351` 冲突。
2. `sha256` 追加到 `db/migrations.sha256` **尾部**，跳过前 5 行 `#` 注释。
3. `postRustTables`（`fingerprint.go:171-195`）登记新表：`sc_source_fulfillers`、`sc_catalog_managers`。
4. `postRustColumns`（`:200-240`）登记新列，`Ordinal` 必须是**物理尾序**（`diffTable:448-465` 只比 `gotColumns[len(want.Columns):]` 这一段尾部切片）。
5. `postRustIndexes` / `postRustConstraints` 登记新索引与 CHECK/UNIQUE。
6. `intentionalFunctions`（`:265-284`）登记新函数；函数体也要出现在 goose SQL 里（两侧比对）。
7. `intentionalRLSPolicies`（`:290+`）登记新策略名。
8. **因为 7 会连带跳过 `relrowsecurity`/`relforcerowsecurity` 的比较（`:518-521`）**，必须额外加一条显式断言：`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN (...) ` 且三列全部为真。
9. `-- +goose Down` = `SELECT 1;`（配 `-- Rust down() refuses a destructive rollback.`，与本目录既有风格一致）。
10. 不加 `CONCURRENTLY`：goose 在事务里跑，`CREATE INDEX CONCURRENTLY` 会直接失败。

### 10.4 顺序依赖

`00360` → `00361` → `00362` → `00363` → `00364` → `00365`。其中：

- `00362` 的复合 FK 依赖 `00361` 的 `sc_source_fulfillers`。
- `00364` 的函数体引用 `00362` 的 `fulfiller_id` 与 `00361` 的表。
- `00363` 的过渡臂引用 `00362` 的列。

这六个文件不能合并：`00364` 的 `DROP FUNCTION` 与 `CREATE FUNCTION` 若与 `00362` 的 `ADD COLUMN` 同文件，回滚语义会变成「删了函数但列还在」，而 `Down` 一律是 `SELECT 1`，不可逆。

---

## 11. 分期与验收

### 11.1 Phase 0：止血（不依赖本方案任何未决问题，可立即做）

| # | 动作 | 文件 |
| --- | --- | --- |
| 0-1 | `adjust_supplier_db_price` 的 guard 从 `GuardStaff` 改 `GuardSuper` | `internal/admin/http/suppliers.go:61` |
| 0-2 | 给 `delegate_source_active_member_count(text)` 补 `REVOKE EXECUTE ... FROM PUBLIC` | 新迁移（可并入 00360） |
| 0-3 | `SetRole` 增加「目标 `account_kind<>'platform'` → 拒绝」的 Go 层检查（DB CHECK 上线前的过渡） | `internal/admin/users/repo/users.go:547-585` |
| 0-4 | `provision` 复用分支增加「目标 `account_kind='platform'` → 拒绝」 | `internal/admin/supplier/repo/accounts.go:244-260`（复用分支 L245-250，`INSERT sc_source_members` L253-257） |
| 0-5 | 卸载 `/api/supplier/wallet` 与 `/api/supplier/withdrawals` 两条读路由 + 一条写路由（F1） | `internal/supplier/http/handler.go:69-81` |

Phase 0 全部是「把已有的洞堵上」，不引入新模型，不需要第 12 节任何决定。

### 11.2 Phase 1：模型（00360–00362）

- 加 `account_kind` / `must_change_password`，中间件闸上线，前端读 `accountKind`。
- 建两张授权表，管理端加授权的 CRUD（`GuardSuper`）。
- `delegate_dispatches.fulfiller_id` 加列但**不启用**（派发器仍写 NULL）。
- 出口：所有账号有明确 `account_kind`；供应商号无法被提升；新表空转不影响业务。

### 11.3 Phase 2：策略与函数（00363–00364）

- 派发器开始写 `fulfiller_id`。
- 三个 definer 函数换成带 `p_fulfiller_id` 的版本，旧签名 `DROP`。
- 资金三表删 supplier 臂（前提：9.2 的清算已完成，由 `RAISE EXCEPTION` 强制）。
- 过渡臂上线，6 周计时开始。

### 11.4 Phase 3：商品管理面（00365）

- `/api/catalog/*` 上线，六张目录表上 RLS。
- 出口：普通平台账号能维护被授权的库，读不到别人的库，改不了平台售价。

### 11.5 Phase 4：收尾（00366，最早 +6 周）

- 删过渡臂。
- `DROP COLUMN` 遗留的 `last_rejected_source_id`（如果那时确认无对账需求）。
- `supplier_id` / `target` 上不再有任何权限语义，可评估删除（`supplier_id` 仍被 `identity/wire.go:55` 作为 `supplierId?` 透出，删之前要确认前端无消费）。

### 11.6 验证矩阵

| 断言 | 怎么验 |
| --- | --- |
| 供应商号无法成为 admin | 集成测试：`SetRole(supplier_public_id, 'admin')` → 期望 DB CHECK 报错 OR Go 层先拒 |
| `must_change_password` 只放行 6 条 | 集成测试：逐条打 `/api/admin/users`、`/api/supplier/dispatches`、`/api/supplier/wallet`、SSE，全 403 `PASSWORD_CHANGE_REQUIRED` |
| 同库新成员接不了旧包 | 集成测试：A 接包 → 撤 A → 加 B → B 调 accept → 期望 `DELEGATE_FORBIDDEN` |
| 换履约人后驳回行能重新派发 | 集成测试：派发 → reject → 撤换履约人 → 触发 `dispatchReady` → 期望新包生成 |
| 供应商读不到任何资金行 | 集成测试：`db.Supplier(userID)` 下 `SELECT count(*) FROM supplier_wallets` = 0 |
| 商品负责人只读自己库 | 集成测试：两个 manager 各建一行，互相不可见；staff 全见 |
| 商品负责人改不了平台价 | 集成测试：`POST /api/catalog/.../price` → 404（路由不存在）或 403 |
| `PUBLIC` 不能执行 definer 函数 | 6.4 的审计 SQL 返回空集 |
| RLS 真的 FORCE | 10.3 第 8 条的显式断言 |
| 迁移守卫 | `go test ./internal/platform/db -run TestMigrationGuard` |

---

## 12. 需要拍板的 5 个问题

这 5 个已经登记到 `docs/decisions.md` 的 `O11`–`O15`。本文的默认取值是推荐值，不是已定结论。

| 号 | 问题 | 本文默认 | 备选 |
| --- | --- | --- | --- |
| O11 | 一个货源库只能有一个履约人，还是可以有多个 | **一个**（`ux_sc_source_fulfillers_one_active`）。派发器遇到 0 个写 `no_fulfiller`，遇到 >1 个写 `ambiguous_fulfiller` | 多个：需要按商品/SKU 分配规则，`ux_delegate_dispatches_live` 与三项分组逻辑全要重算 |
| O12 | 历史包（`fulfiller_id IS NULL`）怎么处理 | **fail-closed + 6 周只读过渡臂**：默认只有 staff 可见；过渡期 active 成员能看见但**动不了**（三个动作函数对 `fulfiller_id IS NULL` 一律拒绝），旧包由员工代收代发 | 立即全封（供应商看不到旧包，可能卡住进行中的单）；或给三个函数加 legacy 分支（过渡期可真接单，但函数里永久留一条 source 级逃生门）；或永久保留 source 级（等于不做这项改造） |
| O13 | 供应商能不能复用已有的平台邮箱 | **不能**。`provision` 遇到 `account_kind='platform'` 拒绝；转成供应商必须超管显式操作并留审计 | 允许复用（要处理「同一账号同时是平台用户和供应商」的双重身份，与 M4 的 DB CHECK 冲突） |
| O14 | 是否要 `can_view_global` | **砍掉**。观察面继续只认 `super_admin` | 保留：要同步重写 9 处硬编码（`observe/repo:77-78`、`00275` 六条策略 L5-51、`00300:85-92`、`00320:165-173`） |
| O15 | `supplier_wallets` 残留余额与待审提现怎么清 | **先清理再迁移**：迁移里 `RAISE EXCEPTION` 拦住非零余额，人工逐厂清算后再放行 F2/F3 | 迁移里自动清零（不可接受：等于抹掉负债） |

另有两个不算「产品决策」但必须由 owner 确认的工程约束：

- `00351` 的合并顺序。`fix/billing-capacity-quote-scope` 一旦先合，本批必须让到 `00360` 之后（本来就是），但**不要**反过来让 billing 分支重排——它的迁移已经在分支上跑过。
- `db/migrations.sha256` 是追加式清单，本批 6 个文件会把它从 327 行推到 333 行；这是正常的，不要试图重排。

---

## 13. 未验证清单

以下结论是静态读码得出的，**没有**执行验证：

1. 没有跑过任何数据库测试。RLS 与 SECURITY DEFINER 的行为全部来自 SQL 文本阅读；策略的 `FOR ALL` / `USING` / `WITH CHECK` 组合在真实 PG 上的行为未实测。
2. 没有查过生产数据形状：一个厂有几个成员、有没有 `balance_microfen != 0` 的钱包、有没有 `status='requested'` 的提现、`target='/supplier'` 的行数、有没有 `target='/supplier'` 但 `role<>'user'` 的异常行——**全部未知**。
3. 没有确认 `00259` 之后是否还有别的迁移覆盖了那三个函数。只按文件名检查到 `00350` 为止没有发现，但文件名不能证明函数体没被别的迁移改过。上线前用 `d+ public.delegate_supplier_accept` 与 `pg_get_functiondef` 实测。
4. 没有确认 `00351` 分支的合并时间与内容是否会再次改动 `account_users` 或 `delegate_*`。分支名与提交标题（"honor capacity overrides and freeze quoted periods"）看起来只碰 billing，但未读 diff。
5. 目录的 owner 过滤只核了 `supply.go:280/285/292/325` 与 `x1_prompt.go:303` 五处（都是 `created_by_account_uuid` 等值），以及 `loadRows` 没有创建者过滤；没有全量审计 `internal/listing/read`、`internal/supply`、`internal/supplier` 里所有 `sc_products` 读路径是否也有同类归属假设。
6. 前端 `routeAudienceFor` 只有 3 个非测试调用点（`App.tsx:234` 与 `:266` 是匿名、`:277` 是已登录、`authenticated-app.tsx:143` 是另一条已登录路径）。改 `hasWorkspace` 的语义会同时影响这 3 处与 `App.tsx:295` 的 `/supplier` 前缀分支，逐处影响未评估。
7. 没有跑 `gofmt` / `go build` / `go vet` / `go test` / `bun test`。本文不改代码，所以不产生编译面，但第 11 节的验证矩阵里的测试**都还不存在**。
8. `supplier-db-minimal.md` 的 `00352`–`00357` 是否真的会按它自己写的方式落地，取决于那份文档拍板；本文只保证自己的号段不与之冲突，无法保证那边重排。
9. **`podhub_worker` 是 `BYPASSRLS`**（`00048:47`、`00078:47`，两处 `CREATE ROLE podhub_worker NOINHERIT BYPASSRLS`；`00294` 的文件头也复述了这一点）。所以 §6 里所有新增的 RLS 谓词，对走 `db.Worker()` 会话的代码**完全不可见**——今天至少 `internal/ratings/repo/repo.go:270-275` 用了 worker 会话。本文没有审计「§6.1 那 15 行策略覆盖的 19 张表是否会被任何 worker 路径读到」，只按现有调用点确认 `db.Worker()` 只出现在 `internal/ratings/repo/repo.go:274`，其两条事务只读写 `organization_stores` / `store_rating_sync` / `store_rating_history`。任何**新增** worker 用途都会静默绕过本方案的全部新谓词。上线前必须补一次全量 `db.Worker()` 调用点审计，并把结论写进 §6.1。

   **审计已完成（实现期）**：全仓 `db.Worker()` / `tenantx.BeginWorker` 的非测试调用点只有 `internal/ratings/repo/repo.go:274` 一处（`grep -rn 'db.Worker()\|BeginWorker' --include=*.go internal/ | grep -v _test.go`）。该文件的 `inWorker` 被 `ClaimDue`（L295）与 L355 两处使用，实际触及的表只有 `organization_stores` / `store_rating_sync` / `store_rating_history`（`awk` 提取 `FROM|INTO|UPDATE|JOIN` 目标表验证），与 §6.1 的 15 行策略覆盖的 19 张表**零交集**。结论：本方案的新谓词不会被 worker 路径绕过。**约束**：今后任何新增 `db.Worker()` 用途都必须复查是否落在这些表上，否则会静默绕过全部新谓词。
