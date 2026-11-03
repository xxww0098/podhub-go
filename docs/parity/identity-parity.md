# PR-1 身份与租户：和 Rust 对过什么

来源是 `xxww0098/podhub` 提交 `a03d735`。租户键仍是 `org_id`。Go 用 chi 中间件、事务内 `set_config(..., true)`、sqlc 和一份 OpenAPI。响应字节按读过的 serde 字段顺序手写。生成链已由 [决策 D2](../decisions.md) 确认：OpenAPI 为唯一规格，oapi-codegen 生成 models 与 chi 路由。

2026-11-02 起，角色模型以当前数据库的三个工作空间角色为准，旧 Rust 五角色矩阵不再作为兼容目标，见 [账号与权限模型](../architecture/account-permission-model.md)。下面「已钉住」的是同一输入下状态码、响应字节、表行或纯函数结果。没钉住的单独列在后面，不能当成已经等价。

## 已钉住

| 项 | 依据 | 测试 |
| --- | --- | --- |
| 平台账号变更：不能指派 `super_admin`；admin 只能创建/改 user；最后一个活跃 super_admin 不能被降级或禁用 | `internal/admin/users/contract/rank.go` | `TestAuthorizeNamedEdges` |
| 工作空间只保留 owner、manager、member；未知值及旧 admin/operator/reviewer/viewer 不授予权限；成员变更按三角色判断 | `internal/identity/contract/workspace.go` | `TestWorkspaceRoles`、`TestMembershipChanges`、`TestGates` |
| 平台与工作空间角色独立；平台 staff 为 admin/super_admin，管理入口继续按原 Guard 区分 staff 与 super_admin | `internal/identity/contract/access.go`、`internal/admin/http` | `TestPlatformRoles`、`TestAdminGuards` |
| CSRF：只拦带非空 `sid` 的 POST/PUT/PATCH/DELETE。`Sec-Fetch-Site` 必须是 `same-origin` 或 `none`。没有该头时比 Origin 的 `scheme://host[:port]` 和 Host。无 Origin 且无 Sec-Fetch-Site 放行。无会话 cookie 放行 | `src/http/csrf.rs` | `TestCSRFVectors`；集成测试对带 cookie 的跨站 logout 断言 403 `{"code":"csrf_rejected","message":"跨站请求已被拒绝"}` |
| 路由分类（按当前 API 清理已删除入口；统一提交走普通写预算） | `internal/identity/classify.go` | `TestClassifyPaths` |
| 登录节流：pair 免费 5 次、IP 免费 30 次、窗口 15 分钟、延迟 `2<<shift` 上限 900 秒。检查不插入。`X-Forwarded-For` 取最后一跳，否则 `direct` | `src/auth/login_throttle.rs` | `TestLoginThrottleMath`；集成测试第 7 次未知邮箱登录为 429，正文 `{"error":"登录失败次数过多，请稍后再试","code":"RATE_LIMITED"}`，无 `Retry-After` |
| 单会话 cookie：只有 `sid`，HttpOnly，SameSite=Lax，Path=/，Max-Age 604800；每次回复都过期掉废弃的 `sids`。`CLOUD_COOKIE_SECURE` 去空白后恰好是 `0` 或 `false` 才不带 Secure | `internal/identity/session.go` | `TestSessionCookie`；集成测试断言旧 `sids` 不再认证、登录不再下发它 |
| 带 Idempotency-Key 的会话令牌：标签 `podhub-auth-v2`，seed 由库存密码哈希和会话版本组成；邮箱换绑后递增版本，避免旧令牌被相同请求键复活。key 是去空白后的头。pepper 是 `podhub-session-pepper-v1` 加 `CLOUD_SELLER_CREDENTIAL_KEY`（环境变量存在就用，含空串，不去空白） | `src/auth/crypto.rs`；会话版本是 Go 侧差异 | `TestDeterministicSessionToken`；集成测试验证重放及换绑后的会话撤销 |
| 邮箱形状、名字、账号模式（owner / member / unaffiliated）、自有工作空间上限 3 | `src/auth/profile.rs`、`src/auth/account_mode.rs` | `TestEmailNameAndAccountMode` |
| 绝对并发预算：媒体上传 2、psd 6、控制面预留 16、控制面每用户 8、等候室每槽 8、等待 10 秒。超用户预算 429「当前用户的并发预算已用尽，请稍后重试」；打满 503「服务繁忙，请稍后重试」；两则 `code` 为 `internal`，`Retry-After` 夹在 1..30。识图与 AI 共用用户预算且不占全局槽。无 cookie 且无 Authorization 的请求不做用户公平 | `src/http/admission.rs` | `TestAdmissionRefusalBodies` |
| 租户事务：一条语句 `set_config('role','podhub_app',true)` 与 `set_config('app.current_org_id',…,true)`。Worker 只切 `podhub_worker`。都是事务局部 | `src/listing/kernel/tenant.rs` | `TestIdentityAndTenantIsolation` 的 `isolateTenants` |
| RLS：`listing_card_cursors` 对 `podhub_app` 强制 `tenant_isolation`。缺 GUC 时 SELECT 为 0 且 INSERT 失败。`podhub_worker` 是 BYPASSRLS，能看见两行 | migration `00109` | 同上 |
| API 隔离：A 的会话切换到 B 的 org 得到 403 `{"error":"无权切换到该 Workspace","code":"FORBIDDEN"}`，`active_org_id` 不变。A 的成员名单含 A 不含 B，owner 的 `inviteRoles` 是 `["manager","member"]` | 成员资格查询与 `MayInvite` | 同上 |
| 注册成功：一行 `account_sessions`（`token_hash` 为令牌的小写 hex SHA-256）、一行 `account_registered` 审计（writer lease 两列为空，摘要含「开通免费工作空间」）、一个 `plan=free` 的组织和一条 owner 成员。登录 JSON 字段顺序为 token、user、target；user 为 uuid、role、email、name，空 supplierId 省略。匿名会话字节为 `{"data":{"authenticated":false,"active_workspace":null,"workspaces":[],"unusable_workspaces":[]}}`。新用户 `account_mode` 为 owner；邮箱验证已按产品要求删除，会话不再返回 `email_verified` | `src/auth/registration.rs`、`src/audit/mod.rs`、`src/auth/session_view.rs`；邮箱验证移除属于明确的产品差异 | `TestIdentityAndTenantIsolation` |

没有 Docker 套接字且未设置 `PODHUB_PARITY_DSN` 时，集成测试跳过。GitHub Actions `ubuntu-latest` 有 Docker，`go test -timeout 25m ./...` 会跑。

## 不能证明一致

这些差异没有用「同一输入、同一输出」钉死。在补证据之前不要写成已经等价。

1. 黄金字节来自读过的 Rust 结构经 serde_json 的形状，不是一台活着的 Rust 进程。没有把 Rust 指到生产库。
2. 审计行的 `writer_lease_id` 与 `writer_fence_token` 写 NULL。writer lease（domain `auth`，holder `axum`）没有移植。这是行内容差异，不是优化。
3. 非空邀请码一律 400 `邀请码无效`。代理归因查询没有移植。空码与缺省仍是不绑定。
4. 注册会按邮箱回填未处理邀请的 `invitee_user_id`，不写通知行。
5. 超级管理员不再有验证器：登录只校验邮箱和密码，没有 `totpCode` 字段、`TOTP_REQUIRED` 错误码、恢复码或 15 分钟 step-up。迁移 `00004_drop_admin_totp.sql` 删除 `account_admin_totp` 与 `account_sessions.admin_step_up_until`，管理端 enroll、confirm、step-up 三条路由也一并删除。`TestIdentitySessionIssuanceRechecksLockedCredential` 仍覆盖锁定凭据的会话签发复查；Rust 侧的 TOTP 登录不再作为对拍目标。
6. 早期浏览器交接页（GET/POST `/auth/handoff`）没有实现；`POST /api/auth/handoff` 也已从当前路由表撤下，旧的 60 秒码说明不能作为现行登录流程。
7. 密码找回通过 TLS SMTP 投递；令牌表只落哈希，专用发件箱保存 AES-GCM 加密载荷，失败退避重试且终态擦除。迁移 `00010_password_reset_mail.sql` 新增持久化发件箱、IP 限流和凭证变更撤销触发器。注册不要求邮箱验证；迁移 `00038_email_change.sql` 为登录邮箱换绑增加新地址确认，复用邮件发件箱，并在换绑后撤销会话及旧链接。`password_changed` 摘要「修改密码」、`password_reset` 摘要「重置密码」是按任务说明写的，没有打开对应的 Rust `json!`。
8. 改密成功体是登录 JSON 加新 cookie。切换工作空间成功体是切换后的会话 JSON。都没有对照 `identity/api.rs` 的 HTTP 包装。
9. 成员名单是投影 `id`、`email`、`role`、`displayName`、`status` 和 `permissions.inviteRoles`，不是 Rust 目录的完整 camelCase。
10. 派生并发上限没有在 `admission.rs` 里找到，目前写死：interactive 8、普通写 4、媒体探测 4、AI 2、全局 64。分类表按当前 OpenAPI 清理，已删除的批量入口及其独立预算不再保留。绝对预算见上表。
11. 会话 `expires_at` 用进程时钟加 TTL 再格式化成 RFC3339Nano。节流和「最近是否发过邮件」用 `clock_timestamp()`。两台时钟不一致时到期点会差。
12. 密码哈希信号量是 `max(GOMAXPROCS*2, 4)` 的 try-acquire，满了返回 429「请求过于频繁，请稍后重试」。与 Rust 信号量容量没有对拍。
13. 邮件令牌 60 秒内重发仍回 200、忘记密码无论地址是否存在都回 200、禁用账号不发令牌：逻辑按读过的说明实现，没有字节级对拍。
14. `55P03` → 503「资源正在更新，请稍后重试」且 `Retry-After: 1`；`P0M01` → 409「媒体对象已进入回收，请重新上传」（信封仍是 auth 的 `INTERNAL`）。SQLSTATE 分支没有在集成测试里打到。

## 只读 GET 接到会话

`internal/identity/contract.Resolver` 由 `identity.Service.Resolve` 实现，并挂在 `app.Handler` 的 `Server.Access` 上。只读 GET 因此使用会话里的 `user_id`、`org_id`、库存工作空间角色和平台角色。`GET /api/billing/usage-stats?rollup=1` 对主管及以上返回区间结束月份的本组织与当前成员汇总；普通用户访问 `GET /api/admin/banned-tags` 得到 403；未登录得到 401；A 的会话看不见 B 的准备作业。测试在 `TestIdentityAndTenantIsolation`。

早期 PR-1 的管理端 GET 与后续管理端用户/AI、账单、官方包等处理器一样，只按平台角色判断超级管理员，没有验证器或 step-up 守卫：管理端权限只来自 `super_admin` 角色，因此可以按「已有会话直接读管理端 GET」调用。当前管理端差异见 [用户与 AI 鉴权](admin-users-ai-auth-parity.md)、[账单与观察](admin-billing-parity.md)。

最初的禁用标签规则接口不读会话；后续提交业务分支增加了 工作空间成员鉴权（`OrgMember`），见 [提交流水线对照](listing-submit-parity.md)。带 cookie 的跨站 POST 仍受 CSRF 中间件约束。

## 需要用户决定

- 上面 2–14 是否接受为本阶段的缺口，还是要在合并前逐项补到与 Rust 字节一致。
- 派生并发上限（第 10 条）要用哪组池常量。在读到 Rust 数字之前，不要把 8/4/4/2/64 当成已经对齐。

账号用途（`account_kind`）、`must_change_password` 的接口白名单、供应商账号能否复用平台邮箱这几项不属本域，统一登记在 [decisions.md](../decisions.md) 的 O13。本文只保留身份对拍本身的缺口。
