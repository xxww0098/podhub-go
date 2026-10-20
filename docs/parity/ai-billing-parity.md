# AI / OCR 与计费钱包（PR-7）

对照 Rust `xxww0098/podhub` @ `a03d735`（v0.0.112）。源码通过只读接口摘录，没有写入该仓库。

本端口优化的是调用顺序和进程边界，不改同一输入下的账本、请求状态和验签结果。每一处都有对照测试。无法证明与 Rust 逐字一致的地方列在文末，不当成已经对齐。

`third_party/new-api`、迁移 `00293`，以及聊天结算改走的公式，另有一份说明：[newapi-billing-parity.md](newapi-billing-parity.md)。钱包原语 `HoldTx` / `SettleTx` / `ReleaseTx` 和 `GET /api/ai/usage`、`GET /api/ai/prices` 仍在。聊天的金额不再走 `rating.go`：预扣是字符估算，结算是拷来的 new-api 公式，差额记吸收，并写 `ai_consume_logs`。同一输入下的聊天金额因此是有意变化，不是还没对齐的遗漏。

## 流程

- 钱包仍是所有者 `user_id` 一行。动作在同一事务里 `FOR UPDATE`、更新 `user_wallets`、追加一条 `wallet_ledger`。重放返回当时记下的余额和冻结，不增加 `version`，不写第二行。
- 钱包、`billing_operations`、`lease_slot` / `lease_window` 语句 `SET LOCAL ROLE podhub_app`，并设置 `app.current_org_id` 与 `app.current_wallet_user_id`。缺 GUC 时 RLS 看不到行。`ai_requests`、订单、兑换码、席位投影仍用会话用户写入，因为迁移只给 `podhub_app` 这些表的 SELECT（`ai_requests`）或没有写授权。没有新增 GRANT，也没有改 `wallet_ledger_is_immutable`。
- 聊天：校验 `Idempotency-Key` → 查重放 → 无价格或公式无法报价则 503 且不建行 → 按字符估算冻结（封顶为价目表 `max_request_microfen`，估算为 0 则冻结 0）→ 同一事务里 `writer.Assert` 域 `billing`，再插入 `dispatching`，冻结额大于 0 才 `HoldTx` → 拒绝 `stream: true`（已冻结则释放，状态 `failed` / `invalid_request`）→ 盖章 `stream: false` 和模型 → RelayKit 只做协议接受 → POST 回环 → JSON 或 SSE 折成一次 completion → `QuoteSettle` → 冻结额大于 0 才 `SettleTx`（`charged = min(exact, held)`，其余 `absorbed`）→ 写 `ai_consume_logs`。不记成欠款。返回体里的 `price.max_request_microfen` 是这笔冻结额。
- 幂等范围是 `(org_id, idempotency_key)`。账本键是 `air_` 前缀的 `public_id`，不是客户端的 Key。`failed` 释放该 Key。
- 并发：RPM 固定窗口 60 秒，满了不增加计数。槽位全有或全无。限额全 0 时不写租约行。
- 支付回调只验签，不访问渠道。支付宝 / 易支付成功正文是 `success`；微信 / Stripe 是空 200。钱包充值 `pending → paid` 后 `topup`。成员名额订单不标成已支付。
- 兑换码、席位投影、成员 `quota_suspended` 与 900 秒 AI reaper、7 天响应体清理都是可调用函数。没有挂到 River，也没有在进程里起定时器。River 不决定这些状态。
- 铺货提交扣费函数按源码 SQL 实现，不挂进队列 worker。
- OCR `POST` 在冻结之前返回 400。识别回写和上传票据没有读完，不能假装写回成功。

## 结果为什么不变

- 钱包以外的 microfen 计价仍是整数：加权和加 500000 后除以 1000000，余数按小数部分从大到小补给，平分时顺序是未缓存输入、缓存、输出、推理。按次模式四项为 0，总额为单价。聊天结算不再走这套舍入，差额见 [newapi-billing-parity.md](newapi-billing-parity.md)。
- 冻结不改余额。结算同时减余额（实收）和冻结（整笔预占）。释放只减冻结。充值只加余额。
- 验签：支付宝 RSA2 规范串不编码、跳过 `sign` / `sign_type` / 空值；微信先 RSA 再 AES-256-GCM；Stripe HMAC 的密钥是 `whsec_` 原文，不是 Base64；易支付是规范串直接拼接商户密钥的 MD5。时间窗是绝对差大于 300 秒才拒绝。
- 出站字节是盖章后的 Chat Completions JSON。RelayKit 的转换结果不替换这个字节。转换失败只记日志，不改计费。

## 对照测试

- `internal/billing/rating_test.go`、`pricing_test.go`：天花板、OCR 样例、拆分、舍入、发布拒绝语。
- `internal/billing/sign_test.go`：支付宝冻结串与签名、易支付 `84e855ac…`、Stripe `3e7c889d…`（`t=1700000000`）、微信 GCM 与报文体。
- `internal/ai/sse_test.go`：Key 字符集、SSE 折叠、`stream: true`。
- `internal/llm/accept_test.go`：盖章 JSON 能过 RelayKit，且测试不拨号。
- `tests/integration/ai_billing_test.go`（`PODHUB_PARITY_DSN` 或 testcontainers）：冻结重放、账本不变量、不可改触发器、缺 GUC / 跨租户、并发扣费、聊天按估算冻结并吸收差额、空估算吸收全部费用、重放不二次上游、SSE 折成同一 usage、`stream: true` 释放、余额不足不建行、OCR POST 不冻结、非回环拒绝、900 秒 reaper、支付宝充值重放、兑换码、席位扫描、用户槽位 429、无任务的铺货扣费不写账。
- `tests/integration/ai_wallet_logs_test.go`：日志 RLS 与成员字段剥离、统计窗口、CSV 公式转义、导出锁与 10000 行上限、两个组织共用一个钱包时无超扣、写租约拒绝。

## 不能证明与 Rust 一致

这些没有被测试说成已经对齐，留给决定。

1. `github.com/QuantumNous/new-api/relaykit` 是 GNU AGPL-3.0。封装在 `internal/llm`，`llm.Converter` 可以换成别的实现。进程要不要在分发构建里继续链这个库，需要决定。付费出站字节仍然是盖章后的 Chat Completions，不使用转换结果。
2. OCR `POST`（行购买、任务回写、合同 422、410）没有端口。现在固定 400 `请求格式无效`，且发生在冻结之前。`GET` 只按 Key 读已存正文，响应包络没有逐字节对照。
3. 账户池、最多 4 次切换、备份模型和 `ocr_models` 没有读完。价格按请求里的 `model` 查找，服务器不改写成池内另一个模型。价格接口的 `ocr_models` / `default_ocr_model` 固定为 null。
4. `GET /api/ai/wallet` 没有带充值列表。充值 HTTP 路径和查询没有读到。响应里是余额视图加最近 50 条账本。
5. `GET /api/ai/usage` 只返回账单字段的子集，不是完整 `AiBillingView`。
6. 成员名额的支付履约（续期批次、店铺配额）没有读完。这类通知返回 400 `failed`，订单保持 `pending`。取消订单的 SQL 没有整段从 `lifecycle.rs` 抄出，本端口把 `pending` 收成 `canceled`。
7. 钱包充值账本幂等键用的是订单 `public_id`。源码注释和唯一索引不一致，键的拼写没有从 `lifecycle.rs` 抄到。
8. `public_id` 是 `air_` 加 32 位十六进制。源码字母表没有打开。
9. 支付完成页 HTML 只保证转义和状态归类，不是字节级黄金样本。
10. 商户配置的加密读取没有端口。未注入密钥时回调 503 `支付渠道未开放`，不会发请求。
11. `ai_requests`、`payment_orders`、`redeem_codes`、`member_seat_lots` 没有给 `podhub_app` 写权限。若生产连接用户就是 `podhub_app`，这些写入会失败。本端口没有加 GRANT。
12. 不变量查询按源码不设置 GUC。`podhub_app` 在 FORCE RLS 下看不到其他用户。测试用表所有者，能看到全部。
13. 铺货扣费没有接到 worker。`CLOUD_LISTING_SUBMIT_PRICE_MICROFEN` 的解析在 `billing/repo.ListingSubmitPriceMicrofen`，与两个杀开关无关，没有第二套杀开关解析。
14. `reconcile_store_quota` 没有读，席位扫描不改店铺配额。
15. 402 正文用的是钱包错误的英文 Display（含两个微元数字）。HTTP 层中文包装没有在摘录里。进行中的 409 文案、未定价时的 503 文案也没有逐字抄到。
16. 出站基址不从环境变量读取。空基址在冻结前 503。测试注入回环 URL。
17. reaper 与权益扫描没有进程定时器。调用方自己决定何时跑 `SweepStranded`、`PruneBodies`、`SweepEntitlements`。
