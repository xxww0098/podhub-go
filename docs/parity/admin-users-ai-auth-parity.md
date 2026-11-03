# admin 用户与 AI 鉴权对拍

早期移植替换了 25 条原先返回 501 的 `/api/admin` 路由；其中验证器 enroll、confirm、step-up 三条已随 TOTP 删除整体撤下。当前 `POST /api/admin/support-grants/{id}/revoke` 与 `POST /api/admin/writer-leases/revoke` 已不在 `PlatformRoutes` 注册；内部 dispatch 分支尚在，不能当成已挂载接口。AI 用量、验证和连接配置的 operationId 也已改名，以 `api/openapi.yaml` 为准。规格是上传的 adminB 用户目录与 AI 鉴权说明（Rust v0.0.112）。没有 Rust 源码树，对照依据是规格里的 SQL、错误文案和 `tests/integration/admin_users_ai_auth_test.go`。

这些 handler 使用普通事务，不 `SET ROLE podhub_app`，也不设 `app.current_org_id`。规格写明用户目录、状态、角色、密码、席位、support grant 不设组织 GUC。目录逐个工作区设组织 GUC 读 `workspace_wallets`。解散先设组织 GUC 再锁该工作区的钱包行。`BeginApp` 会 `SET ROLE` 并藏起跨租户行，和这批规格相反，所以没有用它。

`GET /api/admin/ai-requests` 的守卫从盘点里的工作区改为超级管理员。`POST /api/admin/integrations/ai/verify` 从登录守卫改为超级管理员。当前两条路径保留，operationId 分别为 `adminAiRequestsList` 和 `adminIntegrationsAiVerify`。

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
| 解散名称不符、成功、再解散 403 | 同测试 dissolve |
| 非超管 403、未登录用户目录 `AUTH_INVALID`、AI 账本 `AUTH_REQUIRED` | 同测试，以及 `TestAdminGuards` |
| 钱包 RLS：`podhub_app` 无 GUC 看不见，设对用户只看见该行 | 同测试末尾 |
| 角色代数、席位规划、价格归一、租约决策 | `internal/admin/domain` 包测试 |

未接线（`API == nil`）时超管仍得到 501，`TestAdminGuards` 断言这一点。

## 改了哪个流程、结果为什么不变

- 目录和席位 SQL 现位于 `internal/admin/users/repo`，配额规划在 `internal/admin/users/contract`，授权、租约、价格和配置仍由 `internal/admin/repo` 承接。事务边界（审计失败回滚、价格审计在提交之后、预览不走写门、租约 grant 不走 admin 写门）与规格相同，所以同一输入得到同一状态和同一错误文案。
- 席位预览和应用已读取订阅的已购成员/店铺容量及保留名单；存在订阅时不再仅由 `member_seat_lots` 推导容量。订阅店铺按创建顺序处理，手动 override 会清除对应保留名单的作用；应用后跳过旧批次的第二次店铺 reconcile。见 `internal/admin/users/contract/seats.go` 与 `internal/admin/users/repo/seats.go`。
- 密码重置除删除会话外，还设置 `must_change_password=true`；平台角色赋值会拒绝供应商账号。见 `internal/admin/users/repo/users.go`。
- 席位预览在服务层先做可管理性检查，再查组织。组织不存在仍是 404，不可管理仍是 403，不因为多一次账号读取而改结果。
- 探测客户端放在 `internal/admin/http`，服务只依赖接口。无重定向、无代理、DNS 钉死、成功体 1 MiB、错误体 16 KiB。loopback 只在 `CLOUD_AI_EGRESS_ALLOW_LOOPBACK` trim 后等于 `1` 时允许；公网拨号还需要加密连接配置快照里的 `ai_runtime.allow_public_egress`（管理端「AI 账号」页），每次探测时读取，没有配置行或为关则拒绝，默认关闭。测试打的是 `httptest`，没有真实供应商。
- AI 账本的 401 码是 `AUTH_REQUIRED`，其余 admin 路由仍是 `AUTH_INVALID`。这是规格里的错误族差异，不是新行为。

管理端「AI 账号」页内的「AI识图」标签统一维护默认模型、账号和模型定价，模型列表保留搜索、刷新与分页。独立的「AI识图」菜单与设置页已删除。

## 需要用户决定

- axum 对 Path/Query 类型拒绝和 2 MiB 体限制的响应体规格未确认。这里收成 400 `VALIDATION` / `请求格式无效`。
- 超级管理员的验证器已整体删除：登录只有邮箱和密码，没有 `totpCode`、`TOTP_REQUIRED`、恢复码或 step-up 窗口；`POST /api/admin/totp/enroll`、`POST /api/admin/totp/confirm`、`POST /api/admin/step-up` 不再存在，迁移 `00004_drop_admin_totp.sql` 删除 `account_admin_totp` 与 `account_sessions.admin_step_up_until`。`TestAdminUsersAIAuth` 保留其余目录、席位、角色、密码、价格与探测断言。
- 已确认。连接配置明文以规格 X3-C 和 `crypto-vectors.json` 为准，键是 camelCase。管理端写入、支付、媒体和委托读同一份文档。旧 snake_case 行先按 camelCase 解，失败再按 snake_case 读，然后重封成 camelCase。
- 管理端「AI 账号」页把识图、对话与生图账号合在一份快照里。每个账号必须带 `purpose`（`ocr`、`chat` 或 `image`），识别只用 `ocr` 账号，文本入口只用 `chat` 账号，套图生成只用 `image` 账号，默认识别模型只能来自启用的 `ocr` Chat Completions 账号。`chat` 账号可选 Chat Completions、Anthropic Messages 或 Responses 格式；`ocr` 与 `image` 账号只使用 Chat Completions。快照另有 `aiRuntime`（接口 `ai_runtime`）：全局、单用户、单上游账号并发上限，单用户每分钟请求数，租约秒数（默认 90）和公网探测开关。它们取代已删除的并发、频率、租约秒数和公网探测这几个环境变量（`CLOUD_AI_EGRESS_ALLOW_LOOPBACK` 只供本地测试，仍是环境变量）。中继每个请求读一次快照，没有配置行时所有上限为 0（关闭）、租约 90 秒；配置行无法读取则 503 `RELAY_UNAVAILABLE`。没有 `purpose` 或 `aiRuntime` 的旧文档读取时迁移：模型名为 `qwen-image-2.1-pro` 的账号是 `image`，其余是 `ocr`，运行参数取默认值，并按现有路径重封。更新时 `ai_runtime` 可省略（保留已存的值），给出时必须包含全部六个字段。
- 已确认。writer 实例不再固定为 `podhub-go`。`CLOUD_INSTANCE_ID` 经 `internal/platform/config.WriterInstanceID` 读取，空白时为 `axum-{pid}`，holder 固定 `axum`。依据规格 X3-B `WriterIdentity::axum_from_env`。
- 探测 User-Agent 版本写成规格里的 `0.0.112`。只在 host 为 `opencode.ai` 且 path 以 `/zen/go/` 开头时发送。
- AI 账本查询走 `dbFault`，`55P03` 会变成 503。规格写 AI 的 internal 不单独映射 `55P03`（始终 500）。这条没有被当前测试钉死。
- `support_grants` 是否 ENABLE 但未 FORCE RLS，本批没有再验证。
- golden `admin.json` 里 `admin_member_seat_preview` 的路径仍是 `/api/admin/teams/101/...`，和当前 `/api/admin/users/{uuid}/member-seats/preview` 不一致。测试按当前路由断言。
- 测试库的超级用户绕过 FORCE RLS。目录查询在超级用户下不会被钱包策略收窄；`podhub_app` 会。集成测试单独 `SET ROLE podhub_app` 证明了这一点。
