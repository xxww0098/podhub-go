# 工作空间 Cloudflare R2

切片存储归工作空间所有。只有工作空间所有者可连接 Cloudflare、创建或清理存储桶。一个空间只保留一个有效配置，同一物理桶不能成为两个空间的有效配置；成员使用空间共享桶上传切片，在设置中可浏览、预览及下载，不能执行存储管理写操作。设置位于「工作空间 → 存储桶」，地址、权限和密钥由系统配置，不提供手工密钥配置或 GIF；建桶前可选填写桶名。

当前状态：同一 Cloudflare 账户下的私有 OAuth 客户端已完成真实授权、自动建桶、凭据签发和对象回读验证；其他 Cloudflare 账户的授权链路尚未验证。生产客户端的域名验证已通过并已设为公开，生产 API 已配置 OAuth 参数并部署 0.0.2；生产授权链路尚待真实账号验收。缺少应用配置时，界面保留注册与开通引导，不显示可操作的连接或创建按钮。

## 首次使用

已有 Cloudflare 账号可直接登录并授权；没有账号可[注册 Cloudflare](https://dash.cloudflare.com/sign-up)。在[进入 R2](https://dash.cloudflare.com/?to=/:account/r2/overview) 后完成官方订阅结账流程。需要有效付款方式，不限于信用卡；Cloudflare 的付款方式还包括 PayPal 等，实际选项以结账页为准。参阅 [R2 开通要求](https://developers.cloudflare.com/r2/get-started/)、[付款方式](https://developers.cloudflare.com/billing/understand/billing-policy/)。平台完成 OAuth 应用接入前，登录 Cloudflare 控制台不代表已经连接 PodHub，也不能创建工作空间存储桶。

平台完成 OAuth 应用接入并验收后，空间所有者连接 Cloudflare，选择授权账户并确认切片图片可公开读取。Cloudflare 授权页会将 `Account API Tokens Write` 作为敏感权限单独展示，即使客户端将其设为必需，也须在授权时手动启用；该权限用于签发桶级凭据。桶名留空时生成 `podhub-<去掉连字符的随机 UUID>`，也可填写 3–63 个字符的小写字母、数字和连字符，首尾为字母或数字，不允许中文。系统创建桶、配置本站 origin 的 CORS、开启 r2.dev 访问并申请仅此桶可用的 S3 凭据。真实上传、私有及公开字节回读、列举和删除探针通过后才激活。

[标准存储免费额度](https://developers.cloudflare.com/r2/pricing/)每月含 10 GB-month，属于整个 Cloudflare 账户共享额度，不是每个桶的容量上限。超出后按量计费。r2.dev 是有限速的开发地址；[生产公开访问](https://developers.cloudflare.com/r2/buckets/public-buckets/)应使用自有域名，该绑定不包含在本次自动创建范围内。

## 平台 OAuth 配置

由平台运营者在自己的 Cloudflare 账户[创建 OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)，普通空间用户无需注册应用。

- 使用授权码模式、`client_secret_basic` 和 S256 PKCE；不得借用 cf/Wrangler 的 client。
- 回调：`<CLOUD_PUBLIC_URL>/api/workspace/slice-storage/cloudflare/callback`。
- 所需权限包含账户读取、`Workers R2 Storage Write` 和 `Account API Tokens Write`。后者也可读取账户令牌权限组。通过官方 `GET /client/v4/oauth/scopes` 获取实际 OAuth scope 标识，不猜测名称。同一 Cloudflare 账户已验证真实 OAuth 可签发目标桶级令牌；其他账户仍待验收。
- 面向其他 Cloudflare 账户前，完成发布者域名验证并开放 client。默认私有 client 仅用于所属账户成员验证。
- 服务端设置 `CLOUDFLARE_OAUTH_CLIENT_ID`、`CLOUDFLARE_OAUTH_CLIENT_SECRET`、`CLOUDFLARE_OAUTH_SCOPES`、显式 `CLOUD_PUBLIC_URL`、现有配置加密密钥，并开启媒体清理服务。生产回调必须 HTTPS；本地允许 HTTP loopback。

OAuth state 和 verifier 在加密 HttpOnly Cookie 中保留 10 分钟。access token 在另一个加密 HttpOnly Cookie 中保留最多 15 分钟，附加数据绑定用户、工作空间和本站登录会话。切换空间、用户或登录会话后，旧授权不能复用。Cookie 路径覆盖存储创建接口，JavaScript 不获得 bearer token。不申请或保留 refresh token。

OAuth 断开接口撤销尚有效的本轮 access token 并清除 Cookie；授权已过期或不存在时只清除 Cookie。撤销失败时保留连接状态供重试。断开不删除桶或持久化的桶级 S3 令牌。工作空间运行和清理使用加密持久化的桶级令牌。重新登录会先断开本轮授权再发起授权；若要切换 Cloudflare 网站的登录账号，须先在 Cloudflare 控制台退出。若需停止桶级凭据，应在 Cloudflare 中撤销对应 `PodHub <桶名>` 令牌。

## API 与重试

所有接口使用本站会话。写接口沿用同源 CSRF 防护。完整 DTO 以 `api/openapi.yaml` 为准。

| 路径（前缀 `/api/workspace/slice-storage`） | 行为 |
| --- | --- |
| `GET` 前缀本身 | 当前空间配置、所有者能力、清理和未完成创建状态；不返回密钥 |
| `POST` 前缀本身 | 所有者提交 `account_id` 和 `public_access: true`，系统自动完成配置 |
| `POST /clear` | 所有者请求清理切片，由 worker 处理 |
| `PATCH /cleanup` | 所有者选择每天北京时间清理或仅手动清理 |
| `GET /objects` | 在当前配置的 uploads 前缀内分页浏览，支持路径前缀、目录与游标 |
| `GET /stats` | 列举当前切片实际容量及数量；未扫完明确返回 `complete: false` |
| `GET /download` | 为合法的当前配置切片 key 签发 5 分钟下载 URL |
| `POST /objects/delete` | 所有者删除指定切片或递归删除文件夹，每批最多 100 项，先退休租约再精确删除 |
| `POST /cloudflare/authorize` | 返回授权地址并设置 state Cookie |
| `GET /cloudflare/callback` | 验证 state 和 PKCE、兑换授权码，然后 303 回到当前设置页 |
| `GET /cloudflare/accounts` | 分页读取授权账户，列表不完整时失败 |
| `GET` / `DELETE /cloudflare` | 查询本轮短期连接 / 撤销 OAuth 授权 |

创建先在 `workspace_slice_provisions` 为空间保留随机 UUID 与桶名，并用空间级 PostgreSQL 会话锁串行化。每个已完成阶段独立提交：`creating → bucket_ready → token_creating → verifying → ready`。重试使用原账户、原桶名和原配置身份；开始创建后及激活后均不能改名。默认随机桶创建结果不确定时先 GET 回读；明确冲突进入 `blocked`。自定义名称在 POST 前先保存 `blocked` 检查点，避免进程中断后接管不明来源的同名桶。Cloudflare 明确拒绝且未创建时，仅释放本地自定义名称保留记录；同名冲突返回 409，可换名重试。结果不确定则保留检查点、停止外部写入，要求人工核对。

迁移 `00032_workspace_bucket_names.sql` 记录自定义名称来源，将名称唯一范围调整为 `(Cloudflare 账户 ID, 桶名)`，允许不同 Cloudflare 账户使用相同名称；现有配置、桶、对象和凭据不变。

签发 S3 令牌是一次性凭据操作。先保存 `token_creating`，再向上游发请求。明确拒绝可以重试；网络中断、5xx、响应损坏或服务中断留下未知结果时停止自动签发，要求人工核对 Cloudflare 中的桶与同名令牌。不会把未知状态显示为可用。验证失败保留加密候选，下一次继续验证；只有验证通过才原子激活。

桶级令牌策略仅包含 `com.cloudflare.edge.r2.bucket.<account>_default_<bucket>` 的 `Workers R2 Storage Bucket Item Write`。S3 Access Key ID 使用令牌 ID，Secret Access Key 使用令牌值的 SHA-256，不把 OAuth access token 当作 S3 密钥。参阅 [R2 凭据](https://developers.cloudflare.com/r2/api/tokens/)。

## 切片复用与自动清理

上传准备按工作空间、当前存储配置及修订、SHA-256、扩展名和字节数查找对象。已验证对象返回 `transport: ready`，沿用原物理目录，不再 PUT，也不重复扣本月上传额度；同时续期四小时使用租约。尚未完成的并发首传共享同一对象键和一次额度预占，仍返回直传授权；条件 PUT 防止覆盖，每个调用者用自己的签名回执确认，pending 不当作成功。不同空间不共享复用，退休、删除、清理中、手动清理之前及超过 28 天提交时限的对象不能命中。前端检查服务端选定的物理批次；混合批次确认分别由完整对象键和签名票据限定。

冻结提交时，将切片来源 URL 写入不可修改的 `submission_intents.slice_image_urls`。Ozon 导入受理、任务完成或商品 ID 都不单独证明抓图成功；必须回读 `/v2/product/pictures/info`，确认同一商品、无图片错误、回执覆盖本次全部切片来源 URL，才保存回执和数据库时间 `slice_images_fetched_at`。若只返回无法对应来源的 CDN 链接，保留未知状态和切片，不按数量推断成功。网络失败、限流或仍在处理时延后重读，不重复导入。

每日自动清理只处理所有引用均确认抓图超过 24 小时、使用租约已过期、最后一次上传或复用超过 16 分钟的对象。待提交商品、活动任务、商品源图、供应商素材和长期媒体引用均阻止回收。引用写入持有共享身份锁；清理取得排他锁后以新数据库快照重查，再不可逆退休；R2 请求不持有数据库锁。分页会跳过受保护对象，继续处理后续页面，删除失败或查询失败按原回执机制重试。运行完成表示本轮可安全删除的对象已清理，不表示桶已清空。

迁移 `00039_slice_reuse_cleanup.sql` 增加冻结引用、抓图证据与索引。仅在新上传租约中标记 `slice_gc_tracked`；旧对象可能缺少历史引用证据，仍可复用，但不纳入自动回收。未使用、抓图失败或未知的切片也保留，可由所有者核对后手动删除。自动清理不再以每日时间边界批量撤销仍受保护的上传批次；显式手动清理仍会撤销旧批次。

此流程需要完成数据库迁移，并运行 reconciler 和媒体清理 worker。仅手动清理模式不执行自动回收。Cloudflare 自身的生命周期规则不受应用引用保护约束，不能另配短期强制过期来替代上述判断。未引入多账号、跨账号额度池或桶轮换。

## 数据迁移与管理范围

迁移 `00031_workspace_slice_storage.sql` 将个人表改为工作空间表。旧配置只映射给创建者拥有的一个未解散空间，优先其当前空间，否则选择最早空间。无法确定归属的配置及重复物理桶配置退休，凭据保留供原前缀清理。原配置 UUID、加密上下文和对象 key 保留，不复制云端对象。该所有权迁移不能自动安全回滚。

RLS 允许同空间读取，写入还检查实际空间所有者。创建者仅作为不可变的加密上下文保留，后续共享读取不按创建者过滤。上传、发送前检查和清理都使用当前空间配置。

管理仅覆盖本配置 `podhub-slices/<配置 UUID>/uploads/`，不展示或删除桶中的其他用途对象。对象和文件夹删除要求批次及最后一次上传授权或确认均已超过 16 分钟，避免尚有效的 PUT 授权重新写回；目录中已授权但尚未上传的对象也会阻止删除。文件夹通过含配置 UUID 的完整前缀绑定空间，拒绝根目录、其他配置与非规范路径；每批从目录重新列举最多 100 项，删除后回读，客户端在 `has_more` 为 true 时继续。遇到失败或未过期上传即停止并刷新，已完成的批次不会回滚；重试保留原租约退休时间。并发的新上传仍可能在删除完成后出现。成员没有删除入口，服务器删除开关关闭时按钮禁用。所有者可选择每天指定时间自动清理或仅手动清理；自动和全量手动清理通过 worker 执行，清理回执未确认时如实显示未知状态。

容量统计一次最多扫描 100,000 个对象、30 秒。达到页数上限时界面显示“至少”；上游失败显示统计不可用，不显示账户额度百分比。该统计是列举过程中的观察值，不是账单快照。

交互参考 [localflare](https://github.com/rohanprasadofficial/localflare) 的 R2 浏览、对象详情及下载管理，以及 [Nextcloud](https://docs.nextcloud.com/server/stable/user_manual/en/files/access_webgui.html) 的目录导航与缩略图网格。管理页以文件夹图标和图片网格展示，按内容区宽度自动换列；保留前缀搜索、上一级与面包屑、选择、下载及递归删除，缩略图懒加载并提供失败回退。未引入参考项目的存储服务，也没有把本地模拟结果作为 Cloudflare 外部证据。

## 验证

本地 PostgreSQL 测试覆盖迁移、所有者写限制、空间共享与跨空间隔离、物理桶唯一性、候选加密落库、失败验证后恢复、重复请求不重复建桶或签发凭据，以及凭据结果未知时停止重试。固定上游测试覆盖 CORS、桶级策略、密钥派生、OAuth PKCE、Cookie 空间/用户/会话隔离、篡改、过期、CSRF、重定向与错误脱敏。

2026-11-03 使用已有 Cloudflare 账号和本地私有客户端完成真实 OAuth 授权及回调，在独立工作空间 `Cloudflare OAuth 验收` 中创建 `podhub-23dc0e88bffe467bb916dfd8bd84733c`。系统签发并加密保存桶级凭据，实际探针完成 PUT、浏览器来源 CORS 预检、私有和公开字节回读、列举、精确删除及删除后回读，再激活配置。首次 PUT 失败且原因未确认；系统保留原桶和凭据，同一配置重试后通过。独立签名 PUT 和 DELETE 也通过；退出 OAuth 授权返回 204 后，桶配置和对象列举仍可用。验收后该桶保留，容量和对象数均为 0。

生产 `PodHub` 客户端已配置回调和品牌徽标，`podhub.si` 的发布者 TXT 记录已添加且可通过公共 DNS 回读；Cloudflare 已显示域名验证通过，并在用户确认后设为公开。生产 0.0.2 已配置三个 OAuth 变量并部署本轮存储桶改动；API、数据库、写入租约、工作进程及旧站健康检查通过，数据库无新增迁移。尚未验证其他 Cloudflare 账户授权、生产公开客户端以及真实权限不足场景，不能宣称全部外部账户可用。直接 API 建桶测试 `PODHUB_CLOUDFLARE_LIVE_CREATE=1` 只能证明直接建桶；现有 `PODHUB_TEST_WORKSPACE_R2_LIVE=1` 切片测试只证明指定测试桶数据通路，两者都不能替代完整 OAuth 验收。没有凭据时均明确跳过。
