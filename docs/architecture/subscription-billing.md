# 订阅、账期与容量变更设计

日期：2026-10-19（第 2 版，经四路对抗审查后重写）。前提见根目录 `AGENTS.md`：**把本项目当新工程改，允许破坏性变更，不做旧兼容**。本文只描述目标形态，不描述迁移期、双读或回滚窗口。

本文是方案，不改代码。

## 第 1 版被否决的问题（重写原因）

第 1 版有四处结构性错误，不是措辞问题：

1. **续费样例少收 ¥120**：样例写 `extra_stores: 2`、`months: 3`，金额却只算 `100 × 3`，漏了 `2 × 20 × 3`。
2. **排水判定无法实现**：`jobs` 表没有 `store_id`，SQL 只按 `org_id` 过滤，实际变成"组织内有任一在途任务就一家店都不挂"；且 `media.render` / `media.upload` 的租约过期后永远停在 `running`（[`internal/queue/domain/contract.go:207`](../../internal/queue/domain/contract.go:207)），排水永不结束。
3. **拦截面不成立**：worker 的 `listing.submit.batch` 全程不查 `quota_suspended`（[`internal/listing/submit/persist.go:34`](../../internal/listing/submit/persist.go:34)），四条店铺准入实现中只有一条查它；浏览器 grant 入口绕过队列。
4. **缺三块基础设施**：没有报价持久化、没有订单 reaper、`POST /api/workspaces` 还是 501。

本版逐条修正，并在文末列出与第 1 版的差异。

## 不变量

1. **账期是唯一的时间事实。** `subscriptions.term_end` 决定一切生效与失效。
2. **加购与升级不改账期。** 只改变本期容量，`term_end` 不变。
3. **每一笔购买都按自然月折算。** 套餐、续费、加店、加人、升级走同一个 `Prorate`，没有"整月一口价"的例外。
4. **金额先在有理数上精确累加，最后一次舍入到分。** 不做逐段舍入。
5. **到期不销毁数据，只收回容量与入口。** 数据、钱包余额、历史账单保留。
6. **到期不打断在途任务。** 到期前已入队的任务跑完；只有永不终结的任务由硬截止兜底。
7. **所有账期边界是 `Asia/Shanghai` 的 00:00。**

## 套餐目录

| 套餐 | 店铺 | 成员（含自己） | 月费 | 加购 |
| --- | --- | --- | --- | --- |
| free | 1 | 1 | ¥0 | 禁止 |
| lite | 5 | 1 | ¥100 | 店铺 ¥20/月，成员 ¥30/月 |
| pro | 30 | 6 | ¥600 | 同上 |
| max | 50 | 11 | ¥1000 | 同上 |

- 付费工作空间不限数量；**同一账号同一时刻只能有 1 个 free 工作空间**，升级付费后释放。
- free 永久免费，不限期。1 店、1 人、S3 上行 1 GiB/月、AI 不赠送但可充值。
- free 禁止加购与升级到 free；`plan_to` 只接受 `lite` / `pro` / `max`。
- 加购不设上限：加购单价高于相邻高档套餐的边际价，不存在套利。

`plans` 现表有 5 行（含 `ultra`）。新目录删除 `ultra` 行，并把 `free` 的 `max_stores` / `seat_limit` 改为 1。这两件事必须与 `tierKey(0)='lite'` 的投影默认值同批删除（见 §旧机制），否则到期会回落到付费容量。

## 定价与折算

### 记账口径

- 金额单位整数分。`Prorate` 内部用有理数累加，**最后一次** half-up 舍入。
- 加购按总量折算：`Prorate(单价 × 数量, from, to)`，不是 `Prorate(单价) × 数量`。10-31 加 25 家店应为 `500/31 = ¥16.13`，逐项舍入会得到 ¥16.25。
- 所有边界按 `Asia/Shanghai` 的**日期**计算，左闭右开：`from_date ≤ d < to_date`。

### 时间锚点

```
month_start(t)      = t 所在月的 1 日 00:00（Asia/Shanghai）
next_month_start(t) = month_start(t) + 1 个月
```

新增订阅（free → 付费、或已过期重开）的**首段**必须至少 1 个完整自然日：

```
stub_end = next_month_start(now)
若 stub_end − now < 24h:
    term_start = stub_end            -- 本月剩余不足一天，直接下个月起算
    金额       = base × months
    term_end   = stub_end + months 个月
否则:
    term_start = now
    金额       = Prorate(base, now, stub_end) + base × (months − 1)
    term_end   = stub_end + (months − 1) 个月
```

否则 10-31 23:59:50 下单会得到 `term_end = 11-01 00:00`，用户付了钱 10 秒后即过期。本月剩余不足一天时不再折算，直接按整月买、从下月 1 日起算——最多白送几小时，不会出现"付钱即过期"。

**所有写 `term_end` 的路径都必须落在 `Asia/Shanghai` 的 1 日 00:00。** 首购、续费、变更、兑换码赠送、管理员调整统一走 `TermEnd()`；DB 用触发器校验（`date_trunc` 带时区是 `STABLE`，不能写成 `CHECK`）。

**月费基数 `base` 永远包含加购：**

```
base(plan_key, extra_stores, extra_members)
    = plan_monthly(plan_key) + 20 × extra_stores + 30 × extra_members
```

`base` 取三个参数，调用方决定传当前值还是目标值：续费且无预约时传当前值；续费且 `next_plan_key` 非空时传 `next_*`（用户已决定下期降级，就按降级后的价格收）；容量变更时传 `target`。

### 续费（active 状态）

```
term_start = 当前 term_end           -- 一定是 1 日 00:00
term_end   = term_start + months 个月
金额       = base × months
```

`months` 只允许 1 / 3 / 6 / 12，不打折。若存在预约降级（`next_plan_key` 非空或 `next_extra_*` 更小），`base` 取 `next_*`；履约时在同一事务内把 `next_*` 落到当前字段并清空预约，`term_start` 取旧 `term_end`，因此降级在续费生效日准点发生。

### 容量变更（active 状态）

请求表达**目标状态**，不是增量：

```
target = { plan_key, extra_stores, extra_members }
```

金额：

```
升级费 = Prorate(max(0, plan_monthly(target.plan) − plan_monthly(cur.plan)), now, term_end)
加店费 = Prorate(20 × max(0, target.extra_stores  − cur.extra_stores ), now, term_end)
加人费 = Prorate(30 × max(0, target.extra_members − cur.extra_members), now, term_end)
金额   = 三项之和
```

- **减少是免费的，且在 `term_end` 生效**，不退本期。减容不产生负数金额，因此不会撞 `amount_cents >= 0`。
- `target` 的容量必须能容纳保留名单：`plan.max_stores(target.plan) + target.extra_stores ≥ len(keep_store_ids)`，成员同理。
- 升级时**加购原样保留**。用户为加购付过的钱不会因为升级而重复收，也不会被清零。
- 若 `金额 = 0` 且只有减少 → 这是 `schedule` 动作，不建订单，直接写预约。
- 若 `term_end ≤ now` → 拒绝 `RENEW_REQUIRED`，必须先续费。
- `plan_key = free` 一律拒绝。

### 前置条件与拒绝码

| 条件 | 码 |
| --- | --- |
| `term_end ≤ now` 时做容量变更 | `402 RENEW_REQUIRED` |
| 目标容量小于保留名单 | `409 CAPACITY_BELOW_USAGE` |
| `plan_key = free` | `400 VALIDATION` |
| 金额 ≤ 0 的付费动作 | `400 VALIDATION` |
| 同一工作区已有待支付订阅单 | `409 PENDING_ORDER_EXISTS` |
| 报价已过期 | `409 QUOTE_EXPIRED` |
| 报价后订阅已变化 | `409 QUOTE_STALE` |

### 示例（10 月 31 天）

| 场景 | 计算 | 金额 |
| --- | --- | --- |
| 10-15 首购 lite，1 个月 | `100 × 17/31` | ¥54.84 |
| 10-15 首购 lite，3 个月 | `54.84 + 100×2` | ¥254.84 |
| 10-15 加 1 家店 | `20 × 17/31` | ¥10.97 |
| 10-31 加 25 家店 | `500 × 1/31` | ¥16.13 |
| 10-15 lite→pro，保留加购 | `500 × 17/31` | ¥274.19 |
| lite + 2 店续费 3 个月 | `(100 + 40) × 3` | ¥420.00 |
| 10-31 23:59 首购 1 个月 | 本月剩余 < 24h：`term_start = 11-01`，`100 × 1` | ¥100.00 |
| 10-31 12:00 首购 1 个月 | 剩余 12h < 24h：`term_start = 11-01` | ¥100.00 |
| 10-30 12:00 首购 1 个月 | 剩余 36h：`100 × 2/31 + 100 × 0` | ¥6.45 |

## 生命周期与状态机

`subscriptions.status` 显式存储，不再从 `term_end` 推导：

| 状态 | 含义 | 容量 |
| --- | --- | --- |
| `free` | 未付费 | free |
| `active` | `term_end > now` | 套餐 + 加购 |
| `expired` | 付过费且 `term_end ≤ now` | free（排水中的店铺/成员例外） |

转换只有四条：`free→active`（首购）、`active→active`（续费/变更）、`active→expired`（到期）、`expired→active`（重开）。

**到期不重置 `plan_key`、`extra_stores`、`extra_members`。** 50 家店的工作区过期后按 free 容量运行，续费后原样恢复。

### 到期：零宽限 + 排水

到期时刻做两件事：拦截新活、放行旧活。

**排水集合**（`drain_set`）：`term_end` 时刻由 sweep 写一条 `subscription_events`，`kind='drain'`、`effective_at = term_end`，`breakdown` 只存**计数**（按 state 分组）供观察。排水范围**不存 job id 列表**——它由 `effective_at` 实时算出来，避免上万条 id 塞进一个 jsonb：

```
drain_range = jobs.created_at < drain.effective_at
              AND jobs.kind NOT IN ('media.render','media.upload')

活跃(job)   = cancel_requested_at IS NULL
              AND (state IN ('queued','retry_wait')
                   OR (state = 'running' AND lease_until > now()))
```

`cancel_requested_at IS NULL` 这一条是硬截止的收尾：硬截止会给排水范围内的**所有**活跃行（含 `running`）置 `cancel_requested_at`，这样它们之后被 `ReclaimExpiredRows` 回收成 `retry_wait` 时也不会重新变成活跃——否则"租约过期 → 回收成 retry_wait → 店铺永远不能挂起"会形成死循环。

配对方式：`drain_done` 的 `breakdown` 存 `{"drain_event_id": <id>}`，查询"最近一条未配对的 `drain`"就是 `NOT EXISTS (SELECT 1 FROM subscription_events d WHERE d.kind='drain_done' AND (d.breakdown->>'drain_event_id')::bigint = e.id)`。续费后再次到期时，新一轮 `effective_at` 是新的 `term_end`，上一轮已终结的 job 不会误算。

**上界只需 `created_at < effective_at`**：上一轮 `drain_done` 时所有 `queued` / `retry_wait` 已被取消，剩下的 `running` 行租约到期后即使被重新领取，也会被步骤 6 的 `store_writable` 挡在领取前——店铺此时已挂起。不需要把 job id 列表存下来。

- 排除 `media.render` / `media.upload`：这两类 kind 的租约过期后**不会**被回收（[`contract.go:207`](../../internal/queue/domain/contract.go:207)、[`kernel.go:239`](../../internal/queue/repo/kernel.go:239)），浏览器崩溃后会永久停在 `running`。纳入排水会让工作区永远无法结算。
- `running` 必须带 `lease_until > now()`：租约已过期的 `running` 行是"死行"，队列不会主动回收它（除上述两类外的 kind 要等 `ReclaimExpiredRows` 的下一轮，且 listing 类有 900 秒退避），把它算作活跃会让排水卡住。
- 排除 `uncertain`：结果是"不知道有没有写出去"，不会再发起新调用，不构成在途。
- **`jobs` 新增 `store_id uuid NULL` 与 `member_id bigint NULL`**，在 `EnqueueOn` 写入。`store_id` 为 NULL 的任务（如 `delegate.posting_sync`）不阻塞任何店铺。

**挂起判定**：

```
suspend(store)  = rn > store_limit  AND NOT EXISTS (活跃 job ∈ drain_range AND jobs.store_id = store.id)
suspend(member) = rn > seat_limit   AND NOT EXISTS (活跃 job ∈ drain_range AND jobs.member_id = member.id)
```

`drain_range` 与 `活跃` 的每次求值都用当前时刻，不能读快照里的旧状态；否则任务跑完后店铺永远不会被挂起。实现上用一条带 `store_id` 的 `EXISTS` 子查询。

**硬截止**：`term_end + 24h`。到达时分两步做，缺一不可：

```
UPDATE jobs SET state='cancelled', cancel_requested_at=now()
 WHERE 在 drain_range 内 AND state IN ('queued','retry_wait') AND cancel_requested_at IS NULL;

UPDATE jobs SET cancel_requested_at=now()          -- 只打标记，不改 state
 WHERE 在 drain_range 内 AND state='running' AND cancel_requested_at IS NULL;
```

第二步不能省：`running` 行在租约过期后被 `ReclaimExpiredRows` 改成 `retry_wait` 时，`applyLease`（[`kernel.go:911`](../../internal/queue/repo/kernel.go:911)）**不检查** `cancel_requested_at`，只按 `state='running'` 这个栅栏写回。不预先打标记，这条行会在硬截止之后重新进入活跃集合。打了标记后，"活跃"里的 `cancel_requested_at IS NULL` 把它永久排除；执行器即使跑完当前这一次也不会再被领取。

之后写 `drain_done` 事件，排水完成。剩下的 `running` 行全部带着标记，租约过期后不会被重新领取，也不会再阻塞挂起。

**注意：`cancel_requested_at` 只阻止**新领取**。** `lockDueJobs` 用它过滤 `queued` / `retry_wait`（[`kernel.go:793`](../../internal/queue/repo/kernel.go:793)），但**不中断已经在跑的 job**。因此硬截止的实际语义是"不再领取剩余的重试"，正在执行的那一次会自然结束。这是可接受的：单次执行有租约上限，不会无限跑。

硬截止与领取之间有一个很窄的竞态：worker 在标记写入前已经选中该行。`lockDueJobs` 用 `FOR UPDATE SKIP LOCKED`（[`kernel.go:789`](../../internal/queue/repo/kernel.go:789)）锁行，硬截止的 UPDATE 会等它提交后再看 `cancel_requested_at IS NULL` 这个条件；若 worker 已把行改成 `running`，第一条 UPDATE 的 `state IN ('queued','retry_wait')` 就不匹配，第二条会补上标记。硬截止因此必须先做完这两条 UPDATE、再写 `drain_done`。

**为什么必须有这个机制**：`retry_wait` 的退避上限是 900 秒（listing）和 1800 秒（product_sync / delegate），且 `ReasonAdmissionUnavailable` 会撤回 attempt 导致无限重试（[`contract.go:177`](../../internal/queue/domain/contract.go:177)）。"任务必然有限时间结束"在没有硬截止时并不成立。

### 新活拦截

到期后以下入口返回 `402 SUBSCRIPTION_EXPIRED`，响应体带续费报价：

| 入口 | 位置 |
| --- | --- |
| 上架提交与入队 | `POST /api/listing/submit`（含 `row_ids` 批量提交） |
| 浏览器取凭据 | `POST /api/listing/browser/grant`、`POST /api/listing/browser/report` |
| 店铺绑定 / 新建 | `POST /api/workspaces/stores` 等 |
| 成员邀请 | 工作区成员写操作 |
| 店铺信息刷新 | `POST /api/workspaces/stores/{uuid}/seller-info` |
| 周期扫描 | `EnqueueDueProductSync`、`EnqueueDelegateSync` 的候选 SQL |
| 执行器 | worker 领取任务前 |

**不放在全局 `Enqueue`**：周期扫描与被遗忘的调用方会因此静默失败；拦截必须落在用户入口和扫描候选查询上。

### 店铺准入收敛（本版新增）

现在至少有四条独立的店铺准入实现，只有一条查 `quota_suspended`：

| 路径 | 现状 | 处理 |
| --- | --- | --- |
| `internal/seller/repo/upstream_admit.go:41` | 查 `quota_suspended` | 保留，改为调用统一谓词 |
| `internal/ops/repo/admit.go:15` | 只在成员 join 里查 | 补店铺维度 |
| `internal/shipping/repo/credential.go:36` | 只查 `deleted_at_ms` 与密钥过期 | 补 `quota_suspended` |
| `internal/store/repo/company.go:236` | 同上 | 补 `quota_suspended` |
| worker `listing.submit` | 完全不查 | 领取时补检查 |

新增单一谓词 `store_writable(org_id, store_id)`，以上五处全部调用它。否则到期后仍有多条路径能解封卖家密钥并调用 Ozon。

### 读路径（本版修正）

第 1 版说"只拦操作、不拦读"，但现码把 `quota_suspended` 用在身份解析与读列表上：`ResolveAccount` 的 active_workspace 过滤、`ListWorkspaces`、MCP、catalog 读、listing 读都排除被挂起的成员。到期后成员会看不到工作区，也就点不到续费入口。

需要拆成两个谓词：

- `member_can_operate`：`status='active' AND NOT manual_disabled AND NOT quota_suspended`，用于写操作准入。
- `member_visible`：`status='active' AND NOT manual_disabled`，用于列表、会话、账单页、导出。

## 数据模型

### `subscriptions`

```sql
CREATE TABLE subscriptions (
  org_id          bigint PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('free','active','expired')),
  plan_key        text NOT NULL REFERENCES plans(key),
  term_start      timestamptz,
  term_end        timestamptz,
  extra_stores    int  NOT NULL DEFAULT 0 CHECK (extra_stores  >= 0),
  extra_members   int  NOT NULL DEFAULT 0 CHECK (extra_members >= 0),
  next_plan_key     text REFERENCES plans(key),
  next_extra_stores int NOT NULL DEFAULT 0 CHECK (next_extra_stores  >= 0),
  next_extra_members int NOT NULL DEFAULT 0 CHECK (next_extra_members >= 0),
  next_keep_store_ids   uuid[] NOT NULL DEFAULT '{}',
  next_keep_member_ids  bigint[] NOT NULL DEFAULT '{}',
  revision        bigint NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL,
  CONSTRAINT subscriptions_term_shape CHECK (
      (status = 'free'    AND term_end IS NULL     AND term_start IS NULL)
   OR (status = 'active'  AND term_end IS NOT NULL AND term_start IS NOT NULL)
   OR (status = 'expired' AND term_end IS NOT NULL AND term_start IS NOT NULL)),
  CONSTRAINT subscriptions_term_order CHECK (term_end IS NULL OR term_end > term_start),
  CONSTRAINT subscriptions_plan_not_free CHECK (status = 'free' OR plan_key <> 'free')
);
```

- `status` 显式存储，消除第 1 版"从 `term_end` 推导"的歧义。
- 三条 CHECK 一起用：`free` 必须没有账期；`active` / `expired` 必须两者都有且有序；付费状态不能挂 `free` 档。第 1 版的两条 CHECK 允许"free 但带未来 term_end"，那是不可达状态。
- `next_*` 承载预约降级与保留名单；`next_plan_key` 为空表示不降级。它只在续费履约时被消费，其余时间只是用户意图。
- 预约的容量必须能容纳保留名单：`plans.max_stores(next_plan_key) + next_extra_stores ≥ cardinality(next_keep_store_ids)`，成员同理。DB 无法用 CHECK 表达（要读 plans），在写入前校验。
- `revision` 只由写订阅的路径递增；报价 CAS 用它，与 `organizations.quota_revision` 无关。

### `subscription_quotes`（本版新增）

第 1 版没有报价表，导致"TTL 15 分钟"和"订单快照"无法落地，跨零点重新计价会差几十元。

```sql
CREATE TABLE subscription_quotes (
  id            uuid PRIMARY KEY,
  org_id        bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  revision      bigint NOT NULL,
  action        text NOT NULL CHECK (action IN ('subscribe','renew','change')),
  months        int  NOT NULL CHECK (months IN (1,3,6,12)),
  term_start    timestamptz,
  term_end      timestamptz,
  plan_key      text NOT NULL REFERENCES plans(key),  -- change: 目标档；renew: 续费后档位
  extra_stores  int  NOT NULL,
  extra_members int  NOT NULL,
  keep_store_ids  uuid[] NOT NULL DEFAULT '{}',
  keep_member_ids bigint[] NOT NULL DEFAULT '{}',
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  breakdown     jsonb NOT NULL,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL
);
CREATE INDEX subscription_quotes_org_idx ON subscription_quotes (org_id, created_at DESC);
```

下单只接受 `quote_id`，服务端在同一事务内锁 quote 并校验 `expires_at > now()`、`consumed_at IS NULL`、`subscriptions.revision = quote.revision`，然后 `UPDATE ... SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`（CAS，两笔并发下单只有一个成功）。客户端不传金额。

报价过期与订阅变化都**在创建订单时**拒绝（`QUOTE_EXPIRED` / `QUOTE_STALE`），用户还没付钱，重报即可。钱一旦到账，履约不允许再因为这两条失败——见 §履约。

### `subscription_events`

```sql
CREATE TABLE subscription_events (
  id bigserial PRIMARY KEY,
  org_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id bigint REFERENCES payment_orders(id),
  kind text NOT NULL CHECK (kind IN (
    'subscribe','renew','change','schedule','expire','drain','drain_done','redeem')),
  effective_at timestamptz NOT NULL,
  plan_from text, plan_to text,
  stores_delta int NOT NULL DEFAULT 0,
  members_delta int NOT NULL DEFAULT 0,
  term_start timestamptz, term_end timestamptz,
  amount_cents bigint NOT NULL DEFAULT 0,
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX subscription_events_order_uidx
  ON subscription_events (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX subscription_events_org_idx ON subscription_events (org_id, effective_at DESC);
```

`order_id` 唯一索引是幂等的最后一道：任何重放路径都不能把 `term_end` 推两次。

### `payment_orders` 改动

新增：`subscription_snapshot jsonb`、`payment_deadline_at timestamptz`、`fulfillment_failed_at timestamptz`、`reconciliation_reason text`。

**不新增状态值**：`payment_orders_status_check` 是 `('pending','paid','canceled')`（[`00046:24`](../../db/migrations/00046_payment_orders.sql:24)），扩状态会波及所有按状态分支的既有代码。需要人工介入的订单写 `reconciliation_reason`（`amount_mismatch` / `fulfilled_after_cancel` / `term_shortened`），状态仍停在 `pending` 或 `canceled`，由告警消费。

必须重建的约束（第 1 版漏列，照原样实施会让订阅单插不进去）：

| 约束 | 现状 | 新形态 |
| --- | --- | --- |
| `payment_orders_product_known` | `('member_seats','wallet_topup','platform_goods')` | `('subscription','wallet_topup','platform_goods','member_seats')`。**必须保留 `member_seats`**：CHECK 校验全表，历史订单仍带该值；新行由 `product_shape` 挡住 |
| `payment_orders_product_shape` | 三个分支 | 增加 `subscription` 分支：`subscription_snapshot IS NOT NULL AND member_seats IS NULL AND topup_microfen IS NULL` |
| `payment_orders_months_check` | `months >= 1`，`months NOT NULL` | 订阅单写 `months`（1/3/6/12），保留约束 |
| `payment_orders_credit_shape` | `credit_cents=0 OR product='member_seats'` | 删除（抵扣机制整条移除；`credit_cents` / `credit_lots` 列一并删除） |
| `payment_orders_purchase_agreement_valid` | 硬编码 `product='member_seats'` | 改为 `product='subscription'` 且**必填** |
| `payment_orders_member_seat_terms` | 只约束 `member_seats` | 删除 |
| `payment_orders_amount_check` | `amount_cents >= 0` | **保留**。容量变更公式已对每项取 `max(0, delta)`，不会产生负数 |
| （未命名）`plan` / `months` 列 | 两者都 `NOT NULL`，`plan → plans(key)` | 不新增列，直接复用：订阅单的 `plan` 写**目标档位**（`renew` 写续费后的档位），`months` 写 1/3/6/12。金额与全部细节仍在 `subscription_snapshot` |

`subscription_snapshot` 与 `purchase_agreement` 一样加不可变触发器。

现有唯一索引是 `(org_id, product) WHERE status='pending' AND product <> 'platform_goods'`（[`00121:116`](../../db/migrations/00121_supply_chain_orders.sql:116)），**不是**第 1 版写的 `(org_id)`。它允许订阅单与钱包充值单并存，正是需要的。

### 订单 reaper（本版新增）

第 1 版说"由现有 reaper 关闭"，但仓库里没有关闭 `payment_orders` 的 reaper：`ReconcilePayments` 只重放钱包充值（[`payments.go:32`](../../internal/billing/repo/payments.go:32)），`ReapReservations` 清的是 `billing_operations`。

新增一个 5 分钟 tick：

```
UPDATE payment_orders SET status='canceled', canceled_at=now()
 WHERE status='pending' AND payment_deadline_at < now()
```

`payment_deadline_at = created_at + 15 分钟`。回调在订单被关闭后到达时，必须走退款或人工对账，**不能静默 commit**（现在是 `status != 'pending'` 直接返回，用户会被扣款且不履约）。

reaper 与回调的竞态用状态 CAS 保证：reaper 只关 `status='pending' AND deadline < now()`；回调只认 `status='pending'`。若渠道已扣款而订单已被关，回调检测到 `status='canceled'` 时写 `reconciliation_reason='fulfilled_after_cancel'` 并告警，不自动退款（退款是外部动作，不能在回调事务里发）。

### `organizations` 改动

新增 `store_limit bigint NOT NULL DEFAULT 1`，迁移内回填。

投影只写这四列，且**只有投影函数能写**：

```
plan            = status = 'active' ? plan_key : 'free'
seat_limit      = plans.seat_limit  + (active ? extra_members : 0)
store_limit     = plans.max_stores  + (active ? extra_stores  : 0)
plan_expires_at = term_end
```

`member_seat_limit_override` / `store_limit_override` 删除。管理端人工覆盖改为写 `subscriptions.extra_*` 并留审计，不再有第二套真相。

**`plans` 的读取必须锁定版本**：`plans` 是可变目录，投影时若 `plans` 行在两次 sweep 之间被改，`seat_limit` 会漂移。投影函数与 `plans` 更新都要经过同一把 advisory lock（`pg_advisory_xact_lock(hashtext('plans-catalog'))`），或接受"目录变更后一轮 sweep 内生效"并在文档写明。

**排水期间的两列口径**：`store_limit` / `seat_limit` 仍写 free 值，`quota_suspended` 的挂起条件再加一层"不在排水集合内"。不能反过来写付费容量——那会让到期后新建的店也拿到容量。

### RLS

`subscriptions`、`subscription_quotes`、`subscription_events` 与 `payment_orders` 同构：`ENABLE + FORCE ROW LEVEL SECURITY`、`tenant_isolation`（`app.current_org_id`）、`worker_claim`。

"一个账号只能有 1 个 free 工作区"需要跨工作区计数，不能靠 `podhub_app` 裸查。改为 `SECURITY DEFINER` 函数 `billing_owned_free_count(user_id)`，属主 `podhub_billing_lookup`，与现有 `billing_owner_paid_orders` 同一模式。

## 履约

唯一入口：

```go
func fulfillSubscription(ctx, tx, order paymentOrder) error
```

回调（`internal/billing/http/handler.go`）与管理端 `PUT /api/admin/orders/{public_id}/confirm` 都调用它。`ConfirmProduct` 增加 `subscription` 分支，否则管理员确认会永远 422。

履约步骤：

1. `pending → paid` 的 CAS（`WHERE status='pending'`）。失败即返回，不重复履约。
2. `SELECT ... FOR UPDATE` 订阅行。**履约阶段不再做 `revision` / `expires_at` 校验**：钱已经到账，任何"报价过期"或"订阅已变化"都不能让订单卡住。`revision` 只在建单时用一次。履约按 `action` 决定落点：
   - `renew`：把 `months` 叠加到**当前** `term_end` 之后（`term_start = term_end`，`term_end = term_start + months`），金额不变。若订单是 `pending` 期间被兑换码或管理员延长过，服务时间顺延而不是覆盖——用户不会少拿到时间。若当前 `term_end` 比报价时的 `term_start` **更早**（订阅被缩短），仍按当前值顺延，同时写 `reconciliation_reason='term_shortened'` 告警，不阻塞履约。
   - `subscribe`：要求 `status IN ('free','expired')`；若期间已变成 `active`（并发或别的订单先到），降级为 `renew` 语义处理，不报错。
   - `change`：把订阅的 `plan_key` / `extra_*` 置为 quote 里的目标值，`term_end` 不变。并发变更被两道闸门挡住：下单时 `(org_id, product) WHERE status='pending'` 唯一索引只允许一张待支付订阅单，且 `revision` 只在履约时递增。若仍出现"目标已等于当前"（例如管理员手工改过），写 `reconciliation_reason='superseded_change'` 告警并按已付费处理，不重复计费。
3. 写 `subscription_events`（`order_id` 唯一）。
4. 更新 `subscriptions`：`status`、`term_start`、`term_end`、`extra_*`、消费 `next_*`、`revision + 1`。
5. 同一事务内立即重投影 `organizations`，不等 sweep。

**竞态与失败**：

| 场景 | 行为 |
| --- | --- |
| 两个回调并发 | `FOR UPDATE` + CAS 串行化，第二个看到 `paid` 直接提交 |
| 回调与 reaper 并发 | 以状态 CAS 为准；reaper 只关 `pending` |
| 回调与管理员确认并发 | 同一 CAS，只有一个成功 |
| 履约抛错 | 整个事务回滚，订单回到 `pending`，事务外写 `fulfillment_failed_at` 并告警 |
| 金额/币种不匹配 | 不履约，写 `reconciliation_reason='amount_mismatch'`，触发退款或人工确认 |
| `renew` 发现当前 `term_end` 早于快照 | 不履约，写 `reconciliation_reason='term_shortened'`，人工处理 |
| 重复重放 | `subscription_events(order_id)` 唯一索引拦截 |

### 投影与并发

第 1 版有两个写入者（30 秒 sweep 与履约时的立即投影）且没有栅栏，会互相覆盖。修正为：

- 所有投影写入走同一个 `ProjectSubscription(tx, orgID)`：`SELECT ... FOR UPDATE` 订阅行 → 重新计算 → 以 `quota_revision` 作 CAS 更新 `organizations`。
- `ProjectSubscription` 必须先锁 `organizations` 行再读订阅，与 `ApplySeats` 等既有写路径的锁序一致；锁序反过来会死锁。
- 履约与排水完成时直接调用它；sweep 只负责发现漂移，不做增量计算。
- sweep 的候选查询按 `term_end` 建索引：`WHERE status='active' AND term_end <= now()` 与 `WHERE status='expired' AND term_end > now()`（漏结算的补账）。
- 排水期间，投影仍写 free 容量，但 `ReconcileStores` / `ReconcileSeats` 的挂起条件加上"不在排水集合内"。这样"到期立刻失效"与"在途任务不被打断"同时成立。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/billing/subscription` | 状态、档位、容量、已用、`term_end`、下次续费金额、预约 |
| POST | `/api/billing/subscription/quote` | `{action, target:{plan_key, extra_stores, extra_members}, months, keep_store_ids, keep_member_ids}`。`target` 是**调整后目标值**，不是增量 |
| POST | `/api/billing/subscription/orders` | `{quote_id}`，不接受金额 |
| POST | `/api/billing/wallet/topups` | 自助充值 |

报价响应：

```json
{"data":{
  "quote_id":"...","expires_at":"...","revision":12,
  "current":{"plan_key":"lite","stores":5,"members":1,"term_end":"..."},
  "target":{"plan_key":"pro","stores":30,"members":5},
  "amount_cents":27419,
  "breakdown":[{"label":"lite→pro，剩余 17/31 天","cents":27419}],
  "next_renewal":{"months":1,"amount_cents":60000}
}}
```

**契约同步**（第 1 版漏掉的）：`api/openapi.yaml` 的 4 个 operation、`internal/app/testdata/routes.txt` 黄金表、`routes_openapi_allowlist.txt` 保持 0 条、`api/codegen/billing.yaml`、前端 `routes.ts`。spec 里已有的 `/api/ai/recharge/orders` 与 `workspace/billing/overview`（Go 未实现）随本次一并删除或由新接口替代。

## 时区

- 月界按 `Asia/Shanghai`。数据库里 `date_trunc('month', ts AT TIME ZONE 'Asia/Shanghai')`，相关函数标 `STABLE`。
- 镜像若不是 scratch/distroless，确认 `/usr/share/zoneinfo` 存在；否则入口 `import _ "time/tzdata"`。
- 需要改的 UTC 分月点共 7 处：`internal/telemetry/domain/usage.go:62,105,118`、`internal/app/api/reads.go:160`、`internal/app/api/query.go:193`、`internal/admin/users/repo/users.go:53,171`（第 1 版漏了最后两处，它们会让管理端统计与新 `billing_period` 错位）。
- `internal/telemetry/domain/accept_test.go:20` 的 UTC 断言同步改。

## 通知

新增 kind：`subscription_expiring`、`subscription_expired`、`subscription_renewed`、`subscription_drained`。

- `ck_notifications_kind` 需扩展（[`00337:10`](../../db/migrations/00337_store_rating_notification.sql:10)）。
- 通知表没有去重键，7/3/1 天提醒会重复。新增 `notification_dedupe(user_id, kind, dedupe_key)` 唯一索引，`dedupe_key` 用 `org_id:term_end`。
- 收件人是工作区 owner；组织有多个 owner 时全部发送。
- 提醒任务放在单一 River periodic 上，并设 `UniqueOpts`；现有多进程各自注册 periodic，不设唯一性会重复。

## 旧机制处理

| 机制 | 处理 | 连带改动 |
| --- | --- | --- |
| `member_seat_lots` | 删表 | fingerprint、`security_cutover_test.go`、`order_confirm_credit_test.go` |
| `member_seat_lot_credits` | 删表 | 同上 |
| `credit_cents` / `credit_lots` / `renews_lot_id` | 删列 | `confirm_credit.go` 整段删除 |
| `member_seat_limit_override` / `store_limit_override` | 删列 | `admin/users/repo/seats.go`、`ops/repo/console.go:29`、`confirm_credit.go:473`、OpenAPI、`plans-screen.tsx` |
| `tierKey` / `tierRank` 副本 | 收敛成一个 `Plan` 枚举 | `billing/repo/seats.go:22`、`confirm_credit.go:364`、`redeem_rules.go:86`、`order_machine.go:53` |
| `StoreQuotaFor` 的"每席位 5 店" | 删 | `admin/users/repo/seats.go:390` |
| `ApplySeats` 直接写投影 | 改为写订阅 + 调 `ProjectSubscription` | `admin/users/repo/seats.go:204` |
| `AdminConfirm` 的 settleSeats / settleCredit | 删除，统一走 `fulfillSubscription` | `plans_orders.go:283`、`confirm_credit.go` |
| 兑换码按席位 | 改为"赠送 N 个月"：`redeem_codes.product` 增加 `subscription_months`，`tier` 直接复用为赠送档位（不再限定 `pro/max/ultra`，改为引用 `plans(key)`），`duration_days` 保留并换算 `months = floor(days / 30)`（1..12） | `admin/domain/redeem_rules.go:38`（档位白名单）、`billing/repo/redeem.go:136` 的 `grantSeats`、`00138` 的 `redeem_codes_product_shape` |
| `plans.ultra` | 删除行 | fingerprint `row_count` 从 5 改 4 |
| `maxOwnedWorkspaces = 3` | 换成 free 数量判定 | 仅 `seats.go:407` 实际生效，注册路径不检查 |

**测试资产**（第 1 版完全没提）：`tests/integration/testdata/expected-head-fingerprint.json`、`tests/testkit/fingerprint.go` 的 `postRustColumns` / `intentionalRLSPolicies` / `sameConstraintDef` 白名单，必须与每个 schema 变更同批更新，否则 CI 直接失败。

**迁移规则**：新文件从 `00350` 起（00344–00349 已被订阅方案占用），只追加，Down 是 `SELECT 1`，同步 `db/migrations.sha256`。`plans` 用新迁移 UPDATE，不修改已有文件。**目录更新（删 `ultra`）必须排在投影回填之前**，否则回填会把 `ultra` 工作区写成 `active + plan_key='ultra'`，随后删行时撞外键。

## 实施顺序

第 1 版的顺序有两个致命倒置：删除旧机制放最后（中间态过不了 CI）、支付渠道拉起放第 6 步（第 4 步的回调无法端到端验收）。

| 步骤 | 内容 | 验收 |
| --- | --- | --- |
| 1 | **金额核心**：`billing/domain/period.go`（`MonthStart`、`NextMonthStart`、`Prorate`、`Quote`），有理数累加、一次舍入 | `TestProrate`：大小月、闰年、1 日/31 日、3/6/12 月、跨年、23:59 下单、批量加购 |
| 2 | **目录与容量**：`plans` 四行（删 ultra、free=1/1）、`organizations.store_limit`、删两套旧上限、S3 改读套餐、删 `tierKey` 默认 lite | `TestFreeCannotAddCapacity`、`TestPlanCatalog` |
| 3 | **订阅表 + 投影 + 状态机**：`subscriptions`、`subscription_events`、`ProjectSubscription`、30 秒 sweep 替换 `SweepEntitlements` | `TestProjectionMatchesSubscription` |
| 4 | **报价与订单**：`subscription_quotes`（含 `months` / `keep_*` 列）、quote/orders 接口、下单事务内 CAS 消费 quote、`payment_deadline_at`、订单 reaper、渠道拉起 | `TestQuoteThenOrderAmountMatches`、`TestQuoteConsumedAtOrder`、`TestPendingOrderReaped` |
| 5 | **履约唯一入口**：`fulfillSubscription`（不校验 revision / expires_at）、回调接入、admin confirm 收敛、`reconciliation_reason` | `TestFulfillIdempotent`、`TestFulfillAfterQuoteExpired`、`TestAdminConfirmAndWebhookRace` |
| 6 | **排水与拦截**：`jobs.store_id/member_id`、`drain` 事件、挂起加 `NOT draining`、硬截止两条 UPDATE（含 `running` 打标）、用户入口拦截、准入收敛、worker 检查 | `TestExpiryKeepsDrainingJobs`、`TestMediaJobDoesNotBlockDrain`、`TestHardDeadlineCancelsRetryWait`、`TestWorkerStopsAfterSuspend` |
| 7 | **容量变更与预约**：change/schedule、续费消费 `next_*` | `TestUpgradeKeepsExtras`、`TestRenewalChargesExtras`、`TestPendingConsumedOnRenew` |
| 8 | **事务外前置**：实现 `POST /api/workspaces`、注册 bootstrap 改 free、建订阅行 | `TestOneFreeWorkspacePerAccount` |
| 9 | **自助充值**：`POST /api/billing/wallet/topups` | free 可充值并用 AI |
| 10 | **通知**：4 个 kind、约束、去重键、periodic | 到期前 7/3/1 天各一条 |
| 11 | **清理**：删表删列、删旧代码、同步 fingerprint 与契约 | 全库无 `member_seat_lots`；CI 全绿 |

步骤 2 与 3 必须同批：只改目录不删 `tierKey(0)='lite'`，过期工作区会拿到 lite 的付费容量。

## 验收测试

1. `TestProrate` — 折算核心，含整月、零头、批量、23:59。
2. `TestAddOnDoesNotMoveTerm` — 加店、加人、升级都不写 `term_end`。
3. `TestRenewalChargesExtras` — lite + 2 店续 3 个月 = ¥420。
4. `TestUpgradeKeepsExtras` — lite + 25 店升级 pro 只收 `500 × 剩余比例`，加购保留。
5. `TestExpiryKeepsDrainingJobs` — 到期时 `queued` 与 `running` 混合，全部跑完，其余店铺挂起。
6. `TestMediaJobDoesNotBlockDrain` — 一个卡在 `running` 的 `media.render` 不阻止结算。
7. `TestDrainHardDeadline` — `term_end + 24h` 强制收尾。
8. `TestWorkerStopsAfterSuspend` — 挂起后 worker 不再调 Ozon。
9. `TestOneFreeWorkspacePerAccount` — 第 2 个 free 被拒；升级后可再建；过期未续费仍占名额。
10. `TestQuoteThenOrderAmountMatches` — 跨零点报价与扣款一致。
11. `TestFulfillIdempotent` — 双回调、重放、admin 并发只履约一次。

## 已定与待定

**已定（用户确认）：**

- free 永久免费，1 店 1 人，不可加购；free 可充值使用 AI。
- 套餐购买与加购都按自然月折算，同一个 `Prorate`。
- 3/6/12 个月不打折。
- 宽限 0 天。
- 到期前入队的任务全部跑完。
- 付费工作空间不限数量；同一账号同一时刻只能有 1 个 free。
- 所有月界按 `Asia/Shanghai`。

**待定：**

1. 到期后是否允许在 free 容量内继续新建任务（O7）。
2. 12 个月预付期间能否立即减容（O8）。
3. 兑换码赠送的月份是否可叠加在已有账期上（O9）。
4. **钱包归属**：`user_wallets` 按所有者用户记账，同一 owner 的多个付费工作区共享余额。这是现状，且与"付费工作区不限数量"叠加后更明显。建议保留并写进产品说明；若要改成按工作区，`HoldTx` / `SettleTx` / `wallet_ledger` 都要改主键。
