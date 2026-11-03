# 决策登记表

这里统一登记跨文档决策；领域文档保留方案、实现与证据，引用本表，不再复制开放清单。已定不等于已部署或验收通过，精铺能力以[技术验证清单](precision-listing-verification.md)为准。

状态为 **开放**、**已定**、**不做**。被新决定取代的记录保留原编号并注明替代依据；代码已实现的原开放项移到「已定」，明确只核实静态实现。

## 开放

| # | 事项 | 现状 | 选项 | 推荐 | 相关文档 |
| --- | --- | --- | --- | --- | --- |
| O1 | 是否合并服务端与浏览器的 listing-core 模块 | 服务端嵌入 `listing-core.wasm`（含禁用标签 op 20、`snapshot_from_fields`），浏览器用 `--features browser` 的 `listing-state.wasm`；共用源码，不共用同一二进制 | a) 去掉 feature 差异后合并；b) 保持按 feature 分别构建 | 维持现有分工；合并需另验导出与体积 | [listing-core-host.md](parity/listing-core-host.md)、[architecture.md](architecture.md) |
| O2 | 是否改变提交前禁用标签策略 | 当前提交路径保留冻结前标签拒绝；历史材料对「已决定」与「倾向保留」记载不一致，本表不补造确认 | a) 保留现状；b) 改变策略并同步回归 | 保留现状，变更时明确决定 | [listing-core-host.md](parity/listing-core-host.md) |
| O3 | schema revision 排序与旧哈希退役 | Go 调用前排序；`LegacyRevision` 与 `submit/schema_revision.go` 仍接受旧哈希 | a) 内核统一排序并同步调用方、缓存与测试；b) 维持当前实现 | 按新工程约束收敛为单一契约；现存双接受不构成永久旧兼容要求 | [schema-revision-parity.md](parity/schema-revision-parity.md) |
| O9 | 套餐兑换码如何与已付订阅共存 | 套餐码指定套餐、店铺数和月数 | a) 已付期间结束后追加；b) 立即覆盖原期间 | a，保留已付时长；没有有效期间时立即开始 | [subscription-billing.md](architecture/subscription-billing.md#套餐兑换码) |
| O14 | 是否引入 `can_view_global` 让非超管看全平台数据 | 现行方案没有引入该标志；跨租户观察授权仍须单独核查，旧报告的固定调用点计数不作为现状 | a) 不引入，观察面继续只认 super_admin；b) 引入并复核所有 HTTP、SQL 与 RLS 授权路径 | a | [account-permission-model.md](architecture/account-permission-model.md) §角色为何分开、§决策状态 |
| O16 | 套餐功能是否按档位开关 | 尚未实现按套餐的功能开关：在能力表和服务端检查落地之前，各档只在店铺单价和数量上有区别 | a) 增加套餐能力表，服务端各入口检查；b) 各档功能保持一致，只按数量与单价区分 | a | [订阅与续费](architecture/subscription-billing.md) §价格与容量 |
| O17 | 自动续费是否代扣 | 没有已验证的代扣或授权扣款能力；工作区钱包是 AI 额度，不是订阅付款渠道。D25 只做自动出单 | a) 只出单，用户付款；b) 到期前从工作区钱包自动扣；c) 接入渠道代扣协议 | a；b、c 须先按精铺准入的方式验证授权、实际扣款、结果回读和失败处理 | [订阅与续费](architecture/subscription-billing.md#待实现店铺上限自动出单与到期冻结) |

## 已定

| # | 事项 | 结论 | 依据 / 落点 |
| --- | --- | --- | --- |
| D1 | 迁移历史 | 压缩为 `00001_roles` / `00002_schema` / `00003_seed` 三个文件，版本连续，`gooseUp` 用严格 `Up`；已提交文件由 sha256 冻结，新增文件号必须更大 | `internal/platform/db/migrate.go` 的 `gooseUp`；`internal/platform/db/migrate_guard_test.go`、`db/migrations.sha256`；[architecture.md](architecture.md) §队列与迁移 |
| D2 | OpenAPI 生成链 | `api/openapi.yaml` 是唯一 spec；oapi-codegen 生成 models 与 chi 路由（生成范围 2026-10-28 起收缩为 7 个单元，见 D24），响应字节手写 | `api/codegen/*.yaml`、`Makefile` 的 `generate`、[architecture.md](architecture.md) |
| D3 | 集成测试的 Postgres | 普通用例使用共享 Docker 容器和迁移一次的模板库；改角色或重放部分迁移的用例使用独立集群。显式测试 DSN 与无 Docker 时的行为见 README | `tests/integration/main_test.go`、`tests/testkit`、[开发与检查](../README.md#开发与检查) |
| D4 | 镜像是否含 `writer-lease` | 含 | `Dockerfile`、`Makefile` 的 `build` |
| D5 | OTLP exporter 默认 | 默认关闭；只有 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 指向回环 collector 时才拨号 | `internal/platform/observability/observability.go` |
| D6 | AI 计费与协议调用的来源 | 自研 `internal/billing/contract` 与 `internal/platform/aiclient`；不链接、不拷贝 RelayKit/new-api。仓库为专有软件，SPDX `LicenseRef-Proprietary` | `internal/billing/contract`、`internal/platform/aiclient`、根 `LICENSE` 与 `NOTICE`、[ai-billing-parity.md](parity/ai-billing-parity.md) |
| D7 | 前端是否从 spec 生成契约类型与路径 | 生成，已落地：`web/` 用 openapi-typescript 从 `api/openapi.yaml` 生成 `schema.d.ts`，再生成 `routes.ts`；请求封装和业务接线仍由前端实现 | `web/package.json` 的 `api:generate` / `api:routes`；`web/src/api/routes.test.ts` |
| D8 | admin 子单元的切分粒度 | 按主题（shipping、supplier、billing、delegate、catalog、users、observe、x1） | `tests/archtest/arch_test.go` 的 `level`、[architecture-tree.md](architecture-tree.md) |
| D9 | 环境变量解析点 | 只在 `internal/platform/config`；业务代码不出现 `os.Getenv` / `os.LookupEnv` | `tests/archtest/parsepoint_test.go` |
| D10 | 租户事务入口 | `internal/platform/db.InTx` + 显式会话；空会话拒绝，不隐式补租户。会话构造器和授权边界统一见项目树；GUC 设置集中在 `tenantx`，旧调用由架构基线收敛 | `internal/platform/db/tx.go`、[数据库薄封装](architecture-tree.md#数据库薄封装) |
| D11 | 业务队列是否迁到 River | 不迁。River 只当执行器，业务状态在 `jobs` 表 | [architecture.md](architecture.md)、[queue-and-migration-differences.md](parity/queue-and-migration-differences.md) |
| D12 | 是否批量把手写 SQL 改成 sqlc | 不批量改；sqlc 用于新查询和被迁移的查询 | [optimization-plan.md](architecture/optimization-plan.md) |
| D13 | 是否编译 Go wasm（`GOOS=js`） | 不做；浏览器侧继续用 Rust wasm（源码在 `rust/crates`，产物在 `wasm/dist/browser`） | [architecture.md](architecture.md) |
| D14 | spec 以哪一侧为准 | **以 Go 代码为准**：`api/openapi.yaml` 描述本仓库当前实际的路由、状态码和响应形状。Go 独有的路由保留并在文档里标注来源 | `api/openapi.yaml`、`internal/app/testdata/routes.txt`、[architecture.md](architecture.md) §契约与变更 |
| D15 | 订阅定价、账期、容量变更与到期规则 | 套餐 free/lite/pro/max 决定功能档位和各自的店铺单价，没有打包月费，也不含店铺。月价 = 店铺数 × 该档店铺单价，店铺按绝对数量购买（种子价：lite ¥20、pro ¥25、max ¥30，每店铺每月；free 不可购买，固定 1 店）。**成员不售卖**：每个工作区的成员上限全局为 10 人（含所有者），不分档位，free 也一样；超出上限的加入者按加入顺序 `quota_suspended`，所有者永不暂停；管理员可用 `organizations.member_seat_limit_override` 把某工作区上限覆盖为 1–10。取消成员单价，这取代了更早的「所有者是唯一免费成员、额外成员每人 ¥30」方案。上限常量 `billing/domain.MemberCap`、`admin/users/contract.MemberCap` 与 SQL `subscription_capacity()` 里的 10 须同改。可购买期限 1/3/6/12 个完整服务月，不打折；单价在每个付费期间内冻结。升级或增加店铺补当月差额，折算到期间结束；减少店铺免费，下期生效。同账号最多一个 free 工作区，同账号最多一个 free 工作区，付费工作区不限数量，不建抵扣账本。**原自然月账期已被购买日方案替代**：首购/续费买完整服务月，已付期间与下次配置分开；到期排水与免费容量按现行方案 | 基线 `00002_schema.sql` / `00003_seed.sql`（`plans.store_monthly_cents`）、`internal/billing/domain/period.go` / `subscription.go`；[订阅与续费](architecture/subscription-billing.md)（2026-10-27）；本次仅静态核对 |
| D18 | 前端是否并入本仓库 | 并入 `web/`。React 19 + Vite，与 Go 服务端同仓；HTTP 契约来自 `api/openapi.yaml`，浏览器消费 `wasm/dist/browser/` 下的上架与渲染产物 | `web/`、[architecture.md](architecture.md) §系统边界、[architecture-tree.md](architecture-tree.md) §仓库边界 |
| D19 | 未实现接口是否一律保留为 501 | **原决定已被 API 简化取代**：无生产消费方的接口已按范围删除；现存桩和未挂载路由由契约测试登记，不是保留所有旧接口的理由 | [API 简化记录](api-simplification-report.md)；`internal/app/api/not_ported.go`、`web/src/api/mounted.test.ts` |
| D20 | `web/` 的 wasm 测试依赖 | 根目录的 `crates` 已删除；前端测试与文档写明确的 `rust/crates/...` 路径 | `web/.gitignore`、[architecture-tree.md](architecture-tree.md) §迁移记录 |
| D21 | PSD 渲染源码是否并入本仓库 | 并入 `rust/crates/{render,render-wasm,psd-x}`，属于同一个 workspace。产物入库，用 `make wasm`（或 `scripts/build-wasm.sh render`）重建。这同时回答了原 O4：取「并入 `rust/`」而不是当时推荐的「只提交产物 + 源码哈希」 | `rust/Cargo.toml`、`scripts/build-wasm.sh`、`Makefile`、[optimization-plan.md](architecture/optimization-plan.md) D7 |
| D22 | listing-core 浏览器产物体积上限 | 沿用上游的 1.5 MiB，不另放宽。浏览器模块就是 `--features browser` 的 `wasm/dist/browser/listing-state.wasm`，该特性去掉服务端专用导出 `snapshot_from_fields`，本仓库只比上游多导出 `send_transition`，实测仍在 1.5 MiB 以内；导出面由同文件的导出断言锁定（必须含 `send_transition`、不得含 `snapshot_from_fields`），提交了服务端那份会直接失败 | `web/tests/listing-core-wasm.test.ts` 的 `WASM_SIZE_LIMIT` 与导出断言 |
| D23 | 目录 RLS 是否保留通用兼容读臂 | 不保留 `sc_<table>_app_compat`；按 staff、商品负责人、公开目录、供应商成员与卖家绑定分别授权，工厂成本不开放通用读 | 基线 `00002_schema.sql` 的 `sc_*` RLS 策略；[账号权限方案](architecture/account-permission-model.md) 记录授权及验收边界 |
| D24 | 12 个域放弃 oapi-codegen 生成路线 | admin、ai、store、ratings、ops、mcp、delegate、billing、automation、telemetry、supply、supplier 及 catalog-reads（reads 变体）的 13 份生成配置与对应零引用生成目录（含 `internal/agent/gen/sqlcgen`）删除，这些域的 HTTP 层手写；`api/openapi.yaml` 仍是唯一契约源（D2 的 spec 地位不变）。同一批清理 4 个零引用业务包（`internal/seller/ozon/repo/ledger`、`internal/media/domain/multipart`、`internal/media/service/render`、`internal/delegate/jobs`）。明确接受校验面收窄：被删 tag 的 Go 侧 typename 碰撞只能靠剩余 7 份配置与前端 openapi-typescript 链发现 | `api/codegen/`（余 agent、catalog、health、identity、listing、listing-rules、media 共 7 份）、`sqlc.yaml`、`Makefile`；[api-simplification-report.md](api-simplification-report.md) 与 delegate/supplier parity 的历史注记。`db/queries/agent` 留待 db 侧后续清理 |
| D25 | 店铺购买上限、自动出单与到期冻结 | 补充 D15，并取代 D15 中「到期回落免费容量」的部分及原开放项 O7。①每工作区单次有效购买至多 100 个店铺名额（一店一把当前密钥），按单个工作区计；成员仍为 10 人免费。②到期前 72 小时为开启 `auto_renew` 的工作区生成 1 个月续费单，金额冻结；只出单不代扣，用户选渠道付款，否则到期后重新购买。③付过费的工作区到期后冻结：全部店铺拒绝新业务，数据与成员只读可见，只能续费或充值；从未付费的 free 工作区仍为 1 家店；无宽限期。实现于迁移 `00014`；本地 Postgres 回归通过，未做真实商户或生产验收 | [订阅与续费](architecture/subscription-billing.md#待实现店铺上限自动出单与到期冻结) |
| D26 | 发布时由谁执行数据库迁移 | 采用一次性部署作业：新增 `cmd/migrate`（同一镜像内），在 API、worker、lease-keeper 启动前执行；API 启动仍不自动迁移。`PODHUB_ALLOW_SUPERUSER_DB=1` 仅给该作业；`PODHUB_API_DB_PASSWORD` 设置 `podhub_login_api`，`PODHUB_WORKER_DB_PASSWORD` 设置三个 worker 登录角色密码 | `cmd/migrate`、`internal/app/migrate.go`、`compose.yaml` 的 `migrate` 服务、`Dockerfile` |

### 原开放项的实现状态（2026-10-23 静态复核）

以下只确认代码和迁移已有落点，未在本次文档清理中执行数据库验收或核查生产部署。

| 原编号 | 当前实现 | 依据与仍需核验的范围 |
| --- | --- | --- |
| O8 | 不立即收回已付容量；减少下次购买数量在全部已付服务结束后适用，已购买未来低容量期间在其开始时切换 | `internal/billing/domain/subscription.go`、[订阅与续费](architecture/subscription-billing.md#店铺续费调整)；不把提前支付等同于提前减容 |
| O11 | 同一货源库最多一名 active 履约人；迁移选择最早 active 成员回填 | `00361`；[账号权限方案](architecture/account-permission-model.md)。业务分配与越权行为仍需相应测试 |
| O12 | 可匹配历史包回填履约人；剩余 NULL 包不向供应商开放，由 staff 处理；未保留六周过渡臂 | `00362`、`00363`；不再把已撤销的兼容窗口列为推荐 |
| O13 | provision 拒绝复用 `account_kind=platform` 的账号 | `internal/admin/supplier/repo/accounts.go`；账号转型不能靠静默绑定完成 |
| O15 | 删除供应商钱包访问前，非零余额或 requested 提现会阻断迁移，须先人工清算；本人固定派单对应结算仍可读 | `00363`；不能概括为「供应商不能读任何资金行」，也不证明生产余额已清算 |

## 不做

| # | 事项 | 原因 |
| --- | --- | --- |
| N1 | 统一 20 份 `itoa` | 收益太小，收进公共包反而增加跨包依赖 |
| N2 | 拆 `internal/identity` 的平铺文件 | `net/http` 与同包未导出调用绑住，改动会制造新违规或改函数体；见 [architecture-tree.md](architecture-tree.md) §仓库边界 |
| N3 | 无目的改名 `listing` 路由、字段和队列 kind | 不做纯改名；原「结果一致性禁止改契约」已由新工程准则取代，必要产品变更须同步调用方与测试 |
| N4 | 改 `OZON_WRITE_KILL_SWITCH`、`CLOUD_MEDIA_GC_DELETE` 的解析与语义 | 语义固定，见 [architecture.md](architecture.md) §安全开关与外部出口 |
| N5 | 改写已提交迁移 | 迁移指纹守卫冻结历史；必要的数据库行为调整通过新迁移与回归表达，不因此禁止后续修正函数 |
