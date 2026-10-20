# 意图、死信、类目读对照（T-LB）

对照来源是 uploads 里的 listing-catalog 规格（Rust v0.0.112，HEAD `7df856a`）和 `fixtures/cloud/goldens/catalog-schema-cache.json`、`catalog-tree-cache.json`。本环境没有 Rust 仓库，也没有把这些接口打到真实 Ozon。

## 状态机对照

HTTP 取消不是 `IntentTransition::CancelBeforeDispatch`。那十一条边仍在 `internal/listing/submit`，本文件不改它们。

| 事实 | 条件 | 结果 | 测试 |
| --- | --- | --- | --- |
| HTTP cancel 改状态 | `state = queued` 且 `external_task_id` 为空 | `cancelled`，并在行 `submission_state = queued` 且 revision 相等时写成 `cancelled` | `TestCancelMovesToCancelled`、集成取消 |
| HTTP cancel 只盖章 | submitting、unknown、已有 external task、其余终态 | state 不变，`cancel_requested_at` 用 `COALESCE` 留第一次 | 同上 |
| 非法边 | reconciled、conflict、operator_attested、superseded、accepted、rejected | 不进入 cancelled | `TestReleaseIDsAndPredicates` |
| release | 仅 `unknown`，claim 已过期或为空，且没有未完成的 `listing.submit.batch` | `superseded`，开放 issue 写入 `resolvedAtMs`，行 `submission_state = none` | `ReleaseAllowed`、集成 release |
| release 拒绝 | claim 仍活着，或未完成派发作业，或状态不是 unknown | 行保持原状态，不出现在 `releasedIntentIds` | 纯函数表 |
| 重放拒绝 | 浏览器 executor；卖家写入类；`cancel_requested`；未归类 | 409 `not_replayable`，不改行 | `TestReplayRefusalTable` |
| 可重放 | `store.product_sync` / `delegate.posting_sync` / `listing.reconcile` 且错误码是规格列出的四个 | `state = queued`，`attempt = 0`，清租约，`last_error_code` 保留 | 集成 requeue |

`superseded` 不是 `IntentTransition` 边。第二次 release 匹配不到 `state = unknown`，`releasedIntentIds` 为空。

## 已接上的 HTTP

- `GET /api/listing/intents`、`GET /api/listing/intents/{id}`：`ListingPrepare`，租户事务，可见店铺子查询，GET 才附 release facts。对不上快照的行省略两个布尔，不发明 `false`。
- `POST /api/listing/intents/{id}/cancel`：`ListingSubmit`。找不到或店不可见是 404 `提交意图不存在`。没有 409。
- `POST /api/listing/intents/{id}/recover`：通过 `ListingSubmit` 后直接 410 `gone`，路径 id 不使用，无 SQL。
- `POST /api/listing/intents/release-unknown`：校验、锁活着的 workspace、按规格谓词放开。本 workspace 没有的 id 不 404。
- `GET /api/listing/dead-letters`、`POST .../requeue`：死信谓词 `state = failed AND attempt >= max_attempts`。非法游标当成没有游标。
- `GET /api/catalog/tree`：无 storeId 的命中 / 过期 / 损坏路径保持原字节。非空 storeId 先做可见性；缓存新鲜则同一棵树。未命中或过期时用该店 Seller 密钥回环 `POST /v1/description-category/tree`，成功后 gzip 写入 `ozon_catalog_tree_cache`（24 小时）。缺密钥 400，过期密钥 400，上游非 2xx 是 502 `类目树读取失败`。非回环基址不拨号，502 `Seller 服务暂时无法访问`。同一进程正在补拉时 503 `类目数据正在读取，请稍后重试`，`Retry-After: 3`。
- `GET /api/catalog/schema`：新鲜缓存按 gzip 原文返回 fields（保留 golden 里的 `collection`），并附上由这些字段算出的 `nativeMaterial`。没有可用平台密钥时 `data: null`。有未禁用平台密钥且缓存未命中时，回环读取 attribute / values，成功写入缓存；全部密钥失败是 502 `平台类目读取失败，请检查平台类目密钥后重试`，并记 60 秒负缓存。
- `POST /api/listing/jobs/{id}/claim`、`POST /api/listing/jobs/claim-window`、`POST /api/listing/jobs/{id}/heartbeat`：浏览器执行租约，`DEFAULT_LEASE_SECS` 为 30。单条认领在配额函数返回 false 时回滚作业并 429。窗口认领配额满是 200 `data: []`。心跳影响行数不是 1 时 `{"data":false}`。非法 uuid 进 SQL，22P02 折成 500 `服务暂不可用`。这是执行租约，不走 `writer.Assert`。
- `POST /api/listing/intents/{id}/probe`：停止条件仍是 409。通过后认领 `reconcile_claim_until`（2 分钟）再回环 `POST /v3/product/info/list`，正文 `{"offer_id":[...]}`，带 `Client-Id` / `Api-Key`。命中取 `sources[].sku` 大于 0 的第一个，`stamp_accept`。连续两次缺失 `stamp_release`。读失败 `stamp_retry`，`claim_until` 清空，状态保持 `unknown`。
- `GET /api/catalog/fetch-config`：超级管理员。无行不插入，返回规格默认值。不选出 WB token 或 Api-Key 密文。
- `GET /api/catalog/wb/subjects/{subject_id}`：坐标失败是同一句 400。空库 `catalog_unavailable`。不调用 WB。
- `POST /api/listing/submit`：禁用标签仍是 400 `banned_tag`，门在鉴权之前。通过门但不是草稿体：400 `validation` `请求格式无效`，不写库、不入队。

认领、窗口认领、续租、probe 和类目 live fill 已由 `TestListingHotPath` 与 `TestListingIntentsCatalog` 锁住。`fillBlank` 已按 `docs/parity/listing-write-parity.md` 写入，不再返回 501。

草稿发送 `SendDrafts`、`GET /api/listing/events`、`GET /api/listing/jobs/{id}` 不在本次改动里。

## 流程不同、结果对齐的点

1. 意图列表的可见店铺子查询写在 `podhub_app` 事务里。`organization_stores` 没有 RLS，`00191` 已授予 `podhub_app` SELECT。过滤条件与规格子查询相同：`org_id`、`deleted_at_ms IS NULL`、主管看全部或 `assignee_membership_id` 等于当前席位。
2. release facts 用类型化的 `unnest` 七列连接，列与规格 `jsonb_to_recordset` 相同（id、store、row、revision、client operation、state、updated_at）。避免把 `timestamptz` 先变成 JSON 文本再比相等。
3. `organizations` 的 `FOR NO KEY UPDATE` 放在同一租户事务里。`00191` 授予了 UPDATE。缺失或 `dissolved_at` 非空：取消返回 `提交意图不存在`，release 返回 `Store 不存在`。
4. 类目错误码改为规格里的 snake_case（`auth_invalid`、`forbidden`、`validation`、`not_found`、`internal`、`not_ported`）。树的成功字节不变。
5. 意图列表和死信的 `limit=100` 再取 1 行，上限 101，因此可以有 `nextCursor`。这和卡片列表把 fetch 再夹到 100 不同，跟规格的 `clamp(1, 101)` 一致。
6. `canResume`：当前 issue 存在且 `allowedActions` 含 `resume` 时为 true。`OZON_WRITES_DISABLED` 加 `resume` 为 true。没有 issue 为 false。多条同时满足时取数组最后一条。

## 路由表

相对原 golden 增加 8 条，方法加路径，没有删已有行：

- `POST /api/listing/dead-letters/{job_id}/requeue`
- `POST /api/listing/intents/release-unknown`
- `POST /api/listing/intents/{id}/cancel`
- `POST /api/listing/intents/{id}/probe`
- `POST /api/listing/intents/{id}/recover`
- `POST /api/listing/jobs/claim-window`
- `POST /api/listing/jobs/{id}/claim`
- `POST /api/listing/jobs/{id}/heartbeat`

`release-unknown` 注册在 `GET /api/listing/intents/{id}` 之前。

## 需要用户决定

- `can_resume` 函数体不在规格里。上面的 `allowedActions` 含 `resume` 是从 `OZON_WRITES_DISABLED` → Resume 推出来的。
- `unknown` 状态另有一段历史对账码例外，规格没有把谓词写全。本端口只在 `code = last_error_code` 且未解决时给出 current issue。
- `importProbe` 的推导没有写出。响应省略该字段。
- `categoryKey` 在 `ListingIntentsQuery` 上，列表 SQL 骨架没有这个谓词。接受参数，不新增过滤。
- `ensure_store_usable` 选出了 `manual_disabled` / `quota_suspended`，决策树只写了无行、无席位、不可见。本端口不因这两列拒绝。
- 类目 schema 成功响应带 `nativeMaterial`。缓存里的 fields 字节仍按存储原文返回（golden 的 `collection: true` 保留）。属性 85 在字典被截断时，live fill 追加搜索材料 `valueId` 126745801、标签「Нет бренда」。缓存命中不改已存储的 fields。
- 未来的 `fetched_at_ms` 视为不可用，issue 用 `catalog_stale`。规格没有给未来时间单独的 code。
- axum 查询反序列化失败的正文是 `Failed to deserialize query string: …`，serde 原文未确认。未知意图查询参数和非法布尔返回 400 `请求格式无效`，不发明英文前缀。`limit` 非整数仍是已经上线的 400 `limit 无效`。
- 成功 JSON 沿用现有 `jsonwire`（无 `X-Content-Type-Options`）。Rust `DomainError` 的错误响应带 nosniff。listing 标签门的 writer 本来就带 nosniff，这条没改。
- 执行租约（jobs claim / heartbeat）与 `writer_leases` 的 `writer.Assert` 不是同一把锁。本端口没有把浏览器作业认领改成写租约。
- `PUT /api/catalog/schema`、`PUT /api/catalog/tree`、`PUT/POST /api/catalog/fetch-config`、`wb-credential`、dictionary-search 不在当前 Go 路由表里。本次不新增（写租约、WB HTTP、或会改 golden 的挂载）。
