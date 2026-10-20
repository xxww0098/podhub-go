# 自动化域对照（automation，13 条路由）

Rust 证据：`docs/rust-evidence/aomt/spec-aomt-automation.md`（v0.0.112，HEAD `7df856a`）与 `fixtures-aomt/automation`。本文件只覆盖 `/api/automation/**`。

## 已实现

501 `not_ported` 已换成按规格的读写。成功一律 HTTP 200。错误体为 `{"error","code"}`，并带 `X-Content-Type-Options: nosniff`。

| 路由 | 事务 |
| --- | --- |
| 素材集、执行端、命令 | `tenantx.BeginApp`（`SET LOCAL ROLE podhub_app` + `app.current_org_id`） |
| 授权列表 / 创建 / 吊销 | 普通事务，不 `SET ROLE`。吊销按规格 `set_config` `app.automation_grant_id`，有组织时再设 `app.current_org_id`，然后按顺序删除命令、执行端、回执、执行、授权 |

命令状态机与规格 §0.11 的 SQL 谓词一致：`claim`、`renew`、`progress`、`settle_*`、`release`。续期控制为 `continue` / `cancel` / `lost`。`claim` 要求授权与执行端都活着；`progress` / `settle` 不要求授权仍有效。租约 90 秒、执行端 45 秒（含边界）、认领条数 1..8 默认 4，都在 SQL 与领域常量里。

角色矩阵在 `domain.Delegate` / `LiveAllows`：member→operator，admin→manager，live 角色经 `from_stored`。viewer 不能委托备货；viewer 与 reviewer 不能提交。

这 13 条路由不读 `OZON_WRITE_KILL_SWITCH` / `CLOUD_MEDIA_GC_DELETE`，不访问 Ozon、对象存储、模型或支付，不写账本，不入队。

## 测试

| 规格 | 测试 |
| --- | --- |
| §0.11 合法 / 非法边、续期控制、45 秒边界 | `TestCommandEdges`、`TestRenewControl`、`TestRuntimeLiveBoundary` |
| 名称、素材项、渲染契约、有效期、角色、令牌 | `TestCleanNameAndItems`、`TestRendererExpiryLimit`、`TestDelegateMatrix`、`TestStatusAndToken` |
| 错误字节、成功 JSON、空领取、过期结算、无出站 | `TestAuthAndValidationBytes`、`TestSuccessBytes`、`TestStaleWriteAndEmptyClaim`、`TestAutomationDoesNotDial` |
| SQLSTATE 55P03 / P0M01 | `TestMapDB` |
| 授权生命周期、成员动作、租约、素材等待、吊销级联、两组织 RLS | `TestAutomationFlow` |
| 路由条数不变、本域不解析开关 | `TestRouteTableMatchesGolden`、`TestDomainsDoNotParseSwitches` |

本地已执行：

```text
go test ./internal/automation/... ./tests/archtest/ ./internal/app/
PODHUB_PARITY_DSN=postgres://127.0.0.1:5432/podhub?sslmode=disable go test -count=1 -timeout 8m ./tests/integration/ -run TestAutomationFlow
```

第二行对着本机 Postgres 16.15（迁移版本 292）通过。覆盖授权生命周期与 token 哈希、成员动作、`manual_disabled` 的 403、执行端心跳、续期 continue/cancel/lost、进度与结算、素材等待与旧 label、重名 500、非法 runtime uuid 回滚、吊销后五张表计数为 0、跨组织读不到写不进、缺 `app.current_org_id` 时读不到且插入失败。

## 优化

响应字段、状态和落库与规格相同。有两处写法不同，结果不变：

- 创建授权的到期表达式在规格里是 `$9 || ' days'`。pgx 把天数绑成 `bigint`，`bigint || text` 没有运算符，所以写成 `$9::text || ' days'`。间隔仍是 `clock_timestamp()` 加整天数。`TestAutomationFlow` 的 `expiresInDays: 1` 断言 `expiresAtMs` 非空。
- 列表 SQL 只取出 HTTP 视图会序列化的列。没读的列不进 JSON，库内行不变。

## 需要用户决定

1. 认领 CTE 的 `RETURNING` 与外层 `ORDER BY created_at` 谁生效，规格写了未确认。Go 不另行排序。
2. 请求体超过 2MiB 时的状态码与正文，规格写了未确认。本域不另造 413，沿用现有中间件。
3. Axum `JsonRejection` 除「请求格式无效」以外的正文，规格写了未确认。Go 把未知字段、非法 JSON、尾部杂质都映射成这一句。
4. 路径参数百分号编码非法时的行为，规格写了未确认。
5. 授权仍有效但实时角色不再允许该动作时，规格只说 403，没有引用第二句中文。本实现使用路由错误表里唯一多出来的 403 文案「当前授权已变化，请刷新后重试」。若 Rust 是另一句，需要对照后改 `MsgAuthority`。
6. 交互读 16、普通写 10 的数字预算与现有 identity 中间件（8 与 4）不一致。该中间件被其他域的测试锁住，本任务不改。类别映射本身已与规格一致（仅 heartbeat 为 control）。
7. `enqueue_automation_command` 的生产调用点仍是未确认，本域没有入队。
8. `CLOUD_DB_LOGIN_API` 是否 `SET ROLE podhub_app` 未确认。租户表走现有 `BeginApp`；授权三路由按规格明确不 `SET ROLE`。
9. `organization_members.role` 的 CHECK 只有 owner、manager、member。reviewer / viewer 的能力判断只在领域函数里，集成测插不进这两种库角色。
