# 存储设计：公共规则

日期：2026-10-18。三份桶设计共用的模型与约束：

- [中转桶 transit](storage-transit.md)
- [素材库桶 assets](storage-assets.md)
- [私有数据桶 private](storage-private.md)

## 桶

| 桶 | 角色 | 保留策略 | 公开域名 | 访问方式 |
| --- | --- | --- | --- | --- |
| `podhub-transit` | 短期桶 | 固定上海时间每天 04:00 删除全部对象 | `https://transit.podhub.si` | 公开 URL |
| `podhub-assets` | 素材库 | 长期 | `https://assets.podhub.si` | 公开 URL |
| `podhub-private` | 用户数据桶 | 长期 | 无 | 签名 URL 或应用代理 |

- **一个主机名只映射一个桶**；不用 `podhub.si` 根域承载桶。
- 三个桶不得共用同一物理桶；token 按桶授权，回收器使用独立只删 token。
- 公开域名是精确值，配置校验按角色逐字匹配：`transit` 只接受 `https://transit.podhub.si`，`assets` 只接受 `https://assets.podhub.si`，`private` 必须为空。
- 三个桶都关闭 `r2.dev`；公开桶只保留一个自定义主机名。
- 公开桶只存 `jpg`、`png`、`webp`、`psd`、`mp4`、`mov`；服务端写 `Content-Type` 与 `nosniff`，不存 `svg`、`html` 等可执行内容。
- **桶身份 = endpoint + bucket + prefix。** 有对象后不可修改，变更按迁移处理；URL 派生使用对象自己的桶记录，不使用当前配置。
- 生产出口只允许 `*.r2.cloudflarestorage.com`，拒绝重定向与代理；provider 固定为 `cloudflare`。
- 会话 cookie 不设 `Domain`，保持 host-only，并使用 `__Host-` 前缀。
- 桶 CORS 是部署前置条件：允许应用 origin，方法 `PUT/GET/HEAD`，请求头 `content-type`、`if-none-match`、`x-amz-checksum-sha256`，暴露 `ETag`、`x-amz-checksum-sha256`，`Allow-Credentials: false`。

## 不变量

1. **长期对象有注册行。** 每个可被业务引用的长期对象在 `storage_objects` 有一行。对象元数据、旁路文件、URL 文本都不是身份来源。
2. **引用是显式的。** 业务记录保存 `object_id`；引用表由触发器在业务写入的同一事务里维护；删除前在事务内查引用。
3. **路径只由服务端生成。** 客户端不能声明归属、目录或最终 key。公开性由桶决定。

短期桶例外：切片对象不写注册表、不参与引用检查，依赖批次代数与每日整桶清空。

## 上传：直传，无中转

所有长期对象按内容寻址。客户端在签名 URL 覆盖的约束下**直接写正式 key**：

```text
Presign(purpose_kind, purpose_id, sha256, bytes, extension)
  ├─ 服务端从会话与业务记录解析归属，生成 scope 与正式 key
  ├─ 插入 storage_uploads(pending, object_key, multipart_id, expires_at)
  └─ 返回 PUT / 分片 URL
        headers: if-none-match: *、content-length、x-amz-checksum-sha256（每片）

客户端直传目标桶

Confirm(upload_id)
  ├─ 共享锁 + 原子 UPDATE ... WHERE state='pending' AND expires_at > now()
  ├─ 重新校验会话、组织、绑定、来源仍存在且归属未变
  ├─ HEAD 正式 key：长度、类型、full-object checksum 回显
  ├─ 记录：命中既有 live 对象且 key 一致则复用，否则插入 storage_objects(live)
  └─ storage_uploads → confirmed
```

- **客户端不能指定归属。** 请求只带资源 ID；`purpose_kind` / `purpose_id` / scope / 路径段全部由服务端解析，跨来源、跨组织的伪造在 Presign 就被拒绝，Confirm 再校验一次。
- **没有暂存桶、没有服务端复制、没有中转流量。** 内容寻址 key 加上强制的 `x-amz-checksum-sha256`，使“写进正式 key 的字节就是声明的哈希”由存储侧证明。
- **校验和不可关闭。** 不读取客户端的 `enforceChecksum` 开关；provider 不支持签名校验和即拒绝该配置。
- **三个桶都使用 Cloudflare R2，客户端直连。** 不设中继、不设国内存储副本；不做服务端流式校验降级。
- **`if-none-match: *` 不可覆盖。** 相同内容并发上传时，后到者得到 412，按去重命中处理。
- **分片上传与单次 PUT 目标一致。** 每个分片签 checksum；Complete 请求带 full-object checksum，且由服务端在 key 级排他锁内执行：先 HEAD 确认无对象或对象哈希一致，Complete 后再 HEAD 校验。拿不到 full-object checksum 一律拒绝，不接受仅凭分片 ETag 的装配证明。过期行必须先 `AbortMultipartUpload` 再清理。
- **大文件不出内存。** 确认只做 HEAD；没有 full-object checksum 时不注册。
- **扩展名与 MIME 绑定。** `<ext> → <mime>` 固定映射，由服务端写入签名；同一个扩展名不允许两种类型。

### 未确认对象

`storage_uploads` 的 `(bucket_identity, object_key, expires_at)` 就是未确认对象的租约，**按 key 而不是按行**生效。回收器处理过期行时取该 key 的排他锁，再确认：

- 若该 key 已有 `storage_objects` 行，只把上传行置为 `expired`；
- 否则执行 `locks` 内的「无 live 行 **且** 无其他未过期 pending 行」检查，通过才删除对象。

这样多个会话上传同一内容时，任一在途会话都不会被另一行的过期清理误删。

### 公开桶的可见性

公开桶是桶级公开。**未确认对象一旦写入即可被任何人读取**，前缀不是安全边界。因此：

- 未确认内容不得包含敏感信息，Presign 即视为同意公开；
- 必须配套 per-org 配额、Presign 速率限制、按用途的硬上限与滥用下架流程；
- 公开桶关闭 `r2.dev`，只保留一个自定义主机名，避免绕过边缘控制。

## 数据模型

```sql
CREATE TABLE public.storage_objects (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket          text NOT NULL CHECK (bucket IN ('assets', 'private')),
    bucket_identity text NOT NULL,          -- endpoint+bucket+prefix 的摘要
    object_key      text NOT NULL,
    dedupe_scope    text NOT NULL,          -- 各桶定义
    owner_org_id    bigint,                 -- 平台资产为 NULL
    sha256          bytea NOT NULL,
    byte_length     bigint NOT NULL CHECK (byte_length > 0),
    content_type    text NOT NULL,
    extension       text NOT NULL,
    state           text NOT NULL CHECK (state IN ('live', 'deleting')),
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

    UNIQUE (bucket_identity, object_key),
    UNIQUE (bucket_identity, dedupe_scope, sha256, extension)
);

CREATE TABLE public.storage_uploads (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id         bigint NOT NULL,
    org_id           bigint,
    purpose_kind     text NOT NULL,         -- 服务端解析，客户端不能指定
    purpose_id       text NOT NULL,         -- source / binding / org / catalog
    bucket           text NOT NULL CHECK (bucket IN ('assets', 'private')),
    bucket_identity  text NOT NULL,
    object_key       text NOT NULL,
    dedupe_scope     text NOT NULL,
    sha256           bytea NOT NULL,
    byte_length      bigint NOT NULL,
    content_type     text NOT NULL,
    extension        text NOT NULL,
    multipart_id     text,                  -- 分片上传时必填，用于 Abort
    state            text NOT NULL CHECK (state IN ('pending', 'confirmed', 'expired', 'aborted')),
    expires_at       timestamptz NOT NULL,
    confirmed_at     timestamptz,
    object_id        uuid REFERENCES public.storage_objects(id) ON DELETE SET NULL,

    CHECK (state <> 'confirmed' OR object_id IS NOT NULL),
    UNIQUE (bucket_identity, object_key, actor_id, purpose_kind, purpose_id)
);

CREATE TABLE public.storage_object_refs (
    object_id    uuid NOT NULL REFERENCES public.storage_objects(id) ON DELETE RESTRICT,
    owner_kind   text NOT NULL,
    owner_id     text NOT NULL,
    owner_org_id bigint,                 -- 平台资产为 NULL
    PRIMARY KEY (object_id, owner_kind, owner_id)
);
```

引用由业务表触发器维护，与业务写入同一事务。触发器必须：

- 按**集合**做差：先算该业务行所有引用字段（`gallery[]`、`psd[]`、`product_videos[].url`、`product_videos[].coverUrl`、`media[]`）的并集，再 `delete old - new`、`insert new - old`。逐字段做差会在同一对象同时出现在图集与封面时误删唯一引用。
- 拒绝非 `live` 对象：插入前对该行取 `FOR KEY SHARE`，`state <> 'live'` 即报错。
- 业务行删除、级联删除都要清引用；`TRUNCATE` 权限收回。

`storage_object_refs` 启用并强制 RLS，按 `owner_org_id` 隔离；`podhub_app` 无直接 DML 权限，只能由触发器写入。

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

## URL 与读取

- 业务表存 `object_id`；输出时由 `bucket_identity + object_key` 派生 URL，数据库不保存 URL 文本。
- 公开桶 URL 形如 `https://assets.podhub.si/{prefix}{key}`。
- 私有对象只签发短时 GET（60–300 秒），或经应用代理转发。代理统一设置 `Content-Type`（取注册表）、`Content-Disposition`、`nosniff`、`private, no-store`，剥离源站 `Set-Cookie`，并支持 Range。
- 私有桶不接公共 CDN；若必须经过边缘，只用私有主机、绕过缓存，并禁止忽略 query 的缓存规则。
- 嵌入签名 URL 的页面设置 `Referrer-Policy: no-referrer`；日志对 `X-Amz-Signature`、`X-Amz-Credential` 脱敏。
- 主机名固定，环境差异只通过 `keyPrefix` 表达。**key 中已包含 `{prefix}`**，URL 拼接为 `{publicBase}/{key}`，不得重复加前缀。
- 公开对象直接由 R2 自定义域提供，读取不消耗额度，不额外接 CDN。容器按对象实际需要设置 `Cache-Control`；内容寻址路径禁止负缓存（404 TTL = 0），避免先请求后上传时把 404 缓存住。

## 回收

1. 业务事务删除引用。
2. `state = 'deleting'`。
3. 删除对象。
4. 删除注册行。
5. 中断后按 `state` 续跑。

正式对象不配置按年龄删除；生命周期只用于未确认对象的前缀。

## 管理工具

- 可创建未被引用的自定义路径对象。
- 已注册对象的移动与删除一律拒绝。
- 原始桶浏览分页，整页被隐藏也保留下一页游标。

## 一次性迁移

不做双读、不做双写、不保留旧 key。迁移在一个停机窗口内一次完成：

1. **冻结**：停止三个桶的所有写入入口，记录冻结时刻。
2. **清单**：列举旧对象的 bucket、key、大小、哈希；从业务表导出引用关系。清单是迁移的唯一输入，不靠扫桶猜归属。
3. **复制**：按新路径规则写入目标桶，逐对象校验大小与 SHA-256。R2 读取不计费，复制成本可忽略。
4. **重建引用**：在同一事务内写入 `storage_objects`、`storage_object_refs`，并把业务表的 URL/object_key 改写成 `object_id`。派单载荷这类冻结副本同样在事务内改写。
5. **切换**：部署只认识新 key 的版本；旧桶与旧域名保留只读窗口，用于核对，不再被应用读取。
6. **清退**：核对无误后删除旧桶对象与旧账号配置。

旧切片桶（原 `podhub-slices`）无需迁移：其中的对象按设计每天清空，最长存活一天。停机窗口覆盖该寿命即可，切换后旧切片 URL 自然失效，Ozon 已取走的图片不受影响。

迁移中断时保留已复制对象与清单，按清单幂等重跑；引用重建失败则回滚该事务并继续使用旧引用，不删除源对象。
