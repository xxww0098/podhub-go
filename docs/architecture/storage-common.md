# 存储设计：公共规则

设计始于 2026-10-18，2026-10-24 按当前接线复核。本文分别记录现有实现与统一注册表的目标约束；真实能力边界见 [技术验证清单](../precision-listing-verification.md)。

- [中转桶 transit](storage-transit.md)
- [素材库桶 assets](storage-assets.md)
- [委托图片桶 private](storage-private.md)

## 当前接入范围

| 链路 | 当前身份与读写方式 |
| --- | --- |
| AI 套图 | `internal/app/image_assets.go` 调用注册表服务，直写正式 key，完整回读私有签名 URL 和公开 URL 后确认；基线 schema 为两张 AI 表接入了引用触发器 |
| 用户 PSD | 只在本机 OPFS 保存；方案仅同步摘要和文件名，无云端备份或恢复接口 |
| 厂家商品与平台目录 | 商品字段仍含 URL；公开目录直接读取 `media` / `gallery.url`，供应商图片代理仍按 URL 比对可见性；平台目录图片仍经暂存、回读、复制后保存 URL |
| 委托原图与派单 | `delegate_assets.object_key` 与冻结载荷的 `object_key` 仍是下载依据；尚未改为注册表引用 |
| 中转切片 | 使用批次 key 与短期回收，不进入注册表 |

通用引用触发器目前只挂 AI 两表；用户模板表及其引用由迁移删除。枚举中存在 `source_product`、`catalog_product`、`catalog_sku`、`delegate_asset`、`dispatch` 不表示这些业务表已接入。下面的统一注册表约束不能外推为所有旧路径已经具备的行为。

## 桶

下列为长期系统桶配置；切片由工作空间所有者填写独立的 R2 桶配置。用户 PSD 仅在本机处理，不上传到任何系统桶。云端 CORS、域名、生命周期和权限仍须实查。

| 桶 | 角色 | 保留策略 | 公开域名 | 访问方式 |
| --- | --- | --- | --- | --- |
| 工作空间独立 R2 | 切片 | 所有者选择每天指定时间自动清理，或仅手动清理；默认北京时间 04:00 | 系统启用的 r2.dev 地址 | 公开 URL |
| `podhub-supplier` | 素材库 | 长期 | `https://podhub-supplier.ozon-pod.com` | 公开 URL |
| `podhub-private` | 委托图片与识图暂存 | 长期 | 无 | 签名 URL 或应用代理 |

- **一个主机名只映射一个桶**；不用 `podhub.si` 根域承载桶。
- 两个系统角色不得共用同一 endpoint 下的物理桶；工作空间切片按配置 UUID 使用独立前缀。
- 系统生产桶名固定绑定角色与公开域名：`podhub-supplier` 使用 `assets` 与 `https://podhub-supplier.ozon-pod.com`，`podhub-private` 使用 `private` 且公开域名为空。
- 系统生产桶关闭 `r2.dev`；系统公开桶只保留一个自定义主机名。非默认系统测试桶的公开角色只允许显式的 `https://pub-<32位小写十六进制>.r2.dev`，私有角色仍无公开域名。工作空间切片桶由系统启用 r2.dev；生产自有域名须另行验收。
- 公开桶只存 `jpg`、`png`、`webp`、`psd`、`mp4`、`mov`；服务端写 `Content-Type` 与 `nosniff`，不存 `svg`、`html` 等可执行内容。
- 长期桶身份为 endpoint + bucket + prefix；工作空间切片按配置 UUID 隔离前缀，退休配置保留供清理。
- 生产出口只允许 `*.r2.cloudflarestorage.com`，拒绝重定向与代理；provider 固定为 `cloudflare`。
- 会话 cookie 不设 `Domain`，保持 host-only，并使用 `__Host-` 前缀。
- 桶 CORS 是部署前置条件：允许应用 origin，方法 `PUT/GET/HEAD`，请求头 `content-type`、`if-none-match`、`x-amz-checksum-sha256`，暴露 `ETag`、`Retry-After`；浏览器上传使用 `credentials: "omit"`。

## 服务端配置

`assets` 和 `private` 由超级管理员在「平台管理 → 系统存储桶」手动输入 R2 端点、桶名、公开地址与访问凭据；不使用 OAuth。凭据与 AI、支付配置保存在同一个加密快照，使用 `CLOUD_INTEGRATION_CONFIG_KEY` 加密。接口不回显凭据；空凭据在端点和桶名不变时保留已保存值，修改端点或桶名时须重新填写。保存使用修订号检查并写审计；保存只检查配置格式，不证明外部连接成功。工作空间切片存储独立配置，无配置时不回退系统桶。

| 角色 | 内部账号 ID | 默认桶 |
| --- | --- | --- |
| `assets` | `s3_assets` | `podhub-supplier` |
| `private` | `s3_private` | `podhub-private` |

每组填写端点、桶名、Access Key ID、Secret Access Key；素材桶另填公开地址。桶名留空时保存为角色默认桶，默认桶的公开地址留空时保存为默认公开域名。账号 ID 与对象路径前缀由服务端维护，不作为界面或接口输入，也不在读取接口回显；已有配置在保存时沿用原账号 ID 和前缀。Session Token 不再保存。指定非默认桶后，公开角色必须明确填写该桶的公开地址，不能回退到生产域名。桶名限 3–63 个小写字母、数字及连字符，首尾必须是字母或数字；公开 URL 不允许端口、用户信息、路径、查询或片段。provider 为 `cloudflare`、region 为 `auto`，使用路径式访问。两个角色不得指向同一物理桶，不完整或不符合桶规则的配置拒绝保存。

系统测试桶映射为 `assets → podhub-test-supplier`、`private → podhub-test-delegate`。工作空间切片测试桶通过隔离夹具注入；激活前必须验证授权、写入、私有和公开回读、列举与精确删除。

本地前端的测试桶均须允许 `http://127.0.0.1:1420` 和 `http://localhost:1420`，方法、请求头和暴露头按上述规则配置；部署地址变化时改为实际应用 origin。私有桶也需要允许签名上传和读取，公开访问保持关闭。

迁移时在界面填写原有 endpoint、桶名、公开地址和凭据。升级会沿用已保存快照中的内部账号 ID 与对象前缀，不要先删除旧配置再重建，否则前缀无法从界面恢复，已有对象会失去引用。旧环境变量不再生效，不会自动导入。保存后新请求读取最新配置，已经签发的 URL 仍受其到期时间和云端凭据状态约束。此次配置搬迁不复制、删除或重命名云端对象，也不代表外部链路重新验收通过。

旧的 `R2_ENDPOINT`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` 仅用于回环假桶测试，不能代替工作空间切片配置。定时清理需运行 `worker-media-gc` 并开启 `CLOUD_MEDIA_GC_DELETE`。

## 统一注册表的目标不变量

1. **长期对象有注册行。** 每个可被业务引用的长期对象在 `storage_objects` 有一行。对象元数据、旁路文件、URL 文本都不是身份来源。
2. **引用是显式的。** 业务记录保存 `object_id`；引用表由触发器在业务写入的同一事务里维护；删除前在事务内查引用。
3. **路径只由服务端生成。** 客户端不能声明归属、目录或最终 key。公开性由桶决定。

短期桶例外：切片对象不写注册表、不参与引用检查，依赖批次代数与每日限定前缀清理。

## 注册表上传协议

`internal/media/service/registry` 已实现单次 PUT 的内容寻址、上传会话与确认。当前 AI 适配器使用这条链路；下图是**接入方与注册表共同完成**的协议，业务授权复查和对象证明由接入方负责。平台目录和委托现状见各桶文档：

```text
Presign(purpose_kind, purpose_id, sha256, bytes, extension)
  ├─ 服务端从会话与业务记录解析归属，生成 scope 与正式 key
  ├─ 插入 storage_uploads(pending, object_key, multipart_id, expires_at)
  └─ 返回 PUT URL
        headers: if-none-match: *、content-length、x-amz-checksum-sha256

客户端直传目标桶

Confirm(upload_id)
  ├─ 注册表：按 actor / org 读取上传会话，检查状态与到期时间
  ├─ 接入方：重新校验会话、组织、绑定、来源仍存在且归属未变
  ├─ 接入方：取得长度、类型与 full-object SHA256 证明
  │   └─ HEAD 不足时使用已实现的有界完整 GET 校验，或拒绝确认
  ├─ 注册表事务：取共享 fence 与上传行锁，再查状态及到期时间
  ├─ 命中既有 live 对象且 key 一致则复用，否则插入 storage_objects(live)
  └─ 原子 UPDATE pending → confirmed；已确认重试须仍指向同一对象
```

- **客户端不能指定归属。** 注册表服务接收可信调用方传入的用途、组织与资源 ID，它本身不查询业务授权；接入方必须从会话和业务记录解析并复检。AI 适配器从当前组织与用户传值，不能据此宣称其他用途已经具备完整授权入口。
- **没有暂存桶和服务端复制。** 内容寻址 key 配合签名校验和；注册前仍须取得完整对象的 SHA256 证明，不能把 CRC64 或分片 checksum 当作该证明。
- **注册表签名要求校验和。** provider 不支持签名校验和即拒绝该配置。委托旧入口仍传递 `checksum` 参数并在确认时提供完整 GET 后备，不能混同为同一个签名契约。
- **系统桶和用户切片桶都使用 Cloudflare R2。** 普通上传客户端直连；AI 模型输出由服务端上传，并完整读取私有对象和公开对象，逐一核对长度及 SHA256。
- **`if-none-match: *` 不可覆盖。** 相同内容并发上传时，后到者得到 412，按去重命中处理。
- **分片接入仍是缺口。** 注册表保留 `multipart_id`，但当前注册表服务没有发起、签发分片或 Complete 实现。接入要求是与单次 PUT 使用同一正式 key，在 key 级排他锁内检查目标并完成装配，再取得完整对象 SHA256 证明；不能按分片 ETag 直接确认。过期分片须先 Abort 再清理。这些要求不是已跑通的端到端能力。
- **无完整证明时拒绝注册。** R2 实际 HEAD 可能只有 CRC64NVME。AI JPEG 上限 20 MiB，真实链路采用完整 GET 计算 SHA256；委托上传的 `confirmDelegate` 也有按授权长度限制的 GET 后备实现，但本次没有真实大文件/分片验收，不能因 HEAD 长度或 ETag 正确而确认。
- **扩展名与 MIME 绑定。** `<ext> → <mime>` 固定映射，由服务端写入签名；同一个扩展名不允许两种类型。

### 未确认对象

`storage_uploads` 的 `(bucket_identity, object_key, expires_at)` 表达未确认对象租约，**按 key 而不是按行**判断。`storageregistry.DecideCollect` 已有判断逻辑；当前没有查到把该逻辑接到注册表对象删除的运行时回收器。实现回收器时须取该 key 的排他锁，再确认：

- 若该 key 已有 `storage_objects` 行，只把上传行置为 `expired`；
- 否则执行 `locks` 内的「无 live 行 **且** 无其他未过期 pending 行」检查，通过才删除对象。

这样多个会话上传同一内容时，任一在途会话都不会被另一行的过期清理误删。

### 公开桶的可见性

公开桶是桶级公开。**未确认对象一旦写入即可被任何人读取**，前缀不是安全边界。因此：

- 未确认内容不得包含敏感信息，Presign 即视为同意公开；
- 必须配套 per-org 配额、Presign 速率限制、按用途的硬上限与滥用下架流程；
- 系统公开桶关闭 `r2.dev`，只保留一个自定义主机名，避免绕过边缘控制。

## 数据模型

注册表定义与 AI 用途扩展都在基线 `db/migrations/00002_schema.sql` 里（`storage_objects`、`storage_uploads`、`ai_image_sets` 等）；不在设计文档复制另一份可执行 DDL。

| 表 | 身份与状态 | 约束 |
| --- | --- | --- |
| `storage_objects` | `bucket_identity + object_key` 唯一；`live → deleting → deleted` | 长期对象按 scope、SHA256、扩展名去重；私有对象必须有组织归属；`deleted` 同时记录 `retired_at` |
| `storage_uploads` | 上传会话、用途、正式 key、到期时间、可选 multipart ID | 状态为 `pending/confirmed/expired/aborted/superseded`；确认必须有 object ID 与时间；只对 pending/confirmed 会话施加 live 唯一索引 |
| `storage_object_refs` | `(object_id, owner_kind, owner_id)` 主键 | 业务引用与业务写入同事务维护；对象外键限制删除 |


已接入的 AI 引用由业务表触发器同事务维护。通用触发器支持顶层 UUID 字段、UUID 数组及含 `objectId` / `object_id` 的数组项；不会解析任意嵌套路径或从 URL 恢复身份。扩展到目录与派单时必须：

- 按**集合**做差：先算该业务行所有引用字段（`gallery[]`、`psd[]`、`product_videos[].url`、`product_videos[].coverUrl`、`media[]`）的并集，再 `delete old - new`、`insert new - old`。逐字段做差会在同一对象同时出现在图集与封面时误删唯一引用。
- 拒绝非 `live` 对象：插入前对该行取 `FOR KEY SHARE`，`state <> 'live'` 即报错。
- 业务行删除、级联删除都要清引用；`TRUNCATE` 权限收回。

`storage_object_refs` **ENABLE RLS，但不 FORCE**：定义者触发器以表所有者运行并绕过 RLS。应用角色可读平台引用、当前组织引用，或 staff 可读全部；`podhub_app` 与 `podhub_worker` 均无直接 DML 权限。`storage_objects` / `storage_uploads` 本身没有该租户 RLS 策略，业务授权由调用方与仓储条件承担，不能把引用表的隔离外推给两张元数据表。

删除判据：

```sql
SELECT EXISTS (SELECT 1 FROM public.storage_object_refs WHERE object_id = $1);
```

### 并发与回收

引用检查与对象删除之间必须有锁，否则业务写入可以在检查之后插入引用，对象仍被删除。

- 统一 fence key：`hashtextextended('storage-key:v1:' || bucket_identity || ':' || object_key, 0)`，按物理 key 而不是哈希，同内容不同 key 不互相阻塞。
- 引用触发器取 `pg_advisory_xact_lock_shared(fence)`；确认、复用同样取共享锁。
- 回收器取排他锁，`UPDATE ... SET state='deleting' WHERE id=$1 AND state='live'` 取得行锁，然后在新语句里重查引用；有引用则退回 `live`，无引用才删除对象。
- 去重与复用只命中 `state='live'`；`deleting` 一律视为冲突。
- 保留墓碑：删除后行不物理移除，置 `state='deleted'` 并记录 `retired_at`。内容寻址的 key 不能复活，同 key 重传按新对象处理需要显式规则。
- 已确认但从未被业务引用的对象，由宽限期后的扫描回收；宽限期必须覆盖从确认到业务落库的最大时延。

所有相关事务运行在 `READ COMMITTED`。

## URL 与读取约束

- 统一模型要求业务表存 `object_id`，输出时从已注册对象派生 URL。AI 已接入；用户 PSD 不进入云端存储；目录仍存 URL，委托仍存 key，不能在迁移前删除这些字段。
- 素材桶 URL 形如 `https://podhub-supplier.ozon-pod.com/{key}`；key 已含配置前缀。
- 私有读取采用短时 GET（60–300 秒）或受限代理；代理应设置可信 `Content-Type`、`Content-Disposition`、`nosniff`、`private, no-store`，不透传源站 Cookie，并支持 Range。供应商原图现以 120 秒签名 GET 返回 JSON 或 `307` 跳转，由对象存储直接传输；Go 不再缓冲整包。该路径仍按冻结载荷取 key，尚未接入通用注册表下载，外部验证范围见 [私有桶现状](storage-private.md)。
- 私有桶不接公共 CDN；若必须经过边缘，只用私有主机、绕过缓存，并禁止忽略 query 的缓存规则。
- 嵌入签名 URL 的页面设置 `Referrer-Policy: no-referrer`；日志对 `X-Amz-Signature`、`X-Amz-Credential` 脱敏。
- 公开 URL 使用当前存储账号配置的主机名，不能用生产域名拼接测试桶对象。**key 中已包含 `{prefix}`**，URL 拼接为 `{publicBase}/{key}`，不得重复加前缀。
- 公开对象直接由 R2 自定义域提供，读取不消耗额度，不额外接 CDN。容器按对象实际需要设置 `Cache-Control`；内容寻址路径禁止负缓存（404 TTL = 0），避免先请求后上传时把 404 缓存住。

## 注册对象回收协议（尚未接入运行时）

1. 业务事务删除引用。
2. `state = 'deleting'`。
3. 删除对象。
4. 注册行保留为 `deleted` 墓碑并记录 `retired_at`，不物理删除。
5. 中断后按 `state` 续跑。

正式对象不配置按年龄删除。未确认对象直写正式 key，没有可单独套用生命周期的暂存前缀；按 `storage_uploads` 租约回收，未完成分片另配置 Abort 生命周期。外部桶策略必须实查，数据库引用不能阻止云端规则删对象。

## 管理工具约束

- 可创建未被引用的自定义路径对象。
- 已注册对象的移动与删除一律拒绝。
- 原始桶浏览分页，整页被隐藏也保留下一页游标。

这些是注册表接入后的要求；当前不能假定所有原始桶管理操作都会查 `storage_objects`。上线前必须核对实际列表、移动、删除处理器与外部桶策略。

## 一次性迁移

不做双读、不做双写、不保留旧 key。迁移在一个停机窗口内一次完成：

1. **冻结**：停止待迁移桶的所有写入入口，记录冻结时刻。
2. **清单**：列举旧对象的 bucket、key、大小、哈希；从业务表导出引用关系。清单是迁移的唯一输入，不靠扫桶猜归属。
3. **复制**：按新路径规则写入目标桶，逐对象校验大小与 SHA-256。迁移窗口、请求量和费用需按实际对象清单评估。
4. **重建引用**：在同一事务内写入 `storage_objects`、`storage_object_refs`，并把业务表的 URL/object_key 改写成 `object_id`。派单载荷这类冻结副本同样在事务内改写。
5. **切换**：部署只认识新 key 的版本；旧桶与旧域名保留只读窗口，用于核对，不再被应用读取。
6. **清退**：核对无误后删除旧桶对象与旧账号配置。

旧切片桶（原 `podhub-slices`）按短期对象处理。清退前仍要确认在途任务和外部图片读取已完成，不能以发送受理或等待一天代替确认；删除失败与并发上传也可能使对象跨日残留。

迁移中断时保留已复制对象与清单，按清单幂等重跑；引用重建失败则回滚该事务并继续使用旧引用，不删除源对象。
