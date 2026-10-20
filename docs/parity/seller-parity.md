# Seller 出口对照（PR-6）

对照提交：Rust `a03d735`。`OZON_WRITE_KILL_SWITCH` 只在 `internal/config` 解析一次。`seller.Egress` 只读 `config.OzonWritesDisabled()`，没有第二套解析。读和探测不看这个开关。

## 出口

`CLOUD_SELLER_BASE_URL` 的接受条件和 `src/store/egress.rs` 的 `is_loopback_origin` 相同：`http`、loopback 主机、显式端口、路径 `/`、没有用户信息、查询和片段。其它值在 Rust 里会回到 `https://api-seller.ozon.ru`。本进程即使落到这个生产源也拒绝拨号（`ErrRefusedOrigin`），计数保持 0。这是安全约束，不是结果等价。

L1 是 `src/lease/mod.rs` 的 `RESERVE_SQL`，原样放在 `internal/seller/budget.go`。时钟只用 `clock_timestamp()`。集成测试对 `lease_budget` 做了一次成功预留。L2 槽位：读 8、交互读 4、写 2、交互写 2，合计 16。默认速率：普通 5/s 突发 10，分析 1/s 突发 1，目录间隔 2s 突发 1。目录路径只有四条：`/v3/product/list`、`/v3/product/info/list`、`/v4/product/info/stocks`、`/v5/product/info/prices`。`/v3/product/import` 留在 default。

## 上游代理

`GET` 与 `POST /api/seller/upstream/{uuid}/*` 在 `internal/seller.MountUpstream`。允许表 31 条，先于数据库。chi v5 把 `{name:*}` 当成单段正则，所以捕获用末尾 `*`。`URL.Path` 会把 `%2F` 解成斜杠，chi 的 `*` 仍保留编码，允许表对不上，现为 403。读路径不查 kill switch。超 2MiB 的正文是 413 `Failed to buffer the request body`，`Content-Type: text/plain; charset=utf-8`。

## 对账探测

`UnknownImportsScan` 调用 `submit.ProbeDue`。认领 SQL、`stamp_accept`、`stamp_release`、`stamp_retry` 抄自 `src/listing/kernel/submission/import_reconcile.rs`。

- 认领在读之前提交。窗口 2 分钟，`FOR UPDATE SKIP LOCKED`，上限夹到 1..64。
- 有 `id > 0` 的商品立刻 `unknown → accepted`，`reconciliation_outcome.found.{productId,sku}`，行 `accepted`。
- 一次 `absent` 只记 `probe.{passes,observation}` 并退避（60s 起、翻倍、封顶 900s）。
- 连续两次 `absent` 才 `superseded`，写下 `probeReleased.{atMs,passes}`，行回到 `none`。
- 读失败或非 2xx 是 `unreadable`，不记成缺失，也不调用 `/v3/product/import`。
- 第 8 次仍不能接受或释放：`OZON_RECONCILE_STILL_UNKNOWN`，`reconcile_after` 置空。
- 没有 `store_seller_credentials` 行时整批 `unreadable`，和 Rust 加载凭据失败的分支一样。

`atMs` 用进程 UTC 毫秒，对应 Rust 的 `chrono::Utc::now().timestamp_millis()`。两次进程的数值不会相同，字段和单位相同。

## 七个扫描

名字和间隔仍是 `internal/queue` 里已经锁定的那七个，没有改。

| 扫描 | 这次 |
| --- | --- |
| UnknownImportsScan | 上面的探测 |
| UnknownWritesScan | 空转。`reconcile_due_unknown_batch` 没接到 |
| ProductSyncScan | 空转。批量仍是 0，因为现有测试锁定了它 |
| ProductSyncCleanupScan | 空转 |
| DelegateSyncScan | 空转。`DELEGATE_SYNC_INTERVAL_MS` 的间隔没改 |
| ProductGroupingScan | 空转 |
| AcceptedImportsScan | 空转 |

空转会打日志 `reconcile scan has no ported writer` 并返回 idle，不插入任务。

## 写账

`seller_upstream_writes` 只实现 CHECK 允许的四条：`dispatching → settled`、`dispatching → result_unknown`、`result_unknown → reconciled`、`result_unknown → conflict`。后两条有纯函数，提交路径还没有调用方。只有 `settled` 带 `response_status` 和 `response_body`。

占用只做 `held → released`，释放原因必须是 CHECK 里的四个字面量。
