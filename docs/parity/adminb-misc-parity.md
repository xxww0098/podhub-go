# 管理端：官方字段包、提示词、视频、媒体

对照规格（Rust `v0.0.112`）：共享门禁、`ozon_listing_field_templates` 官方包、`category_prompts`、`category_videos`、媒体存储快照与源站操作。全局禁用标签的读写早已落地，这次没有改 `internal/listing/rules` 的处理函数。

路由表的方法与路径没有增删。这 18 条在 `Deps.Ported` 里替换了原来的 501。没进这张表的管理路由的成功路径写在其它 parity 文档里，不再是整段 501。

## 和 Rust 同结果的部分

- **错误体**：业务错误是 `{"error","code"}`，码为 `AUTH_INVALID` / `FORBIDDEN` / `VALIDATION` / `CONFLICT` / `NOT_FOUND` / `INTERNAL` / `WRITES_DISABLED` / `UNAVAILABLE` / `MEDIA_COMPLETE_MISSING`。域错误带 `X-Content-Type-Options: nosniff`。超过本路由正文上限是空体 413。处理超时是 `{"code","message"}` 的 504。
- **超级管理员**：先解析身份。请求里有会话材料时，先跑 standing SQL（已绑定验证器，且 `admin_step_up_until` 仍在未来），再拒绝非 `super_admin`。没有会话材料的测试替身不跑 standing，避免改掉既有读测试。顺序：未登录、非超级管理员、未绑定验证器、步骤升级过期。
- **数据库错误**：`55P03` → 503，`Retry-After: 1`，正文「资源正在更新，请稍后重试」。`P0M01` → 409「媒体对象已进入回收，请重新上传」。官方包唯一冲突、提示词创建冲突、视频创建冲突走 23505 的固定句子。提示词和视频的更新唯一冲突不改写成 409。
- **写入闸**：`writer_leases` 里 `domain = admin` 且未撤销的行 `FOR UPDATE`。没有未撤销的行、过期（`expires_at_ms` 或 `heartbeat_at_ms + 60000` 不大于现在）、holder 不是 `axum`、或实例不是 `CLOUD_INSTANCE_ID`（空白则为 `axum-{pid}`），返回 503 `WRITES_DISABLED`。匹配则把心跳和过期都写成这次的 `now`。官方包文案「管理域写入未启用」，提示词「提示词目录写入未启用」，视频「视频池写入未启用」。写和审计在同一事务；审计 0 行则回滚 500。GET 官方包、存储统计、清空，以及目录、移动、删除、预签名、确认，不拿这把闸。空表不再放行，见 `docs/parity/security-hardening.md`。
- **官方包**：`scope = official`，`org_id = 0`，`status = published`。快照取该类目 `updated_at_ms DESC, id DESC` 的一行；没有快照是 400「该类目尚无 Schema 快照，请先同步 Schema」。名称按字节 1–255，在事务内、在查快照之前。`defaults_json` / `dataset_json` 按请求原文保存。类目不一致的替换和删除是 404。GET 没有行仍 200 `{"data":{}}`，并写 `official_package_read`。
- **提示词**：`prompt_` 加去掉连字符的 UUID v4。校验顺序：类目 id、名称 1–255 字、文件名扩展名 `.md` 或 `.txt`、六行俄文简介、固定标签、再交给 wasm `partition`。禁用词命中返回 wasm 的句子。创建 201，更新 200，删除 200 `{"data":{"promptId"}}`。不存在是 404「提示词不存在或已删除」。`created_by_account_uuid` 是 `account_users.public_id`。本进程缓存由 `InvalidateBannedTags` 清掉。
- **视频**：`video_` 加去掉连字符的 UUID v4。链接必须是没有空白的 `https://`，时长 1 毫秒到 1 小时。删除不改源文件。
- **媒体快照**：`schemaVersion` 必须是 1。密钥是 `CLOUD_INTEGRATION_CONFIG_KEY` 经 `config.Load` 读出后做 SHA-256，AES-256-GCM，AAD `platform_integration_config|v1`，失败再试无 AAD。密钥短于 32 或等于示例占位值是 503。没有配置行是 503「平台尚未配置媒体存储」。快照按角色保存三个桶（`storageBuckets`），每个角色一条：`transit` → `podhub-transit`、`assets` → `podhub-assets`、`private` → `podhub-private`；桶名与公开域名逐字校验，持久写入拒绝 `transit` 角色。
- **源站**：列举 XML 用字符串切分。签名用已有的 SigV4。确认票据在 app 层调用已有的 media receipt。非回环主机在拨号前拒绝。管理端清空只对回环 DELETE。校验头的查询名未在规格里写死，确认改为整对象 GET。清空的请求前缀为空时先折到账号根；折完仍为空才是 400「删除必须指定对象前缀」。

## 流程变化，以及为什么结果不变

- 官方包、提示词、视频的 SQL 写在 `internal/admin/service`，直接用 pgx，没有再生成一份 sqlc。语句与规格一致，审计列与 `InsertAudit` 相同，并带上本事务的租约 id。共享的 `InsertAudit` 没有改。
- 票据签发放在 `internal/app/api`，因为 service 不能引用 `internal/media/domain/receipt`。签出来的 URL、票据和确认标记与 receipt 包既有字节一致。
- 源站 HTTP 放在 `internal/platform/r2`，只拨回环。这是规格里的源站客户端，不是 `CLOUD_MEDIA_GC_DELETE` 那条删除开关。

## 规格与测试

| 规格 | Go 测试 |
|---|---|
| 简介六行、BOM、行数、汉字、标题公式 | `TestCanonicalBriefFixture`，`TestCanonicalBriefEdges` |
| 固定标签字符与分段 | `TestFixedTagsEdges` |
| 官方包名称字节与 JSON 对象/数组 | `TestPackageNameAndJSON` |
| 提示词文件名、视频链接与时长 | `TestPromptFileAndVideo` |
| 路径、列举 XML、分组、快照与亚太桶 | `TestPaths`，`TestListXMLAndGroups`，`TestSnapshotAndAccounts` |
| 鉴权前的查询/路径/未知字段，以及非超级管理员 | `TestAdminBRejectsBeforeADatabase` |
| 已替换路由跳过库存守卫 | `TestPortedSkipsInventoryGuard` |
| 非回环拒绝、回环 PUT | `TestExchangeRefusesRemote`，`TestExchangeLoopback` |
| 官方包、提示词、视频、租约、审计、媒体回环、确认、非回环 | `TestAdminBCatalogAndMedia` |
| standing 顺序：验证器、步骤升级、角色 | `TestAdminBStandingOrder` |
| 这三张表没有 RLS | `TestAdminBCatalogAndMedia` 里的 `relrowsecurity` |

```
go test ./internal/admin/... ./internal/app/api/ ./internal/platform/r2/ ./tests/archtest/ -count=1
go test ./tests/integration/ -count=1 -run 'AdminB'
```

## 需要用户决定

- 这三张业务表按规格没有 RLS，也不读 `app.current_org_id`。这和「业务表走 tenantx」的仓库约定不一致。实现按规格，没有发明会失败的 RLS 测试。
- 缺查询参数、非法路径 id、未知查询名，在鉴权前返回 400 `VALIDATION`「请求格式无效」。规格没有写死这个顺序。
- 正文超过本路由上限是空体 413。规格没有写死超限体。
- 进程级的准入队列、全局 30 秒和全局 2MiB 没有做。这 18 条自己加了 30 秒（确认 3900 秒）和 2MiB（确认 65536）限制。
- 已确认，并在 S1 收紧。写入持有者固定为 `axum`。实例是 `CLOUD_INSTANCE_ID`，空白时 `axum-{pid}`，不再使用 `hostname:pid`。没有未撤销的行时拒绝写。已有租约但实例不同是 503。见 `docs/parity/security-hardening.md`。
- 确认时的校验 HEAD 查询名规格未写，跳过，改为整对象 GET。
- Go 在拨号前拒绝非回环主机。Rust 会拨配置里的 endpoint。回环 DELETE 不读 `CLOUD_MEDIA_GC_DELETE`。
- 列举的压缩用 Go 客户端默认。源站调用关闭压缩。
- `http.Client` 构造成功，Rust 的「无法创建源站客户端」到不了。非回环表现为「源站列举失败：refusing non-loopback media host」。
- 删除提示词和视频的审计消息规格没给 JSON，这里用了与创建相同的对象形状。
