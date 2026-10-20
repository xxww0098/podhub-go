# Ozon 错误目录（E2）

服务端把 Seller `import/info` 和请求层 4xx 收成两张计数表。全局表没有租户、没有 offer、没有密钥。组织表只计该组织自己见过的次数。没有前端。

这次不对照 Rust 仓库。既有上架输出、状态和数据是否保持原样，以 Go 里已经存在的发放/报回测试，加上本文件列出的 `TestOzonErrorCatalog` 为准。

## 为什么单独开一条浏览器路由

`POST /api/listing/browser/report` 已经改 `submission_intents` 和 `listing_rows`，并由 `TestBrowserGrantAndReport` 钉住。import/info 发生在报回之后，要能按任务号和 offer 单独幂等。所以新增 `POST /api/listing/browser/import-info`，不改报回的状态机。

请求层 4xx 仍走原来的 report。目录写入发生在 `Report` 提交成功之后。写失败只打日志，HTTP 结果和上架状态保持报回自己的结果。

## 采集点

本仓库没有轮询 `import/info` 的 worker。服务端能看见这份响应正文的现有路径，只有 Seller 代理 `POST /v1/product/import/info`。代理先把 Ozon 的状态和正文写回，再调用观察回调。回调拿不到 Client-Id 和 Api-Key。回调失败不改变代理的状态码和正文。已接受的对账探测仍是 `POST /v3/product/info/list`，不进这个目录。

三条写入：

1. 浏览器 `POST /api/listing/browser/import-info`。白名单字段是 `code`、`field`、`attribute_id`、`attribute_name`、`description`、`state`、`level`，以及任务号、offer、类目、类型。未知字段丢掉。超过 100 条返回 400，一行都不写。需要 `CapListingSubmit`。
2. 浏览器 report 的 4xx。只留 grpc code 和 message。不存请求体。映射是 400→3、404→5、403→7、401→16、429→8。这五个状态上网关 `code` 只有 3、5、7、8、16 才采用，否则仍按 HTTP 状态；所以 400 带 `code: 9` 仍记 `3`。422 和其他 4xx 也记：网关给出正整数 `code` 就用那个数，没有就用十进制 HTTP 状态。attribute、类目、类型缺省仍是 0。
3. 代理上的同一条 import/info。2xx 解析 items；4xx 只记 grpc code 和 message。没有任务号则什么都不记。单次最多 100 条，多出来的丢掉，代理正文仍原样返回。

组织成员用 `GET /api/listing/ozon-errors` 看自己的计数。超级管理员用 `GET /api/admin/ozon-error-catalog` 看全局表，门禁与错误摘要相同：平台角色、验证器、15 分钟内的 step-up。两条都分页，可按 code、类目、类型过滤，按出现次数或最后出现时间排序。

写开关仍只有 `config.Load` 里那个布尔。这条目录不读它，也不因为开关关闭就签发密钥。

## 幂等和锁

幂等键是组织、任务键、offer 键、来源、code、attribute_id、类目、类型。import/info 的任务键是十进制任务号，offer 键是该条的 offer，可以是空串。浏览器 4xx 在报回里没有正整数任务号时，任务键是 `intent:` 加意图 id，offer 键在同一租户事务里从 `submission_intents.offer_id` 读出，不信客户端另传的 offer。报回里有正整数 `taskId` 或 `task_id` 时，任务键改成这个十进制任务号，offer 键为空，和代理 4xx 相同。代理 4xx 的任务键本来就是请求里的任务号，offer 键为空。两边都看见同一次带任务号的调用时，sighting 冲突，全局次数只加一。没有任务号的报回仍用意图 id，和代理那一行对不上，会各计一次。

先插入 sighting，`ON CONFLICT DO NOTHING`。只有新插入的那一行才给组织表和全局表的 `occurrences` 加一。同一任务和同一 offer 再报一次，计数不变。

同一事务里的锁顺序是：行按 code、attribute、类目、类型、offer、任务、来源排好，再写 sighting，再写组织表，然后 `SET ROLE podhub_ozon_catalog` 写全局表。不锁整张表。

冲突时只增加次数和 `last_seen_at`。第一条样本留下。`docs_seed` 不在写者策略的可见范围里，运行中的写入改不到那 8 行。

`attribute_id`、类目、类型缺省记 0。查询参数不传表示不过滤；显式传 0 才筛 0。

样本先按标记剥掉密钥样式的片段，再截到 500 个字符。数据库 CHECK 用同一组标记，漏网的插入会失败并回滚，已经提交的上架状态不动。夹具串是 `fixture-api-key-browser-direct`。

八个种子码都在。只有 `Incorrect_density` 有样本 `密度 0.001–13.55`（短横线是 U+2013）。其余七个样本为空。种子的 `occurrences` 是 0，表示“有这条说明”，不是线上次数。

## 测试

| 测试 | 命令 |
| --- | --- |
| `TestOzonErrorCatalog` | `go test ./tests/integration -run TestOzonErrorCatalog$ -count=1` |
| `TestOzonErrorCatalogFollowup` | `go test ./tests/integration -run TestOzonErrorCatalogFollowup -count=1` |
| `TestSampleRetentionBoundaryDay`、`TestOther4xxKeepsExplicitCodeAndDropsBody`、`TestMissingAttributeCategoryTypeStayZero`、`TestSharedTaskKeyCanonical` | `go test ./internal/ozonerr/domain -count=1` |
| `TestImportInfoObserveLeavesTheResponse` | `go test ./internal/seller -run TestImportInfoObserveLeavesTheResponse -count=1` |
| `TestOzonCatalogGate` | `go test ./internal/admin/http -run TestOzonCatalogGate -count=1` |
| `TestRedactStripsFixtureAndKeepsSellerText`、`TestRedactMarkers`、`TestParseImportDropsUnknownAndStripsSecret`、`TestParseImportRefusesTooMany`、`TestRequestFromReportMaps4xxOnly`、`TestUpstreamIgnoresRequestBodyExceptTaskID` | `go test ./internal/ozonerr/domain -count=1` |
| 既有发放与报回 | `go test ./tests/integration -run 'TestBrowserGrantAndReport\|TestBrowserDirect' -count=1` |

`TestOzonErrorCatalog` 覆盖：种子在且不被覆盖；同一任务和 offer 不重复计数；并发计数正确且没有 `40P01`；描述里的夹具密钥被剥掉，未知字段不入库；跨组织读写失败，缺少 GUC 失败；非超级管理员读不到全局表；2xx 报回仍是 accepted 且不写 `ozon_request`；4xx 报回仍是 rejected / `OZON_ROW_REJECTED`，目录另记 grpc code，第二次报回 409 且次数不变；import/info 不改意图状态，开关为真时仍可记录且响应里没有密钥；审阅者不能上报但可以看本组织；写失败不改已经提交的上架状态；代理观察不把请求体里的密钥存进样本。

## 保留期限

`domain.SampleRetention` 是 180 天（`180 * 24 * time.Hour`）。现有 River 周期任务 `podhub.error_digest` 在投影上一小时之前调用 `ClearExpiredSamples`。`last_seen_at` 严格早于 `now - 180 天` 的活样本被置成空串。等于截止时刻的样本留下。`occurrences`、`first_seen_at`、`last_seen_at` 不改。`docs_seed` 不在这个更新范围内。清理角色是 `podhub_ozon_sample_prune`（`NOLOGIN`、非超级用户、无 `BYPASSRLS`），只能把 `sample_description` 更新成空串。这个周期任务不写 `jobs.state`。

## 登录角色

00320 只把 `podhub_ozon_catalog` 授给了迁移当时的 `CURRENT_USER`。API 会话用户是 `podhub_login_api`。`SET ROLE` 看的是会话用户，所以进入 `podhub_app` 之后再切到目录角色，仍然要求登录角色持有 `SET`。00340 按 writer-lease 的形状补上：`GRANT podhub_ozon_catalog TO podhub_login_api WITH INHERIT FALSE, SET TRUE`。不授给 `PUBLIC`，不授给 `podhub_worker`，不把该角色改成超级用户。没有这层授权时，全局写入失败并回滚，只打 `ozon error catalog` 日志，已经提交的上架状态不动。授权之后同一条路径写入成功。上线核对见 `docs/parity/security-hardening.md`。

## 需要用户决定

- 样本在剥掉密钥之后还可以留下卖家原文。若不能留原文，需要另定替换规则。
- 没有界面。
- 422 和其他未映射 4xx 在没有正整数网关 `code` 时，目录 code 记十进制 HTTP 状态，没有另造 grpc 数字。若 422 必须固定成某一个 grpc code，需要指定那个数字。仓库报回仍按原来的决定：没有数字 Seller code 的 422 不进目录，也不改记成 `3`。
- 400/401/403/404/429 上，网关 code 不是 3、5、7、8、16 时仍按原来的 HTTP 映射。这次没有改这五个状态的结果。
- 浏览器 report 没有正整数任务号时，幂等键仍是 `intent:` 加意图 id 加意图上的 offer。代理 4xx 用任务号加空 offer。这两行对不上，会各计一次。有任务号时两边只计一次。
- 删除组织会级联删掉该组织的 sighting 和观测。全局次数还在。重建组织后同一任务可以再计一次。
- `docs_seed` 的样本不按 180 天清空。`Incorrect_density` 的文档句子会留下。若种子描述也要过期，需要另定。
- 除 `Incorrect_density` 以外的七个种子没有文档描述，样本留空。
- 代理在写完响应之后最多再等 2 秒做这次观察。
- 样本清理失败只打日志，同一轮 `podhub.error_digest` 仍继续做小时投影。
