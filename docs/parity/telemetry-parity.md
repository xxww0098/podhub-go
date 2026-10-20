# telemetry 对拍

对照 `xxww0098/podhub` @ `7df856a`（v0.0.112）。Rust 源码按 `uploads/spec-aomt-telemetry.md` 摘录。`POST /api/events/inbox` 与 `POST /api/listing/client-logs` 按摘录实现。`GET /api/billing/usage-stats`（含 `rollup=1` 主管汇总） 已在 `internal/app/api/reads.go`，本步没有重写。`error_log_retention`（`internal/telemetry/jobs.Run`）仍返回 `not_ported`，不删除行。

层级：L2。inbox 与 client-logs 在 `internal/telemetry`。用量读仍在 app 的既有读路由。

这三条遥测路由不读 `OZON_WRITE_KILL_SWITCH`。inbox 的写闸是 telemetry writer lease，不是 Ozon 开关。

## 端点

| 方法 | 路径 | operationId | 本端口 |
| --- | --- | --- | --- |
| POST | `/api/events/inbox` | `event_inbox` | 200 `{"data":{"ok":true,"accepted":[...],"rejected":[...]}}`。空可写入批次仍开一次审计事务 |
| GET | `/api/billing/usage-stats` | （既有读路由） | 已实现，未改 |
| POST | `/api/listing/client-logs` | `ingest_client_listing_logs` | 200 `{"data":{"accepted":N,"dropped":M}}`。开关关闭时 403，且先于鉴权 |

`client-logs` 不在原来的生成清单里。路由表多了这一行，`TestPR8BOperationsAreInOpenAPI` 的遥测段从 `+1` 改为 `+2`。ops 仍是 19。`api/codegen/telemetry.yaml` 仍只包含 `event_inbox`。

错误 JSON 字段顺序是 `error` 然后 `code`，并带 `X-Content-Type-Options: nosniff`。成功 JSON 不转义 HTML，紧凑，带结尾换行。未登录是 `AUTH_REQUIRED`。

inbox 写事务 `SET ROLE podhub_app`，不设 `app.current_org_id`。`event_inbox_events`、`billable_usage_events`、`billable_usage_rollups` 没有 RLS。`client_listing_logs` 用 `tenantx.BeginApp`。

## 规格与测试

| 规格 | 测试 |
| --- | --- |
| 1.1 未登录 `AUTH_REQUIRED`；设备头先于正文；Content-Type；单批 200 | `TestEventInboxAuthAndValidation` |
| 1.1 不读 Ozon 写开关 | `TestInboxDoesNotConsultOzonSwitch` |
| 1.2 接受、拒绝、v4、列宽与 S3 公式 | `TestInboxGoldenVectors`，`TestInboxRejects`，`TestV4FixtureAndV2Shape`，`TestLimitsMatchRustConstants`，`TestInboxColumnLimits` |
| 1.4 重放一行、同 id 异身份、AI 两行、S3 超额不落库、租约 503 | `TestTelemetryInboxAndClientLogs` |
| 4.1 采集开关先于鉴权；只认 `1/true/yes/on` | `TestClientLogsSwitchBeforeAuth`，`TestClientLogCollectMatchesTruthy` |
| 4.2 关联字段保留、秘密丢弃、窗口与 IP 前缀 | `TestClientLogKeepsCorrelationAndDropsSecrets`，`TestClientLogDropsAndWindowAndPrefix` |
| 4.4 跨组织读不到；缺 GUC 的插入失败 | `TestTelemetryInboxAndClientLogs` |
| 2 / 3 用量读（既有） | `TestUsageAndRunGoldens` |
| 保留任务不删除 | `TestRetentionDeletesNothing` |
| 路由表多一行 client-logs | `TestRouteTableMatchesGolden`，`TestPR8BOperationsAreInOpenAPI` |

## 改了哪个流程、结果为什么不变

1. 用量行按事件逐条 `INSERT`，没有用一条 `unnest`。列、冲突键 `(org_id, user_id, event_id, metric)` 和 rollup 的 upsert 与规格相同。`TestTelemetryInboxAndClientLogs` 核对 AI 事件两行、桌面错误重放仍是一行 inbox。
2. S3 月额度用 `stores * (29 * 1073741824 / 2)`。规格正文里的 `15566761488` 与该整数公式不一致。实现用公式，`TestLimitsMatchRustConstants` 期望 `15569256448`。店铺数是 `COALESCE(organizations.store_limit_override, plans.max_stores, 0)`，`resolve_for_account` 正文没有导出。
3. 本进程不是 `axum` / `hono`。telemetry 域没有未撤销的行、行已过期或身份不符时返回 503 `WRITES_DISABLED` / `遥测域写入未启用`，不插入、不刷新心跳、不发明 `go` holder。匹配的 `axum` 行允许并心跳。第一条租约用 `writer-lease bootstrap telemetry`。见 `docs/parity/security-hardening.md`。
4. 客户端日志 `InsertClientLogs` 先按切片顺序对 `(user_id, client_id)` first-wins 去重，再一条多行 `INSERT … ON CONFLICT (user_id, client_id) DO NOTHING`。空批次在 `BeginApp` 之前返回，不开事务。`CommitChunk` 的逐事件配额没有改。`id` 与 `received_at` 由数据库生成，对照时不比这两列。`TestInsertClientLogsBatchParity`：40 行含 5 行已存在冲突和重复 `client_id`，行集与插入列一致，插入语句数 1。`BenchmarkInsertClientLogs`（40 行，`-benchtime=1s`）：`1147643 ns/op`。

## 租户

inbox、用量事件、用量汇总没有 RLS。隔离是行上的 `org_id` / `user_id`，不是 GUC。client-logs 有 `FORCE ROW LEVEL SECURITY` 的 `tenant_isolation`。另一组织的事务读到 0 行；`podhub_app` 且不设 `app.current_org_id` 时插入失败。

## 对照测试

无数据库：

```text
go test ./internal/telemetry/... ./internal/platform/config/ ./internal/app/ ./tests/archtest/ -count=1
```

loopback Postgres（`PODHUB_PARITY_DSN`，不连生产）：

```text
go test ./tests/integration/ -count=1 -run 'TestTelemetryInboxAndClientLogs|TestMCPGrantContextAndReplay'
```

本机结果：上述包通过。`TestTelemetryInboxAndClientLogs` 与 `TestMCPGrantContextAndReplay` 为 `ok`。

## 需要用户决定

1. axum `DefaultBodyLimit` 的 413 正文未导出。inbox 超过 6644224、client-logs 超过 98304 时返回空正文 413。
2. diagnostic v3 的完整 `json!` 未导出。重放投影是本进程写入的 canonical payload。v3 context 只留 `{field, platform}`，raw 深度 8，比未导出的解码器更严。
3. `resolve_for_account` 未导出。S3 店铺数用上面的 `COALESCE`。AI token 只记账，不设闸，与 `check_usage_within_quota` 一致。
4. 用量插入是逐行而不是一条 `unnest`。列、冲突键和结果行相同。
5. `db/schema` 没有这些表。SQL 写在 `internal/telemetry/repo`，没有新的 sqlc 单元，也没有改 migration。
6. 规格正文的每店字节数 `15566761488` 与 `29 * 1073741824 / 2 = 15569256448` 不一致。实现用公式。
7. 已确认，并在 S1 收紧。inbox 与错误日志删除共用 telemetry 写闸。匹配 `axum` + `CLOUD_INSTANCE_ID` 的未过期行允许并心跳。没有未撤销的行、过期或身份不符拒绝，文案「遥测域写入未启用」。空表不再放行。见 `docs/parity/security-hardening.md`。
8. `jobs.Run` 继续 `not_ported`，`Deleted` 为 0。API 定时器的 `PruneErrorLogs` 通过 `prune_aged_inbox` 删除过龄 inbox，不看 kind，与收窄前的行集一致。`client_listing_logs` 的按龄删除不变。详见 `error-digest-parity.md`。
