# PR-8a delegate：和 Rust 对过什么

层级 L3。`tests/archtest/arch_test.go` 的 `level` 已有 `delegate: 3`。本域只 import 自己的 `contract` / `domain` / `gen`。`go test ./tests/archtest` 无新增违规。

装配在 `internal/app/wire_supply_delegate_supplier.go`。`tenant.BeginApp` 由 app 传入，本域不 import `internal/tenant`。生产代码不读环境变量，不解析 `OZON_WRITE_KILL_SWITCH` 或 `CLOUD_MEDIA_GC_DELETE`。`DELEGATE_SYNC_INTERVAL_MS` 仍只在 `internal/platform/config` 解析一次；`delegate/jobs` 不读它。`DELEGATE_AUTO_DISPATCH` 也只在 `internal/platform/config` 解析一次，缺省开启；`0`/`false`/`no`/`off`（trim、ASCII lower）关闭。关闭后 ready 行不自动插入 `delegate_dispatches`。这 16 条路由都不入队。

卖家 16 条路由的 SQL 是 `internal/delegate/repo/seller_bind.go` 与 `seller_order.go` 里的手写 pgx，跑在 `BeginApp` 里。`db/schema/pr8a/delegate.sql` 仍是 sqlc 桩，没有加 goose 迁移。供应商接单/拒单/发货仍走 sqlc 与 `delegate_supplier_*` 函数。`domain.TransitionOrder` 仍是 `ErrUnproven`。

sqlc 输出在 `internal/delegate/gen`（包名 `sqlcgen`）。archtest 把 `repo/sqlcgen` 判成同域 `repo`，`repo` 不能 import `repo`。`gen` 是允许的层。

## 证据来源

`xxww0098/podhub` 提交 `a03d735` 无法匿名克隆。没有活的 Rust 进程，也没有伪造 HTTP JSON。证据是本仓库已抄入的函数，在本机 Postgres 16 上执行，再和 Go 纯函数比较。

函数正文：

- `public.delegate_supplier_recompute_order_state(uuid, bigint)`：`db/migrations/00205_supplier_portal_actions.sql`
- `public.delegate_supplier_accept` / `reject` / `ship`：`db/migrations/00259_delegate_action_locks.sql`（替换 00205 的版本）

```
PODHUB_PARITY_DSN='postgres://postgres:postgres@127.0.0.1:5432/podhub?sslmode=disable' \
  go test ./internal/delegate/repo/ -count=1 -timeout 10m -v
```

结果（goose 291，无新迁移）：

- `TestRecomputeMatchesSQLFunction` PASS，含 `null_ready`、`rejected_null_ready`
- `TestDispatchActionsMatchSQLFunction` PASS：接单幂等、拒单回写 `last_rejected_source_id`、发货、终态、非成员、缺单
- `TestDispatchRLS` PASS

没有 Docker 且未设置 `PODHUB_PARITY_DSN` 时这些测试跳过。GitHub Actions 有 Docker。

## 已钉住

| 项 | 依据 | 测试 |
| --- | --- | --- |
| 重算：0 行 → `awaiting_setup`。包状态 `shipped` 记 live+accepted；`accepted` 再把 all_shipped 打假；`dispatched` 记 live 并把 all_shipped 打假；其余（含 rejected、cancelled、无包、未知）只把 all_shipped 打假。然后 shipped / in_production / dispatched / ready / awaiting_setup | 00205 的 `IF` 顺序 | `internal/delegate/domain/testdata/order_recompute.json` 与 `TestRecomputeMatchesSQLFunction`。返回值与 `delegate_orders.state` 都对上。`done`、`cancelled` 列不改，函数返回值仍是算出来的状态 |
| 缺绑定不是 SQL NULL。SELECT 是 `(b.active IS TRUE AND EXISTS 已核验资产)`。没有绑定行时 `NULL IS TRUE` 为假，`all_ready` 被清掉，结果是 `awaiting_setup` | 00205 第 21–24 行、第 50–52 行 | 向量「missing binding waits for setup」「rejected packet without a binding waits for setup」；集成 `null_ready`、`rejected_null_ready` 断言函数返回 `awaiting_setup` |
| 接单：找不到 → `DELEGATE_NOT_FOUND`；非活跃成员 → `DELEGATE_FORBIDDEN`；订单 `cancelled`/`done` 或包不是 `dispatched` 且也不是已 `accepted` → `DELEGATE_TERMINAL`；已 `accepted` 原样返回且不写 receipt；成功把包改为 `accepted` 并重算订单 | 00259 | `TestDispatchEdges` 与 `TestDispatchActionsMatchSQLFunction/accept_then_idempotent`。订单变为 `in_production`（未就绪绑定 + accepted 包）。receipt 仍为 NULL |
| 拒单：不是幂等。包不是 `dispatched` 或订单已终态 → `DELEGATE_TERMINAL`。成功写 receipt `reason`，并把 payload 里的行 `last_rejected_source_id` 写成该货源 | 00259 | `reject_latches_the_line`。第二次拒单为 `ErrTerminal` |
| 发货：包必须是 `accepted` 且订单非终态。receipt 写入调用方的 `tracking_no`、`note`、`now_ms` | 00259 | `ship_from_accepted`（`at_ms` 为 99，订单 `shipped`）。未接单就发货、取消单上接单、停用成员、缺 uuid、坏 uuid 分别是 terminal / forbidden / not_found |
| RLS：组织策略与货源成员策略是 OR。只设 org 只看见该 org；只设 `app.current_supplier_user_id` 只看见该货源；两个都设看见并集。缺两者在开事务前 `ErrNoTenant`。裸 `podhub_app` 无 GUC 时 `delegate_dispatches` 为 0 行，插入订单失败。org A 的事务不能插入 org B 的订单 | migration `00203` | `TestDispatchRLS` |
| 卖家取消、关闭、催单：没有对应 SQL 函数 | 迁移里不存在 | `TransitionOrder` 全部 `ErrUnproven` |
| 结算 `held`/`settled`/`released` 只有 CHECK，没有转移函数 | migration `00258` | `TransitionSettlement` 全部 `ErrUnproven` |
| `delegate.posting_sync` 的 tick 返回 `(false, nil)`，不入队、不退避、不读间隔 | `internal/queue` 未改。`DelegateSyncScan` 仍是队列包里的空转 | `TestPostingSyncTickIsIdle` |

接单、拒单、发货的写在 repo，经 service。HTTP 不调用它们，所以线上请求不会写这些表。

## HTTP

方法+路径与 `internal/app/testdata/routes.txt` 的卖家委托段相同。16 条卖家路由在会话与工作空间角色通过后进入 `service.Seller`。上游代理不在本包：`internal/seller` 注册 `GET` 和 `POST /api/seller/upstream/{uuid}/*`。资产存储与写租约以 main 的 `writer.Assert` 为准，本包不另写一套。

错误码是 snake_case（`auth_invalid`、`forbidden`、`validation`、`not_found`、`conflict`、`writes_disabled`、`storage_unavailable`、`upstream_unreachable`、`internal`）。JSON 带 `X-Content-Type-Options: nosniff`。成功是 200。`strict_json` 失败是 400 `请求格式无效`。`POST /assets` 正文上限 64 KiB，其余 JSON 2 MiB，超限同样是这句，不是 413。缺 query 字段是 `text/plain`：`Failed to deserialize query string: missing field \`storeId\``（`postingNumbers` 同理）。presign 成功和 presign/finalize 的错误带 `Cache-Control: private, no-store`；finalize 成功不带。

工作空间：`OrgID == 0` 或角色为空 → 403 `forbidden` 与「尚未加入任何工作空间」。角色无法解析 → 403「工作空间角色无效」。`owner`/`manager`/`admin` 可管理。其它已登录状态 → 500 `internal`。

`write_under_authority(Entitlement)`：presign 不进写闸。finalize 与删除进入 `writer.Assert`。匹配 `axum` + `CLOUD_INSTANCE_ID` 的未过期行允许并心跳，审计写入租约 id 与 fence。没有未撤销的行、过期、心跳窗口已死、holder 或实例不符 → 503 `writes_disabled`「委托订单写入未启用」。空表不再放行，成功写入的租约列因此非空。第一条租约用 `writer-lease bootstrap entitlement`。`LEASE_TTL_MS = 60_000`。这 16 条路由不读 `OZON_WRITE_KILL_SWITCH`。见 `docs/parity/security-hardening.md`。

生产存储：无行 → 503 `storage_unavailable`「委托原图存储未配置，请先在集成设置中配置」，此时不检查密钥。有行后密钥 trim 长度 `< 32` 是同一状态码「平台连接配置密钥未设置」；等于 `set-a-random-32-plus-character-server-secret` 是「平台连接配置密钥不能使用 .env.example 中的占位值」。`schemaVersion` 必须为 1。密封无版本字节：nonce 12 字节，AES-256-GCM 密文含 16 字节 tag，AAD `platform_integration_config|v1`，密钥 SHA-256(trim(key))，解密先试 AAD 再试无 AAD。其它解密或 schema 失败在这条 HTTP 上是 500「服务暂不可用」。`active == false` 或没有 `delegateAssetsStorage` 与无行同一句 503。明文是 camelCase `StoredConfig`。对象键 `{prefix}{org_id}/{sha256}.{ext}`。presign PUT TTL 600 秒。finalize GET 300 秒；强制校验和先 HEAD，证明不了再 GET。回收删除的 HTTP DELETE 只在已解析的媒体删除开关为开、且主机是 loopback 时发出；JSON 的 `reclaimed` 仍是 SQL 计数。Seller 读只打 loopback。店铺凭据 v1/v2 用 `seal.OpenStored`，与 `crypto-vectors.json` 对拍。旧的 `DeriveKEK` 布局没有改。

## 规格段落与测试

| 规格 | 测试 |
| --- | --- |
| `validate_file` / 对象键 / 前缀 | `TestValidateFile`、`TestAssetKey` |
| 游标、合并态、行筛选、窗口、角色 | `TestCursorMergeAndSelect`、`TestWindowAndRole` |
| 物流白名单 | `TestLogisticsWhitelist` |
| 建单快照键序 `status, substatus, in_process_at, shipment_date` | `TestFindPostingSnapshotKeyOrder` |
| query 缺字段纯文本；`limit` 类型错误句 | `TestQueryRejectionPlainText` |
| `strict_json`、Idempotency-Key 在 JSON 之后、postings 默认 30/50 | `TestStrictJSONAndIdempotency` |
| presign `Cache-Control`、checksum 头、finalize 成功不带该头 | `TestPresignCacheControl` |
| 写闸改前谓词 vs Rust `Decide` | `TestDecideMatchesRustNotTheOldChecks` |
| 集成配置与店铺凭据向量 | `TestCryptoVectors` `TestDelegateSnapshotAndCredentialVectors` |
| 管理端 camelCase 快照与委托/媒体/支付同一份文档；旧 snake_case 重写 | `TestSnapshotReadersShareCamelDocument` `TestAdminWriteRoundTripAndSnakeRewrite` `TestPaymentReadsAdminCamelAndRewrittenSnake` `TestReadSnapshotRewritesSnakeAndLeavesCamel` |
| presign/finalize/删除的 loopback 与故障 | `TestDelegateIssueConfirmDeleteLoopback` `TestDelegateChecksumHead` `TestDelegatePlaintextHTTPIsRefused` |
| 资产路由错误体逐字节 | `TestAssetRouteErrorBytes` |
| finalize 把存储 409 改成 422；登录再检查 | `TestFinalizeRewritesStorageConflict` `TestFinalizeRecheckSession` |
| 鉴权 snake_case、无工作空间、非法角色、其它状态改 500 | `TestAuthSnakeCase` |
| 厂家列表信封；viewer 可读 | `TestSourcesEnvelope` |
| 上游不在本包 | `TestUpstreamLeftThisRouter` |
| `DELEGATE_AUTO_DISPATCH` | `TestDelegateAutoDispatch` |
| 绑定 RLS：跨店不可见；裸 `podhub_app` 无 GUC 为 0 行 | `TestSellerBindingsRLS`（无 DSN/Docker 时跳过） |
| 供应商重算 / 接单拒单发货 / 派发 RLS | `TestRecomputeMatchesSQLFunction`、`TestDispatchActionsMatchSQLFunction`、`TestDispatchRLS` |
| 卖家取消/关闭/催单不是 SQL 函数 | `TransitionOrder` → `ErrUnproven` |
| 路由表与 OpenAPI 路径 | `TestRouteTableMatchesGolden`、`TestOpenAPIListsDelegateRoutes` |

## 优化

卖家重算调用已经和 `delegate_supplier_recompute_order_state` 对过拍的 `domain.ComputeOrderState`，不另写一条状态机。

`promote` 与 `recomputeStore` 不再对每单各做一次行子查询。未完成订单 id 仍按原顺序收集后，一条 `WHERE l.order_id = ANY($1::uuid[])` 取出 `ready` 和 `packet_state`，在 Go 里按订单分组（没有行的订单分组为空，仍会更新），再按该 id 顺序调用 `ComputeOrderState` 和原来的 `UPDATE delegate_orders`，然后按同一顺序调用 `dispatchReady`。单笔 `recompute` 仍留给 `dispatchReady` 末尾和 `insertOrder`。`dispatch_no` 仍是 `domain.NewDispatchNo`。每个新建派发在 `seenAsset` 去重后，一条 `unnest` 插入 `delegate_dispatch_assets`，列和 `ON CONFLICT (dispatch_id, asset_id)` 不变；`ErrNoRows` 时仍跳过素材。`TestRecomputeBatchParity` 用逐单 `recompute` + `dispatchReady` 作对照：每单 `state`、`updated_at_ms`，以及新建派发除 `dispatch_id` / `dispatch_no`（两次执行各自生成）以外的列、素材 `(order_id, source_id, asset_id, org_id)` 一致。50 个未完成订单、`auto=false`：行查询 1 条，`UPDATE delegate_orders SET state` 50 条。`TestDispatchAssetBatchParity` 在同一个 `dispatch_id` 上对照逐行插入，`(dispatch_id, asset_id, org_id)` 一致，素材插入语句数 1。`BenchmarkRecomputeOrders`（50 单，`auto=false`，每次回滚，`-benchtime=1s`）：`5157745 ns/op`。

管理端读到 snake_case 快照时，用同一把密钥和同一条 AAD 把明文重封成 camelCase，revision 不变。业务字段不变，所以委托、媒体、支付解出来的账号和支付段与重写前的 snake 文档相同。camelCase 行不重写。冻结退回的钱包 SQL 抄在 delegate repo 里，因为 `billing` 的 `ReleaseTx` 会在同一事务里 `RESET ROLE`，审计插入会发生在角色掉下去之后。退回的金额、幂等键和备注与规格相同。审计 JSON 用结构体字段序，避免 `encoding/json` 把 map 按字母序重排。

## 未分配

代理提成七条路由不在本任务。它们已由 agent 域实现，见 `docs/parity/agent-parity.md`。本改动不碰那些文件。

## 需要用户决定

- Caddy `request_body max_size` 的响应正文未确认。本实现只按规格里的池限制：确认 64 KiB，其余 JSON 2 MiB，超限 400「请求格式无效」。
- 已确认。`EXAMPLE_CONFIG_KEY` 与 `delegateAssetsStorage` 明文以规格 X3-C 和 `crypto-vectors.json` 为准。有密文不再返回 501。
- 已确认。`LEASE_TTL_MS = 60_000`。`writer.Assert` 先 `FOR UPDATE` 未撤销行，再 `EXISTS` 该域是否曾经租过，持有时心跳。
- `ORDER_ROW_COLUMNS` 宏、`load_binding_view`、`load_order_row` 的函数体未贴出。列表列与绑定视图按规格里的 SELECT 重建。
- `platform_integration_config` 在本仓库没有 RLS。读取用普通查询，不设组织 GUC。
- 已确认。Rust 密封的店铺凭据 v1/v2 由 `seal.OpenStored` 打开，`TestCryptoVectors` 逐向量通过。旧 `DeriveKEK` / `OpenStore` 仍服务其它调用点，委托路径不再使用它。
- 回收删除的 HTTP DELETE 在已解析媒体删除开关为关时不发出。规格 C 的删除段没有提到 `CLOUD_MEDIA_GC_DELETE`。JSON `reclaimed` 仍是 `delegate_dispatch_assets` 计数为 0。开关只经 `Config.MediaDeleteEnabled()`，域代码里没有该环境变量字符串。非 loopback 主机在拨号前拒绝。
- 已修复。管理端 `domain.Snapshot` 与 `seal.Snapshot` 使用同一份 camelCase 文档（`schemaVersion`、`aiAccounts`、`mediaAccounts`、`delegateAssetsStorage`、`payment`）。委托、媒体、支付读取这份明文。已落库的 snake_case 行由管理端先按 camelCase 解密，失败再按 snake_case 读入，并用同一套 AES-GCM（AAD `platform_integration_config|v1`）重写成 camelCase，不另做密文，revision 不增加。测试：`TestSnapshotReadersShareCamelDocument`、`TestAdminWriteRoundTripAndSnakeRewrite`、`TestPaymentReadsAdminCamelAndRewrittenSnake`、`TestReadSnapshotRewritesSnakeAndLeavesCamel`。
- 店铺名册写（「店铺名册写入未启用」）没有已移植的写路由，没有新增。
- 规格里的 `tenant_txn` 只 `set_config` 组织 GUC，不 `SET ROLE`。本仓库按约束一律 `BeginApp`（`podhub_app` + GUC）。`GET /sources` 也走这个事务；`sc_sources` 没有 RLS，结果与「无事务」相同。
- query 类型错误的 serde Display 未逐字节确认。`limit=abc` 目前返回纯文本 `Failed to deserialize query string: invalid digit found in string`。缺字段的句子是确认过的。
- Ozon 响应除测试 mock 的顶层 `postings` 和 `result` 包装外，字段类型未展开。两种都接受。
- 催单没有 Rust 测试 JSON。冷却 30 分钟、只更新 `dispatched`/`accepted`，按规格实现。
- 这 16 条路由的 Seller 读不经过 `seller.Egress` 槽位和频率预留，因为 `Egress.Read` 不设置 `Client-Id` / `Api-Key`。只打 loopback。
- 上游代理归 `internal/seller`，路径是 `{uuid}/*`。`%2F` 与 Caddy 413 仍未逐字节确认。
- oapi-codegen 仍未选定为 utoipa 的替代。`internal/delegate/http/gen` 仍只有包注释。
- 缺绑定使 `b.active IS TRUE` 为假，从而 `awaiting_setup`。这与 00205 的执行结果一致。
- `delegate_settlements` 没有转移函数。供应商结算状态机仍是 `ErrUnproven`。卖家撤单/收口按规格里的 UPDATE 退回冻结，不调用那个状态机。
- `delegate.posting_sync` 的 tick 仍空转。本任务不改 `internal/queue`。
