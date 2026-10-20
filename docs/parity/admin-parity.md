# admin 对拍

层级：L6。`internal/admin/http` 按供应商、平台目录、平台管理分文件。它不是第二个 `httpapi`：chi `Mount` 只注册这三组。全局禁用标签 4 条仍在 `internal/platform`（GET 在生成路由，写在 `MountBannedWrites`），本包的 `Routes` 不含 `banned-tags`。

T-A1 改了供应商 41 条里规格已经写全请求、SQL 和成功 JSON 的路由。没有改 `internal/supplier`。T-A2 改平台目录、采购、物流、Seller 中转、代理管理和委托单读接口。账单与观察见 `docs/parity/admin-billing-parity.md`。用户与 AI 鉴权见 `docs/parity/admin-users-ai-auth-parity.md`。官方字段包、类目提示词、类目视频和媒体见 `docs/parity/adminb-misc-parity.md`。委托派发、收货、取消，以及物流 reconcile / safe-continue 已按 X2 规格实现。

证据来源：`internal/admin/http` 的路由表，加上 v0.0.112 导出的 `spec-adminA*.md`。守卫分类：

| 盘点原文 | 本 PR |
|---|---|
| `super_admin` | `domain.SuperAdmin`，拒绝文案与 `access.MsgSuperAdmin` 相同：「需要超级管理员权限」 |
| `platform staff（admin/super_admin）` | `domain.PlatformStaff`：`admin` 或 `super_admin`（`access.Principal` 注释里的平台角色名） |
| `路径推断` / `需核对` | 失败闭合为 super_admin |
| `require_price_publisher` | 失败闭合为 super_admin |
| 工作区会话 | `org_id == 0` 拒绝，文案与 `access.MsgNoWorkspace` 相同 |
| 登录会话 | 任意已解析 principal，不要求 org |

Rust 仓库克隆 404。账单与观察按随任务附带的规格移植，见 `docs/parity/admin-billing-parity.md`。供应商货源、厂家账号、提现、提示词列表和自动化授权按规格实现。成功体是 `{"data":...}`。货源 / 提示词错误码是大写（`VALIDATION`），厂家门户错误码是小写（`validation`），自动化是大写且没有 `WRITES_DISABLED`。货源、存储、提示词成功响应带 `Cache-Control: private, no-store` 和 `Vary: Cookie, Authorization`。

## 已挂上的行为

157 条都已注册。未登录 401。守卫失败 403。

用户目录、席位、解散、support grant、writer lease、AI 账本、价格、探测、连接配置和验证器这 25 条已按上传的 adminB 规格实现，见 `docs/parity/admin-users-ai-auth-parity.md`。平台目录、采购、物流预设、中转文件和代理管理在超级管理员完成 TOTP 与 15 分钟 step-up 之后走已实现的 SQL。官方字段包、类目提示词、类目视频和媒体管理这 18 条见 `docs/parity/adminb-misc-parity.md`。账单、兑换码、支付配置、钱包、平台观察和错误日志见 `docs/parity/admin-billing-parity.md`。供应商已实现的路由见下面的逐项登记。原先 501 的 22 条供应商存储、货源行、Ozon 配置和提示词写路径已按上传规格接上。委托三条写和物流 reconcile / safe-continue 已实现。

供应商门户的员工拒绝是「需要平台管理员权限」。其余 legacy 路由的员工拒绝正文仍是 `forbidden` / `FORBIDDEN`。

## 与 Rust 对比的测试

```
go test ./internal/admin/... ./tests/archtest/ -count=1
```

`TestAdminGuards` 覆盖：超级管理员打提现支付在未接线时得到 500 `internal`；平台 `admin` 可以过供应商列表的 staff 守卫然后 500；普通用户被 staff 拒绝（「需要平台管理员权限」）；平台 `admin` 打 `/api/admin/users` 得到超级管理员拒绝；非超管打 `/api/admin/ai-requests` 403（守卫按规格改为 super，未接线时超管仍 501）；未登录打 AI 账本得到 `AUTH_REQUIRED`；登录用户 DELETE 视频在没有替换处理器时得到 501（登录守卫，不要求 org）。`TestPortedSkipsInventoryGuard` 锁住已替换的路由不再走这道库存守卫。

有 Docker 或 `PODHUB_PARITY_DSN` 时还会跑 `TestOwnershipStaffRLSAndCash`：admin 只看见自己创建的库；另一个 admin 看不见；super_admin 看得见；缺 `app.staff_access` 时 `supplier_withdrawals` 与 `sc_source_members` 行数为 0；打款把冻结和余额同时减去金额，第二次 409；授权只列给创建它的用户，别人撤销 404，第二次撤销 404。用户与 AI 鉴权的库测是 `TestAdminUsersAIAuth`。

字节测试：`TestSupplierListBytesAndHeaders`、`TestSupplierValidationAndAuthBytes`、`TestGrantAndWithdrawalInput`、`TestDecodeSupplierDb`、`TestAdminGuards`。

规格段落与测试：

| 规格 | 测试 |
|---|---|
| supplier-dbs GET/POST 列表与校验、私有缓存头 | `TestSupplierListBytesAndHeaders` `TestDecodeSupplierDb` |
| 属性 position 必填、非员工 403、空 PATCH、改密 super、未配置存储 503 | `TestSupplierValidationAndAuthBytes` |
| 存储目录/列表/删除/移动/上传、行创建、调价、diff、preview、sync、PATCH、提示词发布、中止 | `TestSupplierX1SuccessBytes` |
| 缺 Content-Type、确认体超限、未知 query、坏 revision、空 cursor、员工打存储、用户打行、未配置桶、源站错误、复制 404、复制体含 Error、被引用、保留路径、同路径、目录移动、目录源站 503/500、写租约关闭、上架 missing、非 loopback | `TestSupplierX1ErrorBranches` |
| 预览摘要、六行 diff、存储分页游标、员工行 denial | `TestPreviewChernovikDigest` `TestDiffSixLines` `TestProjectStorageHiddenPageKeepsCursor` `TestStaffRowDenialShape` |
| 修订、跨所有者、缺 GUC、无 RLS、写租约 | `TestSupplierX1RevisionsRLSAndLease` |
| 提现状态、授权动作、打款单号 | `TestGrantAndWithdrawalInput` |
| 所有权、staff RLS、打款账本、授权隔离 | `TestOwnershipStaffRLSAndCash` |
| CSRF 在私有缓存头之前 | `TestCSRFStillRejectsCookieWrite` |
| 平台目录校验、外链图、修订 | `TestCatalogProductEdges` `TestCatalogRevisionAndPrice` |
| 采购认领与回执文案 | `TestProcureValidation` `TestProductionFilesUnknownShape` |
| 代理邀请码、策略、CSV | `TestInviteCodeRules` `TestRebatePolicyRanges` `TestCSVQuotingAndFormulas` |
| 物流预设与注入开关 | `TestNormalizePayloadMessages` `TestWriteGates` `TestSafeContinueBlock` |
| sing-box 配置字节 | `TestSingBoxMatchesFixture` |
| 委托单查询与 uuid | `TestOrderQuery` `TestCanonicalUUID` |
| A2 在供应商守卫之前要求 TOTP | `TestA2GatesBeforePort` |

## 改了哪个流程、结果为什么不变

账单与观察路由的流程变化写在 `docs/parity/admin-billing-parity.md`。供应商写路径仍在同一个 `tenantx.BeginApp` 事务里完成插入、审计和提交。没有把多次往返并成结果会变的批处理。各写域共用 `internal/platform/writer.Assert`：匹配本进程 `axum` + `CLOUD_INSTANCE_ID` 的未过期行允许并心跳，否则 503，文案仍按调用点。厂家门户看的是 `admin` 域，不是 `entitlement`。平台货源行、Ozon 配置和提示词写路径也走同一 `Assert`，域是 `admin`，关闭文案是「平台货源写入未启用」。存储 6 条不进写租约。这 22 条不读 `OZON_WRITE_KILL_SWITCH` 或 `CLOUD_MEDIA_GC_DELETE`，确认不删除暂存对象，也不调用 Seller。官方字段包、提示词和视频的写闸见 `docs/parity/adminb-misc-parity.md`。一次性密码仍是 `dzp-` 加 UUID。用户与 AI 鉴权这 25 条走另一套普通事务，租约判断与其它域相同，流程对照写在 `admin-users-ai-auth-parity.md`。禁用标签的既有写路径没有改。路径和 operationId 数量没变。没有第二套 `OZON_WRITE_KILL_SWITCH` 解析。OpenAPI tag `admin` 已用于 banned-tags，所以账单新增 operation 用 operationId 从根代码生成里排除，生成的 `Server` 不变。

## 需要用户决定

1. 生产成功路径已经不是整段 501。还对不齐的是各文档里的未确认句子，不是「守卫通过后一律 501」。用户与 AI 鉴权的未确认点见 `admin-users-ai-auth-parity.md`。账单与观察里无法证明与 Rust 一致的差异见 `admin-billing-parity.md`。官方字段包、提示词、视频和媒体的未确认点见 `adminb-misc-parity.md`。
2. 「路径推断」的真实守卫。失败闭合为 super_admin 可能比 Rust 更严（例如只要求 platform admin）。`require_price_publisher` 在价格规格里就是 `require_super_admin`。守卫仍记为 GuardPrice，行为与 super 相同。物流 readiness 在路由表里标的是工作区守卫，处理函数按规格改成超级管理员加 TOTP。
3. staff 拒绝的中文正文。
4. 供应商 admin 与另一代理的 `internal/supplier` 如何共享表。本 PR 不建第二套 repo；以后查询应走本域 sqlc，不改对方文件。`db/schema` 现在没有这些表，所以没有生成 sqlc。
5. 规则表即时生效和审计已经由 banned-tags 写路径完成，本 PR 没有第二套。
6. 库详情、行创建/更新、调价、上下架已按上传规格和夹具实现。成功状态：GET 详情 200，POST 行 201，PUT 行、调价、上架、下架 200。字段顺序按规格结构体。规格没有逐字贴出的中文句子见第 21 条。
7. 存储 6 条与货源上传 3 条已实现，对象请求只打 loopback，确认不删除暂存对象。未配置桶是 503 `STORAGE_NOT_CONFIGURED`。目录 201，列表、删除、移动、上传、确认 200，中止 204 空体。晋升标记编码、分片父对象字段顺序和行上传请求字段名见第 20 条。
8. 提示词 diff、preview、publish、PATCH、sync 已实现，成功都是 200。preview 与空 sync 的成功字节对过夹具。GET `/api/admin/supplier-prompts` 仍是原来的 200。准入 429 正文和未知 query 的 expected 列表用词见第 18、19 条。本包不安装限流器。
9. 提现审计的 `module` / `entity_type` 没有逐字段贴出。本实现写成 `supplier_portal` / `supplier_withdrawal`，action、path、payload 键按规格。若 Rust 的 module 不是这两个值，需要改审计行。
10. 提现 path 不是 UUID 时，规格同时写了「SQL `$1::uuid` 失败 → 500」和「未确认」。本实现把 `22P02` 收成 500 `internal` / `服务暂不可用`。
11. 供应商开通厂家账号目前只检查角色。平台目录、采购、物流、中转和代理路由，以及账单与观察路由，额外要求 `account_admin_totp.confirmed_at` 与未过期的 `admin_step_up_until`，文案是「请先绑定验证器」「管理操作需要重新验证」。用户与 AI 鉴权这 25 条用自己的 step-up。官方字段包、提示词、视频和媒体这 18 条在请求带会话凭据时会查 TOTP standing，见 `docs/parity/adminb-misc-parity.md`。账单细节见 `docs/parity/admin-billing-parity.md`。
12. 平台目录、采购、物流预设与绑定、中转节点文件、代理管理和委托单读取已实现。委托单 dispatch/receipt/cancel 与物流 reconcile / safe-continue 已按 X2 规格实现，见逐项登记。用户与 AI 鉴权 25 条、账单与观察，以及官方字段包、类目提示词、类目视频和媒体这 18 条已经实现。
13. 已确认。写闸共用 `writer.Assert`（规格 X3-B）。平台目录、采购、物流预设、代理管理、字段包、提示词、视频、权益、连接配置、厂家门户和平台货源都按 holder `axum` 与 `CLOUD_INSTANCE_ID` 判断，并在持有时心跳。503 文案仍是各调用点原来的句子。店铺名册写路径没有移植，没有新路由。
14. 连接配置密文已按 camelCase 解密，管理端、支付、媒体、委托和目录白名单读同一份文档。`CatalogRepo.Bases` 只取 `mediaAccounts[].publicBaseUrl`：去掉空字符串，不 trim、不去尾部斜杠，停用账号也算。没有配置行时是空列表，并且不检查密钥。非空媒体在前缀对不上时 400 `图片须先通过图片上传接口写入媒体存储`。`supplierDbStorage`、`delegateAssetsStorage`、AI 和支付不是白名单。上传票据仍是本地 HMAC，不是已证明的 Rust `upload_receipt`。`storage_identity` 公式未确认。`sc_products` 没有 RLS，越权靠超级管理员门。
15. `CLOUD_SELLER_EGRESS_ROUTES` 的完整切分没有钉死，所以 probe 看不到 socks5h 标签时返回 200 不可达，不拨号。有 socks5h 标签时仍是这一条的 501，因为规格没有钉死代理拨号，本进程不打开真实代理。这不是整段管理路由的 501。目录来自已解析的 `CLOUD_SELLER_RELAY_DIR` / `CLOUD_SELLER_RELAY_SWITCH_DIR`。注入开关 A 是已解析的 `SHIPPING_INJECT_OZON_WRITES`。开关 B 只用 `Config.OzonWritesDisabled()`，HTTP 正文是现有 egress 哨兵的英文 `Error()`，不是 Rust Display 的中文句子。
16. 生产快照 JSON 字段名未确认。未知形状变成空的 `productionFiles`。代理非法 uuid、reference 超长、拒绝原因超长走 `mapAdmin` 的 500，不单列 `22P02`。
17. 委托单表有 RLS。员工事务只设 `app.staff_access=1`，不设 `app.current_org_id`。缺 staff GUC 时这些行对 `podhub_app` 不可见。目录、采购、代理表没有 RLS。`sc_products`、`sc_skus`、`sc_price_versions` 没有 RLS，本 PR 不加。
18. 准入超预算的 429 正文没有展开。这 22 条不安装限流器。
19. GET 存储对象的未知 query 状态是 400，正文前缀是 `Failed to deserialize query string: `，Content-Type 是 `text/plain; charset=utf-8`。实现写出 `unknown field \`foo\`, expected \`prefix\` or \`cursor\``。expected 列表的用词没有按 Rust 钉死。
20. 晋升标记用小写十六进制。行上传请求字段按存储上传的 `path`、`contentType`、`bytes`、`sha256`。abort 空体或没有 `uploadTicket` 回 204。confirm 的 `parts` 可选。分片父对象字段顺序是 `uploadId`、`ticket`、`partSize`、`parts`。
21. 这些中文句子已实现，规格没有逐字贴出：数值必须大于 0；新建行不能是归档态；expectedRevision 必填；平台价必须大于 0；版本号必须为正整数；归档商品不能上架；商品尚未满足上架条件（带 `missing`）；平台货号已被占用；同款尺寸已存在；同款分组需要填写尺寸；sha256 无效；文件扩展名无效；固定标签含受限词，不能保存；配置已被其他操作更新；上传对象内容与声明的文件类型不一致。行审计 `entity_id` 用 `product_id`。sync 规格里的「商品已被其他操作更新」也用于行 CAS。
22. 这 22 条不读 `OZON_WRITE_KILL_SWITCH`，也不调用 Seller。确认不删除暂存对象，因此不读 `CLOUD_MEDIA_GC_DELETE`。

## 逐项登记

下表「结果」列写明已实现的成功状态。标「已移植」的见 `docs/parity/admin-billing-parity.md`。生产成功路径没有整段 501。个别未钉死的分支仍在表内写明（例如有 socks5h 标签的 probe）。写闸关闭的 ops 两条在表中仍标 501，代码是 `OZON_WRITES_DISABLED`。

| 方法 | 路径 | Rust operationId | 守卫 | 结果 |
|---|---|---|---|---|
| GET | `/api/admin/supplier-accounts` | `list_supplier_accounts` | GuardStaff | 200 groups |
| POST | `/api/admin/supplier-accounts` | `create_supplier_account` | GuardSuper | 200 member |
| DELETE | `/api/admin/supplier-accounts/{member_id}` | `delete_supplier_account` | GuardStaff | 200 unbound |
| PATCH | `/api/admin/supplier-accounts/{member_id}` | `patch_supplier_account` | GuardStaff；body 含 password 时升为 GuardSuper | 200 member |
| GET | `/api/admin/supplier-automation/grants` | `supplier_automation_grants_list` | GuardStaff，再读 account_users | 200 grants |
| POST | `/api/admin/supplier-automation/grants` | `supplier_automation_grant_create` | GuardStaff，再读 account_users | 200 grant+token |
| POST | `/api/admin/supplier-automation/grants/{id}/revoke` | `supplier_automation_grant_revoke` | GuardStaff，再读 account_users | 200 revoked |
| POST | `/api/admin/supplier-db-storage/directories` | `admin_supplier_db_storage_directories_create` | GuardSuper | 201 path；无桶 503 |
| GET | `/api/admin/supplier-db-storage/objects` | `admin_supplier_db_storage_objects_list` | GuardSuper | 200 页；无桶 503 |
| POST | `/api/admin/supplier-db-storage/objects/delete` | `admin_supplier_db_storage_objects_delete` | GuardSuper | 200 tally；无桶 503 |
| POST | `/api/admin/supplier-db-storage/objects/move` | `admin_supplier_db_storage_objects_move` | GuardSuper | 200 moved；无桶 503 |
| POST | `/api/admin/supplier-db-storage/uploads` | `admin_supplier_db_storage_uploads_create` | GuardSuper | 200 upload；无桶 503 |
| POST | `/api/admin/supplier-db-storage/uploads/confirm` | `admin_supplier_db_storage_uploads_confirm` | GuardSuper | 200 confirmed；不删暂存 |
| GET | `/api/admin/supplier-dbs` | `list_supplier_dbs` | GuardStaff | 200 dbs |
| POST | `/api/admin/supplier-dbs` | `create_supplier_db` | GuardStaff | 201 db |
| DELETE | `/api/admin/supplier-dbs/{source_id}` | `delete_supplier_db` | GuardStaff | 200 sourceId |
| GET | `/api/admin/supplier-dbs/{source_id}` | `get_supplier_db` | GuardStaff | 200 detail |
| PUT | `/api/admin/supplier-dbs/{source_id}` | `update_supplier_db` | GuardStaff | 200 db |
| POST | `/api/admin/supplier-dbs/{source_id}/props` | `create_supplier_db_prop` | GuardStaff | 201 prop |
| DELETE | `/api/admin/supplier-dbs/{source_id}/props/{prop_id}` | `delete_supplier_db_prop` | GuardStaff | 200 rowsWithValues |
| PUT | `/api/admin/supplier-dbs/{source_id}/props/{prop_id}` | `update_supplier_db_prop` | GuardStaff | 200 prop |
| POST | `/api/admin/supplier-dbs/{source_id}/rows` | `create_supplier_db_row` | GuardStaff | 201 row |
| DELETE | `/api/admin/supplier-dbs/{source_id}/rows/{product_id}` | `delete_supplier_db_row` | GuardStaff | 200 productId |
| PUT | `/api/admin/supplier-dbs/{source_id}/rows/{product_id}` | `update_supplier_db_row` | GuardStaff | 200 row |
| GET | `/api/admin/supplier-dbs/{source_id}/rows/{product_id}/ozon-config` | `get_supplier_ozon_config` | GuardStaff | 200 config |
| PUT | `/api/admin/supplier-dbs/{source_id}/rows/{product_id}/ozon-config` | `put_supplier_ozon_config` | GuardStaff | 200 config |
| POST | `/api/admin/supplier-dbs/{source_id}/rows/{product_id}/price` | `adjust_supplier_db_price` | GuardStaff | 200 row |
| GET | `/api/admin/supplier-dbs/{source_id}/rows/{product_id}/prompt/diff` | `diff_supplier_prompt` | GuardStaff | 200 diff |
| POST | `/api/admin/supplier-dbs/{source_id}/rows/{product_id}/prompt/preview` | `preview_supplier_prompt` | GuardStaff | 200 preview |
| POST | `/api/admin/supplier-dbs/{source_id}/rows/{product_id}/prompt/publish` | `publish_supplier_prompt_revision` | GuardStaff | 200 publish |
| POST | `/api/admin/supplier-dbs/{source_id}/rows/{product_id}/publish` | `publish_supplier_db_row` | GuardStaff | 200 row |
| POST | `/api/admin/supplier-dbs/{source_id}/rows/{product_id}/unpublish` | `unpublish_supplier_db_row` | GuardStaff | 200 row |
| POST | `/api/admin/supplier-dbs/{source_id}/uploads` | `presign_supplier_db_upload` | GuardStaff | 200 upload |
| POST | `/api/admin/supplier-dbs/{source_id}/uploads/abort` | `abort_supplier_db_upload` | GuardStaff | 204 空体 |
| POST | `/api/admin/supplier-dbs/{source_id}/uploads/confirm` | `confirm_supplier_db_upload` | GuardStaff | 200 confirmed |
| GET | `/api/admin/supplier-prompts` | `list_supplier_prompts` | GuardStaff | 200 prompts |
| POST | `/api/admin/supplier-prompts/sync` | `sync_supplier_prompts` | GuardSuper | 200 report |
| PATCH | `/api/admin/supplier-prompts/{product_id}` | `patch_supplier_prompt` | GuardStaff | 200 prompt |
| GET | `/api/admin/supplier-withdrawals` | `list_factory_withdrawals` | GuardStaff | 200 withdrawals |
| POST | `/api/admin/supplier-withdrawals/{withdrawal_id}/pay` | `pay_withdrawal` | GuardStaff | 200 单元素 withdrawals |
| POST | `/api/admin/supplier-withdrawals/{withdrawal_id}/reject` | `reject_withdrawal` | GuardStaff | 200 单元素 withdrawals |
| GET | `/api/admin/platform-catalog` | `admin_list` | GuardSuper | 200 目录；超级管理员+TOTP+step-up |
| POST | `/api/admin/platform-catalog/products` | `create_product` | GuardSuper | 201 商品 |
| PUT | `/api/admin/platform-catalog/products/{product_id}` | `update_product` | GuardSuper | 200；CAS 失败 409 |
| POST | `/api/admin/platform-catalog/products/{product_id}/images` | `upload_product_image` | GuardSuper | 确认图片；无媒体配置 503/400 |
| POST | `/api/admin/platform-catalog/products/{product_id}/images/upload` | `init_product_image_upload` | GuardSuper | 初始化上传；只打 loopback |
| POST | `/api/admin/platform-catalog/products/{product_id}/publish` | `publish_product` | GuardInferred | 200 上下架 |
| POST | `/api/admin/platform-catalog/products/{product_id}/unpublish` | `unpublish_product` | GuardInferred | 200 上下架 |
| POST | `/api/admin/platform-catalog/skus` | `create_sku` | GuardSuper | 201 SKU |
| PUT | `/api/admin/platform-catalog/skus/{sku_id}` | `update_sku` | GuardSuper | 200 SKU |
| POST | `/api/admin/platform-catalog/skus/{sku_id}/images` | `upload_sku_image` | GuardSuper | 确认图片；无媒体配置 503/400 |
| POST | `/api/admin/platform-catalog/skus/{sku_id}/images/upload` | `init_sku_image_upload` | GuardSuper | 初始化上传；只打 loopback |
| POST | `/api/admin/platform-catalog/skus/{sku_id}/price` | `set_price` | GuardSuper | 200 平台价 |
| POST | `/api/admin/platform-catalog/skus/{sku_id}/publish` | `publish_sku` | GuardInferred | 200；无价 400 |
| POST | `/api/admin/platform-catalog/skus/{sku_id}/unpublish` | `unpublish_sku` | GuardInferred | 200 上下架 |
| GET | `/api/admin/agent-commissions` | `list_agent_commissions` | GuardSuper | 200 分页 |
| GET | `/api/admin/agent-commissions/csv` | `export_agent_commissions` | GuardSuper | 200 CSV，不是 JSON |
| PUT | `/api/admin/agent-rebate-policy` | `set_agent_rebate_policy` | GuardSuper | 200 策略 |
| GET | `/api/admin/agent-withdrawals` | `list_agent_withdrawals_admin` | GuardSuper | 200 提现 |
| POST | `/api/admin/agent-withdrawals/{public_id}/pay` | `pay_agent_withdrawal` | GuardSuper | 200；账本冲突保持英文句子 |
| POST | `/api/admin/agent-withdrawals/{public_id}/reject` | `reject_agent_withdrawal` | GuardSuper | 200；拒绝原因必填 |
| GET | `/api/admin/agents` | `list_agents` | GuardSuper | 200；写审计，不占写租约 |
| POST | `/api/admin/agents` | `create_agent` | GuardSuper | 200 代理 |
| PUT | `/api/admin/agents/{uuid}` | `update_agent` | GuardSuper | 200 代理 |
| GET | `/api/admin/ai-requests` | `list` | GuardSuper | 已实现 |
| GET | `/api/admin/ai-requests/summary` | `summary` | GuardSuper | 已实现 |
| DELETE | `/api/admin/ai/prices` | `unpublish_price` | GuardPrice | 已实现 |
| PUT | `/api/admin/ai/prices` | `publish_price` | GuardPrice | 已实现 |
| GET | `/api/admin/delegate-orders` | `delegate_admin_list_orders` | GuardStaff | 200；staff_access，小写错误码 |
| GET | `/api/admin/delegate-orders/{order_id}` | `delegate_admin_get_order` | GuardStaff | 200 或 404 |
| POST | `/api/admin/delegate-orders/{order_id}/cancel` | `delegate_admin_cancel_order` | GuardStaff | 已实现。员工，蛇形 code。写租约走 `writer.Assert` |
| POST | `/api/admin/delegate-orders/{order_id}/dispatch` | `delegate_admin_dispatch_order` | GuardStaff | 已实现。员工，蛇形 code。写租约走 `writer.Assert` |
| POST | `/api/admin/delegate-orders/{order_id}/receipt` | `delegate_admin_record_receipt` | GuardStaff | 已实现。员工，蛇形 code。写租约走 `writer.Assert` |
| DELETE | `/api/admin/error-logs` | `delete_selected` | GuardSuper | 已移植，见 admin-billing-parity.md |
| GET | `/api/admin/error-logs` | `list` | GuardWorkspace | 已移植，见 admin-billing-parity.md |
| POST | `/api/admin/integrations/ai/models` | `list_models` | GuardSuper | 已实现 |
| POST | `/api/admin/integrations/ai/verify` | `verify` | GuardSuper | 已实现 |
| PUT | `/api/admin/integrations/config` | `replace` | GuardSuper | 已实现 |
| GET | `/api/admin/listing/packages/official` | `get_official` | GuardSuper | ported，见 adminb-misc |
| POST | `/api/admin/listing/packages/official` | `create_official` | GuardSuper | ported，见 adminb-misc |
| DELETE | `/api/admin/listing/packages/official/{id}` | `delete_official` | GuardSuper | ported，见 adminb-misc |
| PUT | `/api/admin/listing/packages/official/{id}` | `replace_official` | GuardSuper | ported，见 adminb-misc |
| POST | `/api/admin/media/directories` | `admin_media_directories_create` | GuardSuper | ported，见 adminb-misc |
| GET | `/api/admin/media/objects` | `admin_media_objects_list` | GuardSuper | ported，见 adminb-misc |
| POST | `/api/admin/media/objects/delete` | `admin_media_objects_delete` | GuardSuper | ported，见 adminb-misc |
| POST | `/api/admin/media/objects/move` | `admin_media_objects_move` | GuardSuper | ported，见 adminb-misc |
| POST | `/api/admin/media/purge` | `purge` | GuardSuper | ported，见 adminb-misc |
| GET | `/api/admin/media/storage` | `storage` | GuardSuper | ported，见 adminb-misc |
| POST | `/api/admin/media/uploads` | `admin_media_uploads_create` | GuardSuper | ported，见 adminb-misc |
| POST | `/api/admin/media/uploads/confirm` | `admin_media_uploads_confirm` | GuardSuper | ported，见 adminb-misc |
| GET | `/api/admin/ops/console/snapshot` | `admin_observation_console_snapshot` | GuardInferred | 已移植，见 admin-billing-parity.md |
| GET | `/api/admin/ops/scopes` | `admin_observation_scopes` | GuardInferred | 已移植，见 admin-billing-parity.md |
| GET | `/api/admin/orders` | `list_orders` | GuardSuper | 已移植，见 admin-billing-parity.md |
| GET | `/api/admin/orders/{public_id}` | `get_order` | GuardSuper | 已移植，见 admin-billing-parity.md |
| POST | `/api/admin/orders/{public_id}/cancel` | `cancel_order` | GuardSuper | 已移植，见 admin-billing-parity.md |
| PUT | `/api/admin/orders/{public_id}/confirm` | `confirm_order` | GuardSuper | 已移植，见 admin-billing-parity.md |
| PUT | `/api/admin/payment/config` | `replace_payment_config` | GuardSuper | 已移植，见 admin-billing-parity.md |
| PUT | `/api/admin/payment/config` | `replace_payment_config` | GuardSuper | 已移植，见 admin-billing-parity.md |
| GET | `/api/admin/plans` | `list_plans` | GuardSuper | 已移植，见 admin-billing-parity.md |
| POST | `/api/admin/platform-orders/{order_id}/request-refund` | `request_refund_route` | GuardSuper | 200 退款时间 |
| GET | `/api/admin/platform-procurements` | `list_work_route` | GuardSuper | 200 工作列表 |
| POST | `/api/admin/platform-procurements/claim` | `claim_route` | GuardSuper | 200 认领 |
| POST | `/api/admin/platform-procurements/{procurement_id}/dispatch` | `dispatch_route` | GuardSuper | 200 派发 |
| POST | `/api/admin/platform-procurements/{procurement_id}/receipt` | `receipt_route` | GuardSuper | 200 回执 |
| POST | `/api/admin/prompts` | `create` | GuardWorkspace | ported，见 adminb-misc；入口改走超级管理员 |
| DELETE | `/api/admin/prompts/{prompt_id}` | `delete` | GuardLogin | ported，见 adminb-misc；入口改走超级管理员 |
| PUT | `/api/admin/prompts/{prompt_id}` | `update` | GuardWorkspace | ported，见 adminb-misc；入口改走超级管理员 |
| GET | `/api/admin/redeem-codes` | `list` | GuardWorkspace | 已移植，见 admin-billing-parity.md |
| POST | `/api/admin/redeem-codes` | `create` | GuardWorkspace | 已移植，见 admin-billing-parity.md |
| POST | `/api/admin/redeem-codes` | `create` | GuardWorkspace | 已移植，见 admin-billing-parity.md |
| GET | `/api/admin/redeem-codes/{id}` | `detail` | GuardSuper | 已移植，见 admin-billing-parity.md |
| GET | `/api/admin/redeem-codes/{id}` | `detail` | GuardSuper | 已移植，见 admin-billing-parity.md |
| POST | `/api/admin/redeem-codes/{id}/revoke` | `revoke` | GuardSuper | 已移植，见 admin-billing-parity.md |
| GET | `/api/admin/seller-relay` | `seller_relay_get` | GuardSuper | 200 节点文件；不启 sing-box |
| PUT | `/api/admin/seller-relay/active` | `seller_relay_switch` | GuardSuper | 200 切换并写 config.json |
| POST | `/api/admin/seller-relay/nodes` | `seller_relay_import` | GuardSuper | 200 导入 |
| DELETE | `/api/admin/seller-relay/nodes/{node_id}` | `seller_relay_delete` | GuardSuper | 200 删除 |
| POST | `/api/admin/seller-relay/probe` | `seller_relay_probe` | GuardSuper | 无 socks5h 时 200 不可达；有路由则 501 |
| GET | `/api/admin/shipping-injections` | `list_injections_route` | GuardSuper | 200 诊断 |
| GET | `/api/admin/shipping-injections/{store_uuid}/{preset_id}` | `get_injection_route` | GuardSuper | 200 诊断 |
| POST | `/api/admin/shipping-injections/{store_uuid}/{preset_id}/reconcile` | `reconcile_route` | GuardSuper | 已实现。超管 + 验证器，SCREAMING code。不看两个写入开关 |
| POST | `/api/admin/shipping-injections/{store_uuid}/{preset_id}/safe-continue` | `safe_continue_route` | GuardSuper | 已实现。先看 `ShippingInjectWrites()`，写路径再看 kill switch |
| GET | `/api/admin/shipping-presets` | `list_presets_route` | GuardSuper | 200 预设 |
| POST | `/api/admin/shipping-presets` | `create_preset` | GuardSuper | 201 预设 |
| DELETE | `/api/admin/shipping-presets/{preset_id}` | `delete_preset_route` | GuardSuper | 200 删除 |
| GET | `/api/admin/shipping-presets/{preset_id}` | `get_preset_route` | GuardSuper | 200 预设 |
| PUT | `/api/admin/shipping-presets/{preset_id}` | `update_preset` | GuardSuper | 200 新版本 |
| POST | `/api/admin/shipping-presets/{preset_id}/apply-product` | `apply_product` | GuardSuper | 200 绑定 |
| GET | `/api/admin/shipping-readiness/{sku_id}` | `readiness_route` | GuardWorkspace | 200；实际守卫是超级管理员+TOTP |
| POST | `/api/admin/shipping-sku-bindings` | `bind_sku` | GuardSuper | 200 绑定 |
| DELETE | `/api/admin/shipping-sku-bindings/{sku_id}` | `unbind_sku` | GuardSuper | 200 解绑 |
| POST | `/api/admin/step-up` | `step_up` | GuardSuper | 已实现 |
| GET | `/api/admin/stores/products` | `admin_observation_products` | GuardInferred | 已移植，见 admin-billing-parity.md |
| GET | `/api/admin/stores/products/overview` | `admin_observation_products_overview` | GuardInferred | 已移植，见 admin-billing-parity.md |
| GET | `/api/admin/stores/{store_id}/products/{store_product_id}/thumbnail` | `admin_observation_thumbnail` | GuardInferred | 已移植，见 admin-billing-parity.md |
| GET | `/api/admin/support-grants` | `support_grants` | GuardSuper | 已实现 |
| POST | `/api/admin/support-grants` | `issue_grant` | GuardSuper | 已实现 |
| POST | `/api/admin/support-grants/{id}/revoke` | `revoke_grant` | GuardSuper | 已实现 |
| POST | `/api/admin/totp/confirm` | `confirm` | GuardSuper | 已实现 |
| POST | `/api/admin/totp/enroll` | `enroll` | GuardSuper | 已实现 |
| GET | `/api/admin/users` | `list_users` | GuardSuper | 已实现 |
| POST | `/api/admin/users` | `create_user` | GuardSuper | 已实现 |
| POST | `/api/admin/users/{uuid}/admin` | `set_user_admin` | GuardSuper | 已实现 |
| POST | `/api/admin/users/{uuid}/member-seats/apply` | `apply_user_member_seats` | GuardSuper | 已实现 |
| POST | `/api/admin/users/{uuid}/member-seats/preview` | `preview_member_seats` | GuardSuper | 已实现 |
| POST | `/api/admin/users/{uuid}/password` | `set_user_password` | GuardSuper | 已实现 |
| POST | `/api/admin/users/{uuid}/seats` | `set_user_seats` | GuardSuper | 已实现 |
| POST | `/api/admin/users/{uuid}/status` | `set_user_status` | GuardSuper | 已实现 |
| POST | `/api/admin/videos` | `create` | GuardWorkspace | ported，见 adminb-misc；入口改走超级管理员 |
| DELETE | `/api/admin/videos/{video_id}` | `delete` | GuardLogin | ported，见 adminb-misc；入口改走超级管理员 |
| PUT | `/api/admin/videos/{video_id}` | `update` | GuardWorkspace | ported，见 adminb-misc；入口改走超级管理员 |
| POST | `/api/admin/workspaces/{uuid}/dissolve` | `dissolve_workspace` | GuardSuper | 已实现 |
| GET | `/api/admin/workspaces/{uuid}/wallet` | `wallet` | GuardSuper | 已移植，见 admin-billing-parity.md |
| POST | `/api/admin/workspaces/{uuid}/wallet/topups` | `create_topup` | GuardSuper | 已移植，见 admin-billing-parity.md |
| POST | `/api/admin/workspaces/{uuid}/wallet/topups/{topup_id}/revoke` | `revoke_topup` | GuardSuper | 已移植，见 admin-billing-parity.md |
| GET | `/api/admin/writer-leases` | `writer_lease_status` | GuardSuper | 已实现 |
| POST | `/api/admin/writer-leases` | `writer_lease_grant` | GuardSuper | 已实现 |
| POST | `/api/admin/writer-leases/revoke` | `writer_lease_revoke` | GuardSuper | 已实现 |

## 运费绑定批量写入

`Apply` 仍先 `ensurePreset` 一次，再按 `created_at_ms, sku_id` 取出 SKU。绑定不再逐个 `upsertBinding`：一条 `SELECT sku_id … WHERE sku_id = ANY` 确认都存在，一条多行 upsert（`updated_at_ms` 用传入的 `now`，冲突时不改 `created_at_ms`），然后按原 SKU 顺序 `loadBinding` 并逐条 `InsertAudit`。返回顺序等于原 SKU 顺序。某个 SKU 不存在时，在 upsert 之前返回 400 `平台 SKU 不存在`，整事务回滚。单笔 `Bind` 仍走 `upsertBinding`。`sc_skus` 有 `UNIQUE(product_id)`，一个商品放不下 40 个 SKU，语句计数直接调用 `bindSKUs`。`TestBindSKUsBatchParity` 用逐条 `upsertBinding` 作对照：`shipping_sku_bindings` 列一致，审计按 `audit_logs.id` 的顺序一致（不比 `clock_timestamp()` 的 `created_at_ms`）。40 个 SKU：存在性查询 1、upsert 1、审计插入 40。`BenchmarkBindSKUs`（40 个 SKU，`-benchtime=1s`）：`3913012 ns/op`。
