# new-api 计费公式与消费日志表

来源是 [QuantumNous/new-api](https://github.com/QuantumNous/new-api) `3e2ce2c8856e32ca7054d673f8cd059ae466e80c`。副本在 `third_party/new-api`，清单在该目录的 `PROVENANCE.md`。

这是相对 Rust `rating.go` 的有意偏离。聊天结算已经改走 `internal/platform/newapibilling`。`HoldTx` / `SettleTx` / `ReleaseTx` 仍是钱包原语，余额不为负。`GET /api/ai/usage` 和 `GET /api/ai/prices` 还留着，等日志界面上线后再删。`rating.go` 仍给对比测试和其他调用方用，聊天不再调用 `ChargeUsage`。

## 已接受

用户接受 AGPL-3.0 第 13 条。这些文件一旦编进用户能通过网络访问的服务，就要提供对应源码。`NOTICE` 要求界面保留 “Frontend design and development by New API contributors.” 和 https://github.com/QuantumNous/new-api 。本仓库没有日志页，署名留到有前端的那一次。同意拷贝并接受第 13 条，不等于已经决定公开 podhub 里与这次拷贝无关的全部源码；对应源码的边界仍以许可证原文为准。

计费和日志不做兼容层。新表 `ai_consume_logs.quota` 存 new-api 整数额度，不叫 microfen。

## 已定

换算常数是 `newapibilling.MicrofenPerQuota = 1`。拷来的 `common.QuotaPerUnit` 仍是 500000，所以 1 美元 = 500000 microfen。模型倍率 `m = input_microfen_per_million / 1_000_000`。四档价的 output/input、cached/input 就是补全倍率和缓存倍率。分组只读 `GetGroupRatio("default")`，倍率是 1，不把订阅映射到席位表。

选 1 是因为更大的倍数会把 new-api「四舍五入后仍为 0 的可计费额度抬到 1」放大成更多 microfen。`TestScaleOneMinimizesTheLift` 量过这个抬升。典型零售四档（`db/migrations/00102` 的 qwen3.7-flash：输入 40000000、缓存 20000000、输出和推理 160000000 microfen / 百万）在这个常数下总额和分路都与 `rating.go` 相同。

实际费用大于冻结时平台吸收。`SettleTx` 已是 `charged = min(exact, held)`，`absorbed = exact - charged`。不拒绝，也不把余额扣成负数。钱包非负 CHECK 没改。

预扣始终冻结估算，没有信任免预扣。估算是消息正文字符数除以 4 向上取整（没有分词器）。冻结额再被 `max_request_microfen` 封顶。估算为 0 时冻结额就是 0，不偷偷改成 1。

聊天写入前在同一事务里 `writer.Assert`，域是 `billing`（迁移 00305）。锁顺序是 `writer_leases`，然后 `ai_requests`，然后 `user_wallets`。`writer.Forget` 在事务结束时调用。900 秒回收释放冻结时也走这个域。

## 有意差异（对比测试）

命令：`go test ./internal/platform/newapibilling/ ./internal/ai/service/ -count=1`

- 零售样例与 `rating.go` 相同：OCR 40000/3500 合计 2160000；缓存 1000/200/100 合计 52000；prompt 3 合计 120；prompt 1000 合计 40000。分路也相同。
- 舍入样例输入和输出费率都是 500000、各 3 token：总额 3，未缓存 2，输出 1。与 `rating.go` 相同。
- 推理费率不等于输出费率时，公式只有一个补全倍率，推理按输出价计。拆分价 100e6/10e6/200e6/400e6，P=1000、缓存 900、补全 400、推理 300：`rating.go` 159000，公式 99000，差 60000。
- 缓存 token 大于 prompt：`rating.go` 报错；公式把未缓存基数夹到 0，仍按缓存价计费。零售价、缓存 150、prompt 100 时公式收 3000。迁移 00307 去掉 `ai_requests_token_details_within_totals`，才能把供应商报上来的这类计数存下来。
- 抬到 1：100000 microfen/百万、1 个 token，`rating.go` 为 0，公式额度为 1，钱包动 1 microfen。
- 按次：`QuoteFlat(n/500000*500000)` 对 9 精确，对 249 截成 248。扫过 1 到 2000000、并抽样到 1e12，最多少 1。迁移 00306 允许按次总额比标价少 0 或 1。
- 预扣是估算而不是 `max_request` 天花板。零售价估算 1000 prompt token 时冻结 40000，不是 50000000。

聊天金额测试 `tests/integration/ai_billing_test.go` 已改成这条路径。`parity-model` 输入和输出都是 1000000 microfen/百万。「hi」估算 1，上游报 1000：总额 1000，实收 1，吸收 999，日志 `quota` 是 1000。空消息估算 0：冻结 0，不调用 `SettleTx`，实收 0，吸收全部实际费用，余额为 0 的用户也能打到回环上游。

`GET /api/ai/logs`、`/api/ai/logs/stat`、`/api/ai/logs/export` 只读当前组织。分页默认 20，`page_size` 上限 100，`p` 上限 100000。`quota` 统计是筛选窗口里 type=2 的额度合计；`rpm` / `tpm` 只看最近 60 秒的 type=2，不看筛选窗口。`username` 和 `channel` 只有 owner/manager/admin。成员响应去掉 `admin_info`、`root_info`、`audit_info`、`channel_id`、`channel_name`、`channel_type`、`reject_reason`，并把 `channel` 和 `ip` 清空。导出是流式 CSV，不是 NDJSON。单元格以 `=` `+` `-` `@`、制表符或回车开头时前面加 `'`。同一用户并发导出用事务级咨询锁，第二个返回 429；超过 10000 行返回 400。本阶段不写 `quota_saturation`。

返回体里的 `price.max_request_microfen` 现在是这笔请求冻结的估算（再封顶），不是价目表天花板。它来自 `ai_requests.held_microfen`。

## 00293

只追加 `db/migrations/00293_ai_consume_logs.sql`。不改 `00001`–`00292`。

- `ai_billing_ratio_documents`：`org_id` 可空。空值是平台默认行。`podhub_app` 的 RLS 要求 `org_id` 等于 `app.current_org_id`，所以平台行对 `podhub_app` 不可见，也不能由它插入。
- `ai_consume_logs`：列对齐 new-api `model.Log`，另加 `org_id` 和可空的 `ai_request_id`。`channel_name` 在上游是关联字段，不是列。
- 两张表 `ENABLE` + `FORCE ROW LEVEL SECURITY`。`podhub_app` 只有 `SELECT` 和 `INSERT`。缺 GUC 时选择到 0 行，插入失败。`podhub_worker` 没有授权。

指纹对比跳过这两张表的名字。其余 132 张 Rust head 表仍逐列对比。

## 数字

`internal/platform/newapibilling/oracle_test.go` 调用拷来的函数，不在测试里重写公式。

| 情况 | 预扣 | 结算 |
| --- | --- | --- |
| gpt-4o，P=1000，cache=200，completion=100，group=default | 1250 | 1625 |
| gpt-4o，P=3 | 3 | 4 |
| gpt-4o，P=1000 | 1250 | 1250 |
| 同上但 `UsageSemantic=anthropic` | 1250 | 1875 |
| OpenAI，P=100，cache=80，cache create=50 | 125 | 128 |
| `sora-2-pro` 按次，价格 0.5 | 250000 | |
| `dall-e-3` 按次，表价 0.04。整数是 `QuotePerCall` 与 `QuotaFromFloatStrict(price * QuotaPerUnit)` 的共同输出 | 20000 | |
| 分组倍率 0 | 0 | 0 |
| `QuotaFromFloat(MaxQuota+42)` 与 `QuotaFromDecimal(3000000000)` | 2147483647 | |
| `QuotaFromFloatStrict` 对同一溢出 | 返回错误 | |
| 未配置模型 `no-such-model-zz` | 错误 `relay.model_price_not_configured` | |

## 需要用户决定

上面「已定」和「有意差异」里的常数、吸收、始终预扣、分组 default，是按 W1 选的，理由写在那里。下面这些还没定：

1. 估算为 0，或输入费率为 0 因而预扣为 0 时，平台吸收全部实际费用。余额为 0 的用户仍能打到上游。要不要改成一个正的最低冻结，本 PR 没有加。
2. 消费日志对组织内每个成员可见，不是按用户隔离。
3. 日志 UI 放在本仓库还是另一个仓库。另一仓库若闭源，AGPL 问题相同。界面上线时要放 NOTICE 署名和 GitHub 链接。本 PR 没有界面。
4. 阶梯表达式、音频、图像、工具附加费的路由后挂。公式文件已经在副本里，本 PR 不挂 HTTP。
5. 平台默认倍率行（`org_id` 为空）当前对 `podhub_app` 不可见。租户要不要读平台默认，还没有改策略。
6. RelayKit 已在 `internal/platform/llm`，同样是 AGPL。第 13 条已接受。已定：不购买商业授权，本仓库整体采用 AGPL-3.0-only，见根目录 `NOTICE`。
7. 预扣 token 数是字符数除以 4，不是 new-api 的分词器。
8. 导出 10000 行、分页 100 条是这次选的上限。
9. `quota_saturation` 这次不写入 `admin_info`。
