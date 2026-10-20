# 商库极简化：最终删除清单与施工方案

- 状态：待拍板（第 7 节问题未决前不动工）
- 日期：2026-10-20
- 输入材料：本轮最终设计 JSON（estimatedLoc 等估算字段的出处）、需求基线 24 条需求（core 7 / valuable 7 / dispensable 10，随材料提供，无独立文档）、12 项删除主张的独立核验（全部 holds=false，即「没人依赖」这一原始理由均不成立，删除须经第 4 节扩充清单执行）、对抗轮次复核（passed=true，7 项口径修正已并入本文）。
- 检查归属分两层：
  - **本 session 亲跑**（命令与结论见各处标注）：下文所有标注「亲验」的事实，包括 00119/00265 的 UNIQUE 裁决、8 码清单、referenced() 边界、RLS 策略机制、路由表 40 条清点。
  - **上游轮次运行、本 session 未重跑**：`gofmt -l .` 无输出；`go build ./...` 通过；「商库相关包测试通过」——上游未给出包清单，范围不明；`tests/archtest` 通过。
- 所有「不可达 / 0 调用 / 唯一写者」结论（未标亲验者）为上游静态读码与 grep 结论；`go test ./...` 全量、`go vet`、tests/integration（无 Docker）、`bun test` 全量、生产库普查均未运行。

---

## 1. 商库在做什么生意

平台方按厂家维护一份货源台账：员工逐行录入商品（一款一规格、成本报价、平台售价、Ozon 类目配置、识别提示词），并决定每行是否对卖家可见。卖家在工作台按厂家浏览这批货盘，把看中的行一键变成上架方案卡。同一套厂家主数据还兼作厂家自助门户：厂家登录后接单或拒单、查看货款余额并申请提现，平台审批放款。

商库的实体内核因此只有四件事：**listing 行模型 + 派单结算 + 一张成本价 + 一个 listable 判定**。类目戳、禁用词表、提示词各收敛到一个事实源（ozon_catalog_schema_cache 持久行 + SemanticRevision / prompt_revisions / 一个 Denial 函数）。

## 2. 现在花了多少

| 维度 | 数值 | 口径与出处 |
|---|---|---|
| 商库相关代码量 | 基线约 41,500 行、删后 estimatedLoc=33,000 | **这两个数都是设计 JSON 自述的估算，数字本身不可信**。交付复核用 `wc -l` 实测：后端四域（supplier/supply/admin-supplier/admin-x1）非测试 Go 仅 **9,887 行**，加 admin/catalog 共 **10,645 行**；前端 supplier-dbs + supply-chain 两项非测试 **16,318 行**。41,500 这个基线把测试、生成物和相邻域一并算进去了，33,000 也从未对账。**可用的口径是相对减量**：第 4 节逐刀行数合计约 11,000 行（Go 约 9,200 + web 约 1,840），但 C9–C14 未逐刀计数、x1 并入有约 200+ 处接线的净增、测试改写与迁移新增均未计入，所以这不是一个能预测总行数的模型 |
| 数据库表 | 金标钉 132 张 | 本方案退役 9 张、删 6 列（分布在 00352 三列 / 00353 两列 / 00357 一列，共三条迁移）、删 2 条约束、新增 3 列。表上行数变化（offers 回填、grants 清理、指纹 diffRowCounts 归零）不在任何行数估算内 |
| 路由 | routes.txt 324 行（golden 字节比对，`routes_test.go:39`） | 涉商库：admin supplier-* 40 条（本 session 亲验：`awk '/func SupplierRoutes/,/^}$/' suppliers.go \| grep -c "RustOperationID:"` = 40；上游勘察稿的「41 条」与此不符，以实测 40 为准）、admin platform-catalog 3 条（routes.txt:41,150,151）、supply 挂 3 条（routes.txt:100,101,102）、门户 `/api/supplier/*` 11 条、其余 admin 面板路由若干。本方案删 12 行：routes.txt:100 + :41/:150/:151 + 5 条 storage + 3 条 grants |
| Go 模块 | 涉 internal/supply、internal/supplier、internal/admin/{catalog,x1,repo,service,domain}、internal/listing/read/http、internal/catalog/http、internal/delegate | 删 1 个整包（admin/catalog）、并 1 个单元（x1→supplier）、扁平化 2 个包、**删 5 个生成目录**（supplier/gen、supply/gen、supplier/http/gen、supply/http/gen、admin/http/gen）+ 2 个 codegen yaml + sqlc 两段 |
| 前端 | supplier-dbs 约 15.5k 行、supply-chain 约 7.5k 行（上游静态统计） | 两块受众 UI 减不动；删约 1,800 行封装/分支/死 key（静态统计） |
| 迁移 | 已到 00349（00342–00349 已被占用，manifest 尾 8 条 sha256 上游亲验） | 新开 00350–00357 共 8 个号 + grants 清理 1 个追加号（见 C5） |

各刀行数（C1 约 1,700、C2 约 1,745、C3 约 726、C4 约 510、C5 约 350、C6 约 1,400 净、C7 约 160 Go + 40 web、C8 约 560、C15 约 1,218、C16 约 570、C17 约 1,800 web）均为上游静态统计或估算。

## 3. 极简落点

### 3.1 模块边界

表格括号内数字的图例：**跟在文件/包名后的是行数**（上游 `wc -l` 口径，如 service(167)、gen(128)）；**跟在模块名后的是 archtest 层级**（如 listing/read(5)、admin/supplier(6)）。

| 模块 | 处置 | 关键约束 |
|---|---|---|
| `internal/supplier` | 扁平化为根包：repo 与 http 文件同包（`package supplier`），处理器直调本包 SQL；service(167) 与 gen(128) 删，wire 改调扁平后的构造函数 | 现有构造链亲验：`repo.New(pool, begin)`（repo.go:29）+ `WithBlobs(assets, catalog *sign.Account)`（repo.go:40-43，platform/r2/sigv4 签名账号，由 wire 传入）——设计文本写「supplier.New(pool, BeginApp, blobs)」，blobs 即现有 WithBlobs 链合入构造参数，与 C2 删除的 admin 侧 catalog_blob.go（admin/service.BlobPort 的 LoopbackBlob，wire_ops_admin_mcp.go:211 装配）**不是同一个东西**，互不牵连。archtest level 3 不变 |
| `internal/supply` | 扁平化为根包：handler(282) + catalog 读(253) + jsonbox(118) 同包；**service、repo.go、orders、binding_write 全删**（对抗轮次修正：repo.go:13 import supply/gen、:32-64 GetBinding 查 sc_listing_bindings，00355 DROP 该表后是死读，同批删） | 不扁平化则 http 直调 repo 踩 archtest sameUnit（`arch_test.go:204-218` http 允许集 {service,domain,contract,gen} 无 repo） |
| `internal/supplier/contract` | 新立：`Denial(Facts)`（8 码、顺序固定、无 ProductPublished）+ BriefValid + CanonicalBrief/prompt_rules + ocr_prompt.ru.txt embed | prompt 按粒度拆：prompt_rules.go 与 BriefValid 无 core import 可迁；Compose/BuildPreview 用 outcome.Fail（supplier_prompt.go:115/:214，行号经核验：:115 在 NormalizeTags 内），连同 shared.go 的 fail 包装（依赖 core/contract 与 outcome）留在 admin/supplier/contract |
| `internal/admin/supplier` | level 6，吸收 admin/x1 全部 repo（约 200+ 处依赖重接线，见 C6），平台端唯一写入口 | 继续走 admin/core/repo 的 Gate/Identity/AssertWrite/LockSource/LockProduct |
| `internal/admin` | level 7：admin/http 留 32 条 supplier 路由；admin/service 保留 orchestration（x1/dbs/prompts/cash/accounts/x1storage+ports），删 catalog/catalog_image/procure | admin/domain 删 catalog.go 前先迁出 DecodeJSON（agents/procure 共用）与 x1_alias.go(103) |
| `internal/listing/read/http` | 保留 ON CONFLICT 与 409 `supplier_not_listable`（`supplier_card.go:38-39/:72-79`），可上架阶梯改调 `supplier/contract.Denial` | 409 wire 契约与 openapi 枚举不动 |
| `internal/delegate` | 删第二套 Actions 端口与 Ship 链；保留 settleDispatch 与 creditFactory | 钱包写口 3→2，见 C16 |
| `internal/catalog/http` | live.go 是类目快照唯一写者并新增写 content_digest；reads.go 删过期预取 DELETE，freshness 面板改 join cache.fetched_at_ms | cache 行从此持久：过期未重同步的行在卖家侧判定为 catalog_expired（可恢复），不再消失 |
| `internal/platform/*`、`admin/core/repo/supply.go` | 不动 | — |

### 3.2 目标数据模型（全部走 00350–00357）

| 表 | 处置 |
|---|---|
| `sc_products` | 保留；吸收 offers 两列 `cost_cents`/`shipping_cost_cents`（00354，attnum 37/38）；删 `prompt_content`/`fixed_tags`（00352，迁移 00165 与 00270 两次回填——「两次回填」出处为设计 dataModel 00352 段自述，本 session 未复核回填覆盖面，Go 读点 0 为上游 grep 结论） |
| `sc_skus` | 保留不合并。**UNIQUE 裁决（本 session 亲验）**：00119:51 建表时 `ix_sc_skus_product` 是普通索引，**00265:34 追加 `sc_skus_product_unique UNIQUE(product_id)`**——product_id 现在有 UNIQUE，独立核验稿「无 UNIQUE、1:1 仅靠写者纪律」只查了 00119，被 00265 推翻。不合并的理由是两条 RESTRICT 外键钉住 + 1:1 本身不构成合并必要性，不是「无 UNIQUE」。`published` 与 sc_products.published 保持两列，删 admin/catalog 后 SetPublished（x1.go:287-300）是唯一写者、同事务双写 |
| `sc_sources` | 保留；删 `view_prefs`（00357，三步发布最后）与 `schema_revision`（00352，3 UPDATE 0 SELECT，上游 grep） |
| `sc_source_offers` | 00354 折叠进 sc_products 后 DROP；`ck_sc_source_offers_nonempty` 降级为写者约定（upsertOffer 两空置 NULL），代价上限＝未来误写 (NULL,NULL) 只被读成「没有报价」。**折叠前提被 00265:34 的 UNIQUE 加强为 schema 保证**（见上） |
| `sc_orders`/`sc_order_lines`/`sc_order_quotes`/`sc_procurements`/`sc_listing_bindings` | 00355 五表 DROP，顺序 procurements→order_lines→orders→quotes→listing_bindings（闭集，入边 FK 无外部引用）。硬前置：`payment_orders` 中 `product='platform_goods' AND status='pending'` = 0 |
| `supplier_ozon_configs` | 保留；00353 删 `prompt_text`/`fixed_tags`（prompt_revisions 的发布镜像）。删后：展示/回带=最新 revision；PromptValid=published_revision 那版的 BriefValid，草稿永不满足上架门。`state` 列保留（00165:35 CHECK ('valid','needs_reconfiguration')，亲验） |
| `prompt_revisions`、`sc_source_prop_defs`、`sc_source_members`、钱包三表、`sc_price_versions`、`listing_cards`、`shipping_sku_bindings` | 保留不动。shipping_sku_bindings 仅作为不合并 sc_skus 的理由被引用（对 sc_skus 的 RESTRICT 外键之一），本方案不触碰 |
| `ozon_catalog_schema_cache` | 00350 加 `content_digest text` + CHECK `^sha256:[0-9a-f]{64}$`，由 live.go:203-223 同条 INSERT 写入，值 = `domain.SemanticRevision`（material.go:13-35） |
| `ozon_category_current`/`ozon_dictionary_current` | 00351 先 DROP dictionary 再 DROP category（00164:41 CASCADE，显式先删子表） |
| `supplier_media_objects` | 00356：CREATE OR REPLACE GC fence 函数去三分支后 DROP TABLE（Go 0 引用、无 INSERT，上游 grep；fence 只认 teams\|workspaces 的 sha256 键，从未生效） |
| media/specs 四列（sc_products/sc_skus） | **保留**：supply 两条保留路由与公开站的真实读点；删 writer 后变只读数据，新商品 media=[] 走 gallery 兜底、specs={} 不渲染规格区；是否后续 DROP 待生产普查 |

RLS 现状（按表写对，不新增；本 session 亲验策略机制）：supplier_wallets/ledger/withdrawals（00258:118-179）、sc_source_members（00203:148）、delegate_*（00258:93-107）、**listing_cards（00078:103-106 tenant_isolation）**有 ENABLE+FORCE；sc_products/sc_skus/sc_sources/supplier_ozon_configs/prompt_revisions 没有。两类表的失败模式不同：FORCE RLS 表的策略 `FOR ALL TO podhub_app` 以 session 变量为条件（00258:120-136 亲验：source 隔离走 `current_setting('app.current_supplier_user_id')` + sc_source_members 成员校验，staff 走 `current_setting('app.staff_access')='1'`）——**绕开 Gate（未设置这些变量的连接）两条策略都不满足，读到 0 行**，这就是「静默 0 行」的机制；而无 RLS 的商库五表，绕开 Gate 的裸 SQL **看见全表**，所以这些表的新 SQL 必须继续走 Gate 的 Identity+created_by 谓词，绕开不是 0 行而是越权全表。

### 3.3 目标接口

- 保留 32 条 `/api/admin/supplier-*`（实测 40 减 8：5 storage + 3 grants）、11 条 `/api/supplier/*`（无 ship）、supply 挂 3 条删 1 条：删 routes.txt:100 `GET /api/platform-catalog`（卖家第二货盘，无页面消费），保留 :101 `GET /api/platform-catalog/products/{product_id}` 与 :102 `GET /api/public/platform-catalog`——后者即「公开站 1 条」，消费链亲验：web/src/features/site/public-site-catalog.tsx:11 `listPublicPlatformCatalog` → http-public-catalog.ts:15 `route("publicPlatformCatalog")` → routes.ts:210 `/api/public/platform-catalog`。routes.txt 324→312 行。
- 删 12 条：:100、:41/:150/:151（admin platform-catalog 3 条）、5 条 supplier-db-storage/*、3 条 supplier-automation/grants。
- **Denial 8 码完整清单（本 session 亲验，Go 与前端逐字一致）**：`source_not_listed`、`product_archived`、`sku_not_published`、`catalog_expired`、`catalog_missing`、`config_needs_reconfiguration`、`catalog_digest_mismatch`、`prompt_invalid`（internal/supplier/domain/catalog.go:44-64 顺序固定；web/src/features/supply-chain/listability-copy.ts:34-43 KNOWN_DENIALS 同集）。`catalog_expired` **在**码表（Freshness=="expired" 时返回）；「needs_reconfiguration」**不是判定码**，是 supplier_ozon_configs.state 的列值（00165:35 CHECK），state 非 'valid' 时 Denial 返回的码是 `config_needs_reconfiguration`。码表保持 8 个（`listability-copy.test.ts:27-43` 断言不变）；409 `supplier_not_listable` 契约不变；已知的口径变化：统一到 supplier 版 Denial 后，空串 digest 行的拒绝码从 catalog_missing 收窄为 catalog_digest_mismatch（supplier/domain/catalog.go:54 只判 nil，admin 版判 nil 或空串），两码同属 fail-closed、前端归并不受影响。
- 前端删 12 个 routes.ts key：8 supplier + 3 adminPlatformCatalog + platformCatalog（routes.ts:208，连带 http-supply-chain.ts:15 的 listPlatformCatalog 与 http-bindings.test.ts:87 的 typeof 断言）。手写 DTO `http-supplier-dbs-types.ts` 是唯一真实契约，保留。
- 顺序固定：openapi → generate → routes → 调用点 → routes.txt（golden 逐字节比对，不同批改必红）。

## 4. 要删的东西

**核验总况：12 项删除主张的独立核验全部 holds=false——「没人依赖」这一理由没有一条成立。** 删除方向本身的背书链：上游裁决轮文本自述「吸收……我逐条验证过的删除（sc_source_offers 零入边 FK、admin/catalog 整包、supply 订单域、ozon current 两表、死列死表）」——**该验证过程本 session 无法复核，只转录声明**；对抗轮次整体 passed=true。C13–C17 无独立核验条目，依据＝上游勘察证据（grep 计数）＋上述裁决声明＋对抗轮次通过，是全案中证据最薄的五刀。每一条都必须按核验补全后的清单执行，照原始清单删必坏编译、测试或 CI。

| # | 删除目标 | 理由（核验后仍然成立的部分） | 依赖核验结果 | 代价与顺序 |
|---|---|---|---|---|
| C1 | internal/supply 订单与绑定半包：repo/orders.go(469)、repo/binding_write.go(154)、repo/jsonbox.go 订单部分、service/portal.go(99)、domain/order.go、repo/repo.go(63)、**http/handler.go:166-232 死代码 filesField/optInt/strictJSON（对抗轮次补）**、GET /api/platform-catalog（routes.txt:100） | 写路径 HTTP 不可达（routes.txt 无 platform-orders/listing_row_id）；Actions 只声明 3 个 catalog 方法 | **核验未通过**。真实依赖：security_cutover_test.go 是订单半包唯一活消费方（:31-32 import、:88-103 RLS 断言、:163-176 状态断言、:478-496 造数）；wire_supply_delegate_supplier.go:19-21/:36-39 唯一装配；billing plans_orders.go:382 settlePlatform、admin/repo/procure.go 8 处、dbs.go:479-493 referenced() 都还碰这些表；历史迁移 00120/00121/00122/00180/00294 与指纹金标（**处置：迁移 sha256 冻结不可改，靠 4.1 的 retiredTables 让指纹跳过；00294 的 RLS 随表消亡**）；docs/parity/supply-parity.md 与 security-hardening.md 两文档（**处置：同步删条目，无测试钉**）；openapi.yaml:11081、web routes.ts:208 三件套；包内测试 4 个文件（orders_flow/jsonbox/handler:74-103/status_test） | 先删 security_cutover_test 订单腿（保留 payment_orders/member_seat_lots/member_seat_lot_credits/redeem_codes/ai_requests/webhook 腿——:88-91 原文含 member_seat_lot_credits，对抗轮次补）→ 删 routes.txt 1 行 + openapi + 前端三件套 → supply 扁平化为根包 → 删半包；约减 1,700 行；security_cutover_test 的逐表 RLS 断言清单少 sc_orders/sc_order_lines 两行 |
| C2 | internal/admin/catalog 整包(758) + admin/service/{catalog.go(226),catalog_image.go(308)} + admin/domain/catalog.go(453) + 3 条路由 + 11 个无路由 dispatch 分支 | sc_products 的第二个写入口与 media/specs 唯一写者、sc_skus.published 第二写者；删后 SetPublished 双写在结构上成立 | **核验未通过**。真实依赖（编译级）：DecodeJSON 定义在 domain/catalog.go:68，被 agents.go:40,79,104,183,203 与 procure.go:48,75 共用，须先迁出；catalog_ports.go(55) 引 domain 别名；catalog_blob.go(93) 实现 BlobPort（**只服务 admin/catalog，随包删；supplier 侧 blobs 是另一条链，见 3.1**）；platform_a2.go:12-13 dispatch；mount_test.go:15 断言 CatalogRoutes()==3、mount.go:109；domain/catalog_test.go(164)+catalog_alias_test.go(66)；a2_guard_test.go:22 期望 403，删路由变 404；routes.txt:41,150,151 golden；openapi.yaml:6574,6623,6690 与生成物；mount.go:231-236 CSRF 死分支与 identity/classify.go:125 特判；archtest level 表陈旧条目；catalog_whitelist_test.go | 先迁 DecodeJSON+msgBadCatalogJSON → 删包与服务 → 改 a2_guard_test → 重生成 openapi/routes；约减 1,745 行 + 3 条路由 |
| C3 | internal/admin/repo/procure.go(593) + admin/service/procure.go(133) + procure_ports.go + procure_types.go + deps.Procure + billing settlePlatform/EdgePlatformGoods + **5 张订单表（00355）** | platform-procurements 路由与 openapi 均 0 条；deps.Procure 零读取；全仓唯一建 platform_goods 支付单点 supply/repo/orders.go:226 随 C1 消失 | **核验未通过**。真实依赖：dbs.go:479-493 referenced()（本 session 亲验为**五路** COUNT：sc_listing_bindings/sc_order_quotes/sc_orders/sc_order_lines/sc_price_versions）被 DeleteDb(:196)/DeleteRow(:417) 两个活 DELETE 路由调用；指纹（fingerprint.go:90 硬编码 132 表 + 金标含 4 张 sc_ 订单表）；security_cutover_test:165-178/:470-495；billing/payments_test.go:23；supply orders_flow_test.go:66-122；00347 CHECK 仍含 'platform_goods'（枚举值保留，同 payment_orders 处理，不改）；活路由 PUT /api/admin/orders/{public_id}/confirm 的 default 分支 | **硬门：删前必须 `SELECT count(*) FROM payment_orders WHERE product='platform_goods' AND status='pending'` = 0；普查未跑，且结果是时点值——批 0 普查后发布路径仍可能产生新单（该活路由在营），00355 合入临前必须复验一次**。非 0 先逐单确认/取消，否则整刀延后。settlePlatform 的 UPDATE 在表 DROP 后是报错不是 0 行，plan_orders.go:330-354 switch、:379-396 settlePlatform、order_machine.go:8,19 必须同批删；约减 726 行 + 5 表；不可逆 |
| C4 | 5 条 /api/admin/supplier-db-storage/* + x1storage.go 目录半部 + supplier_x1.go:82 死分支 + web 5 个封装 | 唯一消费方是 media-storage-tree.test.ts（仅 supplierDbStorageObjects 一条）+ settings-visual.browser.tsx:142 mock；行上传由三条 uploads 路由承担 | **核验未通过**。真实依赖：settings-visual.browser.tsx:142 在 tsconfig include 内，不改则 tsc 失败；routes.txt:49,160-163 golden；supplier_x1_test.go 约 20 处与保留断言交织、supplier_test.go:98、mount_test.go:36；openapi 5 条路径 + schema 重生成、commands.ts:375-383 别名、http-integrations.ts:39-45 import；**共用函数不可粗切**：uploadFromIssued(:270)、verifyObject、callOrigin(:21)、root(:43)、DecodeStorageUpload(supplier_requests.go:25) 树/行上传共用 | 按函数边界切（行号经核验修正）：IssueRowUpload(:451)/issueLargePSD(:496)/AbortRowUpload(:534)/ConfirmRowUpload(:560)/completeMultipart(:633) 留下，verifyObject(:363) 留下；StorageRoot（supplier_storage.go:54）与 UploadBody/ConfirmedUpload/MultipartPlan/UploadPart（x1_alias.go）搬进 admin/supplier/contract；约减 510 行 Go + 40 行 web |
| C5 | 3 条 /api/admin/supplier-automation/grants + supplier_catalog scope + repo/grants.go(168) + web 分支 | MCP 只注册 6 个 workspace.* 工具，无 supplier:* action；授权换不到任何调用 | **核验未通过**。真实依赖：routes golden 三角（routes.txt:48,158,159 + routes_openapi_test 只缩不涨）；supplier_test.go:108-111 断言 401，删路由变 404；automation/domain/rules.go:195-208 的 supplier:* 空 cap 映射与 grant.go:10,43-47 是 00263 CHECK 的 Go 镜像（测试钉着，**镜像分支保留、死映射随刀删**——对抗轮次补）；web 共用文件 http-automation-grants.ts 的类型与三元分支（ScopedAutomationGrantView schema 被 catalog scope 共用，不能连带删）；存量 grant 行的唯一撤销入口就是这 3 条路由 | **00263 CHECK 不改**（supplier_catalog 枚举值残留无害，同 00347 处理；因此不动指纹约束）。先落一次性 DELETE 迁移清存量行（**需追加一个迁移号，实施时取 manifest 尾下一个空号；若树未前进即 00358**）→ 删路由/scope/web → store.go:432,479 对存量 token 是 fail-closed（401），持有者立即失效；约减 350 行 |
| C6 | internal/admin/x1 整单元(2971) 并入 internal/admin/supplier，删 admin/domain/x1_alias.go(103) | 同 level 6、写同一批表、仅 wire_ops_admin_mcp.go:21,188,240 一处装配；x1_alias 是 33 别名 + 11 转发 | **核验未通过**（不是死代码，是约 200+ 处依赖的重接线）。真实依赖：service/ports.go:41-51 Rows 端口 12 处别名；service/x1storage.go 约 82 处；service/cash.go:10,19；service/x1.go 用到 :190（不止 :171）；http/supplier_x1.go:273-287、supplier.go:367、supplier_test.go:173；domain/supplier_prompt_test.go（第五个依赖文件，清单原漏）+ testdata/x1 跨包夹具（http/supplier_x1_test.go:348）；archtest level 表删一行；docs 三处；outcome.go:2 注释 | admin/domain 四文件 56 处 x1contract 引用改直引（33 只是别名数）；prompt 按粒度拆（见 3.1）；约减 1,400 行净额；零行为变更；单独提交 |
| C7 | 上架阶梯收成 internal/supplier/contract.Denial 一份（supplier/domain/catalog.go:44-65、admin/x1/contract/supplier_row.go:150-195、listing supplier_card.go:160-186、web gallery-model.ts 投影） | 三份 Go + 一份 TS 互相矛盾：supplier 侧 PromptValid 写死 false（repo/catalog.go:147 亲验，注释「ocr_prompt::validate_brief body is not in the spec」——因此**当前生产行为是卖家货盘全墙 denial=prompt_invalid、listable=false**，上游基线认定为实现缺陷而非需求死亡）；listing 侧 `strings.TrimSpace(promptText) != ""`（supplier_card.go:169 亲验）；admin 侧 BriefValid；listing 版还把 !published\|\|!sku 合成一个 case | **核验未通过**。四份副本各有活调用方与钉死测试：supplier 版喂卖家货盘 listable（openapi 枚举 + gallery/队列/导入过滤 7+ 模块）；admin 版喂就绪徽标与「待复核」筛选（supplier-db-filters.tsx:27，码 config_needs_reconfiguration）+ openapi SupplierOzonConfigDenial；listing 版是 409 wire 契约（listing_hot_test.go:480-483 钉死 product_archived 码）；web 码表在 listability-copy.ts:30-45 被 7+ 模块消费 | 统一口径必须同时保 8 码表、409 契约、openapi 枚举；PromptValid 收敛为 published_revision 的 BriefValid（C11）——**副作用是修复全墙不可选**；admin 的 ConfigDenial＝「覆写 listed/archived/sku/prompt 后调同一 Denial」，ozonOK 从四码负列表改 `configDenial==""`；已知口径变化见 3.3；约减 160 行 Go + 40 行 web |
| C8 | supplier/supply 的 service 层与生成物：supplier/service(167)+gen(128)、supply/service(99)+repo.go、supplier/http/gen、supply/http/gen、sqlc.yaml 对应段 | 两个 service 全是直通或恒定拒绝（上游亲读） | **核验未通过**。设计原句「生成物除 supplier/gen 外零导入」被核验**整体推翻**：supply/gen 同样被 supply/repo/repo.go:13 导入（GetBinding 用 sqlcgen.GetListingBinding）。正确结论：零导入的只有三个 http/gen；supplier/gen 与 supply/gen 各有运行时使用者，必须先内联/同批删。其余真实依赖：wire_supply_delegate_supplier.go:38,47 直接装配两个 service，删前必改；supplier/gen 被 repo.go:13 import、:43/:61 用 ListWallets/ListWithdrawals（tx_test/rls_test 也调）；supply 的 repo.go/binding.go/ports.go/binding_test.go/supply/gen 同批删（对抗轮次认定的两刀间漏账）；api/codegen/{supplier,supply}.yaml 不删则 make generate 复活生成物 | 顺序固定：先改 wire 两行（repo 直接充当 Actions）→ 内联 repo.go 两条 sqlc 查询为手写 SQL → 删 gen 与 yaml 与 sqlc 段 → 两包扁平化 → 删 service；约减 560 行；archtest level 不变（3） |
| C9 | sc_source_offers 折叠进 sc_products（00354） | UNIQUE(source_id,sku_id) + 一 sku 一产品，二维键退化；入边 FK 为 0（迁移全量 grep 亲验）；对抗轮次做了改写推演：(NULL,NULL)→COALESCE=0 与今天的 missing 计数分支同归 | **核验未通过**（指「没人依赖」）。真实依赖：写 1（x1_write.go:84-95）、删 1（dbs.go:495）、读 6（x1.go:43、supplier/repo/catalog.go:193、write.go:198、read.go:465,477、admin_settle.go:95）——三处是结算金额 SQL；指纹金标（fingerprint.go:90 的 132 表 + expected-head-fingerprint.json:16960，须走 retiredTables）；x1_test.go:335 dropX1 清理 SQL；web 运费 0→null 语义注释（supplier-row-info-tab.tsx:189-206）。**核验稿的「sc_skus.product_id 无 UNIQUE、1:1 仅靠写者纪律」被本 session 推翻**：00265:34 已有 UNIQUE（见 3.2），折叠前提是 schema 保证 | INSERT 列清单加两列；改写必须经 sc_products 且保留 source 谓词与「无报价=0 且被 >0 过滤」；**硬前置（对账）：00354 上线前把三处金额 SQL（admin_settle.go:81-107、read.go:452-491、write.go:186-214）旧口径结果落快照，切换后新口径 diff 逐行相等，另补一条带 cost+shipping 的集成金标断言 quote/payout 不变** |
| C10 | ozon_category_current 与 ozon_dictionary_current（00350+00351 两步）+ 7 处读点 join | 生产 0 写入者；三个 catalog_* 码恒成立 | **核验未通过**。真实依赖（对方清单漏）：三处测试夹具 INSERT——listing_hot_test.go:451-456、listing_write_test.go:259-263、listing_write_test.go:370-379（第三处喂 http_rows.go:202 rejectTags 的 409 路径，被 write_test:49 与 fillblank_test:38 调用）；指纹链（132 表硬编码 + :407 列数 diff，00350 加列也须 postRustColumns 先行）；listing_intents_test.go:266-282 向 cache INSERT 不带 digest（00350 列须可空或有默认） | 00350 给 cache 加 content_digest（可空或带默认，避免夹具坏）+ 删 reads.go:112-124 预取 DELETE + **同改 tokens.go:83-96 attributeID()：cache 的 attribute_id 是 JSON 字符串（live.go:724/:346），现解析只认数字会得零 key、禁用词门永久 fail-open；改法＝接受字符串与数字，解析不出→503 rules_unavailable（fail-closed），补 marshalCatalogFields 真实形状用例** → 重同步按 `SELECT DISTINCT description_category_id,type_id,language FROM supplier_ozon_configs WHERE description_category_id>0` 逐坐标执行（'default' 与 'zh_hans' 两套都要）→ 7 读点切 cache → 夹具改写（先例 listing_write_test.go:245-256）→ 00351 先 DROP dictionary 再 DROP category。**未重同步坐标的行：state 列停在 'needs_reconfiguration'，卖家/admin 看到的判定码是 config_needs_reconfiguration，与今天一致** |
| C11 | supplier_ozon_configs 的 prompt_text 与 fixed_tags 两列（00353） | 发布镜像：x1_prompt.go:258 发布时抄入；权威是 prompt_revisions（append-only 触发器 + published_revision 复合外键） | **核验未通过**。真实依赖：读点合计 **21 处**（原 17 + 对抗轮次补 4：x1.go:55,:57、prompts.go:29、supplier/repo/catalog.go:167 的 fixed_tags 兜底）；listing_hot_test.go:443-448 直接 INSERT 不建 revision，须同批改；指纹 retiredColumns 先行。**语义坑**：putOzon 在已发布时冻结旧值（x1_write.go:444-447），recordIntent 在 pointer!=nil 时可插入全空白 revision（:508-542）——替换门固定 `btrim(brief) <> ''` 等价性由对抗轮次推演确认 | **硬前置（核对）：`SELECT count(*) FROM supplier_ozon_configs c WHERE btrim(c.prompt_text)<>'' AND NOT EXISTS (SELECT 1 FROM prompt_revisions r WHERE r.product_id=c.product_id AND r.revision=c.published_revision)` 非 0 先补 revision；普查未跑，且普查后发布路径仍在写镜像（x1_prompt.go:258 在营），00353 合入临前必须重跑一次**。三个门替换表达式固定 `btrim(brief) <> ''`；DTO 展示值=最新 revision；草稿不满足上架门 |
| C12 | dbs.go:479-493 referenced() 的多路 COUNT | 五路里四路随 00355 消失，仅 sc_price_versions 留存 | **核验未通过**。真实依赖：DeleteDb(:196) 与 DeleteRow(:417) 两个活 DELETE 路由靠它做「真删 vs 归档」分流；删掉预检会撞 RESTRICT FK 使事务 abort（WithTx 无 SAVEPOINT）或留下悬挂引用；sc_order_lines.platform_sku_id 是无 FK 裸列 | 缩成单条 EXISTS(sc_price_versions)，**保留归档分流语义**；不改 listing_cards（该表 00078:103-106 FORCE RLS + tenant_isolation，策略只见本 org——写成删除保护是假安全感）；跨 org 软引用今天就没有兜底，不新增也不声称新增 |
| C13 | supplier_media_objects + fence 分支（00356） | Go 0 引用（上游 grep）、无 INSERT；GC 只认 teams\|workspaces 的 sha256 键 | **无独立核验条目**（依据见本节开头声明链） | 00290 ≤341 且 sha256 冻结，只能在 00356 里 CREATE OR REPLACE 函数去分支再 DROP TABLE；一条迁移；无业务影响 |
| C14 | 死列：sc_products.{prompt_content,fixed_tags}、sc_sources.schema_revision（00352）；sc_sources.view_prefs（00357，三步发布后） | prompt_content 已由 00165+00270 回填（设计自述，未复核）、Go 读点 0（上游 grep）；schema_revision 3 UPDATE 0 SELECT；view_prefs 前端每次回带但无人消费 | **无独立核验条目**（依据见本节开头声明链）；viewPrefs 两难经上游亲读（dbinput.go:18-24 hasOnly 拒未知键且 requireKeys 强制必填，先删任一侧另一侧 400） | 6 个 DROP COLUMN 分布在**三条**迁移：00352 三列（sc_products.prompt_content、sc_products.fixed_tags、sc_sources.schema_revision）、00353 两列（supplier_ozon_configs，属 C11 刀）、00357 一列（sc_sources.view_prefs）——设计原稿「6 个分两条」与实际分配不符，以本表为准。viewPrefs 三步：①后端 requireKeys 去掉 viewPrefs、hasOnly 暂留容忍旧前端 → ②前端 dbToUpsert/类型/fixtures 停发 → ③后端从 hasOnly 删键 + 00357 DROP COLUMN。**直接两步会在某一方向 400，主台账写路径在窗口内不可用** |
| C15 | 三个零导入生成包：admin/http/gen(1210)、supplier/http/gen、supply/http/gen 与 codegen yaml | 排除自身 0 导入；纯负债且会重新生成 | 部分核验（C8 覆盖三个 http/gen 零导入；admin/http/gen 1210 行零导入经核验确认）；supplier/gen 与 supply/gen 不在本刀（C8 先内联/同批删）——**全案合计删 5 个生成目录**，设计原稿「四个」把 supplier/gen 计入本条又留在 C8，口径以本表为准 | make generate 同批跑；约减 1,218 行 |
| C16 | supplier 死 Ship 链 + 五个零调用状态机函数 + Route 结构体两列（RustOperationID/Source，suppliers.go:24-31——**是 Go 路由表结构体的两个字段，不是数据库列，无迁移**） | 无路由无调用者（前端注释自认无 ship 客户端；上游 grep 生产调用点 0）；**生效的状态迁移在 SQL 函数（00205_supplier_portal_actions.sql 的 delegate_supplier_accept/reject 等 :78/:128/:184）与 UPDATE 语句的 WHERE 守卫里**，Go 纯函数（DispatchEdge/TransitionWithdrawal/TransitionOrder）只是影子副本；两列的论据本 session 亲验：SupplierRoutes() 40 条、OperationID 与 RustOperationID 40/40 逐字相同、13 个唯一 Source 全指向 `src/`（`[ -d src ]` → 不存在）、全仓 0 读点（上游 grep） | **无独立核验条目**（依据见本节开头声明链；对抗轮次 verdict 第 (6) 条复核「11 条无 ship、删后钱包写口 3→2 成立」） | **钱包三个写口**：supplier/repo/write.go:279（moveCash，提现申请扣减）、admin/supplier/repo/cash.go:136（moveCash，审批放款/驳回）、delegate/repo/admin_settle.go:238（creditFactory，派单结算入账）。本刀删的是 supplier 侧死 Ship 链触发的 settleDispatch 写入（write.go:65/:73 死链），**moveCash 的提现申请写口保留**，剩 admin cash.go 与 delegate creditFactory 两个（write.go:391 withdrawal_hold 保留）；各自表驱动测试同删；约减 570 行 |
| C17 | 前端：5 个 storage 封装、grant 分支、routes.ts 12 个 key、supplier-readiness 副本、gallery 再映射、viewPrefs 往返、listPlatformCatalog | 对应被删路由与第 5 份 readiness 副本 | **无独立核验条目**；对抗轮次通过。上游证据：mounted.test.ts:105 断言**已挂载路由键数 >250**，上游运行时实为 277 通过（命令 `bun test src/api/mounted.test.ts src/api/routes.test.ts`，3 pass） | 12 个 key = 8 supplier + 3 adminPlatformCatalog + routes.ts:208 platformCatalog；顺序 openapi→generate→routes→调用点→routes.txt；约减 1,800 行 web；viewPrefs 按三步走 |

### 4.1 指纹与迁移守门（所有 DROP 的前置机制）

- 迁移编号是硬约束：00342–00349 已被占用（storage_registry/transit_clear/subscription 系列/jobs_drain_columns，manifest 尾 8 条 sha256 上游亲验）。本方案 00350–00357 + grants 清理 1 个追加号。**实施时必须重新 `ls db/migrations` 取下一个空号**——上一稿就在这一点上基于旧树写错了编号。
- baselineMax=341、已合并文件 sha256 冻结、重复版本被拒（migrate_guard_test.go:71-104，上游亲验）。
- 指纹侧新增：`retiredTables`（9 张）实现为「构建 want 后一次性过滤」，同时覆盖 missing/extra、diffTable、diffRowCounts（fingerprint.go:343-367 对每张 want 表 SELECT count(*)，不过滤必 fatal）；`retiredColumns`（6 列）按名过滤；`retiredConstraints`（2 条：sc_sources_schema_revision_positive、supplier_ozon_configs_fixed_tags_array）；新列登记 `postRustColumns`（content_digest 序号 8；sc_products.cost_cents/shipping_cost_cents 序号 37/38，上游 session 指纹 JSON 亲验：35 列、max ordinal=36、ordinal 17 有历史空洞）；新 CHECK 走 postRustConstraints。DROP COLUMN 不重排 attnum，按名过滤后其余列 ordinal 仍对得上。
- **该机制本 session 无 Docker 未实跑**，是方案最大的未验证机制点。

## 5. 施工顺序

原则：每批一次提交，批内把列出测试同批改至绿，不提交批内中间态；恢复＝revert 单批提交。无 Docker 环境下 tests/integration 全程无法本地验证，指纹机制与 DROP 的组合只在静态层面成立——首批合入后必须在有 Docker 的环境跑一次全量集成再继续。

| 批 | 内容 | 完成后系统状态 | 会红/须同批改的测试 | 恢复 |
|---|---|---|---|---|
| 批 0（不碰代码） | 生产普查：platform_goods pending 计数（C3 硬门）、prompt 镜像核对 SQL（C11 硬门）、（可选）media/specs 非空行数（只影响后续是否 DROP）。**两项硬门结论都是时点值，分别为批 3 / 批 6 临前复验，见 C3/C11** | 代码零变化 | 无 | 无需 |
| 批 1（守门机制） | 指纹 testkit 落地 retiredTables/retiredColumns/retiredConstraints/postRustColumns/postRustConstraints（先只加机制，清单可为空）；grants 清理迁移取号 | 行为零变化；后续所有 DROP 的安全网就位 | tests/testkit 单测新增；tests/integration 需 Docker 验证（未跑） | revert |
| 批 2（无 schema 的路由刀） | C4 storage 5 路由 + C5 grants 3 路由 + grants 死映射 + C2 admin/catalog（先迁 DecodeJSON）+ 对应 web/生成物 + C16 的 Route 两列（纯 Go 字段，无迁移） | admin 路由 43→32；sc_products.media/specs 变只读数据；MCP 不变 | routes golden、routes_openapi、supplier_x1_test（约 20 处）、supplier_test:98/:108-111、mount_test:15/:36、a2_guard_test:22、catalog_whitelist_test、grant/rules 相关、bun 的 mounted/routes/grant-options | revert |
| 批 3（supply 订单域整链 + 00355） | C1 supply 半包扁平化 + C3 procure/settlePlatform/五表 DROP + security_cutover_test 删腿（保留六腿含 member_seat_lot_credits）+ C12 referenced() 缩成 EXISTS + openapi/前端三件套 | 订单域进程内无创建者、表已删；dbs.go 删除路径走 sc_price_versions 单一预检；钱包写口 3→2 | security_cutover_test、orders_flow_test（删）、billing payments_test:23、routes golden、bun | **不可逆（表已 DROP）**；代码侧 revert + 数据侧只能靠备份恢复——备份责任人见第 7 节问题 9 |
| 批 4（x1 并入 + 阶梯收敛，零 schema） | C6 x1→admin/supplier + C7 Denial 收敛 + prompt 按粒度拆分 + archtest level 表删一行 | 平台端唯一写入口= admin/supplier；Denial 一份；空串 digest 行拒绝码 catalog_missing→catalog_digest_mismatch（fail-closed）；**卖家货盘从全墙 prompt_invalid 恢复为真实判定** | archtest、admin/domain 测试（含 supplier_prompt_test 与 testdata/x1 夹具）、listability 8 码断言（不变）、x1 相关 | revert |
| 批 5（类目戳切 cache + 00350 + 00351） | C10：digest 列 + 删预取 DELETE + 7 读点切 cache + rejectTags attributeID 修复 + 夹具改写 + 重同步 + 两表 DROP | 类目快照唯一事实源= cache 持久行；未重同步坐标 state 停在 'needs_reconfiguration'、判定码 config_needs_reconfiguration（与今天一致，不是恶化） | listing_hot/listing_write/fillblank/listing_intents 夹具、tokens 用例、指纹 retiredTables（+2） | 迁移前向滚；未重同步坐标可逐行重存恢复 |
| 批 6（列级收口 00352/00353/00354/00356） | C11 prompt 镜像两列（核对 SQL **临前重跑**通过后）+ C9 offers 折叠（快照对账通过后）+ C13 media_objects + C14 死列 | 台账列收敛完成；offers 语义并入 sc_products | 三处金额 SQL 对账 diff、集成金标、指纹 retiredColumns/postRustColumns | 00354 前有快照可回切；列 DROP 后靠备份 |
| 批 7（结构收尾 + viewPrefs 三步 + 前端） | C8 wire/内联/删 gen/扁平化 + C15 + C17 + 00357 viewPrefs（①②③跨三个发布） | supplier/supply 各为根包；5 个生成目录消失；前端死 key 清零 | tx_test/rls_test（改手写 SQL 断言）、bun 全量、**viewPrefs 窗口内后端处于「容忍未知键」宽松态，只能短驻** | 各步独立 revert；viewPrefs 三步各自可停 |

依赖关系上必须锁死的顺序：批 1 → 所有含 DROP 的批；批 2 的 admin/catalog 删除 → C9 的「x1 是唯一 sku 写者」（现已叠加 00265 UNIQUE 兜底）；批 3 的五表 DROP → C12 才能缩成单条 EXISTS（提前缩会在表还在时丢保护）；批 5 的 00350 → 00351；C8 的内联 → 删 supplier/gen；00357 永远最后。

## 6. 明确不做的

- **sc_skus 不合并进 sc_products**：被 sc_price_versions 与 shipping_sku_bindings 两条 RESTRICT 钉住；00265:34 的 UNIQUE(product_id) 证明 1:1，但 1:1 是合并的可行性不是必要性。
- **可上架判定不进 SQL 视图**（上游裁决否决备选方案 1 的中心机制）：全仓 0 个 CREATE VIEW；00191 的授权只覆盖 relkind r/p/S；BriefValid 是纯 Go 六行卡校验无法进 SQL；http 直连 repo 违反 arch_test.go:210/222。
- **备选方案 2 的主键改造不做**（改 sc_products/sc_skus 的主键为 product_id 直指）：6 条以 sku_id 为值的外键无法不变值重指；要 DROP 带 NOT NULL RESTRICT 外键的 sc_price_versions；还会删掉公开站在用的 specs。（「sc_items」是被否决方案文本里的表名，本库实际表为 sc_products/sc_skus。）
- **payment_orders 不删、00347 CHECK 的 'platform_goods' 与 00263 CHECK 的 'supplier_catalog' 枚举值不动**：subscription/wallet_topup 在用前者；枚举值残留无害，收窄反而牵动指纹。
- **SemanticRevision 不进一步按 key 排序**：会牵连 listing 快照 pin，本轮不动；残余暴露＝Ozon 只调整字段顺序时重同步让配置翻 catalog_digest_mismatch（fail-closed），见第 7 节。
- **跨 org listing_cards 软引用不新增数据库兜底**：今天就没有，不新增也不声称新增。
- **media/specs 四列保留**：不再依赖生产普查做删除决策；是否后续 DROP 留待普查（批 0 可选项）。
- **internal/platform/*、admin/core/repo/supply.go、admin/service 其余 orchestration 不动**。
- **前端 supplier-dbs（约 15.5k）与 supply-chain（约 7.5k）两块受众 UI 不减**。
- **不补 Rust 侧任何实现、不重建 src/ 对照**；docs/parity 文档与 archtest level 表只做同步删除条目，不重写。

## 7. 需要用户拍板的问题

1. **platform_goods pending 存量**（批 0 硬门，批 3 临前复验）：`SELECT count(*) FROM payment_orders WHERE product='platform_goods' AND status='pending'` 若非 0，是逐单清零后删，还是整刀（C3+批 3 的表 DROP 部分）延后？非 0 强删的后果是已收款订单在活路由上永远「订单商品无效」。
2. **prompt 镜像核对 SQL**（批 0 硬门，批 6 临前重跑）：非 0 行是接受「先补 revision 再删列」的运维成本，还是放弃 00353 保留镜像列？
3. **卖家解锁的运维窗口**：批 5 重同步（含 'default' 与 'zh_hans' 两套语言、逐坐标执行、每行配置再保存一次）谁做、什么窗口做？没有这个承诺就不能宣称卖家解锁——未同步坐标的判定码停留 config_needs_reconfiguration 与今天一致，但今天恒为 catalog_missing 的行也不会自己变好。
4. **viewPrefs 三步发布的窗口纪律**（00357）：三步跨三个发布，中间态后端「容忍未知键」，只能短驻——接受这个流程还是干脆保留 view_prefs 列不删？
5. **SemanticRevision 是否按 key 排序哈希**：不改则 Ozon 调整字段顺序的重同步会让配置翻 catalog_digest_mismatch（fail-closed、逐行重存恢复），发生频率无生产数据可估；改则牵连 listing 快照 pin。默认不动，需要明确认可。
6. **grants 清理迁移取号**：追加独立号（树未前进即 00358）还是并入某条现有迁移？影响 manifest 与指纹同步。（00263 CHECK 不改，已定为不做。）
7. **批 3 五表 DROP 前的备份**：谁在哪个时间点做、什么形式（快照/pg_dump）、验收标准是什么（能恢复到 DROP 前的行数与指纹）？没有这条，批 3 的「不可逆」没有退路。
8. **批 0 生产普查的执行者与权限**：生产库访问谁提供、SQL 由谁跑、结果如何留档？这是两个硬门的数据来源，不能口头带过。
9. **指纹机制的首验环境**：retiredTables/postRustColumns 这套机制无 Docker 未实跑，批 1 合入后需要一次有 Docker 环境的全量 tests/integration——这个环境谁提供、什么时候。
10. **media/specs 四列的远期**：批 0 普查做完后，是否立项后续 DROP（本方案不做）。
