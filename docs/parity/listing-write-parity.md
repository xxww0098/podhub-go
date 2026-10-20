# Listing 写路径、目录读、SSE（PR-3b）

对照 `xxww0098/podhub` `a03d735`，卡片与行的读写再对照规格导出（Rust `v0.0.112`，HEAD `7df856a`）。种子和草稿编辑走 `listing-core` wasm 的 `seed_row` / `edit_row`。`fromSupplier`、供应商卡读写、无 draft 的行合并、候选确认、清空生成内容和 `fillBlank` 已接上。发送路径见 `docs/parity/listing-submit-parity.md`。

## 和 Rust 同结果的部分

- **五事实**（`internal/listing/facts.go`）：`content` / `media` / `validation` / `submission` 的映射与 `kernel/facts.rs` 的表驱动用例一致，包括 `cancelled`/`superseded` → `none`、`operator_attested` → `unknown`、候选列表空列表算结清。
- **三处禁用标签**：行草稿拒绝、AI 写回、发送前剥离分别调用 wasm 的 `partition`、`partition`、`strip_text`。`ForbidSave` / `StripForAI` / `StripBeforeSend` 与已有 `Validate` 用同一次引擎、同一份规则。规则或 wasm 失败不放行。词干规则没有在 Go 里重写。
- **卡片列表 / 单卡 GET**：SQL 与 `kernel/cards.rs` 的 `CARD_SELECT`、`(updated_at, id)` 倒序、游标 `micros:uuid`、`limit` 先夹到 1..100 再把 `limit+1` 夹回 100 相同。所以 `limit=100` 没有 `nextCursor`。`storeId` 非法 uuid 仍交给 SQL，失败是 500 `服务暂不可用`。响应字段顺序是 `id, title, storeId?, revision, payload, updatedAtMs`。列表不带 `ocrPromptSha256`。单卡 GET 从 payload 的 `aiPromptSha256` 填 `ocrPromptSha256`。供应商卡与普通卡走同一对列表 / GET，不再因为 `supplierProductId` 返回 501。
- **卡片标题 / 仅 revision 的 CAS**：`cas_patch_card` 的 `UPDATE`（空标题保留原标题、`payload` 用 `'null'` 表示不改、`revision+1`、`updated_by`）。冲突文案是 `上架方案已被他人更新，请刷新后重试`，码 `conflict`。不存在是 `上架方案不存在`。
- **删除卡片**：先数行，再删卡，再删这些行。意图和作业没有另写一条 Go 更新。响应是 `{"data":{"id","deletedRows"}}`。
- **创建卡片的前置拒绝**（不插入）：`fromPack`、`fieldPackId`、`sourceCardId`、`applyActivePack`、`supplierProductId` 的使用限制、空白卡 payload 里的供应商 id、`copyCard` 缺来源、复制供应商卡。文案来自 `cards/create.rs` 与 `card_writes.rs`。
- **行 PATCH 的 revision**：不一致时 409 `商品行已被他人更新，请刷新后重试`，并带 `conflict`（`serverRevision`、`serverPayload`、`clientBaseRevision`、`clientChanges`）。不更新。
- **行 PATCH 的搜索标签**：属性 `23171` 的 `text`/`url`/`text_list`/`url_list` 按空白切开，交给上面的 `ForbidSave`。规则表或 wasm 失败是 503，不保存。类目坐标或 `ozon_category_current` 缺失是 409 `该类目尚未同步，请先同步类目字段后重试`。
- **行 PATCH 的草稿**：载荷能解成 lean row 时走 wasm `edit_row`（op 2），同一条 CAS 写入 payload、`validation_state`、可选店铺，`revision + 1`。解不出时 400，句子以「商品行载荷不是可校验的上架文档」开头，不写。
- **`fromSupplier` 创建**：服务端用 `PrepareCard` 组装 payload。可上架则插入；同一 `(org_id, supplier_product_id)` 再次创建返回已有卡。缺失商品 404 `供应商商品不存在或当前不可上架`。拒绝码放在 `error` 与 `denial`，HTTP 码 `supplier_not_listable`。`prompt_text` 非空视为提示词有效。
- **供应商卡 PATCH**：白名单是 `queue`、`targetStoreId`、`defaults`、`psdTemplateAssetId`、`psdTemplateSha256`、`psdTemplateFileName`。改标题 400 `供应商商品方案配置由在线平台货源管理，不能在方案中修改`。非供应商 payload 写入 `supplierProductId` 仍是 400 `请从平台货源选择规格创建方案`。PSD 字符串超过 512 是 400 `PSD 模板绑定过长`。
- **无 draft 的 `changes` / `payload`**：保护 `ai`、`fieldOrigins`、`handEditedKeys`、`supplierProductId` 和 `draft` 之后，用 `payload || patch` 做 revision CAS。`candidateDecisions` 独占，走 wasm op 4。`clearGeneratedContent` 在 `submission_state` 不是 `none`/`cancelled`/`rejected` 时 422 `已上架或待对账商品不能清空生成内容`；识别中、处理中或仍有活动作业时 422。`fillBlank: true` 且没有 `draft` 时走 `fill_blank`：只替换已有的 SQL NULL、JSON null 或正好是 `""` 的键，缺键照样插入，`build_state = 'stale'`，`revision + 1`，不写 `updated_by`。写入前删掉填充文档顶层的 `schemaSnapshot` 和 `schemaRevision`。`fill_blank` 为真时不追加 `ManualField`。类目、来源、店铺等触发器按导出的列覆盖各写一条 UPDATE。成功体是 `{data, issues}`，没有 `plan`，响应副本去掉 `schemaSnapshot`，不补快照。带 `draft` 时仍走原来的草稿编辑和标签闸。
- **行视图回执与 hydrate**：`submissionReceiptStatus` 取该行最新 `submission_intents.submission_receipt`（`listing_rows` 没有这一列）。空为 `absent`，JSON 对象为 `valid`，其余为 `unreadable`。已有 `schemaSnapshot` 或没有 `schemaRevision` 时原样返回；否则按修订号补上快照。
- **带 `storeId` 的类目树与 schema live fill**：缓存未命中或过期时回环补拉并写缓存。schema 成功体包含 `nativeMaterial`。详见 `docs/parity/listing-intents-catalog-parity.md`。
- **行创建**：`createKey` 与 `requestFingerprint` 成对；`source.sha256` 为 64 位十六进制；卡不存在 404。类目缓存 `ozon_catalog_schema_cache` 未命中或超过 24 小时是 409 `该类目尚未同步，请先同步类目字段后重试`。`listing_schema_revisions` 没有该修订是 409 `类目字段版本尚未注册，请重新同步类目后重试`。种子是 wasm `seed_row`（op 1）。`(org_id, card_id, create_key)` 冲突且指纹相同返回 `created: false`；指纹不同 409 `该创建键已用于不同的创建内容，请刷新列表后用新的创建键重试`。
- **行列表 / 单行 GET**：`cardId` 非法在鉴权前 400。无 `cardId` 时按 `(updated_at, id)` 倒序，游标 `micros:uuid`，`limit+1` 最多 101。有 `cardId` 时按 `queue_position, created_at, id` 做 offset。视图由存储列投影。不存在的行 404 `商品行不存在`。合法但不存在的 `cardId` 返回空列表。
- **空白卡 / 复制卡**：`PrepareCard` 解码、去掉 `schemaRevision`、拒绝未知键、系统媒体、PSD 摘要。空白卡插入新 id、revision 1。`copyCard` 与 `POST /cards/{id}/copy` 复制源 payload 与店铺，不复制行；供应商卡 400 `供应商商品方案是唯一软链接，不能复制`。店铺可见性按 owner/manager/admin 或 assignee。
- **卡片 payload / storeId**：非供应商整包 payload 经 `PrepareCard` 后 CAS。`storeId` 空白解绑。冲突 409，不存在 404。
- **快照**：存储行存在即 200（不走供应商投影）。`cursor` 来自 `listing_card_cursors.seq`，没有则 `"0"`。`workspaceId` 是 org id 十进制。`summary` 由行 stage 计入六个计数字段。
- **禁用标签管理写**：`INSERT`/`UPDATE`/`DELETE` 与 `http.rs` 相同，`canonical_term` 走 wasm `normalize`，备注 200 字，模式只收 `exact|stem`，重复 409 `这个受限词已经存在`。写完调用 `InvalidateBannedTags`，审计走现有 `InsertAudit`（失败只记日志，仍返回列表）。`created_by` 是账号 `public_id`。
- **字段包**：用户维度，不进 RLS。咨询锁、第一条为 active、激活时先关掉同坐标其他行再打开目标、`shared` 只是标志、`library_id` 仅在分享时出现、`author_is_self=true`、`source=cloud`。列表 `active DESC, updated_at_ms DESC, id DESC LIMIT 100`。正文按 `FieldLibraryBody` 的 serde 顺序重编码（`cleared` 空则省略，对象键排序）。
- **类目树缓存读（没有 `storeId`）**：gzip 解开，过期（24h）删除后 `data: null`，未命中同样是 `data: null`。损坏是 500 `类目树缓存损坏，请稍后重试`。节点空 `children` 省略。
- **SSE 帧**：`id`、`event`、`data` 的顺序与 axum `Event` 的 Display 一致。保活字节是 `: ping\n\n`，间隔 15 秒。`row.remove` 与 `card.invalidate` 的 JSON 字段顺序按 `ListingRowEventData` / `ListingCardEventData`。回放窗口、64 条溢出、序号缺口的判定与 `kernel/stream.rs` 的纯函数一致。监听用单独连接，读行用 `podhub_app` + `app.current_org_id`。

## 流程变化，以及为什么结果不变

- 卡片列表在 Go 里把 jsonb 重新编码成紧凑 JSON。Rust 也是 `serde_json` 输出。键排序与数字写法对对象键一致；集成测试锁了一条不含供应商、payload 不能被解码填充的卡。
- 禁用标签写完立刻清本进程 1 秒缓存。这就是 Rust `store::invalidate`。别的进程仍最多等 1 秒，没有改 TTL。
- 字段包正文先按 serde 结构再编码，是为了去掉客户端的键顺序差异。空 `cleared` 不出现，与 `skip_serializing_if` 相同。
- 字段包咨询锁的键在 Go 里拼成 `field_pack_active:{user}:{category}:{type}:{language}`，再交给 `hashtextextended`。Rust 在 SQL 里用同样的拼接。pgx 会把 `$1::text` 当成 text 参数，不能把 bigint 编进去，所以不能把强制转换留在 SQL 里。锁的文本和因此互斥的范围不变。
- 行种子和草稿编辑在 Go 里直接调用已提交的 `listing-core.wasm`，不在 Go 里重写合并。同输入得到 wasm 的同一段 JSON，再按规格里的 CAS 写入。集成测试 `TestListingCardRowRoundTrip` 锁住创建、复制、快照、幂等重放、指纹冲突、light 草稿和跨 org 404。
- 商品行列表在游标关闭后，对本页仍需要快照的 `schemaRevision` 去重，一条 `WHERE schema_revision = ANY($1::text[])` 取回，再按原行序调用 `HydratePayload`。已带 `schemaSnapshot`、没有修订、空字符串或非字符串的行不进这条查询；一页都不需要时不查注册表。缺修订时，错误仍是列表顺序里的第一个：`schema revision … is not registered; the row payload references a snapshot the registry does not carry`。HTTP 层不改，`writeDB` 仍把它写成 500 `{"error":"服务暂不可用","code":"internal"}`。单行 `getRow` 继续走原来的 `withSnapshot`。查询留在列表的同一事务里。`TestListingSnapshotBatchParity` 用旧的逐行 `withSnapshot` 作对照，列表和单行响应字节一致，100 行 / 10 个修订的注册表语句数是 1。`BenchmarkListSchemaSnapshots`（100 行，`-benchtime=1s`）：`1706887 ns/op`。

## 不能证明与 Rust 一致的部分

`fillBlank` 的 SQL、互斥、触发器和错误文案已按导出的 `fields.rs` / `patch.rs` / `kernel-invalidation.rs` 接上。下面这些字节或流程仍然对不齐，或规格没有钉死。

- **`fillBlank` 的 200 整段字节**。`updatedAtMs` 用数据库时钟。投影树和 `jsonb_object_agg` 的键序没有钉成与 Rust 逐字相同；测试用 JSON 运算符核对值，并核对 `issues` 与 `data.validationIssues` 相同、没有 `plan`。
- **`listing row payload decode:` 后面的英文**。前缀和回滚已锁住。Go 的解码细节不是 serde Display。
- **冲突里的 `serverPayload` 原始字节**。按语义相等断言。`updated_by` 非空时带 `lastEditorId`，空则省略。
- **`view_revision` 的绝对起点**。表默认是 1。测试从已知插入值断言每次 UPDATE `+1`。
- **`had_source && source_changed`**。`fill_blank` 不会替换非空的 `source` 对象，所以这条 HTTP 路径到不了「旧值没有来源记录」的候选。函数已实现，单测覆盖。
- **准入 429/503**。本进程的 listing 与目录处理器没有挂 RegularWrite 限流器。
- **CSRF 辅助函数**。`listing/read/http` 不能引用 `internal/identity`，cookie / site / origin 规则在 `fillblank.go` 里复制了一份，布尔结果与 `identity.CrossOriginWrite` 相同。
- **仅 `storeId` 的 CAS**。沿用现有换店 SQL，会写 `updated_by`。`fill_blank` 那条 UPDATE 不写 `updated_by`。`cas_set_row_store` 的 Rust 正文不在这批 fixture 里。
- **`fromPack` 与其它创建模式**。`fromPack` 是 400 `不再支持字段包导入`。不是 `blank` / `copyCard` / `fromSupplier` 的模式是 400 `请求格式无效`。与上面创建卡片的前置拒绝一致，不插入。
- **SSE `row.upsert`**。密封行要 hydration。遇到这种事件发 `reset` / `snapshot_required` 并关掉，不发半截行视图。`row.remove` 和 `card.invalidate` 会发。GET 与列表会 hydrate；`editDraft`、换店和创建行的扫描还不补快照。
- **多卡 SSE 的交错**。按查询里的卡片顺序发完一张再发下一张。Rust 是轮询弹出。单卡字节不受影响。
- **空闲补拉间隔**。`stream.rs` 写的是 `SSE_IDLE_POLL_SECS`，本轮没有打开定义它的文件。保活用已确认的 15 秒，空闲补拉用了同一个 15 秒。若那个常量不是 15，补拉频率不同，事件内容的判定不变。
- **`/api/catalog/wb/subjects/{id}`、`/api/catalog/fetch-config`**。读路径已按意图文档接上。`fetch-config` 不查询 `wb_token_*` 密文。本文件不把它们再标成 501。
- **带 `storeId` 的类目树**。缓存未命中或过期时回环补拉，见意图文档。无 `storeId` 的缓存读按上面的规则。
- **字段值 `decimal` / `decimal_list`**。`f64` 的 JSON 字节没有对上 `serde_json`，字段包拒绝这种正文。
- **字段包 404 文案、DELETE 的 204、字段库列表的排序** 没有在本轮打开 `field_packs/mod.rs` 的 HTTP 层。SQL 是从 `persist.rs` 抄的。
- **路径上的非法 uuid** 返回 400 `cardId 无效` / `商品行编号无效`，不是 SQL 的 500。查询参数 `cardId` 本来就是 400。
- **PATCH 行在规则读失败时用 503 `rules_unavailable`**，与现有规则接口一致。Rust 的 `ListingApiError::db` 可能是 500。

## 租户

卡片、行、意图、事件回放都在事务里 `set_config('role','podhub_app')` 和 `app.current_org_id`。集成测试与身份对拍同一条策略：只切到 `podhub_app`、不设 GUC 时，`listing_cards` 的 SELECT 为 0，INSERT 被 RLS 拒绝。字段包和 `banned_tags`、类目缓存没有 RLS，按 Rust 用用户 id 或全局表，不设 GUC。
