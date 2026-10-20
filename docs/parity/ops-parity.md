# ops 对拍

层级：L3。装配在 `internal/app/wire_ops_admin_mcp.go`。ops 不 import `seller`。Seller 出站只经过 `internal/seller.Egress.Call`，由 app 里的 `sellerPort` 适配成 `contract.Seller`。`OZON_WRITE_KILL_SWITCH` 只在 `internal/platform/config` 解析一次，egress 构造时记下布尔值。

证据来源：上传的 Rust 规格（`xxww0098/podhub` HEAD `7df856a4f2d1d8541f0846f5a08e83d0587f43d6`，tag `v0.0.112`）里的 lists / products 两份说明，以及随规格导出的 ops JSON fixture。Rust 仓库本身不可读，没有从源码再抽一份 golden。规格标成未确认、又不能从现有说明推出来的点，留在文末「需要用户决定」，对应路径保持 501 `not_ported` 或明确的降级行为。

## 做了什么

19 条 `/api/ops/**` 从守卫之后的 501 换成规格里能对上的实现。方法与路径没有变，`internal/app/testdata/routes.txt` 仍是 19 条 ops、全库 318 行。根路由没有新增中间件：CSRF 与 admission 仍是 `internal/app` 里已有的全局层。

写路径（`products/mutate`、`message-center/send`）顺序是：JSON 能解码才做业务校验；校验失败 400；角色不够 403 且不查店；`admit_store` 失败不拨号；写闸为真时返回 503 `writes_disabled`，正文是「写闸已启用，Ozon 实时写入已停止」这句完整中文（源码把环境变量名拆成两段拼接，运行时与规格句一致，ops 源文件不构成第二处解析），并且不 `INSERT` 账本、不调用 Ozon。读路径不看写闸。

畸形 JSON、未知字段、类型不对、正文超过 2MiB+1，保持 501 `not_ported`。`product_ids` 里没有正数的促销查询在鉴权之前返回 200 空列表。

## 路由

| 方法 | 路径 | 结果 |
|---|---|---|
| POST | `/api/ops/console/reconcile` | 只读复核未知账本；viewer 403 |
| POST | `/api/ops/console/refresh-metrics` | 事务内 advisory lock 后拉 30 日出单 |
| GET | `/api/ops/console/snapshot` | 花名册 + 账本 + 指标 + 商品汇总 |
| POST | `/api/ops/message-center/history` | 聊天记录，空 `chat_id` 在查店前 400 |
| POST | `/api/ops/message-center/inbox` | 按请求顺序聚合，失败店留在列表里 |
| POST | `/api/ops/message-center/send` | 写闸 + 账本；幂等键 `ozon.chat-send` |
| POST | `/api/ops/products/metrics` | 经营指标，页上限默认 1000 |
| POST | `/api/ops/products/mutate` | 写闸 + 账本；幂等键 `ozon.product-mutation` |
| POST | `/api/ops/products/promotions` | 无正数商品 id 时 200，不鉴权 |
| POST | `/api/ops/products/sync` | 商品同步投影 |
| POST | `/api/ops/products/warehouses` | 仓库列表 + FBS 库存 |
| POST | `/api/ops/returns/cancellations` | 取消申请 |
| POST | `/api/ops/returns/list` | 退货 |
| POST | `/api/ops/shipping/list` | 待发货，窗口与截单按规格 |
| POST | `/api/ops/supply/orders` | 供货单；非法 id / 缺详情失败关闭 |
| POST | `/api/ops/supply/warehouse-stocks` | 仓库存汇总；第 21 个非空页 502 |
| POST | `/api/ops/voice/chats` | 会话 |
| POST | `/api/ops/voice/questions` | 提问 |
| POST | `/api/ops/voice/reviews` | 评价；Premium Plus 文案命中时 200 且不再请求 |

消息中心三条没有 Rust HTTP 测试，按 handler 说明实现，不是继续 501。

## 规格小节 ↔ Go 测试

| 规格 | 测试 |
|---|---|
| lists 0.2 角色 / products 0.7 Capability | `TestOpsWeakRolesStopBeforeAdmit`、`TestOpsParsedRolesCanRead`、`TestOpsUnauthenticatedAndWorkspace` |
| lists 0.5 信封；畸形 JSON | `TestOpsMalformedJSONStaysNotPorted` |
| lists 0.7 / products 0.10 写闸在账本和拨号之前 | `TestOpsWriteSwitchBeforeLedger`、`TestOpsWriteKillSwitchSendsNothing` |
| lists 0.6 `admit_store` 看不见即 404 | `TestOpsInvisibleStoreDoesNotCallOzon` |
| lists 1 发货窗口与投影 | `TestShippingWindowAndProjection` |
| lists 7 供货单 | `TestSupplyOrdersProjectAndFailClosed` |
| lists 8 仓库存分页 | `TestWarehouseStocksAggregateAndPageBound` |
| lists 9 inbox 顺序 | `TestInboxKeepsRequestOrderAndCounts` |
| lists 4–6、10 评价 / 提问 / 会话 | `TestVoicePremiumAndChatSort` |
| lists 11 / products 5 幂等键与状态机 | `TestChatAndProductKeys`、`TestApplyEdgesAndIllegalPairs`、`TestMutationValidationJoinAndLeave` |
| products 1–2 同步与指标 | `TestMonitorProjectionAndMetrics`、`TestMetricsPagingAndDaySeries` |
| products 4 促销空列表 | `TestPromotionsEmptyBeforeAnyCall`、`TestOpsEmptyPromotionsSkipAuth` |
| products 6–7 控制台状态与刷新 | `TestStatusFromWireAndRefreshDue`、`TestProbeBackoffAndLedgerSQL` |
| products 8 复核需要第二次相同观察 | `TestDecideNeedsASecondIdenticalObservation` |
| products 0.11 / 5.4 RLS | `TestLedgerAndConsoleRLS` |
| 路由清单 19 条 | `TestOpsRoutesMatchInventoryCount` |

## 与 Rust 对比的测试

本地没有 Docker、没有 `PODHUB_PARITY_DSN`。对比用的是规格 fixture，不是连到 Rust 进程。

```
gofmt -l internal/ops internal/seller/egress.go internal/app/wire_ops_admin_mcp.go internal/app/wire_ops_admin_mcp_test.go
go test ./internal/ops/... ./internal/seller/ ./internal/app/ ./tests/archtest/ -count=1
```

`TestLedgerAndConsoleRLS` 在没有 Docker 或 `PODHUB_PARITY_DSN` 时跳过；CI 的 Postgres 16 会跑两组织隔离：跨组织读到 0 行、更新 0 行、插入失败，缺 `app.current_org_id` 时三张表计数为 0 且插入失败。

写闸关闭时 `WritePosts` 为 0、账本 `Begin` 为 0。读路径不看开关。

## 改了哪个流程、结果为什么不变

1. 商品同步、价格、库存、供货单列表与计数、供货单明细 bundle 按固定顺序调用，而不是规格里的并发 fan-out。请求集合与投影由 `TestMonitorProjectionAndMetrics`、`TestSupplyOrdersProjectAndFailClosed` 钉住，不依赖调度先后。
2. 经营指标条目按 SKU 排序后再编码，避免 HashMap 迭代顺序。`TestMetricsPagingAndDaySeries` 对上日期序列与合计。
3. inbox 按请求里的店铺顺序返回。Rust `buffer_unordered` 的完成顺序不稳定，本实现选稳定顺序，并在「需要用户决定」列出。

金额字符串用两位小数；其余数字走 `encoding/json`（`10` 而不是 `10.0`）。

## 需要用户决定

1. Axum 拒绝畸形 JSON / 超限正文时的响应体未确认。这些请求保持 501 `{"error":"...","code":"not_ported"}`。
2. `post_read` 的 SafeStatuses 重试次数未确认。读失败只请求一次。
3. `admit_store` 是否要 `SET LOCAL` 未确认。`organization_stores`、凭据、成员没有 RLS，查询带 `org_id` 谓词，不进租户事务。账本、`console_store_metrics`、`store_product_sync` 走 `tenantx.BeginApp`。
4. seller `entry()` 探活 `/v1/roles` 未确认，没有调用。
5. `kind=chat_send` 会不会被 observation CHECK 拒绝未确认。插入不写 `observation_state`（迁移允许 NULL）。
6. 归档商品镜像 `UPDATE` 的 SQL 没有贴出，没有写 `store_products`。HTTP 200 与账本结算仍然发生。
7. identity admission 的默认池数字没有对照规格改。ops 不新增第四个根中间件。
8. inbox 完成顺序：本实现按请求顺序；Rust 并发完成顺序不稳定。
9. 非金额浮点：Go `encoding/json` 写出 `10`，serde 可能写出 `10.0`。没有字节级 golden 钉死的字段按 Go 默认编码。
10. 花名册 SQL 没有贴出。投影是规格里点名的列：`store_limit` 取 `COALESCE(store_limit_override, 1)`，已用与挂起按全组织计数，店铺列表按可见性过滤。
11. 复核探针：聊天命中、删除缺席/矛盾、库存只读核对已实现。价格、归档、加入/退出活动返回 `indeterminate`（`unsupported`），HTTP 仍 200，不重发写请求。
12. `settle` 在 `rows_affected != 1` 时没有按规格再查一行。若状态已不是 `dispatching`，更新影响 0 行后仍返回成功。
