# admin 用户与 AI 鉴权对拍

这一批替换 25 条原先返回 501 的 `/api/admin` 路由。路径和 operationId 没有增删。规格是上传的 adminB 用户目录与 AI 鉴权说明（Rust v0.0.112）。没有 Rust 源码树，对照依据是规格里的 SQL、错误文案和 `tests/integration/admin_users_ai_auth_test.go`。

这些 handler 使用普通事务，不 `SET ROLE podhub_app`，也不设 `app.current_org_id`。规格写明用户目录、状态、角色、密码、席位、support grant 不设组织 GUC。目录读钱包时只设 `app.current_wallet_user_id`。解散按规格先设组织 GUC 再设钱包用户。`BeginApp` 会 `SET ROLE` 并藏起跨租户行，和这批规格相反，所以没有用它。

`GET /api/admin/ai-requests` 的守卫从盘点里的工作区改为超级管理员。`POST /api/admin/integrations/ai/verify` 从登录守卫改为超级管理员。两条路径和 operationId 没变。

## 规格章节与测试

| 规格 | 测试 |
| --- | --- |
| 用户目录 list，审计 `accounts_listed` | `TestAdminUsersAIAuth` 列表 200 与审计计数 |
| 创建账号、邮箱规范化、短密码、重复邮箱 | 同测试 create 201、400、409 |
| 状态：缺 `enabled`、禁用最后超管、再启用 | 同测试 status |
| 角色 admin 再改回 user | 同测试 admin |
| 密码重置删除该用户会话 | 同测试 password，随后旧 bearer 401 |
| 席位、预览、revision 冲突、apply | 同测试 seats / preview / apply |
| support grant 签发、撤销、重放 | 同测试 grants |
| writer lease 七域、holder 文案、fence `Some(n)`、审计路径 `/api/admin/writer-leases/grant` | 同测试 leases |
| 价格思考预算 26214 拒绝、26216 接受、下架 404 | 同测试 prices |
| 账本 `page_size=0`、summary `cache_hit_rate_bps` | 同测试 usage |
| 探测 loopback 目录排序去重、模型不在列表仍 verified | 同测试 models / verify |
| 空连接配置 CAS revision 1，响应无密钥 | 同测试 config |
| 验证器注册、空码、错码、确认、已绑定 409 `VALIDATION`、恢复码一次性 | 同测试 totp / step-up |
| 解散名称不符、成功、再解散 403 | 同测试 dissolve |
| 非超管 403、未登录用户目录 `AUTH_INVALID`、AI 账本 `AUTH_REQUIRED` | 同测试，以及 `TestAdminGuards` |
| 钱包 RLS：`podhub_app` 无 GUC 看不见，设对用户只看见该行 | 同测试末尾 |
| 角色代数、席位规划、价格归一、租约决策 | `internal/admin/domain` 包测试 |

未接线（`API == nil`）时超管仍得到 501，`TestAdminGuards` 断言这一点。

## 改了哪个流程、结果为什么不变

- 目录、席位、授权、租约、价格、配置、验证器的 SQL 按规格写在 `internal/admin/repo`。事务边界（审计失败回滚、价格审计在提交之后、预览不走写门、租约 grant 不走 admin 写门）与规格相同，所以同一输入得到同一状态和同一错误文案。
- 席位预览在服务层先做可管理性检查，再查组织。组织不存在仍是 404，不可管理仍是 403，不因为多一次账号读取而改结果。
- 探测客户端放在 `internal/admin/http`，服务只依赖接口。无重定向、无代理、DNS 钉死、成功体 1 MiB、错误体 16 KiB。loopback 只在 `CLOUD_AI_EGRESS_ALLOW_LOOPBACK` trim 后等于 `1` 时允许。测试打的是 `httptest`，没有真实供应商。
- AI 账本的 401 码是 `AUTH_REQUIRED`，其余 admin 路由仍是 `AUTH_INVALID`。这是规格里的错误族差异，不是新行为。

## 需要用户决定

- axum 对 Path/Query 类型拒绝和 2 MiB 体限制的响应体规格未确认。这里收成 400 `VALIDATION` / `请求格式无效`。
- `totp-rs` 5.6 的 `otpauth` 查询顺序未确认。实现顺序是 `secret`、`issuer`、`algorithm`、`digits`、`period`。
- 已确认。连接配置明文以规格 X3-C 和 `crypto-vectors.json` 为准，键是 camelCase。管理端写入、支付、媒体和委托读同一份文档。旧 snake_case 行先按 camelCase 解，失败再按 snake_case 读，然后重封成 camelCase。
- 登录仍不校验 TOTP、也不写 step-up。`internal/identity/login.go` 对已确认的超管验证器直接 401。本批不改登录。确认成功会写 15 分钟 step-up，所以确认之后的管理路由能用。
- 已确认。writer 实例不再固定为 `podhub-go`。`CLOUD_INSTANCE_ID` 经 `internal/platform/config.WriterInstanceID` 读取，空白时为 `axum-{pid}`，holder 固定 `axum`。依据规格 X3-B `WriterIdentity::axum_from_env`。
- 探测 User-Agent 版本写成规格里的 `0.0.112`。只在 host 为 `opencode.ai` 且 path 以 `/zen/go/` 开头时发送。
- AI 账本查询走 `dbFault`，`55P03` 会变成 503。规格写 AI 的 internal 不单独映射 `55P03`（始终 500）。这条没有被当前测试钉死。
- `support_grants` 是否 ENABLE 但未 FORCE RLS，本批没有再验证。
- golden `admin.json` 里 `admin_member_seat_preview` 的路径仍是 `/api/admin/teams/101/...`，和当前 `/api/admin/users/{uuid}/member-seats/preview` 不一致。测试按当前路由断言。
- 测试库的超级用户绕过 FORCE RLS。目录查询在超级用户下不会被钱包策略收窄；`podhub_app` 会。集成测试单独 `SET ROLE podhub_app` 证明了这一点。
