# 发布切换方案：shadow / canary / 回滚

本文只是方案（优化计划 OPT-22），不改代码、配置和迁移。依据是 `main` 的 `27b6a73`。文中「旧版」「新版」都指本仓库 Go 程序的两个发布版本。

约定：

- 不新增开关。Ozon 写入只用现有的 `OZON_WRITE_KILL_SWITCH` 关闭，对象删除只用现有的 `CLOUD_MEDIA_GC_DELETE` 关闭，解析和语义不变（`internal/platform/config/config.go` 的 `isTruthy`、`mediaDeleteEnabled`）。
- 迁移只追加，Down 是 `SELECT 1`。回滚只换二进制，不回退库。
- 路由、JSON 字段、错误码、队列 kind 不改名。切换期间不合入改这些的 PR。

---

## 1. 现有机制（切换依赖的事实）

| 机制 | 位置 | 对切换的意义 |
| --- | --- | --- |
| 写入租约 | `internal/platform/writer/lease.go` | 每个写域（`auth`、`admin`、`billing`、`entitlement`、`telemetry` 等，以 `rg 'writer.Assert\(' internal` 为准）同一时刻只有一条未撤销的 `writer_leases` 行。`Decide` 只放行 holder 为 `axum`、`holder_instance` 等于本进程 `CLOUD_INSTANCE_ID` 且未过期（TTL 60s，每次写入续期）的行。没有行一律拒绝 |
| 首次发放 | `cmd/writer-lease`（`writer-lease bootstrap <domain>`） | 只插入第一条行。已有另一实例的未撤销行时返回 `ErrLeaseHeld`，**不判断是否过期**，没有撤销子命令 |
| 租约转移 | `GET/POST /api/admin/writer-leases`、`POST /api/admin/writer-leases/revoke`（`internal/admin/repo/leases.go`） | 超级管理员按 `expectedFence` 撤销、发放，写 `writer_lease_events` 与审计行。转移用这组接口（3.3） |
| 实例身份 | `config.WriterInstanceID()` | `CLOUD_INSTANCE_ID` 去空白；空或未设置时是 `axum-<pid>`，每次重启都变。切换涉及的进程必须显式设置 |
| Ozon 写闸 | `internal/platform/egressgate/ozon.go` | `OZON_WRITE_KILL_SWITCH` 为 `1/true/yes/on` 时 `AllowWrite` 返回 `ErrWritesDisabled`。只在进程启动时读一次，改值要重启 |
| 迁移 | `internal/platform/db/migrate.go` | `goose.UpContext(..., WithAllowMissing())` 加 River 迁移。进程启动时**不**自动迁移，迁移是单独一步 |
| 迁移守卫 | `internal/platform/db/migrate_guard_test.go`、`db/migrations.sha256` | 已合入迁移的 sha256 不变，新文件号大于基线最大号 |
| 健康检查 | `GET /api/health` | `DATABASE_URL` 为空时仍返回不可用，可作负载均衡探针 |
| 库地址 | `config.CheckDatabase` | `DATABASE_URL` 只能是回环地址，新旧实例都要在库所在机器或经回环隧道连接 |

---

## 2. shadow：只读镜像比对

目的：新版在真实读流量上的状态码和正文字节与旧版一致，才进入 canary。

### 2.1 部署

1. 新版 `api` 起一个 shadow 实例，不进负载均衡，只接收镜像流量。
2. shadow 实例的环境：
   - `OZON_WRITE_KILL_SWITCH=1`：Seller 写入在出站闸被拒。
   - `CLOUD_MEDIA_GC_DELETE=0`：对象删除关闭。
   - `CLOUD_INSTANCE_ID=shadow-<版本>`，且**不**为它执行 `writer-lease bootstrap`。所有走 `writer.Assert` 的写入因为没有匹配的租约行被拒绝，返回各调用点既有的「写入未启用」错误。
   - 库连接使用只读事务默认值（连接串加 `options=-c default_transaction_read_only=on`）。不走租约的写入也会失败，失败本身就是一条差异。
3. shadow 期间不启动新版的 worker 进程（`worker-listing`、`worker-sync`、`worker-reconcile`、`worker-media-gc`）。
4. `api` 进程连上库后会启动 `RunBackground`（`internal/app/background.go`）的定时任务：AI 与计费回收、支付对账、错误日志保留、目录抓取调度。shadow 实例上它们会因只读事务失败并打 `slog.Error`，属预期，不计入差异；比对时按日志消息过滤掉这几类。

### 2.2 镜像范围

- 只镜像 `GET`。`POST/PUT/PATCH/DELETE` 一律不镜像。
- 镜像在网关做（如 nginx `mirror`、Envoy `request_mirror_policies`），镜像请求的响应丢弃，不影响用户请求的延迟和结果。
- 带会话的 GET 原样转发 Cookie / Authorization。会话的有效性只读判断；如果某个 GET 在旧版会续期或写审计，shadow 侧会因只读事务失败，记为差异并逐条确认，不在 shadow 侧放开写。

### 2.3 比对

- 比对键：方法、路径（含查询串）、主体组织。
- 比对内容：状态码、`Content-Type`、正文字节。头的其余部分只记录不比对。
- 允许的差异必须事先列成清单并说明原因，例如服务端时间戳、请求 id、按当前时间计算的字段。清单之外的任何差异都阻止进入 canary。
- 每个路由（`internal/app/testdata/routes.txt` 中的 GET 行）至少命中一次才算覆盖。未命中的路由在 canary 前用回归清单（`docs/parity/regression-checklist.md`）手工补一次。

### 2.4 退出条件

- 覆盖的 GET 路由差异为零（清单内除外），持续一个完整业务周期（至少覆盖一次 store_rating_sync 与 error_digest 的周期）。
- shadow 实例日志中没有 panic、没有非预期的 5xx。

---

## 3. canary：按组织放量

### 3.1 读流量

- 网关按会话解析出的组织 id 分流：白名单组织的请求转到新版，其余仍到旧版。白名单放在网关配置里，不进本仓库。
- 放量顺序：内部组织 → 少量真实组织 → 一半 → 全部。每一步至少观察一个业务周期，指标与旧版对比：5xx 比例、p95 延迟、`WRITES_DISABLED` 类错误数。

### 3.2 写流量的约束

写入租约按**域**发放，不按组织。同一个域同一时刻只有一个 `holder_instance` 能写，所以「只给 canary 组织打开写路径」不能直接用现有租约做到。可选做法：

| 做法 | 说明 | 结论 |
| --- | --- | --- |
| a) canary 只放读，写按域整体切 | canary 组织的写请求仍由网关转到旧版（按方法分流）。读的 canary 走完后，逐个域把租约从旧版实例转到新版实例（见 3.3），每转一个域观察一个周期 | **推荐**。租约的互斥保证不变 |
| b) 新旧版共用一个 `CLOUD_INSTANCE_ID` | 两个进程都能通过 `Decide`，可以按组织分流写 | 不推荐。等于关闭了租约对新旧双写的防护，只在单域、短窗口、人工值守时考虑 |
| c) 给租约加组织维度 | 需要改 `writer_leases` 与 `Decide` | 本方案不做，若要做需单独立项和迁移 |

Ozon 写入另外受 `OZON_WRITE_KILL_SWITCH` 控制。canary 前期新版实例保持 `OZON_WRITE_KILL_SWITCH=1`；某个域的租约转到新版并观察无异常后，再去掉新版实例的该变量并重启。

### 3.3 租约转移（逐域）

租约的发放与撤销走已有的超级管理员接口（`internal/admin/http`，`GuardSuper`），每次操作都写 `writer_lease_events` 和审计行：

- `GET /api/admin/writer-leases`：查看各域当前的 holder、实例和 fence。
- `POST /api/admin/writer-leases/revoke`，body `{"domain", "reason", "expectedFence"}`：撤销该域的未撤销行。`expectedFence` 与当前 fence 不一致时返回冲突，不做修改。
- `POST /api/admin/writer-leases`，body `{"domain", "holder", "holderInstance", "reason", "expectedFence"}`：发放新行。另一实例的行仍在心跳时返回冲突（「revoke and drain first」）。

`writer-lease bootstrap` 遇到另一实例未撤销的行（即使已过期）会返回 `ErrLeaseHeld`，所以转移不用它。转移步骤：

1. 网关停止把该域的写请求发给旧版（或旧版实例设 `OZON_WRITE_KILL_SWITCH=1` 并重启，覆盖 Seller 写入部分）。
2. `GET /api/admin/writer-leases`，记下该域的 fence `F`，确认 `holderInstance` 是旧版实例。
3. `POST /api/admin/writer-leases/revoke`，`expectedFence: F`。撤销后旧版对该域的写入立即被 `Decide` 拒绝，不需要等租约过期。
4. `POST /api/admin/writer-leases`，`holder: "axum"`，`holderInstance` 填新版 `api` / worker 的 `CLOUD_INSTANCE_ID`，不带 `expectedFence`（此时该域没有未撤销行）。
5. 网关把该域写请求转到新版，确认写入返回成功、审计行带上新的 lease id 和 fence。

第 3 步与第 4 步之间该域没有写入者，写请求返回「写入未启用」。两次调用间隔按秒计，选低峰执行。`auth` 域的发放和撤销还会取 `writer.AuthGateKey` 共享锁，与认证写入互斥，不需要额外处理。

### 3.4 worker 切换

worker 进程按 kind 认领 `jobs` 表任务。River 的三个周期任务（`podhub.error_digest`、`podhub.store_rating_sync`、`podhub.store_rating_prune`）由 River 的维护服务入队，只在当选 leader 的客户端上运行，所以两版同时连库也只入队一次；但入队后由哪一版的 worker 执行不确定。切换时先停旧版 worker，再起新版 worker，不并行运行两版同一个 worker，避免同一 kind 被两版各认领一部分。

canary 期间新旧两版 `api` 同时运行，两边的 `RunBackground` 定时任务都会执行。多副本部署 `api` 时这些任务本来就会并行运行；若某个定时任务不能并行，应在 canary 前单独确认，不在本方案里改。

---

## 4. 回滚

### 4.1 原则

- 只换二进制，不回退库。迁移只追加、Down 是 `SELECT 1`；旧版二进制必须能在新库结构上运行，这要求本序列的迁移只加表、加列（有默认值或可空）、加索引，不改、不删旧版在用的列。迁移守卫保证已合入的迁移文件不变。
- 迁移号乱序（优化计划 Q1）已由 `WithAllowMissing` 处理：回滚后再前滚，低于已记录最大号的未执行迁移会被补跑，不会因 missing migrations 启动失败。

### 4.2 步骤

1. 网关把读写流量切回旧版（canary 白名单清空）。
2. 新版持有的每个域按 3.3 反向转移：按当前 fence 撤销，再把 `holderInstance` 发放给旧版实例。
3. 停新版 worker，起旧版 worker。
4. 新版实例保留 `OZON_WRITE_KILL_SWITCH=1` 直到下线，防止残留请求写 Ozon。

### 4.3 回滚触发条件

- canary 组织的 5xx 比例或 p95 延迟明显高于旧版并持续一个观察窗口。
- 出现 shadow 清单之外的响应差异。
- 任一写域出现审计行 lease id / fence 与预期实例不符。

---

## 5. 待确认与缺口

- 租约转移依赖超级管理员接口（3.3）。管理员接口正在按主题拆分（D10），拆分后路径若有变化，需同步本文 3.3。
- 进程启动不自动迁移，仓库里也没有迁移的命令行入口。发布时谁调用 `db.Migrate`、在新版 `api` 启动前还是后执行，需要和部署方式一起定。
- 网关的镜像、按组织分流、按方法分流都在本仓库之外，选型由部署方决定。
- 写入不经过 `writer.Assert` 的路径（例如只设置租户会话就写的仓储）在 shadow 期间只靠只读事务挡住；canary 写切换前需要列出这些路径并确认它们归属哪个域。
