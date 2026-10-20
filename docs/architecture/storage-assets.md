# 素材库桶（assets）

日期：2026-10-18。公共规则见 [存储设计](storage-common.md)。

长期公开素材：后端需要长期保存、并对外提供 URL 的 web 货源库图片，以及平台目录图片。归属与审计不同，共用注册表与引用检查。

中转桶的产物不进入本桶：上架载荷引用的是公开存储里已投递的切片 URL，二者生命周期不同。

## 桶

| 项 | 值 |
| --- | --- |
| 物理桶 | `podhub-assets` |
| 公开域名 | `https://assets.podhub.si` |
| 角色 | `assets` |
| 保留策略 | 长期；引用存在期间保留 |
| 去重范围 | 厂家素材 `source:{source_id}`；平台目录图片 `catalog` |
| 上传方式 | 客户端直传（内容寻址） |

## 路径

```text
podhub-assets
└── {prefix}
    ├── sources/{source-id}/{sha256}.{jpg|png|webp|psd|mp4|mov}
    └── catalog/{sha256}.jpg
```

- **来源段保留。** 哈希可从公开 URL 读出；全局去重会让厂家 A 直接引用厂家 B 的图片而不拥有它。去重范围与路径同时按来源隔离。
- 素材类别（图集 / PSD / 视频）存在 `sc_products` 的 `gallery`、`psd`、`product_videos` 数组中，由 `content_type` 与扩展名约束。
- `catalog/` 是平台资产，引用点是平台商品与 SKU 的 `media[]`。

## 去重

| 类别 | `bucket` | `dedupe_scope` | 去重粒度 |
| --- | --- | --- | --- |
| 厂家素材 | `assets` | `source:{source_id}` | **同一来源内**按 `sha + ext` |
| 平台目录图片 | `assets` | `catalog` | 全平台按 `sha + ext` |

相同内容在不同来源下是不同对象；删除一个来源不影响其他来源。同一来源内重复上传直接命中既有 `object_id`，不产生新对象。

## 引用点

| 表 | 字段 | `owner_kind` |
| --- | --- | --- |
| `sc_products` | `gallery[]`、`psd[]`、`product_videos[]`、`product_videos[].cover` | `source_product` |
| `sc_products` | `media[]` | `catalog_product` |
| `sc_skus` | `media[]` | `catalog_sku` |

## 上传

沿用公共直传流程。要点：

- `purpose` 中的来源决定 `dedupe_scope` 与路径段，客户端不能指定。
- 扩展名只接受 `jpg|jpeg→jpg`、`png`、`webp`、`psd`、`mp4`、`mov`，绑定 MIME 与 magic。
- `x-amz-checksum-sha256` 强制；R2 接受签名校验和，服务端不读取对象内容。
- 单次 PUT 与分片上传目标一致；分片 Complete 前先 `HEAD`。
- 本桶全部公开；有下载权限要求的 PSD 不进入本桶。

## 读取

| 入口 | 方式 |
| --- | --- |
| 业务 JSON | 保存 `object_id`，输出时派生 URL |
| 公开目录 `GET /api/public/platform-catalog` | join 注册表，输出派生 URL |
| 供应商图片代理 `GET /api/supplier/images/{object_id}` | 查注册表 → 可见性检查（被该来源的已发布商品引用）→ 按需缩放 |
| 平台目录媒体白名单 | `object_id` 必须存在，scope 为 `catalog` 或该来源的 `source:{id}` |

可见性来自引用表，不做 URL 比对。

## 管理界面

| 层级 | 内容 |
| --- | --- |
| 来源 → 图集 / PSD / 视频 → 商品引用 | 来源名、商品名、原文件名 |
| 平台目录：商品 / SKU → 图片 | 商品标题 |

分组来自数据库，不创建空目录对象。已注册对象不可移动或删除。

## 验收

- 同一来源内相同内容重复上传返回同一 `object_id`；不同来源各自独立，删除一个来源不影响其他来源。
- `source:*` 与 `catalog` 之间不互相复用。
- 平台目录图片被 `sc_products.media` 或 `sc_skus.media` 引用时拒绝删除；删掉引用后可回收。
- 公开目录、供应商代理、平台目录三处读同一对象返回一致内容。
- 白名单外扩展名、扩展名与 MIME 不符、magic 不符、长度不符、checksum 不符全部拒绝。
- 未确认对象不会被任何读路径暴露；并发同内容上传只有一个对象。
- 跨来源、跨 scope 越权读取被拒绝。
