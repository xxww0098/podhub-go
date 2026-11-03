# 仓库与配送方式（WH1）

本文记录 WH1 的仓库缓存、浏览器发放/报回与围栏构件。当前 HTTP 入口只保留仓库相关的 7 条；配送方式与 timeslot 接口已撤下。服务端不拨号写 Ozon，接口存在和本地桩通过均不代表外部写链通过准入，见 [技术验证清单](../precision-listing-verification.md)。

既有 WH1 记录不读 Rust 仓库，也不做 Rust 结果对照。既有上架输出、状态和数据是否保持原样，以 Go 里已经存在的发放、报回、围栏和热路径测试，加上 `TestWarehouseReadWriteArchive` 里上架行指纹不变为准。

## OGL 开发方向（2026-10-28 确认）

用户明确后续物流功能按平台现阶段的 OGL 模式开发，并非指定旧测试店铺已经切换 OGL。本文后续的 `4877007` 探测只作为旧跨境 rFBS 样本，不能据此认定 OGL 不支持编辑地址，也不能把仓库的 `is_rfbs` 值或配送方式名称直接当作 OGL 能力标识。

店铺管理中的目标结构是「工作空间 → 店铺 → OGL 仓库 → 配送方式」。地址绑定已有店铺 UUID 与平台仓库标识，凭据轮换不重建地址；沿用服务端托管凭据与租户授权，不按明文密钥建地址簿，也不把 OGL 拆成另一个电商平台。

依据官方 [OGL 仓库设置](https://global-help.ozon.com/zh/fulfillment/ogl/logistic-settings-ogl/warehouse-setting-ogl) 与 [OGL 配送方式设置](https://global-help.ozon.com/zh/fulfillment/ogl/logistic-settings-ogl/delivery-methods-ogl)，候选范围为：

- 仓库：名称、联系电话、发货地址与定位、营业日，以及退货地址、收件人、联系电话；允许退货信息与发货仓一致。
- 配送：每个 OGL 仓库一种方式；选择 Self-Drop 或 Pick-up、对应集运仓，以及备货时限和接单截止时间。平台集运仓地址从可选仓中选择，不当作卖家的自由文本地址修改。
- 生效：区分已提交、处理中与平台确认。已生成发运时的编辑限制及更新耗时按实际平台状态处理，不能把保存受理当作立即可发货。

这两页证明 Ozon 卖家后台存在上述操作流程，不证明本系统已取得对应 Seller API 写入能力。开发顺序是先验证 OGL 店铺身份及授权、实际读写契约、保存与异步状态、独立回读和失败恢复，再连接真实 React 页面；不复用旧 FBS/rFBS Express 写接口来模拟 OGL 成功。目前 OGL API 写入仍待验证，尚无 OGL 产品入口。

同日重新读取 `4877007`，仍是一仓、五种配送方式，唯一启用方式为 China Post、`tpl_integration_type=hybrid`；本次零 Seller 写入。该结果只校准测试样本范围，不用于反驳 OGL 开发方向。[只读复核记录](/Users/xxww/.codex/visualizations/2026/10/28/01a18137-86da-7043-aa83-d33103d2091f/ozon-logistics-verification/ogl-read-report.json)。

## 做了什么

迁移 `00325`–`00329` 追加五张表：`ozon_warehouses`、`ozon_delivery_methods`、`ozon_warehouse_sync`、`ozon_warehouse_intents`、`ozon_warehouse_fences`。只存非敏感字段，没有 Api-Key。RLS 强制打开，角色是 `podhub_app`。没有新函数，没有触发器，没有改此前的迁移。五张表已随压缩进入 `00002_schema.sql`。

读：`POST /v2/warehouse/list`，realFBS 再读 `POST /v2/delivery-method/list`。不回退 `/v1/warehouse/list`。配送方式按当前 v2 契约发送字符串数组 `filter.warehouse_ids`，通过 `cursor` 翻页，解析 `delivery_methods`；不发送旧 `offset`、单数 `warehouse_id`、`status` 或 `provider_id`。页数超过 50、下一页游标缺失或循环、声明有下一页却返回空页，以及列表缺失、类型错误、行标识无效或返回其他仓库的配送方式，都返回 502，保留原快照和同步时间。完整空列表仍可清空缓存。同步时间写在 `ozon_warehouse_sync`。

写和归档：`POST /api/seller/warehouses/grant` 先记意图再返回密钥，服务端不拨 Ozon。浏览器报回 `POST /api/seller/warehouses/report`；`2xx + operation_id` 只证明受理，保存为 `unknown` 并保留围栏，不改变本地 `archived_at`。异步结果用已报回的 `operation_id` 调 `POST /v1/warehouse/operation/status`，目前只提供核验信息，不自动完成或释放围栏；终态契约尚未验证。没有删除接口。配送方式只读。drop-off 请求字段没有核实，保留的路由在鉴权之后返回 501 `not_ported`；timeslot 路由已撤下。

同一仓库的并发写先锁 `ozon_warehouse_fences` 的一行，再插入意图。部分唯一索引只覆盖 `granted` 和 `unknown`。报回只锁意图行。`40P01` 不会被收成别的错误码。

`OZON_WRITE_KILL_SWITCH` 为真时，发放在校验、占额、记意图和解密之前返回 503 `OZON_WRITES_DISABLED`，正文「Ozon 写入已停止」。响应、日志和审计都没有密钥。同步仍是读，`seller.Egress.Call` 的 write 参数是 false。

错误目录已接入 `internal/ozonerr`。`WarehouseCatalog` 调用 `RecordRows`，来源 `ozon_request`。正文、密钥和 message 不传。目录写入失败只打日志，仓库接口自己的结果不变。

能力位 `CapWarehouseWrite` 加在 iota 末尾，只给 owner 和 manager。默认成员（operator）没有。读和同步用已有的 `CapStoreRead`。

## 路由

当前 `internal/warehouse/http/handler.go` 与 `internal/app/testdata/routes.txt` 只注册下面 7 条。原 WH1 的 11 条中，三个 `/api/seller/delivery-methods` 入口与 `/api/seller/warehouses/timeslot/list` 已撤下。

- `GET /api/seller/warehouses`
- `GET /api/seller/warehouses/{warehouse_id}`
- `POST /api/seller/warehouses/sync`
- `POST /api/seller/warehouses/grant`
- `POST /api/seller/warehouses/report`
- `POST /api/seller/warehouses/operations/status`
- `POST /api/seller/warehouses/drop-off/list`（501）

## 结果为什么不变

上架发放、报回、`submission_intents` 和 `listing_rows` 的写入没有改。新能力位在矩阵末尾，原有能力的判定没有改。仓库同步不写上架表，不入队。

`TestWarehouseReadWriteArchive` 在仓库操作前后记录 `listing_rows` 与 `submission_intents` 的行数、状态、revision、offer，以及该组织的 `jobs` 行数。前后相同。`pg_stat_database.deadlocks` 的差值是 0。

既有上架测试在合并 `5caa713` 之后重新通过，见下表。`TestResultConsistency` 在空库上通过；新表已并入 `00002_schema.sql`，旧表列和策略没有差。

## 测试

以下是 WH1 当时的本地验证记录，包含当时的 11 条路由与旧计数；不是本次文档复核重跑结果，也不能证明已撤下入口仍在线。

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

`TestWarehouseReadWriteArchive` 覆盖：同步幂等且跨租户 404；v2 返回 code 9 时不请求 `/v1/warehouse/list`，并写入目录 code `9`；成员 403；归档缺 `confirm` 被拒绝且不插意图；发放/报回的受理（unknown，保留围栏）、403（目录记 grpc `7`）、422（不记 grpc `3`）、无状态码（unknown）、再次报回 409 且行不变；同一仓库并发写只有一个成功，创建槽也只有一个成功；过期发放换操作 ID 也不再给密钥；归档/取消归档的受理不改变本地 `archived_at`；开关打开时不占额、不解密，审计文案是「Ozon 写入已停止」；五张表的跨租户读是 0，缺 GUC 时读是 0 且不能插入。

## 未核实

- `provider_id`、`template_id`、`cutoff`、`sla_cut_in`、`created_at`、`updated_at` 的标量类型没有被文档钉死，列类型是 text。
- Ozon 归档后的 status 字符串没有被现有读路径证实。本地用 `archived_at`。可归档的缓存状态只用现有读路径里的 `created`。
- drop-off 列表和 timeslot 列表的请求字段没有核实。
- 官方有 rFBS Express 专属的配送方式更新接口；它们的存在不证明能用于跨境 rFBS 仓。2026-10-28 的目标仓真实更新拒绝见下节，未放行地址或配送写入界面。
- 仓库列表的 code 9 出现在 HTTP 200 的正文里。这不是错误目录原来的 4xx grpc 映射。

## 需要用户决定

- 能力位名叫 `CapWarehouseWrite`。owner 和 manager 可以写和归档。成员、审阅者、查看者不可以。成员能否自己归档还没定。
- 仓库同步没有定时任务，只有接口触发。频率未定。
- 配送方式的历史缓存实现不构成当前公开 API；三个读/同步入口已经撤下。
- `fence_warehouse_id` 0 是该店的创建槽，不是 Ozon 仓库号。同一时刻只能有一个进行中的创建。
- 归档必须 `confirm=true`、`warehouse_id`，且缓存状态正好是 `created`、本地未归档。
- 取消归档只允许本地 `archived_at` 已有值。没有这个标记时，即使 Ozon 状态不是 `created`，也返回 409。
- 发放 TTL 是 120000 毫秒，沿用上架浏览器发放，不是 Ozon 字段。同一 `clientOperationId` 过期后返回 `grant_expired`；TTL 不能证明已发长期凭据没有被使用，换操作 ID 不释放围栏。只有服务端 `Open` 失败、凭据确定未返回浏览器时，才将该次意图撤销为 `rejected`，允许新操作 ID 重试；清理使用独立短超时，避免请求取消后遗留未发意图。
- 数字形式的 Seller `code` 会写入错误目录，包括 HTTP 200 上的 obsolete code `9`。没有数字 code 的 4xx 才用目录里的 grpc 映射（400→3、403→7、401→16、404→5、429→8）。422 不记。若 code 9 不该进目录，需要改掉这条。
- 操作状态查询不回写本地缓存，也不自动完成意图或释放围栏；本地桩中的状态字符串不能作为真实平台终态证据。
- JSON 字段是 camelCase，和上架发放一致。
- 仓库读和商品读各有一个 `seller.Egress`。进程内槽不共享，数据库里的 `lease_budget` 仍是同一张表。

## 2026-10-28 跨境店铺核验

用户指定店铺「1」（Client ID `4877007`）。普通 API 数据库登录、已托管 v2 凭据及正式 Seller 出口实际读取到一个非 Express 的跨境 rFBS 仓、五个配送方式，其中一个启用且 `tpl_integration_type=hybrid`。该配送方式的退货设置读取为 200，但邮编为空、退货点和其它退货详情均未配置。

现有同步的两个阻断已修正：仓库凭据复用运营模块已有的租户事务、权限检查及当前信封解密；官方只读出口补齐既有配送方式列表和操作状态路径。按当前 v2 游标协议同步后，正常仓库 HTTP 路由返回 200，独立数据库回读是一仓、五种配送方式；跨租户读取返回 404。该 HTTP 实测使用已知所有者的固定会话解析器，不计为交互式登录验收。

只使用已有值进行写入探测，未指定新地址或新配送规则：`/v1/warehouse/erfbs/update` 携带原中国手机号时先被 `+7` 格式校验拒绝；省略可选手机号后返回 400 `warehouse … is not rfbs express`。`/v1/warehouse/fbs/update` 携带原名称及原坐标也返回 400 `Warehouse type is not fbs, bad request`。没有操作被受理；独立官方回读的完整仓库响应与探测前一致。

结论限于该目标仓：读取与现有缓存同步通过；两类已核验的公开仓库更新接口均不适用。退货和配送写入未继续尝试，地址编辑入口未加入产品。临时写入探测适配器已移除，默认 Seller 写开关未修改。脱敏证据不含密钥、手机号、实际地址或坐标：[核验报告](/Users/xxww/.codex/visualizations/2026/10/28/01a18137-86da-7043-aa83-d33103d2091f/ozon-logistics-verification/report.json)。
