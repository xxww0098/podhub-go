# podhub-go

PodHub Cloud 是多租户、多电商平台 SaaS，包含 React 前端、Go 服务端与 Rust/WASM 内核。公共业务按域组织，电商平台协议由具体适配器承接。按新工程演进，允许破坏性变更，不以旧接口兼容为目标；具体约束见 [AGENTS.md](AGENTS.md) 和 [架构约束](docs/architecture.md)。

## 开发与检查

Go 版本以 [go.mod](go.mod) 为准，前端使用 Bun。普通 Go/Web 构建消费已提交的 WASM；修改 Rust 或 WASM 构建输入时才需要重建产物。

```sh
# 仓库根
bash dev.sh           # Docker 开发库、迁移、Go API 与 Vite 一起启动
make test             # Go 测试；集成测试的数据库条件见下文
make build            # 校验 WASM 后构建 API、migrate、lease-keeper、四个 worker、writer-lease 和 admin-init
make generate         # sqlc 与各域 OpenAPI Go 代码
make ci               # Rust 原生测试、Go 检查、生成物差异检查

# 前端
cd web
bun install
bun run dev           # Vite :1420；/api 与 /mcp 代理到 127.0.0.1:8080
bun run api:generate  # OpenAPI → schema.d.ts
bun run api:routes    # schema → routes.ts
bun run check         # build → test → api:check → deadcode → lint
```

`dev.sh` 需要 Docker、Go 和 Bun。启动前会回收自己的开发端口：上一次留下的 `dev.sh` 会被停掉（走它自己的清理），本仓库遗留的监听进程直接结束；其他程序占着端口时只报出 pid 并退出，不会杀。开发库是 `podhub-dev-pg` 容器加 `podhub-dev-pgdata` 卷，重启只补跑未应用的迁移，数据默认保留；`RESET_DB=1` 丢弃卷并从零迁移，`KEEP_DB=1` 让 Postgres 在退出后继续运行（默认停止但不删除）。它关闭 Ozon 写入，默认关闭媒体删除；在 `.env` 或 `.env.local` 中设置 `CLOUD_MEDIA_GC_DELETE=1` 和 `CLOUD_INTEGRATION_CONFIG_KEY` 后重启，会运行清理 worker 并允许手动删除文件和文件夹。额外设置 `DEV_MEDIA_GC_WORKER=0` 可停止本地清理 worker，保留手动删除；此时全量清理请求和定时清理不会执行，直到 worker 启动。默认 API 为 `127.0.0.1:8080`、Web 为 `127.0.0.1:1420`。`bun run dev` 只启动前端，需要另行运行 Go API；Vite 的 API 代理默认指向 `http://127.0.0.1:8080`，可用 `DEV_CLOUD_URL` 覆盖。`DATABASE_URL` 默认只接受回环地址；非回环主机还要显式设置 `CLOUD_DATABASE_ALLOW_REMOTE_HOST=1`。

写入租约：写路径只认 `CLOUD_INSTANCE_ID` 对应、60 秒内有心跳的 `writer_leases` 行，否则返回「店铺名册写入未启用」之类的 503。`scripts/dev-api.sh` 把实例固定为 `dev-local`（可用 `CLOUD_INSTANCE_ID` 覆盖），先接管全部八个域，再由 `scripts/devlease` 每 20 秒续期，随脚本退出而停止。它会撤销本地库里其他实例的租约，只用于开发库；生产由 `lease-keeper` 服务首次发放并每 20 秒续期，也可用 `writer-lease bootstrap <域>` 手动发放。

本地 API 依次加载 `.env` 和 `.env.local`，后者覆盖前者；本地测试 R2、数据库及其他开发配置放在被 Git 忽略的 `.env.local`。Vite 不接收这些服务端凭据。修改后重启 `dev.sh` 生效；生产 Compose 默认只加载 `.env`。

本地使用 Compose 时显式加载两个文件。以下命令以 `http://localhost` 访问，并关闭媒体删除；切片存储桶由工作空间所有者在设置中填写。

```sh
CLOUD_PUBLIC_URL=http://localhost CLOUD_MEDIA_GC_DELETE=0 \
  docker compose --env-file .env --env-file .env.local up -d
```

Compose 的媒体清理 worker 不读取 `DEV_MEDIA_GC_WORKER`；启用 `CLOUD_MEDIA_GC_DELETE` 前须确认要运行自动清理。

店铺密钥用 `CLOUD_SELLER_CREDENTIAL_KEY` 加密托管，开发与正式环境一样只从环境变量读取，不设置时批量导入返回「Seller 密钥托管未配置」。本地写进被忽略的 `.env.local`（`dev-api.sh` 会载入），生成方式见 [.env.example](.env.example)；换掉它会让已托管的密钥无法解开。

普通集成测试从共享 Docker PostgreSQL 模板克隆数据库，也可使用回环 `PODHUB_PARITY_DSN`；两者都没有时，这部分用例会跳过。使用 `StartPostgres` 的独立集群测试在 Docker 不可用时，仅在 Linux 尝试本地 PostgreSQL，启动失败会报错。不能把跳过算作通过；显式 DSN 必须是可迁移、可写测试数据的专用库。`make ci` 最后执行 `git diff --exit-code`，已有工作区修改也会让这一步失败。

## 部署到 VPS

单机生产形态见 [compose.yaml](compose.yaml)：Postgres、一次性 `migrate` 作业、API、`lease-keeper`、四个 worker，以及同源提供 SPA、`/api` 和 `/mcp` 反代的 Caddy。

1. 安装 Docker Engine 与 Compose v2，放行 80/443；域名 A/AAAA 记录指向主机。
2. `cp .env.example .env`，至少填写 `POSTGRES_PASSWORD`、`PODHUB_API_DB_PASSWORD`、`PODHUB_WORKER_DB_PASSWORD`、`CLOUD_INTEGRATION_CONFIG_KEY`、`CLOUD_SELLER_CREDENTIAL_KEY`、`CLOUD_PUBLIC_URL`。这些密码会原样拼进 DSN，只能使用 URL 安全字符（`A-Z a-z 0-9 - . _ ~`）；不要使用 `@ : / ? # %`。本地 HTTP 调试用 `PODHUB_SITE_ADDRESS=http://localhost` 和 `CLOUD_COOKIE_SECURE=0`；线上用域名并把 `CLOUD_COOKIE_SECURE` 保持为 1。
3. `docker compose up -d --build`。启动顺序由依赖固定：`migrate` 成功后才启动 API/worker/lease-keeper。
4. 首次初始化超管：`docker compose run --rm -it --entrypoint admin-init api`。
5. 打开 `/`（用户端）或 `/admin`，并检查 `/api/health`：`writer_leases` 应列出八个域且心跳持续更新。

`lease-keeper` 是必需服务。它把 `CLOUD_INSTANCE_ID` 固定的实例租约每 20 秒续到 60 秒 TTL；停掉它后，各域最后一次写入 60 秒后返回 503「店铺名册写入未启用」。不要给 API、worker 和 keeper 设置不同的实例 ID。

`worker-media-gc` 默认开启并常驻消费清理任务（`compose.yaml` 未设置时传 `1`）。设置 `CLOUD_MEDIA_GC_DELETE=0` 后该服务会正常退出，`docker compose ps` 显示 `Exited (0)`，这不是故障；恢复清理时删除该变量并重启服务。

升级：先备份 Postgres 卷，再 `docker compose build && docker compose up -d`；`migrate` 会重新执行，失败时 API 不会启动。回滚应用镜像不能回滚已执行的迁移，破坏性迁移需单独备份。

## 初始化超级管理员

数据库完成迁移后，在交互终端执行一次：

```sh
# 使用与 API 相同的 DATABASE_URL；下面是 bash dev.sh 默认的开发库
DATABASE_URL='postgres://podhub_login_api:podhub@127.0.0.1:55432/podhub?sslmode=disable' go run ./cmd/admin-init
```

按提示输入邮箱和密码，密码不回显，也不接受命令行参数或管道输入。命令在一个事务内创建唯一超级管理员、初始化记录和审计；失败全部回滚，重复或并发执行不会覆盖账号及密码。已有同邮箱账号不会被提升权限。超管不附带租户工作空间，普通用户在初始化后才能注册。

打开站点的 `/admin`，用邮箱和密码登录即可。超级管理员权限只由平台角色 `super_admin` 决定，没有验证器、恢复码或额外的二次验证步骤，也没有 step-up 时限；API 进程不需要任何验证器密钥。

普通账号注册后即可使用，不要求验证邮箱，也不显示验证提醒或重发入口。邮箱仍需满足格式要求。邮件找回使用 TLS SMTP 和持久化加密发件箱。普通、管理员和工厂登录页均有找回入口；`POST /api/auth/forgot` 受理后统一返回 200，不能据此判断账号存在或邮件已送达。缺少邮件、公开站点地址或加密密钥配置时统一返回 503。

平台和工厂账号可在账号设置中更换邮箱：输入当前密码并向新邮箱发送确认链接。确认前仍使用原邮箱登录；确认后所有设备需使用新邮箱重新登录。换绑与密码找回复用同一邮件配置和发件箱，申请受理不代表邮件已送达。

配置 API 进程的 `CLOUD_SMTP_ADDR`（主机:端口）、`CLOUD_SMTP_FROM`、`CLOUD_SMTP_USERNAME`、`CLOUD_SMTP_PASSWORD`、`CLOUD_SMTP_TLS_MODE`（默认 `starttls`，465 端口通常用 `tls`）、`CLOUD_PUBLIC_URL`（前端公开 HTTPS 根地址；本地允许 loopback HTTP），以及至少 32 字符的 `CLOUD_INTEGRATION_CONFIG_KEY`。授权码写入本地 `.env.local`，经开发启动脚本加载后重启 API；生产使用环境变量/密钥管理。不得更换正在使用的加密密钥来启用邮件。API 启动后独立扫描发件箱，每 5 秒认领最多 4 封，SMTP 请求不持有数据库连接。只有 API 进程负责投递，不依赖队列 worker。

重置和换绑链接有效期 30 分钟，单次使用；同一账号 60 秒内不重复签发同类链接。找回申请每个 IP 每 15 分钟最多受理 5 次，超限返回 429 和 `Retry-After`。临时投递失败使用原令牌退避重试（1/2/4/8 分钟，最多 5 次）；永久拒信、到期或重试耗尽后作废该链接并擦除加密载荷。密码、邮箱变更或禁用账号会作废旧链接；成功重置密码或换绑邮箱撤销该账号的所有会话。SMTP 确认丢失时可能收到重复邮件，其链接仍只能使用一次。

排障可查看 `password recovery mail delivery` 日志的 `state/reason/attempt`，以及 `auth_password_reset_deliveries` 的状态与 `last_error_code`；均不记录收件地址、授权码或令牌。服务不可用期间未受理请求，恢复配置后可重新申请。临时失败自动重试，永久失败可修复配置/收件地址后重新申请；清理超过 7 天的过期令牌及对应投递记录。验证真实收件时，须使用已配置的 SMTP 和授权收件地址；隔离测试不会投递外网。

`make build` 同时输出 `bin/admin-init`，Docker 镜像包含同名命令；在能连接数据库的部署环境中用交互终端运行它即可，使用普通 API 数据库角色，无需为此开放数据库超级用户。初始化不会修改数据库迁移或业务写租约。

生成器版本统一维护在 [Makefile](Makefile)，`make generate` 会在缺少或版本不符时安装。环境开关的当前语义见 [架构约束](docs/architecture.md#安全开关与外部出口)；[.env.example](.env.example) 只覆盖部分配置，完整解析在 `internal/platform/config`。

切片使用工作空间所有者在「设置 → 工作空间」中填写的 Cloudflare R2 端点、桶名、公开地址和 API 令牌，不读取 `R2_TRANSIT_*`，不回退到系统中转桶；每个配置使用独立前缀，保存前会真实验证上传、读取、列举和删除。所有者可设置每天北京时间指定时间自动清理，或仅手动清理；默认每天 04:00。存储桶需启用公开访问，并允许当前站点通过 CORS 使用 GET、PUT 及 `Content-Type`、`If-None-Match`、`X-Amz-Checksum-Sha256` 请求头。服务端使用 `CLOUD_INTEGRATION_CONFIG_KEY` 加密凭据，并需要启动 `worker-media-gc` 和启用 `CLOUD_MEDIA_GC_DELETE` 才能执行定时和手动清理。用户 PSD 仅保存在本机，不上传云端；平台素材桶和私有数据桶由超级管理员在「平台管理 → 系统存储桶」手动填写，详见[存储配置](docs/architecture/storage-common.md#服务端配置)。

测试环境的系统桶可使用 `podhub-test-supplier` 和 `podhub-test-delegate`；前者须明确填写自己的公开地址 `https://pub-<32位小写十六进制>.r2.dev`，私有桶留空。切片测试桶在用户设置中填写。填写配置不会自动开放 Cloudflare 公共访问权限；浏览器直传还需按[存储配置](docs/architecture/storage-common.md#服务端配置)设置各桶的 CORS。

## 目录与契约

| 路径 | 职责 |
| --- | --- |
| `web/src` | 真实 React 页面、组件、API 接线与浏览器 WASM 适配；界面规范见 [web/README.md](web/README.md) |
| `cmd`、`internal/app` | API、五个 worker、writer-lease、admin-init 的进程入口与唯一装配层 |
| `internal/<域>`、`internal/platform` | 业务分层与基础设施；边界由 `tests/archtest` 约束 |
| `internal/seller/contract`、`internal/seller/ozon` | 消费方出口契约与 Ozon 实现；其他平台按真实接入需要扩展，不复制租户、计费和队列 |
| `api/openapi.yaml`、`api/codegen` | HTTP 契约与 Go 生成配置；前端类型和路径表也由此生成 |
| `db/migrations`、`db/queries` | 三个压缩基线文件（角色、schema、种子）加追加式 goose 迁移与 sqlc 查询；已提交迁移由 sha256 守卫保护 |
| `rust/crates` | 单一 Rust workspace，负责上架规则、标签匹配与 PSD 渲染 |
| `wasm/dist` | 入库的服务端、浏览器和测试 WASM，以及 `SOURCES.sha256` 清单 |
| `tests`、`web/tests`、`fixtures` | 分层、集成、对拍与前端验收；HTML 夹具不代替产品界面 |

HTTP 路由、状态码和响应形状以当前 Go 实现及 [OpenAPI](api/openapi.yaml) 的一致性检查为准：`TestRouteTableMatchesGolden`、`TestRoutePathsCoveredByOpenAPI` 和前端 `routes.test.ts` / `mounted.test.ts`。不要在文档中另存易漂移的路由总数；未实现或未挂载接口不代表可用能力。

服务端通过 wazero 加载 `wasm/dist/server/`；浏览器直接加载 `wasm/dist/browser/`。两侧共用 Rust 内核源码，各自使用对应 ABI/feature 的产物。Go 不提供页面或静态资源，生产前端需另行同源分发。完整目录、依赖层级与构建边界见 [项目树](docs/architecture-tree.md)。

## WASM 交付

修改 Rust 源码、lockfile 或构建输入后，在仓库根执行 `make wasm`，连同源码提交全部产物与清单。`make wasm-check` 只校验，不补构建；`scripts/build-wasm.sh core|render` 只重建一部分，之后运行 `scripts/check-wasm-dist.sh --update`。固定工具链见 `rust/rust-toolchain.toml` 与 `scripts/build-wasm.sh`。

Go/Web/Docker 构建不重新编译 WASM。CI 的 Go/Web job 消费已提交产物，另有独立 Rust job 执行原生渲染与调度测试；检查项目以 [.github/workflows/ci.yml](.github/workflows/ci.yml) 为准。

## 文档

| 要查什么 | 入口与适用范围 |
| --- | --- |
| 开发约束 | [AGENTS.md](AGENTS.md)、[架构约束](docs/architecture.md) |
| 目录与依赖 | [项目树](docs/architecture-tree.md)；构建命令以 Makefile 和 package.json 为准 |
| 决策与待办 | [决策登记](docs/decisions.md)；方案不等于实现或验收通过 |
| 精铺能力准入 | [技术验证清单](docs/precision-listing-verification.md)；区分本地构件、外部回读和未验证能力 |
| 前端验收 | 记录保存在本地 `design-qa.md`，不随源码提交；视觉或模拟 HTTP 通过不代表外部业务通过 |
| 领域方案 | [订阅账期](docs/architecture/subscription-billing.md)、[账号权限](docs/architecture/account-permission-model.md)、[存储](docs/architecture/storage-common.md) |
| 历史迁移与对拍 | [parity](docs/parity/)、[回归清单](docs/parity/regression-checklist.md)、[API 简化记录](docs/api-simplification-report.md)；按文中日期和范围解释历史结果 |
| 版本记录 | [CHANGELOG.md](CHANGELOG.md)；版本记录不代表当前 Go 能力或部署验收 |

## 许可证

podhub-go 是专有软件，版权持有人 xxww，SPDX 标识 `LicenseRef-Proprietary`。全文见 [LICENSE](LICENSE)，第三方说明见 [NOTICE](NOTICE)，Go 依赖的许可证清单见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)。

AI 计费公式、三种协议客户端和用量归一化都是本仓库原创实现，参考公开接口文档；不链接或不拷贝 RelayKit、new-api 或其他 AGPL 项目。
