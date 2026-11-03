# listing-core 怎么接到 Go

来源提交：`xxww0098/podhub` `a03d735`。本文保留最初接入实验及其 Rust 对照。早期 HTTP 字段和路由描述是历史记录；当前契约以 `api/openapi.yaml` 为准。

用户已经决定：上架规则只在服务端校验，浏览器只做提示；规则表经接口下发并带版本握手；不编译 Go WASM（`GOOS=js` / `GOARCH=wasm`）。`listing-core` 仍是 Rust 纯函数，Cloud 与浏览器共用。当前服务端加载 `wasm/dist/server/listing-core.wasm`（快照、冻结与禁用标签 op 20）；浏览器加载 `wasm/dist/browser/listing-state.wasm`。是否统一产物由 [决策 O1](../decisions.md) 跟踪。

## 浏览器那份 wasm 长什么样

`rust/crates/listing-core-wasm` 是 `wasm32-unknown-unknown` 的 C ABI（`cdylib`），没有 wasm-bindgen，没有线程。模块说明里的宿主导入只有 `env.fill_random(ptr, len)`。导出是 `alloc`、`free`、`schema_load`、`schema_drop`、`call`、`result_ptr`、`result_len`、`drop_result`、`last_error_ptr`、`last_error_len`。`call` 的 op 表是行编辑、冻结、issue 清单、阶段计划、识图答案和变体，**没有** `tag_is_banned` / `partition_tags` / `strip_tag_text`。

op 19 `seedAssociatedRow` 是同源多规格导入的建行入口：宿主传 `orgId`、`supplierSourceId`、`variantGroup`、`rowId` 和与 op 1 相同的种子输入，内核用 `association_identity` 派生关联 id 与共同型号，再把 `PH-<rowId>` 货号和型号写进草稿，回 `{row, associationId, modelValue}`。类目没有普通 9048 字段、源图摘要不是 64 位十六进制、款号或货源库为空时是 `CORE_REFUSED`。Go 不再保留这套派生公式。

禁用标签匹配在 `rust/crates/listing-core/src/banned_tags.rs`。Cloud 原生直接调用它：

- 行草稿 PATCH：`src/listing/api/rows/banned.rs` 取出属性 23171 的词，`forbid_tags` 拒绝保存。
- AI 写回：`src/listing/api/recognition/writeback.rs` 对 `result.tags` 做 `strip_tags`，留下未命中的词再结算。
- 发送前：`strip_tag_text` / `tag_is_banned` 从出站标签里拿掉命中的词（`src/platform/banned_tags/clean.rs` 对属性 23171 和 `tags` 数组做同样的事）。

`POST /api/listing/submit` 的 build→validate→freeze（`submit_drafts_pipeline.rs` 这条链路在盘点第 6 节）**不**调用上述函数。冻结之后如果发送前再剥离，请求哈希和真正出去的字节会不一样。这是现有 Rust 行为，不是 Go 对拍已经对齐的结果。

## wazero 能不能加载这种模块

能加载这种形状，不能用浏览器那份现成产物来做禁用标签。

禁用标签现在是 listing-core-wasm 的 op 20（仅服务端构建，浏览器构建通过 `browser` feature 排除）：JSON 进、JSON 出，直接调用 `listing_core::banned_tags`，没有第二份抄来的源码。`cargo test -p listing-core` 跑 `banned_tags` 的单元测试；`cargo test -p listing-core-wasm` 经导出的 `call` 重放 `rust/crates/listing-core-wasm/tests/fixtures/banned_tags/oracle.json`。Go 的 `TestWasmMatchesNativeOracle` 用 wazero 跑同一批输入，紧凑 JSON 必须与 oracle 逐字节相同。CI 不重编，只对已提交产物跑。

wazero 提供 `env.fill_random`；模块中途 panic 会成为 trap，由宿主丢弃该实例（`internal/platform/wasm` 的池测试覆盖）。

## 最初接入行为（历史记录）

规则从 `public.banned_tags` 读出，只保留 `enabled` 且 `match_mode` 为 `exact` 或 `stem` 的行，按 `id` 排序。这与 `store::load_enabled` 一致。未知的 `match_mode` 跳过，不当成命中。

`GET /api/listing/rules` 返回 `{rulesVersion, bannedTags:{rules:[{term,matchMode}]}}`。`rulesVersion` 是这份数组的 UTF-8 JSON（字段顺序 `term`、`matchMode`，不转义 HTML，无末尾换行）的 sha256 十六进制。`ETag` 是带引号的版本。`If-None-Match` 相同则 304。`Cache-Control: no-store`。没有进程内 1 秒缓存：下一次请求读到已提交的行。Rust 本进程写入会立刻失效，其它进程最多落后 1 秒。这里的读不会比那个缓存更旧，可能更早看见。对拍用的是同一份规则快照，不比较缓存时间。

`POST /api/listing/validate` 无副作用。请求带 `rulesVersion`、`tags`、`text`。版本不一致返回 409 `rules_stale`，并给出当前版本。版本一致时返回四处结果：

- `save`：与行草稿 PATCH 相同，`partition_tags` 命中则拒绝，文案是 `标签含受限词，不能保存：…`。
- `ai`：与 AI 写回相同，`partition_tags` 留下未命中的词。
- `beforeSend`：与发送前剥离相同，`strip_tag_text`。
- `submit`：见下一节。

规则表读失败或 wasm 调用失败返回 503，不把标签放行。

`POST /api/listing/submit` 先做这个闸。命中则 400 `banned_tag`，不入队、不写行、不调用 Ozon。没有 `storeId`/`items` 的正文通过闸之后是 400 `validation` `请求格式无效`，不写库、不入队。带 `storeId` 或 `items` 的正文走草稿入口。

表是全平台的。迁移没有给它打开 RLS，本接口也不 `SET LOCAL ROLE`、不过滤 `org_id`。请求体里的租户标识不参与匹配。最初实验没有实现登录和超级管理员写入；后续禁用标签管理写入与审计已记录在 [Listing 写路径](listing-write-parity.md)。

`OZON_WRITE_KILL_SWITCH` 与 `CLOUD_MEDIA_GC_DELETE` 的解析没有改。

## 有意的行为变化

`submit.rustFreezeChecksTags` 恒为 `false`：当前 Rust 的 build→validate→freeze **不**查禁用标签。Go 的提交闸会拒绝。拒绝条件是下面两条的并集，动作用的是 PATCH 的拒绝，不是发送前的静默剥离：

1. `tags` 会被行草稿 PATCH 拒绝（AI 写回会剥掉的是同一批词）。
2. `text` 会被发送前的 `strip_tag_text` 改掉。

这样冻结前就停住，避免「先冻结、再剥离、请求哈希和出站字节不同」。`behaviorChange` 为 `submit_banned_tag_gate`。测试 `TestSubmitGateDivergesFromRustFreeze` 把「Go 拒绝」和「Rust 冻结不检查」放在同一个断言里。

现有 `decideSubmit` 仍保留拒绝分支；是否调整由 [决策 O2](../decisions.md) 跟踪。本对拍记录不要求为旧 Rust 行为保留兼容。

## listing-core wasm 宿主

`internal/listing/core` 加载手写 C ABI（不是 WASI）。wazero 只出现在 `internal/platform/wasm`；core 调用那个宿主。浏览器 op 1–13 在 `internal/listing/core/contract`。`listing/submit` 只 import 这份 contract，具体模块由 `internal/app` 装上。多了一个宿主导出 `snapshot_from_fields`，入参是缓存里的 snake_case 字段数组，出参是 `snapshot_from_live_fields` 的快照。因此提交进仓库的 `wasm/dist/server/listing-core.wasm` 不是上游浏览器那一份字节。校验和记在 `wasm/dist/SOURCES.sha256`。

服务端与浏览器的 listing-core 模块同属一个 `rust/` workspace，共用 `rust/rust-toolchain.toml` 钉住的稳定工具链（1.99.0），都在本地用 `make wasm` 构建。Go/Web CI 消费已提交 WASM，并校验源码 / 构建输入指纹与产物哈希；独立 Rust job 运行 `cargo test --locked -p listing-core -p listing-core-wasm -p render -p psdx -p render-wasm`，不重编 WASM。Go 测试比较 `freeze_oracle.json` 与禁用标签 `oracle.json` 的结果字节，不比较两次构建的 WASM 文件字节。禁用标签闸经 `engine.New(core.Shared(...))` 复用同一个 listing-core 实例池，生产代码里的 wazero 只在 `internal/platform/wasm`。

`semantic_schema_revision` 的 sha256 仍按传入顺序计算，那次改动只落在 Go 侧、没有动 wasm 源码。Go 在调用 `snapshot_from_fields` 之前按 attribute id 排序，返回的快照把字段拨回缓存里的展示顺序，所以版本号不再跟着顺序变。发送时旧哈希和新哈希都认；对不上才按当前字段重验，只有新增必填且商品没填才拦。详见 `docs/parity/schema-revision-parity.md` 和 `docs/parity/regression-checklist.md`。

草稿发送用 op 9 把 Draft 投成行，再用 op 11 冻结。op 11 还会拒绝 `schema_stale`、`coordinate_mismatch`、`candidates_unresolved`、`row_id_invalid`。Cloud 的 `submit_drafts_pipeline` 在冻结前还有媒体、供应商视频、系统媒体和发货门，那些门除了图片 key 的形状和 28 天期限，没有接上。图片 key 规则抄自 `media-core` 的 `parse_upload_key`，`media-core` 没有链进来。

## 后续决策

产物是否统一、提交闸是否调整、排序是否放入 wasm，集中见 [决策 O1–O3](../decisions.md)。旧路径的兼容包装不再作为本项目要求；新增或删除路由按当前 OpenAPI 与鉴权实现处理。
