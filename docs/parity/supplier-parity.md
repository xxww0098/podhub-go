# supplier：和 Rust 对过什么

层级 L3。`tests/archtest` 无新增违规。装配在 `internal/app/wire_supply_delegate_supplier.go`：`tenant.BeginApp` 由 app 传入，循环地址的对象账号经 `WithBlobs` 注入。本域不解析 `OZON_WRITE_KILL_SWITCH` 或 `CLOUD_MEDIA_GC_DELETE`，也不调用 Seller。

这 12 条路由的行为以规格 `spec-dsa-supplier`（Rust v0.0.112，HEAD `7df856a`）为准。旧的 CHECK-only `domain.Request` / `TransitionWithdrawal` 仍返回 `ErrUnproven`，HTTP 提现走 `CheckWithdrawal` 和 `CreateWithdrawal`。

## 证据

```
go test ./internal/supplier/domain/ ./internal/supplier/http/ ./internal/supplier/service/ -count=1
PODHUB_PARITY_DSN='postgres://postgres:postgres@127.0.0.1:5432/podhub?sslmode=disable' \
  go test ./internal/supplier/repo/ -count=1 -timeout 10m
```

本机 Postgres 16：`TestWalletRLS` PASS。没有 Docker 且未设置 `PODHUB_PARITY_DSN` 时该测试跳过。GitHub Actions 有 Docker。

没有活的 Rust 进程。HTTP 信封按规格里的结构体字段顺序编码，不另造一份。

## 规格对照

| 规格 | Go 测试 |
| --- | --- |
| 派发边：accept / reject / ship，终态订单优先，拒绝和发货不可重放 | `TestDispatchEdges` |
| 列表状态只接受空、dispatched、accepted、shipped；游标 `0\|deadline\|uuid` 或 `1\|\|uuid` | `TestFilterAndCursor` |
| 拒因 1–500、运单 0–128、备注 0–500；提现账号 1–64、姓名 1–32、渠道精确匹配、金额 100..=100_000_000 | `TestRejectShipWithdrawalText` |
| 图片 source id、64 位十六进制文件名、边长 256/640/1280；可上架谓词；Accept 含 `q>0` 才要 JSON | `TestCatalogImageAndListability` |
| 门户错误蛇形、厂家库错误大写；未登录、403 鉴权折成 500、非法状态、缺 Content-Type、缩略图边长、JSON 授权头 | `TestSupplierAuthAndValidation` |
| OpenAPI 路径仍在 | `TestOpenAPIListsSupplierRoutes` |
| 钱包 RLS：跨成员看不见、缺 GUC 插不进 | `TestWalletRLS` |
| 旧的 CHECK-only 提现助手仍不写表 | `TestRequestWithdrawalDoesNotPersist` |

## HTTP

十二条都已挂上真实处理，不再返回 `not_ported`。门户要已登录用户，不要求工作空间。厂家库同样只认登录；非 401 的鉴权状态折成 500 `INTERNAL`。

| 方法 | 路径 | 状态 |
| --- | --- | --- |
| GET | `/api/supplier-dbs/catalog` | 200，`data.dbs/propDefs/rows` |
| GET | `/api/supplier-dbs/catalog/images/{source_id}/{file}` | 200 图片，或 400/404/503 |
| GET | `/api/supplier/dispatches` | 200 分页 |
| GET | `/api/supplier/dispatches/{dispatch_id}` | 200 `data.dispatch` |
| POST | `.../accept` | 不读 JSON。SQL `delegate_supplier_accept` |
| GET | `.../assets/{asset_id}` | JSON 授权或字节 |
| POST | `.../reject` | SQL `delegate_supplier_reject` |
| POST | `.../ship` | SQL `delegate_supplier_ship` |
| GET | `/api/supplier/me` | 200 `data.sources` |
| GET | `/api/supplier/wallet` | 200 |
| GET | `/api/supplier/withdrawals` | 200 |
| POST | `/api/supplier/withdrawals` | 200，写厂家钱包而不是用户钱包 |

接单、拒单、发货、提现进 `writer_leases` 的 `admin` 门（规格 `CapabilityDomain::Admin`，不是 entitlement）。匹配 `axum` 与 `CLOUD_INSTANCE_ID` 的未过期行允许并心跳。没有未撤销的行则拒绝，文案「厂家门户写入未启用」。过期或身份不符同样是 503 `writes_disabled`。第一条租约用 `writer-lease bootstrap admin` 写入。一条 entitlement 租约不再挡住厂家门户。这是相对 Rust X3-B 的已确认行为变化，见 `docs/parity/security-hardening.md`。

## 优化

- 接单/拒单/发货把规格里的预检和写入放进同一个 `podhub_app` 事务。状态仍由 SQL 函数决定。副作用顺序仍是：租约、GUC、函数、资金、审计、通知、提交。结果与分两次读再写相同，少一次往返。
- 缩略图没有 32MiB 进程缓存。同一请求的字节不变，只是每次都读对象。
- 列表 SQL 只选出响应要用的列。过滤和排序与规格相同。

## 需要用户决定

- `ocr_prompt::validate_brief` 的函数体不在规格里。可上架检查在其它条件都过时把 `PromptValid` 固定为 false，因此会落到 `prompt_invalid`。没有猜校验规则。
- 缩略图用最近邻缩小、白底、JPEG quality 75。规格里的 Rust 滤镜是 Triangle。解码失败时退回原始字节。字节不会和 Rust 逐字相同。
- 正文超过 2MiB 时，本实现把 JSON 写成 400 `请求格式无效`。规格写明 axum 的裸 413 正文未确认，所以没有发明 413 正文。
- 身份中间件在进入 handler 之前，把解析数据库失败写成 Cloud 503 `服务繁忙，请稍后重试`。规格要求厂家门户把非 401 的鉴权失败折成 500 `internal`。没有改身份中间件。
- 对象存储只接受注入的循环地址账号。集成配置快照是加密的，本域不解密，也不访问真实 R2。
- 物流字段里空字符串是省略还是保留空串，规格标了未确认。当前保留 JSON 里的空串指针策略与读出的字符串一致：空串会进响应。
- 管理员把提现标成 paid 或 rejected 不在这 12 条里。`TransitionWithdrawal` 仍全部 `ErrUnproven`。
- oapi-codegen 仍不是已选定的 utoipa 替代。`internal/supplier/http/gen` 仍只有包注释。
