# 架构约束

本文维护稳定的系统边界。目录与依赖规则见 [项目树](architecture-tree.md)，产品能力的验证状态见 [精铺技术验证清单](precision-listing-verification.md)。[AGENTS.md](../AGENTS.md) 的新工程、不旧兼容与功能准入要求优先；历史对拍报告不额外冻结已被明确调整的产品行为。

## 系统边界

PodHub 是多租户、多电商平台 SaaS。公共业务按域组织；Seller 出口的具体实现归 `internal/seller/<平台>`，前端上架适配归 `web/src/features/workflow/platforms/<平台>`。`internal/platform` 表示技术基础设施，`features/platform` 表示 SaaS 管理配置，二者都不是电商平台适配目录。当前 Seller 发布传输只有 Ozon 实现，WB 上架本地预览不代表外部发布链路已通过；具体目录、剩余耦合与准入边界见[项目树](architecture-tree.md#多平台-saas-边界)。

| 部分 | 位置 | 职责与限制 |
| --- | --- | --- |
| React 前端 | `web/src` | 真实页面、交互、HTTP API 与浏览器 WASM；不持有服务端密钥，不决定服务端结果 |
| Go 服务端 | `cmd`、`internal` | API、worker、授权、写入租约、数据库与外部 I/O；不复制 Rust 内核业务逻辑 |
| Rust/WASM | `rust`、`wasm` | 规则、冻结、状态转移与渲染；纯函数内核无 SQL、HTTP 或时钟，不碰密钥 |

Go 不提供页面、静态资源或服务端渲染。Vite 开发代理将 `/api` 与 `/mcp` 发到 Go；生产前端另行同源分发。HTML 预览和测试夹具只用于验收，产品界面必须在 `web/src`。

## 契约与变更

`api/openapi.yaml` 是 HTTP 契约源，描述当前 Go 实现的路由、状态码和响应形状（[D14](decisions.md)）。oapi-codegen 仅为保留的 7 个单元（agent、catalog、health、identity、listing、listing-rules、media）生成 Go models 与路由，其余域的 HTTP 层手写（[D24](decisions.md)）；前端生成 `schema.d.ts` 和 `routes.ts`，生成物不手改。

- `TestRouteTableMatchesGolden` 与 `TestRoutePathsCoveredByOpenAPI` 校验挂载路由及 method+path 覆盖；前端 `routes.test.ts` / `mounted.test.ts` 校验路径与挂载边界。
- `tests/testkit/openapi.go` 的响应检查由 `tests/integration/openapi_check_test.go` 中登记的前缀覆盖。spec 存在或返回 501 不代表功能实现。
- 纯重构保留既定结果并提供回归证据；明确改变产品行为时同步修改调用方、契约、测试和文档，不为旧接口保留兼容分支。
- 不能把请求受理、队列完成、模拟成功或已有商品等同于审核完成或在售。新增精铺能力的实际输入、持久化、失败处理和外部回读按技术验证清单验收。

## 上架规则与 WASM

`rust/crates/listing-core` 同一份源码分别构建服务端和浏览器模块。Go 只经 `internal/platform/wasm` 的 wazero 调用已编译 WASM；不链接 Rust 原生库、不启动 Rust 子进程、不增加 `GOOS=js` / `GOARCH=wasm` 目标。服务端保存与提交仍由服务端校验。

| 产物 | 消费方 |
| --- | --- |
| `wasm/dist/server/listing-core.wasm` | Go 上架内核与禁用标签匹配（op 20） |
| `wasm/dist/browser/listing-state.wasm` | 浏览器上架规则，使用 `--features browser` |
| `wasm/dist/browser/render/` | 浏览器 PSD 渲染；threaded 的 JS、类型、WASM 与 snippets 必须同次构建 |

`make wasm` 本地重建整套产物并刷新清单；Go/Web/Docker 构建消费已提交产物。CI 还单独运行 Rust 原生测试，但不重建 WASM。构建步骤与体积、导出契约见 [项目树](architecture-tree.md#本地-wasm-交付与-ci) 和 [D22](decisions.md)。哈希一致只能发现漂移，不能独自证明产物由对应源码编译。

禁用标签来自平台表 `public.banned_tags`，管理写入要审计。规则版本握手、提交前标签闸及 schema revision 的现有行为见 [listing-core-host](parity/listing-core-host.md)、[schema-revision-parity](parity/schema-revision-parity.md)。是否进一步统一模块或改变标签策略只在[决策登记](decisions.md)维护，不在此重复一份开放清单。

## 租户隔离

业务查询带 `org_id`，请求事务使用 `podhub_app` 与 `app.current_org_id`，由 RLS 限制租户。跨租户队列领取才使用对应 worker 会话；回到租户业务写入时重新进入租户会话。

新代码使用 `internal/platform/db.InTx`，调用方必须显式传入会话；空会话或无有效组织的 `App(orgID)` 都在开事务前拒绝。会话构造器及其边界见 [项目树](architecture-tree.md#数据库薄封装)。底层角色/GUC 设置集中在 `tenantx`，业务代码不手写 `set_config`；尚存的旧调用由架构基线逐步收敛。平台表是否采用 RLS 及其授权必须按表定义，不能把「全平台」当作任意会话可读写。

## 安全开关与外部出口

环境变量只由 `internal/platform/config` 解析，再注入业务层；`tests/archtest` 禁止新增业务侧 `os.Getenv` / `os.LookupEnv`。

| 开关 | 语义 |
| --- | --- |
| `OZON_WRITE_KILL_SWITCH` | 去空白、ASCII 小写后，`1/true/yes/on` 关闭 Seller 写；未设、空值及其他值保持写入开启。读不受该开关影响 |
| `CLOUD_MEDIA_GC_DELETE` | 未设时开启；`1/true/on/yes` 开启，`0/false/off/no` 关闭；其他值（含空值、非 UTF-8）记录错误并关闭，进程不因解析失败退出 |
| `PODHUB_LOADTEST_MODE` | 只允许 Mode R；该模式不打开外部网络、不写 Ozon、不删对象 |
| `CLOUD_DATABASE_ALLOW_REMOTE_HOST` | 仅 `1/true/yes/on` 允许 `DATABASE_URL` 使用非回环主机；未设置时保持只允许回环 |

`DATABASE_URL` 默认只允许空值或回环地址；非回环主机还要显式设置 `CLOUD_DATABASE_ALLOW_REMOTE_HOST=1`，避免复制 DSN 后静默连到未授权数据库。通用 Seller 出口与环境配置的假桶清理路径仍有限制；显式绑定的官方 Seller 传输、模型调用和资产存储有各自的授权与出口校验，不能再概括为「本进程永不访问外部服务」。具体实现边界见 [Ozon 出口](architecture/ozon-egress-connection.md)、[存储约束](architecture/storage-common.md)，真实能力及未部署范围见[技术验证清单](precision-listing-verification.md)。

## 队列与迁移

River 负责运行 worker；业务 `jobs.state`、租约、退避和幂等由 `internal/queue` 决定。类型与错误归 `queue/contract`，仓储操作由 `internal/app` 显式传入执行循环、上架提交和商品同步实例；不依赖 `init` 注册或空白导入。实现差异与原对拍证据见 [queue-and-migration-differences](parity/queue-and-migration-differences.md)。

迁移历史已压缩为三个基线文件：`00001_roles.sql`（运行时角色与成员关系）、`00002_schema.sql`（head 的完整 schema，含 RLS、函数、触发器、授权与默认权限）、`00003_seed.sql`（运行时读取的配置行）；基线之后的新增迁移从 `00004` 起正常叠加。`00004_drop_admin_totp.sql` 删除管理员验证器，`00005_drop_email_verification.sql` 删除邮箱验证状态与验证令牌，密码重置保留。`00002` 是 head 数据库的 `pg_dump --schema-only`，排除了 River 与 goose 自己的表；函数体、触发器、策略与 ACL 与压缩前的 head 逐项一致。基线 Down 为 `SELECT 1`，不提供数据回滚。

已提交迁移不可改，新增迁移号必须大于基线最大号，由 `migrate_guard_test.go` 与 `db/migrations.sha256` 约束。版本连续，`gooseUp` 用默认的严格 `Up`；`WithAllowMissing` 已移除。计划文档不预占具体迁移号。
按旧 329 文件链迁过来的库，`goose_db_version` 里记着本目录不存在的版本（最高 368），goose 只比对自己能看到的文件，所以新加的 `00004` 会被当成已执行而静默跳过。`gooseUp` 因此在 `Up` 之后核对已应用版本集合：只要目录里有高于基线的新文件，这种库就以错误退出并指出 368，需要按基线重建（开发库 `RESET_DB=1`）；目录仍只到基线时它已在 head，照常启动。

许可、队首、媒体引用和不可重写账本等数据库不变量必须保持；需要修改其行为时以新迁移明确表达，并补回归，不能改写已提交迁移规避守卫。生产发布用 `cmd/migrate` 一次性作业，在 API、worker 和 lease keeper 启动前执行；API 启动不自动迁移，见 [D26](decisions.md)。

## AI 协议与计费

`internal/platform/aiclient` 只做三种协议的原生请求与响应处理：`/api/ai/chat/completions` 对应 Chat Completions，`/api/ai/v1/messages` 对应 Anthropic Messages，`/api/ai/responses` 对应 Responses。每个入口按自己的格式调用同格式的上游账号，不做跨协议转换，也不支持流式响应。

`internal/billing/contract` 的四路整数计价是唯一结算路径；`internal/ai/service` 负责把各协议 usage 归一成同一组 token 口径。上游账号由 `internal/app/text_runtime.go` 按模型、格式和用途选择，出站走 `internal/platform/httpx.PublicClient` 的公网地址固定与校验。细节见 [ai-billing-parity](parity/ai-billing-parity.md)。

仓库是专有软件，见 [D6](decisions.md)、根目录 `LICENSE` 与 `NOTICE`。
