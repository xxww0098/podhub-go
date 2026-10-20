# PR-1 身份与租户：和 Rust 对过什么

来源是 `xxww0098/podhub` 提交 `a03d735`。租户键仍是 `org_id`。Go 用 chi 中间件、事务内 `set_config(..., true)`、sqlc 和一份 OpenAPI。响应字节按读过的 serde 字段顺序手写。oapi-codegen 只生成路由，**没有**决定用它替换 utoipa。

本阶段没有改某一条已对上的流程来换速度。下面「已钉住」的是同一输入下状态码、响应字节、表行或纯函数结果。没钉住的单独列在后面，不能当成已经等价。

## 已钉住

| 项 | 依据 | 测试 |
| --- | --- | --- |
| 平台角色代数：不能指派 `super_admin`；admin 只能创建/改 user；最后一个活跃 super_admin 不能被降级或禁用，仍可编辑；未知存储值当作 user | `src/auth/platform.rs` | `TestRoleAlgebraMatchesRust` |
| 工作空间 28 个 Capability：全员读；viewer 不能准备/核对/写图库/审阅；owner、manager、operator 可发布和提交；owner 与 manager 可管理成员和店铺；仅 owner 管账单、预算、轮换凭证、导出审计、改资料、解散；除 owner 外可离开 | `src/auth/workspace.rs` | `TestCapabilityMatrixTable`、`TestWorkspaceMatrixMatchesRust` |
| 平台权限：管平台和观察租户业务仅 super_admin，拒绝文案「需要超级管理员权限」；供应商目录、代下单、供应商账号、提现为 staff，拒绝文案「需要平台管理员权限」 | `src/auth/permissions.rs` | `TestPlatformPermissionsAreClosed` |
| CSRF：只拦带非空 `sid` 或 `sids` 的 POST/PUT/PATCH/DELETE。`Sec-Fetch-Site` 必须是 `same-origin` 或 `none`。没有该头时比 Origin 的 `scheme://host[:port]` 和 Host。无 Origin 且无 Sec-Fetch-Site 放行。无会话 cookie 放行 | `src/http/csrf.rs` | `TestCSRFVectors`；集成测试对带 cookie 的跨站 logout 断言 403 `{"code":"csrf_rejected","message":"跨站请求已被拒绝"}` |
| 路由分类（按当前 API 清理已删除入口；统一提交走普通写预算） | `internal/identity/classify.go` | `TestClassifyPaths` |
| 登录节流：pair 免费 5 次、IP 免费 30 次、窗口 15 分钟、延迟 `2<<shift` 上限 900 秒。检查不插入。`X-Forwarded-For` 取最后一跳，否则 `direct` | `src/auth/login_throttle.rs` | `TestLoginThrottleMath`；集成测试第 7 次未知邮箱登录为 429，正文 `{"error":"登录失败次数过多，请稍后再试","code":"RATE_LIMITED"}`，无 `Retry-After` |
| 会话栈、注销后提升、cookie：`sid` 与 `sids`，HttpOnly，SameSite=Lax，Path=/，Max-Age 604800。`CLOUD_COOKIE_SECURE` 去空白后恰好是 `0` 或 `false` 才不带 Secure | `src/auth/session_stack.rs`、`src/auth/session_view.rs` | `TestSessionStack`；集成测试在 `CLOUD_COOKIE_SECURE=0` 下断言两枚 cookie 且没有 Secure |
| 带 Idempotency-Key 的会话令牌：标签 `podhub-auth-v2`，seed 是库存密码哈希，key 是去空白后的头。pepper 是 `podhub-session-pepper-v1` 加 `CLOUD_SELLER_CREDENTIAL_KEY`（环境变量存在就用，含空串，不去空白） | `src/auth/crypto.rs` | `TestDeterministicSessionToken`；集成测试用库里的 bcrypt 哈希重算登录 JSON |
| 邮箱形状、名字、账号模式（owner / member / unaffiliated）、自有工作空间上限 3 | `src/auth/profile.rs`、`src/auth/account_mode.rs` | `TestEmailNameAndAccountMode` |
| 绝对并发预算：媒体上传 2、psd 6、控制面预留 16、控制面每用户 8、等候室每槽 8、等待 10 秒。超用户预算 429「当前用户的并发预算已用尽，请稍后重试」；打满 503「服务繁忙，请稍后重试」；两则 `code` 为 `internal`，`Retry-After` 夹在 1..30。OCR 与 AI 共用用户预算且不占全局槽。无 cookie 且无 Authorization 的请求不做用户公平 | `src/http/admission.rs` | `TestAdmissionRefusalBodies` |
| 租户事务：一条语句 `set_config('role','podhub_app',true)` 与 `set_config('app.current_org_id',…,true)`。Worker 只切 `podhub_worker`。都是事务局部 | `src/listing/kernel/tenant.rs` | `TestIdentityAndTenantIsolation` 的 `isolateTenants` |
| RLS：`listing_card_cursors` 对 `podhub_app` 强制 `tenant_isolation`。缺 GUC 时 SELECT 为 0 且 INSERT 失败。`podhub_worker` 是 BYPASSRLS，能看见两行 | migration `00109` | 同上 |
| API 隔离：A 的会话切换到 B 的 org 得到 403 `{"error":"无权切换到该 Workspace","code":"FORBIDDEN"}`，`active_org_id` 不变。A 的成员名单含 A 不含 B，owner 的 `inviteRoles` 是 `["manager","member"]` | 成员资格查询与 `MayInvite` | 同上 |
| 注册成功：一行 `account_sessions`（`token_hash` 为令牌的小写 hex SHA-256）、一行 `account_registered` 审计（writer lease 两列为空，摘要含「开通免费工作空间」）、一个 `plan=free` 的组织和一条 owner 成员。登录 JSON 字段顺序为 token、user、target；user 为 uuid、role、email、name，空 supplierId 省略。匿名会话字节为 `{"data":{"authenticated":false,"active_workspace":null,"workspaces":[],"unusable_workspaces":[],"accounts":[]}}`。新用户 `email_verified` 为 false，`account_mode` 为 owner | `src/auth/registration.rs`、`src/audit/mod.rs`、`src/auth/session_view.rs` | `TestIdentityAndTenantIsolation` |

没有 Docker 套接字且未设置 `PODHUB_PARITY_DSN` 时，集成测试跳过。GitHub Actions `ubuntu-latest` 有 Docker，`go test -timeout 25m ./...` 会跑。

## 不能证明一致

这些差异没有用「同一输入、同一输出」钉死。在补证据之前不要写成已经等价。

1. 黄金字节来自读过的 Rust 结构经 serde_json 的形状，不是一台活着的 Rust 进程。没有把 Rust 指到生产库。
2. 审计行的 `writer_lease_id` 与 `writer_fence_token` 写 NULL。writer lease（domain `auth`，holder `axum`）没有移植。这是行内容差异，不是优化。
3. 非空邀请码一律 400 `邀请码无效`。代理归因查询没有移植。空码与缺省仍是不绑定。
4. 注册会按邮箱回填未处理邀请的 `invitee_user_id`，不写通知行。
5. 已确认的 TOTP：登录直接 401 `{"error":"需要验证器代码","code":"TOTP_REQUIRED"}`，不校验验证码。文案和算法都没对照到 Rust 源码。管理端 `POST /api/admin/totp/enroll`、`POST /api/admin/totp/confirm` 与 `POST /api/admin/step-up` 已实现。未登记或未确认的 super_admin 仍签发 8 小时会话。
6. 浏览器交接页（GET/POST `/auth/handoff`）没有实现。`POST /api/auth/handoff` 返回 60 秒码，内存表丢掉了会话令牌，单次兑换从 HTTP 上看不到。
7. 不发 SMTP。重置与验证链接只落哈希。`password_changed` 摘要「修改密码」、`password_reset` 摘要「重置密码」、`email_verified` 摘要「验证邮箱」是按任务说明写的，没有打开对应的 Rust `json!`。
8. 改密成功体是登录 JSON 加新 cookie。切换工作空间成功体是切换后的会话 JSON。都没有对照 `identity/api.rs` 的 HTTP 包装。
9. 成员名单是投影 `id`、`email`、`role`、`displayName`、`status` 和 `permissions.inviteRoles`，不是 Rust 目录的完整 camelCase。
10. 派生并发上限没有在 `admission.rs` 里找到，目前写死：interactive 8、普通写 4、媒体探测 4、AI 2、全局 64。分类表按当前 OpenAPI 清理，已删除的批量入口及其独立预算不再保留。绝对预算见上表。
11. 会话 `expires_at` 用进程时钟加 TTL 再格式化成 RFC3339Nano。节流和「最近是否发过邮件」用 `clock_timestamp()`。两台时钟不一致时到期点会差。
12. 密码哈希信号量是 `max(GOMAXPROCS*2, 4)` 的 try-acquire，满了返回 429「请求过于频繁，请稍后重试」。与 Rust 信号量容量没有对拍。
13. 邮件令牌 60 秒内重发仍回 200、忘记密码无论地址是否存在都回 200、禁用账号不发令牌：逻辑按读过的说明实现，没有字节级对拍。
14. `55P03` → 503「资源正在更新，请稍后重试」且 `Retry-After: 1`；`P0M01` → 409「媒体对象已进入回收，请重新上传」（信封仍是 auth 的 `INTERNAL`）。SQLSTATE 分支没有在集成测试里打到。

## 只读 GET 接到会话

`internal/access.Resolver` 由 `identity.Service.Resolve` 实现，并挂在 `app.Handler` 的 `Server.Access` 上。只读 GET 因此使用会话里的 `user_id`、`org_id`、库存工作空间角色和平台角色。`GET /api/billing/usage-stats?rollup=1` 对主管及以上返回区间结束月份的本组织与当前成员汇总；普通用户访问 `GET /api/admin/banned-tags` 得到 403；未登录得到 401；A 的会话看不见 B 的准备作业。测试在 `TestIdentityAndTenantIsolation`。

管理端 GET 不做 TOTP 逐步提升。已确认验证器的超级管理员在登录时拿不到会话；已经存在的会话不会在这些 GET 上被要求再次验证。这和 Rust 的 step-up 还不能说相同。

禁用标签闸（`/api/listing/rules`、`validate`、`submit`）仍不读会话。带 cookie 的跨站 POST 会被 CSRF 拒绝，与认证写接口同一条中间件。

## 需要用户决定

- oapi-codegen 是否取代 utoipa。本 PR 只用它生成路由。
- 上面 2–14 是否接受为本阶段的缺口，还是要在合并前逐项补到与 Rust 字节一致。
- 派生并发上限（第 10 条）要用哪组池常量。在读到 Rust 数字之前，不要把 8/4/4/2/64 当成已经对齐。
