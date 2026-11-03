# 订阅、购买日账期与店铺续费

2026-10-31 对照当前实现修订，含店铺上限（100）、年付 8 折、订阅优惠码、自动续费订单与到期冻结。基准价格按套餐单价线性计算，店铺数按绝对数量购买，成员不售卖；以购买日按月计算，统一续费。本轮本地回归不代表真实商户或生产部署验收。

## 价格与容量

套餐（free / lite / pro / max）决定功能档位和各自的店铺单价。套餐没有打包月费，也不包含店铺：

- 月价 = 店铺数 × 该档店铺单价。
- 单价存放在 `plans.store_monthly_cents`，不再有全局 `billing_settings`。种子价（分）：

| 套餐 | 店铺 / 月 |
| --- | --- |
| free | 0（不可购买） |
| lite | 2000 |
| pro | 2500 |
| max | 3000 |

- 请求和存储都是绝对数量：`target = {plan_key, stores}`，`stores` 至少为 1，不再有“加购”增量。
- free 工作区固定 1 家店。账号最多自建 3 个未解散工作区，免费与付费工作区均计入该上限。
- 购买时的单价冻结在 `subscription_periods.store_monthly_cents`，之后改价目录不会重算已付期间。续费按下单时的目录单价重新计价。
- 当前能力档位只体现在店铺单价和数量上，没有按套餐的功能开关（见 [决策](../decisions.md) O16）。

## 工作空间钱包

AI 调用（聊天、识图、生图）和钱包充值订单都记在工作空间的钱包上，不再按所有者共享。`workspace_wallets` 以 `org_id` 为主键，`wallet_ledger` 按 `org_id` 追加；两张表的 RLS 只认组织 GUC。同一用户的两个工作空间各有余额、冻结和消费，互不借用。

- 充值、兑换码入账、管理员手动充值与撤回、代理佣金转入（进入代理最早创建的未解散自有工作区）、委托结算冻结都落在对应工作空间。
- 只有工作空间所有者能充值和兑换；成员可见余额、账本和消费日志。
- 解散工作空间时，若账本里仍有未结算的冻结则拒绝；解散后的余额不转移，也没有自动退款。
- 迁移 `00013` 按账本拆分旧的所有者钱包：每个工作空间保留自己账本里未结算的冻结，所有者的其余余额归入其最早创建的未解散工作空间，并各写一条 `wallet-split:<org_id>` 调整账本行，使每个工作空间的钱包等于账本之和。回退（Down）把各工作空间合并回所有者。拆分后的归属是按创建顺序的约定，多工作空间的所有者上线后应核对余额。

## 成员上限

成员不售卖，不计费，目标里没有成员数。每个工作区的成员上限相同，全局为 10 人（含所有者），free 与所有付费档位一样。

- 超出上限的加入者按加入顺序置为 `quota_suspended`；所有者永不暂停。
- 管理员可把某个工作区的成员上限覆盖为 1 至 10 之间的值（`organizations.member_seat_limit_override`），不能超过 10。覆盖值超出范围时管理端返回「成员名额需在 1-10 之间」。
- 订阅接口的 `members{used, limit}` 只用于展示，`limit` 就是该工作区当前的上限；`SubscriptionQuote.current.members` 同样只读。
- 上限常量有三处：`internal/billing/domain.MemberCap`、`internal/admin/users/contract.MemberCap`，以及 SQL `subscription_capacity()` 里的 `10`。集成测试对拍三者；修改上限必须三处同改，并重新生成或更新迁移基线。

例（单价：lite 2000，pro 2500）：

- 首购 lite、7 家店、1 个月：7 × 2000 = 14000 分（¥140）。买 3 个月为 42000 分，无周期折扣；本例未使用优惠码。
- lite 升级到 pro、店铺数不变，中途付款：月差额 = (2500 − 2000) × 店铺数，按剩余服务时长折算。例如 7 家店，10-15 付款，已付服务到 11-01 结束：月差额 3500 分，按 10-01 至 11-01 的锚定服务月折算 17/31，3500 × 17 / 31 = 1919.35，收 1919 分。
- lite 5 家店，10-15 增加 1 家店，已付服务到 11-01 结束：2000 × 17 / 31 = 1096.77，收 1097 分。10-31 增加 25 家店则为 25 × 2000 × 1 / 31 = 1612.90，收 1613 分。

这三例由 `internal/billing/domain/subscription_test.go` 的 `TestDocExamples` 校验。

## 权益与时间

一份工作区订阅分开记录三件事：

- `subscriptions` 保存购买日锚点、全部已付服务的结束时间、当前套餐和 `stores` 的投影，以及版本号。
- `subscription_periods` 保存已经购买的套餐、绝对数量 `stores`、冻结的 `store_monthly_cents`、保留名单 `keep_store_ids` 和订单。区间左闭右开，数据库排斥约束禁止同一工作区的期间重叠。
- 订单及 `subscription_events` 记录付款和履约事实；一个订单只履约一次。

当前付费容量取 `starts_at <= now < ends_at` 的已付期间。`current_end` 是当前容量的切换时间，`term_end` 是全部已付服务的结束时间。未购买的续费配置不能授予权限。

首购立即开始，购买 1 / 3 / 6 / 12 个完整服务月，不按自然月截短。一次购买或续费 12 个月享 8 折，1 / 3 / 6 个月没有周期折扣。续费从全部已付服务的结束时间顺延；已过期重开则从付款时间重新起算。原始锚点保留日期和钟点，例如 1 月 31 日 10:00 → 2 月 28 日 10:00 → 3 月 31 日 10:00。

金额由服务器以分计算。容量变更按购买日锚定的服务月折算，跨期间用有理数累加，最后一次舍入。已经购买的当前及未来期间分别计算：

- 每个期间取更高档的套餐和更大的店铺数；换到更高档套餐时，整个期间按新套餐单价重新计价。
- 收取新旧月价之差，折算到该期间结束；差额不为正则不收费。
- 变更不缩小已付期间，既不重复收费，也不收回已付名额。降低容量或换到更低档套餐时，在下一笔 `renew` 报价中选择目标，并按该目标支付新的完整服务月。没有增长的 `change` 请求返回 `NOTHING_TO_CHANGE`。

## 店铺续费调整

续费时直接选择下一次购买的店铺数量，不绑定某家店铺的独立订阅，也不退款。解绑、删除、手动暂停店铺不改变订阅数量。没有独立保存的未付款续费配置；接口的 `next` 是按当前容量计算的续费建议，未显式指定目标的 `renew` 也使用当前容量。

例如：当前购买 8 家，下次只买 6 家，则当前 8 家继续用满，下一次购买 6 家。实际连接 7 家时，选择保留 6 家即可；实际只连接 6 家或更少则无需选择。保留名单可以少于容量，空位不随机替补。

提前支付下一期 6 家，创建未来已付期间；当前 8 家仍在原定日期结束，不会因提前付款而提前减容，也不会因总有效期延长而推迟减容。

修改未付款订单时，先明确取消旧订单，再按新目标预览和下单。已付款未来期间提高容量需要通过 `change` 补差。例如未来完整服务月从 6 家恢复至 8 家，lite 店铺月价 ¥20 时补 ¥40。未来期间尚未开始时，可以通过 `keep` 免费修改保留名单；套餐、容量与结束时间保持不变。

`change` 对报价冻结的当前及未来已付期间逐段取更高套餐和更大容量，并收取相应差额。例如当前 8 家、已购买未来 6 家时改为 10 家，两段均升到 10 家。后续新一笔续费仍由用户选择目标，默认建议随当前容量变化。

删除名单内店铺后，其名额空闲；新连接店铺不会自动替补。手动停用的店铺不会因订阅变化重新启用。实际连接数量超过下期容量时，订阅页提示重新选择保留名单。

## 暂停与业务收尾

发布入队、浏览器密钥发放、Seller 新请求、批量操作及商品同步准入直接检查已付区间和保留名单。即使后台定时任务延迟，新业务也不能越过服务期间边界。

`quota_suspended` 作为展示投影可以由后台更新。暂停立即阻止新业务，不依赖旧任务是否已经结束。已受理任务继续依照其提交意图处理；回执、状态回写和对账不使用新的店铺准入门槛。配置及历史数据保留。

付过费的工作区在最后一个已付期间结束后冻结，见下文「到期冻结」；从未付费的 free 工作区仍是 1 家店。成员上限不变，保留名单不会购买新一个月。到期排水仍有 24 小时重试收尾边界。

## 预览、确认和支付

`POST /api/billing/quotes` 只持久化报价，绝不修改订阅或已付期间。报价有效期 15 分钟。确认和下单均在工作区锁下校验报价版本、所属工作区、有效期和单次消费状态；名单在确认时重新验证。

订阅页通过购买、续费、扩容或保留名单操作打开结算弹窗。左侧配置套餐、购买月数、店铺数量及已启用的支付渠道，右侧实时显示预估费用；扩容补差须先读取服务端报价。右侧可应用或移除优惠码，只有服务端验证成功的优惠码才展示减免。费用预览后展示实际应付金额与服务日期，阅读并同意购买确认后才能下单。修改配置或移除优惠码立即清除旧报价与确认状态；关闭弹窗不创建订单。

### 年付与优惠码

- `subscribe` / `renew` 购买 12 个月时先将基准总价乘以 80%，再应用优惠码的减免百分比；每一步都以分四舍五入。例：旗舰版 10 家店 × ¥30 × 12 = ¥3,600，年付后 ¥2,880，减免 10% 的优惠码再减 ¥288，实付 ¥2,592。`change` 补差与 `keep` 名单调整不使用这两项优惠。
- 优惠只减本次订单金额，不改变目录和已付期间冻结的基准店铺单价。扩容仍依原有规则按剩余期间补差，不再对补差套用年付折扣或优惠码。系统自动生成的续费单仍为 1 个月，不复用手动购买时的优惠码。
- 超级管理员在「兑换 → 订阅优惠码 → 生成优惠码」配置百分比优惠码并启用、停用。生成表单自动填入随机码，支持重新生成或手动填写。码为 3–32 位字母、数字、短横线或下划线，不区分大小写；减免为 1–99% 整数，开始时间、结束时间必填。次数可选 1–1,000,000 次或通过 ∞ 按钮设为不限次数，列表以 ∞ 展示上限并保留已用次数。表单及列表统一使用北京时间，精确到分钟。
- 可用时段为 `starts_at <= now < expires_at`，到开始时刻自动可用，到结束时刻立即失效，无需定时任务开关。结束须晚于开始且晚于当前时间；过去的开始时间允许立即生效。列表显示「未开始」「可用」「已结束」「已停用」「已用完」，在时段边界自动更新。创建后不修改码、比例、时段和次数，以免既有报价的含义变化。
- 不限次数仍校验可用时段和启用状态，并在下单时原子累加已用次数，不会因次数耗尽失效。API 必须显式提供 `max_uses`，`0` 表示不限次数；省略、null、负数和非整数均拒绝。已用次数用 64 位整数保存。
- 报价只校验有效性，不占用次数。报价与下单事务均校验当前时间在可用时段内；下单还再次校验启用状态、比例及剩余次数，成功创建订单时原子扣减一次。并发不会超用，订单或优惠扣减失败时整笔事务回滚。取消不返还次数，因为系统仍兑现合法的迟到付款，防止已承诺优惠被重复分配。
- 报价明细与订单快照冻结年付折扣、优惠码和应付金额。停用或过期只阻止后续下单，不重算已创建订单。已确认但尚未下单的报价若遇优惠码失效，必须重新预览。优惠后应付至少 1 分。
- 新表与受限查询、扣减函数由迁移 `00020_subscription_coupons.sql` 创建；`00021_subscription_coupon_window.sql` 增加开始时间并同时更新报价和计次的时段校验；`00022_subscription_coupon_unlimited.sql` 增加不限次数及 64 位计数。已有优惠码保留原有上限、时段与状态。普通工作区无优惠码列表或配置权限。购买确认版本为 `subscription-2026-10-31`。

- `GET /api/billing/subscription`：当前套餐和数量、成员占用与上限（`members`，只读）、当前及未来已付期间、续费建议（`next`）、套餐单价目录（`plans`，每项 `key`、`store_monthly_cents`）与购买确认。
- `POST /api/billing/quotes`：预览 `subscribe`、`renew`、`change` 或 `keep`。请求携带当前工作区 UUID，目标为绝对数量 `{plan_key, stores}`。首购或到期重开用 `subscribe`，生效中的订阅用 `renew` 顺延。
- `POST /api/billing/keep`：消费免费 `keep` 报价，修改 `period_id` 指定的未来已付期间名单。报价目标必须等于该期间已购买的套餐和容量；当前期间及未购买的期间不适用。
- `POST /api/billing/orders`：消费付费报价并冻结订单，购买确认由服务器保存版本和同意人。
- `GET /api/billing/orders/{public_id}`：查看工作区自己的订单及购买确认。
- `POST /api/billing/orders/{public_id}/pay`：确认并选择渠道，仅对自动出单的未选渠道订单有效，见「自动续费订单」。
- `PUT /api/billing/auto-renew`：开关自动出单，返回最新订阅视图。

已有待付款订单时，免费配置确认必须明确选择“取消待付款订单并修改配置”。人工核款订单可以在同一事务内取消；外部支付订单须等待渠道确认，状态不明时返回 `PAYMENT_PROCESSING`。超时回收只关闭人工核款订单和未选渠道的自动订单。自动订单不需要这个选择，见「自动续费订单」。

有效付款即使晚于取消也保留并尝试履约；按冻结目标追加服务期间，已有期间的保留名单不会被旧订单覆盖。容量变更订单只修改报价时冻结的服务期间，不扩大到后来新增的期间；冻结期间的时间、容量或单价已变化时转待核对。履约异常时用保存点回滚局部权益写入，保留 `paid` 和待核对原因。重复回调及重复履约不重复创建期间，`paid` 本身不代表权益已经履约。

旧的成员席位批次体系已整体删除：`member_seat_lots`、`member_seat_lot_credits`、`ocr_credit_lots` 三张表，`payment_orders` 上的 `member_seats`、`credit_cents`、`credit_lots`、`renews_lot_id`、`unit_month_cents`、`duration_days` 列，以及兑换码的 `member_seats` 与 `ocr_credits` 产品。订单 `product` 只剩 `subscription`、`wallet_topup`、`platform_goods`；兑换码支持钱包额度和套餐；`organizations.seat_limit` 列不再存在，成员上限由 `subscription_capacity()` 给出。

订阅下单支持人工核款和已配置的支付渠道。人工核款按单号核对付款，管理员确认后使用同一套履约逻辑；支付运行时支持创建支付入口、验签通知、查询恢复及能够证明结果的关单。渠道配置完整且启用后才向用户提供。自建渠道测试不等于真实收款或结算；各渠道的外部验收边界见[技术验证清单](../precision-listing-verification.md)。

### 套餐兑换码

- 超级管理员可批量生成套餐码，指定入门版、专业版或旗舰版、1–100 家店铺、1 / 3 / 6 / 12 个月和兑换截止时间。创建时冻结套餐店铺单价；完整码仅在创建时显示，台账保留尾号。钱包码与套餐码分别列出。
- 工作空间所有者兑换时，已有的当前和未来已付期间不变，兑换期间从全部已付期间结束后开始；没有有效已付期间时立即开始。兑换期间沿用购买日锚点，记录兑换码与订阅事件，原子地消费兑换码并更新订阅投影。
- 如果已连接店铺超过兑换容量，按添加顺序保留容量内的店铺；未来期间可在套餐页面修改保留名单。已选择支付渠道的待付款订阅订单须先处理；未选择支付渠道的自动续费提议会取消，并按新到期日重新出单。
- 兑换码到期、作废或已使用时不能兑换。校验、期间写入、码消费或权益投影任一步失败时，整笔事务回滚。

## 店铺上限

- 购买单位是店铺名额。一家店在 `store_seller_credentials` 里只有一把当前生效的密钥（`credential_revision`），所以 100 个名额等于 100 把密钥。
- 口径是单个工作区：任一期间的 `stores` 不超过 `domain.StoreCap`（100）。账号最多自建 3 个工作区，账号合计的间接上限是 300。
- `paidTarget` 超出时返回 400 `STORE_CAP_EXCEEDED`，`subscribe`、`renew`、`change` 共用。`Upgrade` 取两者较大值，两侧都不超过上限，补差不会越界。
- 迁移 `00014` 把 `subscriptions`、`subscription_periods`、`subscription_quotes` 的 `stores` CHECK 改为 `BETWEEN 1 AND 100`。已有超限行时迁移失败，不截断。上限常量在 domain 与 SQL 两处，`TestStoreCapMatchesTheDatabaseConstraint` 对拍，做法同 `MemberCap`。
- `organizations.store_limit_override` 是管理员人工授权，不受购买上限约束。
- 订阅页店铺数量输入框上限取视图里的 `store_cap`。

## 自动续费订单

只出单，不代扣。系统在到期前为工作区生成一张续费单，用户选择支付渠道付款；不付款就到期，之后重新购买。没有已验证的代扣能力，见 [决策](../decisions.md) O17。

- 触发：`backgroundBilling` 每分钟清扫，`IssueDueRenewals` 调用 `billing_due_renewals` 取候选，再在工作区锁下复核。条件：`subscriptions.auto_renew` 为真、状态 active、`term_end` 在 `RenewalLead`（72 小时）内、没有待付款订阅订单、该 `term_end` 没出过单。
- 内容：目标取最后一个已付期间的套餐与店铺数，购买 1 个月，按出单时的目录单价冻结金额。同一事务内按 `renew` 生成并立即消费报价，订单快照与手动订单同形，履约仍是 `FulfillSubscription`，新期间从原 `term_end` 起算。
- 订单字段：`provider='unselected'`、`payment_deadline_at = term_end`、`created_by_user_id` 取工作区所有者。`payment_orders.auto_term_end` 记录它续的 `term_end`，唯一索引 `(org_id, auto_term_end)` 保证同一到期点最多出一张，无论状态。
- 购买确认：系统不替用户同意。`payment_orders_purchase_agreement_valid` 对 `provider='unselected'` 允许 `purchase_agreement` 为 NULL；触发器 `payment_order_agreement_immutable` 只放行这一次从 NULL 写入。
- 付款：`POST /api/billing/orders/{public_id}/pay`，请求 `{accepted_version, provider?}`，`provider` 缺省为 `manual`，不接受 `unselected`。写入购买确认和渠道，确认人成为订单创建人（协议要求 `accepted_by` 等于创建人），`payment_deadline_at` 重置为 `now + 15 分钟`，然后走既有 `Launch`。此后与普通订阅单相同。已选渠道的订单再次确认返回 409。
- 与改配置的关系：未选渠道的自动单没有外部交易，是系统的提议而不是用户订单。`checkPending` 遇到它（`change`、`keep`、手动下单）直接取消并清空 `auto_term_end`，不需要 `cancel_pending`，下一次清扫按新容量重新出单。
- 开关：`PUT /api/billing/auto-renew`，请求 `{enabled}`，默认开。关闭时取消未选渠道的自动单并保留其 `auto_term_end`，这个到期点不再出单；再次开启会释放已取消自动单的 `auto_term_end`。已选渠道的订单不受开关影响。开关不改订阅 `revision`，不会让用户手上的报价失效。
- 未付款：`billing_reap_subscription_orders` 回收 `provider IN ('manual','unselected')` 且超过 `payment_deadline_at` 的订单。已选外部渠道的订单仍等渠道确认，晚到付款继续履约。
- 提醒：出单时通知所有者（`subscription_renewal_due`），冻结时再通知一次（`subscription_frozen`）。通知投影见 `internal/identity/notifications.go`，前端见 `notification-detail.tsx`。
- 管理端取消、解散工作区、支付配置变更把 `unselected` 与 `manual` 一样视为无外部渠道（`CancelPending`、`dissolve.go`、`payment.go`）。

## 到期冻结

- 判定在 SQL 层，不依赖清扫：工作区存在 `ends_at <= at_time` 的已付期间，且 `at_time` 不在任何期间内，即为冻结。此时 `subscription_capacity` 的 `stores` 为 0，`subscription_store_allowed` 对所有店铺返回 false。从未付费的 free 工作区不变，仍是 1 家店。无宽限期。
- 现有店铺准入都经过 `subscription_store_allowed`：`listing/submit`、`delegate/repo/posting_sync.go`、`ops/repo/admit.go`、`seller/ozon/repo/upstream_admit.go`，以及 `store/repo` 的 `product_write`、`sync_gates`、`listing_credential`。改这一个函数即覆盖全部，没有逐个入口改。本轮只验证了函数本身和视图，未逐个入口端到端复核。
- 媒体中转不经该函数。`reserveTransit` 在 `stores = 0` 时把上传额度置 0。
- 订阅视图的 `frozen` 等于当前 `stores.limit == 0`。冻结期间保留：登录、成员列表、历史数据与配置（只读）、订阅与订单页、钱包充值。成员不被暂停。已受理任务继续走 24 小时排水，回执、回写、对账不加门槛。
- `organization_stores.quota_suspended` 对全部店铺置 true，作为界面展示。付款履约后 `ProjectSubscription` 重算，恢复按现行保留名单规则。
- `store_limit_override` 优先于冻结，管理员人工授权的工作区不会被冻结。
- 数据一律保留；长期冻结的回收期限未定义。

## 数据库与验证

基线 schema 移除了必须在北京时间月初到期的旧触发器，包含服务期间表和购买日锚点（原 `00350_subscription_periods.sql`）。PostgreSQL 使用 `btree_gist` 扩展保证区间不重叠，期间表强制工作区 RLS。跨工作区定时维护通过受限的数据库函数查找候选，不向应用开放 lookup 角色。

计价字段在基线 `00002_schema.sql` / `00003_seed.sql` 中：

- `plans` 只有 `store_monthly_cents` 一个价格列，没有 `member_monthly_cents`；原 `price_monthly_cents`、`price_yearly_cents`、`seat_limit`、`max_stores` 已删除，`billing_settings` 表不存在。
- `subscriptions.stores` 取值 1 至 100（迁移 `00014` 起，之前只要求至少 1），默认 1；`subscription_quotes` 同样保存绝对数量。没有持久化的 `next_plan_key`、`next_stores` 或 `renew_with_change` 开关。`subscriptions`、`subscription_periods`、`subscription_quotes` 没有成员列。
- `subscription_capacity(workspace, at_time)` 的 `stores` 直接取已付期间的列；没有覆盖 `at_time` 的期间时，从未付费取 1，付过费取 0（冻结，迁移 `00014`）；`members` 取 `organizations.member_seat_limit_override`，没有覆盖时取 10。

回归覆盖购买日及闰年月底、线性计价与 `TestDocExamples` 的文档例子、升级套餐按单价差补差、无副作用预览、并发管理员、提前低容量续费、未来期间恢复补差、当前与未来已付期间一起增容、删除保留店铺、免费更换未来名单、晚到付款和重复履约、履约异常保留收款事实、未续费到期、后台期间切换及接口 OpenAPI 契约，另有店铺上限（domain 与数据库约束对拍）、自动出单窗口与去重、选渠道付款、改配置替换、开关、到期冻结与恢复、`store_limit_override` 优先于冻结。普通数据库角色的 HTTP 回归同时检查租户隔离、金额冻结、名单确认失败的事务回滚和并发下单。
