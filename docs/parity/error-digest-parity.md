# 错误摘要与日志保留

对照 `xxww0098/podhub` @ `7df856a`（v0.0.112）。本仓库读不到 Rust 私有源码。收窄之前，`PruneErrorLogs` 按 `received_at` 删除整张 `event_inbox_events`（含计费用量）和整张 `client_listing_logs`。R3 把这张整表删除当作 Rust 已落地的删除面：过龄行一起消失，不看 kind。用户已决定删除集合与收窄前一致。调用方仍然不发无条件的整表 `DELETE`。

OTel 中间件、`pg_stat_statements`、`POST /api/listing/client-logs` 没有改。`OZON_WRITE_KILL_SWITCH` 与 `CLOUD_MEDIA_GC_DELETE` 没有新的解析点。

## 做了什么

1. 追加迁移 `00300_error_digest.sql`。没有修改 `00001`–`00293`。新表 `error_digest` 只存指纹、路由模板、状态码、计数、首次/最近时间、已脱敏摘要，外加小时窗口和可空 `org_id`。不存请求体、密钥、邮箱、手机号、Api-Key，也不存租户名称。`org_id` 非空的行 `FORCE ROW LEVEL SECURITY`，`podhub_app` 只能读写本组织。`org_id` 为空的平台汇总行用单独的策略：`podhub_digest_platform` 可写，超级管理员观察者（`app.platform_observer_id`）可只读。
2. `PruneErrorLogs` 不对 `event_inbox_events` 发无条件整表 `DELETE`。它 `SET ROLE podhub_error_prune` 后只调用 `prune_aged_inbox`。该角色是 `NOBYPASSRLS`，没有这张表的 `DELETE`，也没有 `EXECUTE` 以外的授权。函数正文按 `received_at < clock_timestamp() - interval` 删除每一种 kind：五种错误类、两种计费类，以及未知 kind。`received_at` 等于截止时间的行留下。`client_listing_logs` 仍是原来的按龄删除，没有 `level` 条件。`internal/telemetry/jobs.Run` 仍返回 `not_ported`，删除数仍是 0，没有和 `PruneErrorLogs` 合成。
3. worker 里的 River 周期任务 `podhub.error_digest`（id `error-digest-hourly`，间隔 1 小时，`RunOnStart` 为 false）先按 `docs/parity/ozon-error-catalog-parity.md` 清空超过 180 天的 Ozon 活样本，再把上一 UTC 小时的错误类 inbox 行聚合成 `error_digest`。样本清理失败只打日志。它不改 `jobs`、计费、inbox 或写闸。`GET /api/admin/error-digest` 给已提权的超级管理员只读平台行。

## 路由 golden

只多了一行，中间件仍是 3（otel、CSRF、identity），ops 仍是 19：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/error-digest` | 新的只读接口。operationId `admin_get_api_admin_error-digest`。未登录 `AUTH_REQUIRED`，非超级管理员 403。正文只有指纹、路由模板、状态码、计数、时间和摘要 |

没有改已有路由的方法或路径。

## 与 Rust 的删除行集

纯函数 `RustPruneDeletes` 与 `GoPruneDeletes` 是同一个谓词：任意 kind，`received < now - olderThan`。截止时间上的行两边都不删。

| 行 | Rust 删除 | Go 删除 | 说明 |
| --- | --- | --- | --- |
| 过龄的 `desktop_error_log.v1`–`v4`、`error_feedback.v1` | 是 | 是 | 行集相同 |
| 未过龄的任意 kind，以及 `received == cutoff` | 否 | 否 | 相同。五种错误类、两种计费类、未知 kind 都一样 |
| 过龄的 `billing.ai-token-usage.v1`、`billing.object-upload-usage.v1` | 是 | 是 | 用户已决定与 Rust 一致 |
| 过龄的未知 kind（例如 `'error'`） | 是 | 是 | 与 Rust 一致 |

`client_listing_logs` 的 `debug` / `info` / `warn` / `error` 仍按龄一起删除，和收窄前相同。

## 改了哪个流程、结果为什么不变

1. **client-logs 采集与按龄删除。** 路由、开关、插入和 `DELETE FROM client_listing_logs WHERE received_at < ...` 都没加 `level`。过龄的 info 与 error 仍一起消失。`TestClientLogPruneStatementUnchanged` 锁住这条 SQL。`TestErrorDigestPruneParityAndRLS` 在回环库上插入过龄的 info 与 error，删除后剩下 0 行。
2. **inbox 的按龄删除。** 时间谓词仍是 `received_at < clock_timestamp() - (秒 || ' seconds')::interval`，没有 kind 条件。语句在 `prune_aged_inbox` 里，调用方不拼 `DELETE`。`podhub_error_prune` 直接 `DELETE` 会权限失败。`TestPruneRowSetMatchesRust` 对拍行集，包括计费类和未知 kind，以及 `received == cutoff`。
3. **计费 inbox 行。** 已决定：过龄就删，与收窄前相同。小时摘要仍只投影五种错误类，不把计费用量写进 `error_digest`。
4. **`event_inbox_events` 的表定义。** 没有 `ENABLE ROW LEVEL SECURITY`，没有新策略，没有动 `00001`–`00293`。指纹对比里的这张表不变。新函数使非扩展函数数从 34 变为 35，正文仍必须出现在 goose SQL 里。
5. **现有 HTTP 正文。** `GET /api/admin/error-logs` 仍返回邮箱和 diagnostic。摘要是旁路表和新的只读路由。OTel 中间件计数仍是 3。
6. **River。** `podhub.noop` 仍在。新周期任务不写 `jobs.state`。`TestDigestWorkerDoesNotDecideBusinessState` 只调用写入闭包。
7. **脱敏。** 摘要由 kind、已脱敏 code、路由模板拼成，最长 80 个字符。不复制 message、stack、email、phone、请求体。数字段、UUID、查询串会变成 `{id}` 或占位符。过不了毒化检查的投影整行丢弃，不写入命中片段。

## 测试

无数据库：

```text
go test ./internal/telemetry/... ./internal/admin/http/ ./internal/app/ ./tests/archtest/ -count=1
```

回环 Postgres 16（`PODHUB_PARITY_DSN=postgres://postgres:postgres@127.0.0.1:5432/podhub?sslmode=disable`）：

```text
go test ./tests/integration/ -count=1 -run 'TestErrorDigestPruneParityAndRLS|TestReconcileGaps'
```

`TestErrorDigestPruneParityAndRLS` 证明：过龄的错误类、两种计费 kind 和未知 kind 都被删；未过龄的错误类和未知 kind 还在；直接 `DELETE` 被拒绝；组织 A 看不见组织 B；缺 `app.current_org_id` 时插入失败且计数为 0；库里的摘要字符串不含 `Bearer`、`sk-`、测试卡号、`api_key`、邮箱、手机号和收件人；非超级管理员读不到平台行。纯函数另证 `received == cutoff` 时 Rust 与 Go 都不删。

## 自动修复的设计（不实现）

本变更不打开 PR、不读生产、不读两个开关。下面是以后若要做 agent 回路时的允许清单。合并不在清单里。

允许自动开修复 PR，必须同时满足：

1. 输入只有脱敏后的一行：指纹、来源、code、计数、窗口、仓库内 `internal/` 或 `cmd/` 帧。没有 message，没有 org，没有 payload。
2. 帧不在 `internal/platform/config`、`db/migrations`、seller 写路径、listing wasm 边界。
3. 来源是进程内故障（空指针、类型断言、JSON 编码这一类），同一指纹在窗口内 `count >= 5`，并且只涉及一个逻辑点。
4. 修复能用现有 `go test` 在回环上先失败再变绿。压测只用 Mode R。不新开外网。
5. PR 描述只引用指纹和帧。

禁止开代码 PR：

- `submission_intents.last_error_code`，包括 `OZON_RECONCILE_STILL_UNKNOWN`
- 作业重试耗尽、`uncertain_closed`、写租约、503 写闸文案
- 计费、钱包、席位、offer、RLS、迁移、媒体删除、凭据解密
- 窗口内有脱敏丢弃
- 改路由 JSON 或 `routes.txt`
- 任何需要读或改 `OZON_WRITE_KILL_SWITCH`、`CLOUD_MEDIA_GC_DELETE` 的改动

永不合并。即使用户曾经授权过别的 PR，也不套用到这个回路。合并只发生在用户之后点名该 PR，并且该 PR 的 CI 与一致性测试已经通过。缺一就不合并。

## 需要用户决定

1. 已决定：过龄计费 inbox（`billing.ai-token-usage.v1`、`billing.object-upload-usage.v1`）按 14 天删除，未知 kind 过龄也删。删除集合与收窄前一致。`prune_aged_inbox` 只带时间谓词；`podhub_error_prune` 仍无表级 `DELETE`，且 `NOBYPASSRLS`。
2. `client_listing_logs` 的 `debug` / `info` / `warn` 仍按 14 天删除。若只留 `level = 'error'`，删除结果会变，本次没有改。
3. `GET /api/admin/error-logs` 仍返回邮箱和 diagnostic 原文。摘要是另一条路由。
4. `store_product_metrics` 仍无 Go 插入。OTel 中间件、`pg_stat_statements`、client-logs 采集都保持原样。
5. 上面的自动开 PR 设计没有实现。真要跑，还要单独决定只读副本和导出目录，并且仍然永不合并。
