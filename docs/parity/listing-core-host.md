# listing-core 怎么接到 Go

来源提交：`xxww0098/podhub` `a03d735`。本文只记录已经打开过的源码和这次在本仓库里跑过的加载实验。

用户已经决定：上架规则只在服务端校验，浏览器只做提示；规则表经接口下发并带版本握手；不编译 Go WASM（`GOOS=js` / `GOARCH=wasm`）。`listing-core` 仍是 Rust 纯函数，Cloud 与浏览器共用。Go 是否用 wazero 加载**同一份**浏览器 wasm，要先评估。评估结论如下。是否改用上游那份浏览器产物，留在文末交给用户决定。

## 浏览器那份 wasm 长什么样

`rust/crates/listing-core-wasm` 是 `wasm32-unknown-unknown` 的 C ABI（`cdylib`），没有 wasm-bindgen，没有线程。模块说明里的宿主导入只有 `env.fill_random(ptr, len)`。导出是 `alloc`、`free`、`schema_load`、`schema_drop`、`call`、`result_ptr`、`result_len`、`drop_result`、`last_error_ptr`、`last_error_len`。`call` 的 op 表是行编辑、冻结、issue 清单、阶段计划、OCR 答案和变体，**没有** `tag_is_banned` / `partition_tags` / `strip_tag_text`。

禁用标签匹配在 `rust/crates/listing-core/src/banned_tags.rs`。Cloud 原生直接调用它：

- 行草稿 PATCH：`src/listing/api/rows/banned.rs` 取出属性 23171 的词，`forbid_tags` 拒绝保存。
- AI 写回：`src/listing/api/recognition/writeback.rs` 对 `result.tags` 做 `strip_tags`，留下未命中的词再结算。
- 发送前：`strip_tag_text` / `tag_is_banned` 从出站标签里拿掉命中的词（`src/platform/banned_tags/clean.rs` 对属性 23171 和 `tags` 数组做同样的事）。

`POST /api/listing/submit` 的 build→validate→freeze（`submit_drafts_pipeline.rs` 这条链路在盘点第 6 节）**不**调用上述函数。冻结之后如果发送前再剥离，请求哈希和真正出去的字节会不一样。这是现有 Rust 行为，不是 Go 对拍已经对齐的结果。

## wazero 能不能加载这种模块

能加载这种形状，不能用浏览器那份现成产物来做禁用标签。

本仓库的 `rust/crates/wasm-host-probe` 按同样的约定声明了 `env.fill_random`，并在 wasm 里对宿主写好的字节求和。`TestWazeroHostSatisfiesFillRandom` 用 wazero 提供这个导入，4 个字节各为 7 时和为 28；随后调用会 panic 的导出，wazero 把 trap 当成错误返回。所以「C ABI + 一个 `env.fill_random`」这件事，wazero 做得到。

做不到的是「把浏览器正在用的那份 `listing-core.wasm` 原样加载，然后让它判断禁用标签」：

1. 那份模块的 op 表没有禁用标签函数。调用现有的 freeze（op 11）会复现「冻结时不查标签」的缺口，而不是补上它。
2. 本仓库没有 podhub 工作区。编出那份 wasm 还要 `op-workflow` 等整棵依赖。本 PR 不把那棵树拷进来。
3. 即使编出来，Go 仍然调用不到 `banned_tags`，除非上游先加一个导出。那会变成一份新的浏览器 wasm，不再是今天已经发出去的那一份。

`rust/crates/listing-tags` 编出来的 `wasm/dist/server/listing-tags.wasm` **不是**那份浏览器产物。它只包含从 `banned_tags.rs`（blob `bce8b013`）和 `ocr_script.rs` 的形近字折叠（blob `923d5cd1`）抄来的纯函数，JSON 进、JSON 出。`cargo test` 跑的是抄过来的上游单元测试，再加 `testdata/oracle.json`。Go 的 `TestWasmMatchesNativeOracle` 用 wazero 跑同一批输入，紧凑 JSON 必须与 oracle 逐字节相同。本地重编后可以用 `scripts/build-wasm.sh tags --env FILE` 把 `LISTING_TAGS_WASM` 指到**刚编出来**的模块，再跑一遍同样的 oracle，避免只相信提交进仓库的二进制；CI 不重编，只对已提交产物跑。

这份窄 wasm 的导入表是空的（不需要 `fill_random`，因为匹配函数不用随机数）。浏览器模块需要的那个导入，由上面的探针覆盖。

## 本 PR 实际接上的行为

规则从 `public.banned_tags` 读出，只保留 `enabled` 且 `match_mode` 为 `exact` 或 `stem` 的行，按 `id` 排序。这与 `store::load_enabled` 一致。未知的 `match_mode` 跳过，不当成命中。

`GET /api/listing/rules` 返回 `{rulesVersion, bannedTags:{rules:[{term,matchMode}]}}`。`rulesVersion` 是这份数组的 UTF-8 JSON（字段顺序 `term`、`matchMode`，不转义 HTML，无末尾换行）的 sha256 十六进制。`ETag` 是带引号的版本。`If-None-Match` 相同则 304。`Cache-Control: no-store`。没有进程内 1 秒缓存：下一次请求读到已提交的行。Rust 本进程写入会立刻失效，其它进程最多落后 1 秒。这里的读不会比那个缓存更旧，可能更早看见。对拍用的是同一份规则快照，不比较缓存时间。

`POST /api/listing/validate` 无副作用。请求带 `rulesVersion`、`tags`、`text`。版本不一致返回 409 `rules_stale`，并给出当前版本。版本一致时返回四处结果：

- `save`：与行草稿 PATCH 相同，`partition_tags` 命中则拒绝，文案是 `标签含受限词，不能保存：…`。
- `ai`：与 AI 写回相同，`partition_tags` 留下未命中的词。
- `beforeSend`：与发送前剥离相同，`strip_tag_text`。
- `submit`：见下一节。

规则表读失败或 wasm 调用失败返回 503，不把标签放行。

`POST /api/listing/submit` 先做这个闸。命中则 400 `banned_tag`，不入队、不写行、不调用 Ozon。没有 `storeId`/`items` 的正文通过闸之后是 400 `validation` `请求格式无效`，不写库、不入队。带 `storeId` 或 `items` 的正文走草稿入口。

表是全平台的。迁移没有给它打开 RLS，本接口也不 `SET LOCAL ROLE`、不过滤 `org_id`。请求体里的租户标识不参与匹配。本 PR 不实现登录和超级管理员写入，因此没有无鉴权的管理写接口；审计仍留在 Rust 的 `/api/admin/banned-tags`。

`OZON_WRITE_KILL_SWITCH` 与 `CLOUD_MEDIA_GC_DELETE` 的解析没有改。

## 有意的行为变化（交给用户决定）

`submit.rustFreezeChecksTags` 恒为 `false`：当前 Rust 的 build→validate→freeze **不**查禁用标签。Go 的提交闸会拒绝。拒绝条件是下面两条的并集，动作用的是 PATCH 的拒绝，不是发送前的静默剥离：

1. `tags` 会被行草稿 PATCH 拒绝（AI 写回会剥掉的是同一批词）。
2. `text` 会被发送前的 `strip_tag_text` 改掉。

这样冻结前就停住，避免「先冻结、再剥离、请求哈希和出站字节不同」。`behaviorChange` 为 `submit_banned_tag_gate`。测试 `TestSubmitGateDivergesFromRustFreeze` 把「Go 拒绝」和「Rust 冻结不检查」放在同一个断言里。

若用户不接受这道闸，应去掉 `decideSubmit` 里的拒绝，让提交路径回到「冻结时不查标签」，只保留 validate 里的对照结果。

## listing-core wasm 宿主

`internal/listing/core` 加载手写 C ABI（不是 WASI）。wazero 只出现在 `internal/platform/wasm`；core 调用那个宿主。浏览器 op 1–13 在 `internal/listing/core/contract`。`listing/submit` 只 import 这份 contract，具体模块由 `internal/app` 装上。多了一个宿主导出 `snapshot_from_fields`，入参是缓存里的 snake_case 字段数组，出参是 `snapshot_from_live_fields` 的快照。因此提交进仓库的 `wasm/dist/server/listing-core.wasm` 不是上游浏览器那一份字节。校验和记在 `wasm/dist/SOURCES.sha256`。

窄 wasm、listing-core 和浏览器模块同属一个 `rust/` workspace，共用 `rust/rust-toolchain.toml` 钉住的稳定工具链（1.99.0），都在本地用 `make wasm` 构建。CI 不安装 Rust、不重编 WASM；它校验源码 / 构建输入指纹与产物哈希。CI 传的 `LISTING_CORE_WASM` 与 `LISTING_TAGS_WASM` 指向已提交的 `wasm/dist/server/`，`WASM_HOST_PROBE` 指向 `wasm/dist/test/`，`LISTING_STATE_WASM` 指向 `wasm/dist/browser/`。Go 测试比较 `freeze_oracle.json` 的结果字节，不比较两次构建的 WASM 文件字节。禁用标签闸继续单独加载窄 wasm，生产代码里的 wazero 只在 `internal/platform/wasm`。

`semantic_schema_revision` 的 sha256 仍按传入顺序计算，那次改动只落在 Go 侧、没有动 wasm 源码。Go 在调用 `snapshot_from_fields` 之前按 attribute id 排序，返回的快照把字段拨回缓存里的展示顺序，所以版本号不再跟着顺序变。发送时旧哈希和新哈希都认；对不上才按当前字段重验，只有新增必填且商品没填才拦。详见 `docs/parity/schema-revision-parity.md` 和 `docs/parity/regression-checklist.md`。

草稿发送用 op 9 把 Draft 投成行，再用 op 11 冻结。op 11 还会拒绝 `schema_stale`、`coordinate_mismatch`、`candidates_unresolved`、`row_id_invalid`。Cloud 的 `submit_drafts_pipeline` 在冻结前还有媒体、供应商视频、系统媒体和发货门，那些门除了图片 key 的形状和 28 天期限，没有接上。图片 key 规则抄自 `media-core` 的 `parse_upload_key`，`media-core` 没有链进来。

## 需要用户决定

1. **窄 wasm 是否继续作为服务端匹配器。** 它和浏览器 wasm 不是同一份文件。替代方案是：在 `listing-core-wasm` 增加一个 op（建议 JSON 入参 `{op, tags, text, rules:[{term, matchMode}]}`，出参与现在的 `Out` 相同），由 Rust CI 产出浏览器与 Go 共用的那一个 `.wasm`，Go 只换成那个文件。在那之前，本仓库用窄 wasm，避免把词干规则重写成 Go。
2. **提交闸是否保留。** 见上一节。不接受的话，Rust 与 Go 在「冻结时不查禁用标签」上重新一致，发送前剥离与请求哈希不一致的洞还在。
3. **是否把 `GET /api/me/catalog/banned-tags` 的 `{data:{rules}}` 包一层。** 本接口是新的 `GET /api/listing/rules`，多了 `rulesVersion`。旧路径要等认证（不在本分支）再挂，不能做成无登录的同一 URL。
