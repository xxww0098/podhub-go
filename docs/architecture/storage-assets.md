# 素材库桶（assets）

2026-10-24 按当前实现复核。公共规则见 [存储设计](storage-common.md)，外部验收范围见 [技术验证清单](../precision-listing-verification.md)。素材桶承载长期公开图片；公开 URL 不提供保密性，按组织或来源分 scope 只约束应用内归属与去重。

## 桶与实际接线

| 项 | 值 |
| --- | --- |
| 物理桶 | `podhub-go-supplier` |
| 公开域名 | `https://podhub-go-supplier.ozon-pod.com` |
| 角色 | `assets` |
| 保留目标 | 长期；业务仍引用的对象不得回收 |

上述生产桶名固定绑定 `assets` 角色与公开域名；测试环境可显式配置 `podhub-test-supplier` 及该桶自己的 `r2.dev` URL，见 [服务端配置](storage-common.md#服务端配置)。这不表示旧生产快照已迁移。外部生命周期规则尚未核实，数据库引用无法阻止云端规则删对象。中转切片仍属于 transit，不因被上架载荷引用而转入本桶。

| 链路 | 当前行为 | 源码 |
| --- | --- | --- |
| AI 套图 | 注册表内容寻址上传，完整读取私有签名 URL 与无凭据公开 URL，核对 SHA256 和长度后确认；同组织复用 | `internal/app/image_assets.go`、`internal/media/service/registry` |
| 平台目录图片 | 客户端上传至私有暂存 key；服务端回读并校验后写长期公开 key，最后把 URL 写入商品或 SKU 的 `media` | `internal/admin/service/catalog_image.go` |
| 公开目录读取 | 直接返回 `media` URL 数组；商品数组为空时读取 `gallery[*].url`，不 join 注册表 | `internal/supply/repo/catalog.go` |
| 厂家图片代理 | 由来源与文件名构造 key，对已发布商品中的 URL 做可见性比对，再读取并按需缩放 | `internal/supplier/repo/media.go` |

平台目录上传只接受不超过 512 KiB 的 JPEG，凭据绑定操作者、商品/SKU、revision 与目标存储身份；确认检查长度、SHA256 和 JPEG 起始字节。该路径使用暂存、回读和再次 PUT，未接入 `storage_uploads` / `storage_objects`，也不是完整图像解码验收。

## 当前路径与读取入口

| 用途 | 当前 key / 路由 |
| --- | --- |
| AI 套图 | `{prefix}orgs/{org_id}/images/{sha256}.jpg` |
| 厂家图片代理对象 | `{prefix}supplier-dbs/{source_id}/{id}.{ext}` |
| 平台目录长期对象 | `images/teams/00000000-0000-4000-8000-000000000000/sha256/{sha256}.jpg`，由 `nativeKey` 生成 |
| 公开目录 | `GET /api/public/platform-catalog` |
| 厂家图片代理 | `GET /api/supplier-dbs/catalog/images/{source_id}/{file}`，要求有效登录会话 |

代理检查来源 `listed`、商品与 SKU `published`、商品未归档，且 `gallery[].url` 或 `product_videos[].coverUrl` 等于构造出的公开 URL。当前仍是 **URL 比对**，没有 `/api/supplier/images/{object_id}` 路由，也不从 `storage_object_refs` 判断可见性。

上述代理和平台目录媒体适配器保留回环存储限制；配置里有生产桶不证明这些入口已能访问真实 R2。平台目录 `nativeKey` 与 URL 拼接也没有采用注册表的 `{prefix}catalog/...` 规则，不能用目标规则推算现有文件位置。

## 统一注册表模型

`internal/media/contract/key.go` 已定义以下目标 key 与 scope。当前 AI 已接入，厂家素材及平台目录须完成业务改造后才能使用相同保证：

| 用途 | 正式 key | `dedupe_scope` |
| --- | --- | --- |
| 厂家素材 | `{prefix}sources/{source_id}/{sha256}.{ext}` | `source:{source_id}` |
| 平台目录图片 | `{prefix}catalog/{sha256}.jpg` | `catalog` |
| AI 套图 | `{prefix}orgs/{org_id}/images/{sha256}.jpg` | `org:{org_id}:image` |

注册表按 scope、SHA256 与扩展名去重，复用只命中 `live` 对象。同内容跨来源应成为不同对象；不以公开 URL 中能看到哈希为理由允许跨来源复用。

| 业务引用 | 目标 `owner_kind` | 当前接入 |
| --- | --- | --- |
| 厂家商品图集、PSD、视频与封面 | `source_product` | 尚无引用触发器 |
| 平台商品 `media` | `catalog_product` | 仍为 URL 数组，尚无引用触发器 |
| 平台 SKU `media` | `catalog_sku` | 仍为 URL 数组，尚无引用触发器 |
| AI 原图 `ai_image_sets.source_object_id` | `ai_image_set` | 基线 schema 已接入 |
| AI 产物 `ai_image_set_items.object_id` | `ai_image_item` | 基线 schema 已接入 |

注册表扩展名白名单为 `jpg|jpeg→jpg`、`png`、`webp`、`psd`、`mp4`、`mov`，AI 与 catalog 用途限 JPEG。MIME 由扩展名决定，但通用注册表只接收调用方提供的对象证明，不自行检查文件 magic；各接入方必须验证真实内容。AI 已有完整 GET 校验，其他大文件与分片不能仅凭 HEAD 长度、CRC64NVME 或分片 ETag 宣称完整 SHA256 已证明。

## 接入与验收条件

- 厂家与目录写入先改为保存 `object_id`，挂入同事务引用触发器，再让读取从注册表派生 URL；不能只改路径或接口名。
- 统一模型下，已引用对象拒绝删除，移除最后引用后才允许回收；当前通用回收器尚未接入运行时，不能承诺已自动清理孤儿对象。
- 管理界面按来源、商品、素材类别展示，不靠空目录对象分组；原始桶删除/移动处理器必须核对注册身份与引用。
- 同 scope 并发上传应只注册一个对象，跨 scope 不得复用；跨组织或来源的应用请求必须拒绝。公开 URL 本身仍可被任何持有者访问。
- 未确认对象不得出现在业务查询中，但公开桶一旦写入即可直接访问；不能把确认流程当成公开可见性的开关。

2026-10-24 的代码与文档复核未执行上述接口的真实桶上传、下载、迁移或回收验收。

2026-10-25 已在旧素材桶的真实供应商商品库页面完成 75MB PSD 五分片上传、完整 SHA256/长度/MIME/文件头确认、商品保存与刷新、公开浏览器完整回读。该证据不证明新的 `podhub-go-supplier` 业务链路已通过。该路径仍使用 `supplier-dbs/{source_id}/{sha256}.psd` 和确认 sidecar；条件完成拒绝覆盖，已有对象只有完整匹配本次授权才允许恢复确认，取消仅清理自身 upload ID。通用注册表迁移及自动回收仍须单独验证，范围与证据见[技术验证清单](../precision-listing-verification.md)。
