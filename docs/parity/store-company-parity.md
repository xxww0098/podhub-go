# 店铺公司名自动填充与分组

本文件记录 ST1。Go 仓库里原先没有店铺列表、改名、密钥保存和密钥校验的 HTTP。Rust 版已退役，这里不引用 Rust 行为，只证明这次改动没有改掉 Go 里已经存在的输出。

`/v1/seller/info` 的字段名由用户用真实密钥核实。本仓库没有复现那次调用。解析保留 `company.name`（简称，用来填店铺名）、`company.legal_name`（全称，用来分组）、`company.currency`、`company.country`、`subscription.is_premium`、`subscription.type`。`company.inn`、`company.ogrn`、`company.tax_system`、`company.ownership_form` 不进结果结构、不写列、不进 slog、不进审计、不进响应。`ratings` 不在这次范围内。字段缺失、类型不对、`company` 为 null 时得到空字符串，不 panic。JSON 本身坏掉时，HTTP 2xx 仍把密钥记为 valid，但不改公司字段。

## 做了什么

迁移 `00330_store_company_names.sql` 和 `00331_store_seller_info.sql` 只追加。00320 已由 main 使用。`organization_stores` 增加可空的 `company_short_name`、`company_legal_name`、`company_currency`、`company_country`、`subscription_is_premium`、`subscription_type`、`seller_info_synced_at`、`seller_key_reason`，以及 `name_source`（`auto` 或 `manual`，默认 `auto`）和 `seller_key_status`（`valid` / `invalid` / `unknown`，默认 `unknown`）。索引是 `(org_id, company_legal_name)`。这张表原来没有 RLS，这次也不打开。`podhub_app` 增加这些列和 `name`、`updated_at` 的 UPDATE 授权。

00330 的列默认值是 `auto`。00332 只改数据：把迁移当时已经有非空店名的行回填为 `name_source = manual`。空店名保持 `auto`。00332 之后新建的行仍用默认值 `auto`。自动填充不需要再确认：来源是 `auto` 时直接写简称，`manual` 不覆盖。

保存或校验密钥之后调用 `Service.OnCredentialSaved` / `OnCredentialVerified`。出站是现有的 `seller.Egress.Call`：`POST /v1/seller/info`，正文 `{}`，`write=false`。客户端仍是 `httpx.OzonClient`。带上连接池时走现有 GCRA。非回环的基址拒绝拨号。成功且店铺名的来源不是 `manual` 时，用简称替换店铺名。`manual` 的店铺名不改。简称、全称、币种、国家、订阅类型非空且不超过列长时写入；`subscription.is_premium` 只有 JSON 布尔值才写入。2xx 且 JSON 对象可解析时写下 `seller_info_synced_at`。密钥健康一并写入：2xx 为 `valid`；401、403、404 为 `invalid`，原因就是这个状态码；传输失败为 `unknown` / `network`；其它非 2xx 为 `unknown` / `upstream`。失败不返回错误，店名保持原样。slog 只打原因类别、org 和店铺 id。

公司币种和 `store_product_sync.currency`（店铺定价币种）都非空且忽略大小写后不同时，校验结果带 `currency_mismatch` 和 `currency_warning`。提示文案是「公司币种 CNY 与店铺定价币种 USD 不一致」这种形式。任一侧为空则不提示。

`GET /api/workspaces/stores/company-groups` 按全称分组。全称为空的进「未分类」，排在最后。每家店铺带上币种、国家、订阅、同步时间和密钥健康。`PUT /api/workspaces/stores/{uuid}` 只接受 `{"name":"..."}`。名字变了才把 `name_source` 写成 `manual`。主管才能改。`POST /api/workspaces/stores/{uuid}/seller-info` 用已经封存的密钥再读一次卖方信息，请求体不能带密钥。它同样走 `write=false` 和现有 GCRA。主管才能刷新。未知 JSON 字段直接 400，响应里不回显正文。

控制台花名册 SQL 和 `SnapshotJSON` 没有改。

## 测试

本机没有 Docker。店铺集成测试用本机 PostgreSQL 16 的 `initdb`（`tests/testkit.StartPostgres`），卖方地址是 `httptest` 回环。`TestResultConsistency` 在没有 Docker 且未设置 `PODHUB_PARITY_DSN` 时跳过；其中的指纹对照由 `TestStoreCompanyAutofillAndGroups` 调用的 `testkit.CompareHeadFingerprint` 覆盖，该断言已通过。

```text
go test -count=1 -timeout 180s ./internal/store/... ./internal/ops/domain/ ./internal/ops/repo/ ./tests/archtest/
go test -count=1 -timeout 180s ./internal/app/ -run 'TestSellerInfo|TestRouteTable|TestPR8BOperationsAreInOpenAPI'
go test -count=1 -timeout 60s ./internal/admin/http/ -run TestAdminRouteCounts
go test -count=1 -timeout 15m ./tests/integration/ -run 'TestStoreCompanyAutofillAndGroups|TestExistingStoreNameBecomesManual'
```

| 测试 | 结果 |
| --- | --- |
| `TestParseSellerInfoKeepsNamesOnly` | PASS。简称、全称、币种、国家、订阅正确；序列化结果没有 inn/ogrn/tax_system/ownership_form/ratings |
| `TestParseSellerInfoToleratesMissingAndOddTypes` | PASS。缺字段、null、错类型不 panic |
| `TestFillName` | PASS。auto 被替换；manual 不替换 |
| `TestGroupByLegalName` | PASS。两组加未分类，未分类在最后 |
| `TestAutofillAndManualAndFailure` | PASS。填充、manual、500、缺字段；日志里没有夹具密钥和税号 |
| `TestRenameSetsManual` | PASS。改名变 manual；同名不变；操作员禁止 |
| `TestCompanyGroupsBytes` | PASS。分组响应字节 |
| `TestSellerInfoReadIgnoresWriteSwitch` | PASS。`OZON_WRITE_KILL_SWITCH=1` 时这次读取仍发出，写计数为 0 |
| `TestSellerInfoRefusesPublicHost` | PASS。`https://api-seller.ozon.ru` 返回 `ErrRefusedOrigin`，读写计数都是 0 |
| `TestHealthCurrencyAndRefresh` | PASS。币种不一致提示；401 为 invalid；传输失败为 unknown/network；刷新写出字段；操作员禁止；日志没有密钥和税号 |
| `TestRefreshRejectsSecretsAndReturnsWarning` | PASS。刷新请求里的密钥和税号字段被 400 丢掉，成功响应带 `currency_mismatch` |
| `TestStoreCompanyAutofillAndGroups` | PASS。回环 Postgres 与回环 mock：字段落库、币种不一致提示、valid/invalid/unknown、刷新、另一个 org 读不到、缺 GUC 失败、库行/日志/分组响应/刷新响应没有密钥和税号字段。goose 迁到 332，指纹对照通过 |
| `TestExistingStoreNameBecomesManual` | PASS。先迁到 329 再插入非空店名；升到 331 后该行仍是 `auto`；00332 把它改成 `manual` 且简称不覆盖。00332 之后新建的行是 `auto` 并被填充 |
| `TestSnapshotJSONOmitsCompanyFields` | PASS。旧控制台快照没有新字段 |
| `TestRosterSQLDoesNotProjectCompanyNames` | PASS。旧花名册 SQL 没有新列 |
| `tests/archtest` | PASS。`store` 登记在 L3，import 基线没有新增 |

夹具密钥是 `fixture-api-key-store-autofill`。没有连接 api-seller.ozon.ru。

`go vet ./...` 通过。`go build ./...` 通过。`go test -count=1 -timeout 25m ./...` 里，与这次改动相关的包都通过。另外四个测试在本机直接失败，原因是 `docker daemon is not available`，它们没有改成跳过：`internal/listing/submit` 的 `TestEnqueueDraftsBatchMatchesSequential`，`internal/queue/repo` 的 `TestEnqueueBatchMatchesSequential`、`TestEnqueueBatchStatementOrder`、`TestEnqueueBatchClaimStillSkipsBrowser`。这四条不读店铺公司名。

## 流程

卖方信息的读取放在租户事务外面：先读店铺，再拨号，拨号结束后再开事务写回健康状态和这次能用的字段。失败的拨号不占着事务，也不挡住密钥保存。写回的列和填充规则与同一次输入在事务里调用相同。没有别的优化。

## 发现的问题

Go 路由表里原先没有 `PUT /api/workspaces/stores/{uuid}`，也没有 `POST /api/workspaces/stores/{uuid}/credential` 和 `.../credential/test`。改名是这次加上的，只改显示名。自动填充没有现成的保存/校验处理函数可以挂钩，所以挂在 `OnCredentialSaved` 和 `OnCredentialVerified` 上，由测试直接调用。`organization_stores` 没有 RLS。

已合并 `origin/main` `565e548`（PR #64，迁移 00335–00337，main 上的路由黄金值 340 行）。PlatformRoutes 仍是 104。路由黄金值按合并后同时挂上仓库、店铺和评级处理器的实际输出，共 343 行。相对 main 多了三条：`GET /api/workspaces/stores/company-groups`、`PUT /api/workspaces/stores/{uuid}`、`POST /api/workspaces/stores/{uuid}/seller-info`。旧路由的方法加路径没有改。

## 需要用户决定

- 同名全称只在同一个 org 里分成一组，不跨组织合并。
- `manual` 的店名不覆盖，但全称和简称仍会更新，分组会跟着变。
- 提交与现名相同的 `PUT` 不把 `auto` 改成 `manual`。
- 操作员不能改名，也不能刷新店铺信息，包括分配给自己的店。
- 定价币种取 `store_product_sync.currency`。没有同步行时不提示币种不一致。
- `ratings` 不落库。`inn`、`ogrn`、`tax_system`、`ownership_form` 不落库。
- 不给 `organization_stores` 打开 RLS。打开会碰到现有不设 `app.current_org_id` 的查询。
- 密钥保存和校验的 HTTP 还没有。要不要等那两条路由移植后再接到 `OnCredentialSaved` / `OnCredentialVerified`。在那之前，生产路径不会在保存密钥时自动填充；刷新接口会打开已经封存的密钥。
