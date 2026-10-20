# 回归测试清单

本文件记录 `schema_revision` 误报的现象和修复原则。拆 listing 读写路径的那次搬家只改位置、不改计算。修复已落地，做法、回归测试和与 Rust 的差异表见 `docs/parity/schema-revision-parity.md`。

## 线上现象（Rust）

2026-10-16 19:35 SGT，用户点上架，15 件商品被拦，提示「类目字段已更新，这个商品仍是按旧版字段填写的（schema_revision）」。实际字段没变，是误报。

根因：`listing_core::schema::semantic_schema_revision` 的 sha256 把字段顺序也算进去了。Ozon `/v1/description-category/attribute` 每次缓存刷新（24h TTL）返回的字段顺序会变（59 个字段约 40 个位置变化，必填、类型、约束、选项都没变），版本号就变。浏览器 `freeze_listing` 和服务端 draft-submit 发现 `row.schema_revision != current` 就拒绝。这和文档「字段自动更新、不需用户确认」不符。影响约 14 个组织、10+ 类目，每天触发。

拒绝文案在 `rust/crates/listing-core/src/ops/freeze.rs`：`row.schema_revision != schema.revision()` 时 issue 码 `schema_stale`，中文为「类目字段已更新，这个商品仍是按旧版字段填写的」。

哈希实现里，`option_ids` 会排序，字段顺序和 `field_keys` 按给定顺序保留（`schema.rs` 注释：`Field order and field_keys stay as given`）。`schema/tests.rs` 的 `semantic_schema_revision_tracks_field_order` 断言顺序不同则哈希不同，把这个行为锁进了测试。同文件 `semantic_schema_revision_ignores_option_id_order` 断言选项 id 的顺序不改变哈希。

## 实现位置

Go 没有单独的哈希函数。线上版本号由 Go 调用 wasm，最终执行 Rust `semantic_schema_revision`。

| 角色 | 路径 | 函数 |
| --- | --- | --- |
| 哈希（缺陷所在，本步不改） | `rust/crates/listing-core/src/schema.rs` | `semantic_schema_revision` |
| 快照前缀 `workflow:` | 同上 | `snapshot_from_live_fields`（内部再调 `semantic_schema_revision`）；内容摘要是 `snapshot_semantic_digest` |
| wasm 导出 | `rust/crates/listing-core-wasm/src/lib.rs` | `snapshot_from_fields`（调用 `listing_core::schema::snapshot_from_live_fields`） |
| 浏览器 op 10，读已加载 schema 的版本 | `rust/crates/listing-core-wasm/src/dispatch.rs` | `schema_revision` |
| 冻结时比较版本并拒绝 | `rust/crates/listing-core/src/ops/freeze.rs` | `freeze`（`FreezeRefusal::SchemaStale`） |
| Go 入口（对应实现） | `internal/listing/core/host.go` | `(*Module).Snapshot`（`guest.Call(..., "snapshot_from_fields", ...)`） |
| Go 接口与 op 号 | `internal/listing/core/contract/freeze.go` | `Module.Snapshot`；`OpSchemaRevision = 10`；`OpFreezeListing = 11` |
| 服务端草稿发送读取版本 | `internal/listing/submit/draft.go` | `loadSnapshot`（读 `ozon_catalog_schema_cache`，TTL `schemaTTLMS` = 24h，解压字段后调用 `mod.Snapshot`，取 JSON 字段 `schema_revision`；`schema_stale` 记为跳过） |

## 修复原则（已按此实现）

这是用户批准的有意行为变化。与 Rust 的差异写在 `docs/parity/schema-revision-parity.md`。

1. schema 版本号与字段顺序无关。哈希前按 attribute id 排序，展示顺序另存。
2. 发送时版本不一致，自动用当前字段重新校验再继续。只有确实新增必填且商品不满足时才拦，并标出具体字段。
3. 浏览器和服务端同一套规则。规则表由服务端下发，浏览器只提示。两边用同一套判断：自动重新绑定和直接拒绝不能各走一边。
4. 回归测试：
   - 同字段、不同顺序 → 相同版本号。
   - 缓存刷新后内容未变 → 已验证行仍可发送。
   - 真正新增必填 → 被拦，并指出字段。
5. 只有顺序变化时不写新的版本记录。

修复 PR 还要做两件事：

- 用 Rust 在真实字段变化（新增必填、改类型、改选项）下的结果做一致性对比。顺序变化这一项按上面的原则与 Rust 分叉，其余语义变化与 Rust 对齐。
- 考虑已存储的 Rust 旧版哈希如何兼容：迁移，或双算一次（旧哈希与新哈希都认，直到该行按新规则重写）。
