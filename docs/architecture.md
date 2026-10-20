# 架构约束

本文件是本仓库必须遵守的设计约束。目录约定见 [README](../README.md)。

## 系统边界

系统由 React 前端、Go 服务端、Rust/WASM 内核三部分组成，三层都在本仓库。

| 部分 | 在哪 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| React 前端 | `web/` | 渲染页面；直接调用 HTTP API；直接实例化浏览器版 wasm | 不连数据库，不持有服务端密钥，不决定服务端结果 |
| Go 服务端 | `cmd/`、`internal/` | 提供 HTTP API、跑 worker、判定写入租约、连数据库和出站 | 不把 Rust 内核的逻辑改写成 Go 业务代码，不编译 Go wasm |
| Rust/WASM | `rust/`、`wasm/` | 纯函数：规则、冻结、状态转移 | 无 SQL、无 HTTP、无时钟，不碰密钥 |

前端与 Go 只通过 `api/openapi.yaml` 和 `wasm/dist/browser/listing-state.wasm` 耦合。`api/openapi.yaml` 是唯一契约：Go 侧用 oapi-codegen 生成 router 与 models，`web/` 用 openapi-typescript 生成 `schema.d.ts`，再由 `bun run api:routes` 生成路径表。两侧的路径集由 Go 的 `TestRoutePathsCoveredByOpenAPI` 与前端的 `routes.test.ts` 共同钉住。

Go 不提供页面、静态资源或服务端渲染；路由除 `/mcp` 外都在 `/api/*` 下。前端开发时 Vite 把 `/api` 与 `/mcp` 代理到 `127.0.0.1:8080`。

## 结果一致性

功能流程可以优化，但结果不能变：同样的输入必须得到同样的输出、状态和数据。

每个优化点都必须有结果一致性测试，并在 PR 中说明：改了哪个流程、结果为什么不变（附测试证据）。无法证明一致的差异必须单独列出，交给用户决定。

识图计费和 Ozon 写入尚未实现；对应入口返回明确错误，不把“尚未实现”当成通过。禁用标签校验、规则下发、身份会话和一批只读 GET 已经接上。存储按 [storage-common.md](architecture/storage-common.md) 的三个桶划分。媒体库上传与 finalize 接口已随 API 简化删除；长期对象注册表仍保留在存储层。`POST /api/media/objects/{digest}/{extension}/presign` 只服务中转桶的批次切片，键里的工作区是该 `org_id` 的 `organizations.uuid`；checksum 开关已移除，签发的 PUT 一律覆盖 checksum。中转桶清理见下。其余 `/api/media/*`（分片、图库、探测）还没有挂上：它们要写租约和媒体行，这一层还没有对拍过的处理器。

## 上架规则

`rust/crates/listing-core` 是纯函数（无 SQL、无 HTTP、无时钟），同一份内核分别构建为服务端和浏览器 WASM（`rust/crates/listing-core-wasm`）。Go 只通过 wazero 调用已有 WASM，不链接或启动 Rust 原生程序，也不把这些函数改写成业务代码。服务端保存和提交只认服务端校验；浏览器提示不作数。

wazero 可以加载这种 C ABI（本仓库的探针提供了 `env.fill_random`）。浏览器那份 wasm 的 op 表没有禁用标签函数，所以不能靠加载它来做词干匹配。当前服务端匹配器是同一份源码另编的窄 wasm，不是浏览器产物。是否改回「上游加导出后的那一份浏览器 wasm」还没有决定，说明在 [listing-core-host.md](parity/listing-core-host.md)。

全局禁用标签表 `public.banned_tags` 由超级管理员在数据库中维护，修改立即生效，写入要审计。启用中的规则有两条读路径：`GET /api/listing/rules` 带 `rulesVersion`，每次读库，供版本握手；`GET /api/me/catalog/banned-tags` 与 `GET /api/admin/banned-tags` 走已登录的只读 GET，启用列表保留一秒钟进程缓存。写和校验接口版本不一致则拒绝。管理写入不在本分支。登录和会话已经接上。匹配由上面的窄 wasm 执行。`POST /api/listing/submit` 在冻结前多了一道禁用标签拒绝（命中返回 400），这是有意的行为选择，用户已决定保留。

PL/pgSQL 里的不变量（许可、队首、`notify_ozon_jobs_wake`、`guard_submission_offer`、`seal_listing_row_events`、`media_reference_guard`、账本 `*_no_rewrite`、`delegate_supplier_*`）必须原样保留。函数体不在本仓库里重写。

## 不编译 Go WASM

PSD 渲染和上架规则的浏览器提示继续用现有 Rust WASM（`rust/crates/listing-core-wasm`、`rust/crates/render-wasm`、`rust/crates/psd-x`）。本仓库不增加 `GOOS=js` / `GOARCH=wasm` 目标。

仓库内的 Rust 源码只有一处：`rust/` 下的单一 workspace，同一份内核构建服务端与浏览器产物。

| 源码 | 工具链 | 产物 | 谁加载 |
| --- | --- | --- | --- |
| `rust/crates/listing-core-wasm` | Rust 1.99.0 | `wasm/dist/server/listing-core.wasm`（服务端） | Go，经 `internal/platform/wasm` 的 wazero |
| 同上，`--features browser` | Rust 1.99.0 | `wasm/dist/browser/listing-state.wasm`（浏览器） | React 前端，Go 不嵌入 |
| `rust/crates/render-wasm` | Rust 1.99.0；`threads` 版用 nightly-2026-09-14 | `wasm/dist/browser/render/render_wasm.wasm` 与 `threaded/` | React 前端，Go 不嵌入 |
| `rust/crates/listing-tags`、`rust/crates/wasm-host-probe` | Rust 1.99.0，与上面同一个 workspace | `wasm/dist/server/listing-tags.wasm`、`wasm/dist/test/host-probe.wasm` | Go |

`rust/` 是这棵 Rust 树的全部源码：`listing-core`/`listing-core-wasm`（上架规则）、`render`/`render-wasm`（PSD 渲染）、`psd-x`（PSD 读写，MIT 第三方 fork）、`listing-tags`/`wasm-host-probe`（窄 wasm 与宿主探针）、`op-workflow`（工作流纯类型与规则）。crate 都在 `rust/crates/` 下，共用一个 `Cargo.toml` 与 `rust/rust-toolchain.toml` 钉住的稳定工具链；只有 `threads` 版渲染产物单独用 nightly。仓库根没有 `crates` 目录，测试与文档写明确的 `rust/crates/` 路径。

浏览器产物也入库：`wasm/dist/browser/listing-state.wasm`、`wasm/dist/browser/render/render_wasm.wasm` 与 `wasm/dist/browser/render/threaded/` 的 WASM、JS、类型声明和 Worker snippets 作为一套提交，`web/` 不再另存副本。浏览器侧只有 `listing-state.wasm` 一份 listing-core 模块：它就是上表 `--features browser` 的产物，前端与 Go 浏览器测试读同一个文件。`make wasm` 只在本地构建全部模块并刷新清单；Go / Web 构建、Docker 和 CI 直接消费已提交产物。CI 校验源码、lockfile、构建配置 / 脚本和产物指纹并运行消费端测试，不安装 Rust / nightly / wasm-bindgen，不重新编译 WASM。项目树与迁移记录见 [architecture-tree.md](architecture-tree.md)。

`make web-wasm` 或 `cd web && bun run wasm:build` 只重建浏览器渲染产物，不刷新全局清单；浏览器 listing-core 模块没有单独的构建入口，它随 `scripts/build-wasm.sh core` 与服务端模块一起产出。listing-core 浏览器模块的体积上限沿用上游的 1.5 MiB：`browser` 特性去掉了 `snapshot_from_fields`，本仓库只比上游多导出 `send_transition`，实测仍在 1.5 MiB 以内。

## 租户隔离

业务查询带 `org_id`。请求事务执行 `SET LOCAL ROLE podhub_app`，并设置 `app.current_org_id`。RLS 策略 `tenant_isolation` 用这个 GUC 比较 `org_id`。Worker 领取跨租户作业时先用 `podhub_worker`（该角色带 `BYPASSRLS`），写某一租户的行之前再进入 `podhub_app`。

入口是 `internal/platform/db` 的 `InTx`，会话角色由 `db.App` / `db.Worker` / `db.Staff` / `db.Observer` / `db.WalletUser` / `db.SupplierUser` / `db.Grant` / `db.Catalog` 指定；`db.App` 之外的角色必须显式写明。SQL 底层仍在 `internal/platform/db/tenantx`，GUC 名只在那里出现，业务代码不得手写 `set_config`。`db.App(orgID)` 在 `orgID <= 0` 时于开事务之前返回 `tenantx.ErrOrgUnset`。

`banned_tags` 是全平台表，不加租户 RLS。

## 安全开关

解析语义固定，只在 `internal/platform/config` 读一次。业务代码不出现 `os.Getenv` / `os.LookupEnv`，由 `tests/archtest` 强制。

`OZON_WRITE_KILL_SWITCH`（`is_truthy`）：只有 `1` / `true` / `yes` / `on`（去空白、ASCII 小写）关闭 Seller 写。未设置、空串和其他值都保持写入开启。读不受这个开关影响。进程在开关未关闭时仍返回 `ErrNotPorted`，不向 Ozon 拨号。

`CLOUD_MEDIA_GC_DELETE`（`enabled`）：未设置时开启。`1` / `true` / `on` / `yes` 开启。`0` / `false` / `off` / `no` 关闭。其他值（含空串、非 UTF-8）记一条错误并保持关闭，进程不因此退出。开启后每天上海时间 04:00 清空物理桶 `podhub-transit`（固定 UTC+8，无关闭窗口；04:00 之前发出的上传可能被同一次清理删除，这是设计行为）。删除只允许打到主机名正好是 `127.0.0.1` 的假桶（`http` 或 `https`，可以带端口，不能带用户信息）。`localhost`、`::1` 和其他任何主机，以及不完整的 `R2_*`，在删除开启时拒绝构造客户端，不发送请求。没有 R2 配置时删除入口返回 `ErrDeleteNotPorted`，worker 不以 0 退出。假桶也要有 `transit_clear_runs` 才能删；没有数据库时 worker 以非 0 退出，对象留在桶里。

`DATABASE_URL` 只允许空值或回环地址（`localhost`、`127.0.0.1`、`::1`）。本进程不连接生产数据库、Ozon、真实 R2 或模型供应商。对象存储只拨主机名 `127.0.0.1`。

## 队列与迁移（已决定）

使用 River 和 goose，接受实现差异。每一项差异、结果为什么不变、对应测试，写在 [queue-and-migration-differences.md](parity/queue-and-migration-differences.md)。无法证明一致的点留在该文件末尾，不在这里代为取舍。

goose 不按上游文件名里的版本号排序。291 步按声明序号重编号后交给 goose，SQL（含 PL/pgSQL）保持原样，文件是 `db/migrations/00001` 到 `00291`。`00292` 只追加表授权，`00293` 追加 new-api 倍率文档表和 `ai_consume_logs`；更晚的迁移按合入顺序追加。Down 一律是 `SELECT 1`。

迁移号和合入顺序不一定单调：`00330–00332` 晚于 `00335–00337` 合入。`gooseUp` 用 `goose.WithAllowMissing()` 补跑这些低于已记录最大号的未执行文件，Down 和其他 goose 命令仍是默认行为。已合入的文件不得再改，新文件号必须大于基线最大号，由 `internal/platform/db/migrate_guard_test.go` 与 `db/migrations.sha256` 强制。

River 只负责把 worker 跑起来。业务上的 `jobs.state`、租约、退避和幂等由 `internal/queue` 的契约函数决定，不把 `river_job_state` 改名当成结果。

## 尚未决定

未决事项集中登记在 [decisions.md](decisions.md)，本节只列仍然开放的那几条，已决定的事项连同依据一并留在那里，不再散落在各域对拍文档里。

当前仍然开放的：

1. 浏览器那份 `listing-core.wasm` 要不要成为 Go 加载的那一份（服务端窄 wasm 的去留），见 [listing-core-host.md](parity/listing-core-host.md)。
2. 提交前的禁用标签闸是否保留——这是有意的行为选择，见 [listing-core-host.md](parity/listing-core-host.md)。
3. schema_revision 的排序何时放进 wasm 本身、何时退役 `LegacyRevision` 双版本接受，见 [schema-revision-parity.md](parity/schema-revision-parity.md)。

已经决定的：

- **OpenAPI**：`api/openapi.yaml` 是唯一 spec，oapi-codegen 生成 models 与 chi 路由，响应字节手写。它同时是前端的客户端生成源，因此 spec 必须描述本仓库实际的路由、状态码和响应形状（decisions.md D14），不以任何外部导出作为需要复原的目标。`internal/app/testdata/routes_openapi_allowlist.txt` 已清零，门禁按 **method+path** 比对，path 级的旧形态曾让 `POST /api/admin/banned-tags` 在 `GET` 的阴影里消失。JSON golden 只作对照，不是本仓库的生成链。
  - 唯一无法用 path 表达的形态是 chi 的通配符：`api/openapi.yaml` 用 `x-podhub-path: /api/seller/upstream/{uuid}/*` 记录真实模式，参数写作 `{seller_path}`。
  - 响应状态码由 `tests/testkit/openapi.go` 的 `CheckResponse` 对着真实 handler 输出校验；`tests/integration/openapi_check_test.go` 的 `specCheckedPrefixes` 决定覆盖哪些前缀。新增域时把前缀加进去，spec 里写的状态码才会有实测背书。
- **RelayKit 与计费公式副本的 AGPL-3.0**：接受，仓库整体采用 AGPL-3.0-only，见根目录 `NOTICE` 与 [newapi-billing-parity.md](parity/newapi-billing-parity.md)。

## 压测

只允许 Mode R（`PODHUB_LOADTEST_MODE=R`）。Mode R 不打开网络、不写 Ozon、不删对象。其他模式直接拒绝。

## 协议转换（RelayKit）

`internal/platform/llm` 封装 `github.com/QuantumNous/new-api/relaykit`（当前 `v0.3.4`，模块要求 Go 1.25.1 或更高；本仓库 `go.mod` 的语言版本是 1.27.0，工具链与实际编译使用 Go 1.27.2）。它只在 OpenAI Chat、OpenAI Responses、Claude Messages、Gemini `generateContent` 之间转换请求、响应和流式事件。HTTP、鉴权、计费仍由宿主完成。

`New` 注册 `SetMediaResolver`。需要下载 URL 或解析 data URL 时由宿主函数执行；未注册则转换失败，不由本包自行访问网络。转换诊断写入 `slog`，日志先去掉 `Bearer`、`api_key` 和 `sk-` 形态的密钥。本包不接收上游 API Key。

计费请求只走 Chat Completions。Responses 和 Anthropic Messages 账号存在，但不会被选去结算。RelayKit 先接进来，供后续决定识图或对话是否改走其他协议；在有对比测试之前，它不替换 `ai-gateway` 的出站。

RelayKit 使用 GNU AGPL-3.0。是否把它链进最终发行物，需要用户决定。
