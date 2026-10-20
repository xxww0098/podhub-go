# 项目树与依赖边界

项目采用 React + Rust/WASM + Go（chi）。下面先给出项目树，再记录 Rust/WASM 源码与产物的布局迁移。迁移已完成，仓库里只有一套路径，没有旧路径、占位目录或兼容层。

Go 保持标准的 `cmd/`、`internal/` 根目录布局，React 是 `web/` 下的独立工程。Rust 负责内核计算，Go 通过 wazero 消费预先构建的 WASM。服务端构建、前端构建、Docker 构建和 CI 均不隐式编译 Rust。

## 项目树

```text
podhub-go/
├── go.mod / go.sum                   # Go 模块，chi + wazero
├── Makefile                          # 本地构建入口；make wasm 才编译 Rust
├── Dockerfile                        # 消费已提交 WASM，构建 Go 镜像
├── cmd/                              # 进程入口，只调用 internal/app
│   ├── api/main.go
│   ├── worker-listing/main.go
│   ├── worker-sync/main.go
│   ├── worker-reconcile/main.go
│   ├── worker-media-gc/main.go
│   └── writer-lease/main.go
├── internal/
│   ├── app/                          # 配置、依赖注入、路由和 worker 装配
│   ├── platform/                     # DB、存储、网络、WASM 等基础设施
│   │   └── wasm/                     # wazero、宿主导入、实例池和资源回收
│   └── <业务域>/                     # listing、media、billing 等
│       ├── contract/                 # 跨域契约、DTO、错误
│       ├── domain/                   # Go 自有领域规则，不复制 Rust 内核
│       ├── service/                  # 用例编排；ports.go 声明使用方接口
│       ├── repo/                     # 数据库实现
│       ├── http/                     # chi handler；gen/ 为生成物
│       └── jobs/                     # 有后台任务时才建立
├── web/
│   ├── package.json / bun.lock
│   ├── public/
│   ├── src/
│   │   ├── app/                      # 应用入口、路由和 Provider
│   │   ├── api/                      # OpenAPI 生成类型、路径和请求封装
│   │   ├── features/<业务域>/        # 页面、用例交互、域内组件和状态
│   │   ├── components/               # 已有共享 UI
│   │   ├── listing-core/             # 上架 WASM 的类型与 TypeScript 适配
│   │   └── render/                   # 渲染 WASM 适配与 Worker
│   └── tests/                        # 前端、WASM 与契约测试
├── rust/                             # Rust 源码唯一根，单一 workspace
│   ├── Cargo.toml / Cargo.lock
│   ├── rust-toolchain.toml           # 固定稳定工具链；线程构建单独指定 nightly
│   ├── .cargo/config.toml
│   └── crates/
│       ├── listing-core/             # 纯上架规则
│       ├── listing-core-wasm/        # 服务端 / 浏览器导出和内存协议
│       ├── listing-tags/             # 禁用标签匹配 WASM
│       ├── op-workflow/              # 工作流纯类型与规则
│       ├── render/                   # 渲染算法
│       ├── render-wasm/              # 渲染导出、浏览器线程入口
│       ├── psd-x/                    # PSD 读写，保留第三方许可证
│       └── wasm-host-probe/          # 宿主契约测试探针
├── wasm/                             # 产物交付边界，不放 Rust 源码
│   ├── embed.go                      # 仅嵌入 dist/server/ 的生产模块
│   ├── embed_test.go
│   └── dist/                         # 本地生成，随源代码提交
│       ├── SOURCES.sha256            # 输入、工具版本与产物指纹
│       ├── server/
│       │   ├── listing-core.wasm
│       │   └── listing-tags.wasm
│       ├── browser/
│       │   ├── listing-state.wasm    # --features browser 的唯一 listing-core 浏览器模块
│       │   └── render/
│       │       ├── render_wasm.wasm  # 单线程测试 / golden
│       │       └── threaded/        # WASM、JS、.d.ts、snippets 一起交付
│       └── test/host-probe.wasm
├── api/
│   ├── openapi.yaml                 # HTTP 契约唯一源
│   └── codegen/                     # 各域代码生成配置
├── db/                              # migrations、queries、schema、agent-schema
├── fixtures/                        # 跨 Rust / Go / Web 共用的输入与 golden
├── tests/                           # archtest、integration、parity、testkit
├── scripts/                         # 本地 WASM 构建、产物清单校验及其测试
├── docs/                            # 设计、行为约束和对拍依据
├── third_party/                     # 已有第三方源码与许可证
└── .github/workflows/ci.yml          # 校验产物，构建 / 测试 Go 和 Web
```

业务目录按需要建立，小域不必凑齐所有层。不增加 `backend/` 外壳、通用 `shared/` 工程或额外 workspace 管理工具。

## 迁移记录

Rust/WASM 的源码与产物已按上面的布局迁完，仓库里只有这一套路径。迁移做的事：

| 变化 | 现在的位置 |
| --- | --- |
| Rust 源码合并为一个 workspace | `rust/`：`Cargo.toml` / `Cargo.lock` / `rust-toolchain.toml` / `.cargo/config.toml`，全部 crate 在 `rust/crates/` |
| 窄 wasm 与宿主探针从独立工程并入 | `rust/crates/listing-tags`、`rust/crates/wasm-host-probe`，与其余 crate 共用同一个工具链 |
| 根目录的 `crates` 目录已删除 | 测试与文档一律写 `rust/crates/` 的明确路径 |
| 服务端产物归组 | `wasm/dist/server/`：`listing-core.wasm`、`listing-tags.wasm` |
| 测试探针移出生产嵌入集合 | `wasm/dist/test/host-probe.wasm` |
| 浏览器产物归组，`web/` 不再保存副本 | `wasm/dist/browser/`：`listing-state.wasm`、`render/render_wasm.wasm` 与 `render/threaded/` |
| 工具链统一 | 一个稳定版本写在 `rust/rust-toolchain.toml`，覆盖全部 crate；只有 `threads` 版渲染产物用 nightly-2026-09-14 |

迁移一次性更新了 Cargo 路径依赖、构建脚本、清单脚本、Go embed、Web import / Worker URL、fixture 路径、测试和文档。浏览器直接 import `wasm/dist/browser/` 下的产物。旧布局（一棵嵌套的 Rust 树、`wasm/` 下的独立 Rust 工程、`web/` 里的 wasm 副本）已经不存在，逐条对照见 git 历史。

## 三层调用约定

```text
React ──HTTP / OpenAPI──> Go（chi）──> service ──> repo / 外部 I/O
  │                                      │
  └──浏览器适配器──> browser WASM          └──Go 适配器──> wazero ──> server WASM
                          ↑                                       ↑
                          └────────────同一套 Rust 内核────────────┘
```

- Rust 只计算输入与输出；数据库、对象存储、HTTP、授权、事务和重试由 Go 编排，浏览器自己的持久化和界面状态由 TypeScript 管理。
- Go 的 Rust 集成只走 WASM：不调用 Cargo、不链接 Rust 动态库、不用 cgo，也不启动 Rust 子进程。`CompileModule` 是 wazero 对已有 WASM 的运行时编译，不是 Rust 源码构建。
- wazero 依赖只出现在 `internal/platform/wasm`；具体域的适配器拥有操作码、DTO、错误转换，通用运行时不认识上架业务。
- 服务端与浏览器共享 Rust 内核，分别构建满足各自 ABI / feature 的产物，不要求二进制文件相同。带 wasm-bindgen JS 导入和线程的浏览器模块只交给浏览器加载。
- 手写 C ABI 保持现有导出、内存分配 / 释放、JSON / 字节协议；wasm-bindgen 输出的 JS、类型声明、WASM 和 Worker snippets 必须来自同次构建。跨语言输入验证与 WASM 调用失败处理由现有边界负责。
- 浏览器计算用于预览和交互，服务端仍校验并作最终决定。契约变化同时更新 Rust 导出、Go / TypeScript 适配器和跨端 golden。

运行时选择沿用 [wazero 的 Go 嵌入方式](https://wazero.io/)，浏览器 glue 的交付遵循 [wasm-bindgen 的部署约定](https://wasm-bindgen.github.io/wasm-bindgen/reference/deployment.html)。

## 本地 WASM 交付与 CI

本地构建与 CI 的流程如下：

1. 修改 Rust 源码、Cargo.lock、编译配置或构建脚本后，在本地执行 `make wasm`。它运行服务端构建中的 Rust 测试，生成全部服务端 / 浏览器模块与 JS glue，全部成功后才刷新 `wasm/dist/SOURCES.sha256`。
2. 将源码、`.wasm`、生成的 JS / `.d.ts` / snippets 与清单一起提交。`target/`、`node_modules/`、Web `dist/` 和 Go `bin/` 不入库。
3. `make wasm-check` 只校验工具版本标记、源码 / lockfile / 配置 / 构建脚本指纹和产物哈希；它不执行 Rust。源码陈旧、产物缺失、glue 改动都失败，不自动补构建。
4. `make build` 校验清单后只构建 Go；`cd web && bun run build` 校验清单后只运行 TypeScript / Vite。`make generate` 只生成 sqlc 和 OpenAPI 代码。Docker 只构建 Go 并嵌入已提交产物。
5. CI 的 `lint`、`test`、`web` 三个 job 并行。CI 校验清单、Go 分层 / 生成代码、Go / 数据库 / 跨端 golden、前端类型 / 打包 / API 契约 / 测试；不安装 Rust / nightly / wasm-bindgen，不缓存 Cargo，不上传或下载临时 WASM。

`make listing-wasm`、`make web-wasm`、`cd web && bun run wasm:build` 是本地局部构建入口（分别只重建服务端标签模块、浏览器渲染产物），不自动刷新全局清单；浏览器 listing-core 模块只随 `scripts/build-wasm.sh core` 与服务端模块一起产出。共享 Rust workspace 改动后，以 `make wasm` 完成整套交付。不要单独用 `--update` 将旧二进制标成新源码的产物。

哈希清单能发现输入或产物漂移，不能证明产物确由对应源码编译。Rust 原生测试在本地构建时执行，CI 用已提交模块运行消费端与 golden 测试；这是取消云端 Rust 构建后的验证边界。

## 仓库边界

本文约束三层的目录、调用和交付边界；以下 Go 分层规则由 `tests/archtest` 执行。

| 层 | 当前源码位置 | 执行约束 |
| --- | --- | --- |
| React 前端 | `web/` | 本文的交付边界与 `web/README.md`；消费 OpenAPI 和浏览器 WASM |
| Go 服务端 | `cmd/`、`internal/`、`db/`、`api/` | 以下域内分层与层级表 |
| Rust/WASM | `rust/`（crate 都在 `rust/crates/`）、`wasm/dist/` | 本地固定工具链构建；CI 校验 `wasm/dist/SOURCES.sha256` 并测试产物 |

`rust/`、`wasm/`、`web/` 不进 Go 业务域的 `level` 表。Go 侧只通过 `internal/platform/wasm` 加载 Rust 产物。前端测试按 `rust/crates/...` 的明确路径读取 fixture，仓库根没有 `crates` 目录。平台叶子包在 `internal/platform/**`，唯一装配层是 `internal/app`；`internal/identity` 尚未分层的文件继续留在原处。

## 三类根

- `internal/platform/**`：基础设施，不含业务。
- `internal/<域>/**`：业务。
- `internal/app/**`：唯一装配层，可 import 一切。`cmd/` 只调用 `internal/app`。

## 域内分层

小域可以只有 `domain/` 与 `service/`。层目录只用这些固定词：`contract`、`domain`、`service`、`repo`、`http`、`jobs`、`gen`、`sqlcgen`。不得自造 `util`、`common`、`helpers`、`models`。包名等于目录名；`http` 层包名用 `<域>http`，`repo` 用 `<域>repo`。一个文件一个主题。测试放同目录。表驱动对拍向量放同目录 `testdata/`。

| 层 | 内容 | 可以 import | 禁止 |
| --- | --- | --- | --- |
| `contract/` | 对外接口、DTO、哨兵错误，无副作用 | 标准库里没有副作用的部分 | pgx、chi、aws、river；同域其它层 |
| `domain/` | 纯类型、状态机、规则、纯函数（无 I/O、无时钟） | `domain`、`contract` | pgx、chi、aws、river、otel、`net/http` |
| `service/` | 用例编排；在 `ports.go` 声明自己需要的 repo 与外部接口 | `domain`、`contract` | chi、`net/http` |
| `repo/` | pgx + sqlc 实现 service 的 port；`repo/sqlcgen/` 为生成物 | `domain`、`contract`、`gen` | 全部走 `tenantx` |
| `http/` | chi handler；`http/gen/` 为 oapi 生成物；对外只暴露 `Mount(r chi.Router, d Deps)` | `service`、`domain`、`contract`、`gen` | 不得 import `repo` |
| `jobs/` | 队列 kind 的 worker、due scan。有队列 kind 或 due scan 才建 | `service`、`domain`、`contract` | |

接口由使用方在 `service/ports.go` 声明。哨兵错误放 `contract/errors.go`。HTTP 状态映射只在 `http/`。

域间只通过对方的 `contract/`。对方层级必须严格低于自己。`internal/app` 可以 import 各域。`platform` 不得 import 业务或 `app`。

## 层级表

在 `tests/archtest/arch_test.go` 的 `level` 里登记。数字是 DAG 秩。一个单元只能 import 更低层级单元的 `contract`。未登记的单元会使 archtest 失败。

| 层级 | 单元 |
| --- | --- |
| L1 | identity |
| L2 | queue, media, catalog, billing, seller, telemetry |
| L3 | listing/core, ai, supply, delegate, supplier, agent, ops, shipping, ozonerr, ratings, warehouse, store |
| L4 | listing/rules, automation |
| L5 | listing/read, listing/write, admin/core |
| L6 | listing/submit, mcp, admin/<主题> |
| L7 | admin |

### admin 子单元与唯一的非 contract 例外

admin 按主题拆成 `admin/<主题>`（L6），共享部分在 `admin/core`（L5），剩余的 `admin`（L7）通过各主题的 `contract/` 调用它们。

`admin/core/contract` 放 admin 各单元共用的类型与纯函数：`Fault` 及构造函数、`APIError` / `Fail` / `NotPorted`、`Actor`、`NormalizeUUID`、`CanonicalUUID`、`Itoa64`、`Marshal`、`NewPublicID`，以及集成配置快照 `Snapshot` / `StoredAI` / `StoredMedia` / `ParseStored`。`admin/core/contract/apifault` 放 admin service 与 `Store` 用的线上错误体 `Fault`（Status/Code/Message/RetryAfter）及构造函数，名字与上面的 `Fault` 冲突所以单独成包；`admin/contract` 用别名与一行包装指向它。`admin/domain` 用类型别名或一行包装指向它们，所以各单元返回和 `errors.As` 匹配的是同一个类型。

`admin/core/contract/outcome` 放货源后台的 `Fail`（Kind/Message/Status）和边缘 `Actor`。`admin/contract` 用别名和一行包装指向它。`admin/core/contract` 还放货源行的 `SupplierDb` / `Prop`、提示词列表行 `Prompt`，以及严格 JSON 对象解码和 `JSONText`。

`admin/core/repo` 放 repo 层共用的 pgx 工具：`AuditBill` / `Lease`、`Admit`、`MapBill`、`MapAdmin`、`BeginAdmin` / `BeginStaff`、`Data`、`EndLease`、`MsgUnavailable`、`OrgAtLeast0`、`RFC3339Millis`；`Store` 的写闸与审计 `WithGate` / `AssertAuthority` / `AuditRow` / `InsertAudit` / `WriteAudit` / `AuditAfter`，以及 `DBFault` / `PlainFault` / `OrgFloor` / `JSONText`；管理域写闸 `AssertWriteLease`（目录、物流、代理共用，禁用时返回 `WRITES_DISABLED`）；货源事务 `Gate` / `WithRead` / `WithWrite` / `WithTx` / `Identity` / `AssertWrite` / `AuditApplied` / `Audit` / `MapDB` / `ListDbs` / `RequireSource` / `LockSource` / `LockProduct`，以及集成配置的 `AESKey` / `Seal` / `Open`。它们的签名带 `pgx.Tx` / `pgconn.PgError`，`contract/` 不能 import pgx，所以不能放进 contract。`admin/repo.InsertAudit` 把 `domain.Audit` 交给已有的 `InsertAudit(AuditRow)`，SQL 与参数不变。

例外只有一条：**`admin` 或 `admin/<主题>` 的 `repo/` 层可以 import `admin/core/repo`**。层级检查照常（`admin/core` 必须低于来源单元）。其他层（domain、service、http、jobs、根包）、其他单元、`admin/core` 的其他层目录都不放行。规则在 `tests/archtest/arch_test.go` 的 `crossUnit` / `adminCoreRepo`，`TestAdminCoreRepoExceptionIsNarrow` 用表钉住放行与拒绝的组合，`TestAdminCoreRepoExceptionMatchesTree` 检查真实代码树里每一处 import 都来自允许的 repo 包。

已搬出的主题：

| 主题 | contract | domain | repo |
|---|---|---|---|
| `admin/observe` | `Scope`、`ProductQuery`、`Thumbnail`、`ImageBytes`（原 `admin/contract/observe.go`） | `observe_rules.go`、`image_url.go`（原 `admin/domain`） | `Observe`、`Fetch`、`LoopbackFetch`（原 `admin/repo/{observe*,fetch}.go`） |
| `admin/delegate` | `OrderQuery`、`OrderRow`、`OrderListResponse`、`OrderDetailResponse` 等视图（原 `admin/contract/delegate.go`） | `delegate_view.go`：投影与分页（原 `admin/domain`） | `DelegateRepo`（原 `admin/repo/delegateadmin.go`） |
| `admin/billing` | `RedeemSpec`、`TopupGrant`（原 `admin/contract/billing.go`） | `order_machine.go`、`credit_lines.go`、`redeem_view.go`、`peak_seats.go`（原 `admin/domain`） | `Entitlement`：套餐/订单/确认入账/兑换码/钱包（原 `admin/repo/{plans_orders,confirm_credit,redeem,wallet,entitlement}.go`） |
| `admin/users` | `Account`、`Person`、`Workspace`、`Directory`、`SeatLoad`、席位计算、`Rank` 与 `Authorize`（原 `admin/contract/{users_views,seats,rank}.go`） | `users_rules.go`：`WorkspaceName`、`OwnedLimit`（原 `admin/domain`） | `Users`：账号与席位（原 `admin/repo/{users,seats,users_store}.go`；`dissolve.go` 受 baseline 路径约束留在 admin） |
| `admin/x1` | 行、Ozon 配置、提示词与上架校验（原 `admin/domain/{supplier_input,supplier_ozon,supplier_prompt,supplier_row}.go` 与提示词规则） |  | `X1`：厂家行、价格、上下架、Ozon 配置、提示词（原 `admin/repo/x1*.go`） |
| `admin/catalog` | `Product`、`SKU`、`ProductInput`、`SKUInput`、`ImageTarget`，以及 `FillProduct` / `FillSKU` / `ProductAudit` / `SKUAudit`（原 `admin/domain/catalog.go` 的行类型） |  | `CatalogRepo`：平台商品与 SKU（原 `admin/repo/catalog.go`）。校验仍留在 `admin/domain`，供 service 使用 |
| `admin/shipping` | 预设、绑定、注入诊断与校验（原 `admin/domain/shipping.go` 的物流规则） |  | `ShippingRepo`：预设与 SKU 绑定（原 `admin/repo/shipping.go`）。`BeginAdmin` 等事务包装留在 admin |
| `admin/supplier` | 厂家库、成员、提现的输入与视图（原 `admin/domain` 的对应类型） |  | `Portal`：厂家库、成员、提示词列表、提现、存储账号（原 `admin/repo/{dbs,accounts,prompts,cash,supplier_account}.go`）。授权仍留在 admin |

`admin/domain` 用类型别名保留 observe、delegate、billing、users、x1、catalog、shipping、supplier 契约类型的旧名（delegate 的 `ParseOrderQuery` 等校验留在 `admin/domain`，供 service 使用；catalog 的解析同样留在 `admin/domain`）；app 用 `{*adminrepo.Repo, *billingrepo.Entitlement, *observerepo.Observe}` 组合体满足 `BillingAPI`，用 `{*adminrepo.Store, *usersrepo.Users}` 组合体作为 service 的 `DB`，用 `{adminrepo.Repo, supplierrepo.Portal, x1repo.X1}` 组合体作为 supplier service 的 `Store`，用 `catalogrepo.CatalogRepo` 作为目录 port，用 `adminshippingrepo.ShippingRepo` 作为物流 port。

新增域时：把单元名和层级写进 `level`，再跑 `go test ./tests/archtest`。不要为了让旧的平铺包通过而删掉规则。旧树里尚未迁走的违规在 `tests/archtest/baseline.txt`。棘轮：新违规失败；基线里已经被修好的条目也失败，必须删掉那一行。平台叶子包搬走时，只删除了随包消失的行。`internal/platform/**` 是基础设施，不进入这张层级表。

## 命名与生成物

- sqlc 查询放 `db/queries/<unit>/<主题>.sql`，查询名是「动词+名词」，生成包名 `sqlcgen`。
- oapi：`api/openapi.yaml` 里给每个 operation 打且只打一个 tag，tag 等于单元名。`api/codegen/<unit>.yaml` 用 `include-tags`。
- 只在 `platform/config` 读环境变量，不新增 `os.Getenv`。
- 业务表访问一律 `tenantx.BeginApp`。跨租户 claim 才用 `BeginWorker`。

第三方模块只允许出现在一处（archtest 的 `onlyIn`）：

| 模块 | 唯一位置 |
| --- | --- |
| `github.com/QuantumNous/new-api/relaykit` | `internal/platform/llm` |
| `github.com/aws/aws-sdk-go-v2` | `internal/platform/r2` |
| `github.com/tetratelabs/wazero` | `internal/platform/wasm` |
| `github.com/pressly/goose` | `internal/platform/db` |

## 新域模板

以 supply 为例：

```
internal/supply/{contract,domain,service(ports.go + 用例),repo(repo.go + sqlcgen),http(handler.go Mount + gen),jobs}
db/queries/supply/*.sql
api/codegen/supply.yaml
internal/app/wire_supply.go
```

`wire_supply.go` 做 `new(repo)` → `new(service)` → `http.Mount`。现有 `app.go` 只加最少几行调用。

## 域检查清单

1. 在 `level` 表登记层级。
2. openapi operation 打 tag，加 `api/codegen/<域>.yaml`，在仓库根的 `sqlc.yaml` 加一块。
3. 只 import 更低层域的 `contract`。
4. 所有表访问经 `tenantx`，补 RLS 越权用例（两个 org，越权读写必败，GUC 缺失必败）。
5. 状态机补「命名边表驱动 + 非法边必败」。
6. 对拍向量或 golden 放 `tests/parity`。PR 里写「改了哪个流程、结果为什么不变」。
7. 不新增 `os.Getenv`。
8. 表访问用 `platform/db.InTx` 加显式会话，不直接 `Begin`/`BeginTx`，不手写 `set_config`。

## 数据库薄封装

薄封装已在 `internal/platform/db`：`InTx` 默认走带租户 GUC 的 `App` 会话，缺 `org_id` 返回 `tenantx.ErrOrgUnset`；`Worker`/`Staff`/`Observer`/`WalletUser`/`SupplierUser`/`Grant`/`Catalog` 显式声明其他会话。复杂查询、触发器相关、锁相关仍走 sqlc。尚未迁到 `InTx` 的调用点按域逐个迁移，GUC 文本的违约清单在 `tests/archtest/baseline.txt`，只许删除。

## 单点解析

下面这些文本只能有一个解析点。archtest 的 `TestSingleParsePoints` 扫描 `internal/**/*.go`（不含 `_test.go`）。开关名用完整的双引号字面量，注释和报错文案里提到名字不算。`app.current_org_id` 还匹配反引号字符串，以及任意 Go 字符串里的 SQL 形式 `'app.current_org_id'`。`os.Getenv` 与 `os.LookupEnv` 只允许出现在 `internal/platform/config`，按选择子匹配，注释和字符串里的这几个字不算。`pgxpool.New` 仍是调用文本。允许目录是迁移完成后的位置：

| 文本 | 允许目录 |
| --- | --- |
| `OZON_WRITE_KILL_SWITCH` | `internal/platform/config` |
| `CLOUD_MEDIA_GC_DELETE` | `internal/platform/config` |
| `app.current_org_id` | `internal/platform/db/tenantx` |
| `pgxpool.New(` / `pgxpool.NewWithConfig(` | `internal/platform/db` |
| `os.Getenv` / `os.LookupEnv` | `internal/platform/config` |

`os.Getenv` / `os.LookupEnv` 在业务代码里已清零。仍留在业务代码里的 GUC 旧调用记在 `tests/archtest/baseline.txt` 的 `# single-parse-points` 段，只许删除。不要把允许目录改宽，也不要在业务域里再解析这两个开关。业务代码只接收已经解析好的布尔值。
