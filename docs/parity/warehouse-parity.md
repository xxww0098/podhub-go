# 仓库与配送方式（WH1）

租户缓存 Ozon 仓库和 realFBS 配送方式，写操作走浏览器直连。服务端不拨号写 Ozon，也不保存 Api-Key。没有前端。

这次不读 Rust 仓库，也不做 Rust 结果对照。既有上架输出、状态和数据是否保持原样，以 Go 里已经存在的发放、报回、围栏和热路径测试，加上 `TestWarehouseReadWriteArchive` 里上架行指纹不变为准。

## 做了什么

迁移 `00325`–`00329` 追加五张表：`ozon_warehouses`、`ozon_delivery_methods`、`ozon_warehouse_sync`、`ozon_warehouse_intents`、`ozon_warehouse_fences`。只存非敏感字段，没有 Api-Key。RLS 强制打开，角色是 `podhub_app`。没有新函数，没有触发器，没有改 00001–00320。五张表在 `postRustTables`。

读：`POST /v2/warehouse/list`，realFBS 再读 `POST /v2/delivery-method/list`。不回退 `/v1/warehouse/list`。配送方式请求只带 `filter.warehouse_id`，不带 `status` 或 `provider_id`。页数超过 50 返回 502，不写半截快照。同步时间写在 `ozon_warehouse_sync`。

写和归档：`POST /api/seller/warehouses/grant` 先记意图再返回密钥，服务端不拨 Ozon。浏览器报回 `POST /api/seller/warehouses/report`。异步结果用已报回的 `operation_id` 调 `POST /v1/warehouse/operation/status`。没有删除接口。配送方式只读。drop-off 和 timeslot 的请求字段没有核实，两条路由在鉴权之后返回 501 `not_ported`。

同一仓库的并发写先锁 `ozon_warehouse_fences` 的一行，再插入意图。部分唯一索引只覆盖 `granted` 和 `unknown`。报回只锁意图行。`40P01` 不会被收成别的错误码。

`OZON_WRITE_KILL_SWITCH` 为真时，发放在校验、占额、记意图和解密之前返回 503 `OZON_WRITES_DISABLED`，正文「Ozon 写入已停止」。响应、日志和审计都没有密钥。同步仍是读，`seller.Egress.Call` 的 write 参数是 false。

错误目录已接入 `internal/ozonerr`。`WarehouseCatalog` 调用 `RecordRows`，来源 `ozon_request`。正文、密钥和 message 不传。目录写入失败只打日志，仓库接口自己的结果不变。

能力位 `CapWarehouseWrite` 加在 iota 末尾，只给 owner 和 manager。默认成员（operator）没有。读和同步用已有的 `CapStoreRead`。

## 路由

`origin/main`（`5caa713`）的路由黄金值是 327 行，`PlatformRoutes` 是 104。这次在黄金值里只追加下面 11 行，合并后是 338 行。`PlatformRoutes` 仍是 104。ops 路由仍是 19。中间件仍是 3 个。

- `GET /api/seller/warehouses`
- `GET /api/seller/warehouses/{warehouse_id}`
- `POST /api/seller/warehouses/sync`
- `GET /api/seller/delivery-methods`
- `GET /api/seller/delivery-methods/{method_id}`
- `POST /api/seller/delivery-methods/sync`
- `POST /api/seller/warehouses/grant`
- `POST /api/seller/warehouses/report`
- `POST /api/seller/warehouses/operations/status`
- `POST /api/seller/warehouses/drop-off/list`（501）
- `POST /api/seller/warehouses/timeslot/list`（501）

## 结果为什么不变

上架发放、报回、`submission_intents` 和 `listing_rows` 的写入没有改。新能力位在矩阵末尾，原有能力的判定没有改。仓库同步不写上架表，不入队。

`TestWarehouseReadWriteArchive` 在仓库操作前后记录 `listing_rows` 与 `submission_intents` 的行数、状态、revision、offer，以及该组织的 `jobs` 行数。前后相同。`pg_stat_database.deadlocks` 的差值是 0。

既有上架测试在合并 `5caa713` 之后重新通过，见下表。`TestResultConsistency` 在空库上通过，新表被 `postRustTables` 排除，旧表列和策略没有差。

## 测试

本机 PostgreSQL 16.15，`127.0.0.1`。没有 Docker。没有连接生产库、Ozon、R2 或模型供应商。夹具密钥是固定字符串 `fixture-warehouse-api-key`。压测只调用 `loadmode.Run("R")`。

| 测试 | 命令 | 结果 |
| --- | --- | --- |
| `TestNamedEdgesAndIllegalEdges`、`TestClassifyReport`、`TestParseWarehousesAndObsolete`、`TestParseMethodsKeepsVerifiedFieldsAsText`、`TestParseOperation`、`TestArchiveGuards` | `go test ./internal/warehouse/domain -count=1` | PASS |
| `TestGrantKillSwitchOpensNothing`、`TestSyncNeverFallsBackToRetiredList`、`TestObsoleteListDoesNotFallBack`、`TestWarehousePageCapDoesNotSave`、`TestLoadTestsStayOnModeR` | `go test ./internal/warehouse/service -count=1` | PASS |
| `TestMemberCannotWriteAndDropOffStaysUnported`、`TestKillSwitchResponseHasNoKey`、`TestOpenAPIListsWarehouseRoutes` | `go test ./internal/warehouse/http -count=1` | PASS |
| `TestRouteTableMatchesGolden`、`TestMountedWarehouseKillSwitchAndCapability`、`TestWarehouseReadDialsWhenWritesAreDisabled`、`TestWarehouseCatalogUsesOzonErrorRows` | `go test ./internal/app -count=1` | PASS |
| `TestAdminRouteCounts`（`PlatformRoutes` 104） | `go test ./internal/admin/http -run TestAdminRouteCounts -count=1` | PASS |
| `TestImportRules`、`TestSingleParsePoints` | `go test ./tests/archtest -count=1` | PASS |
| `TestCapabilityMatrixIsTotal` 及其余 identity 测试 | `go test ./internal/identity/... -count=1` | PASS |
| `TestEnqueueDraftsBatchMatchesSequential` 及其余 listing 包测试 | `PODHUB_ALLOW_SUPERUSER_DB=1 PODHUB_PARITY_DSN=postgres://postgres:postgres@127.0.0.1:5432/podhub_draft?sslmode=disable go test ./internal/listing/... -count=1` | PASS |
| `TestWarehouseReadWriteArchive` | `PODHUB_ALLOW_SUPERUSER_DB=1 PODHUB_PARITY_DSN=postgres://postgres:postgres@127.0.0.1:5432/podhub_list?sslmode=disable go test ./tests/integration -run TestWarehouseReadWriteArchive -count=1` | PASS |
| `TestResultConsistency` | `PODHUB_ALLOW_SUPERUSER_DB=1 PODHUB_PARITY_DSN=postgres://postgres:postgres@127.0.0.1:5432/podhub_fp?sslmode=disable go test ./tests/integration -run TestResultConsistency -count=1` | PASS |
| `TestBrowserGrantAndReport`、`TestBrowserDirectImportRoundTrip`、`TestBrowserDirectConcurrentGrants`、`TestBrowserDirectKillSwitchHidesKey`、`TestBrowserDirectGrantDeadlineAndRevocation`、`TestBrowserDirectTenantAndCapability`、`TestBrowserDirectWorkerDoesNotDialSubmitting`、`TestBrowserDirectModeRGrantCount`、`TestSubmissionOfferFence`、`TestSubmitSellerColumns`、`TestListingHotPath` | `PODHUB_ALLOW_SUPERUSER_DB=1 PODHUB_PARITY_DSN=postgres://postgres:postgres@127.0.0.1:5432/podhub_browser?sslmode=disable go test ./tests/integration -run 'TestBrowserGrantAndReport\|TestBrowserDirect\|TestSubmissionOfferFence\|TestSubmitSellerColumns\|TestListingHotPath' -count=1` | PASS |
| `go vet ./...`、`go build ./...` | 同上 | PASS |

`TestWarehouseReadWriteArchive` 覆盖：同步幂等且跨租户 404；v2 返回 code 9 时不请求 `/v1/warehouse/list`，并写入目录 code `9`；成员 403；归档缺 `confirm` 被拒绝且不插意图；发放/报回的成功、403（目录记 grpc `7`）、422（不记 grpc `3`）、无状态码（unknown，围栏继续占着）、再次报回 409 且行不变；同一仓库并发写只有一个成功，创建槽也只有一个成功；过期发放不再给密钥；归档后同步保留本地 `archived_at`；开关打开时不占额、不解密，审计文案是「Ozon 写入已停止」；五张表的跨租户读是 0，缺 GUC 时读是 0 且不能插入。

## 未核实

- `provider_id`、`template_id`、`cutoff`、`sla_cut_in`、`created_at`、`updated_at` 的标量类型没有被文档钉死，列类型是 text。
- Ozon 归档后的 status 字符串没有被现有读路径证实。本地用 `archived_at`。可归档的缓存状态只用现有读路径里的 `created`。
- drop-off 列表和 timeslot 列表的请求字段没有核实。
- 没有找到配送方式的创建或更新接口。
- 仓库列表的 code 9 出现在 HTTP 200 的正文里。这不是错误目录原来的 4xx grpc 映射。

## 需要用户决定

- 能力位名叫 `CapWarehouseWrite`。owner 和 manager 可以写和归档。成员、审阅者、查看者不可以。成员能否自己归档还没定。
- 同步没有定时任务，只有接口触发。频率未定。
- 配送方式保持只读，直到有核实过的写接口。
- `fence_warehouse_id` 0 是该店的创建槽，不是 Ozon 仓库号。同一时刻只能有一个进行中的创建。
- 归档必须 `confirm=true`、`warehouse_id`，且缓存状态正好是 `created`、本地未归档。
- 取消归档只允许本地 `archived_at` 已有值。没有这个标记时，即使 Ozon 状态不是 `created`，也返回 409。
- 发放 TTL 是 120000 毫秒，沿用上架浏览器发放，不是 Ozon 字段。同一 `clientOperationId` 过期后返回 `grant_expired`，围栏要等另一个 clientOperationId 才会被释放。
- 数字形式的 Seller `code` 会写入错误目录，包括 HTTP 200 上的 obsolete code `9`。没有数字 code 的 4xx 才用目录里的 grpc 映射（400→3、403→7、401→16、404→5、429→8）。422 不记。若 code 9 不该进目录，需要改掉这条。
- 操作状态查询不回写本地缓存。
- JSON 字段是 camelCase，和上架发放一致。
- 仓库读和商品读各有一个 `seller.Egress`。进程内槽不共享，数据库里的 `lease_budget` 仍是同一张表。
