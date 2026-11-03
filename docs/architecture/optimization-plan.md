# podhub-go 优化计划（历史记录）

原计划基于 `565e548`（PR #64 合入后），后续回看记录至 `8e37ea9`。**这是阶段性记录，不是“全部完成”的验收报告。** 下表的数量、路径和完成状态均属于当时快照，不表示 2026-10-23 工作树或生产环境状态。

当前约束见 [architecture.md](../architecture.md)，目录见 [architecture-tree.md](../architecture-tree.md)，决策见 [decisions.md](../decisions.md)。未完成项不能直接按旧 PR 序列继续实施，必须先核对当前代码、调用点与需求。

2026-10-25 补记：OPT-17 的队列部分已迁移为使用方声明 ports、装配层显式传入；旧队列根包与基础设施注册包已删除。下表保留原阶段快照，当前队列结构以项目树为准。

## 阶段性回看（原记录核对至 `8e37ea9`）

| 项 | 状态 | 落点 / 备注 |
| --- | --- | --- |
| OPT-1 CI | 完成 | `.github/workflows/ci.yml`：push 只跑 main、`concurrency` 取消旧运行、`lint` / `web` / `test` 三个 job 并行、生成器二进制缓存。wasm 校验在 `test` job 内，没有独立的 wasm job，也没有路径过滤 |
| OPT-2 Makefile/README | 完成 | `Makefile` 的 `generate`/`ci`/`codegen-versions`；`build` 含 writer-lease |
| OPT-3 迁移守卫 | 完成 | `internal/platform/db/migrate_guard_test.go` + `db/migrations.sha256`（baselineMax 341 / 313 个文件） |
| OPT-4 许可证 | 部分 | 根 `LICENSE`、`NOTICE`、`THIRD-PARTY-LICENSES.md` 已在；**CI 尚未校验清单是否最新** |
| OPT-5 archtest 加强 | 完成 | `tests/archtest/parsepoint_test.go`；`baseline.txt` 只剩 2 行（`admin/repo/dissolve.go`、`agent/repo/wallet.go`） |
| OPT-6 集成测试共享容器 | 完成 | `tests/integration/main_test.go` 共享容器 + 模板库；62 个 Test 仍串行 |
| OPT-7 事务封装 | 完成 | `internal/platform/db/tx.go`（`InTx` + `App`/`Worker`/`Staff`/… 会话） |
| OPT-8 按域迁移到 InTx | 进行中 | 10 个域已用 `InTx`；仍有 48 个文件直接 `Begin`/`BeginTx`，集中在 admin 14、listing 8、billing 5 |
| OPT-9 `os.Getenv` 收口 | 完成 | 非测试代码里 `platform/config` 之外已为 0 |
| OPT-10 routes ⊆ spec 棘轮 | 完成 | `internal/app/routes_openapi_test.go`，白名单 `routes_openapi_allowlist.txt` |
| OPT-11 补 spec | 完成 | spec 343 个 operation / 294 path；白名单从 36 条降到 **0**。方向改为以 Go 代码为准（decisions.md D14），不再以 Rust spec 为目标 |
| OPT-12 codegen 统一 | 进行中 | 23 份配置；18 份 `chi-server`、5 份只生成 models（ai、billing、catalog-reads、ratings、stores） |
| OPT-13 响应写出收口 | 进行中 | 仍有 18 处本地 `writeJSON`/`writeErr`；`jsonwire` 只被 25 个包使用 |
| OPT-14 装配层改名 | 完成 | `wire_pr8a`/`wire_pr8b`/`wire_x2`/`adminb_*` 已全部消失 |
| OPT-15 admin 拆子单元 | 完成 | 8 个主题子单元 + `admin/core`，已登记进 `level` 表 |
| OPT-16 admin 去重 | 部分 | `PickMethod` 已收口到 `admin/shipping/contract`；其余重复规则未见后续 PR |
| OPT-17 收根包门面 | **未做** | `internal/queue/wire.go`、`internal/billing/wire.go` 的 `init` 仍未拆 |
| OPT-18 可观测性 | 完成 | slog 带 trace_id/span_id、OTLP 默认关、pgx QueryTracer、出站 `traced`、River span |
| OPT-19 River 周期任务登记表 | 完成 | `internal/app/worker/periodic.go` |
| OPT-20 wasm 统一 | 完成 | 产物都在 `wasm/dist/{server,browser,test}`，一份 `SOURCES.sha256`，`scripts/build-wasm.sh`，单一 workspace 工具链（`rust/`） |
| OPT-21 切断 gin | 完成 | `go list -deps ./cmd/api` 已不含 `gin-gonic` |
| OPT-22 切换方案 | 完成 | [cutover-plan.md](cutover-plan.md)，并已修正本文 Q1 的结论 |

### 原方案决策的阶段性结果

| # | 结果 |
| --- | --- |
| D1 迁移乱序 | 已终结：迁移历史压缩为三个连续版本的文件，`WithAllowMissing` 移除，`gooseUp` 用严格 `Up`；OPT-3 的 sha256 守卫保留。见 [cutover-plan.md](cutover-plan.md) §4.1 |
| D2 codegen 形态 | 方向取 a（`models + chi-server`），但尚未统一：23 份里 18 份带 `chi-server` |
| D3 共享容器 | 取 a，已落地 |
| D4 Dockerfile 加 writer-lease | 加了 |
| D5 schema_revision 排序进 wasm | **未做**，`LegacyRevision` 仍在（`internal/listing/submit/draft.go`） |
| D6 OTLP 默认 | 默认关，由 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 开启 |
| D7 PSD 渲染 wasm | **部分**：源码已并入 `rust/crates/{render,render-wasm,psd-x}`，浏览器产物在 `wasm/dist/browser/render/`（`web_source_sha256` 与 `web_glue_sha256` 记录源码与 threaded glue）。没有 `psd-render.wasm` 服务端条目：PSD 渲染只有浏览器构建，没有服务端 ABI 组 |
| D8 前端从 spec 生成 | 方向已定；上表记录 OPT-11 已补齐当时路由，不能据此认定客户端已全部生成 |
| D9 NOTICE 界面署名 | 未到：还没有日志 UI |
| D10 admin 切分粒度 | 按主题，已落地 |


## 保留的设计理由

| 主题 | 当时的问题与取舍 | 验收边界 |
| --- | --- | --- |
| 事务与租户隔离 | 手写角色和 GUC 分散，使用 `db.InTx` 与显式 App / Worker / Staff 等会话收口；缺组织的 App 会话应在开事务前拒绝 | 核对事务内 `current_user`、GUC、跨组织拒绝与事务结束后的角色恢复；封装存在不等于所有调用方已迁移 |
| sqlc 配置 | 原计划拟统一 schema 来源；当前 `sqlc.yaml` 仍引用 `db/schema`、`db/schema/pr8a` 与 `db/agent-schema`，不能记为已完成收口 | 迁移查询需核对生成类型、Scan 与 JSON 输出，不能只要求生成命令成功 |
| admin 分层 | 主题间共享大包妨碍定位与隔离，先按主题拆分，再处理重复业务规则 | 纯移动比较函数体；去重比较实际输入、输出及持久化，不只看编译通过 |
| OpenAPI 与响应 | 路由、类型和实际响应必须对得上；生成器不替代手写响应的字节契约 | 路由集合、spec、生成物和消费者一起核对；补 spec 不等于外部调用已验证 |
| 测试容器 | 每测试起容器和重复迁移占据 CI 时间，改为共享容器与模板库 | 修改集群角色的测试需隔离，不能仅以耗时下降证明无测试串扰 |
| 配置解析 | 环境变量应在 `platform/config` 收口，保留各变量实际读取时机 | 启动时读取和调用时读取不可混同；开关语义需独立测试 |
| River | 只承担执行与周期任务，业务状态继续由 `jobs` 管理 | 周期任务 kind、周期及入队语义不因登记方式改变 |
| 可观测性 | HTTP、数据库、出站和 worker 的 trace 需要串联；OTLP 默认关闭 | 关闭 exporter 不应新增出口；HTTP 响应不能被观测接线改变 |
| WASM | 产物与源码清单收口到 `wasm/dist`，源码并入同一 Rust workspace | 重编可改变二进制哈希；以新清单和结果级 golden 验收，不能要求重编前后哈希不变 |
| 迁移 | 已应用文件冻结，新增迁移追加；版本连续，无缺号补跑 | 守卫不保证旧二进制兼容新 schema，也不替代非空库迁移验证 |
| 依赖 | 切断计费适配层无关的 gin 传递依赖，公式副本保持其校验规则 | 依赖图和计费结果都要核对；许可证清单是否最新需单独检查 |

## 5. 原方案的范围取舍

### 5.1 没有纳入的工作

- 不把业务队列迁到 River，不批量把所有手写 SQL 改成 sqlc；sqlc 用于新查询和实际迁移的查询。
- 不为二十余份简单 `itoa` 新建公共层，不为目录整齐强拆 identity。
- 不把当时的重构扩成生产切换或真实 Ozon 写入验收。
- 保留当时纯重构的响应、路由与数据验收要求；这些历史要求不构成当前新增功能的旧兼容承诺。

原文的逐 PR 施工序列、固定迁移起号、等待 #62/#65 的冲突表及多份重复验收清单已移除。它们依赖已经变化的工作树，继续复制会误导施工。发布讨论仍可参考 [cutover-plan.md](cutover-plan.md)，但必须重新证明目标发布对的迁移与回滚条件。
