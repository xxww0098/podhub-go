# 上架流程优化与回归证据

首轮基线：`be364cb76e87dc9ea178cd322b888ab3b641d998`。改动前端发送边界、Go 提交持久化和 worker 执行循环。第二轮补齐 stored-row 的版本契约和批次结算事务；两轮均不修改 Rust 规则、WASM 产物、迁移或既有配额 SQL。

创建 PR 时，主分支已推进到 `64cb010656ef795b608050e04376d7674aa691ee`。新增的主分支改动与本批文件无重叠；随后还在 GitHub 生成的合并版本上验证前端与仓库 CI。

## 问题与修复

| 位置 | 原行为 | 修复后的行为 |
| --- | --- | --- |
| `internal/listing/submit/draft.go` / `SendStored` | 幂等重放不创建工作，却再次把行投影写为 `queued`，递增视图版本并覆盖更新时间 | 只为本次 `created` 的 intent 更新行投影；重放保留原状态、时间和视图版本 |
| 同文件 / `enqueueDrafts` | stored-row 批次使用第一行的卡片 ID 插入所有 intent | 每行携带自己的卡片 ID；普通 draft 路径显式使用请求中已验证的卡片 ID |
| 同文件 / `gateSchema` | 已匹配 current/legacy 的 schema 仍逐行读取历史快照 | 匹配版本跳过历史读取；不同版本继续比较历史、阻断缺少的新必填项 |
| `web/src/features/workflow/submit/send-queue.ts` | 行版本检查后等待持久化，编辑、换店、删除或新回执可能使旧快照失效；最终订阅通知也可重入 | 在持久化和最后一次通知之后、发送之前，重新验证 revision、作用域、店铺和本次 admission marker |
| `web/src/features/workflow/submit/publish-policy.ts` | 未选中商品的关联店铺冲突会阻断选中商品 | 显式选择只检查所选商品；整卡发送继续检查整卡 |
| `internal/queue/service/loop.go` | `Work` 在领取循环中同步执行，配置的并发无法生效，长任务阻塞心跳与回收 | 回调在有界 goroutine 中执行；领取、心跳和回收继续运行；同时限制活动回调和数据库 running 行数 |

## 执行与状态约束

队列仍调用原来的 `Claim`。公平游标、许可申请、锁顺序、重试原因、作业结算和租约恢复规则保持不变。完成回调立即通知循环补充空位；数据库已结算但回调仍在清理时，不能提前复用该本地空位。取消后不再启动新的回调，循环等已启动回调退出后返回。

同一进程内，同一个 `org_id` 的 `listing.submit.batch` 保持领取顺序执行。原因是现有 `orgBatchBusy` 按 running 行计数：一次领取多个提交者的同工作区批次后，直接并行启动可能让所有批次相互拒绝。本批用有界完成信号串接保持原来的同工作区执行顺序，跨工作区批次和其他任务种类可以并行；最后一项结束后清理工作区记录。没有新增分布式调度器、修改数据库状态或提高单工作区批次上限。

浏览器的本地拒绝只撤销本次尚未发出的准入和 offer lock。编辑后的内容、店铺及新回执均保留；同批未变的商品继续发送。已持久化的提交/修复预算不退款，也不自动重新生成或重发旧商品。`row_changed_before_dispatch` 是本地拒绝原因，不是新的服务端状态。

## 先复现，再修复

- `TestSendStoredKeepsReplayStateAndCardOwnership`：在旧实现上复现第二张卡片归属错误，以及 `submitting / unknown / accepted / rejected / cancelled` 被改回 `queued`；含 `queued` 在内的六种重放都会改变更新时间和视图版本。修复后只创建两条新的 intent，新建工作和重放身份保持正确。
- `TestGateSchemaAcceptedRevisionsAvoidHistoryReads`：旧实现的 current/legacy 两例失败；修复后不再查询历史。`TestGateSchemaChangedRevisionStillReadsHistory` 保证旧版本新增必填项仍被阻断。
- 原有 `TestEnqueueDraftsBatchMatchesSequential` 保留独立旧顺序算法作为单卡片对照，只增加适配函数和每行卡片 fixture。没有把 oracle 换成新实现。
- 前端首批九项新回归在旧实现全部失败；初次修复后的最终通知窗口又由两项新回归复现。最终十一项覆盖保存等待期间的编辑、换店、删除、新回执、同步订阅者编辑/停止及选择范围。
- `TestQueueLoopExecution` 在旧实现复现回调不能并行、回调阻塞期间 10 秒心跳和过期回收不能执行。测试使用真实 PostgreSQL 和通道屏障，核验执行上限、清理完成后补位、取消等待及租约身份。
- `TestListingBatchLoopSerializesOneOrgAndMakesProgress` 用同工作区两个提交者的四个真实批次，首先证明直接并行版本会重叠执行；加入顺序保护后，四批都通过 `submit.Work` 和本机假 Seller 完成，只发送四次请求。
- `TestSubmitPortConcurrentWrites` 验证共享 Seller 适配器并发请求的内容隔离；生产传输的 slots、计数与 HTTP client 继续使用现有实现。

## 验证与复现

使用仓库工具链 Go 1.27.2、Bun 1.4.3 和 PostgreSQL 16.15。数据库测试只连接隔离的 `127.0.0.1` 实例；Seller 使用本机假服务。前端网络保护保持开启。

```sh
# web/
bun install --frozen-lockfile
bun run check

# 仓库根；PODHUB_PARITY_DSN 指向新建的隔离测试数据库
PODHUB_ALLOW_SUPERUSER_DB=1 OTEL_TRACES_SAMPLER=always_on \
  go test -race -p 1 -count=1 \
  ./internal/listing/submit/... ./internal/queue/... ./internal/seller/... \
  ./tests/parity ./tests/archtest

PODHUB_ALLOW_SUPERUSER_DB=1 OTEL_TRACES_SAMPLER=always_on \
  go test -race -count=1 ./tests/integration \
  -run '^(TestQueueLoopExecution|TestListingBatchLoopSerializesOneOrgAndMakesProgress)$'

go vet ./internal/listing/... ./internal/queue/... ./internal/seller/... ./tests/integration
scripts/check-wasm-dist.sh
git diff --check
```

每个既有集成测试单独使用新的数据库，避免共享 fixture 造成交叉污染。开发环境全局 OTEL 采样率为 1%，曾导致既有“两条 span”断言收到零条；仅在测试进程设置 `OTEL_TRACES_SAMPLER=always_on`，不改测试断言或生产配置。新增前端测试的一处 optional chaining lint 告警也已修正，原有 818 告警阈值保持不变。

数据库 `-race` 回归还检出了既有 `submit_parity_test.go` 假 Seller 计数器的并发读写。其辅助 `counter` 改为 `atomic.Int64`，调用接口及断言保持不变；复跑全部选定集成测试后不再报告数据竞争。

合并版本的首轮 CI 有一项前端网络保护失败：WB 持久化回归期间出现未注册的 `/api/events/inbox` 请求；同一版本完整本地复跑则通过。随后发现准备流程测试的 `record().restore()` 只恢复 fetch，遗留了账户上下文及反馈定时器。新增两条 fake-clock 回归在未修复版本稳定产生同一请求签名（0 通过、2 失败）。修复在外层传输 fixture 退出时先失效账户、取消旧反馈，再恢复原账户及 fetch；保留返回后等待回执的断言，未改生产上报或网络保护。定向 42 项测试通过。此证据确认了可重现的跨测试泄漏机制，未追踪首轮 CI 请求的具体 receipt ID。

### 首轮本地结果

| 检查 | 结果 |
| --- | --- |
| 最新主分支合并版本的前端检查 | 构建、类型检查、API 生成一致性、knip 通过；测试 3,146 通过、2 跳过、0 失败；lint 的既有基线问题见下 |
| 上述 Go 提交、队列、Seller、parity、archtest 包的 `-race` | 109 项测试（含子测试）通过；11 个有测试的包通过，另 4 个包无测试文件 |
| 12 项选定的数据库集成测试，每项独立新数据库、启用 `-race` | 含子测试共 46 项通过，0 跳过、0 失败；无数据竞争 |
| 队列执行专项重复测试 | 5 个子测试 × 3 轮通过，启用 `-race` |
| 共享 Seller Port 并发专项 | 20 轮通过，启用 `-race` |
| `go vet`、WASM 产物 hash 检查、`git diff --check` | 全部通过 |

初始基线上的完整 `bun run check` 曾全部通过（3,122 通过、2 跳过）。最新主分支合并版本的 `check` 在最后一步 lint 失败：819 条告警超过现有 818 阈值。另开纯 `main@64cb010` 工作树复跑 lint，同样失败；按文件和消息逐条对照，两边 819 条告警完全一致，本 PR 未新增告警。相较初始基线，上游拖拽文件新增两条 inline transition 告警，登录页减少一条。未调高阈值；此项主分支基线问题仍存在。

选定的数据库集成测试为：`TestQueueLoopExecution`、`TestListingBatchLoopSerializesOneOrgAndMakesProgress`、`TestParallelBatchReceiptSurvivesLeaseLock`、`TestOrgBatchCapDoesNotSend`、`TestReconcilerClosesFailedSubmitting`、`TestSubmitSellerColumns`、`TestSubmissionOfferFence`、`TestBrowserDirectConcurrentGrants`、`TestBrowserDirectWorkerDoesNotDialSubmitting`、`TestListingIntentsCatalog`、`TestListingHotPath`、`TestResultConsistency`。本地结果不等同于仓库全量 CI；PR 的 CI 单独报告。

## 第二轮：点击版本、会话失效与结算租约

第二轮以 PR 的 `a201e468e09543d5638562cb6641f523a7996b93` 为起点，并与已合入 PR #17 的 `main@032a3a86457c79e607bb8a33de82be96aa44adf7` 组合验证。下面是明确的行为修正，不归类为同输入结果不变的性能优化。

### 点击时的服务端版本必须到达提交事务

实际工作台路径是 `usePublishQueue → workflowSend → sendRows → sendNativeChunk → submitOzonChunk → ParseBatch → SendStored`。这条路径的 pin 是 `ListingRowView.revision`，不是另一条本地 Draft 队列的 `LocalRow.rev`。此前前端保留了 pins 却未放入 POST，后端也忽略请求中的 `expectedRevisions`。

stored-row 请求现在要求：

```json
{
  "storeId": "11111111-1111-4111-8111-111111111111",
  "row_ids": ["22222222-2222-4222-8222-222222222222"],
  "expectedRevisions": [
    {"rowId": "22222222-2222-4222-8222-222222222222", "revision": 1}
  ]
}
```

| 情况 | 新结果 | 回归 |
| --- | --- | --- |
| 缺失、重复、遗漏、额外或无效的 pin | HTTP 400，未进入冻结 | `TestParseBatchRevisionPins`、直接服务调用及 HTTP 拒绝测试 |
| 读取时已经是其他 revision | 该行 `skipped: revision_mismatch`；匹配行继续 | `TestSendStoredRejectsStalePinsAndEnqueuesCurrentRows` |
| 冻结中发生编辑，新 intent 的投影 CAS 更新零行 | HTTP 409 `revision_mismatch`；本请求的新 intent、job 和投影更新整体回滚 | `TestSendStoredConcurrentEditRollsBackWholeBatch` |
| 幂等重放 | 保留既有 intent 和行投影 | 既有六状态重放回归及混合批次回滚回归 |

预检查不提前持有行锁。新建 intent 沿用触发器的 store → row 锁顺序，再检查原有投影 UPDATE 的 `RowsAffected`，避免增加 row → store 反序。中途冲突的整批回滚是有意变化：响应明确告知“本批未入队，请刷新后重试”，前端只把精确的 HTTP 409 / `revision_mismatch` 组合当作确定未受理；其他未知 409 继续保持 `unknown`。

批次结果的行键从 `rowId` 对齐为前端已使用的 `row_id`，否则真实拒绝无法对应商品。OpenAPI 补齐三种请求形状、stored-row 必填 pins 和实际 `{error, code}` 错误体，Go 与 TypeScript 产物同步生成。前后端需同步更新；不保留无 pin 的旧 stored-row 调用方式。Draft 发送形状和其它 Intent 字段未在这一轮扩展。

正式红测证明：旧 pin 会创建较新内容的 intent；冻结中编辑仍会留下旧 snapshot 的 job；缺 pin 被接受；响应缺少 `row_id`；实际错误体与 OpenAPI 不符。数据库用确定性 freeze fixture 隔离持久化，不能把这组测试称为真实 WASM 或 Seller 端到端验证。

### 会话失效后停止尚未派发的动作

`sendRows` 在第一个等待之前捕获现有 `rowCacheScope`；后续 `shouldStop` 同时检查该会话是否有效。实际 UI 入口把账户会话和工作台 scope 合并用于自动保存、供应商校验、队列等待、派发和结果落地。没有新增状态机；已经派发的请求仍使用原来的 deadline，继续接收结果，不因切换被当成可重发。

红测在真实 compiled WASM 的 schema 加载处设屏障，切换会话后恢复，旧实现仍发出上架 POST。另一个红测通过实际 hook 切换工作台并返回 403，证明多余旧请求存在，同时确认新工作台没有被覆写。这些证据不构成跨租户写入或 RLS 绕过的证明。回归还覆盖自动保存等待、已发请求的迟到正常结果、精确 pins 序列化和缺 pin 的本地拒绝。

### 批次终态与作业租约在一个事务结算

旧 `settleBatch` 清空每项的 Lease，逐项提交后才调用 `queue.Finish`。真实 `Enqueue → Claim → ReclaimExpiredRows` 回归证明：`Ready` 尚未返回时租约被回收，随后零次发送的连接拒绝仍会把 batch 的 intent/行提交为 `rejected`；最终虽报 lost lease，已提交的行无法回滚。单条路径的同场景则保持原样。

批次现在与单条共享行结算 SQL，在一次 `queue.MutateRunning` 事务内检查租约、更新整批 intent/写账/占用/投影，再完成 job。后项错误使前项一同回滚；已经越过目标边的 intent 仍按原规则跳过。继续使用现有 head → quota 锁顺序和重试，不改许可、公平游标或回收器。单条清空错误码、批次在无新错误码时保留旧值的既有差异也保持。

正的外部 `task_id` 仍先独立提交。即使之后租约失效，回执也保留，由已有恢复扫描确认 accepted，测试要求只出现一次 import 请求。这避免把外部既成事实与失效 worker 的状态写入权限混为一谈。

回归：`TestListingSettlementRejectsReclaimedLease`、`TestListingLateReceiptSurvivesReclaimedLease`、`TestListingBatchSettlementRollsBackOnLaterFailure`、`TestListingBatchSettlementSkipsPastEdges`、`TestListingSettlementKeepsExistingJobSemantics`，以及原有租约行锁、提交列、组织上限、队列循环回归。

### 第二轮最终本地验证

以下结果来自最终代码与 `main@032a3a8` 的合并工作树：

| 检查 | 结果 |
| --- | --- |
| 前端构建、TypeScript、API 生成一致性、knip | 通过 |
| 全量前端测试，网络保护开启 | 3,159 通过、2 跳过、0 失败，427 个文件 |
| submit / queue / seller / api / parity / archtest 的 `-race -p 1 -count=1` | 152 项测试（含子例）通过，12 个有测试的包通过，0 跳过、0 失败 |
| 12 组独立 PostgreSQL 集成测试，启用 `-race` | 37 项测试（含子例）通过，0 跳过、0 失败 |
| Go 生成代码、`go vet`、WASM hash、`git diff --check` | 通过 |
| 前端 lint | 819 条既有告警超过 818 阈值；与纯 `main@032a3a8` 的文件、消息、严重度、规则逐条完全一致，新增 0 条 |

12 组数据库测试是上述五组新结算回归，加上 `TestSubmitSellerColumns`、`TestParallelBatchReceiptSurvivesLeaseLock`、`TestOrgBatchCapDoesNotSend`、`TestReconcilerClosesFailedSubmitting`、`TestListingBatchLoopSerializesOneOrgAndMakesProgress`、`TestQueueLoopExecution`、`TestSubmissionOfferFence`。每组使用独立新数据库。

完整 `bun run check` 在最后的 lint 步骤以非零退出；不能把它描述为全部通过。既有 `workflow-wiring` 源码断言同步为联合检查会话和工作台 scope，实际行为由新增 hook 回归覆盖；未降低 lint 阈值或放宽网络保护。远端全量 CI 结果单独记录在 PR 中。

## 收益与边界

已匹配 schema 的 N 行请求消除 N 次无用的历史快照查询；这是查询次数的确定性减少，不是整条上架链路的实测加速比例。并发测试证明执行重叠、上限与续租，不作为线上吞吐量或 100 用户容量报告。

未执行真实店铺发布、生产数据库测试、真实浏览器 IndexedDB 端到端流程或部署。本仓库现有的真实出站限制保持不变。此前独立 WASM PR 的源码及产物未混入本批。
