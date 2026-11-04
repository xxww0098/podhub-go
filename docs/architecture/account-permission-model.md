# 账号与权限模型

2026-10-24 静态复核。原 `00360`–`00365` 与 `00367` 的改动已并入基线 schema 并有实现；原 2026-10-21 提案的“待拍板”、六周兼容窗口和固定后续迁移号不再描述当前代码。本文保留权限边界、实现与原提案的差异、以及仍需验证的发布条件。

原审查基线为 `6c8acbc6d836cdd9ab87fcfc616668d15fd3cc16`。本次核对迁移、关键处理器和测试源码，未运行数据库测试、未普查生产数据，也不据代码存在宣称生产权限链路已通过。当前行为以源码为准，产品能力准入另见 [技术验证清单](../precision-listing-verification.md)。

## 1. 角色模型

角色只在三个作用域定义：平台、组织工作空间、工厂工作空间。每个账号在每个作用域只有一个角色；履约与商品负责人是源级授权，不是角色。

| 作用域 | 角色 | 存储 |
| --- | --- | --- |
| 平台 | `super_admin` / `admin` / `user` | `account_users.role`；`account_kind='supplier'` 的账号固定 `user` |
| 工作空间 | `owner` / `manager` / `member` | `organization_members.role` |
| 工厂工作空间 | `member` | `sc_factory_members` 成员行；可登录工厂入口，可读所绑定商品库目录，履约操作需另授权 |

- 工厂工作空间不复制 `organizations` 的 `owner` / `manager` / `member`：工厂和首个账号由平台超级管理员开通，不能自助注册，工厂侧没有成员管理入口，只有 `member`。
- 履约授权 `sc_source_fulfillers` 按来源授予；一个来源最多一个 active。它决定谁能接单、拒单、发货；没有授权的工厂成员登录后看到等待状态，不是工厂角色。
- 商品负责人 `sc_catalog_managers` 按来源授予平台账号；一个来源可有多个负责人，不是工厂角色。
- 授权行引用 `account_users`，撤销后保留行和审计字段。不能依赖会被删除的 `sc_factory_members` 行承载历史包的收件人。

不新增 `can_view_global` 来扩大跨租户观察权限；该提案没有为普通账号提供全平台观察授权。

### 1.1 角色规则收敛（2026-11-02）

工作空间角色统一在 `internal/identity/contract/workspace.go` 定义，直接使用数据库的 `owner` / `manager` / `member`。解析会去除首尾空白并转为小写；不再接受工作空间 `admin` 别名、`operator`、`reviewer` 或 `viewer`。未知值和零值不授予权限，不降级为可读用户。

| 操作 | owner | manager | member |
| --- | --- | --- | --- |
| 修改资料、解散工作空间 | 可以 | 不可以 | 不可以 |
| 邀请、移除他人 | manager、member | member | 不可以 |
| 调整他人角色 | manager ↔ member | 不可以 | 不可以 |
| 退出工作空间 | 不可以，须解散 | 可以 | 可以 |
| 店铺可见范围 | 全部 | 全部 | 仅指派店铺 |
| 新增、分配店铺及绑定、轮换、清除或导出店铺密钥 | 可以 | 可以 | 不可以 |

不能移除自己或 owner。店铺的旧指派人密钥开关不再授予权限；历史值不影响新的角色判断。旧浏览器直发密钥接口只允许所有者和管理员，员工上架使用服务端队列。上架、订单与自动化先验证有效成员，再检查店铺指派、具体授权及业务状态；平台管理员身份不会绕过工作空间成员检查。公共目录自动化授权直接检查 `catalog` 范围，不借用虚构的 `viewer` 角色。

平台管理员闸门统一复用 `identity/contract`；账号创建、改角色与最后一个超级管理员保护仍由 `admin/users/contract` 的实际账号管理规则处理。删除未被业务调用的旧角色代数、29 项工作空间能力矩阵及转发导出，保留实际入口需要的判断。

管理页面与平台设置统一使用 `/admin` 地址；管理接口统一使用 `/api/admin/...`。类目抓取配置位于 `/api/admin/catalog/fetch-config`，商品库识图测试位于 `/api/admin/ai/ocr-tests/{id}`，旧路径不注册。工作空间 `owner` / `manager` / `member` 不授予平台管理权限。路由表明确区分 `admin` 可用操作与 `super_admin` 专属操作，替换处理器也必须先通过路由鉴权。

现有 schema 已限制工作空间为这三个角色，因此本次不新增数据库迁移，不改写角色数据。

## 2. 实现落点

数据库侧以基线 `db/migrations/00002_schema.sql`（head 的 `pg_dump --schema-only`）为准；`00027` 删除旧来源成员角色列，`00040` 将成员迁到独立工厂，让成员行本身成为工厂角色。下表按 schema 对象定位。

| 位置 | 作用 |
| --- | --- |
| `account_users.account_kind` 等列与 CHECK | 账号用途、强制改密标志、供应商不得成为管理员的约束、大小写无关邮箱唯一索引 |
| `sc_factories` / `sc_factory_members` / `sc_sources.factory_id` | 工厂、成员与商品库绑定；一家工厂可绑定多个商品库 |
| `sc_source_fulfillers` / `sc_catalog_managers` | 来源级履约及商品维护授权；不是角色 |
| `delegate_dispatches.fulfiller_id` | 包固定履约人、驳回闩改为履约人、派单阻塞原因 |
| 派单与结算策略 | 履约人范围；不含供应商钱包、流水和提现的 self 策略；残留资金守卫 |
| `delegate_*` 动作函数与 ACL | 动作函数签名、锁前后复检、受限结算入账函数 |
| 六张 `sc_*` 目录表的 RLS | 区分公开商品、供应成本与平台售价 |
| 履约来源卡片与派单报价 | 不依赖旧来源成员关系；不扩大目录及资金表权限 |
| `internal/identity/middleware.go` | 强制改密的精确方法与路径白名单 |
| `internal/suppliercatalog/http/handler.go` | 商品负责人接口 `/api/supplier-catalog` |

这些对象不是部署回执。新的权限变更必须写成基线之后的追加迁移，并从实际迁移目录和清单取号（基线最高号为 `00003`）。

## 3. 数据约束

### 3.1 账号

数据库 CHECK 保证 `account_kind='supplier'` 时 `role='user'`。基线 schema 只把 `target='/supplier' AND role='user'` 的行回填为供应商；用途与管理员角色冲突、大小写重复邮箱会中止迁移，不能静默猜测或合并账号。

`00009` 补的账号与授权约束：

- `role` 只能是 `user` / `admin` / `super_admin`。Go 侧按去空白、小写比较，SQL 过去按原样比较，`Super_Admin` 能通过管理员闸门却绕开唯一超级管理员索引。迁移把现存值规整为小写。
- 邮箱不得带首尾空白，必须是 `x@y.z` 形态；`public_id`、`uuid` 唯一；密码哈希不得为空白。
- 代理归因绑定后，邀请人、时间、费率、来源四列整体只读，清空也算改写。
- `account_kind` 创建后不可改。
- `account_sessions.user_id` 外键并级联删除，`token_hash` 与 `auth_email_tokens.token_hash` 必须是 64 位小写十六进制，原始令牌写不进去。迁移删除不满足的会话与重置令牌，只会让持有者重新登录。
- 平台和工厂账号均可用当前密码申请更换登录邮箱；新邮箱收到的一次性链接有效 30 分钟，确认前原邮箱不变。确认后撤销全部会话和未完成的找回、换绑链接，并按新旧邮箱调整待处理邀请。发送复用密码找回的 SMTP 配置与持久化发件箱；邮件未配置时返回不可用，不修改邮箱。
- `organizations.owner_user_id`、`organization_members`、`org_invitations` 补外键。成员行不能换工作空间或换账号。邀请角色只能是 `manager` / `member`，已接受、已撤销、已拒绝至多一个。

### 3.2 履约人与商品负责人

履约人表的 `(source_id) WHERE status='active'` 唯一索引表达“最多一个”，不保证每个来源都有履约人。无 active 成员的来源不会被自动补人。

`sc_factory_members` 的成员行即工厂成员角色；同一工厂可以有多个成员，也可以绑定多个商品库。每个商品库的履约账号由对应 active 授权唯一确定。停用或解绑成员时仅撤销该工厂各商品库的有效履约授权，保留历史派单权限规则。

`sc_factory_members`、`sc_source_fulfillers` 要求供应商账号，`sc_catalog_managers` 要求平台账号，由 INSERT 触发器在 SQL 层检查；过去只有 Go 的 `grantableAccount` 检查。成员行不能改 `factory_id` / `user_id`；授权行不能改 `source_id` / `user_id`，只能经 `status` 撤销与恢复。迁移时已有不合规行会让迁移失败，不做静默修复。

`support_grants` 的 `staff_user_id` 必须是未停用的平台 `admin` / `super_admin`，签发人必须是未停用的 `super_admin`，有效期不超过创建后 25 小时（API 上限 24 小时，加时钟偏差余量）。已签发的授权只能缩短有效期或撤销，不能延期、改原因、改目标、取消撤销。

授权撤销写 `disabled` 与撤销人/时间，保留主键。包使用 `(source_id, fulfiller_id)` 复合外键防止指向别的来源；`fulfiller_id` 可空，空值需要人工处置。

### 3.3 派单状态

`dispatch_blocked_reason` 使用 `no_fulfiller` / `ambiguous_fulfiller` 表达无法确定收件人，不新增订单状态。`last_rejected_fulfiller_id` 将驳回限制绑定到具体履约人，避免换人后仍被旧 source 级闩永久阻塞。

## 4. 身份与认证

### 4.1 账号用途

账号用途从持久化 `account_kind` 读取，不能用页面路径、`target` 或 `supplier_id` 推断权限。平台管理员资格仍须独立检查平台角色；有工作区或有来源成员关系都不等于管理员。

身份查询通过 `db.InTx(..., db.AppRole(), ...)` 设置事务局部应用角色；`withQueries` 与审计事务共用此边界。密码计算、验证或外部操作不能放在该数据库回调内。角色恢复仍需用实际应用连接验证，不能仅因调用了事务包装就推定生产连接权限正确。

### 4.2 强制改密

`allowWhileLocked` 对已解析出的锁定会话仅放行以下方法与路径：

| 方法 | 路径 |
| --- | --- |
| POST | `/api/auth/login` |
| POST | `/api/auth/logout` |
| GET | `/api/auth/session` |
| POST | `/api/auth/password` |
| GET | `/api/health` |

其余请求返回 `PASSWORD_CHANGE_REQUIRED`。匹配必须同时约束方法和完整路径；静态资源不是本 API 的路由，CSRF 由前置中间件处理，不能把“静态资源 / 预检”当作第六条模糊通配规则。

### 4.3 供应商账号创建

`internal/admin/supplier/repo/accounts.go` 的 `provision` 要求超级管理员。新号写 `account_kind='supplier'`、`must_change_password=true`；已有平台邮箱、管理员邮箱或停用账号被拒绝复用。`lower(email)` 唯一索引同时约束并发创建。

## 5. HTTP 边界

- 供应商商品库价格入口 `POST /api/admin/supplier-dbs/{source_id}/rows/{product_id}/price` 已使用 `GuardSuper`。
- 履约人、商品负责人授权管理位于 `/api/admin/supplier-dbs/{source_id}/...`，使用 `GuardSuper`。
- 商品维护独立挂在 `/api/supplier-catalog`，不使用原提案的 `/api/catalog/*`。后者已有其他类目语义，不能混用。
- 供应商门户不再挂钱包和提现三条接口；底层策略也必须同时限制，卸载路由本身不构成数据库隔离。

## 6. RLS 与定义者函数

### 6.1 当前策略边界

| 数据 | 当前策略 |
| --- | --- |
| 目录六表 | ENABLE + FORCE RLS；staff 读写，商品负责人按 active 来源授权 |
| 来源、商品、SKU、售价 | 按各表的 `listed` / `published` 条件提供共享参考读取；另有供应商来源成员和卖家绑定读取。公开读不授予写权 |
| `sc_source_offers` | 没有通用公开读；staff、本来源供应商成员、被授权商品负责人可读。负责人有 SELECT / INSERT / UPDATE，没有 DELETE |
| `sc_price_versions` | 商品负责人只读；平台售价写入走平台权限 |
| `delegate_dispatches`、`delegate_settlements` | 供应商按包固定的履约人只读，撤销授权仍保留本人历史读取。供应商会话没有写策略，状态只经动作函数变化（`00009`） |
| `supplier_wallets`、`supplier_wallet_ledger`、`supplier_withdrawals` | 删除供应商 self 策略，保留平台处理路径 |

不能把“任意 org GUC 已设置”当目录授权。公开货盘是共享参考数据，厂家成本不是；旧提案按派单 source 给卖家读取整厂成本的方案已被否定。供应商结算所需报价通过 `supplier_dispatch_quote(dispatch_id)` 受限读取，不要求向履约人开放 `sc_source_offers`。

`sc_factory_members` 的供应商自隔离策略只剩 SELECT（`00009`）。此前同一条策略覆盖全部命令，供应商会话可以给自己写任意来源的成员行，或把自己被停用的成员行改回 active。授权只由 staff 策略写入。

`account_credentials` 只有 `sync_account_side_tables()` 一个写入口：该触发器改为 SECURITY DEFINER，`podhub_app` 与 `podhub_worker` 失去对该表的 INSERT / UPDATE / DELETE，两个角色也不能 DELETE `account_users`、`organizations`、`support_grants`。账号只停用，工作空间只解散，支持授权只保留为证据。

### 6.2 会话

`db.CatalogManager(userID)` 使用 `app.current_org_user_id`，值是账号 ID，不是组织 ID。不得复用提供平台观察权限的 `db.Catalog()`，也不得通过放宽 admin guard 给普通商品负责人设置 `staff_access`。

### 6.3 SECURITY DEFINER

改变函数参数列表时必须删除旧签名，否则旧重载仍可调用。基线 schema 对新签名逐个撤销 PUBLIC EXECUTE 并授权应用角色，动作函数在加锁前后检查同一履约人身份与 active 状态。`delegate_supplier_accept` / `reject` / `ship` 另在入口校验调用者：`p_supplier_user_id` 必须等于 `app.current_supplier_user_id`，或会话带 `app.staff_access = '1'`（`00009`）。此前任何 `podhub_app` 会话传入别人的用户 ID 与履约人 ID 就能接单、发货。检查必须用 `COALESCE(..., false)` 包住：GUC 未设置时比较结果是 NULL，plpgsql 的 `IF` 不会执行。

这三个函数与其余 `delegate_*` / `supplier_*` 定义者函数的 `search_path` 改为 `public, pg_temp`，临时模式排在最后。

定义者函数不能依赖外层 RLS 代替自身校验。类似地，具有 BYPASSRLS 的 worker 或高权连接不受普通 app 策略保护；新增调用路径需要重新检查实际角色、GUC 与函数权限，不能沿用历史“只有一处 worker 调用”的计数。

两个只读定义者函数同样撤销 PUBLIC EXECUTE，仅授予 `podhub_app`：

- `supplier_fulfiller_sources()` 仅返回当前 `app.current_supplier_user_id` 的来源卡片。active 授权可以进入；disabled 授权须仍有固定到该授权和来源的历史包。它不要求 `sc_factory_members`。
- `supplier_dispatch_quote(dispatch_id)` 只汇总固定给该用户的包，返回行数、缺成本行数和总分值。成本来自包来源与 SKU 的匹配供货记录，不返回逐行成本；撤权后仍可读取本人旧包的汇总。无匹配包时聚合为零，不授予动作权限。

门户 `Me`、包列表、详情、下载及动作入口使用前者；列表结算信息、接单冻结与结算使用后者。动作仍须通过动作函数里的 active 履约人复检，不能以“能看到来源卡片或报价”代替授权。

## 7. 固定收件人与历史包

### 7.1 派单

新包绑定具体履约人；同来源新加入的成员不能仅凭成员关系接管旧包。撤权结束动作权限，但不抹掉已固定包的读取归属。

### 7.4 历史包

基线回填按每个来源最早的 active 成员建立履约授权，再把该来源尚无履约人的旧包挂到这条授权上。**这是确定性的迁移归属选择，不是恢复了历史真实收件人。** 发布前必须核对业务是否接受这一映射。

回填后仍为 NULL 的包没有供应商读取或动作授权，由 staff 处置。原提案的六周 source 级只读过渡臂没有实施，不安排删除该臂的后续迁移。

## 8. 商品负责人

### 8.1 独立入口

商品维护不能复用会设置 staff 豁免的管理端事务；独立接口按账号和来源授权，避免一次 guard 放宽将全平台数据暴露给普通账号。

### 8.2 能力边界

负责人可维护授权来源的商品、SKU 和供货成本；商品库上架、下架和平台售价配置仅限超级管理员。发布规格时自动启用所属来源的 `listed`，不再提供独立的卖家可见设置。负责人不能通过归档或删除已发布商品绕过下架限制，也不可管理授权、读取供应商钱包或提现。触发器限制负责人改变 `sc_sources.listed` 与 `accepts_delegate`，价格历史仅给 SELECT。RLS 约束还须配合 HTTP 校验与输出字段检查，不能仅凭表策略推断任意 DTO 安全。

## 9. 资金边界

### 9.1 不开放钱包管理

供应商没有钱包、流水和提现的直接访问权限，但其本人派单对应的结算仍有受限读取，履约动作仍可能触发冻结和结算。因此不能把本模型概括为“供应商会话读取不到任何资金相关行”。

### 9.2 残留必须人工清算

原迁移遇到 `supplier_wallets.balance_microfen != 0` 或 `supplier_withdrawals.status='requested'` 就报错中止。部署前需逐厂核对、清算并保留记录；迁移不能把负债自动清零。本次未查询这些生产数据。

### 9.3 履约结算

动作授权必须先于资金变化。动作函数 `delegate_credit_fulfiller_wallet` 从结算行取金额，以 dispatch 为幂等键入账，并重新校验调用方为 staff 或包固定的履约人；它不是允许客户端自行指定金额的钱包接口。权限判断将未设置的 staff GUC 视为 false（`COALESCE(..., false)`）；否则 SQL 的 `NULL OR false` 仍为 NULL，PL/pgSQL 的 `IF NOT (...)` 不会进入拒绝分支。

## 10. 迁移与发布条件

### 10.2 发布前检查

- 非空库检查账号用途冲突、大小写重复邮箱、来源成员映射、NULL 包、余额和待审提现。
- 同时更新所有调用新函数签名的运行时；旧签名已删除，不能假设只换回旧二进制就可回滚。
- 对受限真实应用角色运行权限测试，检查实际 ACL、FORCE RLS、GUC 与事务结束后的角色恢复。
- 已有迁移和清单按仓库守卫执行；新工作从当前目录取号，不使用历史文档预留号。

## 11. 验证证据与限制

### 11.4 商品管理

实现与测试源码可以证明检查存在，不能证明生产角色、迁移和外部业务已验证。原提案中“测试都还不存在”的说法已过期。

### 11.6 已有测试入口

| 文件 | 覆盖内容 |
| --- | --- |
| `internal/identity/contract/access_test.go` | 三角色边界、非法角色拒绝、邀请/移除/改角色矩阵、平台角色与工作空间隔离 |
| `internal/automation/domain/rules_test.go` / `internal/mcp/domain/catalog_test.go` | 自动化及 MCP 不接受旧角色或未知角色，目录范围独立授权 |
| `tests/integration/workspace_invitations_test.go` / `workspace_lifecycle_test.go` | 邀请、成员管理、角色调整、资料维护及解散的真实数据库链路 |
| `internal/identity/gate_test.go` | 精确改密白名单、拒绝响应、CSRF 顺序、会话字段 |
| `tests/integration/account_permission_test.go` | 供应商不能提升、钱包隔离、PUBLIC 函数 ACL、目录 FORCE RLS、固定收件人 |
| `tests/integration/fulfiller_wallet_test.go` | 受限供应商会话的结算入账与陌生调用方拒绝 |
| `tests/integration/catalog_manager_test.go` | 商品负责人跨来源隔离 |
| `tests/integration/catalog_cost_test.go` | 无相应授权会话无法读取厂家成本 |
| `tests/integration/catalog_manager_scope_test.go` | 平台标志不可改、offer 可新增不可删、不能凭一个派单读全厂成本 |
| `tests/integration/supplier_fulfiller_access_test.go` | 无旧成员关系的履约入口、撤权保留旧包、跨人包隔离、汇总报价不开放成本/资金表、缺成本回滚 |

2026-10-24 复核只检查测试源码，未运行；2026-11-02 角色收敛的运行结果另见 [角色权限核查](../role-permissions-check.md)。`TestSupplierSessionReadsNoFunds` 的结算样例是未分配履约人的包，不能用该测试名推导“本人 pinned settlement 也不可读”。

## 12. 决策状态

实现采用单 active 履约人、拒绝平台邮箱复用、残留资金人工清算硬门；没有采用六周兼容臂。相关决策索引见 [decisions.md](../decisions.md)。代码采用某选项不等于生产清算、迁移归属或上线验收已完成。

## 13. 尚未验证

生产存量、实际部署版本、非空库迁移与回滚演练、全部权限调用方及 worker 绕过面，本次均未验证。尤其旧包回填只按当前成员排序，不能还原历史真实归属；必须在发布检查中明确处理。
