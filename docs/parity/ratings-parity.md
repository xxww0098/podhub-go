# 店铺评级同步与健康度

对照任务 RT1。Rust 版已退役，这里不引用 Rust 源码。Seller `POST /v1/seller/info` 的形状来自任务说明：`ratings[]` 含 `rating`、`name`、`current_value`、`past_value`、`value_type`、`status`。`past_value` 可为 null。`value_type` 已见到 `RATIO` 与 `REVIEW_SCORE`，其它字符串原样保存。已见到的 `status` 全是 `UNKNOWN`；其它取值没有官方文档，原样保存，不猜测好坏顺序。

开工时 main 为 `5caa713`（当时迁移最大号 `00320`）。合并 `d6c0b8f` 后，00325–00329 是仓库表，评级仍用 00335–00337。ST1 的「刷新店铺信息」函数不在这棵树上。接入点是 `internal/app/worker/ratings.go` 的 `ratingSource.Post`：它打开本店信封后，用 `seller.Egress.Call` 对 `POST /v1/seller/info` 发只读请求（`write=false`）。这条路径走现有的限速和 `httpx.OzonClient`，非回环基址不拨号。ST1 合并后，把 `ratingSource.Post` 改成调用那次刷新，不要再自己拼路径。

## 数据

| 迁移 | 内容 |
| --- | --- |
| 00335 | `store_rating_snapshots`（最新快照）和 `store_rating_sync`（90 秒租约 + 上次成功时间）。两张表 `FORCE ROW LEVEL SECURITY`，策略 `tenant_isolation` 只给 `podhub_app` |
| 00336 | `store_rating_history`。只在 `status` 或 `current_value` 变化时追加。`recorded_at` 超过保留期由清理任务删除 |
| 00337 | `notifications.kind` 增加 `store_rating_worsened`。原有五个 kind 和顺序不变，没有新列 |

`organization_stores` 在领取时不加 `FOR UPDATE`。读列表的 SQL 也不加 `FOR UPDATE`（`TestListDoesNotLock`）。

默认保留 90 天（`domain.DefaultRetention`）。默认同步间隔 6 小时（`domain.DefaultSyncInterval`）。环境变量只在 `internal/platform/config` 解析：`STORE_RATING_SYNC_INTERVAL`、`STORE_RATING_RETENTION`、`STORE_RATING_STATUS_RANK`。空或无法识别的间隔和保留期回到默认值。状态映射默认只有 `UNKNOWN=0`。数字越大越差。只有新旧状态都在映射里、且新的更差，才写一条站内通知。默认映射因此不会触发。

错开方式：River 按 15 分钟（间隔更短时按间隔本身）跑一轮，只领取 `organization_stores.id % 槽数` 等于当前时间槽的店。一轮最多 25 店。HTTP 在租约事务提交之后才发出。

失败只打 `slog`，不带上客户端编号或密钥。字段里出现密钥形状的项被丢掉，约束也拒绝写入。

## 读取

- `GET /api/workspaces/stores/{uuid}/ratings`
- `GET /api/workspaces/stores/{uuid}/ratings/history`（`limit` 1–100，默认 50；`cursor` 为上一页最后的 id；可选 `ratingKey`）

未登录 401，没有工作空间 403，成员不可用 403，看不见的店 404。`status` 为 `UNKNOWN` 或 `current_value` 为 null 时 `noData` 为 true，`direction` 为 `no_data`，两个数值字段为 null，不用 0 代替。有数值时方向相对上一条历史：`up` / `down` / `flat`。

这两条路由是新的，不在原来的 501 表里。`internal/app/testdata/routes.txt` 增加这两行。`PlatformRoutes` 仍是 104，没有改管理端路由。

响应字节用 `jsonwire` 手写，字段顺序跟结构体一致。

## 测试

| 测试 | 覆盖 |
| --- | --- |
| `TestParseSellerInfo`、`TestChangeAndNotifyEdges`、`TestPresentDoesNotInventZero`、`TestStaggerBuckets` | 全 UNKNOWN/null、未知 status/value_type、相同值不变化、变差才提醒、默认映射不提醒、0 与 null 分开、错开槽 |
| `TestSyncIsolatesFailuresAndDropsSecrets`、`TestNilSourceDoesNotDial`、`TestVisibility` | 一店失败不影响下一店、日志不含夹具密钥、未接线不拨号、可见性 |
| `TestRatingReadsAuth` | 401 / 403 / 404 / 400 / 503 |
| `TestRegisterWorkers` | River kind，不写 `jobs` |
| `TestPostSellerInfoLoopback` | 回环 mock、夹具密钥 `fixture-client-rt1` / `fixture-api-key-rt1`、杀开关打开仍然只读、生产主机不拨号、错误文本不含密钥 |
| `TestListDoesNotLock`、`TestRatingsParity` | 相同值不追加、变化追加一行、未知值原样存、两租户越权、缺 GUC、清理、提醒触发与不触发、响应和通知不含密钥、租约与错开 |
| `TestRatingSyncConfig` | 默认 6 小时、90 天、`UNKNOWN=0`，且不改变两个开关 |

`TestRatingsParity` 在 `PODHUB_PARITY_DSN` 指向回环 Postgres 16 时运行；没有 DSN 且没有 Docker 时跳过。CI 有 Docker。

## 与既有行为

读路径是新路由，不改既有接口的响应。`ck_notifications_kind` 多一个 kind，旧 kind 仍能插入。指纹比较去掉这个 kind 后与原来的定义相同。没有改 `OZON_WRITE_KILL_SWITCH` 和 `CLOUD_MEDIA_GC_DELETE` 的解析。没有连接生产 Ozon，也没有删桶。

River 只负责到点调用。快照、历史和通知在事务里写完，不看 `river_job_state`。

## 需要用户决定

1. 评级 `status` 的好坏顺序。默认映射只有 `UNKNOWN=0`，不会发提醒。若要提醒，用 `STORE_RATING_STATUS_RANK`（例如 `OK=1,BAD=2`，数字大表示更差）。官方文档没有打开，这里不猜。
2. 历史保留期默认 90 天。`STORE_RATING_RETENTION` 可以改（Go duration，至少 1 秒）。90 天是否合适没有业务确认。
3. 每店同步间隔默认 6 小时，槽宽 15 分钟。`STORE_RATING_SYNC_INTERVAL` 可以改。是否要更频繁没有确认。
4. 变差时只写 `notifications`（kind `store_rating_worsened`），不推外部通道（邮件、短信、Webhook）。要不要对外推送没有确认。
5. 一次响应里消失的评级键：快照先留着，不自动删除。
6. 第一次见到某个键会写一条历史，当作从「没有上一行」变成当前值。这不是一次变差，所以不提醒。
7. ST1 尚未合并。当前出站是 `seller.Egress.Call` 打 `POST /v1/seller/info`。ST1 的刷新函数落地后应改接那一处。
8. `oapi-codegen` 是否取代 utoipa 仍未决定。这两条读路由是 chi 手写，没有加 OpenAPI 生成物。
