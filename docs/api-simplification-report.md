# API 接口简化报告

日期：2026-10-20（含当日遗留事项清理复测）。范围：`api/openapi.yaml` 契约面收缩与归一，及 Go / TypeScript 双端代码对齐。本文数据以本轮工作流产出的契约变更记录、方案要点与校验记录为准；标注「本报告复核」的条目为撰写时在当前仓库重新执行命令确认。

## 1. 背景与目标

本项目按新工程标准重构，允许破坏性变更、不做旧兼容（`AGENTS.md`）。本轮对公开 API 契约做三件事：

1. **删**：移除无生产消费方的接口（判定依据为消费方盘点：web 生产代码引用 > Go 测试引用 > 仅 docs 提及）。
2. **并**：把同一动作的多个入口合并为 body / 参数多态的单一入口，鉴权语义维持各分支现状。
3. **统**：operationId 撞名清零、命名统一 snake_case、schema 信封拍平、tag 与生成包对齐。

风险评级（方案要点）：75 个删除项全部 low，2 个合并项 medium，13 个改名项与 2 个配置重组项 low。

## 2. 接口面变化

### 2.1 数量

| 指标 | 值 | 来源 |
|---|---|---|
| 简化后操作总数 | **376** | 契约 `operationsAfter=376`；本报告复核 `grep -c "operationId:" api/openapi.yaml` = 376，`api/codegen/mcp.yaml:1` 计数注释同为 376 |
| 直接删除 | **75** | 契约 `removed` 数组，脚本计数确认 |
| 合并源操作（随合并移除） | **2** | `POST /api/listing/batch/submit`、`GET /api/billing/usage`（契约 `merges`） |
| 简化前操作总数 | **453** | 反推值：376 + 75 + 2；仓库非 git，无历史版本可直接核验 |

### 2.2 删除清单（75 个，均 low 风险）

按域分组；共性理由：web 生产代码零引用（仅 docs 或仅单测路径级提及），同资源在用的兄弟操作保留。

| 域 | 数量 | 路径 |
|---|---|---|
| admin shipping 全域 | 13 | `shipping-presets`×6（列表/建/读/改/删/apply-product）、`shipping-injections`×4、`shipping-readiness/{sku_id}`、`shipping-sku-bindings`×2 |
| admin platform-catalog 写面 | 11 | products/{id} 的 PUT·images·images/upload·publish·unpublish，skus/{id} 的同款 6 个 |
| admin platform-orders / procurements | 5 | `request-refund`、procurements 列表/claim/dispatch/receipt |
| platform-catalog / platform-orders（supply 域） | 7 | listings/{id}/binding×3、skus/{sku_id}、platform-orders 的建/quotes/查 |
| billing 自助订阅 | 4 | subscription 的 GET/quote/orders、wallet/topups |
| media library | 5 | assets 列表/删/bindings、uploads、uploads finalize（前 4 个为 501 桩，`internal/app/api/not_ported.go`） |
| auth / avatars | 5 | `auth/handoff`、`auth/me`（与在用的 `auth/session` 重复，保留 session）、avatars users·workspaces GET（仅删 GET，同路径 PUT 是生产头像上传）、avatars/me/upload |
| listing | 3 | `rows/{id}/submit`（由 body 多态的 `/api/listing/submit` 覆盖）、`rows/rebuild`、`templates/{id}/multipart/presign`（abort/complete 生产在用保留） |
| seller | 6 | warehouses timeslot、delivery-methods×3、upstream 通配 GET/POST（chi 通配路由同步删） |
| ops | 1 | `ops/voice/chats`（questions/reviews 在用保留） |
| admin 杂项 | 12 | supplier-db-storage confirm、error-digest、ozon-error-catalog、listing packages official 的 PUT/DELETE、`orders/{public_id}`、redeem-codes GET+revoke、support-grants revoke、writer-leases revoke |
| 其它 | 4 | `field-library/{id}`（列表保留）、`workspaces/stores/company-groups`、`stores/{uuid}/status`、`workspace/billing/official-mcp-access` |
| supplier | 1 | `dispatches/{dispatch_id}/ship`（supplier 其余 11 op 有 web 调用保留） |

### 2.3 合并（2 个，medium 风险）

**POST /api/listing/batch/submit → POST /api/listing/submit**
- 同一提交动作两个入口，改为 body 多态：schema 新增 `row_ids` 数组（uuid），200 描述改为 per-row items。
- 路由顺序不变量：`rowIds` 判定必须**先于** `IsDraft`——`shape.go:44-53` 会把任何带 storeId/items 的 body 判为 Draft，批量 body 带 storeId 会被误路由因缺 cardId 400。
- 鉴权维持各分支现状：批量分支内部先过 `submitActor`（`submit_routes.go:173-197`）再 ParseBatch→SendStored，且不过 `draftTagGate`；非 rowIds 路径完全维持现状（tag 检查分支无鉴权直走）。显式不变量：`listing_test.go:114,123,150` 三处无 principal 断言 400 的用例不得变为 401/403。
- 调用方改写（非删除）：web 生产 `send-ozon-transport.ts:98` 与 20 个文件的 `route("listingBatchSubmit")` 引用统随键替换为 `listingSubmit`。

**GET /api/billing/usage → GET /api/billing/usage-stats**
- 两套 usage 读归一：`usage-stats` 新增可选 query 参数 `rollup=1`，按原 `billingUsage` 同策略门控——主管及以上可见，member 得 403『需要主管权限』；响应在 ledger 之外附 organization/member rollup 块。
- member 默认请求不含 rollup，权限不扩宽。

### 2.4 改名

- **路径改名**：`GET /api/listing/runs` → `GET /api/listing/jobs`（operationId `listListingRuns`→`listListingJobs`），与生产形态详情面 `/api/listing/jobs/{id}` 统一（`row-execution.ts:304`）。
- **operationId 改名 34 个**（撞名清零 + 裸单词加域前缀）。代表性案例：裸名 `list`/`create`/`delete`/`verify` 各自与其它域撞名，改为 `adminAiRequestsList`、`notificationList`、`storesList`、`storesCredentialDelete`、`adminIntegrationsAiVerify` 等；`dissolve_workspace` 双保留撞名改 `adminDissolveWorkspace`；`list_for_category` 成对改 `promptsListForCategory` / `videosListForCategory`。
- 修复后 operationId 唯一、`$ref` 无悬挂（素材记录修复后全套校验重跑通过）。

## 3. schema 级简化

- **89 个 data 信封拍平**：69 个 ref 包装删除直指 View、15 个内联提升、4 个数组改 `{items,total}`、1 个描述型直返。典型案例：`MessageCenterMessageView.data→items`、`CatalogTreeResponse.tree→items`。
- `ListingRunView.payload` 改显式 object；`CatalogTreeNode`/`CatalogTreeCacheNode` 去递归 + 补 `parent_id`。
- **原工作流统一 791 个 camelCase 属性与 7 个 query 参数为 snake_case**；本次补齐 11 个内嵌属性，命名回归检查覆盖所有层级。
- **24 个新孤儿 schema GC**。
- **tag 对齐**：auth→workspaces（7 op）、fetch-config→catalog、supply→platform、admin-ai-prices→ai、listing-rules 3 op、billingUsageStats→billing。
- delegate 16 op 与 supplier 11 op 的 summary 按实现改写；`info.description` 重写；`/mcp` 405 description。

### 3.1 codegen 配置重组

- 删 4 份（`billing-usage.yaml`、`listing-rules-list.yaml`、`listing-read.yaml`、`listing-submit.yaml`）、新建 `listing.yaml`、重写 `listing-rules.yaml` 为 `include-tags: listing-rules`（先把 getListingRules/postListingValidate/adminBannedTagsList 三 op retag 到新 tag）。
- `admin.yaml` 删 exclude-operation-ids 补丁；17 份现存配置移除 `exclude-schemas` 递归规避；`supply.yaml` tag→platform；`mcp.yaml` 计数→376；README 重写。
- 本报告复核：`api/codegen/*.yaml` 现为 20 份。

### 3.2 第 2 轮修复：catalog.yaml 的 CatalogErrorCode 重名（本轮唯一失败回环）

- **现象**：`catalog.yaml` 生成报 duplicate typename `CatalogErrorCode`。
- **根因**：retag 使 `GET /api/catalog/fetch-config` 进入 catalog tag 后，其 401/403/500 原引用的命名响应 `CatalogError` 内联展开，code 属性的内联枚举按路径派生类型名 `CatalogErrorCode`（证据 `internal/catalog/http/gen/reads/reads.gen.go:204`，本报告复核该行注释仍在），与姊妹操作（`fetch-config/run`、`fetch-config/wb-credential` 经 `CatalogErrorResponse` 引用的独立枚举 schema `CatalogErrorCode`）在同一个输出里生成第二个同名 TypeDefinition。
- **修复**：GET 的 401/403/500 改为直接 `$ref #/components/schemas/CatalogErrorResponse`（本报告复核 `api/openapi.yaml:13256/13262/13268` 已是 $ref），wire 同形 `{error,code}`，文档化错误码从 5 值内联枚举对齐为共享 9 值枚举；catalog.yaml 不再触达命名响应，catalog-reads 输出不变。
- **验证**（素材实测）：`for cfg in api/codegen/*.yaml; do oapi-codegen -config $cfg api/openapi.yaml; done` 全部 20 份配置连续两轮通过（第 1 轮在 catalog.yaml 复现原错误，修复后 exit 0）。

## 4. 双端代码对齐情况

**本报告复核确认已落地：**

- web：`web/src/features/workflow/submit/send-ozon-transport.ts:98` 已是 `route("listingSubmit")`、`:111` 发送 `row_ids`；`web/src/api/routes.ts` 中 `listingBatchSubmit` 零命中，`"/api/listing/submit"` 在册。
- Go 单测随删：shipping-injections（`x2_test.go`）、platform-procurements（`a2_guard_test.go`）、error-digest / ozon-error-catalog（`adminb_test.go`）、media library（`storage_test.go`）、supply platform-orders（`handler_test.go`）——grep 全部零命中。
- 用例迁移：`internal/app/api/reads_test.go:26,50` 打 `/api/billing/usage-stats` 与 `?rollup=1`；`:27,57` 打 `/api/listing/jobs`；`internal/app/api/submit_routes_test.go:31-33` viewer 403 断言已改为向 `/api/listing/submit` 发同形批量 body。
- 挂载与契约一致：`internal/app/api/mux.go:40` 挂 `GET /api/billing/usage-stats`；spec 中 `"/api/billing/usage"`、`batch/submit`、`shipping-presets` 均零命中。

**素材记录、本报告未逐项复核**：`routes.ts`/`schema.d.ts` regen、`classify.go:117` 分支清理、`docs/parity/identity-parity.md` 更新、UNMOUNTED 名单行删除、20 个文件的 `route()` 引用替换（仅抽查 routes.ts）。

**素材方案与初次复核的出入**：初次复核发现四处「随删/随改」未落地；现已按第 6 节完成清理。

## 5. 校验结果

以下为工作流按时间序记录的 15 条检查（素材给定；**除标注外本报告未复跑**）。多条检查出现两次：第一轮「修复中」表示发现待修问题，修复后重跑：

| 检查 | 首轮状态 | 终态 |
|---|---|---|
| `make generate` + 双端生成 | 修复中 | **通过** |
| `go build` + `go vet` | 修复中 | **通过** |
| `tsc --noEmit` / `tsc` + `vite build` | 修复中 | **通过** |
| `go test ./tests/archtest` | — | **通过** |
| `go test ./...` | 修复中 | **通过（本次收尾复测）** |
| `bun test` | — | **通过** |
| `api:check` 契约同步 | — | **通过** |
| `deadcode` 死代码 | 修复中 | **通过** |
| `lint` | 修复中 | **通过** |

**基线差异说明**：原工作流将 `go test ./...` 记录为「基线即失败」。本次在 Docker PostgreSQL 16 临时库中复现并清理：过期路由与响应断言、旧席位订单夹具、00342–00349 之后的 schema 快照差异，以及遗漏的 HTTP 契约对齐。最终结果见第 6 节；原工作流的失败记录仅保留为历史。

**本报告撰写时实际执行的复核**（命令与输出）：
- `grep -c "operationId:" api/openapi.yaml` → 376（与素材一致）
- `ls api/codegen/*.yaml | wc -l` → 20
- 其余上文章节标注的 grep/sed 抽查。

## 6. 遗留事项清理（2026-10-20）

1. **Go 基线失败已清理。** `go test -timeout 25m ./...` 全部通过，含 Docker PostgreSQL 集成测试；`go vet ./...` 通过。数据库对拍继续保留 Rust head 原始快照，仅明确列出后续 migration 的列、索引、约束、函数、触发器和四档套餐差异，不修改生产 migration。删除已退役席位售卖/抵扣测试，并补充新席位订单必须被 `payment_orders_product_shape` 拒绝的断言。
2. **旧路由残留已删除。** 移除 batch submit、媒体库 uploads/finalize、供应商存储 confirm、平台商品图片写入和 seller upstream 的专用分类及死辅助函数；删除无消费者的 `ClassBatch` 与独立预算。`POST /api/listing/submit` 继续归普通写。集成测试统一使用 `/api/listing/jobs` 与 `/api/billing/usage-stats?rollup=1`；用 `from`/`to` 替代旧 `period`，保留 member 默认可读、请求 rollup 得 403 的断言。相关文档和前端注释已更新。
3. **补齐实际响应和契约。** AI、兑换、抓取配置、类目 schema、店铺评分的成功响应按当前契约拍平，评分与类目查询参数对齐 snake_case。修复抓取配置/WB 内嵌 schema 漏掉的 11 个属性及对应 required 名称，新增递归命名回归检查。`make generate` 的 20 份配置、TypeScript schema 与路径表重新生成通过；operationId 仍为 376 个且唯一，所有 `$ref` 可解析。
4. **fetch-config 共享错误枚举作为当前设计保留。** 使用 `CatalogErrorResponse` 避免重新引入生成器重名；共享 9 值是 catalog 域的文档集合，GET 的实际错误分支仍为 `auth_invalid`、`forbidden`、`internal`，没有扩大运行时权限或更改错误信封。
5. **前端验收通过。** `bun run check` 全部通过：TypeScript/Vite 构建、3,108 个测试通过（2 个既有跳过、0 失败）、`api:check`、deadcode、lint。移除全局 `--parallel`，避免硬性性能断言与其它测试竞争 CPU；1,000 行 revalidate 实测 72.54ms，原 300ms 门槛保留。既有 lint 警告仍在脚本允许范围内。
6. **素材覆盖度归档。** 原方案要点仅有 92 条记录这一事实无法从当前目录补回，作为原工作流的来源限制保留，不再作为代码待办。本次收尾以仓库源文件、重新生成、全套测试和契约检查作为验收依据，没有补写未执行过的历史验证。
