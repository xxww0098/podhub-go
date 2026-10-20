# 决策登记表

这是未决事项与已决事项的唯一登记处。各域对拍文档（`docs/parity/*.md`）只在末尾列本域独有的开放问题，并链接到这里；同一个决策不要在多处各写一份。

状态只有三种：**开放**（尚未定）、**已定**（有结论和依据）、**不做**（明确不做，附原因）。

## 开放

| # | 事项 | 现状 | 选项 | 推荐 | 相关文档 |
| --- | --- | --- | --- | --- | --- |
| O1 | 浏览器 `listing-core.wasm` 是否成为 Go 加载的那一份 | 服务端用同一份源码另编的窄 wasm（只有禁用标签匹配），与浏览器产物不是同一字节 | a) 在 `listing-core-wasm` 增加一个匹配 op，产出 Go 与浏览器共用的单一 wasm；b) 维持窄 wasm | a，但要等上游导出该 op；在此之前维持 b | [listing-core-host.md](parity/listing-core-host.md)、[architecture.md](architecture.md) |
| O2 | 提交前的禁用标签闸是否保留 | `POST /api/listing/submit` 在冻结前拒绝命中禁用标签的请求（400），而冻结本身不查标签。这是有意的行为变化，用户已表示倾向保留 | a) 保留；b) 去掉，让冻结不查标签 | a | [listing-core-host.md](parity/listing-core-host.md) |
| O3 | schema_revision 的排序何时放进 wasm | Go 在调用 `snapshot_from_fields` 前按 attribute id 排序；wasm 内部仍按传入顺序哈希。`LegacyRevision` 双版本接受仍在 `internal/listing/submit/draft.go` | a) 下次浏览器 wasm 重编时把排序放进 wasm，观察一个窗口期后退役 `LegacyRevision`；b) 永久维持服务端排序 + 双版本接受 | a；窗口期至少为缓存 TTL 的数倍，具体长度待定 | [schema-revision-parity.md](parity/schema-revision-parity.md) |
| O5 | 发布时由谁执行数据库迁移 | 进程启动不自动迁移，仓库里没有迁移命令行入口；`db.Migrate` 只被集成测试调用 | a) 增加 `cmd/migrate`；b) 由部署流程在启动前跑一次性 job；c) 启动时自动迁移 | a 或 b，取决于部署方式 | [architecture.md](architecture.md) §队列与迁移 |
| O6 | 日志 UI 与 NOTICE 署名位置 | 还没有日志页 | a) 随日志 UI 一起放；b) 先放在前端页脚 | a | [newapi-billing-parity.md](parity/newapi-billing-parity.md) |
| O7 | 订阅到期后能否在 free 容量内继续新建任务 | 到期即拦截新活、放行在途任务；截断后的工作区是否还能小规模使用没有决定 | a) 允许，按 free 容量继续用；b) 不允许，到期后只能读 | a | [subscription-billing.md](architecture/subscription-billing.md) §已定与待定 |
| O8 | 12 个月预付期间能否立即减容 | 方案按「一律在 `term_end` 生效且不退款」写；立即释放会让同一账期内反复增减被重复计费 | a) 只在 `term_end` 生效；b) 允许立即释放、钱不退 | a | [subscription-billing.md](architecture/subscription-billing.md) §定价与折算 |
| O9 | 兑换码改成「赠送 N 个月」后如何落账 | 兑换码当前按席位发批次，新方案改为时长 | a) 叠加在已有账期上顺延；b) 只用于已过期工作区重开 | a | [subscription-billing.md](architecture/subscription-billing.md) §旧机制处理 |
| O10 | 钱包按所有者用户还是按工作区记账 | `user_wallets` 主键是 `user_id`，同一 owner 的多个付费工作区共享余额；「付费工作区不限数量」后更明显 | a) 保留 owner 级共享并写进产品说明；b) 改为按工作区（`user_wallets` / `wallet_ledger` / `HoldTx` / `SettleTx` 全部改主键） | a | [subscription-billing.md](architecture/subscription-billing.md) §已定与待定 |

## 已定

| # | 事项 | 结论 | 依据 / 落点 |
| --- | --- | --- | --- |
| D1 | 迁移号乱序 | `goose.WithAllowMissing()` + 迁移文件 sha256 守卫；不改历史迁移号 | `internal/platform/db/migrate.go` 的 `gooseUp`；`internal/platform/db/migrate_guard_test.go`、`db/migrations.sha256`；[architecture.md](architecture.md) §队列与迁移 |
| D2 | OpenAPI 生成链 | `api/openapi.yaml` 是唯一 spec；oapi-codegen 生成 models 与 chi 路由，响应字节手写 | `api/codegen/*.yaml`、`Makefile` 的 `generate`、[architecture.md](architecture.md) |
| D3 | 集成测试的 Postgres | 共享容器 + 迁移一次的模板库，测试串行 | `tests/integration/main_test.go`、`tests/testkit` |
| D4 | 镜像是否含 `writer-lease` | 含 | `Dockerfile`、`Makefile` 的 `build` |
| D5 | OTLP exporter 默认 | 默认关闭；只有 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 指向回环 collector 时才拨号 | `internal/platform/observability/observability.go` |
| D6 | RelayKit 与计费公式副本的 AGPL-3.0 | 接受，不购买商业授权；仓库整体 AGPL-3.0-only | 根 `NOTICE`、[newapi-billing-parity.md](parity/newapi-billing-parity.md) |
| D7 | 前端是否从 spec 生成客户端 | 生成，已落地：`web/` 用 openapi-typescript 从 `api/openapi.yaml` 生成 `schema.d.ts`，再生成 `routes.ts` | `web/package.json` 的 `api:generate` / `api:routes`；`web/src/api/routes.test.ts` |
| D14 | spec 以哪一侧为准 | **以 Go 代码为准**：`api/openapi.yaml` 描述本仓库当前实际的路由、状态码和响应形状。Go 独有的路由保留并在文档里标注来源 | `api/openapi.yaml`、`internal/app/testdata/routes.txt`、[architecture.md](architecture.md) §OpenAPI |
| D8 | admin 子单元的切分粒度 | 按主题（shipping、supplier、billing、delegate、catalog、users、observe、x1） | `tests/archtest/arch_test.go` 的 `level`、[architecture-tree.md](architecture-tree.md) |
| D9 | 环境变量解析点 | 只在 `internal/platform/config`；业务代码不出现 `os.Getenv` / `os.LookupEnv` | `tests/archtest/parsepoint_test.go` |
| D10 | 租户事务入口 | `internal/platform/db.InTx` + 显式会话（`App`/`Worker`/`Staff`/`Observer`/`WalletUser`/`SupplierUser`/`Grant`/`Catalog`）；GUC 名只在 `tenantx` | `internal/platform/db/tx.go`、[architecture.md](architecture.md) |
| D11 | 业务队列是否迁到 River | 不迁。River 只当执行器，业务状态在 `jobs` 表 | [architecture.md](architecture.md)、[queue-and-migration-differences.md](parity/queue-and-migration-differences.md) |
| D12 | 是否批量把 1,091 处手写 SQL 改成 sqlc | 不批量改；sqlc 只用于新查询和被迁移的查询 | [optimization-plan.md](architecture/optimization-plan.md) §5.1 |
| D13 | 是否编译 Go wasm（`GOOS=js`） | 不做；浏览器侧继续用 Rust wasm（源码在 `rust/crates`，产物在 `wasm/dist/browser`） | [architecture.md](architecture.md) |
| D18 | 前端是否并入本仓库 | 并入 `web/`。React 19 + Vite，与 Go 服务端同仓；两边只通过 `api/openapi.yaml` 和 `wasm/dist/browser/listing-state.wasm` 耦合 | `web/`、[architecture.md](architecture.md) §系统边界、[architecture-tree.md](architecture-tree.md) §仓库边界 |
| D19 | Go 未实现但 spec 已登记的路由 | 保留在 spec 里，由 `internal/app/api/not_ported.go` 的桩统一回 501 `NOT_PORTED`，不删除；spec 里有而 Go 根本没挂载的 54 条不在此列，前端 `web/src/api/mounted.test.ts` 用只减不增的名单登记，禁止新增调用 | `internal/app/api/not_ported.go`；`routes.txt` 黄金表同步收录；`web/src/api/mounted.test.ts` |
| D20 | `web/` 的 wasm 测试依赖 | 根目录的 `crates` 已删除；前端测试与文档写明确的 `rust/crates/...` 路径 | `web/.gitignore`、[architecture-tree.md](architecture-tree.md) §迁移记录 |
| D21 | PSD 渲染源码是否并入本仓库 | 并入 `rust/crates/{render,render-wasm,psd-x}`，属于同一个 workspace。产物入库，用 `make web-wasm` 重建。这同时回答了原 O4：取「并入 `rust/`」而不是当时推荐的「只提交产物 + 源码哈希」 | `rust/Cargo.toml`、`web/scripts/build-render.sh`、`Makefile`、[optimization-plan.md](architecture/optimization-plan.md) D7 |
| D22 | listing-core 浏览器产物体积上限 | 沿用上游的 1.5 MiB，不另放宽。浏览器模块就是 `--features browser` 的 `wasm/dist/browser/listing-state.wasm`，该特性去掉服务端专用导出 `snapshot_from_fields`，本仓库只比上游多导出 `send_transition`，实测仍在 1.5 MiB 以内；导出面由同文件的导出断言锁定（必须含 `send_transition`、不得含 `snapshot_from_fields`），提交了服务端那份会直接失败 | `web/tests/listing-core-wasm.test.ts` 的 `WASM_SIZE_LIMIT` 与导出断言 |
| D15 | 订阅账期、容量变更与到期规则 | free/lite/pro/max 四档，店铺统一 ¥20/月、成员 ¥30/月；账期按自然月、`Asia/Shanghai`；套餐购买、续费、加购、加人、升级全部按当月剩余天数折算（同一个 `Prorate`），加购与升级不改到期日；3/6/12 个月不打折；宽限 0 天；到期前入队的任务全部跑完；付费工作空间不限数量、同一账号同一时刻只能有 1 个 free 工作空间；不建抵扣账本 | 用户 2026-10-18 确认；[subscription-billing.md](architecture/subscription-billing.md) |

## 不做

| # | 事项 | 原因 |
| --- | --- | --- |
| N1 | 统一 20 份 `itoa` | 收益太小，收进公共包反而增加跨包依赖 |
| N2 | 拆 `internal/identity` 的平铺文件 | `net/http` 与同包未导出调用绑住，改动会制造新违规或改函数体；见 [architecture-tree.md](architecture-tree.md) §仓库边界 |
| N3 | 改对外的 `listing` 命名、路由、JSON 字段、错误码、队列 kind | 结果一致性约束 |
| N4 | 改 `OZON_WRITE_KILL_SWITCH`、`CLOUD_MEDIA_GC_DELETE` 的解析与语义 | 语义固定，见 [architecture.md](architecture.md) §安全开关 |
| N5 | 改已有迁移文件与 PL/pgSQL 函数体 | 迁移守卫冻结；函数体保持既定实现，不重写 |
