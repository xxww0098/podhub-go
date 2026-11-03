# 发布切换方案：shadow / canary / 回滚

本文源于 `27b6a73` 的优化计划 OPT-22，2026-10-23 清理。它是发布检查框架，未执行生产切换或回滚演练。“旧版”“新版”指两个明确的 Go 发布版本；执行前须记录提交、迁移差异、实例、数据恢复点和实际部署方式。当前未挂载独立撤租接口，原转移流程已不完整，写切换与回滚都不能按本文直接执行。

约定：

- 不新增开关。Ozon 写入只用现有的 `OZON_WRITE_KILL_SWITCH` 关闭，对象删除只用现有的 `CLOUD_MEDIA_GC_DELETE` 关闭，解析和语义不变（`internal/platform/config/config.go` 的 `isTruthy`、`mediaDeleteEnabled`）。
- 迁移只追加，Down 不提供数据回退。只有目标旧二进制已验证能运行于新 schema 时，才可只切回二进制；破坏性迁移必须另有恢复或前向修复方案。
- 路由、JSON 字段、错误码、队列 kind 不改名。切换期间不合入改这些的 PR。

---

## 1. 现有机制（切换依赖的事实）

| 机制 | 位置 | 对切换的意义 |
| --- | --- | --- |
| 写入租约 | `internal/platform/writer/lease.go` | 管理接口接受的写域（`auth`、`entitlement`、`catalog`、`recipe`、`telemetry`、`admin`、`release`，见 `internal/admin/domain/lease.go`）同一时刻只有一条未撤销的 `writer_leases` 行。`Decide` 只放行 holder 为 `axum`、`holder_instance` 等于本进程 `CLOUD_INSTANCE_ID` 且未过期（TTL 60s，每次写入续期）的行。没有行一律拒绝 |
| 首次发放 | `cmd/writer-lease`（`writer-lease bootstrap <domain>`） | 首次插入；同实例有效行可复用，过期返回 `ErrLeaseExpired`。已有另一实例未撤销行时返回 `ErrLeaseHeld`，即使其已过期；不承担租约转移 |
| 租约接口 | `GET/POST /api/admin/writer-leases` | 当前仅挂载状态读取与发放；旧独立撤租入口未挂载。仓储或 dispatch 中保留撤销代码不等于 HTTP 能调用；转移缺口见 3.3 |
| 实例身份 | `config.WriterInstanceID()` | `CLOUD_INSTANCE_ID` 去空白；空或未设置时是 `axum-<pid>`，每次重启都变。切换涉及的进程必须显式设置 |
| Ozon 写闸 | `internal/seller/ozon`、`internal/platform/config` | `OZON_WRITE_KILL_SWITCH` 为 `1/true/yes/on` 时禁止 Ozon 写入；回环出口和官方绑定传输均检查写闸。配置在启动时读取并注入，改值要重启 |
| 迁移 | `internal/platform/db/migrate.go` | `goose.UpContext(...)`（严格 Up，三个压缩迁移）加 River 迁移。进程启动时**不**自动迁移，迁移是单独一步 |
| 迁移守卫 | `internal/platform/db/migrate_guard_test.go`、`db/migrations.sha256` | 三个基线文件的 sha256 不变，新文件号大于 3 |
| 健康检查 | `GET /api/health` | `DATABASE_URL` 为空时仍返回不可用，可作负载均衡探针 |
| 库地址 | `config.CheckDatabase` | `DATABASE_URL` 只能是回环地址，新旧实例都要在库所在机器或经回环隧道连接 |

---

## 2. shadow：只读镜像比对

目的：核对目标发布对的读行为。预期变化须事先登记；未解释差异阻止进入 canary。

### 2.1 部署

1. 新版 `api` 起一个 shadow 实例，不进负载均衡，只接收镜像流量。
2. shadow 实例的环境：
   - `OZON_WRITE_KILL_SWITCH=1`：Seller 写入在出站闸被拒。
   - `CLOUD_MEDIA_GC_DELETE=0`：对象删除关闭。
   - `CLOUD_INSTANCE_ID=shadow-<版本>`，且**不**为它执行 `writer-lease bootstrap`。所有走 `writer.Assert` 的写入因为没有匹配的租约行被拒绝，返回各调用点既有的「写入未启用」错误。
   - 使用经过验证的只读数据库身份与出口隔离。`default_transaction_read_only=on` 只作额外防误写措施，不能代替权限边界；启动前验证该身份的实际权限和应用兼容性。
3. shadow 期间不启动新版的 worker 进程（`worker-listing`、`worker-sync`、`worker-reconcile`、`worker-media-gc`）。
4. `api` 进程连上库后会启动 `RunBackground`（`internal/app/background.go`）的定时任务：AI 与计费回收、支付对账、错误日志保留、目录抓取调度。必须在部署层隔离其写入和外部副作用，并记录具体失败；不能把所有同名后台错误一律过滤为预期。只读配置能否覆盖全部路径需要执行前验证。

### 2.2 镜像范围

- 只镜像已审查为可安全重放的 `GET` 白名单。方法本身不证明无副作用；`POST/PUT/PATCH/DELETE` 不镜像。
- 镜像在网关做（如 nginx `mirror`、Envoy `request_mirror_policies`），镜像请求的响应丢弃，不影响用户请求的延迟和结果。
- 带会话的 GET 原样转发 Cookie / Authorization。会话的有效性只读判断；如果某个 GET 在旧版会续期或写审计，shadow 侧会因只读事务失败，记为差异并逐条确认，不在 shadow 侧放开写。

### 2.3 比对

- 比对键：方法、路径（含查询串）、主体组织。
- 比对内容：状态码、`Content-Type`、正文字节。头的其余部分只记录不比对。
- 允许的差异必须事先列成清单并说明原因，例如服务端时间戳、请求 id、按当前时间计算的字段。清单之外的任何差异都阻止进入 canary。
- 以 `internal/app/testdata/routes.txt` 的 GET 集合建立逐路由记录：已镜像、隔离测试或未覆盖及原因。schema revision 另跑[专项回归清单](../parity/regression-checklist.md)；该清单不能代表全部 GET 覆盖。

### 2.4 退出条件

- 覆盖的 GET 路由差异为零（清单内除外），持续一个完整业务周期（至少覆盖一次 store_rating_sync 与 error_digest 的周期）。
- shadow 实例日志中没有 panic、没有非预期的 5xx。

---

## 3. canary：按组织放量

### 3.1 读流量

- 网关按会话解析出的组织 id 分流：白名单组织的请求转到新版，其余仍到旧版。白名单放在网关配置里，不进本仓库。
- 放量顺序：内部组织 → 少量真实组织 → 一半 → 全部。每一步至少观察一个业务周期，指标与旧版对比：5xx 比例、p95 延迟、`WRITES_DISABLED` 类错误数。

### 3.2 写流量的约束

写入租约按**域**发放，不按组织。同一个域同一时刻只有一个 `holder_instance` 能写，所以「只给 canary 组织打开写路径」不能直接用现有租约做到。因此 canary 只能先评估读流量，写请求留在旧版；逐域写切换还缺已验证的租约转移流程（见 3.3），读验证通过不能直接进入写切换。新旧版不得共用同一 `CLOUD_INSTANCE_ID` 来绕过互斥。组织级写灰度需要不同设计，本文没有提供该能力。

Ozon 写入另外受 `OZON_WRITE_KILL_SWITCH` 控制。canary 前期新版实例保持 `OZON_WRITE_KILL_SWITCH=1`；准备执行已授权的 Seller 写入时再显式配置并重启，随后复查实例与租约。写闸开启期间不能宣称真实写入验证通过。

### 3.3 租约转移缺口

当前 `internal/admin/http/platform.go` 与 `internal/app/testdata/routes.txt` 只登记 `GET/POST /api/admin/writer-leases`，没有挂载旧的独立撤租端点。`internal/admin/http/dispatch.go` 的残留撤销分支、仓储撤销函数和审计路径不能证明它可经 HTTP 调用。

原方案依赖“排空旧写入 → 按 fence 撤销旧租约 → 发放新租约 → 切流”。该流程现已缺少已挂载的独立撤销入口，不再提供旧端点的请求体或操作步骤。现有发放逻辑会拒绝仍在心跳的其他持有者，`writer-lease bootstrap` 也不承担租约转移；等待过期后是否可安全接管，需要结合真实实例、在途请求、认证与管理租约另行验证，本文不把它当作已可用替代方案。

恢复写切换前，必须形成并验证当前接口支持的完整流程：停止新请求与 worker 认领、排空在途工作、核对 holder/实例/fence、转移授权、恢复和失败处理。特别要验证 `auth` / `admin` 在操作期间的认证与管理可达性。未完成前，canary 写切换与对应回滚均未具备已验证流程；不能用直接写数据库绕过此缺口。

现有接口范围见 [OpenAPI](../../api/openapi.yaml)。该路径的 POST 尚未描述完整请求体，不能仅凭 schema、数据库的 snake_case 字段或残留 handler 的 camelCase 字段生成操作命令；实际调用契约也属于执行前核对项。

### 3.4 worker 切换

worker 进程按 kind 认领 `jobs` 表任务。River 的三个周期任务（`podhub.error_digest`、`podhub.store_rating_sync`、`podhub.store_rating_prune`）由 River 的维护服务入队，只在当选 leader 的客户端上运行，所以两版同时连库也只入队一次；但入队后由哪一版的 worker 执行不确定。切换时先停旧版 worker，再起新版 worker，不并行运行两版同一个 worker，避免同一 kind 被两版各认领一部分。

canary 期间新旧两版 `api` 同时运行，两边的 `RunBackground` 定时任务都会执行。多副本部署 `api` 时这些任务本来就会并行运行；若某个定时任务不能并行，应在 canary 前单独确认，不在本方案里改。

---

## 4. 回滚

### 4.1 原则

- 二进制回退以兼容性实测为前提。迁移守卫只保证已合入文件没有被修改，不保证旧程序能使用新 schema。删除函数签名、列或改变权限的迁移都可能阻止回退；基线 schema 已删除旧履约函数签名，不能直接套用早期“只换二进制”假设。
- 迁移不提供回滚，也不证明变更可逆；压缩后的严格 `Up` 只在版本高于已记录最大值时追加文件。

### 4.2 回滚方案的必要条件

当前缺少 3.3 所述的完整租约转移验证，不能把“反向转移”列成可执行命令。发布前的回滚演练至少需要证明：

- 可以停止新写入与 worker 认领并处理在途工作；
- 旧二进制兼容当前数据库，或已有经验证的数据恢复/前向修复方案；
- 可以通过当前受支持入口恢复每个写域的持有者、实例与 fence，认证与管理链不中断；
- 恢复流量后读写和账本一致，新版下线前保持外部写闸关闭。

这些条件尚未验证齐全，不应启动依赖该回滚能力的写切换。

### 4.3 回滚触发条件

- canary 组织的 5xx 比例或 p95 延迟明显高于旧版并持续一个观察窗口。
- 出现 shadow 清单之外的响应差异。
- 任一写域出现审计行 lease id / fence 与预期实例不符。

---

## 5. 待确认与缺口

- 旧独立撤租端点已不挂载，现有发放入口的完整操作契约和转移/恢复流程未验证（3.3）；这是写切换与回滚的前置缺口。
- API 启动不自动迁移；本地开发已有 `scripts/devmigrate/main.go`，由 `scripts/dev-api.sh` 调用。生产迁移由谁、在什么窗口执行以及失败如何恢复，仍需随部署方式确定。
- 网关的镜像、按组织分流、按方法分流都在本仓库之外，选型由部署方决定。
- 写入不经过 `writer.Assert` 的路径（例如只设置租户会话就写的仓储）不受租约保护；shadow 必须验证数据库权限和出口隔离确实阻断副作用，写切换前还要明确这些路径的停写与恢复方式。
