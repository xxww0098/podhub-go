# schema_revision 误报修复

这是用户批准的有意行为变化。Rust 的 `semantic_schema_revision` 仍把字段顺序算进 sha256。Go 不改 wasm 字节，在调用前把字段按 attribute id 排好，版本号就不再跟着 Ozon 缓存的返回顺序变。

## 缺陷与根因

2026-10-16 19:35 SGT，上架被拦：「类目字段已更新，这个商品仍是按旧版字段填写的（schema_revision）」。必填、类型、约束、选项都没变，变的是 `/v1/description-category/attribute` 的字段顺序（缓存 TTL 24 小时）。`listing_core::schema::semantic_schema_revision` 把这个顺序哈希进去。浏览器 `freeze_listing` 和服务端 draft-submit 见 `row.schema_revision != current` 就拒绝。约 14 个组织、10+ 类目、每天触发。

哈希在 `rust/crates/listing-core/src/schema.rs`。`option_ids` 会排序，字段顺序和 `field_keys` 按给定顺序保留。`schema/tests.rs` 的 `semantic_schema_revision_tracks_field_order` 把「顺序不同则哈希不同」锁进了 Rust 测试。

## 做法

wasm 仍是原来的 `snapshot_from_fields`。`(*Module).Snapshot`（`internal/listing/core/host.go`）在传入 wasm 之前：

1. 有 `attribute_id` 的字段按数值 id 排序；没有 id 的按字段 key 排序。
2. 用排好的数组调用 wasm，得到与顺序无关的 `schema_revision`。
3. 把快照里的 `fields` 拨回缓存原来的顺序。展示顺序还在字段数组里，没有另造一列，也没有丢。

`(*Module).LegacyRevision` 用缓存的原始顺序再调一次同一个 wasm，得到 Rust 旧算法的版本号。

发送（`internal/listing/submit/draft.go` 的 `decideSchema`）是浏览器和服务端共用的那一条规则。响应里的 `acceptedSchemaRevisions` 就是这条规则：当前版本，以及和它不同的旧算法版本。行上的 `schemaRevision` 等于其中任意一个，视为没变。

对不上时，不直接 `schema_stale`。把行上的版本改写成当前版本后再冻结，让 wasm 里的字符串相等检查和这条规则一致，然后按当前字段校验。只有「现在必填、以前不是（或不存在）、商品没有值」才拦，`skipReason` 仍是 `schema_stale`，并多一个 `fields` 数组写出字段 key。已经必填的空字段仍走原来的 `validation_failed` / `required`。

`listing_schema_revisions` 只在能证明语义变了时插入当前版本（`ON CONFLICT DO NOTHING`）。只是顺序变化时 `Record` 为 false，不插入。没有旧快照时也不插入，避免把一次顺序刷新写成新版本行。没有改 `db/migrations`。

## 与 Rust 的差异

同一份 wasm。Rust 列是不排序的 `LegacyRevision`（旧算法）。Go 列是排序后的 `Snapshot`。判定「版本号变不变」除顺序外一致。下面的哈希来自 `TestRustParityRealFieldChangeAgreesExceptOrder`（`go test -run TestRustParity ./internal/listing/core/`）。

| 变化 | Rust（按传入顺序哈希） | Go（先按 attribute id 排序） |
| --- | --- | --- |
| 只改字段顺序 | 变。`workflow:sha256:40f39ed4143da623ca3f05218b256adf6d358282212e4ac87e4684d3ced168d2` 是排好序的那一次；反序的旧哈希不同 | 不变，两次都是 `workflow:sha256:40f39ed4143da623ca3f05218b256adf6d358282212e4ac87e4684d3ced168d2` |
| 新增必填字段 | 变。`workflow:sha256:9de5df41002b4780bcb88d577c1c6478c64f551c03f0cd0bf9905ea675ab68d6` | 变。`workflow:sha256:b42e42302e5623bb5b728fde108594c5aa900c99a874a273b82c9ae4429956f2` |
| 改类型（editor） | 变。`workflow:sha256:fb9c991beda5b4f2970585c788048b20279077466460b4a24a3758b764cdfe88` | 变。`workflow:sha256:f8b3087731df235c7be5ca7c5a4f626b6cf90af5abb297f4e5de14bd840f947a` |
| 改选项 id | 变。`workflow:sha256:df0da069f8c83c6facfd1bca877579a827bececf30c660833340779a54fdf1f3` | 变。`workflow:sha256:822af30b59b5304c453bb76ca905d95fa83f77d70441a3be162cdff8de7b36fb` |

新增必填、改类型、改选项时，两边都判定「版本变了」。哈希字符串本身不同，因为 Rust 列仍按测试夹具的原始顺序哈希，Go 列按 id 排序后哈希。这是同一套 wasm 的输入顺序不同，不是两套哈希函数。

顺序这一行是用户批准的分叉。改约束（`collection` + `max_value_count`）由 `TestTypeOptionConstraintChangeRevision` 覆盖，版本号会变。

## 旧哈希兼容

不迁移库里已有的 revision。发送时同时算：

- 新算法：排序后的 `Snapshot.schema_revision`
- 旧算法：缓存当前顺序下的 `LegacyRevision`

行上的值等于任意一个，就当没变，把行改绑到新版本再冻结（wasm 才能通过它自己的相等检查），不写新的 `listing_schema_revisions` 行。

只认「当前顺序的旧哈希」盖不住「行是用更早一次顺序哈希的」那种线上误报。那种情况两个当前哈希都对不上。发送不把它当成新必填，也不写版本行，改绑后按当前字段校验；字段内容没变就能继续。这是 `TestCacheRefreshOrderChangeStillSendable` 和 `TestHistoricalOrderWithoutSnapshotStillSendable`。

## wasm sha256

没有改 `rust/`，没有重编 wasm。

| | sha256 |
| --- | --- |
| 前 | `3a99fa89dca739430e69d10d3c40a924a3ba9345716d57152c54e2d59b72520f` |
| 后 | 相同。`wasm/dist/SOURCES.sha256` 里 `server/listing-core.wasm` 的哈希未改。`internal/listing/core/host_test.go` 的 `TestCommittedWasmMatchesItsChecksum` 读这份清单比对，通过 |

浏览器那份 wasm 不导出 `snapshot_from_fields`。op 10 只读已经加载的快照上的版本号。服务端下发的快照用新版本号。浏览器不应自己用字符串不等就拒绝；发送响应里的 `acceptedSchemaRevisions` 和拦住时的 `fields` 就是规则。服务端在调用 op 11 之前改绑，所以 wasm 的 `schema_stale` 不会和这条规则各走一边。`TestRebindStopsWasmSchemaStale` 用 `freeze_oracle.json` 的 golden 行证明：版本对不上时 wasm 仍返回 `schema_stale`，改绑到快照版本后同一行变成 `frozen`。

## 回归测试

```text
go test -count=1 -timeout 120s ./internal/listing/core/ ./internal/listing/submit/
```

| 测试 | 结果 |
| --- | --- |
| `TestSameFieldsDifferentOrderSameRevision` | 通过。同字段不同顺序，版本号相同 |
| `TestDisplayOrderIsKeptWhenRevisionIgnoresOrder` | 通过。快照字段仍是 color、size 的传入顺序 |
| `TestCacheRefreshOrderChangeStillSendable` | 通过。内容未变，已填的行改绑后可发送，不写版本行 |
| `TestHistoricalOrderWithoutSnapshotStillSendable` | 通过。库里没有旧快照时，顺序造成的旧哈希不拦、不写行 |
| `TestNewRequiredFieldBlocksAndNamesField` | 通过。新增必填 `brand` 且没有值，`fields` 为 `["brand"]`，`skipReason` 仍是 `schema_stale` |
| `TestNewRequiredFieldSatisfiedContinues` | 通过。新必填已有值则继续 |
| `TestOrderOnlyDoesNotWriteSchemaRevision` | 通过。两种顺序 `Record` 都是 false |
| `TestTypeOptionConstraintChangeRevision` | 通过。改类型、改选项、改约束，版本号都变 |
| `TestTypeOptionConstraintStillChangeTheRevisionDecision` | 通过。语义变化会记录，已填则不拦 |
| `TestLegacyHashIsUnchanged` / `TestCurrentHashIsUnchanged` | 通过。旧哈希或新哈希命中都视为没变 |
| `TestLegacyRevisionMatchesUnsortedWasm` | 通过。旧哈希等于不排序的 wasm 输出 |
| `TestRustParityRealFieldChangeAgreesExceptOrder` | 通过。见上表 |
| `TestRebindStopsWasmSchemaStale` | 通过。改绑后不再 `schema_stale` |
| `TestCommittedWasmMatchesItsChecksum` | 通过。wasm sha256 未变 |

禁用标签闸和回执测试没有改断言。`gofmt`、`go vet`、`go test ./tests/archtest` 在本 PR 的验证里跑过。archtest 基线没有新增。

## 需要用户决定

1. 浏览器安装包若仍在本地把 `freeze_listing` 的 `schema_stale` 当成最终拒绝，会在请求服务端之前拦住只是顺序变了的行。本仓库的发送路径已经改绑并下发 `acceptedSchemaRevisions` 与 `fields`。浏览器应只展示服务端结果。本 PR 没有改 wasm，也没有改 podhub 前端。
2. `listing_schema_revisions` 在生产 head 上是空的。没有旧快照时，发送不插入新行，因此「以前不是必填」只能在表里已经有该 revision 的快照时精确判断。没有快照时，缺的必填由 wasm 校验以 `required` 报出，并写入响应的 `fields`。若要在类目缓存刷新时用新算法补写这张表，需要另开任务；本 PR 不写迁移。
3. 没有 attribute id 的字段（固定字段）按 key 排序后哈希。Ozon 属性字段按数值 id 排序。若固定字段的 key 本身被改名，版本号会变，这和改字段标识是一回事。
