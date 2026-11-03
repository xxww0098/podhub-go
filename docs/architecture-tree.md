# 项目树与依赖边界

项目是多租户、多电商平台 SaaS，采用 React + Rust/WASM + Go（chi）。顶层按业务职责组织，平台协议实现在具体适配器目录；账号、租户、计费、队列与媒体不按电商平台复制。目录存在只代表代码归属，能力是否可用以技术验证清单为准。

Go 保持标准的 `cmd/`、`internal/` 根目录布局，React 是 `web/` 下的独立工程。Rust 负责内核计算，Go 通过 wazero 消费预先构建的 WASM。服务端、前端和 Docker 构建消费已提交 WASM；CI 另有显式 Rust 原生测试，不重建 WASM。

## 项目树

```text
podhub-go/
├── go.mod / go.sum                   # Go 模块，chi + wazero
├── Makefile                          # 构建与检查入口；make wasm 重建全部 WASM
├── Dockerfile                        # 消费已提交 WASM，构建 Go 镜像
├── cmd/                              # 进程入口，只调用 internal/app
│   ├── api/main.go
│   ├── worker-listing/main.go
│   ├── worker-sync/main.go
│   ├── worker-reconcile/main.go
│   ├── worker-media-gc/main.go
│   ├── writer-lease/main.go
│   └── admin-init/main.go
├── internal/
│   ├── app/                          # 配置、依赖注入、路由和 worker 装配
│   ├── platform/                     # DB、存储、网络、WASM 等基础设施
│   │   ├── cloudflare/               # 固定主机的 OAuth 与 R2 管理 API 客户端
│   │   ├── mail/                     # TLS SMTP 传输与失败分类；邮件业务由调用域维护
│   │   └── wasm/                     # wazero、宿主导入、实例池和资源回收
│   ├── seller/                       # Seller 出口边界
│   │   ├── contract/                 # 消费方传输、店铺绑定、准入与错误契约
│   │   └── ozon/                     # Ozon 实现、凭据 probe 与官方/回环出口
│   │       ├── contract/             # Ozon 商品回读的纯 DTO 与严格解析
│   │       ├── domain/               # Ozon 地址、账户键与限流分类
│   │       └── repo/                 # Ozon 出口预算、准入与写账本
│   ├── queue/                        # 共享任务生命周期；由 app 显式装配
│   │   ├── contract/                 # Job、Lease、错误、重排原因与扫描契约
│   │   ├── domain/                   # 许可分类、退避与状态规则
│   │   ├── repo/                     # 领取、围栏、续租、重排与结算
│   │   ├── service/                  # 执行循环，ports.go 声明所需仓储操作
│   │   └── jobs/                     # River worker
│   ├── identity/                     # 账号、会话、恢复令牌与加密邮件发件箱
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
│   │   ├── factory/                  # 工厂端登录、工作空间、订单页面与 API 调用
│   │   ├── features/                 # 按业务域组织页面、交互、组件和状态
│   │   │   ├── platform/             # SaaS 管理配置，不是电商平台适配器
│   │   │   ├── workspace-storage/    # 工作空间专用切片桶引导、API 与对象管理
│   │   │   └── workflow/platforms/   # 上架平台协议；共享契约留在此层
│   │   │       ├── ozon/             # Ozon adapter、字段、修复与回读测试
│   │   │       └── wb/               # WB 本地预览适配与测试
│   │   ├── bindings/                 # HTTP、浏览器存储等现有应用适配
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
│       ├── listing-core-wasm/        # 服务端 / 浏览器导出和内存协议，含禁用标签 op 20
│       ├── op-workflow/              # 工作流纯类型与规则
│       ├── render/                   # 渲染算法
│       ├── render-wasm/              # 渲染导出、浏览器线程入口
│       └── psd-x/                    # PSD 读写，保留第三方许可证
├── wasm/                             # 产物交付边界，不放 Rust 源码
│   ├── embed.go                      # 仅嵌入 dist/server/ 的生产模块
│   ├── embed_test.go
│   └── dist/                         # 本地生成，随源代码提交
│       ├── SOURCES.sha256            # 输入、工具版本与产物指纹
│       ├── server/
│       │   └── listing-core.wasm
│       ├── browser/
│       │   ├── listing-state.wasm    # --features browser 的唯一 listing-core 浏览器模块
│       │   └── render/
│       │       └── threaded/         # WASM、JS、.d.ts、snippets 一起交付
├── api/
│   ├── openapi.yaml                 # HTTP 契约唯一源
│   └── codegen/                     # 各域代码生成配置
├── db/                              # migrations、queries、schema、agent-schema
├── fixtures/                        # 跨 Rust / Go / Web 共用的输入与 golden
├── tests/                           # archtest、integration、parity、testkit
├── scripts/                         # 本地 WASM 构建、产物清单校验及其测试
├── docs/                            # 设计、行为约束和对拍依据
├── third_party/                     # 已有第三方源码与许可证
└── .github/workflows/ci.yml          # 校验产物；Go/Web 检查与 Rust 原生测试
```

业务目录按需要建立，小域不必凑齐所有层。不增加 `backend/` 外壳、通用 `shared/` 工程或额外 workspace 管理工具。

## 多平台 SaaS 边界

| 边界 | 归属 | 约束 |
| --- | --- | --- |
| SaaS 公共能力 | `identity`、`billing`、`store`、`queue`、`media` 等业务域 | 组织、成员、套餐、店铺授权与任务生命周期统一维护，不为 Ozon/WB 各复制一套 |
| 电商平台协议 | `internal/seller/ozon`、前端 `workflow/platforms/ozon` 与 `wb` | API 路径、鉴权、字段与回执差异有明确平台归属；具体传输由 `internal/app` 装配 |
| 技术基础设施 | `internal/platform` | `platform` 表示基础设施；不放电商平台 SDK，也不代表管理后台 |
| SaaS 管理界面 | `features/platform`、`platform-observation` 等 | 页面仍按用户工作组织；界面角色和租户授权不等于电商平台选择 |
| 平台商品管理 | 前端 `features/supplier-dbs` | 商品按工厂归属汇总到单表；先配置工厂，再绑定新增商品，见[管理流程](architecture/platform-catalog-management.md) |
| 工厂工作空间 | 前端 `factory`，后端 `internal/supplier` | 工厂页面独立于用户及平台管理页面；共享基础组件和登录会话，订单按工厂工作空间隔离 |

`seller/contract` 是当前消费者使用的传输边界，仍包含现有 Seller 提交语义，不宣称已是适用于所有平台的统一商品 API。第二个平台需要真实授权、调用、回读与失败证据后，再按实际差异扩展所需 port；不提前建空目录、万能 SDK 或未验证的发送入口。

前端 Ozon/WB 适配器可以共享纯预览契约，但发送能力单独装配。当前 WB 目录只有本地预览，真实提交仍经 Ozon；注册表、模拟测试和 WASM 对拍都不能把 WB 提升为已打通的外部链路。

共享队列只负责领取、租约、重排和终态。执行函数由装配层提供；缺少执行函数时返回 `ErrWorkNotPorted` 并撤回重排，不拼 Ozon API 路径，也不把空处理器标为成功。Ozon 写闸由真实出口检查，错误通过 `seller/contract` 共享。

队列类型、错误、重排原因与扫描契约的唯一来源是 `queue/contract`，代价函数也由此提供；`queue/domain` 维护状态和退避规则。执行循环、上架提交与商品同步各自在 `ports.go` 声明所需操作，`internal/app` 将 `queue/repo` 的实现传入实例。缺失依赖明确报错，不再依靠 `init`、空白导入或基础设施包里的可变函数变量。测试同样显式装配，租约 owner/epoch 围栏与原事务边界保留。

### 对抗审查结论（2026-10-25）

- Ozon 实现曾平铺在 `seller`，前端 Ozon 文件也与共享平台契约混排：已收进各自的 `ozon/`，保留调用契约与现有测试，不保留旧路径转发。
- 基础设施中的 Ozon 永不发送骨架使共享队列带上平台知识：已移除，未注册执行器仍明确失败并重排；真实出口的凭据、限流、写闸与回执路径保留。
- Seller 扫描装配曾经由 `init` 回填全局 `Attach`：已改为 `internal/app/worker` 直接调用同包装配函数，去除适配器反向依赖装配层的隐式入口。
- 未按电商平台拆分整个 SaaS，也未搬迁生成物、数据库或 Rust workspace；这些调整没有对应职责收益。
- 队列能力曾藏在 `platform/jobsched`，由 `queue/jobsched_link.go` 和 `queue/wire.go` 在 `init` 回填：已迁回队列契约与仓储，并由装配层显式传入各实例；旧包、注册文件与空白导入均删除。队列不依赖其他业务域，登记为 L1，媒体等使用方可按层级依赖其纯契约。

## 迁移记录

Rust 源码已统一到 `rust/crates/`，服务端和浏览器产物分别在 `wasm/dist/server/`、`browser/`。根 `crates/`、`wasm/` 下独立 Rust 工程与 `web/` 内 WASM 副本已撤销；旧路径对照见 Git 历史，新增引用只用上面的现行路径。

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
5. CI 分为 `rust`、`lint`、`test`、`web` 四个 job。Go/Web job 校验清单、分层、生成代码、数据库 / 跨端 golden、前端构建 / API 契约 / 测试；`rust` job 以固定工具链运行 `cargo test --locked -p listing-core -p listing-core-wasm -p render -p psdx -p render-wasm`。CI 不重建 WASM，不以临时产物替换已提交文件。

`scripts/build-wasm.sh core|render`（`cd web && bun run wasm:build` 即后者）是本地局部构建入口，只重建服务端 + 浏览器 listing-core 或浏览器渲染产物，不刷新全局清单；之后必须运行 `scripts/check-wasm-dist.sh --update`，或直接 `make wasm` 完成整套交付。不要单独用 `--update` 将旧二进制标成新源码的产物。

哈希清单能发现输入或产物漂移，不能证明产物确由对应源码编译。本地重建运行相应 Rust 测试，CI 另跑渲染与调度原生测试，并用已提交模块运行消费端和 golden 测试；CI 不重建 WASM，不能单独证明源码与二进制等价。

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
| `repo/` | pgx + sqlc 实现 service 的 port；数据库会话经 `db.InTx` / `tenantx` | `domain`、`contract`、`gen` | 不绕过角色与租户会话 |
| `http/` | chi handler；`http/gen/` 为 oapi 生成物；对外只暴露 `Mount(r chi.Router, d Deps)` | `service`、`domain`、`contract`、`gen` | 不得 import `repo` |
| `jobs/` | 队列 kind 的 worker、due scan。有队列 kind 或 due scan 才建 | `service`、`domain`、`contract` | |

接口由使用方在 `service/ports.go` 声明。哨兵错误放 `contract/errors.go`。HTTP 状态映射只在 `http/`。

域间只通过对方的 `contract/`。对方层级必须严格低于自己。`internal/app` 可以 import 各域。`platform` 不得 import 业务或 `app`。

## 层级表

在 `tests/archtest/arch_test.go` 的 `level` 里登记。数字是 DAG 秩。一个单元只能 import 更低层级单元的 `contract`。未登记的单元会使 archtest 失败。

| 层级 | 单元 |
| --- | --- |
| L1 | identity, queue |
| L2 | media, catalog, billing, seller, telemetry |
| L3 | listing/core, seller/ozon, ai, supply, delegate, supplier, suppliercatalog, agent, ops, shipping, ozonerr, ratings, warehouse, store |
| L4 | listing/rules, automation |
| L5 | listing/read, listing/write, admin/core |
| L6 | listing/submit, listing（合并生成单元）, mcp, admin/<主题> |
| L7 | admin |

### admin 子单元与唯一的非 contract 例外

admin 按主题拆成 `admin/<主题>`（L6），共享部分在 `admin/core`（L5），剩余的 `admin`（L7）通过各主题的 `contract/` 调用它们。

`admin/core/contract` 放共享 DTO、错误和纯函数，`apifault` / `outcome` 保留各自错误协议；`admin/core/repo` 放依赖 pgx 的事务、授权、审计和密文工具。具体符号以源码为准，不在这里维护逐函数副本。

唯一的跨域非 contract 例外：**`admin` 或 `admin/<主题>` 的 `repo/` 可以 import `admin/core/repo`**，且仍要求目标层级更低。其他域与其他层不放行；`TestAdminCoreRepoExceptionIsNarrow` 和 `TestAdminCoreRepoExceptionMatchesTree` 校验边界。已拆主题包括 observe、delegate、billing、users、x1、catalog、shipping、supplier；装配在 `internal/app`。

新增域时：把单元名和层级写进 `level`，再跑 `go test ./tests/archtest`。不要为了让旧的平铺包通过而删掉规则。旧树里尚未迁走的违规在 `tests/archtest/baseline.txt`。棘轮：新违规失败；基线里已经被修好的条目也失败，必须删掉那一行。平台叶子包搬走时，只删除了随包消失的行。`internal/platform/**` 是基础设施，不进入这张层级表。

## 命名与生成物

- sqlc 查询放 `db/queries/<unit>/<主题>.sql`，查询名是「动词+名词」，生成包名 `sqlcgen`。
- oapi：`api/openapi.yaml` 里给每个 operation 打且只打一个 tag，tag 等于单元名。`api/codegen/<unit>.yaml` 按 tag 或显式 `include-operation-ids` 选取操作；具体约定见 [codegen README](../api/codegen/README.md)。
- 只在 `platform/config` 读环境变量，不新增 `os.Getenv`。
- 新业务表访问用 `platform/db.InTx` 与明确会话；跨租户 claim 使用 Worker 会话。旧 `tenantx.Begin*` 调用逐步迁移，不能另造角色/GUC 设置入口。

第三方模块只允许出现在一处（archtest 的 `onlyIn`）：

| 模块 | 唯一位置 |
| --- | --- |
| `github.com/aws/aws-sdk-go-v2` | `internal/platform/r2` |
| `github.com/tetratelabs/wazero` | `internal/platform/wasm` |
| `github.com/pressly/goose` | `internal/platform/db` |

## 进程运行时接线

`CLOUD_DNS_SERVER` 由配置层捕获，在 API/worker 启动客户端前设置进程解析器；空值沿系统 DNS。HTTP 客户端原有公网目标校验、TLS 与固定目标限制继续生效。Seller 路由只通过受控 SOCKS5h 适配器，回退限于请求发送前的建连阶段。

`internal/app/payment_runtime.go` 每次操作读取当前加密渠道配置，注入 billing 的订单存储和网关端口；HTTP 下单、验签回调与查询恢复共用订单和账本状态。`internal/app/catalog_runtime.go` 显式装配 `catalog.Fetcher`，由 HTTP 手动请求与 API 定时器共用，任务续租及写入以现有 epoch 围栏保护。域需要的操作放在各自 `service/ports.go`，不通过业务全局注册回填。

`catalog/contract.SameSnapshot` 比较不可变类目版本的语义内容，供类目入库、商品行创建和发送注册共用。比较忽略内核版本哈希明确排除的展示字段与顺序，保留约束、ID、版本和未知字段；同一版本的首次快照不被刷新覆盖。真实 WASM 对拍约束这份比较规则。

## 新域装配

按需要建立上面的域内层目录，并在 `internal/app` 装配 repo → service → HTTP。现有 supply 的实际入口是 `internal/app/wire_supply_delegate_supplier.go` 中的 `mountPR8A`，同时装配 supply、delegate、supplier 和 suppliercatalog；无需为每个域另建空壳 wiring 文件。使用 sqlc 的查询和 OpenAPI 生成配置分别放在 `db/queries` 与 `api/codegen`。

## 域检查清单

1. 在 `level` 表登记层级。
2. openapi operation 打 tag，加 `api/codegen/<域>.yaml`，在仓库根的 `sqlc.yaml` 加一块。
3. 只 import 更低层域的 `contract`。
4. 所有表访问经 `tenantx`，补 RLS 越权用例（两个 org，越权读写必败，GUC 缺失必败）。
5. 状态机补「命名边表驱动 + 非法边必败」。
6. 对拍向量或 golden 放 `tests/parity`。纯重构证明结果一致；产品行为变更同步契约、调用方与回归，不保留无必要的旧兼容。
7. 不新增 `os.Getenv`。
8. 表访问用 `platform/db.InTx` 加显式会话，不直接 `Begin`/`BeginTx`，不手写 `set_config`。

## 数据库薄封装

`internal/platform/db.InTx` 要求调用方传入会话；`Session{}` 返回空会话错误，`App(orgID)` 缺有效组织返回 `tenantx.ErrOrgUnset`，都不会开启事务。构造器为 `App`、`Worker`、`Staff`、`Observer`、`SupplierUser`、`Supplier`、`AutomationGrant`、`Catalog`、`AppRole`、`CatalogManager`，以 `internal/platform/db/tx.go` 为准。`Supplier(userID)` 不设组织，`SupplierUser(orgID, userID)` 同时设置组织和供应商用户；`AppRole()` 不设租户 GUC，不能代替租户访问授权。

回调内保留现有 SQL、锁和触发器；事务由 `InTx` 统一提交或回滚，回调不自行结束事务。尚未迁移的调用点按域逐个收敛，GUC 文本的违约清单在 `tests/archtest/baseline.txt`，只许删除。

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
