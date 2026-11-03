# supply：和 Rust 对过什么

层级 L3。`tests/archtest` 无新增违规。装配在 `internal/app/wire_supply_delegate_supplier.go`。会话适配把 `WorkspaceRole` 传进 handler。本域不解析 `OZON_WRITE_KILL_SWITCH` 或 `CLOUD_MEDIA_GC_DELETE`，也不调用 Seller。

早期 10 条路由以规格 `spec-dsa-supply`（Rust v0.0.112，HEAD `7df856a`）移植。当前仅挂载三个目录 GET；SKU、绑定和 `/api/platform-orders` 相关 HTTP 入口均已撤下。下文保留内部订单/报价与原移植测试的历史证据，不把它们算作现行接口。`TransitionOrder` / `TransitionProcurement` 仍对每一对状态返回 `ErrUnproven`。确认订单只插入 `awaiting_payment`，不在 Go 里推进后续边。

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

当前只有以下三条，公开目录匿名，其余要求可解析的工作空间角色。注册事实来自 `internal/supply/http/handler.go`，与 `internal/app/testdata/routes.txt` 一致。

| 方法 | 路径 | 状态 |
| --- | --- | --- |
| GET | `/api/public/platform-catalog` | 200，`Cache-Control: public, max-age=60, stale-while-revalidate=300` |
| GET | `/api/platform-catalog` | 200，无缓存头 |
| GET | `/api/platform-catalog/products/{product_id}` | 200 `data.product`，否则 404 |

原 SKU、binding、报价和平台订单接口不再列为当前操作步骤。仓储函数与旧测试仍可用于追溯历史实现。

历史确认函数使用 `writer_leases.domain = entitlement`。匹配 `axum` 与 `CLOUD_INSTANCE_ID` 的未过期行允许，把心跳写成这次的 `now`，过期写成 `now + 60000`。没有未撤销的行、过期或身份不符则 503 `WRITES_DISABLED`，文案「平台订单写入未启用」。第一条租约用 `writer-lease bootstrap entitlement` 写入。这是相对 Rust X3-B 的已确认行为变化，见 `docs/parity/security-hardening.md`。

## 历史内部实现与优化

- 原移植把目录、绑定、报价和订单放入 `BeginApp`。当时目录表没有 RLS；当前 `sc_products`、`sc_skus` 已强制启用目录 RLS，发布数据可读，未发布数据及写入按 staff、目录管理员、供应商或卖家绑定策略限制。`sc_orders` 与 `sc_order_lines` 则使用租户 `tenant_isolation`。两者不是同一套隔离规则。
- 报价的几条语句放在一个事务里提交。规格是每条自动提交，唯一约束冲突后再查。冲突时本实现回滚并按同一哈希重读。提交后的报价行相同。
- 卖家 SKU 的 SELECT 不取出随后丢弃的运费列，但保留运费 JOIN，避免少乘出行。
- 确认订单在插入前使用 SAVEPOINT。唯一冲突后回到保存点，再按幂等键读已存在的订单。支付单不会留下半截行。

## 需要用户决定

- 正文超过 2MiB 时写成 400 `请求格式无效`。规格标明裸 413 正文未确认。
- 身份中间件在 handler 之前把解析失败写成 Cloud 503。规格要求本域把非 401/403 的鉴权错误改成 500 `INTERNAL`。没有改身份中间件。
- 当前 `sc_products`、`sc_skus` 的目录 RLS 与 `sc_orders`、`sc_order_lines` 的租户 RLS 都在基线 `00002_schema.sql` 里。`sc_listing_bindings`、`sc_order_quotes` 仍依赖 SQL 中的 `org_id`。原移植时「六表都无 RLS」的结论已失效。
- 付款、认领、派发、收货不在这 10 条里。`TransitionOrder` 继续全部拒绝。
- 生成链已由 [决策 D2](../decisions.md) 确认；supply 的生成范围以 `api/codegen/supply.yaml` 为准，当前挂载仍由 `internal/supply/http/handler.go` 的三条 GET 决定。
