# supply：和 Rust 对过什么

层级 L3。`tests/archtest` 无新增违规。装配在 `internal/app/wire_supply_delegate_supplier.go`。会话适配把 `WorkspaceRole` 传进 handler。本域不解析 `OZON_WRITE_KILL_SWITCH` 或 `CLOUD_MEDIA_GC_DELETE`，也不调用 Seller。

这 10 条路由的行为以规格 `spec-dsa-supply`（Rust v0.0.112，HEAD `7df856a`）为准。`TransitionOrder` / `TransitionProcurement` 仍对每一对状态返回 `ErrUnproven`。确认订单只插入 `awaiting_payment`，不在 Go 里推进后续边。

## 证据

```
go test ./internal/supply/domain/ ./internal/supply/http/ ./internal/supply/service/ -count=1
PODHUB_PARITY_DSN='postgres://postgres:postgres@127.0.0.1:5432/podhub?sslmode=disable' \
  go test ./internal/supply/repo/ -count=1 -timeout 10m
```

本机 Postgres 16：`TestBindingOrgFilterAndMissingRLS` 与 `TestQuoteConfirmIsolatesOrg` PASS。没有 Docker 且未设置 `PODHUB_PARITY_DSN` 时跳过。GitHub Actions 有 Docker。

没有活的 Rust 进程。JSON 字段顺序按规格结构体，`specs` 按键排序。

## 规格对照

| 规格 | Go 测试 |
| --- | --- |
| 命名订单边只有五条；其它对非法。这些路由不写后四条 | `TestNamedOrderEdgesAndIllegals` |
| 请求哈希每个字段后跟 NUL；数量、幂等键、SKU、生产文件、图库路径 | `TestHashAndValidation` |
| 公开目录无价格、带缓存头；卖家目录无缓存头；非法 UUID 404；数量 400；未知字段 400；空报价 400；删除 200 `{ok:true}`；无工作空间 403；坏角色 403 | `TestSupplyRoutes` |
| OpenAPI 含四条新增路径 | `TestOpenAPIListsSupplyRoutes` |
| specs 非字符串则整表为空；快照缺键回退列值；绑定快照键序 | `TestJSONSpecsAndSnapshot` |
| 绑定按 org 过滤；表没有 RLS，裸角色仍能看见两行 | `TestBindingOrgFilterAndMissingRLS` |
| 缺 org 的旧列投影在开事务前拒绝 | `TestGetBindingRequiresOrg` |
| 未绑定报价 400；绑定后单价 1250、数量 2、金额 2500；同一幂等键不刷新过期时间；非所有者 403；确认 `awaiting_payment` 且支付号以 `pg_` 开头；重放同一订单；别的工作空间 GET 404；公开目录能看见已上架商品；已有 entitlement 租约则 503 | `TestQuoteConfirmIsolatesOrg` |

## HTTP

十条都已挂上。公开目录匿名。其余要可解析的工作空间角色，不再查 Capability。只有确认订单再查 `organizations.owner_user_id`。

黄金路由表补了四行。这四条之前没有进 `internal/app/testdata/routes.txt`：

- `POST /api/platform-orders`
- `POST /api/platform-orders/quotes`
- `GET /api/platform-orders/{order_id}`
- `GET /api/public/platform-catalog`

| 方法 | 路径 | 状态 |
| --- | --- | --- |
| GET | `/api/public/platform-catalog` | 200，`Cache-Control: public, max-age=60, stale-while-revalidate=300` |
| GET | `/api/platform-catalog` | 200，无缓存头 |
| GET | `/api/platform-catalog/products/{product_id}` | 200 `data.product`，否则 404 |
| GET | `/api/platform-catalog/skus/{sku_id}` | 200 `data.sku`，否则 404 |
| GET | `.../binding` | 200 `data.binding` |
| PUT | `.../binding` | 200，last-write-wins，无客户端 CAS |
| DELETE | `.../binding` | 200 `{"data":{"ok":true}}`；第二下 404 |
| POST | `/api/platform-orders/quotes` | 200 `data.quote` |
| POST | `/api/platform-orders` | 200 `data.order`，仅所有者，并写审计 |
| GET | `/api/platform-orders/{order_id}` | 200 或 404 |

确认订单使用 `writer_leases.domain = entitlement`。匹配 `axum` 与 `CLOUD_INSTANCE_ID` 的未过期行允许，并把心跳和过期写成这次的 `now`。没有未撤销的行、过期或身份不符则 503 `WRITES_DISABLED`，文案「平台订单写入未启用」。第一条租约用 `writer-lease bootstrap entitlement` 写入。这是相对 Rust X3-B 的已确认行为变化，见 `docs/parity/security-hardening.md`。

## 优化

- 目录、绑定、报价、订单都用 `BeginApp` 把角色设成 `podhub_app`。`sc_products`、`sc_skus`、`sc_listing_bindings`、`sc_order_quotes` 仍没有 RLS。`sc_orders` 与 `sc_order_lines` 在迁移 00294 有 `tenant_isolation`。确认订单的 GUC 就是这笔订单的 `org_id`，写入的行与加策略之前相同。
- 报价的几条语句放在一个事务里提交。规格是每条自动提交，唯一约束冲突后再查。冲突时本实现回滚并按同一哈希重读。提交后的报价行相同。
- 卖家 SKU 的 SELECT 不取出随后丢弃的运费列，但保留运费 JOIN，避免少乘出行。
- 确认订单在插入前使用 SAVEPOINT。唯一冲突后回到保存点，再按幂等键读已存在的订单。支付单不会留下半截行。

## 需要用户决定

- 正文超过 2MiB 时写成 400 `请求格式无效`。规格标明裸 413 正文未确认。
- 身份中间件在 handler 之前把解析失败写成 Cloud 503。规格要求本域把非 401/403 的鉴权错误改成 500 `INTERNAL`。没有改身份中间件。
- `sc_products`、`sc_skus`、`sc_listing_bindings`、`sc_order_quotes`、`sc_orders`、`sc_order_lines` 没有 RLS。隔离靠 SQL 里的 `org_id`。裸 `podhub_app` 仍能读全部绑定。本阶段不写迁移。
- 付款、认领、派发、收货不在这 10 条里。`TransitionOrder` 继续全部拒绝。
- oapi-codegen 仍不是已选定的 utoipa 替代。`internal/supply/http/gen` 仍只有包注释。
