# 委托图片桶（private）

2026-11-02 更新。公共规则见 [存储设计](storage-common.md)。用户自配 R2 只承载切片；平台静态桶承载商品库素材，私有桶承载委托图片及现有识图暂存。用户 PSD 只在本机使用，不上传、备份或从私有桶恢复。

## 桶与当前委托原图

| 项 | 值 |
| --- | --- |
| 物理桶 | `podhub-go-private` |
| 公开域名 | 无；部署要求关闭 `r2.dev` |
| 角色 | `private` |
| 委托图片 | 仅 jpg/png/webp，单文件 500 MiB；PSD 不接受，见 `internal/delegate/domain/seller.go` |
| 当前原图 key | `{prefix}{org_id}/{sha256}.{ext}` |
| 当前资产身份 | `delegate_assets.asset_id`、`object_key`；派单冻结载荷保留 `asset_id` 与 `object_key` |

私有性依赖桶的实际访问策略，路径前缀本身不提供访问控制。会话 cookie 保持 host-only，不发往对象桶。

`Seller.Presign` 先验证当前组织内的绑定与店铺，再用 `AssetKey` 生成按组织内容寻址的 key，返回签名 PUT 与 `upload_ticket`。委托接口的请求、响应字段与查询参数统一使用 OpenAPI 声明的 snake_case，成功响应保留 `data` 信封。**当前 key 不含 binding_id**；`CommitAsset` 以 `(org_id, object_key)` 查重，`ReplayAsset` 拒绝把已属于另一绑定的同一对象重新指派。因此同组织同内容用于第二个绑定仍会冲突，不能宣称已做到按绑定独立存储。

确认凭据绑定操作者、组织与绑定/店铺用途；`confirmDelegate` 在强制 checksum 分支优先检查 HEAD，无法取得完整 SHA256 时按授权长度有界 GET，检查 MIME、长度与 SHA256。确认后还重查会话、绑定店铺和存储 revision。该链路使用签名票据和 `delegate_assets`，未接入 `storage_uploads` 或 `storage_objects`。

浏览器通过 `x-podhub-store-checksum: sha256` 申请签名校验头，按授权的 `headers.checksum_sha256` 发送 PUT；当前入口仍传递 `checksum` 参数，无可信完整 HEAD 证明时必须走完整 GET。不能因为注册表签名器强制 checksum，就认定委托入口使用相同契约。CRC64NVME、分片 ETag 或正确长度均不能替代完整 SHA256 证明。

## 当前供应商下载

`internal/supplier/repo/media.go` 先按履约授权和固定派单归属读冻结载荷，再从匹配 `asset_id` 的载荷项取 `object_key`，不是通过注册表查 `object_id`。撤权后的本人历史包仍可读，具体权限见 [账号与权限模型](account-permission-model.md)。

| 分支 | 当前实现 |
| --- | --- |
| 请求 JSON | 返回 120 秒签名 GET、文件元数据；响应设置 `private, no-store` 与 `Referrer-Policy: no-referrer` |
| 请求文件 | 返回 `307` 到短期签名 GET；浏览器保留 `Range` / `If-Range`，对象存储直接传输，Go 不读正文 |
| 存储配置 | 授权后使用平台管理中与委托上传共用的私有桶；默认 `podhub-go-private`，测试可明确指定 `podhub-test-delegate`，均不得配置公开域名；不回退到假桶 |

授权、跳转和错误响应统一设置 `private, no-store`、`no-referrer` 与 `nosniff`。签名覆盖最终对象响应的 `response-cache-control=private, no-store`、可信内容类型和文件名；安全图片预览使用 inline，JSON 下载和其他类型使用 attachment，未知类型降为 `application/octet-stream`。链接有效期为 120 秒，返回过期时间与 SigV4 的秒精度一致；保存凭据轮换或停用后新请求读取最新配置，已经签发的链接仍受其到期时间和云端凭据状态约束。

原图读取已移除 Go 代理的 20 MiB 上限；500 MiB 稀疏文件的跨 64 MiB 边界、尾部和开放范围请求、`If-Range` 版本变化及 `416` 已在本地 HTTP 实测。真实 PostgreSQL、正常登录 cookie 与 `podhub_login_api` 下验证了冻结载荷授权、签名生成、错误响应、停用与轮换，未使用 superuser 执行业务读取。该验证不代表真实 R2 500 MiB 下载或浏览器断点恢复已经通过。

2026-10-25 只读检查发现，旧生产快照仍使用旧字段，委托桶为停用的 `podhub-delegate`，不能作为新私有桶能力的外部证据。当前 `podhub-go-private` 已通过基础 R2 对象操作验证；应用内下载与撤权行为仍须使用真实对象验收。

## 当前删除

`DeleteAsset` 删除资产业务行后检查 `delegate_dispatch_assets`，无派单引用时标记 `Reclaimed` 并尝试调用存储删除。外部删除受开关与适配器限制；服务层忽略删除调用返回值，不能把 `Reclaimed=true` 解释为源站已确认删除。该流程没有使用 `storage_object_refs` 或注册表墓碑回收器。

## 用户 PSD 仅保存在本机

批量上架绑定 PSD 时，浏览器校验文件并写入本机 OPFS，再保存方案的摘要与文件名。服务端不接收 PSD 字节；原有模板注册、确认、分片、续传和下载接口均已删除。本机文件丢失时需重新选择原文件。平台商品库提供的模板仍可从商品库下载，不会把用户模板上传回去。

迁移 `00028_drop_user_psd_backups.sql` 删除 `workspace_psd_templates` 和相关备份引用、上传会话。已有对象清单保留，迁移不删除远端对象或委托图片；旧备份不再有产品读取入口。

## 当前识别图暂存

浏览器识别任务使用私有 key `ocr/{org_id}/{job_id}/{lease_epoch}/{image_sha256}`。上传票据绑定正常会话、组织、任务和租约，以及当前存储身份、图像 SHA256、长度和 MIME；服务端完整读取并验证对象后，才用服务端保存的 AI 账号调用模型。浏览器不接收服务商密钥。

这条链不写 `storage_uploads`，不能按通用上传注册表推算其对象，也不能将识别暂存当作长期 PSD 或履约原图。真实单识别和完整组合各上传一个 65,469 字节的 1024×1024 JPEG；私有完整 GET、模型结果、业务回执和账本已交叉回读。验收清理只处理这两个精确任务的暂存 key，不代表运行时已具备自动回收能力。

## 统一注册表模型

下面的路径由 `internal/media/contract/key.go` 定义。私有用途拒绝 PSD；当前委托上传、冻结载荷和供应商下载尚未切换到注册表：

```text
podhub-go-private
└── {prefix}
    ├── orgs/{org_id}/originals/{binding_id}/{sha256}.{ext}
    └── orgs/{org_id}/files/{sha256}.{ext}
```

| 用途 | `dedupe_scope` | 目标引用 |
| --- | --- | --- |
| 委托原图 | `binding:{binding_id}` | `delegate_assets.object_id` 与派单载荷中的 `object_id` |
| 其他组织文件 | `org:{org_id}:file` | 接入时定义业务所有者 |

按绑定生成 key 后，同绑定同内容可幂等复用，不同绑定各有对象；代价是相同内容按绑定份数存储。当前委托代码尚未实现这一迁移。用户 PSD 云存储已移除；普通组织文件仍不能仅凭用途枚举视作已有产品能力。

接入要求：

1. 客户端直传正式 key；服务端从可信会话与业务记录决定用途、组织、绑定和 scope。
2. `storage_uploads` 记录 pending 会话；确认重查业务授权并取得完整对象 SHA256 证明，再写入或复用 live 注册对象。
3. 业务行和派单冻结载荷一并改成 `object_id`，引用在同一事务维护。通用触发器目前不解析派单嵌套 JSON，需明确实现引用提取；只改资产表会破坏下载与保留边界。
4. 引用解除后才能回收对象，并保留 deleted 墓碑；当前只有注册表状态模型，尚无完整运行时回收接线。
5. 分片与单次 PUT 应使用同一 key，并发上传与 Complete 必须取得完整对象证明。注册表的 `multipart_id` 字段不代表发起、Complete、Abort 已形成可用链路。

## 验收条件

- 绑定删除或改绑后确认拒绝；跨组织、跨绑定及越权派单下载拒绝。
- 迁移后的同绑定重复上传返回同一对象，不同绑定互不冲突；旧冻结载荷仍能下载同一内容。
- 下载覆盖实际最大文件、Range、内存占用、签名过期与撤权后的历史读取；代理缓存头符合私有数据要求。
- 未确认对象不进入业务读取；原始桶管理入口也按授权限制，不能只靠 `uploadTicket` 隐藏对象。
- 对象存在时拒绝覆盖；分片缺少完整证明时拒绝确认，过期分片先 Abort 再回收。
- 最后引用删除后的实际源站删除需要回读证据；数据库标记与尝试删除不等于回收成功。
