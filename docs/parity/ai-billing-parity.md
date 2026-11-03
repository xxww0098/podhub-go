# AI 计费钱包与协议入口

对照 Rust `xxww0098/podhub` @ `a03d735`（v0.0.112）。源码通过只读接口摘录，没有写入该仓库。

本文保留 PR-7 的实现与对拍边界。后续定时清扫、写授权和铺货扣费接线见 [对账缺口补齐](reconcile-gap-parity.md)，支付履约见 [管理端账单对拍](admin-billing-parity.md)；下面的「没有接上」仅指当时阶段。

本端口优化的是调用顺序和进程边界，不改同一输入下的账本、请求状态和验签结果。每一处都有对照测试。无法证明与 Rust 逐字一致的地方列在文末，不当成已经对齐。

文本 AI 有三个入口：`POST /api/ai/chat/completions`（Chat Completions）、`POST /api/ai/v1/messages`（Anthropic Messages）和 `POST /api/ai/responses`（Responses）。每个入口只调用同格式的上游账号，不做协议转换；流式请求在冻结之前以 400 拒绝。预扣取价目表的单次上限，结算走 `internal/billing/contract` 的四路整数计价，实际用量在上限内实扣、超出部分记吸收，并写 `ai_consume_logs`。钱包原语 `HoldTx` / `SettleTx` / `ReleaseTx` 和 `GET /api/ai/usage`、`GET /api/ai/prices` 仍在。公式与协议客户端都是本仓库原创实现，见 [决策 D6](../decisions.md)。

## 流程

- 钱包按工作区记账，`workspace_wallets` 以 `org_id` 为主键，同一所有者的多个工作区各有各的余额和冻结（迁移 `00013`，拆分规则见 [subscription-billing.md](../architecture/subscription-billing.md)）。动作在同一事务里 `FOR UPDATE`、更新 `workspace_wallets`、追加一条 `wallet_ledger`。重放返回当时记下的余额和冻结，不增加 `version`，不写第二行。
- 钱包、`billing_operations`、`lease_slot` / `lease_window` 语句 `SET LOCAL ROLE podhub_app`，并设置 `app.current_org_id`；钱包与账本的 RLS 只认这一个 GUC，缺失时看不到行也插不进。`ai_requests`、订单、兑换码、席位投影仍用会话用户写入，因为迁移只给 `podhub_app` 这些表的 SELECT（`ai_requests`）或没有写授权。没有新增 GRANT，也没有改 `wallet_ledger_is_immutable`。
- 文本 AI：校验 `Idempotency-Key` → 查重放（`(org_id, key)` 同时绑定 `api_format`）→ 无价格则 503 且不建行 → 按价目表单次上限冻结（token 模式为 `max_request_microfen`，按次模式为 `per_request_microfen`）→ 同一事务里 `writer.Assert` 域 `billing`，再插入 `dispatching`，然后 `HoldTx` → 拒绝 `stream: true`，状态 `failed` / `invalid_request` → 写入 `stream: false` 和模型 → 按账号格式调用上游 → 解析该格式的 usage → `Price.ChargeUsage` → `SettleTx`（`charged = min(exact, held)`，其余 `absorbed`；`held` 即单次上限）→ 写 `ai_consume_logs`。不记成欠款。返回体里的 `price.max_request_microfen` 是这笔冻结额，也是单次计费上限。
- 幂等范围是 `(org_id, idempotency_key)`。账本键是 `air_` 前缀的 `public_id`，不是客户端的 Key。`failed` 释放该 Key。
- 并发：RPM 固定窗口 60 秒，满了不增加计数。槽位全有或全无。限额全 0 时不写租约行。
- 支付回调只验签，不访问渠道。支付宝 / 易支付成功正文是 `success`；微信 / Stripe 是空 200。钱包充值 `pending → paid` 后 `topup`。成员名额订单不标成已支付。
- 兑换码、席位投影、成员 `quota_suspended` 与 900 秒 AI reaper、7 天响应体清理都是可调用函数。没有挂到 River，也没有在进程里起定时器。River 不决定这些状态。
- 铺货提交扣费函数按源码 SQL 实现，不挂进队列 worker。
- 识图 `POST` 在冻结之前返回 400。识别回写和上传票据没有读完，不能假装写回成功。

## 结果为什么不变

- microfen 计价是整数：四路分别乘以单价后除以一百万，半向上取整一次；按次模式四项为 0，总额为单价。预扣 `QuotePrepay` 直接取价目表单次上限：token 模式为 `max_request_microfen`，按次模式为 `per_request_microfen`。
- 冻结不改余额。结算同时减余额（实收）和冻结（整笔预占）。释放只减冻结。充值只加余额。
- 验签：支付宝 RSA2 规范串不编码、跳过 `sign` / `sign_type` / 空值；微信先 RSA 再 AES-256-GCM；Stripe HMAC 的密钥是 `whsec_` 原文，不是 Base64；易支付是规范串直接拼接商户密钥的 MD5。时间窗是绝对差大于 300 秒才拒绝。
- 出站字节保持入口自带的协议形状，只补 `stream: false` 和模型。Anthropic 使用 `x-api-key` 与 `anthropic-version`，其余使用 Bearer。上游返回非 2xx 时按上游错误结算并记录；无法解析的传输结果标成 `unbilled_unknown`。

## 对照测试

- `internal/billing/contract/rating_test.go`、`internal/billing/contract/pricing_test.go`：天花板、识图样例、拆分、舍入、发布拒绝语。
- `internal/billing/domain/sign_test.go`：支付宝冻结串与签名、易支付 `84e855ac…`、Stripe `3e7c889d…`（`t=1700000000`）、微信 GCM 与报文体。
- `internal/ai/service/sse_test.go`：Key 字符集、SSE 折叠、`stream: true`。
- `internal/platform/aiclient/aiclient_test.go`：三个 endpoint、鉴权头、盖章、非 2xx 处理。
- `internal/platform/httpx/egress_test.go`：目标主机固定、不跟随重定向、回环开关。
- `internal/ai/service/usage_test.go`：三种格式的 usage 归一。
- `tests/integration/ai_billing_test.go`（`PODHUB_PARITY_DSN` 或 testcontainers）：冻结重放、账本不变量、不可改触发器、缺 GUC / 跨租户、并发扣费、聊天按单次上限冻结并结算实际、空 prompt 仍需冻结上限、重放不二次上游、`stream: true` 400 不建行、余额不足不建行、识图 POST 不冻结、上游未配置 503 不建行、900 秒 reaper、支付宝充值重放、兑换码、席位扫描、用户槽位 429、无任务的铺货扣费不写账。
- `tests/integration/ai_openapi_test.go`：三个入口各自结算与重放、同一 Key 换格式 409、响应匹配 `api/openapi.yaml`。
- `tests/integration/ai_wallet_logs_test.go`：日志 RLS 与成员字段剥离、统计窗口、CSV 公式转义、导出锁与 10000 行上限、两个组织共用一个钱包时无超扣、写租约拒绝。

## 差异与历史缺口

以下记录当时未对齐的边界；后续已决事项链接到统一登记，不重复要求确认。

1. 计费公式与协议客户端已改为原创实现；不链接 RelayKit，也不保留 `third_party/new-api`。选择见 [决策 D6](../decisions.md)。
2. 识图 `POST`（行购买、任务回写、合同 422、410）没有端口。现在固定 400 `请求格式无效`，且发生在冻结之前。`GET` 只按 Key 读已存正文，响应包络没有逐字节对照。
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
16. 上游基址来自管理端 AI 账号配置，不从环境变量读取。空基址或没有匹配账号在冻结前 503。公网出口要求 HTTPS 和 443；回环只在 `CLOUD_AI_EGRESS_ALLOW_LOOPBACK=1` 时允许。
17. reaper 与权益扫描没有进程定时器。调用方自己决定何时跑 `SweepStranded`、`PruneBodies`、`SweepEntitlements`。这些跨组织扫描用 00368 的 `podhub_maintenance` 会话（`db.Maintenance()`），不是连接属主。
