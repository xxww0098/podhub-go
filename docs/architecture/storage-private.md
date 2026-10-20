# 私有数据桶（private）

日期：2026-10-18。公共规则见 [存储设计](storage-common.md)。

组织私有的长期数据：委托原图、PSD 模板，以及工作空间内的其他用户文件。本桶是唯一私有桶，按**高速上传与下载**设计。

## 桶

| 项 | 值 |
| --- | --- |
| 物理桶 | `podhub-private` |
| 公开域名 | 无；关闭 `r2.dev` |
| 角色 | `private` |
| 保留策略 | 长期；引用存在期间保留 |
| 去重范围 | 原图 `binding:{binding_id}`；模板 `org:{org_id}:template`；其他用户文件 `org:{org_id}:file` |
| 上传方式 | 客户端直传（内容寻址） |

私有性由桶保证。会话 cookie 不设 `Domain`，避免发往公开桶域。

## 高速路径

本桶承载大文件与高频上下行，因此：

1. **直传，不经应用进程。** 客户端拿到签名 URL 后直接写对象存储；服务端只在签发与确认时处理元数据，不转发字节。
2. **无中转桶、无服务端复制。** 内容寻址 + 强制 `x-amz-checksum-sha256` 让正式 key 可直接写。
3. **读写都在桶边缘。** 下载使用短时签名 GET（60–300 秒）或应用代理流式转发；本桶不接公共 CDN。
4. **确认是 O(1)。** 确认只做 HEAD 与一次注册写入，不读取对象内容。
5. **大文件只走分片。** 每个分片签 checksum，Complete 由服务端在 key 级排他锁内执行；分片 URL 一次签发完成，客户端并发直传。

三个桶统一使用 Cloudflare R2，客户端直连，不设中继、不设国内存储副本。R2 接受签名校验和，所以服务端从不读取对象内容，也没有降级路径。

## 路径

```text
podhub-private
└── {prefix}
    ├── orgs/{org-id}/originals/{binding-id}/{sha256}.{ext}
    ├── orgs/{org-id}/templates/{sha256}.psd
    └── orgs/{org-id}/files/{sha256}.{ext}
```

- `org-id` 是组织数值 ID；中转桶用的是组织 UUID，两者不混用。
- 原图 `ext` 为 `jpg`、`png`、`webp`、`psd`；其他用户文件按其真实类型，遵循公共扩展名白名单。
- 没有暂存前缀：对象直接写正式 key，未确认状态由 `storage_uploads` 记录。

### 绑定进 key

数据库模型是“一条素材属于一个绑定”。按组织去重会让同一张图用于第二个绑定必然冲突；按绑定隔离后：

- 同绑定同内容 → 同 key，幂等；
- 不同绑定同内容 → 不同 key，各自归属；
- 删除一个绑定不影响另一个。

代价是同一内容按绑定份数存储。单文件上限 500 MiB；不引入跨绑定共享文件表。上线后用注册表按 `sha256` 统计实际重复度。

模板与普通用户文件是组织级资产，同组织内按哈希复用；同一对象可被多条记录引用。

## 数据

| 类别 | `dedupe_scope` |
| --- | --- |
| 原图 | `binding:{binding_id}` |
| 模板 | `org:{org_id}:template` |
| 其他用户文件 | `org:{org_id}:file` |

scope 必须能唯一决定路径段，否则同一组织内同内容的模板与用户文件会命中同一条去重记录却指向不同 key。

| 表 | 字段 | `owner_kind` |
| --- | --- | --- |
| `delegate_assets` | `object_id` | `delegate_asset` |
| `delegate_dispatches` | `payload.lines[].assets[].object_id` | `dispatch` |
| `workspace_psd_templates` | `object_id` | `psd_template` |

**派单载荷必须带 `object_id`。** 供应商下载读取的是派单载荷；只改表不改载荷会出现“表正确、下载 404”。

绑定删除时，同一事务删除该绑定的引用；对象在无派单引用后由回收器处理。

## 上传与下载

```text
Presign(binding_id | org_id, purpose_kind, sha256, bytes, extension)
  ├─ 从会话与业务记录解析组织、绑定、scope 与 key（客户端不传路径）
  ├─ 查 storage_objects：命中 live 且 key 一致 → 返回 object_id 与下载 URL
  └─ 未命中：插入 storage_uploads(pending, multipart_id) → 返回直传 URL

客户端直传正式 key
Confirm(upload_id)
  ├─ 原子 UPDATE ... WHERE state='pending' AND expires_at > now()
  ├─ 重新校验会话、组织、绑定仍存在且归属未变
  ├─ HEAD：长度、类型、full-object checksum 回显（分片必须）
  ├─ 写入或复用 storage_objects（只命中 live），回填 object_id
  └─ storage_uploads → confirmed
```

- 确认阶段必须重新校验绑定：签发到确认之间绑定可能已被删除或改绑。
- `if-none-match: *` 保证正式对象不可覆盖；并发同内容上传由唯一约束收口，冲突后必须校验既有对象的 key 与本次一致。
- 客户端只持有 `upload_id`，它是 `storage_uploads` 行的标识，与会话共同授权。
- 过期上传行先 `AbortMultipartUpload` 再清理；被回收对象进入墓碑，不复活原 key。
- 已确认但尚未被业务引用的对象有宽限期，超期后回收；宽限期覆盖确认到业务落库的最大时延。

| 场景 | 方式 |
| --- | --- |
| 供应商门户下载 | 校验会话与派单归属后，签名 GET 或代理流式转发 |
| 工作空间内下载 | 同上，按组织权限判定 |
| 外部链接 | 短时签名 GET，绑定对象与签发者，不绑定 key 形状 |
| 管理入口 | 不得直接读取未确认对象 |

## 模板

`workspace_psd_templates` 当前没有运行时写入。路径、去重范围与引用类型先定好，模板上传接入时直接使用，不提前增加接口。同一对象被多条记录引用时，删完最后一条才回收。

## 管理界面

| 层级 | 内容 |
| --- | --- |
| 组织 → 绑定 → 原图 | 绑定信息、原文件名 |
| 组织 → PSD 模板 | 模板名称、类目、类型 |
| 组织 → 文件 | 原文件名、大小 |

整页被隐藏也要保留下一页游标。已注册对象不可移动或删除。

## 验收

- 相同原图在同一绑定内重复确认返回同一 `object_id`；不同绑定产生不同对象，删除一个绑定不影响另一个。
- 签发后绑定被删除或改绑时，确认被拒绝。
- 跨组织、跨绑定、越权派单下载全部拒绝。
- 已删除绑定的对象在无派单引用后可回收，中断可续跑。
- 派单载荷更新后，供应商门户下载仍读到同一对象。
- 未确认对象不能通过任何入口读取；上传会话过期后即使对象仍存在也拒绝。
- 单次 PUT 与分片上传得到同一 key；目标已存在时拒绝覆盖。
- 分片上传的每个分片 URL 可一次签发，客户端并发直传；确认不读取对象内容。
- 同一模板对象被多条记录引用时，删除部分记录不回收；删完最后一条才回收。
