# 提交流水线对照（PR-6）

对照提交：Rust `a03d735`（v0.0.112）。Rust 二进制没有在本环境执行。下面凡是写「逐列」的，期望值都是从该提交的源码和 PL/pgSQL 抄下来的，测试里标了 transcribed。

## 已接上、并且同输入得到同状态的部分

命名边来自 `src/listing/kernel/submission/intent_transition.rs`。`from` 是 SQL `state = ANY(...)`，`to` 是赋值字面量。十一条边：

| 边 | from | to |
| --- | --- | --- |
| Begin | queued | submitting |
| RejectQueued | queued | rejected |
| RejectSubmitting | submitting | rejected |
| RejectBeforeAcceptance | queued, submitting | rejected |
| AcceptSubmitting | submitting | accepted |
| AcceptInFlight | submitting, unknown | accepted |
| AcceptUnknown | unknown | accepted |
| ParkSubmitting | submitting | unknown |
| ParkInFlight | submitting, unknown | unknown |
| CancelBeforeDispatch | queued, submitting | cancelled |
| CancelSubmitting | submitting | cancelled |

`reconciled` / `conflict` / `operator_attested` / `superseded` 不在这张表里。非法边 `Apply` 返回错误，`ApplyStored` 回滚，行数保持 0。表驱动测试在 `internal/listing/submit/intent_test.go`。

一次 `/v3/product/import` 的分类来自 `submit_dispatch/transport.rs` 和 `submit/outcomes.rs`：

- 杀开关在 `Begin` 之前：`RejectQueued`，`OZON_WRITES_DISABLED`，任务 `failed`，不写 `seller_upstream_writes`，请求数 0。
- 连接被拒绝（请求没离开进程）：`RejectQueued`，`OZON_EGRESS_UNREACHABLE`，不落写账。
- 2xx 且 `task_id > 0`：`AcceptInFlight`，任务 `succeeded`，写账 `settled`（状态 + 正文），占用释放原因 `relationship_confirmed`。
- 400/422：`OZON_ROW_REJECTED`。429：`OZON_RATE_LIMITED`。两者都是 `RejectSubmitting`，任务 `failed`，写账 `settled`，占用 `rejected_no_pending`。429 不重新入队。
- 401，以及 403 且供应商 code 16：`OZON_CREDENTIAL_INVALID`。403 且 code 7：`OZON_PERMISSION_DENIED`。其余 403/4xx：`OZON_ACCESS_UNCLASSIFIED`。
- 超时、连接在发出后断开、5xx、408、2xx 但没有正的 task id：`ParkSubmitting`，`OZON_DISPATCH_INTERRUPTED`，任务 `succeeded` 且 outcome `unknown`。没有 HTTP 状态时写账是 `result_unknown`（状态和正文都是空）。
- 发出之后崩溃：请求计 1，结算事务不提交。意图停在 `submitting`，写账停在 `dispatching`。下次认领走 `Recover`，`ParkSubmitting`，错误码 `OZON_SUBMIT_IN_FLIGHT`，不再 POST。

`listing_rows.submission_state` 跟着意图走。`superseded` 把行写成 `none`（行的 CHECK 里没有 `superseded`）。

导入分块 `PlanImportJobs` 按 20 条一块、上限 100。第一块沿用调用方的 job id / batch id / 幂等键，后面的键是 `{batch}:{index}`。三条发送路由在冻结成功后调用它，入队 `listing.submit.batch`。

## 流程上和 Rust 不同、结果保持一致的地方

- 禁用标签闸仍是已合并的那条：只有 `rules_version` + `tags` + `text`、没有 `store_id`/`items` 的正文，命中 400 `banned_tag`，干净则 400 `validation` `请求格式无效`。带 `store_id` 或 `items` 的正文改走草稿入口，先做 `ListingSubmit` 鉴权。
- 进入 `unknown` 时 `reconcile_after` 用数据库时钟加 30 秒（`import_reconcile` 的首次等待），不用进程时钟。探测退避仍是数据库时钟。
- `external_task_id` 存十进制文本，和列类型 `text` 一致。
- 草稿入队把意图和 `listing.submit.batch` 作业放进同一个事务（`EnqueueOn`）。Rust 也是一次提交。中途失败则两边都不出现。
- 每个冻结行的「`INSERT ... ON CONFLICT DO NOTHING RETURNING`；若无行则按 `(org_id, store_id, client_operation_id)` 读回」放进同一个 `pgx.Batch`，语句顺序等于切片顺序。同批相同 `client_operation_id` 仍是第一条创建、后面重放。冲突读回紧跟对应的 INSERT。只有 `outcome=created` 入队。作业 payload、`IdempotencyKey`、`PlanImportJobs` 分批、`batchClientOperationID` 的哈希输入不变。进入 `EnqueueOn` 之前仍是 `podhub_worker`，之后仍 `EnterApp`。成功插入会多一次只读回读，结果丢弃。`DraftItem` 的 outcome、intent.id、state 与逐行执行一致；已有行的 `updatedAtMs` 与种子行一致，本批新建行的 `updatedAtMs` 等于该行 `updated_at` 的同一表达式。30 行里 10 行重放：30 次插入、30 次读回、10 次 `state` 查询，语句共 80、batch 4；提交后 `submission_intents` 共 30 行（accepted 1、queued 29），一个 `listing.submit.batch` 作业，payload 里 intents 顺序不变。测试：`TestEnqueueDraftsBatchMatchesSequential`。
- 一块里的 `external_task_id` 用一条 `UPDATE ... id = ANY(...)` 写入。每条意图的 `state` 仍是 `submitting`，`external_task_id` 都是这一次 import 的 task id。这和逐条 UPDATE 的列相同。锁住租约行时的回归测试读的就是这组列，结算还没发生。
- 一块只有一条时，出站正文就是冻结下来的 import 字节，不再编码一次。`TestOneItemImportKeepsFrozenBytes`。多条重新包成 `{"items":[...]}`，字段顺序没有对上 `ImportV3Request`，见缺口。

## 回环对拍

`tests/integration/submit_parity_test.go` 在 Postgres 16 上，对同一批 mock 响应逐列读 `submission_intents`、`seller_upstream_writes`、`seller_resource_occupancies`、`listing_rows`，并在带租约的成功路径上核对 `jobs.state` / `last_error_code` / `result_ref`。覆盖成功、400、429、403 code 7、丢响应、超时、发出后崩溃再恢复、杀开关零写且探测仍读、一次缺失不释放、两次一致缺失才 `superseded` 且行回到 `none`、命中商品则 `accepted`、非法边零行、缺 `app.current_org_id` 时 `podhub_app` 看不到行。

Rust 进程没有参与这次对拍。

## 相对 Rust 0.0.112 的有意修正

这不是「结果不变」。Rust 把 75 条拆成 4 个批次并行发送，批次共用设计图，回执和 `media_object_leases` 写在同一个事务里。Ozon 已经返回 `task_id` 之后，租约行锁失败会让作业失败，回执没有留下，重试也被同一把锁拒绝。批次 2 的意图停在 `submitting` 且没有 task id（对账只认 `unknown`/`accepted`），批次 3 没发出去就被拒绝。

Go 的做法：

1. `task_id` 先在独立事务写入 `external_task_id`，此时不改 `state`。之后的失败不把作业打成 `failed`，也不清掉这个回执。
2. 租约行用 `FOR UPDATE SKIP LOCKED`，短重试后仍拿不到就返回 `lock_busy`。`Requeue` 对这个原因撤回本次 attempt，所以不会在 `max_attempts` 上失败。
3. 对账额外认领：`submitting` 超过 30 秒，且对应 `listing.submit` / `listing.submit.batch` 作业已经是 `failed`。有 task id 则标成 `accepted` 且不再 POST；没有则停到 `unknown`，交给原来的探测。`unknown` 的三条 stamp SQL 没有改。
4. 每个组织同时发送的 `listing.submit.batch` 默认最多 2 个（`OrgSubmitBatchLimit`）。超出的作业以 `store_busy` 重新排队，不消耗 attempt，也不拨号。这个数字不是 Rust 里的。

回归：`TestParallelBatchReceiptSurvivesLeaseLock` 用 4 个并行批次、同一条租约行、loopback mock。锁住期间每条意图都有 task id 且仍是 `submitting`，mock 的 POST 次数等于批次数；松开之后重试不再 POST，状态到 `accepted`，每条意图只有一行写账、一行 `listing_rows`。`TestOrgBatchCapDoesNotSend` 在上限为 1 且已有一个 running 批次时不拨号。`TestReconcilerClosesFailedSubmitting` 覆盖失败作业上的有 task id / 无 task id。

## stored-row 版本与批次租约的补齐

`POST /api/listing/submit` 的 stored-row 分支现在要求 `store_id` 及 `expected_revisions: [{row_id, revision}]` 与 `row_ids` 一一对应。这里是点击时的服务端内容 revision，不是本地队列 revision。缺失或无效 pin 为 400；读取时已变的行逐行返回 `revision_mismatch`；冻结中发生编辑则在新 intent 的投影 CAS 检查处以 409 `revision_mismatch` 回滚整个请求。原来的“接受但忽略 pin”行为不再保留。批次结果用 `row_id` 与前端契约对应。Draft 外层同样统一为已有前端契约的 `store_id`、`card_id`、`items` 和可选 `rules_version`；其内部 WASM 数据及 IntentView 不变。详见 [上架流程优化与回归证据](listing-flow-optimization.md)。

批次结算也改成一次 `queue.MutateRunning` 事务：intent、写账、占用、行投影和 job 共同受租约限制。原来逐条清空 Lease 并提交、最后才 Finish 的方式会让失效 worker 留下已提交终态。新回归通过真实租约回收复现并验证该差异；已保存的正 `task_id` 继续独立保留，恢复扫描接收该事实且不重复 import。单条与批次共用行结算 SQL，已有终态不重写。

随后补齐成功响应契约：DraftData、DraftItem 与提交 IntentView 的 HTTP 字段统一为已有前端/OpenAPI 的 snake_case，200 响应改为严格的 `data: DraftData | BatchData`，补充已有的 `accepted_schema_revisions`、`fields`。这修复了成功入队后被浏览器判为合同不符的问题。旧字段不再作为别名；WASM 项、状态、SQL 和提交中的轻量重放投影不变。真实 PostgreSQL mixed Draft 回归与实际序列化校验覆盖新建、重放、跳过及空列表；详细红绿证据见同一验证记录。

## 不能证明与 Rust 一致、留给决定的缺口

1. 三条发送路由现在走 listing-core wasm 的 op 9 再 op 11，成功则入队，worker 再拨 loopback。HTTP 返回的是入队回执（意图 `queued`），不是 Rust 在进程内派发之后的意图。列对拍在 worker 跑完之后。没有数据库连接时是 503 `服务暂不可用`，不再是 501 `freeze_not_ported`。没有 `store_id`/`items` 的旧正文仍是标签闸：命中 400 `banned_tag`，干净则 400 `validation` `请求格式无效`。
2. 草稿路径的 `request_hash` 是 wasm 冻结返回的 digest。单条 `listing.submit` 任务仍由调用方放入摘要；那条 worker 不自己计算。
3. 占用释放原因 `relationship_confirmed` / `rejected_no_pending` 是从 CHECK 的四个合法值里选的，没有定位到 Rust 的赋值点。`not_dispatched` 和 `partial_settled` 没有被这条路径使用。
4. `OZON_SUBMIT_IN_FLIGHT` 的拼写来自变量名 `OzonSubmitInFlight`，源文件里的字符串常量没有打开。
5. 占用的 `physical_account_key` 写成 `loopback`，不是 Rust 的账号摘要。写账的该列保持 NULL，因为 CHECK 要求 `sha256:` 加 64 位十六进制。
6. 未知导入探测仍不解密信封，向 loopback 发 `/v3/product/info/list` 时不带 Client-Id 和 Api-Key。已接受意图的扫描会解密并带上这两个头，见 `docs/parity/reconcile-gap-parity.md`。信封字节布局没有对上 Rust。
7. `set_submission_state_many` 的函数体没有抄。行更新是 `UPDATE listing_rows SET submission_state` 且 `revision` 相等。如果 Rust 还写事件流，这里没有。
8. `listing_store_limiter` 的 409 `store_busy`（「该店铺正在发送，本次未发送」）没接。上面的组织批次上限是另一件事，默认 2，不是这个 409。
9. `scrub_import_tags`、发货门、媒体门、店铺暂停、凭据失败时的 `RejectQueued` 没有接。
10. 新路由的错误体是已移植列表读的 `{error, code}`。Rust `ListingErrorResponse` 的字段名没有逐字节对过。已合并的标签闸仍是 `{code, message}`。
11. 超过 100 条时的中文文案不是从 `check_batch_size` 抄的，上限 100 是。
12. `/v3/product/info/list` 的请求体是 `{"offer_id":[...]}`。`InfoListV3Request` 的 serde 重命名没有打开。响应用 `items[].id` / `offer_id` / `sources[].sku`，和 `import_reconcile.rs` 的读取字段一致。
13. 六个 due scan 已有 tick，见 `docs/parity/reconcile-gap-parity.md`。未知写和分组只续租、不改业务状态。商品同步在批量为 0 时不入队。`listing.reconcile` 仍是未移植。
14. 非 loopback 的 Seller 源本进程拒绝拨号。Rust 会拨 `api-seller.ozon.ru`。

