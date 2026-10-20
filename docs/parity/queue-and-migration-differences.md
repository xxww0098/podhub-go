# River、goose 与 Rust 的差异

用户已决定按原方案使用 River 和 goose，并接受实现差异。同样的输入仍必须得到同样的输出、状态和数据。本文逐项写明差异、结果为什么不变、对应测试。测试在 `internal/queue/contract_test.go`（纯函数，任何环境都跑）和 `tests/integration/consistency_test.go`（testcontainers-go）。没有 Docker 套接字时集成测试跳过；GitHub Actions 的 `ubuntu-latest` 有 Docker，CI 的 `go test ./...` 会执行它们。

来源提交：`xxww0098/podhub` `a03d735`。下面凡是写了文件的，都是本仓库重新打开过的源码。

## 迁移：goose 怎么跟上声明顺序

Rust 的顺序是 `migration/src/migrator.rs` 里 `Migrator::migrations()` 的声明顺序，共 291 步。已记录的元数据必须是这份列表的前缀。goose 按文件名里的版本号排序，同号直接报错。

第 280 步 `BannedTags` 的戳是 `m20261014_000055`，第 281 步 `StoreProductVariantFacts` 是 `m20261014_000054`，第 282 步 `SellerResourceOccupancies` 又是 `m20261014_000055`。按戳排序会把第 281 步排到第 280 步前面，并且第 280 与第 282 步版本号冲突。

处理：不把 Rust 戳当作 goose 版本。goose 版本写成声明序号（第 280 步就是版本 280）。SQL 从对应 SeaORM 迁移原样抄入，包括 `CREATE FUNCTION` / `CREATE TRIGGER` 和角色授权。最终 schema 与 `tests/integration/testdata/expected-head-fingerprint.json` 逐表、逐列、逐约束一致。指纹不含函数体、触发器体和角色授权，这三项靠数据库测试另证，不能靠指纹蒙过。

中间版本号和 `seaql_migrations` 的记录方式可以不同。不变的是按声明顺序执行之后的 schema，以及这些函数、触发器的正文。

| 项 | 差异 | 为什么结果不变 | 测试 |
| --- | --- | --- | --- |
| 排序 | goose 升序版本号；Rust 是声明顺序 | 重编号之后 goose 的升序就是声明顺序 | `TestDeclarationOrderIsNotVersionOrder`；`TestResultConsistency/goose_declaration_order` 在两个库里分别按版本号和按 280/281/282 重编号执行，断言前者得到 facts→banned，后者得到 banned→facts→occupancy |
| 重复戳 | 第 280 与第 282 步同为 `000055` | 重编号后版本唯一，goose 不会拒收，也不会合并两步 | 同一测试把两个版本 55 的文件交给 goose，断言报 `duplicate migration version 55` |
| 现有链 | goose 版本是声明序号 1..291，不是 Rust 戳。292 是追加的授权迁移，293 是追加的 new-api 日志表，294 是追加的账单与平台订单 RLS，300 是追加的错误摘要表，315 追加浏览器发放时间戳，00325–00329 追加仓库表，330 与 331 追加 `organization_stores` 的公司名和卖家信息列，332 只回填 `name_source`，00335–00337 追加店铺评级表并给通知 kind 增加 `store_rating_worsened`，都不是 Rust 声明步 | 空库按 1..291 执行后，132 张业务表的列、约束、索引与指纹一致。292 只 `GRANT`。293 新增 `ai_billing_ratio_documents` 与 `ai_consume_logs`，不改已有表。294 只在已有表上 `ENABLE`/`FORCE` RLS 并增加点名策略，不改列、索引、约束。300 新增 `error_digest` 与 `prune_aged_inbox`。00325–00329 新增仓库缓存、配送方式缓存、同步时间、写意图和行锁围栏五张表，不改已有表，表名在 `postRustTables`。330 与 331 只在 `organization_stores` 末尾追加列、一个索引和 CHECK，登记在 `postRustColumns`、`postRustIndexes`、`postRustConstraints`，不改指纹里已有的列。332 不改 schema。00335–00337 的三张评级表在 `postRustTables`，00337 的通知 kind 在 `sameConstraintDef` 里去掉后再比 | `TestResultConsistency/schema_diff` 对比 `tests/integration/testdata/expected-head-fingerprint.json`。少一张、任一列或策略表达式不同即失败。293 与 300 的表在 `postRustTables` 里排除。294 的策略名在 `intentionalRLSPolicies` 里跳过，其它策略仍逐条比较。授权不在指纹里，`TestReconcileGaps` 用 `has_table_privilege` 核对 292。293 的 RLS 在 `tests/integration/newapi_billing_logs_test.go`。详见 `docs/parity/security-hardening.md` 与 `docs/parity/error-digest-parity.md` |
| 函数与触发器 | 指纹没有正文 | 正文留在 goose 文件里，goose 用 `StatementBegin` 整段送出，不按分号切开 `$$` | `TestResultConsistency/function_and_trigger_bodies` 断言 35 个非扩展、非 River 函数（含 00300 的 `prune_aged_inbox`）的 `prosrc` 能在迁移原文里找到。00294 的 7 个账单函数在 `intentionalFunctions` 里另计，正文同样必须出现在迁移原文里。25 个非内部触发器的名字都出现在原文里 |

00320 追加 `ozon_error_catalog`、`ozon_error_observation`、`ozon_error_sighting`。没有新函数，也没有改 00001–00315。非扩展函数仍是 35。这三张表登记在 `postRustTables`，不进入既有指纹表的列比较。仓库读失败和写操作报回调用这份目录的 `RecordRows`，来源是 `ozon_request`，不改 00320 的表。00340 只给 `podhub_login_api` 补 `podhub_ozon_catalog` 的 `SET` 授权。00341 追加 `podhub_ozon_sample_prune` 和只更新 `sample_description` 的策略，没有新函数。非扩展函数仍是 35。

00331 在 `organization_stores` 末尾再追加币种、国家、订阅、同步时间和密钥健康列，以及两个 CHECK。`company.inn`、`company.ogrn`、`company.tax_system`、`company.ownership_form` 和 `ratings` 不是列。登记在 `postRustColumns` 与 `postRustConstraints`。没有新函数。

00332 只把当时已有非空店名的 `name_source` 从 `auto` 改成 `manual`。不新增列、索引、约束或函数，指纹对照不需要新的排除项。

00330–00332、00335–00337、00340–00341 是三组合入顺序和版本号不一致的迁移。一种已迁移库停在 00337：有评级，没有店铺名文件，也还没有 00340–00341。另一种停在 00341：错误目录分支已经执行 00340–00341，并且当时已经有 00325–00329，但没有 00330–00332 和 00335–00337。goose 默认拒绝这两种库。`internal/platform/db/migrate.go` 的 `gooseUp` 只在 `UpContext` 传入 `goose.WithAllowMissing()`，先按版本升序补缺号，再执行比已记录最大值更高的文件。Down 和其他 goose 命令不带这个选项。空库没有缺号，执行顺序不变，`expected-head-fingerprint.json` 不因此改变。风险：该选项会补跑任何一个被漏记的更低版本，不是只放过这三组；迁移 SQL 若不能重入，补跑会以 SQL 错误失败。`TestMigrationVersionsUnique` 拒绝重复编号。`TestMigrationGuard` 用 `db/migrations.sha256` 钉住这些已合入文件的字节。基线最大号是这份清单里的最大版本 00341；已经列在清单里的更小编号仍合法，清单外的新文件必须大于 00341，再把 sha256 补进清单。编号不要求连续。这个测试不调用 goose，也不改补跑用的临时目录。`TestAllowMissingCatchesUpToFreshSchema` 用临时目录分别复现这两种缺号，确认默认 `Up` 报 missing，再走 `db.Migrate`。补跑后的版本集合和库结构指纹与全新库一致；版本行的插入顺序保持各自的历史。

`banned_tags` 的对比包括列序、类型、非空、identity、默认值、四个约束名与定义、RLS 关闭、种子 6 行。约束文本在比较前去掉空白和 `::text`，因为 PostgreSQL 会把 `IN (...)` 打印成 `= ANY (ARRAY[...])`，指纹里已经是这种写法。

### River 运行时授权

`db.Migrate` 先执行 goose，再执行 River 迁移，最后在一个事务内补齐 River 运行时授权。新库和已迁移库都应重新执行这一统一入口；不要只运行 goose CLI。授权可重复执行，角色或对象缺失会报错并回滚授权事务，不会跳过。历史 goose 文件和校验和不变。

项目迁移基线和业务对象使用 `public`，没有自定义 River schema 配置契约。River migrator、运行 client 和授权现在都明确使用 `public`，不依赖连接的 `search_path`；不支持把已有自定义 schema 的 River 数据自动搬迁到 `public`。

三个 `NOINHERIT` 登录身份 `podhub_login_listing_worker`、`podhub_login_ai_media_worker`、`podhub_login_reconciler` 直接获得 `public` schema 的 USAGE、`river_job` / `river_queue` / `river_leader` 的 SELECT / INSERT / UPDATE / DELETE，以及 `river_job_id_seq` 的 USAGE。它们分别覆盖任务插入、领取与完成/清理，队列注册/心跳/清理和 leader 选举/续租/退出。River 直接使用连接池，不能依靠业务事务的 `SET LOCAL ROLE` 或 NOINHERIT 成员关系。

不增加业务表权限、不改变角色属性或 tenant RLS，不授予 TRUNCATE、CREATE、所有权或默认全表权限。API 和 health 登录身份不获得 River 权限；运行身份也不能修改迁移历史。River v0.49.0 的 PostgreSQL 路径不使用 `river_notification`，故不授予它或其序列权限。

运行 client 将 `ReindexerIndexNames` 设为非 nil 的空列表，禁用 River 默认的每日自动 REINDEX。索引检查和必要的重建由有权限的迁移/运维身份负责；不要为此给 worker DDL 权限。任务、队列与 leader 的运行维护仍启用。`TestRuntimeConfigHasNoDDL` 通过 River 自身 `WithDefaults` 验证空列表不会回退到默认索引；`TestRiverRuntimePermissions` 用真实受限登录验证启动、任务完成、删除和停止/重启，以及重复迁移、权限边界、search_path 和授权事务回滚。

## 队列：River 与 `jobs`

River 是 worker 的运行时。业务上看得见的状态、租约、退避和幂等以 `jobs` 的词汇为准，由 `internal/queue` 的契约函数计算。禁止把 `river_job_state` 改名当成 `jobs.state`。`TestRiverStateIsNotRenamed` 与 `TestResultConsistency/river_state_is_not_the_business_state` 锁住这件事。

领取循环在 `internal/queue/kernel.go` 写 `public.jobs`。River 注册 `podhub.noop` 和周期任务 `podhub.error_digest`。后者先把超过 180 天的 Ozon 活样本置空（次数和首末次时间保留），再把上一小时的错误类 inbox 投影写入 `error_digest`。两步都不写 `jobs.state`。同一批输入下，`state`、`attempt`、租约、队首计数和配额行由下面的数据库测试钉住。对拍对象是 goose 里已经抄入的函数和触发器，加上先前与 `lease.rs`、`settlement.rs`、`backoff.rs` 对齐的契约。这次用只读接口打开 `xxww0098/podhub` 的 `a03d735` 返回 404，没有第二台 Rust 进程。

### 1. 表和状态枚举

差异：River 用 `river_job`（`bigserial`、`river_job_state`、`priority` 1..4、没有 `org_id` / `lease_epoch` / `idempotency_key`）。Rust 用 `jobs`（`uuid`、`queued|running|retry_wait|uncertain|succeeded|failed|cancelled`、默认 `priority` 100）。来源：River v0.49 `002_initial_schema.up.sql`；`jobs` 列见盘点 3.3，本项的 priority 默认值来自 enqueue 语句未写 priority 时的表默认（指纹/盘点：`priority smallint=100`）。

结果不变：可观察的优先级、租约代际和幂等键留在业务行上。River 的 `priority` 装不下 100，测试读出 `priority_in_range`（`>= 1 AND <= 4`）并断言业务默认 100 在这个范围之外，因此不能写进那一列冒充结果。River 枚举里没有 `queued`、`retry_wait`、`uncertain`、`succeeded`、`failed`。

测试：`TestResultConsistency/river_state_is_not_the_business_state`。

### 2. `notify_ozon_jobs_wake`

差异：Rust 在 `jobs` 的 `AFTER INSERT` 触发器里 `pg_notify('ozon_jobs_wake', NEW.kind)`。条件是 `state = 'queued'` 且 `payload.executor` 不是 `browser` 或 `http`。`ON CONFLICT` 的重放是 UPDATE，不触发。Requeue 也是 UPDATE，不触发。Worker 把通知当 hint，另外每 750 ms 轮询。来源：`migration/src/jobs_wake_notify.rs`，`jobs/mod.rs` 的 `JOB_WAKE_CHANNEL`。River 在 `state = 'available'` 时通知 `river_insert`，载荷是队列名，不是 kind。

结果不变：业务唤醒继续用这段函数原文，不把 `river_insert` 当作 `ozon_jobs_wake`。750 ms 常量是 `queue/domain.WakePollInterval`。

测试：`TestResultConsistency/wake_notify` 对 goose 链里的 `public.jobs` 触发器做同一件事。同一事务里先插入 browser 再插入 `listing.submit`，`LISTEN` 收到的第一条是 `listing.submit`，没有第二条；随后的 `UPDATE` 也不发通知。

### 3. 队首公平 `account_queue_head`

差异：River 按 `river_job` 的 `priority, scheduled_at, id` 领取，没有 `(user, lane)` 队首，也没有成本配额。Rust 的车道就是 kind。成本是公平货币：`ai.recognize` 和 `media.render` 为 8，`listing.submit` / `listing.submit.batch` 为 4，`media.upload` 和 `listing.reconcile` 为 2，其余为 1。单用户单车道排队成本默认上限 256（`CLOUD_LANE_QUEUED_COST_LIMIT`，夹在 1..1024）。一次 claim 最多看 128 个队首，同一用户在一批里最多 2 条。来源：`jobs/mod.rs` 的 `cost_units_for_kind`、`ACCOUNT_LANE_QUEUED_COST_LIMIT`、`CLAIM_HEAD_LIMIT`、`CLAIM_MAX_PER_USER`。多车道上锁时 `ORDER BY lane`。

结果不变：准入用这些数字，不借用 River 的优先级。249 + 8 被拒绝，248 + 8 被接受。

测试：`TestLaneCostAndClaimCaps`。

计数器对拍的是声明 269 的 `refresh_account_queue_head`，不是已经在第 128 步被删掉的 `refresh_tenant_queue_head`。触发器在 `state`、`cost_units`、`lane`、`submitter_user_id` 变化时重算：`queued` 与 `retry_wait` 计入 `queued_cost`，`running` 计入 `running_cost`，两者都是 0 时删掉队首行。浏览器执行的 `media.render` / `media.upload` 不计入。只改 `updated_at` 不触发。

测试：`TestResultConsistency/queue_head_counters` 在入队、领取、`store_busy` 重排、再次领取、成功落账之后，把 `account_queue_head` 的两列和一条独立 `SUM` 比较。浏览器 `media.render` 不留下队首行。`TestResultConsistency/claim_fairness_and_cap` 里一批 `limit=4` 的领取给两个用户各 2 条；四个并发领取把两边都领完（各 6 条 `running`，`used=6`，没有超出）。129 个有货队首时一次领取正好 128 条，最大的 `user_id` 留在 `queued`，`account_queue_cursor.last_user_id` 停在最后领到的用户，对应的未释放许可是 128。

### 4. `execution_quota` 的加锁顺序

差异：River 领取不锁这两张表。Rust 在写 `jobs` 之前必须先锁 `(user, lane)` 的 `account_queue_head`，再锁 `execution_quota`。颠倒会和「先拿队首、再等配额」的事务死锁（Postgres `40P01`）。来源：`jobs/settlement.rs` `lock_queue_head_then_quota`。实现是 `INSERT ... ON CONFLICT DO UPDATE` 锁住队首行，再调用 `lock_execution_quota`。`media.render` / `media.upload` 在 `ensure_queue_capacities` 里不占队首。

结果不变：契约的锁顺序只有这两步，队首在前。测试在 Postgres 里让一个事务握住队首行，另一个事务按这个顺序去锁；在它堵住时，第三方仍能写入 `execution_quota`。若实现先锁配额，第三方会超时。

测试：`TestLaneCostAndClaimCaps`（顺序名字），`TestResultConsistency/lock_order`（堵住时的锁，用迁移后的 `account_queue_head` 与 `execution_quota`，冲突目标是 `(class, user_id)`）。`TestResultConsistency/claim_lock_order` 让领取循环自己去写：队首行被别人握住时，领取停在 `account_queue_head`，此时第三方仍能锁住 `execution_quota`。

`lock_execution_quota` 不是数据库函数。第 216 步的注释提到它，库里没有这个 `prosrc`。Go 的 `lockQuota` 按 `try_grant_execution_permit` 的建议锁顺序做：有限全局行存在时先 `pg_advisory_xact_lock(hashtextextended('eq-live:' || class, 0))`（`ai_ocr` 且 `hard_limit = 0` 时跳过），再锁 `eq-user:class:user`，再 `INSERT ... ON CONFLICT` 锁配额行。这样同事务里随后调用的 `try_grant_execution_permit` 不会和自己把顺序倒过来。

配额函数体对拍：`TestResultConsistency/quota_functions` 直接调用 `register_execution_demand`（`user_id <= 0` 拒绝，并写入 `execution_fairness`）、`try_grant_execution_permit`（非成员为 false；授予后用户行 `used` 加 1；同一 holder 与 epoch 再授予不增加 `used`；`hard_limit` 挡住下一次）、`release_execution_permit`（第一次 true 且 `used` 减 1，第二次 false）、20 个并发授予在 `hard_limit = 3` 时活许可和 `used` 都等于 3 且不超过 3，以及 `reap_stale_execution_permits` 释放没有对应 `running` / `uncertain` 任务的 uuid 作业许可。`release_execution_permit` 会把 job 的 `holder_id` 转成 uuid，非 uuid 会报错而不是静默释放。

### 5. 租约过期按 kind 落到 `failed` / `uncertain` / `retry_wait`

差异：River 过期后把任务放回 `retryable` 或 `discarded`，不按 kind 分支。Rust 的 `reclaim_expired_leases`（`jobs/lease.rs`）：

- `media.render` 和 `media.upload`：函数直接返回 0，行保持 `running`。
- 其余 kind 走同一条 `CASE`：`listing.submit` → `failed`；`listing.submit.batch` 且 `payload.intents` 非空 → `failed`；`ai.recognize` / `media.render` / `media.upload` → `uncertain`，保留 `lease_owner` 和 `lease_until`，`last_error_code = attempt_uncertain`；执行者不是 `browser` 且 `attempt >= max_attempts` → `failed`，`last_error_code = max_attempts_exhausted`；否则 → `retry_wait` 并清空租约。
- `listing.submit` 即使次数没用尽也是 `failed`。次数用尽且执行者不是 browser 时，错误码仍是 `max_attempts_exhausted`。
- 回收后调用 `reap_stale_execution_permits(db, 64)`。默认租约 30 秒，心跳约 10 秒，清扫批大小 64。

`media.render` / `media.upload` 出现在 `CASE` 里，但清扫入口在 `CASE` 之前返回。测试把两层分开：入口不改行；`CASE` 单独算会得到 `uncertain`。

结果不变：同一输入，Go 的 `ReclaimExpired` / `LeaseCase` 与把这段 `CASE` 放进 Postgres 算出的 `state`、`last_error_code`、是否清租约相同。

测试：`TestLeaseOutcomesByKind`，`TestResultConsistency/lease_case`。

`release_leases` 在 job 变成 `failed` 时还会改 `submission_intents` 和 `listing_rows`。那一段 SQL 读过，还没有最小表对拍。见文末。

### 6. 重试与退避

差异：River 用自己的尝试次数和计划时间。Rust 的 `requeue_delay`（`jobs/backoff.rs`）是纯函数：提交类 base 2 s、cap 900 s；对账 base 5 s、cap 900 s；商品同步和委托同步 base 5 s、cap 1800 s；其余 base 5 s、cap 300 s。限流等待至少 1 秒，只在上面加抖动。其他原因里只有 `SafeToRetry` 按 `base · 2^(attempt-1)` 升级（最多 16 档）。非故障等待（`StoreBusy`、`QuotaExhausted`、`RateLimited`、`AdmissionUnavailable`、`LockBusy`）撤回刚计入的 attempt，因此不升级。超过 cap 的显式等待原样使用。抖动由 `(job_id, lease_epoch, attempt)` 的 FNV-1a 经 SplitMix64 得出，区间夹在 250 ms 和 30 s 之间，且不超过核心延迟的一半。

`requeue_job` 的 `UPDATE`：非撤回且 `attempt >= max_attempts` 时状态是 `failed`，否则 `retry_wait`；撤回时 `attempt` 减 1 但不小于 0；`last_error_code` 写成原因；租约清空。`settle_job` 遇到死锁或 `lock_not_available` 时最多试 3 次（`SETTLE_ATTEMPTS`）。

结果不变：同一 kind、attempt、原因、hint 和 seed，延迟的毫秒数与按 `backoff.rs` 独立算出的向量一致。同一 attempt 与撤回标志，Postgres 里的 `UPDATE` 表达式与 `Requeue` 的状态、次数一致。

测试：`TestBackoffMatchesIndependentVectors`，`TestRequeueWithdrawsNonFaultAttempts`，`TestResultConsistency/requeue`。

`Retry-After` 大到装不进 Go 的 `time.Duration`（约 292 年）时，Go 饱和在最大值，Rust 的 `Duration` 可以更大。`TestHugeRetryAfterDoesNotPanic` 只保证不崩溃、不把装得下的等待截短。见文末。

### 7. 幂等

差异：Rust 的唯一键是 `(org_id, kind, idempotency_key)`。冲突时 `ON CONFLICT DO UPDATE SET updated_at = jobs.updated_at`，已有载荷、状态和 id 都不变。来源：`jobs/mod.rs` `enqueue_job`，`jobs/enqueue.rs` `enqueue_jobs`。空批次不发语句。`submitter_user_id <= 0` 拒绝。River 的唯一约束是另一套（kind/args/queue 上的可选唯一索引），没有这个三元组。

结果不变：第二次插入带着新 id 和新 payload 时，返回的仍是第一行的 id 和 payload，表里只有一行。

测试：`TestResultConsistency/idempotency` 用测试表 `parity_jobs` 锁住同一句 `ON CONFLICT`。`TestResultConsistency/jobs_kernel_rows` 在 `public.jobs` 上重放：新 id、新 payload 返回第一行的 id，payload 仍是 `{"n":1}`，表里只有一行。车道已经满时，重放仍返回第一行，不报满。空批次不发语句。`submitter_user_id <= 0` 返回 `ErrSubmitter`。

同一事务里的语句改由 `pgx.Batch` 按原来的顺序送出，少几次往返。队首 `INSERT ... ON CONFLICT` 收成一条多行语句，`VALUES` 顺序仍是 lane、再 user。每把咨询锁仍是单独一条，顺序仍是 class、再 user。每个作业仍是 EXISTS、再 admit、再 `insertJob`（`ON CONFLICT (org_id, kind, idempotency_key)`，`xmax = 0` 区分插入与重放），浏览器且不占队首时再删空队首。同批两个相同幂等键仍是先插入、后冲突，不放进同一条多行 `INSERT`。`jobs_account_queue_head` 在每行 INSERT 之后更新 `queued_cost`，下一条 admit 读到的是这个值。任一步失败整笔事务回滚。`Claim` 的 `FOR UPDATE SKIP LOCKED` 和 `account_queue_cursor` 没有改。

结果不变：返回的 `Queued`（id、payload、state、attempt、epoch、Inserted）以及 `jobs`、`account_queue_head`、`execution_quota` 与逐条执行一致。空批不发语句。整批重放返回第一行。同批重复幂等键在车道已满时仍返回第一行，不报满。第 3 个作业把车道写满时回滚后零残留。浏览器 `media.render` / `media.upload` 不占队首，领取仍跳过它们。

测试：`TestEnqueueBatchMatchesSequential`、`TestEnqueueBatchStatementOrder`、`TestEnqueueBatchClaimStillSkipsBrowser`，并重跑 `TestResultConsistency` 的 `jobs kernel rows`、`claim lock order`。本机 Postgres 16.15、`PODHUB_PARITY_DSN`、`go test -bench=BenchmarkEnqueue -run=^$ -benchtime=1s -count=1 ./internal/queue/repo/`：`BenchmarkEnqueueBatch-4` 201 次、6597197 ns/op；`BenchmarkEnqueueSequential-4` 121 次、9579839 ns/op。32 条 `listing.submit`，事务回滚。

### 8. 领取循环写 `jobs` 行

差异：River 的 `podhub.noop` 不插入 `jobs`。领取循环用上面的契约写业务行：`Enqueue` 插入 `queued`；`Claim` 把到期的 `queued` / `retry_wait` 改成 `running`，`attempt` 加 1，`lease_epoch` 加 1，`lease_until` 为现在加 30 秒；排序是队首内 `priority, run_at, created_at, id`，一批最多 128 个队首、每用户最多 2 条；`executor` 为 `browser` 或 `http` 的行不领；`run_at` 未到不领。许可用 `PermitClass` 调用 `try_grant_execution_permit`，epoch 是领取后的代际。拒绝则行留在 `queued`。续租只推 `lease_until`。过期清扫对 `media.render` / `media.upload` 不改行，其余走 `ReclaimExpired`，然后 `reap_stale_execution_permits(64)`。围栏不匹配的落账或重排更新 0 行，返回 false，不报错。

结果不变：同一批输入后，行上的 `state`、`attempt`、`lease_epoch`、`lease_owner`、`lease_until`、`last_error_code` 与契约函数的结果相同，队首两列与声明 269 的独立求和相同。

测试：`TestResultConsistency/jobs_kernel_rows`。唤醒方面，单独插入浏览器行没有通知；下一批云端行的第一条 `ozon_jobs_wake` 载荷是 `listing.submit`。

### 9. 对账单实例与七个定时扫描

差异：对账进程先拿会话锁 `pg_try_advisory_lock(0x6f7a6f6e5f72636c)`。没拿到就不领取、不扫描，等到进程上下文结束。这把锁跟会话走，不跟客户端的 `Close` 返回走：`Close` 在套接字写完就返回，后端进程退出前锁还可以留着。七个扫描的间隔按盘点 4.4：未知写、未知导入、分组、已接受导入是 5 秒起、空闲加倍到 60 秒、批 16；商品同步和清理是 30 秒起、空闲到 10 分钟；委托同步用 `DELEGATE_SYNC_INTERVAL_MS`（默认 60 秒）且不退避。`OZON_PRODUCT_SYNC_DISABLED` 为真时商品同步扫描不进入 `Active`。这些 tick 不领取任务、不拿执行许可、不拨号 Ozon。`ENQUEUE_BATCH_LIMIT` 的整数没有从 Rust 读到，`ProductSyncBatch` 记为 0，扫描不入队。

测试：`TestScanSchedule`、`TestProductSyncDisabledDropsOnlyThatScan`、`TestScanPanicAndDisableAreIdle`、`TestResultConsistency/reconciler_seat`。座位测试要证明的仍是：持锁连接还活着时第二把会话立刻失败；持锁连接 `Hijack` 后 `Close`，第二把必须拿到锁，任何错误都失败。`Close` 之后最多等 5 秒、每 20 毫秒试一次，用来等后端放开会话锁。断言没有放宽，崩溃前的拒绝也没有加重试。拿到之后仍主动 `pg_advisory_unlock`。

## 店铺评级表（00335–00337）

合并 `d6c0b8f` 之后，00325–00329 是仓库表。评级仍从 00335 追加，不改 00325–00329。00335 新增 `store_rating_snapshots` 与 `store_rating_sync`，00336 新增 `store_rating_history`，00337 只给 `notifications.kind` 增加 `store_rating_worsened`。三张新表不在 Rust 指纹里，列在 `postRustTables`。`ck_notifications_kind` 的定义在 `sameConstraintDef` 里去掉新增 kind 后与指纹相同，其余约束不改。没有新的 PL/pgSQL 函数，也没有新触发器。函数计数仍是 35。

同步由 River 周期任务 `podhub.store_rating_sync` 领取，不写 `jobs.state`。清理是 `podhub.store_rating_prune`。读接口不拿 `FOR UPDATE`。

## 无法证明，交给用户决定

这些点没有用测试把「同一输入、同一结果」钉死。在补上证据之前，不要把它们写成已经等价。

1. `release_leases` 对 `submission_intents` 和 `listing_rows` 的连带更新没有最小表对拍。过期清扫和落账只改 `jobs` 并释放许可。
2. `seaql_migration_steps` 的指纹行数是 79（逐步标记）。这次空库重放不插入这些标记，测试锁的是「指纹 79、重放 0」。列结构仍然对得上。
3. 第 261 步 `DiagnosticV3Privacy` 是带 `$1` 的键集改写，空库上没有 DDL。goose 文件只有 `SELECT 1`。历史行怎么被改写没有重放。
4. `CLOUD_DB_LOGIN_PASSWORD` 未设置时 Rust 也不改登录角色口令。这次同样跳过。设了这个环境变量之后的 `ALTER ROLE ... PASSWORD` 没有对拍。
5. 带 `$1` 的回填（`jobs` 的 command id、listing row identity 等）在空库上是空转，没有重放。已存在历史行时的结果没有证明。
6. 健康检查的字节 golden 来自 a03d735 的 `HealthResponse`（`src/wire/cloud_api.rs`、`src/health.rs`）经 serde_json 的形状，不是一台活着的 Rust 进程。没有把 Rust 指到生产库。
7. 角色授权语句已抄入，指纹不记录 `pg_auth_members`。这次没有逐条比对角色成员。领取循环要 `SET LOCAL ROLE podhub_worker`。测试用的是超级用户 `postgres`。正式登录角色是否拿得到这个成员关系，没有对拍。
8. 超过 `time.Duration` 上限的 `Retry-After` 无法与 Rust `Duration` 逐位相同。
9. `claim.rs` 这次没有逐行打开（仓库 404）。领取顺序按 `jobs_claim_idx` / `jobs_worker_claim_idx` 和盘点写成 `priority, run_at, created_at, id`，并由 `jobs_kernel_rows` 锁住这个顺序。不能把它写成已经逐行核对过 `claim.rs`。
10. `PermitClass` 是推断：`ai.recognize` → `ai_ocr`，`media.upload` → `cloud_upload`，其余 → `all_execution`。`claim.rs` 没有重新打开。
11. `ENQUEUE_BATCH_LIMIT` 的整数值未知。商品同步扫描的批大小记为 0，tick 不入队。
12. 未移植的任务体不是 Rust worker 的提交结果。`Execute` 对写 kind 只走 `ozon.Send`（杀开关开着时 `ErrWritesDisabled`，关着时 `ErrNotPorted`，两种都不拨号）。读和对账探测返回 `ErrWorkNotPorted`，不查杀开关。循环把这三类错误重排成 `admission_unavailable`，撤回 attempt，状态 `retry_wait`。这是为了骨架不留着 `running` 租约、也不把次数烧光。它不是一次真实提交的行。
13. 浏览器 `media.render` / `media.upload` 不占队首计数，但 Go 仍先锁队首再锁配额，然后删掉 0/0 的队首行。Rust 的 `ensure_queue_capacities` 可能对这两类完全不锁队首。先队首后配额不会和「只锁配额」死锁；若有路径先锁配额再要队首，则会。
14. 一次 `Enqueue` 是一个事务。其中一条车道满了，整批回滚。Rust 是否先提交前面的行，没有读到。
15. 一次领取会为最多 128 个用户各拿一把 `eq-user` 建议锁。Postgres 默认 `max_locks_per_transaction = 64` 是平均值，不是单事务硬顶，但共享锁表按它分配。集成测试的容器追加 `-c max_locks_per_transaction=256`，不替换镜像入口。生产库要不要改这个参数，没有从 Rust 部署读到。
16. `CLOUD_LANE_QUEUED_COST_LIMIT`、`DELEGATE_SYNC_INTERVAL_MS` 和三个 in-flight 环境变量的非法值按「空或解析失败用默认、小于 1 用下限或默认、车道上限超过 1024 夹到 1024」处理。这是合理夹取，不是从 Rust 重新逐行读来的。
17. oapi-codegen 是否取代 utoipa，仍未决定。
18. `listing.submit`（单行 kind）是否还有生产入队点，盘点仍标为待核。

身份与租户阶段另有一份清单，见 [identity-parity.md](identity-parity.md)。那份清单不改变上面 1–18。
