# 对账缺口对照（PR-G）

对照提交：Rust `a03d735`（v0.0.112）。本环境克隆 `github.com/xxww0098/podhub` 失败（匿名克隆与凭据改写都是 Repository not found，`gh api` 对该仓库 404）。下面凡是没有打开 Rust 函数体的 SQL、间隔、请求头和信封布局，都标了无法对照，不把自测生成的密文或推断的 SQL 写成 golden。

## 做了什么

1. 对账进程的六个空转扫描接上了 tick。`UnknownImportsScan` 仍是 `seller.Attach` 里的 `submit.ProbeDue`，没有被换掉。单实例座位仍是 `pg_try_advisory_lock(0x6f7a6f6e5f72636c)`，锁在 dedicated 连接上。
2. listing 作业在 worker 返回 nil 之后结算账单：成功且标价大于 0 时，把一条 `external_task_id` 抄进 `result_ref.taskId`，再调用已有的 `ChargeListingSubmit`。失败或取消且操作处于 `reserved` / `outcome_unknown` 时走已有的 `releaseOne`。已结算的不退。还在 `running` 的（发出后崩溃）不记账。
3. API 进程按本地间隔跑这些已有函数：AI `SweepStranded` / `PruneBodies`，权益 `SweepEntitlements`（现在含店铺配额），`ReapReservations`，支付台账回放 `ReconcilePayments`，`event_inbox_events` 与 `client_listing_logs` 的保留删除，类目抓取时刻表 `TickFetch`。slice 清桶仍只在 media-gc 进程，这里不启动，也不删真实桶。
4. 新迁移 `00292_podhub_app_ai_billing_grants.sql` 给 `podhub_app` 和 `podhub_worker` 补了 `ai_requests`、`payment_orders`、`redeem_codes`、`member_seat_lots` 的 `SELECT, INSERT, UPDATE` 以及对应序列的 `USAGE, SELECT`。没有改历史迁移，没有改 PL/pgSQL，没有加新的 RLS 策略。
5. `internal/platform/seal` 按本地 AES-256-GCM 布局开关店铺信封。密钥只从 `config.Load` 读入。测试用测试密钥做往返。没有 `media_accounts` 表。
6. `docs/parity/listing-submit-parity.md` 第 6、13 条改成当前状态：未知导入探测仍不带凭据头；六个扫描已有 tick，未证实的状态转移单独留下。
7. `TestResultConsistency/reconciler_seat` 在持锁连接 `Close` 之后用最多 5 秒、20 毫秒一次的轮询等待会话级 advisory lock 被后端放开，再断言第二个会话拿到座位。断言仍是拿到座位且没有错误。崩溃前第二个会话抢座必须立即失败，这一段没有加重试。

## 和 Rust 的对照测试

Rust 仓库无法克隆，所以没有 Rust 进程、没有从 Rust 源码抄下来的新 golden。

已跑（本环境 Postgres 16，`PODHUB_PARITY_DSN` 指向 127.0.0.1）：

- `go test ./internal/platform/seal/ ./internal/billing/ ./internal/catalog/ ./internal/config/ ./internal/app/scans/ ./tests/archtest/`
- `go test ./tests/integration/ -run 'TestReconcileGaps|TestResultConsistency'`

`TestReconcileGaps` 在回环 Postgres 上核对：写授权、缺 GUC 时 `billing_operations` 不可见且不能插入、成功作业一条 hold 加一条 settle 且 `taskId` 为 `42`、失败作业把 `reserved` 释放到 held 为 0、店铺配额只暂停非手工且未删除的超额店、支付台账 `paid` 把充值单打成 `paid` 并加余额、席位单保持 `pending`、未知写保持 `result_unknown` 且 `reconcile_after` 推后、分组保持 `pending` 并写上租约、过期 pass page 被删、批量为 0 时不入队商品同步、显式 limit 入队一条、代发同一桶只入队一条且取消后订单仍是 `ready`、已接受探测带上 Client-Id 和 Api-Key 并保持 `accepted`、过期 inbox 行被删、类目 tick 写下 `fetch_not_ported` 且不改 `last_status` / `failure_streak`。

信封测试只证明本布局能打开自己封上的 v1 和 v2，以及错误指纹、错误密钥打不开。这不是 Rust golden。

## 流程变化，以及结果为什么不变

- 六个扫描以前固定返回空闲。现在未知写只把 `reconcile_after` 推后 60 秒，不把 `state` 写成 `reconciled` 或 `conflict`。分组只写观察租约，不改 `observation_state`，不拨号。商品同步清理只删 generation 不等于当前 `refresh_generation` 的 staging 页。这些都避免发明没有读到的业务终态。
- 商品同步的生产 tick 在 `ProductSyncBatch == 0` 时立刻空闲，不入队。`ENQUEUE_BATCH_LIMIT` 仍未读到，队列测试锁着这个 0。显式传入正数 limit 的函数才会入队，幂等键是 `due:{storeUUID}:{nextDue}`。
- 代发扫描入队 `delegate.posting_sync`，幂等键 `bucket:{unixMilli/interval}`。认领后 `Finish` 为 `cancelled`，`last_error_code` 为 `not_ported`，不标成功，不改 `delegate_orders`，不拨号。这样未移植的正文不会在认领循环里重试打满。`listing.reconcile` 仍返回 `ErrWorkNotPorted`。
- 已接受扫描只处理 `state = 'accepted'`。命中则清空 `reconcile_after`，状态保持 `accepted`。缺失或读失败只退避。不调用会把 `unknown` 改成 `superseded` 的那几条 stamp SQL。非 loopback 的 Seller 源仍不拨号。
- 账单沿用 `ChargeListingSubmit` / `HoldTx` / `SettleTx` / `ReleaseTx` 已经写下的账本行。worker 原来的 `result_ref` 只有 `outcome`，不抄 `taskId` 的话已有谓词永远不收费。抄入的是已经写在 `submission_intents.external_task_id` 上的十进制文本。标价仍是 `ListingSubmitPriceMicrofen`，不新增第二处读取。标价为 0 时不改 `result_ref`。
- 店铺配额接在已有的 `projectOne` 里，成员席位的 SQL 没有改。暂停规则是纯函数 `PlanStoreSuspension`：手工停用和已删除的店不计数、不改；其余按 `create_order, id`，前 `limit` 家不暂停。`limit` 是 `store_limit_override`，否则是 `plans.max_stores`。
- 支付回放使用和 HTTP `apply` 相同的 `pending → paid` 与 `TopupTx`。没有供应商 HTTP。席位单保持 `pending`，和现有「未履约」一致。
- 两个开关仍只在 `internal/config` 解析一次。凭据材料是另外四个字段，读进去不会翻转开关。新代码没有第二处 `os.Getenv`，也没有 `pgxpool.New`。扫描和账单实现放在 `internal/app` 与各域自己的文件里，worker 只存函数指针。`internal/listing`、`internal/seller`、`internal/queue` 的已有文件没有改。

## 需要用户决定

- 店铺信封的字节布局无法对照。本地约定：KEK 为 32 字节 hex、标准 base64 或原始 32 字节，否则对原始字符串做 SHA-256。v1 明文是 API key，AAD 是 key id，指纹是 API key 的 SHA-256。v2 的 DEK 包装 AAD 是 `dek\x00` 加 key id，载荷明文是 `clientID\x00apiKey`，载荷 AAD 是 key id。请求头用了公开名字 `Client-Id` 和 `Api-Key`，没有对上 Rust。
- `ENQUEUE_BATCH_LIMIT` 未知。生产商品同步 tick 在批量为 0 时空闲。
- 代发扫描在 `Batch` 为 0 时最多入队 16 个组织。清单该格是空的，16 不是 Rust 常数。
- 代发作业被取消而不是去同步订单。取消原因是 `body_not_ported`。
- 未知写用 60 秒租约，不改 `state`。这不是已读到的 Rust 转移。
- 分组用约 2 分钟的观察租约，不改 `observation_state`，不请求 Ozon。
- 已接受扫描永远不离开 `accepted`，也不做 unknown 探测里的 release / supersede。
- 商品同步清理是按 unlogged staging 表推断的，不是 Rust 函数体。
- 类目随机窗口没有读 RNG，钉在 `window_start_minute`。到点只写 `fetch_not_ported`，不改 `last_status` 和 `failure_streak`，不抓取。
- 日志保留固定 14 天，没有读 `CLOUD_LOG_RETENTION_DAYS`。没有 `error_logs` 表。`client_listing_logs` 仍按龄整表删除。`event_inbox_events` 经 `prune_aged_inbox` 删除全部过龄 kind，见 `docs/parity/error-digest-parity.md`。
- 支付台账状态 `paid` / `succeeded` 是本地字符串。回放间隔 15 分钟、预留回收 900 秒、AI 清扫间隔 60 秒都不是从 Rust 读到的。
- 店铺上限：有 `store_limit_override` 用它，否则用套餐 `max_stores`。套餐行缺失时按 0，非手工的店全部暂停。
- `ai_requests`、`payment_orders`、`redeem_codes`、`member_seat_lots` 没有 `tenant_isolation`。写授权之后，`podhub_app` 可以写这些表，但写授权本身不隔离组织。`billing_operations` 原有 RLS 没改：缺 GUC 看不见、不能插入。
- 成功作业的 `result_ref` 会多一个 `taskId`。一个作业记一笔，不按条目记。若 Rust 按条计费，这里不一致。
- 未知导入探测仍不带凭据头。非 loopback 仍拒绝拨号。
- 没有新增 sqlc 单元，扫描和账单用的是手写 SQL。
- 没有 `media_accounts` 表。解密对象是 `store_seller_credentials`，另有一个给 nonce+ciphertext 用的 `OpenBlob`。
- `internal/telemetry/jobs.Run` 仍返回 not_ported，它的测试锁着删除数为 0。API 定时器调用的是 `internal/telemetry.PruneErrorLogs`。两处没有合成一个函数。inbox 删除改走 `prune_aged_inbox`。
