# podhub-go

PodHub Cloud 的服务端。行为约束在 [docs/architecture.md](docs/architecture.md)。

系统由三部分组成，三层都在本仓库：

| 部分 | 位置 | 职责 |
| --- | --- | --- |
| React 前端 | `web/` | 页面与交互；从 [api/openapi.yaml](api/openapi.yaml) 生成 API 客户端。浏览器直接调用本仓库的 HTTP API，也直接执行浏览器版 wasm |
| Go 服务端 | `cmd/`、`internal/` | HTTP API、四个 worker、写入租约；唯一有数据库和出站网络权限的部分 |
| Rust/WASM | `rust/`、`wasm/` | 纯函数内核与其 wasm 产物。Go 用 wazero 加载服务端产物，浏览器加载浏览器产物 |

同样的输入必须得到同样的输出、状态和数据。优化流程可以，改结果不行。无法用对比测试证明的差异要单独交给用户决定。

## 目录

### React 前端

| 路径 | 约定 |
| --- | --- |
| `web/` | Vite + React 19 + TanStack Query + Tailwind 4 的单页应用，24 个功能域 |
| `web/src/api/schema.d.ts` | 由 `api/openapi.yaml` 经 `bun run api:generate` 生成，不要手改 |
| `web/src/api/routes.ts` | 前端唯一的路径拼写处，`bun run api:routes` 从 schema 重新生成；`routes.test.ts` 禁止别处出现 `/api/…` 字面量 |
| `web/src/listing-core`、`web/src/render` | 浏览器侧 wasm 的 TypeScript 适配与 Worker；wasm 本体在 `wasm/dist/browser/` |
| `web/tests` | `bun test`，网络被 `network-guard.preload.ts` 拦断 |

前端 dev server 把 `/api` 与 `/mcp` 代理到 `127.0.0.1:8080`，即 Go 的默认监听地址；生产由前端自己同源分发。

### Rust / WASM 源与产物

| 路径 | 约定 |
| --- | --- |
| `rust/` | Rust 源码唯一根，单一 workspace（`Cargo.toml` / `Cargo.lock`，edition 2024）。`rust/rust-toolchain.toml` 把整个 workspace 钉在稳定工具链 1.99.0，`.cargo/config.toml` 为 wasm32 打开 simd128 |
| `rust/crates` | 8 个 crate：`listing-core` + `listing-core-wasm`（上架规则）、`render` + `render-wasm`（PSD 渲染）、`psd-x`（PSD 读写，MIT）、`listing-tags`（禁用标签匹配）、`op-workflow`（工作流纯类型）、`wasm-host-probe`（宿主契约探针） |
| `wasm/dist/server` | 提交入库的服务端产物：`listing-core.wasm`、`listing-tags.wasm` |
| `wasm/dist/browser` | 提交入库的浏览器产物：`listing-state.wasm`、`render/render_wasm.wasm` 与 `render/threaded/`（WASM + JS + `.d.ts` + snippets）。`listing-state.wasm` 是 `--features browser` 编出的唯一浏览器 listing-core 模块，前端与 Go 浏览器侧共用这一份 |
| `wasm/dist/test` | `host-probe.wasm`，只给测试用，不进 Go 二进制 |
| `wasm/dist/SOURCES.sha256` | 输入、工具版本与全部产物的指纹清单 |
| `wasm/embed.go` | 只嵌入 `dist/server/` 的两个生产模块；浏览器与 test 产物不进 Go 二进制 |
| `scripts/build-wasm.sh` | 用 workspace 工具链重编全部模块并可选拷入 `wasm/dist`。`scripts/check-wasm-dist.sh` 校验清单 |
| `web/scripts/build-render.sh` | 构建 PSD 渲染的两份产物（C ABI + `threads` 版 wasm-bindgen glue），落 `wasm/dist/browser/render/`。`threads` 版需要 nightly-2026-09-14 与 wasm-bindgen 0.2.127 |

浏览器 WASM、生成的 JS / `.d.ts` 与 Worker snippets 一起入库。`make wasm` 在本地构建全部服务端和浏览器产物后刷新清单；`make wasm-check` 只校验。`make web-wasm` 只重建浏览器渲染产物，不刷新全局清单；浏览器 listing-core 模块由 `scripts/build-wasm.sh core` 与服务端模块同一次构建产出，没有单独的浏览器构建入口。Go 构建、Web 构建、Docker 和 CI 都直接消费已构建的 WASM，不编译 Rust。

完整项目树、迁移记录和依赖边界见 [docs/architecture-tree.md](docs/architecture-tree.md)。仓库里只有一套路径：`rust/` 放全部 Rust 源码，`wasm/` 只放产物与 Go 嵌入。

核心约束：listing-core 是纯函数，无 SQL、无 HTTP、无时钟。Go 不把这些函数改写成业务代码，服务端保存和提交只认服务端校验。详见 [docs/architecture.md](docs/architecture.md) §上架规则。

### Go 服务端

| 路径 | 约定 |
| --- | --- |
| `cmd/api` | HTTP 进程。只调用 `internal/app` |
| `cmd/worker-listing` `cmd/worker-sync` `cmd/worker-reconcile` `cmd/worker-media-gc` | 四个 worker 进程，只调用 `internal/app`。媒体进程在删除关闭时以 0 退出；删除开启且没有 `127.0.0.1` 假桶和回执表时不以 0 退出 |
| `cmd/writer-lease` | `writer-lease bootstrap <domain>`，插入该域第一条未撤销的写入租约。`make build` 和镜像都会构建它 |
| `api/openapi.yaml` `api/codegen` | OpenAPI 与 oapi-codegen 配置（`api/codegen/*.yaml`，新增域加一份）。生成物在各域 `http/gen`，健康检查在 `internal/platform/health/gen`。响应字节手写 |
| `db/migrations` | goose。只追加，不改已有文件。见 [docs/parity/queue-and-migration-differences.md](docs/parity/queue-and-migration-differences.md) |
| `db/queries` `db/schema` `db/agent-schema` | sqlc 的查询和 schema。生成物在 `internal/platform/db/sqlc` 与 `internal/agent/gen/sqlcgen` |
| `internal/app` | 唯一装配层：路由、`wire_*.go`、`api/` 处理函数、`worker/` 进程。`cmd` 只 import 这里 |
| `internal/platform` | 基础设施，不 import 业务。环境变量只在 `platform/config` 解析。`platform/db` 管连接和 goose，`platform/db/tenantx` 设置 `podhub_app` / `podhub_worker` 与 `app.current_org_id`。`platform/r2` 是对象存储出口，删除和预签名只面向 `127.0.0.1` 假桶，真实 R2 主机被拒绝。`platform/egressgate` 是出站闸。`platform/llm` 做协议转换，不持有密钥，不访问供应商。`platform/wasm` 加载 wasm。`platform/writer` 判定写入租约。`platform/loadmode` 只接受 Mode R |
| `internal/listing/core` `rules` `read` `write` `submit` | 上架。窄 wasm 在 `wasm/dist/server`，由 `internal/platform/wasm` 加载。见 [docs/parity/listing-core-host.md](docs/parity/listing-core-host.md) |
| `internal/identity` 以及各业务单元 | `admin`、`agent`、`ai`、`automation`、`billing`、`catalog`、`delegate`、`mcp`、`media`、`ops`、`ozonerr`、`queue`、`ratings`、`seller`、`shipping`、`store`、`supplier`、`supply`、`telemetry`、`warehouse`。层目录用 `contract`、`domain`、`service`、`repo`、`http`、`jobs`、`gen`。层级表在 [docs/architecture-tree.md](docs/architecture-tree.md)。`internal/queue` 的领取循环写 `jobs` 行；River 只跑 worker |
| `tests/archtest` `tests/integration` `tests/parity` `tests/testkit` | 分层棘轮、集成测试、字节比较、集成测试辅助。没有 Docker 时集成测试跳过，除非 `PODHUB_PARITY_DSN` 指向 loopback。CI 会跑。`testkit` 含 Docker 套接字探测与 head 指纹比对 |
| `third_party/new-api` | 计费公式副本。许可证见该目录的 `LICENSE` 与 `NOTICE` |
| `scripts` | wasm 清单和纯搬家检查等仓库脚本 |

Go 语言版本在 `go.mod` 是 1.27.0，工具链是 go1.27.2（高于 RelayKit 要求的 1.25.1）。CI 的 setup-go 读 `go` 行；实际编译再用 `toolchain` 行的 go1.27.2。

## 三层之间的契约

Go 与前端只通过两样东西耦合：

- **HTTP API**：`api/openapi.yaml` 是唯一契约。Go 侧用 oapi-codegen 生成 router 与 models，前端用 openapi-typescript 生成 `schema.d.ts`。spec 描述本仓库实际的路由、状态码和响应形状（[decisions.md](docs/decisions.md) D14）。`internal/app/testdata/routes.txt` 的 396 条路由由 `TestRouteTableMatchesGolden` 钉死、由 `TestRoutePathsCoveredByOpenAPI` 强制落在 spec 内；前端 `routes.test.ts` 要求 `routes.ts` 与 spec 的路径集完全一致，`mounted.test.ts` 再把 `routes.ts` 与已挂载路由对齐（spec 里有、Go 未挂载的 54 条以只减不增的名单登记）。
- **浏览器 wasm**：`wasm/dist/browser/listing-state.wasm` 由前端直接实例化，Go 不参与。加载时机、op 表和数据形状见 [docs/parity/browser-direct.md](docs/parity/browser-direct.md) §前端契约。

Go 不提供页面、静态资源或服务端渲染；路由除 `/mcp` 外都在 `/api/*` 下。

## 本地

```sh
make test
make build
make generate
make ci
```

前端（在 `web/` 下，用 bun）：

```sh
bun install
bun run dev            # Vite，代理 /api 与 /mcp 到 127.0.0.1:8080
bun run api:generate   # 从 ../api/openapi.yaml 重新生成 schema.d.ts
bun run api:routes     # 从 schema 重建 routes.ts 的路径表
bun run check          # build → test → api:check → deadcode → lint
```

`make build` 校验 WASM 清单后写入 `bin/api`、四个 worker 和 `bin/writer-lease`。`make generate` 在缺少或版本不符时安装 sqlc v1.31.1 与 oapi-codegen v2.8.0（版本只写在 `Makefile`），再执行 `sqlc generate`，并遍历 `api/codegen/*.yaml` 逐份生成；新增域只需加一份配置。CI 的 lint job 也跑 `make generate`。`make ci` 对齐后端 CI：gofmt、vet、archtest、清单脚本回归、WASM 清单、`go test -timeout 25m ./...`、`make generate`、`git diff --exit-code`。前端 CI 另跑 Web 构建、API 契约和测试。CI 不安装 Rust 工具链，也不重新构建 WASM；改动 Rust 后先在本地 `make wasm`，再一起提交源码、产物与清单。

`DATABASE_URL` 只能是回环地址。两个开关的解析说明在 `.env.example`。表结构的对拍物是 `tests/integration/testdata/expected-head-fingerprint.json`，迁移顺序见 `db/migrations` 与 [docs/parity/queue-and-migration-differences.md](docs/parity/queue-and-migration-differences.md)。

## 许可证

podhub-go 以 GNU AGPL-3.0（仅第 3 版，SPDX `AGPL-3.0-only`）授权，版权持有人 xxww。全文见 [LICENSE](LICENSE)，版权与第三方说明见 [NOTICE](NOTICE)，Go 依赖的许可证清单见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)。

`internal/platform/llm` 引用的 RelayKit 与 `third_party/new-api` 公式副本都来自 QuantumNous/new-api，按 AGPL-3.0 使用，未购买商业授权。

AGPL-3.0 第 13 条：如果你修改了本程序，并通过计算机网络向用户提供修改版的服务，须让这些用户能够获取该版本的对应源码（Corresponding Source）。分发二进制或镜像时，按第 6 条提供源码。

源码获取方式：[待定——源码获取地址由版权持有人确定后填写]

## 文档

- 行为约束：[docs/architecture.md](docs/architecture.md)
- 目录与依赖规则：[docs/architecture-tree.md](docs/architecture-tree.md)
- 未决与已决事项：[docs/decisions.md](docs/decisions.md)
- 订阅与账期方案：[docs/architecture/subscription-billing.md](docs/architecture/subscription-billing.md)
- 各域对拍：[docs/parity](docs/parity/)，回归清单在 [docs/parity/regression-checklist.md](docs/parity/regression-checklist.md)
