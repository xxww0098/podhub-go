# 只读 GET 对拍（PR-2）

对照 `xxww0098/podhub` 提交 `a03d735`。这一批只做不写库、不调用外部写入的 GET。`app.Handler` 把 `identity.Service` 注入 `access.Resolver`：会话解析出 `user_id`、`org_id`、库存工作空间角色和平台角色。测试仍可用 `FixedResolver` 注入主体。未登录按 401 处理。已确认 TOTP 的逐步提升没有接上，见 [identity-parity.md](identity-parity.md)。

## 这一批端点

| 领域 | 方法 | 路径 | Rust |
| --- | --- | --- | --- |
| 配置读取 | GET | `/api/me/catalog/banned-tags` | `banned_tags/http.rs` `list_enabled` |
| 列表 | GET | `/api/admin/banned-tags` | `list_admin` |
| 统计 | GET | `/api/billing/usage-stats`（`rollup=1` 附主管汇总） | `billing_usage_stats` + `billing_usage` |
| 列表 | GET | `/api/listing/jobs` | `row_reads.rs` `list_runs` |
| 详情 | GET | `/api/listing/jobs/{id}` | `get_run` |

租户读在事务里 `SET LOCAL` 角色 `podhub_app` 并设置 `app.current_org_id`（`internal/tenant.EnterApp`），SQL 同时带 `org_id` 谓词。`banned_tags` 没有 RLS，按 Rust 不进租户事务。`ai_requests` 与 `billable_usage_rollups` 不在 RLS 表里，隔离靠 `org_id`；事务仍设置 GUC，这样以后如果挂上同一条策略，读路径不用再改。

`OZON_WRITE_KILL_SWITCH` 与 `CLOUD_MEDIA_GC_DELETE` 没有改。这些 GET 不拨号、不删对象。压测仍只有 Mode R。

## 优化，以及结果为什么不变

1. **禁用标签一秒钟进程缓存。** 与 `store.rs` 的 `CACHE_TTL` 相同：命中且未满 1 秒直接返回上一份规则；写操作不在本批，所以没有 `invalidate` 的生产调用，也没有 `LISTEN`。同一秒内规则行不变，响应字节不变。未知 `match_mode` 仍被丢掉。
2. **用量汇总和明细分两次查询，不包成可重复读快照。** Rust 用 `try_join` 并发两条语句，默认隔离级别是 read committed。Go 把两条语句放进同一个事务，只为了 `SET LOCAL` 角色；隔离级别仍是 read committed，所以两条语句各自看见已提交的行，不是一份快照。表不动时字节相同。
3. **jsonb 重新编码。** PostgreSQL 的 jsonb 文本带空格。`serde_json::Value` 是按键排序的紧凑 JSON，且不转义 `&`。Go 用 `SetEscapeHTML(false)` 再编码，键排序与 serde 的 `BTreeMap` 一致。结构体字段顺序按 Rust 结构体书写顺序，空的 `Option` 省略，空数组编码成 `[]`。
4. **时钟只取一次。** `generated_at_ms` 和默认 `from` / `to` 用请求开始时的同一个时刻，对应 `now_millis()`。测试注入固定时刻，所以 golden 里的数字是算出来的，不是抹掉的。
5. **`list_jobs` 的第二道 100 上限照抄。** 请求 `limit=100` 时 Rust 先取 `101` 再被函数内的 `clamp(1, 100)` 截回 `100`，因此满页不带 `nextCursor`。这里没有把它「修好」。`limit=50` 仍会多取一行来生成游标。
6. **sqlc 参数写成 `::bigint`，卡片过滤把 `org_id` 写成 `jobs.org_id`。** 绑定的值和谓词与 Rust 相同，只是让生成器接受语句。

## 已验证

不依赖数据库的测试锁住：错误包字段顺序和文案、用量聚合排序、缓存命中率、分页代数、游标解析、满页不返回游标、运行视图的 jsonb 键序和 `&`。

有 Docker，或设置了 loopback 的 `PODHUB_PARITY_DSN` 时，集成测试对上表每个端点做状态码和响应字节比较，并在全部 GET 之后用 `parity.DiffCounts` 确认公开表行数不变。作业列表跨组织不可见（另一组织的作业是 404，行还在）。卡片过滤只返回本组织、且 `listing_rows.card_id` 对上的作业。两者都没有时，该测试跳过。

2026-10-16 在本机 PostgreSQL 16.15（`127.0.0.1`，`PODHUB_PARITY_DSN`）上 `go test ./...` 通过，其中 `TestReadOnlySurface` 覆盖上述端点。

这些 golden 来自同一条 SQL 和 serde 字段顺序，不是一台正在跑的 Rust 进程。

## 不能证明一致

- 没有把同一请求打到 `a03d735` 的进程上比字节。
- 会话由 `identity.Service.Resolve` 解析。工作区角色来自会话查询里的成员资格，不再由测试替身单独注入到生产进程。已确认 TOTP 的逐步提升仍不在这些 GET 上执行，因此不能证明超级管理员二次验证与 Rust 相同。
- 非数字 `limit`（例如 `limit=abc`）在 Rust 里是 axum 的 Query 反序列化拒绝，正文不是本仓库返回的 `{"error":"limit 无效","code":"validation"}`。数字 `limit` 的夹取与 Rust 一致。
- 用量明细的列映射有单元 golden，集成测试只跑到空区间（`ai_requests` 的外键和金额约束没有插入样例行）。空区间仍会执行汇总和分页 SQL，缺列会得到 500。
- 用量两条语句在并发写入时，Go 的先后顺序和 Rust 的 `try_join` 可能各看见一次提交。静止表上相同。
- `created_at::text` 依赖 PostgreSQL 的 DateStyle。本测试库是默认 ISO。换 DateStyle 会改变管理端禁用标签的 `createdAt`，Go 与 Rust 会一起变，因为两边都是这个 cast。
- 下列 GET 不是纯读，或投影依赖 `listing-core`，本批没有实现，也不宣称字节一致：商品卡、商品行、Intent、目录树、目录 schema、目录抓取配置、`/api/listing/events`（SSE）、套餐列表。

## 留给决定的事

- oapi-codegen 是否取代 utoipa。本批沿用骨架里的 oapi-codegen，只生成路由。查询串在 Go 里解析，避免生成器用英文 400 替换 Rust 的中文校验。
- 禁用标签匹配已经用窄 wasm 和 wazero（见 [listing-core-host.md](listing-core-host.md)）。卡、行、Intent 的读投影仍依赖完整 `listing-core`，不能当作已移植。浏览器那份 wasm 要不要换上来，还没有决定。
- 下一批只读端点先做哪一组。
- 非数字 `limit` 的拒绝正文，是改成与某一版 axum 相同，还是保持现在这条中文校验。
