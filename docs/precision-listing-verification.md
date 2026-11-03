# 精铺功能技术验证与准入

2026-11-02 产品调整：用户 PSD 云备份、续传和云端恢复已移除，相关历史验收记录不再表示当前能力。PSD 仅保存在本机；平台商品库模板下载保留，委托只接受 jpg/png/webp 图片。

证据记录日期：2026-10-22。范围：候选能力、代码调用链、隔离测试与外部接口实测。2026-10-23 整理文档，2026-10-24 对照当前代码复核调用链与复跑说明；这两次文档维护均未重新执行下述功能验收。

2026-10-25 补充真实三测试桶的浏览器上传、确认、持久化回读与 CORS，以及后续批量上架整页切片、上传、75MB 大文件/分片、PSD 私有云备份和真实识别/组合准备证据，范围见下方独立记录。

2026-10-27 后端逐页复验补充：沿用已授权店铺与测试桶，补齐固定白名单的 Ozon 业务只读出口、类目缓存普通数据库角色事务、原生 canonical 字段版本注册及对应 OpenAPI 可空字段。真实读取 55 个字段后，经正常 HTTP 创建商品行；新配置的 `qwen3.7-flash` 完成私有图片上传确认、俄文标题/描述/标签回写、扣费与幂等回读。两个带英文标记图片的生成结果分别混入中文或拉丁标签，均被契约拒绝并保留实际用量，未写入商品；无英文标记的蓝杯样例通过。该证据不扩大为模型质量泛化或完整必填属性正确。

同日 R2 实际上传、服务端确认、独立摘要回读和精确清理通过；Ozon 商品、价格、库存、聊天与仓库有成功读取，订单/退货/供货为空，评价与问答受店铺订阅权限限制。该阶段真实外部验证使用普通 API 数据库角色及进程局部真实 DNS，保留公网地址校验；当时常规本机启动仍受 VPN fake DNS 影响。后续正式 DNS、支付运行时、代理路由及类目执行器补齐见文末「本地运行时补齐与复验」，不再沿用本段当时的运行时阻塞结论。支付签名、提现账务与 VLESS REALITY 的自建隔离测试不计为真实收款、转账或公网 Seller 代理通过。该阶段逐项依赖、剩余代码与安全证据见 [2026-10-27 外部验收清单](/Users/xxww/.codex/visualizations/2026/10/26/01a17923-5745-7982-b483-fd334f51cd10/backend-qa-20261027/external-checklist.json)。本轮没有 Seller 写入或生产部署。

本页是精铺准入结论的统一入口。下文按验证阶段保留结果，后续证据只推进已覆盖的能力；较早的失败或未通过记录不删除。`/Users/…` 证据链接和 `/tmp/…` 日志位于原验收机器，未随仓库分发，临时日志可能失效。复核外部能力时需重新取得证据，不能只引用本文结论。

2026-10-28 物流方向确认：用户明确后续按 OGL 开发。旧样本 `4877007` 的 FBS/rFBS Express 更新拒绝只约束该仓及那两类接口，不是 OGL 地址管理的否定结论。OGL 官方后台流程与本系统接口准入分开记录，范围见 [OGL 开发方向](parity/warehouse-parity.md#ogl-开发方向2026-10-28-确认)。

已准入的范围包括本轮输入的本地 PSD 切片与媒体交付、白杯样例的俄文识别和组合准备、人工试算、限定模型三图套图及人工选用，以及单商品发送/改价与独立回读构件。识别质量泛化、自动利润定价、在售与库存、大批量及跨进程恢复仍未通过；新 Go 未部署。逐项边界见[当前结论](#当前结论)。

## 准入门槛

1. 明确真实输入、期望输出、持久化位置和验收标准。
2. 内部能力必须用真实实现验证输入到输出，并验证保存/回读和失败行为；纯展示能力只需验证其真实数据来源与交互。
3. 涉及平台或模型的能力，必须补齐授权和实际环境验证。文档存在、请求字节正确或模拟 HTTP 返回成功，都不等于外部能力通过。
4. 发布必须区分排队、发送、平台受理、审核、在售；结果未知时保留锁定和核对流程。
5. 未通过的候选能力不加入产品入口，不用静态演示或成功提示代替实现。先做最小技术验证，再决定前端和后端范围。

本表的「本地通过」只允许复用对应构件，不扩大为整项业务功能通过。

产品入口必须位于 `web/src` 的真实 React 页面并连接正常 HTTP 路径；`/tests/*.html` 只用于独立验收。前端交互、视觉和测试记录保存在本地 `design-qa.md`，不随源码提交，不在这里重复维护全量测试计数。

参考站的菜单、表单和字段仅作为产品需求证据。候选表中的 P0/P1 是参考优先级，不代表技术验证通过；「前端先做、后端再接」不作为新增能力的开发顺序。参考站一键上货的单任务 50 条限制属于该产品设计，不替代 Ozon 官方接口限制。

## 黄金矿工与企鹅 ERP 的页面落实情况

黄金矿工来源是用户提供的 Bilibili 主页及其视频转录，主流程为采集箱、加工箱、待上架、发布/在线商品；另含套图、价格成本、多店、跟卖、PSD 和数据分析候选。企鹅 ERP 来源是下方勘察报告的 20 个业务页面。**两份蒸馏结果此前均未落成完整业务页面，不能把本轮主框架和既有页面的改版称为两套蒸馏功能已经交付。**

| 来源 | 当前可直接打开的实际页面 | 仍缺失或待验证 |
| --- | --- | --- |
| 黄金矿工精铺 | `?screen=listing` 方案库及字段工作台：总览、准备素材、加工审阅、待发送、平台回执；分组复用现有生命周期。售价旁人工利润试算，商品图片旁三图生成、预览及人工选用。`?screen=products` 为商品读回状态 | 已实现状态分组、当前视图操作范围、人工试算和限定模型套图；外部采集、完整自动利润定价、跟卖数据、语义分层 PSD、WB 分发仍未通过准入。 |
| 企鹅 ERP 商品经营 | `?screen=products` 的读取、筛选、已有改价/库存等动作，新增勾选商品 CSV（货号、SKU、名称、店铺、状态、价格、币种、库存）；修复分页与读取失败 | CSV 本地生成和实际下载回读、一个测试商品的正常改价及官方回读已验证；竞品核价、跨平台草稿与映射、库存及其他外部写入仍待验证。 |
| 企鹅 ERP 订单履约 | `?screen=ops-shipping`、`?screen=ops-returns` 等既有页面 | 采购绑定、国内库存来源、备货/扫码打印、物流异常尚未形成完整流程。 |
| 企鹅 ERP 仓储与财务 | 当前没有相应的新业务路由 | 国内 WMS、库位/货架/库龄、订单费用利润/ROI、物流账单需先验证。`ops-supply` 是 Ozon 入仓供货，店铺余额也不是订单利润，不能拿它们代替。 |

补齐顺序：先验证并组织现有真实生命周期视图和商品/订单入口；外部候选逐项取得输入、输出、持久化、失败与平台结果证据后才加入。逐页截图审查只是视觉验收，不能代替这些能力的实施。

## 当前结论

| 候选能力 | 已证明的部分 | 尚缺证据 / 产品准入结论 |
| --- | --- | --- |
| 三测试桶浏览器直传与确认 | 正常会话和 API 数据库角色下，批量上架整页的真实 WASM 切片/上传、货源 75MB PSD 五分片和委托 75MB 私有原图均完成真实 R2 写入、确认和刷新回读；后续真实识别与组合准备也完成私有识别图和公开切片写入；CORS、取消及中断后恢复通过 | 限本轮输入与浏览器执行器。大批量、跨进程恢复、履约与 Seller 发布须独立验证。 |
| 已移除：用户 PSD 私有云备份与恢复 | 批量上架真实页面完成智能对象 PSD 的普通 PUT、75MB 五分片、服务端完整摘要确认、普通角色持久化回读；仅删除本轮本地副本后，重新打开方案可自动从云端恢复，长度和 SHA256 一致；其他组织及未绑定方案均 404 | 放行本轮已有 PSD 的备份与同浏览器本地缺失恢复构件；不代表跨设备实测或自动生成分层 PSD 通过。 |
| 本地源图导入 | PNG/JPEG 暂存、逐图建行、顺序、部分失败和恢复；真实 PNG 与白杯 JPEG 经产品页面和普通角色 API 建行、持久化和刷新回读通过 | 仅本地导入；顺序及部分失败仍沿用 Hook 隔离测试证据，不代表 1688 采集通过。 |
| 外部商品采集 / 1688 采集箱 | 有供货库入口、SKU 参数导入及本地文件导入 | 未验证外部商品 URL → 授权读取 → SKU/图片完整落库的链路；暂不加入。SKU 参数导入也不等于完整商品采集。 |
| 商品四阶段视图 | 已将既有 16 种生命周期聚合成四阶段，测试覆盖范围、批量目标、旧选择清除、保存后换组和迟到回执；PostgreSQL 行保存回读与 SSE 通过 | 准入为已有事实的纯视图；不新增四套业务状态，不代表外部采集、AI 加工或平台发布闭环通过。`accepted`/`sent` 仍不是在售。 |
| AI 俄语文案、标签、属性 | 白杯 JPEG 使用 `qwen3.7-flash` 完成两次真实调用，俄文标题、简介和固定标签＋五个生成标签实际写入并刷新回读；单独识别和 AI＋切片＋上传组合均通过，回执重放无新增调用或收费，其他组织读取 404 | 限本轮图片、提示词和三个输出字段；未验证俄语质量泛化或全属性正确率。不批准自动类目推荐、自动全属性正确、SEO 提升或「100 分」承诺；完整必填字段仍控制发送。 |
| 从本行已交付图片选择主图、商品图及排序 | 真实已编译 WASM 冻结保留人工主图与图组顺序；真实 Go HTTP + 临时 PostgreSQL 保存、独立回读、CAS、租户隔离和坏输入不覆盖通过 | 准入为人工编辑已有图片；只使用本行 `public_ready` 切片，不新增图源、不生成图片、不保证外部平台已接收。详见下方选图准入证据。 |
| 图片翻译、主图重绘、AI 套图 | 新一组真实三次模型输出，经最新Go正常cookie/标准数据库角色完成R2写入、私有/公开完整SHA256回读、任务GET和独立数据库计费回读；幂等无新增调用，跨组织404；真实输出URL入行及独立PG回读通过 | 限定模型的三图套图、预览及人工选用已接入行内UI，配置/价格缺失不显示生成入口。只验证一个帆布袋样例，不承诺商品细节完全一致或自动发布。翻译仍未通过；识图结果不是图像生成结果。 |
| 上架方案 JSON 富内容默认值 | 2026-11-03 正常登录会话经真实 API 保存、独立 GET 回读、新建商品行继承和清空回读通过；旧版本 409、断网保存失败保留输入与重试通过 | 本地构件已验证，允许方案表格的粘贴编辑入口；仅校验 JSON 对象格式。未验证该富内容被 Ozon 接受、渲染或在售，外部链路待验证。 |
| 成本、佣金、物流、利润与定价模板 | 人工试算、保存及普通方案明确应用通过；最新官方读取当前商品各履约模式佣金/手续费，SSH核实卖家目录报价及缺失运费；CBR当日参考报价真实GET、精确方向与文件回读通过；正常改价与独立官方回读一次通过 | 保留人工「利润试算」。目录价不是已结算采购成本，采样费用估算不是完整账单；缺目标运费及候选售价完整费用模型，不放行自动利润定价。参考汇率不冒充跨币种结算汇率，改价构件通过不等于自动求价或循环改价通过。 |
| Ozon 批量发布与进度 | 单个全新测试商品经正常会话/新v2店铺凭据、真实WASM冻结、租户原子队列、标准worker完成唯一真实import；原scanner核实新task imported无错误并按同货号回读商品/原图URL/主图/62CNY | 放行已验证的单商品发送及结果核对构件；大批量/规模/跨进程真实恢复未实测，新Go未部署。发布时回读尚创建中；随后本轮价格复核已创建且审核通过、仍无库存。imported、accepted或队列完成均不代表在售或审核完成。 |
| 在线库存、价格与促销操作 | 单商品明确改价，以及下方 2026-10-31 零库存测试商品的 ELASTIC_BOOSTING 报名、成员改价、退出恢复，均有真实授权、普通角色持久账本、逐项回执和独立官方回读 | 放行已验证弹性促销的管理入口；库存写入、PROMOCODE/STOCK_DISCOUNT 写入、自动利润求价、批量外部规模及跨进程恢复未通过，不扩大为全部线上动作已接通。 |
| OGL 按店铺管理发货仓、退货地址与配送设置 | 用户明确后续开发主线为 OGL；官方后台流程覆盖仓库地址、退货收件信息、Self-Drop/Pick-up 与集运仓选择 | 尚无 OGL 目标店铺的实际授权、API 写入、异步结果及独立回读证据；不能用官方后台菜单或旧 rFBS 样本代替，不加入产品入口。详见 [OGL 开发方向](parity/warehouse-parity.md#ogl-开发方向2026-10-28-确认)。 |
| 旧跨境 rFBS 仓库读写探测 | 2026-10-28 用户指定跨境店铺真实读取一仓、五种配送方式及空退货设置；修正当前凭据解密和 v2 游标读取，普通数据库角色下仓库 HTTP 同步、独立缓存回读及跨租户 404 通过 | 该仓是非 Express 的跨境 rFBS。使用已有值的 Express 更新及 FBS 更新均被官方 400 明确拒绝仓库类型，未受理操作、独立回读无变化。结论不扩大为 OGL 不能编辑地址；退货/配送写入未验证。详见 [仓库实测记录](parity/warehouse-parity.md#2026-10-28-跨境店铺核验)。 |
| 一份成品分发多店 | 现有每行绑定一店、按配额分配多行到多店通过 | 不是一份成品复制到多个店铺；跨目标重复 row ID 会被拒绝。复制隔离、各店约束与真实回执未验证，暂不加入。 |
| WB 发布 / Ozon 转 WB | WB 原生预览、JSON 字节及拒绝边界通过 | `wbSendCapability.enabled = false`；正式发送注册表只有 Ozon。WB 创建、图片上传、异步状态与真实回读未验证，暂不加入真实发送入口。 |
| 完整跨平台映射模板与草稿持久化 | 本地字段预览与校验可复用；参考站有分类、属性、枚举稳定 ID 和公共/私有模板设计 | 目标平台店铺模板读取未验证；还需验证映射保存/回读、ID 版本更新、类型/必填校验和跨租户隔离。预览测试不是持久化测试，暂不加入完整功能。 |
| 跟卖监控 | 没有已验证的所需数据源 | 未证明能取得指定 SKU 的完整跟卖卖家、数量、卖家链接及报价。官方竞争者列表不能替代这些字段；暂不加入。 |
| 竞品核价、月销量、浏览与转化 | 企鹅店长「跟卖商品」页面展示价格、成本、价格排名与竞品指标，实际更接近竞品核价审核 | 不等于保护自家商品的跟卖监控；稳定数据来源、使用授权、覆盖和刷新精度均未验证。不能以自店数据或模拟数值替代，暂不加入。 |
| 自动生成可编辑分层 PSD | 已有 PSD → 替图 → JPEG 切片的真实 WASM 测试通过 | 不等于从单张图生成背景/产品/标题/卖点四个有效图层。语义分层、PSD 导出与独立编辑器回读未验证，暂不加入。 |
| 商品总览 / 销售漏斗 | 现有部分统计投影、币种和受限/限流状态通过 | 需验证指标定义、订阅权限、时间窗口、分页和覆盖率；不能混用曝光、访问和点击，不能承诺无需会员获得全部分析。 |
| 同类目畅销 TOP | 已有按店铺排序的销量榜，可复用排行组件；尚未证明商品维度 TOP 排行 | 不是全市场同类目商品榜；无已验证的全市场竞品销量来源，暂不加入。 |
| 商品 ABC | 自有商品销量/销售额可作为候选输入 | 分层算法、完整数据与同时间/币种口径未验证，暂不加入。 |
| 分析 Excel 导出 | 其他模块有 CSV 或 TXT 导出 | 不证明上述分析支持 XLSX。需验证生成、类型/币种/时间口径和回读，暂不加入。 |
| 采购记录、采购订单关联与库存发货来源 | 采购筛选状态和绑定读取的租户边界有本地证据 | 未证明创建、绑定、取消、幂等重试、成本归属与订单履约闭环；采购平台自动抓单还需独立接口验证，暂不加入完整采购功能。 |
| 国内 WMS 台账、库位、库龄与库存发货 | 有 Ozon 各仓库存、供货等本地测试，但属于不同业务对象 | 需独立验证入库/预占/出库事务、防超卖、重复提交、撤销/对账和库龄批次；不能因已有「仓库」模块就直接放行。 |
| 订单真实利润、费用与 ROI | 已核实财务底座包含期末余额和币种显示 | 期末余额不是订单利润。费用接口、订单关联、退款/冲销、跨订单费用分摊、币种/汇率及平台账单对账未验证；手填成本也需精度验证，暂不加入自动真实利润。 |
| 快递异常、退件及拒收流转 | 参考站可见问题字段、附件和状态入口 | 创建、附件、权限和状态流转尚未闭环验证；物流轨迹、退件及仓库动作各自需要数据来源与最小验证，暂不加入。 |
| 扫码、批量/自动打印与 WB 建袋 | 有物流映射和请求结果测试，参考站有打印/建袋入口 | 未验证标签来源、格式、浏览器/PDF 路径、重复打印规则、目标打印机与纸张校准；WB 建袋另需官方接口验证，暂不加入。 |
| Yandex、Kaspi、TikTok 等其他平台 | 仅观察到参考站菜单或筛选项 | 各平台授权、接口覆盖和最小业务闭环未验证，暂不加入。 |

## 2026-11-03：上架方案 JSON 富内容（本地构件已验证）

先用真实登录会话和临时方案完成 `attribute_11254` 的 PATCH、独立 GET 回读与旧版本 409 拒绝，再开放方案表格的「JSON富内容」列。编辑时按当前类目 Schema 解析属性键，空白表示清空；非法 JSON、数组、标量和 null 不能保存。正常保存与清空分别经真实新建商品行及独立 GET 验证继承结果。浏览器检查了取消、⌘/Ctrl+Enter、刷新回读、断网失败保留输入和恢复网络重试，以及 375px 弹窗边界。临时方案与商品行已清理。

相关前端 80 项、Go/架构 160 项测试与全部 Go 包编译通过；生产打包通过，设计扫描与改动文件 lint 无发现。全量 TypeScript 仍受已有 OCR 路由测试错误阻断；临时配置仅排除 `ocr-model-routing.test.ts` 和 `use-preparation-actions.test.tsx` 后检查通过，未修改这两个测试。见[本地接口及浏览器证据](/Users/xxww/.codex/visualizations/2026/11/02/01a19d25-3213-7b40-919d-4b81395c60d4/json-rich-content/evidence.json)、[桌面弹窗](/Users/xxww/.codex/visualizations/2026/11/02/01a19d25-3213-7b40-919d-4b81395c60d4/json-rich-content/desktop.png)与[窄屏弹窗](/Users/xxww/.codex/visualizations/2026/11/02/01a19d25-3213-7b40-919d-4b81395c60d4/json-rich-content/mobile.png)。本轮没有向 Ozon 提交商品，也未验证富内容的外部格式或渲染结果。

## Ozon 发送链路的实现与边界

当前实现：

`createOzonSendCapability.send` → `POST /api/listing/submit` → 持久队列 → `submit.Work` → 按 job 的 org/user/store/intent 绑定传输 → 官方限定传输。`queueOptions(RoleListing)` 初始化 `worker.ListingTransport` 并把它传给 `submit.Work`；具体店铺绑定在处理该 job 时执行。

- 发送前从现有数据库按组织、店铺、凭据修订号打开 canonical AAD 密文，复查成员、分配、订阅和凭据可用性；凭据不来自任务 payload 或全局环境。
- 显式绑定的 listing 传输只允许官方 HTTPS 的商品导入和两种结果读取；固定域名、TLS、禁跳转、响应大小、超时及共享出口配额仍有效。`seller.New().Port()` 本身继续仅接受 loopback，未全局放开任意出口。
- 只读收敛依赖既有 unknown/accepted 账本与同一店铺的可用凭据，原提交人离开不阻止结果核对；只读端不能发送写入。
- 确定未发与不确定网络错误分别结算：前者保留审计、请求数零并释放货号锁；后者保留 unknown 和占用，不能自动重发。物理账户占用按 Client ID 共享，API Key 轮换不改变账户身份。
- 受理后检查 `/v1/product/import/info`，再按货号回读商品；异步失败保留错误，不把 task ID、imported 或存在商品等同于在售。
- 现有 browser-direct grant/report API 是另一条调用链，当前正式前端 capability 不调用它们。

这些代码尚未部署到生产。SSH 核实的 `seller-relay-run.sh` 是 SOCKS 服务，不是可直接承接这些 HTTP 请求的桥。本轮已在隔离最新运行时完成一次真实发送及新任务回读，见下方受控导入证据；不把本地mock或旧任务读取计入它。

## 目标店铺只读验证（2026-10-22）

用户确认配置字段后，凭据通过关闭终端回显的 stdin 进入临时诊断进程，仅在内存中持有，未放入仓库、命令参数、截图或验收报告。诊断固定官方 HTTPS 目标、禁止重定向、限制超时，只允许以下四项读取。POST 是这些官方读取方法的 HTTP 动词，该只读诊断没有执行发布、价格或库存写操作；后续唯一真实导入另见下节证据。

| 官方接口 | 实际结果 | 证明范围 |
| --- | --- | --- |
| `/v1/roles` | HTTP 200，42 个角色条目 | 返回权限声明包含商品导入、价格修改和库存修改；权限声明不等于写入通过。 |
| `/v3/product/list` | HTTP 200，样本 1 条，总数 290 | 商品列表读取连通。 |
| `/v5/product/info/prices` | HTTP 200，样本 1 条 | 当前价格读取连通，响应根为 `items`。 |
| `/v4/product/info/stocks` | HTTP 200，样本 1 条 | 当前库存读取连通。 |

脱敏结果：[ozon-readonly-result.json](/Users/xxww/.codex/visualizations/2026/10/22/podhub-ui-review/ozon-readonly-result.json)。该次契约核对使用 [Ozon Seller API](https://docs.ozon.ru/api/seller/) 当时的 swagger；它仅作为接口形状证据。

这是一项直接官方只读诊断，**`ui_end_to_end_verified=false`、`writes_executed=0`**。它不经过正式 UI、店铺持久授权或 worker，因此不能代替应用内真实流程验证。

由当前契约发现并修复了已有后端问题：价格同步错误读取 `result.items`，短页有后续游标却提前结束，以及 HTTP 200 错误/畸形响应被当成成功空列表。现按根 `items` 读取，严格区分无效数组和合法空数组；重复游标与超过页数上限明确失败。删除结果核对缺失有效列表时保持 `indeterminate`，不能以畸形响应证明商品不存在。`go test ./internal/ops/... -count=1` 44 项通过、6 个包；这是本地解析和失败行为验证，未升级为真实写入闭环通过。

## 本轮后端本地验证

受影响的 Seller、Listing、Store、Ops、scanner、worker 与架构检查全部通过，使用临时 Docker PostgreSQL，不使用真实店铺写入。根复跑日志 `/tmp/podhub-go-final-verified.log`；独立 HTTP 快照回归最终日志 `/tmp/podhub-card-snapshot-http-db-final.log`。覆盖店铺绑定及 canonical AAD、权限与只读边界、物理账户占用、确定未发与网络未知、正常与恢复受理首次排程、异步失败持久化、过期 claim，以及旧输入隔离。

非空快照共用 SQL 扫描列，行与快照按 OpenAPI snake_case 传输。当前输入的异步 failed issue 可见且只能核对卖家后台；保留 accepted、任务与回执，不能恢复或重发。新输入不继承旧错误、任务或回执。现有 SSE 触发器通知，无额外轮询。

问题历史达到既有 8 条上限时，失败回读保留最新 7 条与本次失败，其他回读保留原历史；真实 PG 边界及 scanner 全包通过，日志 `/tmp/podhub-accepted-issue-boundary-final.log`。

这些是本地实现与真实数据库验证，不是新商品真实上架验收。

## 新增纯视图与 CSV 的准入证据

四阶段仅由已有后端生命周期投影，不写入新状态。5 项分组/范围测试、真实工作台隔离回归与 10 项浏览器交互通过；真实 PostgreSQL `TestListingCardEventSSE`、`TestListingCardRowRoundTrip` 两项通过。后者证明行保存回读及事件链，不证明平台发送。

CSV 只导出已有列表的当前勾选记录，无上游请求；8 列、UTF-8 BOM、币种和缺失值保真、公式与长 SKU 保护均有测试。浏览器真实下载两条选中商品后用独立 CSV 解析器回读，名称、行数、价格、库存与 SKU 符合输入。证据：[selected-products-browser.csv](/Users/xxww/.codex/visualizations/2026/10/22/podhub-ui-review/selected-products-browser.csv)。这不是 XLSX 或分析报表导出。

## SSH 数据与新 Go 官方读取器的只读核验

按用户授权通过 `ssh tx-podhub` 查询现有数据库，全程设置只读事务。相同 Client ID 有两个工作区绑定，不把配置首项序号当作工作区 ID。数据库镜像每个绑定 415 条且时间已过期，不能替代官方当前 290 条的读取口径。

找到一条既有受理记录及任务号，另有明确标记的 selftest 商品；其他草稿均未满足发布条件，未为验收绕过就绪校验。使用新 Go 官方只读传输读取既有 `/v1/product/import/info` 与 `/v3/product/info/list` 均 HTTP 200，任务状态 imported。凭据只经关闭回显的 stdin 进入临时进程内存。脱敏结果：[ozon-go-readonly-result.json](/Users/xxww/.codex/visualizations/2026/10/22/podhub-ui-review/ozon-go-readonly-result.json)。

该次生产 Cloud API 的浏览器会话返回 401；没有伪造会话、修改数据库或部署新代码。上述验证仍为 `writes_executed=0`、`ui_end_to_end_verified=false`，不证明新发布、改价或库存写入成功。

## 官方接口约束

- [Ozon 商品上传](https://docs.ozon.ru/api/seller/#operation/ProductAPI_ImportProductsV3)：每批最多 100 件，并受账号额度与限流约束。请求受理后还需检查导入结果。
- [WB 商品接口](https://dev.wildberries.ru/en/docs/openapi/item-management)：上传需要相应 Content 授权，文档提供沙箱并限制批量大小、请求体和速率；商品创建为异步流程。还需验证失败查询和最终结果，不能把 HTTP 200 当成商品已创建。文档可证明存在实现路径，不能证明当前账号和程序已接通。
- [Ozon 分析接口](https://docs.ozon.ru/api/seller/#operation/AnalyticsAPI_AnalyticsGetData)：无 Premium Plus 时限定时间范围、指标、分组与调用次数；基础销量/销售额不能推导为曝光、访问、加购和转化全部免费。
- [Ozon 竞争者列表](https://docs.ozon.ru/api/seller/#operation/pricing_competitors)：外部站点竞争者信息不等于逐 SKU 的完整跟卖卖家记录。[详细价格接口](https://docs.ozon.ru/api/seller/#operation/ProductPricesDetails)也存在会员条件，不能拼成未经验证的跟卖承诺。
- [WB 分析接口](https://dev.wildberries.ru/openapi/analytics)：部分高级报告要求 Jam；个别库存报告例外不能推广成全套分析免费。

接口权限、额度和限制可能变化。实现时须按目标账号及当时官方文档再次核验，不固化视频中的次数、价格和效果宣传。

## 本次可复现验证

以下均为隔离测试，未调用付费模型或真实卖家账号。分组存在重复文件，不汇总成去重总数。

| 分组 | 结果 | 边界 |
| --- | --- | --- |
| 核心导入、识图契约、多店配额、发布守卫、固定价格同步 | 119 通过，13 文件 | Cloud/模型响应为替身；不是端到端平台成功。 |
| 候选审阅、生命周期、就绪状态 | 19 通过，3 文件 | 证明本地状态与版本约束。 |
| 在线商品库存/价格构造与分块 | 65 通过，3 文件 | 不是实际店铺写入。 |
| PSD admission、客户端、真实 WASM、worker | 28 通过，4 文件 | 合成 PSD 渲染为两张 JPEG，校验尺寸和固定哈希；不是从图片生成 PSD。 |
| 源图批次、导入恢复、OPFS 恢复 | 19 通过，4 文件 | 其中同款导入 6 项与第一组重复。 |
| Ozon/WB 适配、真实 WASM、分析和币种 | 81 通过，9 文件 | WB 测试证明预览和禁用发送边界，不能当成 WB 发布通过。 |
| 发送队列、未知结果锁和对账 | 33 通过，3 文件 | 验证隔离与拒绝规则。 |
| Go 提交、店铺、经营和出口规则 | 122 通过，6 包 | 含 loopback 出口限制。 |
| Go 类目、AI service、媒体 domain/upload/render | 27 通过，10 包 | 仅验证规则和请求边界，不证明 AI 图片输出。 |

在 `web/` 执行：

```sh
bun test --preload ./tests/network-guard.preload.ts ./src/features/workflow/product-instances-import.test.tsx ./src/features/workflow/source-import-same-design.test.ts ./src/features/workflow/store-quota.test.ts ./src/features/workflow/store-quota-association.test.ts ./src/features/workflow/use-store-quotas.test.tsx ./src/features/workflow/prepare/ai-job.test.ts ./src/features/workflow/prepare/ai-job-contract.test.ts ./src/features/workflow/prepare/ai-job-input.test.ts ./src/features/workflow/prepare/ai-job-recovery.test.ts ./src/features/workflow/workflow-task-progress.test.tsx ./src/features/workflow/submit/use-publish-queue.test.tsx ./src/features/workflow/submit/publish-queue-results.test.ts ./src/features/workflow/card-price-sync.test.ts
bun test --preload ./tests/network-guard.preload.ts ./src/features/workflow/candidate-review-dialog.test.ts ./src/features/workflow/model/listing-row-lifecycle.test.ts ./src/features/workflow/model/workflow-readiness.test.ts
bun test --preload ./tests/network-guard.preload.ts ./src/features/products/products-mutation.test.ts ./tests/products.test.tsx
bun test --preload ./tests/network-guard.preload.ts ./src/render/psd-admission.test.ts ./src/render/client.test.ts
bun test --preload ./tests/network-guard.preload.ts ./src/features/workflow/source-batch.test.ts ./src/features/workflow/source-import-same-design.test.ts ./src/features/workflow/source-import-recovery.test.tsx ./src/bindings/render-opfs.test.ts
bun test --preload ./tests/network-guard.preload.ts ./src/features/workflow/platforms/ozon/adapter.test.ts ./src/features/workflow/platforms/wb/adapter.test.ts ./src/features/workflow/platforms/wb/native-preview.test.ts ./src/features/workflow/platforms/wasm-freeze.test.ts ./src/features/workflow/submit/send-ozon-revision.test.ts ./src/features/workflow/submit/send-ozon-request-evidence.test.ts ./src/features/console/console-board.test.ts ./src/features/console/console-metrics.test.ts ./src/features/products/analytics-money.test.ts
bun test --preload ./tests/network-guard.preload.ts ./src/features/workflow/submit/send-queue.test.ts ./src/features/workflow/submit/queue/unknown-locks.test.ts ./src/features/workflow/platforms/ozon/reconcile.test.ts
```

在仓库根执行：

```sh
go test ./internal/listing/submit/domain ./internal/store/domain ./internal/ops/domain ./internal/queue/...
go test ./internal/seller/ozon ./internal/seller/ozon/domain
go test ./internal/catalog/domain ./internal/ai/service ./internal/media/domain/... ./internal/media/service/upload
```

## 企鹅店长侧聊补充证据

用户授权转入主任务的[完整勘察与技术清单](/Users/xxww/.codex/visualizations/2026/10/21/01a15fa4-7905-7802-92c3-e02c3be6720c/hqozon-feature-integration.md)，以 2026-10-22 对 [参考站](https://oz.hqozon.com/Index/index.html) 20 个业务页面及一键上货新增表单的只读核对为依据。报告保留直接页面地址、字段和技术边界，不含账号密码或客户记录；没有执行真实商品、订单、财务写入或打印。

侧聊独立执行 Go 110 项 / 9 包及 Bun 61 项 / 6 文件，均通过。它们与前述分组存在重合，因此不叠加成去重总数，也不把 171 项本地测试称为生产验收。

```sh
# 仓库根
go test ./internal/ops/domain ./internal/shipping/domain ./internal/shipping/contract ./internal/shipping/service ./internal/supply/domain ./internal/supply/service ./internal/warehouse/domain ./internal/warehouse/service ./internal/store/domain -count=1

# web/
bun test --preload ./tests/network-guard.preload.ts ./src/features/products/products-mutation.test.ts ./src/features/products/analytics-money.test.ts ./src/features/workflow/platforms/wb/adapter.test.ts ./src/features/workflow/platforms/wb/native-preview.test.ts ./src/features/workflow/platforms/wb/cache.test.ts ./src/features/stores/finance-balance.test.ts
```

本地构件证据见 `internal/ops/domain/mutate.go`、`web/src/features/products/products-mutation.ts`、`web/src/features/stores/finance-balance.ts` 和 `internal/supply/domain/procurement.go`。这里的采购文件只校验筛选状态，不证明采购写入；shipping 测试不证明打印；Ozon 仓库/供货测试不证明国内 WMS。主任务本次只合并独立报告，未重新执行这两条命令。

## 已交付图片的人工编辑准入（2026-10-22）

此切片选图输入限定为当前商品行的 `public_ready` 图片及其公开 URL；不允许手贴外链、选择未交付切片或借此运行 AI。保存只写已有草稿 `images`（`url_list`）或 `primary_image`（`text`），不改渲染结果、媒体成功状态、发布状态或回执。该切片选图操作每次只写一个字段：主图从当前商品图中选择，当前显式主图不能被移出商品图，图组顺序独立保存；新增AI选用采用后文双字段原子保存。

| 验证项 | 实际实现与结果 | 准入边界 |
| --- | --- | --- |
| 冻结输出 | `media-selection.test.ts` 调用真实已编译 `freezeListing`，人工主图与图组顺序进入冻结请求；原输入不变 | 是请求构造验证，不发送平台。 |
| 保存及回读 | `TestListingCardRowRoundTrip/manual_media_selection_persists_with_CAS_and_tenant_isolation` 通过真实 HTTP 创建行，再 PATCH 草稿；新 handler GET 与 PostgreSQL 独立查询一致 | 使用自动创建并清理的临时数据库，不使用生产库。 |
| 冲突及权限 | 旧修订号写入返回 409；其他工作空间返回 404，原值与修订号不变 | 不能绕过既有工作区授权或乐观锁。 |
| 坏输入 | `url_list.value` 传字符串返回 400，旧值保留；HTTP 包测试覆盖空值、错误类型和非字符串列表成员 | 修正了该输入原先触发内核解码错误而返回 500 的边界；内核本身故障仍返回 500。 |
| 状态 | 人工选择不把失败媒体改成 ready，也不把商品改成已发送/在售 | UI 与动作沿用发送和未知结果锁；保存失败保留未保存编辑。 |

此次放行的 UI 是精铺表格「主图」「商品图」单元格中的选图面板：缩略图选择、主图指定、商品图顺序调整、全选已交付切片。无需新页面、大标题或介绍卡片。360 图、色卡、富内容、外部采集、AI 重绘和套图没有随此次人工选图放行；本轮套图独立准入见后文。

上述 UI 已接入，按钮与原图片张数同排。浏览器通过排序、指定主图、禁止移除当前主图、取消选图、全选、键盘排序、Escape 回焦、503 后保留编辑并重试保存，以及未知结果锁。修复桌面打开面板再缩屏时面板留在宽表屏外的问题：窗口尺寸改变会关闭面板，不改选择或保存；375px 重新打开时面板宽 351px，无整页横向溢出。颜色样本只读回退也与真实 WASM 输出核对一致，不新增颜色编辑。

证据目录：[选图技术验收](/Users/xxww/.codex/visualizations/2026/10/22/podhub-media-admission/technical-admission.json)、[浏览器检查](/Users/xxww/.codex/visualizations/2026/10/22/podhub-media-admission/browser-checks.json)、[桌面截图](/Users/xxww/.codex/visualizations/2026/10/22/podhub-media-admission/desktop-picker.png)、[手机截图](/Users/xxww/.codex/visualizations/2026/10/22/podhub-media-admission/mobile-picker.png)。浏览器使用真实组件、真实自动保存链与严格限定的内存 HTTP 边界；PostgreSQL 证据来自单独的真实后端集成测试，不把内存保存称为生产保存验收。日志为 `/tmp/podhub-media-admission-{go,pg}.log` 和 `/tmp/podhub-media-ui-tests.log`。未部署、未执行真实店铺写入。

该阶段前端全量 3197 通过、2 个既有跳过、0 失败，436 文件；build、lint 通过。相关定向 37 项通过，含实际自动保存失败后重试和旧回调遇到未知结果的拒绝。全量日志 `/tmp/podhub-media-final-{tests,build,lint}.log`；既有 ECharts 大包提示未处理，未增加依赖或提高警告预算。

复跑命令：

```sh
go test ./internal/listing/read/http -count=1
env PODHUB_PARITY_DSN= go test ./tests/integration -run '^TestListingCard(RowRoundTrip|EventSSE|SnapshotCurrentInputFailureContract)$' -count=1 -v
cd web
bun run test src/features/workflow/workbench/media-selection.test.ts
```

本轮重新核对后未新增的入口：商品现价、库存、覆盖和更新时间已有真实镜像视图，不能重复标成「实时已接通」；供货库的成本、运费和供货平台价虽然均为人民币分，却不是 Ozon 店铺售价，且缺佣金、跨境物流、汇率与利润验证，不能当作精铺自动定价；跨平台映射目前只有预览/内存缓存，缺少模板持久化与目标 schema 验证。

## 人工利润试算准入（2026-10-22）

口径为逐件试算：`净利润 = 售价 − 人工固定成本 − 人工比例费用`，目标净利率为净利润除以售价，不是成本加价率。所有成本、费率和跨币种汇率都由操作者明确输入；不把缺项当作免费，不把供货平台价当作 Ozon 售价。

- 仅 CNY/RUB，两位金额小数；十进制字符串转 BigInt 有理数，成本换汇、各项费率分别向上舍入到分。逐余数类求达到净利率的最低正售价，避免舍入后的利润谓词不单调导致二分求价错误。
- 参数存为方案 typed `pricingAssumptions`；沿用方案 PATCH、修订号和租户隔离，没有增加通用偏好表。普通方案其他字段和供应方案在线字段权限保持原约束。
- 「保存参数」不改方案价格。「应用到方案」为明确操作，仅当方案售价币种已明确且与试算匹配、建议价符合划线价时写入精确 text 金额。CAS 冲突重新读取后再检币种/划线价；缺币种不能自动假定人民币或卢布。
- 商品行同步复用既有继承/fence；不改封存、队列中、提交中或结果未知的商品，不调用真实店铺改价接口。供应方案目前没有实时投影线上币种，且该旧写价路径整体替换 defaults，因此本次一律仅试算和保存；前端与新后端写入组合均阻止供应卡应用，不因旧卡偶然有币种而进入未验证路径。

| 证据 | 实际结果 |
| --- | --- |
| 精确计算 | 覆盖跨币种及逐项舍入、非单调反例、独立穷举最低价、无效/空值/上限及总费率+目标≥100%的拒绝。 |
| 真实数据库 | `TestListingPricingAssumptionsRoundTrip` 用临时 PostgreSQL，真实 PATCH→全新 handler GET→SQL JSONB 相等；普通和供应方案均可保存参数，价格保持不变。旧 revision409、其他租户404、非法费率/缺汇率400，原值/版本不变；供应方案即使显式CNY也不能应用。普通方案应用114.29后独立SQL与新GET一致，划线价200保留。 |
| 正常保存与应用边界 | CardSession 测试证实只写方案、不打店铺价格接口；明确应用保存 `114.29` 精确值，冲突后币种变化不发第二次写入；已有 aiPrompt 等元数据保留。 |
| 浏览器 | 成本80、人工费率10%、净利率20%→114.29；参数保存不改5.00，明确应用才改114.29；清除方案会话后新GET恢复参数。503保留90.00输入并可重试；并发币种改RUB后409回读阻止应用且原价保留。 |
| 窄屏 | 375px 屏幕，面板351px，字段横排换行；桌面开面板后缩屏关闭且保留输入。跨币种须明确方向汇率，无整页横溢。 |

前端定向、Go domain/http 与最终PG日志为 `/tmp/podhub-profit-ui-tests.log`、`/tmp/podhub-profit-metadata-go.log`、`/tmp/podhub-profit-metadata-pg-final.log`。桌面与手机截图在 [本轮证据目录](/Users/xxww/.codex/visualizations/2026/10/22/podhub-next-admission)。浏览器只模拟外层HTTP；真实PG验证独立执行，二者均不等于正式Cloud会话或店铺写入通过。真实CardLibraryHost额外验证建议价应用和手动改价等待商品行读取期间的同行操作锁，见 `profit-browser-checks.json`。

## 自动利润定价：实际费用与汇率来源复核（2026-10-22）

按用户授权从 `ssh tx-podhub` 只读核实测试店铺及鼠标垫货源，再以同一店铺授权直接读取官方当前价格、商品和配送方法；三项均HTTP200。这是来源诊断，不冒充正式Cloud会话或应用自动费用服务。

| 输入 | 本轮实际结果 | 仍缺的边界 |
| --- | --- | --- |
| 卖家采购成本 | 当前卖家可见目录报价为13.00CNY，price version8；该货源/SKU采购记录0 | 是当前采购报价，不是已结算实际采购成本。供应商内部成本未导出，也不自动下发卖家UI。 |
| 商品佣金采样 | 费用读取时售价62.00CNY，RFBS为12%、金额7.44；FBS14.5%、FBO17%、FBP11%分别保留 | 只证明该商品采样价档估算；不能混用履约模式，也不能据此保证候选售价跨档后费率不变。 |
| acquiring | 官方返回金额0.62 | 不是0.62%，不能按当前价比值推定未来固定1%；未取得可用于新售价的完整计费函数。费用对象没有独立回显币种，不扩大解释。 |
| 运费 | 18个公开发布SKU均有卖家报价，均无source shipping或物流绑定；全库shipping preset/version/binding为0，integration revision14没有物流计费字段 | 目标仓5个配送方法中1个ACTIVE，只含provider/template/SLA等元数据，没有运价、币种、重量阶梯。ACTIVE不等于运费已取得，未知不能当0；FBO/FBS物流金额不能补RFBS运输。 |
| 汇率 | 直接官方CBR HTTPS及Ego页面读取同日参考报价：2026-10-22，1CNY=12.2806RUB，与Cloud已有记录一致；原始XML完整SHA、精确Decimal名义单位换算、文件与JSON回读通过 | 公共参考报价，不是Ozon实际结算、换汇点差或提现费用；新Go当前的指标FX fetch尚未绑定，不能说应用自动取价通过。 |
| 商品状态 | 本轮新读已created、moderate approved，SKU6112095850、has_stock=false | 已创建且审核通过，仍无库存；不覆盖上轮发布时创建中的历史回执，不宣称在售或已产生真实利润。 |

`scripts/verify-pricing-sources.py` 默认仅执行限定货源SQL及固定官方读取，参数/身份校验与配送个人字段脱敏有自检。`scripts/verify-profit-fx.py` 固定官方公共XML、禁止重定向、限制响应大小，拒绝缺失/重复CNY、错误名义单位、无效金额及未来/过期报价；自检包含nominal10的精确换算。二者都不改生产数据库、配置或部署，不发Seller写入。凭据只经SSH进程内存和stdin流转，不进入参数、环境、文件或报告。

证据：[来源准入矩阵](/Users/xxww/.codex/visualizations/2026/10/22/podhub-profit-live-admission/sources/admission-matrix.json)、[Cloud只读数据](/Users/xxww/.codex/visualizations/2026/10/22/podhub-profit-live-admission/sources/cloud-source-readback.json)、[官方价格费用](/Users/xxww/.codex/visualizations/2026/10/22/podhub-profit-live-admission/sources/official-v5-product-info-prices.json)、[配送方法脱敏结果](/Users/xxww/.codex/visualizations/2026/10/22/podhub-profit-live-admission/sources/official-v2-delivery-method-list.json)、[CBR真实读取及边界](/Users/xxww/.codex/visualizations/2026/10/22/podhub-profit-live-admission/fx/fx-reference-result.json)。央行[官方页面](https://www.cbr.ru/eng/currency_base/daily/)明确报价对卢布方向，且不承诺按该价格买卖货币；[指定日期XML](https://www.cbr.ru/scripts/XML_daily.asp?date_req=22/10/2026)保留本轮2026-10-22报价。

当前结论：费用及公共参考汇率的来源构件已验证，**完整自动利润定价尚未准入**。还需目标履约渠道/线路的有效运价（币种、计费重、阶梯、附加费及有效期）、适用候选售价的完整费用模型和明确目标净利率；跨币种及声称完整实际净利润时还需相应结算成本口径，同币种不人为加入汇率。未新增自动定价入口、说明卡、占位按钮或假成功，原人工试算保留。受控改价构件与利润求价分别验收。

### 单次正常改价及官方回读通过

只对上轮新建零库存测试商品 `podhub-live-validation-f8c58027486c4ad9bd6dbdfd` / product6706622142，将62.00改为62.01CNY。它是改价传输验收的一分钱调整，不是利润模型求出的价格。请求仅含product/offer、price、currency和原先无划线价的 `old_price="0"`，不改库存、最小价、促销或自动定价字段。

- 最新临时PG366、真实cookie及NOINHERIT/NOSUPER/NOBYPASS标准API池，正常创建店铺并保存新v2凭据；未SQL伪造会话或凭据。现有 `/api/ops/products/mutate` 依次完成授权、持久写账本、专用官方出口和逐项结果解析。
- 先明确读到同一offer/product的62.00CNY、无划线价、has_stock=false，再检查闭写503且0账本。旧价/库存键缺失或null都不算空值/false，预检拒绝。root审阅固定wire SHA256 `0f2a7b0e6af3b8c612870a7baa089c925284a3c40436d7ddfbc588bfe4b0ce33`，排他创建/fsync预算文件后仅允许一次改价。
- 实际httptrace的WroteRequest事件1次且完成1次，HTTP200并有匹配双身份的updated=true/errors=[]逐项回执，独立PG为1条settled。共享 `domain.Dispatch` 在同一二进制的干运行输出与审阅wire一致；这是请求构造校验，不称socket抓包。
- 独立官方 `/v3/product/info/list` 读到同一商品62.01CNY、原划线价仍空、has_stock仍false。未恢复价格或执行第二次改价；全局预算已消费，禁止为复跑验收重发。初次只读roles网络失败发生在预算及改价前，单独保留，不计为平台写尝试。

改价后另一次限定v5只读确认同一商品62.01CNY、old/min仍0、自动促销相关标志和活动列表与改前一致，未覆盖原62.00的费用采样。当前acquiring仍为金额0.62、RFBS12%；两个采样点不证明任意候选售价的费用公式。证据：[改后价格/费用及标志核对](/Users/xxww/.codex/visualizations/2026/10/22/podhub-profit-live-admission/sources/after-price/comparison.json)。本轮临时PG退出后销毁，保留独立账本快照，不声称跨进程未知恢复或生产部署已验证。

实际修复：Ops凭据读取进入既有租户AppRole事务，精确绑定组织/当前修订号，以canonical AAD打开v2并核验指纹及Client ID，保留成员、分配、禁用、订阅和过期校验；专用出口仅允许官方HTTPS、唯一POST改价路径，保留共享预算、写开关及通用loopback边界。原代码把任意HTTP200当全成功，现需完整逐项身份、updated与errors；缺失/畸形/矛盾回执保持result_unknown。正常角色负例还复现旧SQL退避参数类型导致未知状态落库失败，已用整秒参数修正，未知不重发的持久锁验证通过。

普通角色单连接回归覆盖：闭写无请求、明确失败、畸形/空回执未知、相同operation重放0新调用、同operation改body409、跨组织404、禁用/过期/修订号失配、AAD/指纹/Client ID篡改均拒绝且0新增写，裸凭据读取42501、连接角色还原。独立审查发现的updated与errors矛盾、缺字段默认值误判已修正并有测试。

证据：[真实改价及回读](/Users/xxww/.codex/visualizations/2026/10/22/podhub-profit-live-admission/price/actual-run/price-submit.json)、[官方价格结果](/Users/xxww/.codex/visualizations/2026/10/22/podhub-profit-live-admission/price/actual-run/price-after.json)、[独立PG账本](/Users/xxww/.codex/visualizations/2026/10/22/podhub-profit-live-admission/price/actual-run/price-ledger-snapshot.json)、[固定计划](/Users/xxww/.codex/visualizations/2026/10/22/podhub-profit-live-admission/price/preflight/planned-price.json)。正常角色集测日志 `/tmp/podhub-price-normal-final.log`；相关Ops、Seller、App及架构最终回归全部通过，日志 `/tmp/podhub-profit-live-go-final-verified.log`，Store相关回归另见 `/tmp/podhub-profit-live-go-final.log`。本轮前端代码未改，未重复跑既有全量前端测试。

## 此前 AI 图像输出单项验证（2026-10-22）

已配置的活跃模型是文本输出 `qwen3.7-flash`；其名字或识图能力不能证明图片生成。使用同一已授权百炼账号，在北京官方兼容端点明确请求 `qwen-image-2.1-pro`，固定每次 `n=1`、1024×1024，3 次 HTTP 200，耗时约10.54/11.37/11.34秒。没有自动重试。返回体没有 model 字段，只能说明请求指定了该模型，不能声称服务器回显了模型身份。

输入为仓库公开示例 `web/public/site/product-tote.jpg`，输出分别是白底图、场景图和细节图。3 个文件均完整校验 PNG CRC、DEFLATE 和像素重建，文件及像素摘要不同；已逐图目视检查。主要外观保留，没有新增商标、口袋或拉链；细节纹理和针脚有重绘，一个无图案样例不能证明所有商品一致性。PNG 有微量透明度（alpha 最低252/254/254），发布素材需明确合成白底并编码为 JPEG。

凭据仅在远端进程内存中，输出签名 URL 不入报告；无生产库写入。按[官方公开价](https://help.aliyun.com/zh/model-studio/model-pricing)估计3图总计¥0.75，未回读实际账单。接口依据为[百炼图像生成与编辑 API](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)。

证据：[调用及边界清单](/Users/xxww/.codex/visualizations/2026/10/22/podhub-next-admission/ai/validation-manifest.json)、[完整离线解码结果](/Users/xxww/.codex/visualizations/2026/10/22/podhub-next-admission/ai/artifact-check-result.json)、[白底图](/Users/xxww/.codex/visualizations/2026/10/22/podhub-next-admission/ai/set-1.png)、[场景图](/Users/xxww/.codex/visualizations/2026/10/22/podhub-next-admission/ai/set-2.png)、[细节图](/Users/xxww/.codex/visualizations/2026/10/22/podhub-next-admission/ai/set-3.png)。外部模型输出通过与产品资产保存/计费/恢复通过是两个门槛，当时没有据此放入套图入口；后续整链使用全新一组输出独立验证。

### AI 套图后端：先前本地验证

新增 `POST /api/ai/image-sets`、`GET /api/ai/image-sets/{id}`，固定已实际验证的模型、每组3图、逐张 `n=1`；API/OpenAPI/生成类型及路由门禁一致。只使用明确匹配的活跃模型账号、有效 assets 存储配置和已发布正值 `per_request` 价格；缺配置或价格在预占余额前拒绝，不自动改生产账号或价表。

- 新迁移366保存租户套图及3个请求/素材引用，复用钱包和 storage registry，不建设通用媒体库。3张预占同事务，余额不够全回滚；逐张计费、请求结算与对象绑定同事务，保留部分成果。相同幂等键不同输入409；同键重放、取消及未知结果不重新调用模型。
- 输入PNG/JPEG先合成白底、去元数据并转JPEG；输入上限4MP/20MiB，预处理最多2个并发，读取请求体有15秒期限。模型出口仅官方北京HTTPS，限制域名/DNS实际拨号、禁止代理/跳转、限制输出大小，不把模型Bearer发给图床。
- 存储复用 Presign→PUT→HEAD checksum→私有GET哈希→无凭据公开GET哈希→Confirm；公开域403、字节不一致或对象跨租户都不能ready。修正registry原先将64位hex文本直接cast bytea成64字节的问题，统一转成32字节摘要。
- 每20秒续期本进程仍有效的billing writer；不抢回过期或已失去的授权。失权保留unknown及hold，等待正常授权恢复后由租户范围GET释放过期预占，不能声称失权时已经退款，也不会自动再付费生成。
- 正常API数据库角色的会话解析暴露既有裸读权限问题，最小修复为原 `ResolveAccount` 查询包进已有 `db.InTx(AppRole)`；没有新增SECURITY DEFINER、表授权或兼容分支。独立25项回归核对过期/禁用/成员筛选及事务角色还原。

最终临时PG完整17项通过，**同一个 `podhub_login_api` NOINHERIT/NOSUPER/NOBYPASSRLS池**执行正常cookie解析、成员验证、POST/GET、钱包、registry及引用。cookie由现有注册路由在fixture池生成；这不表示标准角色注册流程已完成移植。包含真正等待65秒的模型替身调用、失权后hold不释放/授权恢复后释放、绑定失败账务回滚、部分失败、并发幂等、余额不足、预处理取消、公开访问失败与租户隔离。

这17项的provider为明确替身，重放此前实际生成3图；对象存储是本地HTTP服务，真实执行PUT/HEAD/GET并回读字节，再落真实PG。**该组测试没有新真实推理、生产R2或生产公开域调用，不能当作正式配置→真实模型→真实存储的一体外部验收。** 当时未新增套图UI；后续整链准入与界面接入另见下节。

证据：[后端边界与结果](/Users/xxww/.codex/visualizations/2026/10/22/podhub-next-admission/ai/backend-validation.json)、[工具执行回执](/Users/xxww/.codex/visualizations/2026/10/22/podhub-next-admission/ai/backend-test-receipts.json)、[正常API保存回读](/Users/xxww/.codex/visualizations/2026/10/22/podhub-next-admission/ai/normal-api-persistence-result.json)、[身份角色回归](/Users/xxww/.codex/visualizations/2026/10/22/podhub-next-admission/publish/identity-role-regression.json)。同目录 `saved-set-{1,2,3}.jpg` 为从实际样图白底编码、保存并回读的结果。最终相关Go包与架构全过，根日志 `/tmp/podhub-next-go-final.log`；`api:check`及契约生成后的web build通过。

复跑本地链路（默认使用测试生成的合成图片，不调用真实模型或生产桶）：

```sh
env PODHUB_PARITY_DSN= PODHUB_AI_IMAGE_EVIDENCE_DIR= go test ./tests/integration -run '^TestAIImageSetsNormalAPI$' -count=1 -v
env PODHUB_PARITY_DSN= go test -p 1 ./internal/ai/... ./internal/media/... ./internal/identity/... ./internal/app ./internal/listing/read/... ./tests/archtest -count=1
```

若需重放旧样图，先把 `source-product-tote.jpg` 和 `set-{1,2,3}.png` 复制到新的验收目录，再将 `PODHUB_AI_IMAGE_EVIDENCE_DIR` 指向该目录。此变量同时决定输入和输出位置：测试会写入 `saved-set-{1,2,3}.jpg` 与 `normal-api-persistence-result.json`，不能指向原历史证据目录。

### 本轮真实模型、R2 与回读整链通过

使用全新 PostgreSQL16、完整迁移366、真实登录cookie与同一标准 `podhub_login_api` NOINHERIT/NOSUPERUSER/NOBYPASSRLS池，调用未替换的 `app.Handler` / `newImageRuntime`；模型及R2凭据由 SSH 只读打开后仅经进程内存传入。隔离配置明确选择图像模型、正值按张价格和已存在的持久供应资产桶，未修改旧生产配置、数据库、模型、价表、DNS或部署。

实际 `capability`→`POST /api/ai/image-sets`→3次真实 `n=1`→R2条件写→HEAD→完整私有GET→无凭据公开GET→registry确认→任务GET全部通过。新3次模型请求均HTTP200、data_count=1、usage.image_count=1，明确请求 `qwen-image-2.1-pro`；返回未回显model，报告保留此事实。三张新JPEG已经逐图目视复核，分别为白底、场景及细节，仍需人工判断商品一致性。

独立数据库回读为3条settled、3条consume、4个live对象及4个业务引用（含输入图），本地钱包扣款75,000,000microfen、held=0；相同请求重放新增模型调用0，跨组织GET404。隔离价表为每张25,000,000microfen（¥0.25），三张¥0.75，与官方公开价估算一致；这是本地计费闭环，不是供应商实际账单或免费额度回读。

最新唯一 `assets` 契约使用真实 `podhub-supplier` / `https://podhub-supplier.ozon-pod.com`，不增加旧角色或备用域名。旧对象HEAD曾只有CRC64NVME，本次签SHA256的单PUT则回显fullSHA256；两种都不能代替本链强制执行的完整GET校验。一次付费前公开域TLS连接失败已保留日志，当次推理0次，后续存储预检及唯一三次生成通过；不会自动重试未知推理。桶生命周期读取403，外部过期策略仍未核实，不能宣称云端永不过期；独立前缀未发现应用清理命中。

新增普通成员脱敏能力查询，只有唯一合法图像账号、assets与发布价格才available；另有按原幂等键GET找回接口，POST超时未得到id也不必再次购买。价格确认字段 `expected_unit_microfen` 防止按变更后的价格静默收费：这一附加守门在本次真实二进制之后补入，由后续非付费PG验证，不能计入上述三次真实执行。

证据：[真实整链结果](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/ai/live-validation.json)、[独立任务GET](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/ai/group-get.json)、[真实模型调用预算账本](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/ai/provider-attempts.jsonl)、[存储预检](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/ai/storage-preflight.json)、[新白底](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/ai/set-1.jpg)、[新场景](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/ai/set-2.jpg)、[新细节](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/ai/set-3.jpg)。`scripts/verify-ai-live.py` 默认只预检；显式generate遇已有预算账本即拒绝，不能为重新跑测试而重复付费。

### 本轮套图入行保存与紧凑界面

真实产物入行使用上节三张真实输出URL和源图SHA；新集测经正常cookie、NOINHERIT标准API池、真实内核创建方案和商品行，不以SQL注入就绪或渲染证据。仅以 `baseRevision` 与 `draft` 一次PATCH同时保存 `images` 和 `primary_image`：场景图排首并设为主图，新GET与独立PG读取一致，revision从2到3。名称、标签、说明、价格、源图、media和renderEvidence保留；旧revision409、跨组织GET/PATCH404、禁词400均不写入。恢复旧手动URL再以同一路径保存到revision4。此测试未使用真实PSD，不将旧手动图恢复称为PSD恢复。

该组合修复两处普通角色裸读：行校验的类目查询进入已有组织事务，禁词缓存读取复用已有AppRole平台读取器。单连接回归确认操作后role还原，裸查类目及禁词表仍为42501；未增加表授权或绕过RLS。默认集测及使用实际产物的集测均通过，本阶段新增模型/R2调用均为0。证据：[入行及独立回读](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/ai/row-apply-persistence.json)。

产品入口位于「商品图片」原操作区，以Lucide图标打开Nova弹层，三张图片横排，选用、主图指定、查询和恢复同区操作，不增加页面标题、介绍或额外工具栏。界面以1600px参数读取本行源图预览，按实际发送字节计算SHA；暂存File分支可能直接返回原图，不保证所有路径都缩放。空MIME按PNG/JPEG签名识别，输入仍受4MP/20MiB上限约束。配置/价格/源图不具备时不出现新生成入口；已付费请求仍可查询恢复。

- 选用只保存已就绪图片与首图主图，双字段单次原子自动保存；不修改生命周期媒体事实、渲染证据或发送状态。候选缓存独立于原切片状态，仅信任当前组织/方案/行及原请求匹配的服务端结果。
- 同浏览器原请求持久记录配合Web Locks防止双标签页重复购买；POST回执丢失按原键GET恢复。未知、超时、部分未知和404保留原请求，只允许查询；404不会解锁新付费。三个确定失败经最新GET复核后，才允许显式重试；价格变化须重新确认费用。
- 「恢复切片」按当前本行已交付切片重建图片列表及首图，不是历史自定义选图快照。已有套图在同浏览器重新查询后恢复可信预览；未新增跨设备候选历史。图片持久字段仍由正常行GET保存/读取。
- 浏览器验证为真实组件及自动保存调用、严格内存HTTP夹具，不是浏览器到真实模型/数据库端到端；云端整链与普通角色PG验证分别提供外部及持久化证据。

Ego浏览器完成桌面/375px窄屏生成、预览、三图选用、场景主图、恢复切片、确定失败重试、价格变化确认、回执丢失、部分成功、停用模型后的原请求恢复及404只读锁。两个已打开弹层的标签页同时生成合计只有1 POST，另一页GET取得同一结果；未知业务请求始终0。375px文档宽375、弹层宽351px；Escape关闭后焦点返回套图按钮，减少动画模式无活动动画。证据：[浏览器检查](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/ai/ui-browser-checks.json)、[桌面](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/ai/ui-desktop.png)、[手机](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/ai/ui-mobile.png)。

最新正常AI API隔离集测18项通过，包含65秒租约、失权/恢复、未知、取消、价格确认及跨租户；最终相关Go包、架构和普通角色保存回读通过。前端全量3221通过、2个既有跳过、0失败，443文件；build、api:check及lint通过，未提高警告预算，既有大包提示保留。日志为 `/tmp/podhub-ai-final-regression-verified.log`、`/tmp/podhub-ai-row-apply-real.log`、`/tmp/podhub-live-final-roles-check.log`、`/tmp/podhub-live-web-tests-final.log`、`/tmp/podhub-live-web-build-final.log`、`/tmp/podhub-live-api-final.log`、`/tmp/podhub-live-web-lint-final.log`。

## 此前真实发布复核：当时尚未准入（2026-10-22）

该只读阶段按授权 SSH 查询，并用现成 canonical `seal.OpenStored` 打开 v1 凭据、匹配指纹，完成明确 selftest 商品的5次官方读取（价格1、商品信息1、属性1、类目schema2），均 HTTP 200。该阶段没有发布、改价、库存写入或生产部署。

- 当时核实生产镜像为旧 Rust `0.0.114`，不是新 Go sender，授权 SQL 函数签名也与最新 schema 不一致。Go repo 的 v1 开凭据语义无法打开该生产密文，诊断使用现成 canonical reader，不为旧运行时新增兼容分支；新链路需在最新迁移及正常持久授权下另验，已于后文完成一次导入。
- 当时目标店铺相关用户没有有效正常会话；没有对应 selftest 的 ready 草稿。另一条 accepted 草稿是其他货号，不复制、回退或重复发送。
- 该次官方 selftest 读取为 `images=[]`、无主图、无库存，状态「不在售」。moderation approved/validation success 不等于在售。当时 schema 缺必填属性8229（产品类型，字典1960），不能用 `type_id` 冒充字典选项。
- 当时创建可发送测试输入仍缺真实商品图、属性8229合法值，以及正常登录、订阅和店铺新凭据；后文已补齐另一真实商品输入及正常隔离运行时。若验收「在售」，仍需真实仓库及库存流程。未手动写数据库伪造会话、就绪或商品成功状态。

脱敏证据：[发布复核结果](/Users/xxww/.codex/visualizations/2026/10/22/podhub-next-admission/publish/validation-result.json)。这次实际价格响应包含 CNY、acquiring 和多履约模式佣金/运输字段，但不是完整净利润口径，未自动填入利润试算。

### 本轮 SSH 补齐的真实发布输入

已从 Cloud 数据库找到 org8 正常目录可见的已发布供应 SKU：80×30cm 鼠标垫（`scp_72d518c6a6a54a81a6a93dce2806ba93` / `scs_43accc9523634d7b8046d36886b7975f`），不是原先缺图的 selftest，也不是另一条 accepted 任务。原图3张本地完整 GET200，尺寸、SHA256及商品画面已核对；远端源 IP 曾获 Cloudflare1010，不能把本地可读等同于所有出口都可读。

8次官方只读均200，同一类目 `18262715` / 类型 `96808` 的当前必填属性及合法字典值已核实：品牌85=`126745801`（无品牌），类型8229=`96808`（鼠标垫），型号9048需要全新唯一测试型号。包装采用当前公开源产品的400×450×20mm、470g，明确记录供应配置旧值460g的差异；建议零售价62.00CNY只是货源建议价。没有将未核实的产地、认证或特性复制进新草稿。

输入勘察本身只补齐真实素材和属性，**不构成 ready 草稿、发布回执或在售商品**。随后按下节在最新隔离运行时正常创建会话、店铺、草稿及唯一测试货号，没有借用旧生产会话、复制既有任务或以SQL写就绪/成功状态。旧生产镜像尚未替换。

证据：[真实候选输入](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/publish/candidate-publication-input.json)、[本轮只读结论](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/publish/validation-result.json)、[类目及类型读取](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/publish/official-read-result.json)、[同类目品牌字典](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/publish/brand-dictionary-read-result.json)。本轮输入勘察没有生产数据库、卖家平台或部署写入。

### 本轮唯一真实导入及正常 scanner 回读通过

受控测试商品为 `podhub-live-validation-f8c58027486c4ad9bd6dbdfd`，最终请求使用正常draft字段显式赋予9024/9048同一唯一店铺货号，清除非必要color_image；其余是同类目实证的品牌、类型、2张真实原图、首图、470g包装、62CNY及VAT0。没有后处理冻结body或篡改schema来绕过规则。

- 最新freshPG366、真实cookie和标准NOINHERIT API池完成正常店铺创建、官方只读权限probe、新v2凭据保存、普通方案/行创建和GET回读、真实native校验/冻结及原子入队。schema缓存明确来自本轮实际官方41属性/已核字典的fixture，不据此声称Catalog外部同步通过。
- 标准listing worker从持久新v2凭据绑定当前成员、首店免费额度/订阅、店铺和intent；发送前官方确认该新货号不存在。逐字节比对已审阅的wire SHA256 `56d4ecc74a006f5f5c3ccec70fd827f1739818853e667d47d29d2b2f5b0cef1f`，dispatch前以排他创建及fsync保存预算账本，整轮只允许1次import，未调用库存/改价，未覆盖任何既有商品。
- 唯一 `POST /v3/product/import` HTTP200，task=`5871785557`；原Accepted scanner在真实首读间隔后读取import/info，得到同货号imported、errors=[]，再读取商品确认product=`6706622142`。独立数据库快照保存1个intent、1次write、7个row events、1个attempt1成功job；本地intent仍为accepted，保留平台业务状态。
- 官方商品回读为2个原图URL及主图、62.00CNY、`offer_validated`、validation success、SKU0、`is_created=false`、`has_stock=false`、状态「不在售/创建中」。**只证明单次导入和状态回读，不证明审核完成、在售、正库存或图片已被平台转存。** 无生产数据库或部署写入；授权测试店铺实际新增了这一个零库存测试商品。

实测修复三个正常角色阻塞：凭据注册单独限定官方HTTPS `/v1/roles`只读probe，通用Egress仍不开放；共享Seller预算SQL进入已有AppRole事务，不新增授权；租户提交在当前AppRole事务直接入队，不错误切换无权限的worker角色。真实normal-role回归及原子幂等/角色恢复检查均通过。

本轮隔离PG在退出后销毁，保留脱敏账本/回执；没有验证跨进程恢复原scanner账本，也不做常驻环境或生产部署。全局单次写账本保留，未知时不重发、不换货号；后续只读可以另行核对平台状态，不能冒称原实例恢复。

证据：[真实导入与回读](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/publish/actual-run/publication-submit.json)、[官方商品原始回读](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/publish/actual-run/official-product-readback.json)、[独立账本快照](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/publish/actual-run/actual-ledger-snapshot.json)、[审阅请求](/Users/xxww/.codex/visualizations/2026/10/22/podhub-live-admission/publish/reviewed-preflight/planned-import.json)。最终回归日志为 `/tmp/podhub-publish-final-units.log` 与 `/tmp/podhub-publish-final-normal-role.log`。

## Range 与私有原图下载验证（2026-10-25）

供应商原图读取已改为：冻结派单授权 → 当前加密私有桶配置 → 120 秒签名 GET → JSON 授权或 `307` 跳转。Go 不再完整缓冲原图，原来的 20 MiB 代理上限随该分支移除；安全图片支持 inline 预览，其余类型强制下载。跳转、授权和错误响应均禁止缓存，签名也覆盖最终对象响应的缓存策略、内容类型与文件名。普通数据库角色读取平台配置使用已有 AppRole 事务，操作结束恢复登录角色。

| 验证 | 结果与边界 |
| --- | --- |
| 本地 500 MiB 文件 | 跨 64 MiB 边界只返回所需 8 字节；尾部与开放范围、匹配/变化的 `If-Range`、`416`、私有跳转头通过，race 检查通过。源站是本地 HTTP 文件服务，不是生产 R2。 |
| 私有授权与配置 | 全新 PostgreSQL、真实登录 cookie、单连接 `podhub_login_api` 下，500 MiB 元数据授权、图片预览/下载、未知 MIME 降级、未登录/越权/错派单/错素材拒绝、凭据轮换、停用、非法端点与角色恢复均通过。原履约授权及历史派单隔离回归通过。 |
| 公开域真实视频 | ego-browser 对现有 4,534,882 字节 MP4 的首部、尾部各读取 1,024 字节，均 `206`，`Content-Range` 和长度准确，ETag 一致；缓存依次为 MISS 与 HIT，`Cache-Control: public, max-age=14400`。证明现有浏览器 Range 和缓存链路可读。 |
| 脚本与浏览器差异 | 本地脚本和生产主机脚本收到 Cloudflare `403`，生产主机响应为 `1010`；实际浏览器读取通过，不能把脚本拒绝解释为视频不存在或浏览器不可读。 |
| 生产私有桶 | 只读打开的旧生产快照仍是旧字段，委托配置为停用的 `podhub-delegate`。当前运行时要求 active 的 `podhub-private`；本次未修改生产快照、桶策略、DNS、Cache Rules 或部署，尚未完成真实私有对象下载、R2 响应头覆盖及断点续传验收。 |

相关 Supplier、App、Delegate、Media、签名及架构回归，前端下载/隔离/退出登录 6 项测试、类型检查、API 生成一致性和 vet 均通过。未新增分块缓存服务、分片大小设置或产品入口；PSD 继续使用现有本地缓存与并发恢复复用。

本次没有切换 Origin Range Requests，也没有同区间、同缓存状态的 A/B 或 p99 样本；不能据此推导 Cloudflare 新实现对本项目的性能提升比例。**本地下载构件已验证；公开小视频的浏览器范围读取通过；生产私有大文件外部链路仍待验证。**

证据：[汇总与验证边界](/Users/xxww/.codex/visualizations/2026/10/25/podhub-range-validation/report.json)、[浏览器真实范围响应](/Users/xxww/.codex/visualizations/2026/10/25/podhub-range-validation/public-browser.json)、[正常角色集测](/Users/xxww/.codex/visualizations/2026/10/25/podhub-range-validation/normal-role.log)、[本地 Range race](/Users/xxww/.codex/visualizations/2026/10/25/podhub-range-validation/range-race.log)。

## 三测试桶浏览器上传与 CORS（2026-10-25）

环境为本地真实 React/Vite 页面 `http://127.0.0.1:1420`、新 Go API、标准 `podhub_login_api` 数据库连接及真实 Cloudflare R2。专用管理员通过正常邮箱密码登录后操作供应商商品库（超级管理员权限只来自平台角色，没有验证器），普通成员通过正常登录操作工作区与委托原图；测试图为现有的 1,053 字节、20×20 PNG。

| 桶 | 实际入口与结果 |
| --- | --- |
| `podhub-test-slices` | 在已登录 React 页面调用生产 `prepareDirectMedia`，使用正常账户概览、新批次、预签名、浏览器条件 PUT 和 complete；公开 GET 200、SHA256 一致。数据库 `media_object_leases` 为 `verified`，长度 1,053、尺寸 20×20，`verified_at` 与 `public_ready_at` 均非空。 |
| `podhub-test-supplier` | 真实「供应商商品库 → 商品 → 上传图片」完成授权、R2 PUT、确认及商品保存；确认与保存均 200。刷新页面后图片仍在，公开 GET 200、SHA256 与输入一致。 |
| `podhub-test-delegate` | 真实「委托订单 → 绑定 → 素材 → 上传原图」完成授权、PUT 和确认；刷新后仍显示已核验。浏览器读取本轮同一对象的签名 URL 得到 200、长度及 SHA256 一致；匿名 S3 为 400，关闭的 managed 公共域为 401。 |

三桶 CORS 仅允许 `http://127.0.0.1:1420`、`http://localhost:1420`，方法 `GET/HEAD/PUT`，请求头 `Content-Type`、`If-None-Match`、`x-amz-checksum-sha256`，暴露 `ETag`、`Retry-After`，预检缓存 300 秒。18 个允许组合的真实 OPTIONS 全部 204；未列来源、POST 和未列请求头共 9 个负例全部 403 且无 ACAO。真实浏览器使用共用上传函数对三桶完成 PUT、签名 GET、HEAD 和 ETag 可见性检查。slices、supplier 的 managed 公开访问开启，delegate 保持关闭。

本轮修复了 transit 返回 501 的授权/确认接口、仅允许回环假桶的服务端 R2 回读、裸 DTO 被当成 data 信封的前端读取、委托公开 JSON 字段与校验和协商，以及货源上传的专用请求/授权契约。OpenAPI 与生成产物已同步，旧 camelCase 委托请求不保留兼容分支。相关正常角色数据库集测、架构测试、Go 全包编译、前端回归、类型检查与生产构建均通过。

测试对象及货源核验 sidecar 均已逐个删除并确认签名 GET 404。专用测试账号、工作区与业务数据已清理，本地库恢复为 0 账号、0 组织、未初始化；审计与 writer 历史保留。未修改生产桶或部署。

**当时边界：transit 只覆盖真实前端上传模块与正常 HTTP 存储链，尚未覆盖完整批量上架页面。** 当时 listing row prepare/media/images 接口、PSD 云备份未挂载，大文件与分片未测；后续推进范围见下一节。隔离店铺使用不可解密的测试凭据，页面自动读取发货单的失败不作为 Seller 能力证据。

脱敏证据：[浏览器上传、CORS 与清理汇总](/Users/xxww/.codex/visualizations/2026/10/25/01a17185-be10-7c10-a942-c9080506ee42/r2-upload-qa/report.json)。证据不含密钥、密码、上传票据或预签名 URL。

## 批量上架整页切片、上传与大文件（2026-10-25）

使用独立临时 PostgreSQL、普通 `podhub_login_api` 角色、正常成员/管理员登录、真实 React 页面和上述三个测试桶。店铺为本地隔离夹具，禁止 Seller 写入；未改原开发数据库。

- **批量上架整页通过：** 从方案库绑定真实智能对象 PSD、导入 20×20 PNG，再点击「切片」「上传」。浏览器 WASM 实际输出 `back`、`front` 两张 56×42 JPEG（668、671 字节）；prepare、render 回写、上传批次、条件 PUT、complete、图片绑定均走正常 API。数据库行为 `media_state=ready`，两图 `public_ready`，两个浏览器任务 `media.render` / `media.upload` 为 `succeeded`。完整摘要、尺寸、长度、当前存储身份和有效回执一致；公开浏览器 GET 200、SHA256 一致，刷新后状态与图片保留。
- **货源大 PSD 分片通过：** 在「供应商商品库 → 商品 → 上传 PSD」实际上传 75,000,040 字节的 5000×5000 RGB PSD，五片均返回 200 和可读 ETag；服务端完成完整 SHA256/长度/MIME/文件头校验，确认与商品保存均 200，刷新仍保留下载链接。公开浏览器完整 GET 的长度、MIME 和 SHA256 一致；测试公开域此次下载耗时约 243 秒。故意中断后，同一文件可在保留条件完成防覆盖的前提下恢复：现有对象完整匹配才确认，不匹配仍 409；清理仅针对本次 upload ID。
- **私有大原图通过：** 在「委托订单 → 绑定 → 素材」用普通 PUT 上传同一 75MB PSD，授权、PUT 和确认均 200，刷新仍为「已核验」。该精确对象的诊断签名 GET 在浏览器中返回 200、完整长度及 SHA256 一致；匿名 S3 为 400（要求 Authorization），managed 公共域为 401、开关保持关闭。此诊断签名读不代表厂家下载或履约授权流程通过。
- **失败和恢复：** 真实页面验证已有分片后主动取消，剩余 PUT 中止、Abort 204。延迟真实授权回包后在页面取消，授权到达后仍执行本次 Abort 204，零 PUT、零确认；对应回归同步保留。部分上传旧凭证过期时先刷新全部证明再整批绑定。普通角色真实 PostgreSQL 回归还覆盖换源图/模板后取消、命令重放、CAS、跨租户拒绝和终态全图复验。

本轮同时修复类目请求的 query/裸响应/原生材料字段契约，以及类目树与填充路径漏切换应用数据库角色的问题；OpenAPI 与生成文件同步。Go 受影响测试、架构检查、全包编译、前端回归、TypeScript、WASM 指纹检查和生产构建通过。

**当时准入边界：** 只推进本地 PSD 切片和媒体交付。当时识别及组合准备明确返回 501；PSD 本地绑定可用，云备份入口返回未挂载错误。后续接线与 PSD 备份证据见下一节。本轮没有模型调用、批量规模、跨设备/进程恢复、履约派发或 Seller 发布证据，媒体完成不代表商品可发送或已在售。

清理完成：5 个精确测试对象（含确认 sidecar）删除后逐一 HEAD/GET 404，1 个遗留分片会话中止后精确 key 下无未完成上传。临时 PostgreSQL 容器及其独占匿名卷、测试凭据和探针文件均已移除，浏览器任务已关闭，原开发服务恢复；原开发数据库未改。

脱敏证据：[整页切片、75MB 上传与清理记录](/Users/xxww/.codex/visualizations/2026/10/25/01a17185-be10-7c10-a942-c9080506ee42/workflow-upload-qa/report.json)。记录不含密码、上传票据、S3 密钥或预签名 URL。

## 识别、组合准备与 PSD 云备份接线（2026-10-25）

使用另一套独立临时 PostgreSQL、正常管理员/成员登录、普通 `podhub_login_api` 角色及真实 React 页面，使用已配置的私有及中转测试桶，原开发数据库未改。初始方案为隔离夹具，商品行由真实页面导入白杯 JPEG 创建；完整组合样例另外通过页面复制出空方案，再导入新行。未注入识别结果、收费结果或媒体就绪状态，未调用 Seller 写入。

- **PSD 备份与恢复通过：** 真实页面分别绑定 20,596 字节和 75,000,040 字节的智能对象 PSD。小文件普通 PUT，大文件五个实际 PUT 后完成分片；确认均完成全文件 SHA256、长度、MIME 与 PSD 文件头复验。普通角色独立回读核实模板为 ready、私有对象为 live、组织与当前存储身份一致，且存在 `psd_template` 引用。
- **本地缺失恢复通过：** 仅删除本轮两个唯一摘要对应的本地 OPFS 模板，再由真实页面重新打开对应方案；正常方案下载授权与私有 R2 GET 均为 200，自动恢复后的长度和 SHA256 与上传原件一致。未清除整个站点存储，也未把本地缓存命中当成云端恢复。
- **隔离通过：** 切换至另一个正常成员和组织，页面只显示该组织的方案。请求原组织的两个模板，以及在本组织未绑定方案中请求已知摘要，均为 404，响应不含下载 URL。
- **接线初测：** 准备、浏览器领取、私有识别图暂存、调用回执、保存与恢复路径已接通，补齐命令输入冻结和计费保护。初测尚无 AI 配置时不列为功能通过；后续取得用户提供的真实服务后才推进下面的外部验收。
- **初测缺模型时的真实页面：** 单独识别返回 422 与 `missing_model`，页面显示配置/选择模型的具体原因与重试建议。组合准备返回识别阻断项，同时真实 WASM 切出两张 56×42 JPEG 并完成两个 R2 PUT、完整确认与入行；刷新后媒体仍 ready、两图 `public_ready`，内容保持 draft，发送数为 0。再次一键准备不创建新媒体任务、不重新 PUT，仍明确缺模型；媒体成功不会记为上传失败。该阶段普通角色独立回读确认仅两个媒体任务成功，AI 任务、AI 请求、占款和资金流水均为 0。
- **真实模型配置：** 按用户的低价偏好选用 `qwen3.7-flash`。授权模型目录实际返回该模型，正常管理员登录后（只校验邮箱和密码），通过真实账号页面保存、加密持久化及脱敏刷新回读，应用内鉴权探测返回 `modelPresent=true`。关闭思考的配置实际传为 `enable_thinking:false`。采用[官方北京区价格](https://help.aliyun.com/zh/model-studio/qwen3-7-flash)的输入不超过 32K 档：每百万 Token 输入 0.2 元、缓存输入 0.04 元、输出 0.8 元；平台单请求预占上限单独配置。隔离钱包通过正常管理员 HTTP 加入 0.10 元测试余额，属于手工测试赠额，不是外部支付。
- **真实单独识别通过：** 浏览器领取任务，将源图转换为 65,469 字节、1024×1024 的 JPEG，经私有 R2 PUT 与服务端完整摘要回读后调用真实模型。模型约 4.3 秒返回俄文标题、简介和六个标签（一个固定、五个生成）；行保存、重新打开、独立普通角色数据库回读均一致。发现完成状态被全字段发布校验覆盖后，修复 Go 宿主；原行经新的识别命令复用已结算回执，仅修正完成状态，草稿和输入版本未变，没有新模型调用、任务或扣款。
- **真实完整组合通过：** 新空方案中的新商品行点击一次「一键准备」，识别和 WASM 切片并行。模型约 2.6 秒返回；两张 56×42 JPEG 实际 PUT、全文件确认与图片绑定均为 200。刷新后 `content_state=ready`、`media_state=ready`、两个切片 `public_ready`，页面三步完成并进入「加工审阅」。缺少价格、尺寸等必填字段仍为 `fields_invalid`，发送数保持 0。媒体完成不会再把识别状态改回待识别。
- **回执与账本通过：** 同一成功回执经正常 GET 重放后，回执 ID、内容和输入版本不变；其他正常组织读取该回执、商品行和方案均为 404。普通角色独立核验恰好两条已结算请求、两个不同上游响应及各两笔 hold/settle，最终冻结余额为 0。按成交费率计算的总额为 111,320 microfen（0.0011132 元），钱包实际扣 41,320 microfen；既有预占封顶规则下，超出预占的 70,000 microfen 由平台承担。该数字是本轮用量与平台账本核对，不是阿里云最终账单；生产成本估算仍需更多图片与文本采样。

本轮修复 PSD 分片计划的 snake/camel 映射、完成分片请求、迟到授权取消、失效对象重传判断；补齐实际管理配置/价格读取、配置和探测的字段契约、普通数据库角色入口，以及识别完成与发布校验耦合、媒体完成覆盖 AI 状态的问题。PSD 恢复和素材准备完成不代表商品可发送或已在售。

受影响 Go 包、正常数据库角色集成、架构检查、全包编译、生成文件、TypeScript 和构建通过；最终前端全量回归 3,258 通过、2 项既有跳过、0 失败。测试 provider 仅用于本地故障与并发回归，上述两次识别使用真实外部模型。未验证大批量、跨设备或跨进程恢复，未做生产部署或 Seller 发布。精确测试对象和临时环境的清理结果见证据记录。

清理完成：八个精确对象（两个 PSD、两个识别暂存、四个切片）均 DELETE 204，并逐一 signed HEAD / 无 Range 完整 GET 404，精确 key 下无未完成分片。独立验收容器及其独占匿名卷、临时密钥均已移除，浏览器验收窗口关闭，原开发 API / 前端 / 数据库服务恢复。未删除其他桶对象或原开发数据；脱敏文件已核查不含实际密钥、数据库连接串、租约 owner 或预签名链接。

脱敏证据：[PSD 备份、云端恢复与识别验收状态](/Users/xxww/.codex/visualizations/2026/10/25/01a17185-be10-7c10-a942-c9080506ee42/recognition-psd-qa/report.json)。本轮环境与精确测试对象的清理状态由该记录单独维护。

## 下一项技术验证

前轮限定模型三图套图、单商品发布回读及单次正常改价回读，以及本轮白杯样例的识图和组合准备已取得真实调用与保存回读证据。生产配置和部署未变，不称生产已启用。识别质量泛化、生产计费估算、在售、真实库存、多商品规模和跨进程恢复仍需各自验证。自动利润定价下一步需目标线路有效运价、候选售价完整费用模型、目标净利率及适用的结算口径，不能用当前价费用采样、目录采购报价或参考汇率代替完整成本。外部采集、分层PSD和跨平台分发仍未准入。

## 本地运行时补齐与复验（2026-10-27）

本阶段按用户要求先补齐可自建的本地运行时，使用三个子代理并行实现和交叉复核。最终正常服务为 `http://127.0.0.1:8080` / React `http://127.0.0.1:1420`，数据库使用普通 `podhub_login_api`；没有继续使用临时宿主或验收专用解析器，也未修改系统 DNS。全量检查结果与脱敏日志统一收录于 [本阶段报告](/Users/xxww/.codex/visualizations/2026/10/26/01a17923-5745-7982-b483-fd334f51cd10/backend-completion-20261027/report.json)。

| 能力 | 实现与实际证据 | 验证边界 |
| --- | --- | --- |
| 正式进程 DNS | API 与 worker 启动读取 `CLOUD_DNS_SERVER`，本机配置 `1.1.1.1:53`；正常 8080 的已存 AI 账号鉴权探测 200、真实 Ozon 类目读取及 R2 上传确认通过 | 保留原有公网目标检查和 TLS；不是修改机器全局网络设置。 |
| 支付运行时 | 加密配置按操作读取；支付宝、微信、Stripe、Airwallex、易支付两种方式接通下单、支付入口、通知验签、查询恢复与单次入账。普通角色、重复通知、取消后晚到付款及不确定状态均有数据库回归 | 本机尚无真实商户配置，启用列表实际为空。自建渠道测试不等于真实收款或结算；关单不能证明时保持待核对，Airwallex/易支付返回 409。 |
| Seller 代理路由 | 官方客户端及 worker 共用受控 SOCKS5h 路由；Probe 不带 Seller 凭据且不回退直连。自建隔离 REALITY 完成节点切换、错密钥/UUID、停止与禁用验收 | 回退仅发生在建连阶段，写入已发送后断响应不重发。正常环境仍未配置公网节点；自建测试不计为公网店铺代理通过。 |
| 类目抓取执行器 | 手动和定时共用有 epoch 围栏、续租及失败回执的执行器。正式 8080 实际读取 26 个根节点和一个已知坐标的 55 个字段，缓存、current 与 canonical 版本注册均落库回读，完成后释放租约、失败计数归零 | 读取完整树并刷新已有引用/缓存坐标，未爬遍全部叶子。定时与崩溃恢复有真实数据库测试，未做跨天长期运行。手动执行保留原定时开关。 |
| 存储确认补漏 | 补挂通用货源存储确认路由并统一 snake_case 请求。正式 8080 的 tiny PUT、确认、原票重放、独立源站签名 GET 均通过，1,053 字节 SHA256 一致；仅本轮对象及 QA 货源已精确清理 | 该阶段源站链通过，默认 Python 脚本的公共读取 403 留待核查；后续已定位为客户端标识问题并复验通过，见下节。 |

本轮真实调用发现并修复了类目快照同版本展示顺序误判：比较仅忽略内核哈希明确不包含的展示材料，仍拒绝真实字段约束变化、未知语义字段及伪造相同版本；首次 registry 快照保持不变。真实 WASM 对拍、普通数据库角色刷新/建行/发送注册及 race 回归通过。另将两个数据库测试的硬编码 Docker 套接字探测改为已有环境检测，实际运行两项原先误跳过的测试，未放宽断言或数据库权限。

外部账号相关验收放在最后，以下资料需来自账号所有者；本轮自建的本地测试密钥、渠道服务和 REALITY 节点已完成验证并清理。

| 待验证链路 | 需要提供的账号、密钥或环境 | 后续验收内容 |
| --- | --- | --- |
| 支付宝 | 已开通相应产品的商户/沙箱应用、App ID、应用私钥、支付宝验签公钥，明确沙箱或生产环境 | 实际收银入口、付款、官方通知验签、查询和单次入账/结算核对。 |
| 微信支付 | 商户号、App ID、API v3 密钥、商户证书序列号及私钥、平台验签证书或公钥配置 | 实际下单、扫码支付、通知解密验签、查单与账本核对。 |
| Stripe | 所有者的测试商户账号、测试 Secret Key、Webhook Signing Secret | 实际 Checkout、事件通知、查询恢复；生产结算另需已开通的真实商户。 |
| Airwallex | 测试/生产环境选择、对应 Client ID 和 API Key、可使用的支付产品及 CNY 币种能力 | 实际 Payment Link、回调验签、付款/取消与官方结果回读；未知关单保持待确认。 |
| 易支付 | 所有者认可的网关 URL、商户 ID 和签名密钥、支付宝/微信渠道授权 | 真实收银跳转、签名通知、查单与结算核对；不能证明关单时保持待确认。 |
| 支付通知公网入口 | 所有者控制的公网 HTTPS 域名、有效证书、API 回调反向代理及渠道侧 webhook 配置 | 外部渠道到正常服务的通知投递、重试与去重；本轮未将本地管理服务暴露到公网。 |
| 公网代理 | 自有 VPS 的部署权限，或现成 VLESS REALITY 节点地址/端口、UUID、serverName、公钥、short ID 和对应受控 sidecar 环境 | 真实公网握手、固定官方目标读取、切换与故障处理；测试不发送 Seller 写入。 |
| Ozon 权限与业务写入 | 评价/问答所需店铺订阅及授权；若继续验证发布、库存或促销，需明确的测试店铺、测试商品与写入范围 | 受限接口读取及对应实际写入/官方回读；已有只读和类目授权无需重复提供。 |
| AI 图像生成复验 | 已有 AI 密钥无需重复提供；确认支持图片输出的目标模型 ID、实际权限与小样本验收范围 | 图像生成需另行实际调用和输出验收，识图或模型目录成功不代替图像生成通过。 |
| 真实履约及打款 | 指定可操作的测试订单/供货/售后单、明确的金额与收款授权；打印另需有效标签、打印机与纸张 | 验证真实状态回读及资金/物流凭证。现有代理打款属于人工账务确认，尚未接外部打款 API。 |
| WB 发送 | 后续接入需卖家 Token 及受控测试店铺/商品 | 当前仍缺发送适配，先完成代码和本地验证再验账号；仅补密钥不能使该能力可用。 |

已配置 AI 账号及测试桶的密钥不需要重新提供，证据文件不包含密码、密钥、上传票据或预签名 URL。WB 发送、外部采集、完整履约和真实资金结算仍按前述各自准入条件处理，本阶段未扩大这些能力的结论。

## R2 公共读取 403 归因与复验（2026-10-27）

本轮三个子代理分别检查真实对象生命周期、本机网络差异、配置与 URL 调用链。上节遗留的 17 字节响应实际为 `error code: 1010`。同一对象使用默认 `Python-urllib` 标识时返回 403；保留同一系统网络/代理路径，仅把请求标识配置为真实的 `PodHub-R2-Verification/1.0` 后，连续两次返回 200，完整 SHA256 和长度相同。浏览器及 curl 同时读取通过。关闭单次请求代理仍复现默认 Python 标识的 1010，因此不能把它归因为系统显式代理独有问题。

该结论来自本轮同对象对照。Cloudflare 将 1010 描述为客户端签名拒绝，并建议客户端使用描述应用的 User-Agent；其文档对 Pages/Workers 的专门说明不直接扩大为全部 R2 内部机制结论。[官方说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)

已修正验收请求的客户端标识，保留 [可复跑的公共回读工具](/Users/xxww/.codex/visualizations/2026/10/26/01a17923-5745-7982-b483-fd334f51cd10/r2-public-403-20261027/public-readback.py)。工具只接收无签名查询参数的 HTTPS `pub-*.r2.dev` 对象地址，限制读取大小，校验完整 SHA256/长度，不跟随跳转，成功才退出 0。它使用系统默认 TLS 和网络设置，不使用浏览器伪装标识，不读取存储凭据。

| 验证范围 | 真实结果 |
| --- | --- |
| 货源公共桶 `podhub-test-supplier` | 正常 8080 预签名、PUT、确认/提升成功；原票重放一致；真实浏览器、curl、描述性应用标识均公共 GET 200，1,053 字节 SHA256 一致。 |
| 中转公共桶 `podhub-test-slices` | 当前工作区经正常 8080 建批次、预留额度、真实 PUT、complete，源站与公开读取复验后持久化 ready；两次应用标识公共 GET 200，摘要/长度一致。 |
| React 跨域读取 | 从实际 `http://127.0.0.1:1420` 对两个公共桶执行浏览器 fetch，均 200、`response.type=cors`，完整摘要一致且 ETag 可读。 |
| 配置与权限 | Cloudflare 货源测试桶公共开发 URL 原本已启用。进程配置与 `.env` 一致；公开地址与精确对象 key 匹配，私有角色无公开地址；加密旧桶字段未抢占配置。未修改桶权限、密钥、系统代理、DNS 或产品源码。 |

清理完成：三个本轮精确对象均删除，源站和诚实应用标识的公共 GET 均 404。中转租约通过普通数据库角色白盒精确退休并标记删除，`public_ready_at` 清空，历史核验字节、用量和审计保留；正常 POST probe 不再广告该对象。回读工具对两个已删除的公共对象均返回 404、校验失败并以 1 退出。临时 bridge 和签名辅助工具已移除，正常 API/前端继续运行。

本阶段解决的是已定位的验收客户端 1010，不承诺所有第三方客户端或默认库标识均不再被 Cloudflare 拒绝。测试使用 `r2.dev` 开发地址；生产自定义域名、缓存及长期吞吐需另行验收，不能把开发桶通过扩大为生产 CDN 已部署。[公共开发 URL 的官方边界](https://developers.cloudflare.com/r2/buckets/public-buckets/)

完整请求对照、清理状态及剩余范围见 [本轮报告](/Users/xxww/.codex/visualizations/2026/10/26/01a17923-5745-7982-b483-fd334f51cd10/r2-public-403-20261027/report.json)。早期 403 原始证据保留，本节推进其结论；其余外部商户、店铺权限与未实现适配仍按前述清单处理。

### 2026-10-28 用户自带切片 R2

结论：**本地构件与测试桶外部链路通过**，可接入用户设置；尚不代表任意用户的域名、授权、CORS 或外部平台取图均已通过。每次保存用户配置时再次执行对应 R2 授权、条件 PUT、私有/公开回读、列举和精确删除检查；有浏览器 Origin 时也检查 CORS PUT 预检与公开 GET。

使用隔离 PostgreSQL 16、普通 API 登录角色及普通 media worker 登录角色执行 `TestLiveUserSliceSettingsAndClear`：两名真实注册用户分别读取设置，错误密钥被拒绝；正确密钥加密持久化且不在设置响应回显。当前用户通过正式媒体接口签发、向真实测试 R2 PUT 并确认真实 PNG；手动清理请求经 worker 认领，租约退休、批量删除及签名 GET 404 通过，另一用户无权读取该设置。为避免等待上传授权过期，测试把清理请求时间回拨 17 分钟，并使用更早的合法批次；这不等于实际等待窗口已做长时测试。

`TestLiveVerifyUserSliceStorage` 对 `http://127.0.0.1:1420` 的真实 R2 CORS 预检及保存前验证通过；`TestLiveUserSliceStorage` 另行验证真实 PUT、私有和公开字节回读、前缀列举、批量删除与删除后 404。均使用随机配置 UUID，只删除本次生成的精确对象；没有清空测试桶或触及其他用途对象。仓库另有局部测试覆盖分页、未来批次保留、跨前缀拒绝及不完整删除回执。

用户自己的桶必须配置公开访问、应用 Origin 的 CORS 及对象读写列举删除权限。`worker-media-gc` 需运行且删除开关开启；中断上传在最后一次列举后落地、生产自定义 CDN 缓存及外部平台取图完成时间仍未验证。已受理的上架请求不等于平台已取走图片。

## 对抗审查修复回归（2026-10-29）

本轮修复批量取消、未知提交收敛及手动核对的本地状态一致性。取消项从实际发送内容和凭据绑定中剔除；自动、手动和人工释放同步结清未知账本及货号占用；核对响应必须通过具体 Ozon 解析器，迟到 claim 不得覆盖新持有者。

回归使用实际 Go HTTP、独立 PostgreSQL、普通 API 数据库角色及本地受控 Seller 响应。覆盖同货号重新发送、取消首/中/尾/全部、绑定窗口取消、事务回滚、畸形回读和迟到核对。商品改价的完整价格回读可收敛，连续两次相同差异可解除旧目标围栏；无完整回读证据时保持未知。聊天历史中的相同文本不构成本次发送的成功证据。

这些结果只证明本地实现和故障恢复回归通过，没有真实 Seller 发布、库存、资金或履约操作；大批量、生产部署及跨进程长时间故障验证仍须独立完成。


## 2026-10-30：商品内提示词构建器（已退役）

此入口已按用户要求移除，下面保留历史验证记录。当前准入以[AI识图验证](architecture/artwork-ocr.md#实测与对抗审查)为准。

**本地构件已验证**：真实 React 商品详情内完成中文需求、私有样本上传、后台构建、逐图输出、反馈改进、候选选择和采用草稿；刷新可恢复，390px 窄屏保留全部操作。使用独立 `worker-prompts` 与现有队列围栏；普通 API 角色的集成测试验证已发布商品编译快照进入识图请求并结算。首次采用、重复操作键、组织隔离、事实冲突、规格边界、取消与未知回执停止均有受影响测试。

**外部模型链路已验证**：使用服务端保存的识图账号和 `qwen3.7-flash`。首次完整实测为 1 张杯子图、3 版、9 次真实调用；请求账本全部 settled。钱包扣费 ¥0.003682，与页面、独立账本回读一致。首轮非法 JSON 和标签重复都实际被拦截；后续候选生成有效俄文文案。采用的 v2 保存为本地商品草稿，未自动发布。

**版本与反馈复验已完成**：真实页面从当前查看的 v3 继续改进，持久化来源版本和反馈；新运行生成 2 版，¥0.10 上限，运行记录扣费 ¥0.0023336。v1 仅采用为第 2 个商品提示词草稿，回读正文一致且发布修订仍为空。桌面与 390px 窄屏验证实际版本差异、采用标记、发布限制、预算恢复和键盘操作；回归验证终态 worker 重放不覆盖采用结果。

**语义要求未全部满足**：复验中指定标题主题使用 `Без рисунка`，两版输出都未严格满足，且 v2 复核格式无效。界面保留“待人工确认”。此证据只能证明构建、测试、反馈、状态与草稿持久化路径，不能证明模型语义质量通过。

**历史准入结论（已撤销）**：商品提示词构建的首版入口当时允许本地使用。程序规则通过与模型语义意见分开展示；模型复核出现过误判，仍须管理员确认。没有因此把商品标为公开或外部在售。

**未验证范围**：多商品泛化、独立留出样本、生产部署和真实 Seller 上架。试用图片暂存于受 RLS 保护的 PostgreSQL，最多 25 张/商品；通用媒体保留策略仍待接入。旧修订若没有编译快照，需创建并发布新修订后进入商品识图路径。

证据摘要见[实现与边界](architecture/product-prompt-builder.md)。账本回读、版本与反馈复验、桌面和窄屏截图保存在本地验收资料，不随源码提交。


## 2026-10-30：共享AI识图

**本地构件已验证**：三项商品事实编辑、草稿、发布与回读通过。共享 Rust/WASM 完成主题校验和固定事实拼装；无效旧修订不能发布。原始购买键重放、账单、租约与跨组织拒绝由普通 API 角色集成测试验证。

**外部模型链路已验证**：指定端点的 qwen3.7-flash，前轮最终模板 57 次真实图片调用。覆盖同图六类商品及 15 个独立图片；56 份可应用，1 份无依据地域修饰被程序拒绝，不购买修正。其中额外 6 次调用经过生产 Go 请求构造器与服务器 WASM。

**完整链路已验证（本地 API + 真实外部服务）**：本轮再用同一猫与杯子原图、六个商品条件完成 6 次不同响应标识的真实调用。工作空间管理员 Cookie → 任务领取 → 真实 R2 私有测试桶上传与 SHA256 回读 → Qwen → 钱包结算 → Rust/WASM 拼装 → 商品行持久化及独立 PostgreSQL 回读均通过。6 个任务恰有 6 笔请求、6 笔结算，冻结额归零；GET/POST/settle 重放无新增扣费，缺图与错误租约拒绝，另一工作空间读行和回执均 404。钱包合计扣 ¥0.00092440；按单价和 usage 计价 ¥0.00333360，现有预付封顶记录平台承担差额 ¥0.00240920。累计真实调用 63 次，62 份可应用、1 份拒绝。

**供应商商品库 UI（当时验收，修订/发布流程已由下节 2026-10-31 的唯一当前配置替代）**：商品详情「识图」页三项事实、输出开关、固定标签、预览和发布差异对应真实接口。新增「草稿 v4 · 已发布 v3」/「已发布 v4」版本显示，按钮明确为「发布商品事实」。真实 UI 保存并发布 v4，API 回读一致，商品仍未启用。129 项商品库测试、架构测试、TypeScript 与生产构建通过，1728px/390px 界面已查看。

**准入结论**：现有AI识图可使用共享模板与确定性拼装。逐商品提示词二次优化和 AI 复核入口移除。实测规格为受控条件，不能视为实际商品事实。

**未验证范围**：实拍商品图、纯色/模糊图的真实模型质量；六类 Ozon 实际类目映射与完整必填字段（本轮共用已缓存的数字油画 schema，只验收识图内容与扣费）；供应商商品从启用到 Seller 上架；远端部署。视觉 token 尚未进入现有预付估算，本轮没有改变封顶结算规则。

证据、UI 和代码入口见[AI识图](architecture/artwork-ocr.md)，本轮请求、文案及账本明细见[完整链路脱敏证据](architecture/artwork-ocr-live-20261030.json)，前轮脱敏原始回包在[固定夹具](../rust/crates/listing-core/tests/fixtures/ocr-qwen-live-20261030.json)。


## 2026-10-31：本地环境巡检、唯一识图配置与真实跑图

**本地构件已验证**：现有 PostgreSQL 已应用迁移 00016，启动 Go API 和真实 React 前端。巡检 15 个主导航页面及 19 个设置分区，核对五类本地角色；成员管理 30 项浏览器回归及通知生命周期通过。没有重置开发数据库。

**已删除**：逐商品提示词构建、自迭代、AI 复核、付费修正重试；全局提示词设置、专用同步及文件导入；不能保存的 WB 类目凭证入口、重复通知设置跳转、始终禁用的新建邀请入口及不可到达表单。删除识图草稿/发布/历史选择及发布差异接口。迁移 00016 将最后保存事实归入唯一当前配置并删除历史表；资金账单继续保留。未删除既有成员、已存 WB 配置或无关业务数据。

**供应商商品库 UI 与代码已验证**：商品详情采用「商品信息」「平台字段」「AI识图」三个页签。识图保存直接替换当前事实，固定标签和输出开关在同一页维护，支持免费手填主题测试和真实图片付费测试。桌面与 390px 窄屏验收通过。类目树父索引、平台字段 API 格式、商品可选状态及供应商默认字段/输出策略的实际接线均已修复；补上商品行删除接口，跨工作空间与处理中拒绝回归通过。

**外部链路已验证**：同一张真实原图在页面完成马克杯、鼠标垫的标题、描述和标签测试。新建真实数字油画类目商品及供应商方案后执行一键准备，文案自动落库，真实 93,243,996 字节 PSD 由浏览器 WASM 生成 9 张 JPEG，上传后全部公开 GET 回读，长度及 SHA256 一致；刷新保留结果。供应商 PSD 私有授权完整下载及摘要核验通过，错误摘要和未绑定工作空间返回 404。三笔独立测试及两笔正式流程共实扣 ¥0.00077160，逐笔均只有一条预占、一条结算，最终无冻结余额；其中第一笔正式流程未自动填入，记录为接线缺陷，修复后重新验证成功。

**边界**：测试库和测试规格已恢复未公开/未启用。Seller 写入始终关闭，样本行仍缺卖家销售价和品牌字典材料，未标为待售或已在售。入仓库存巡检曾遇 Ozon 502，保留真实错误和重试；没有进行真实支付结算或远端部署。视觉 token 预付估算及平台承担差额的现有规则未修改。

**自动检查**：前端全量 3313 项测试通过，最终接口改动后另有 65 项受影响测试通过；TypeScript、生产构建、API 类型一致性、Knip 与 lint 通过。Lint 保留 727 条既有警告，阈值仍为 818。`go test ./...`（含临时 PostgreSQL 全量集成测试）、架构检查、全部 Go 包编译及最终 OpenAPI 契约检查通过。未更改 Rust 源码或 WASM 构建输入，直接验收已提交的真实 WASM 产物。

UI、代码与迁移说明见[AI识图](architecture/artwork-ocr.md)，本轮模型、资金、图片与状态证据见[脱敏记录](architecture/artwork-ocr-live-20261031.json)。

## Ozon 货源动态字段保存与校验（2026-10-31）

本轮验证通过的范围是货源配置维护。保存通过不等于商品已在售。验收使用本地正常管理员会话、普通 API 数据库角色和独立的未公开验收库，未向 Seller 写商品。

货源配置经服务端 WASM op 21 调用 Rust 的共享字段校验，覆盖必填、字段类型、数量、字典 ID、尺寸正整数、条码和 URL。商品名称、媒体、售价等逐图字段在此处延后，由最终商品校验负责；币种保留必填，固定标签的 1–30 个俄语标签约束保留。PDF、视频等复杂组独立保存每个条目的值、稳定 ID 和顺序。新迁移保留旧平铺复杂字段，把旧配置标为待复核，清除旧校验摘要。

| 实际类目 | 类目 ID / 类型 ID | 页面可配置字段 | 保存、HTTP 回读、独立数据库比对 |
| --- | --- | ---: | --- |
| 音乐光盘 | 46590429 / 392547272 | 38 | 通过 |
| 数字油画 | 17028964 / 94897 | 44 | 通过 |
| T 恤 | 200000933 / 93244 | 58 | 通过 |
| 运动鞋 | 15621048 / 91248 | 58 | 通过 |
| 智能手机 | 15621050 / 95139 | 89 | 通过 |
| 笔记本电脑 | 17028619 / 91477 | 105 | 通过 |
| 宝石项链 | 17027899 / 971168976 | 46 | 通过 |
| 婴儿连体衣 | 92496473 / 504866284 | 31 | 通过 |

8 类目共 469 个可配置字段全部在真实 React 页面渲染，必填控件语义保留。每个配置均保存两条 PDF、两条视频及一条视频背景；回读值、条目 ID 和顺序一致。页面另完成第 3 条 PDF 的新增、保存、关闭重开和数据库比对，确认共享编辑器的 `ci_…` ID 可直接保存。

每个类目分别保存必填属性缺失、币种缺失、负数宽度、未确认字典 ID、第二条 PDF 非法 URL，40 次均保留输入并返回 `needs_reconfiguration`，错误字段与条目索引正确；修正后恢复 `valid`。过期 CAS revision 返回 409。字典真实调用官方 `/v1/description-category/attribute/values/search`，搜索 Nike 返回 40 项；选取首批 200 项之外的 ID 后，字典结果落库、配置校验和保存回读通过。页面亦完成真实搜索和选用。隔离 HTTP/PostgreSQL 回归覆盖匿名、错误字段、超限请求及畸形上游成功响应。

本地证据目录：[ozon-schema-fix](/Users/xxww/.codex/visualizations/2026/10/31/01a19013-bbe0-72f0-898c-aabe034b2aa1/ozon-schema-fix)。核心证据为 `live-save-results.json`、`negative-save-results.json`、`ui-eight-category-results.json`、`official-dictionary-proof.json`、`ui-new-third-item.json`；它们保存在验收机器，未随仓库分发。

验证边界：以上结果只覆盖这 8 个当日真实类目、已有字段规则及货源保存链路。未知必填字段类型会明确报错。Ozon 商品导入、审核和在售结果没有在本轮重验，仍受最终商品校验和 Seller 回读约束。

## 平台商品库公开展示与图片读取（2026-10-31）

本地「本地验收工厂」库及「数字油画 · 全链路验收」的 `P-C9E2CD320B86` 规格已公开。按原完整链路样本恢复 450×550×50 mm、600 g、RUB、零税率、无品牌和数字油画类型，正常保存与页面再次校验后配置 revision 为 16，状态 `valid`、`usable=true`，10 项字段问题清零。这些包装参数是验收条件，不是实际商品规格；其他未就绪商品和 `111` 规格仍未上架。

普通成员 `user@pod.com` 在 Test 工作空间通过真实页面和 `/api/supplier-dbs/catalog` 读到唯一公开规格。商品名称、编号、40×50 cm 规格、平台价 ¥20.00、运费 ¥0.00 与管理端一致。当前工作区商品库采用列表布局；详情、图集、尺码面板、刷新回读和 390px 窄屏均已核对。未填写的商品资料保留未知状态，没有用 Ozon 配置的验收值填充商品事实。

实际验收发现卖家缩略图仍只接本地测试账户，返回 `STORAGE_NOT_CONFIGURED`。现已接入管理员上传使用的 assets 账户，经统一 R2 客户端签名读取，保留公开引用检查、响应大小限制、取消和重定向限制。256、640、1280 三档图片分别返回 `200 image/jpeg`，浏览器解码成功；未被公开商品引用的图片返回 404。数据库回归覆盖隐藏库、下架商品、归档商品和下架规格，均在读取对象前拒绝。

本地证据：[product-publication](/Users/xxww/.codex/visualizations/2026/10/31/01a190db-7ad3-7c41-85ed-bfc72c5631d0/product-publication)，包括 `published-admin-readback.json`、`member-verification.json`、`member-refresh-mobile.json` 及普通成员页面截图。受影响 Go 测试、架构检查及全部 Go 包编译通过。此轮验证本地平台商品库公开展示，不代表向 Ozon 发布、审核或在售。

## 2026-10-31：团队邀请、商品导出与视图、上架策略、任务记录

本节是当日验收记录。其中「保存商品筛选视图」已从产品删除：页面不再提供「已保存视图」和「保存视图」，`/api/workspaces/products/views` 已撤下，表 `saved_product_views` 由迁移 `00023_drop_saved_product_views.sql` 删除。下面的视图记录只说明删除前的验收事实。

本轮补齐五项已有流程的运营能力。验证使用临时 PostgreSQL、普通 API/worker 登录角色和正常 React 页面；没有向真实 Seller 写商品、库存或价格。

- **团队邀请**：创建、接受、拒绝、撤销和站内通知已接通。私密凭据仅创建时返回，后续目录与通知不返回原始 token；邮箱、角色、期限、名额及并发接受在服务端校验。邀请可在注册前创建，注册后回填站内通知。没有发送邀请邮件。
- **按筛选全量 CSV**：商品页支持导出当前筛选下全部可见商品，保留已选导出。305 行跨页实际下载与内容回读通过；币种、快照时间、公式注入和长 SKU 保护有回归。超过 50,000 行或 64 MiB 返回 413，不返回部分文件。本轮没有加入 XLSX 或表格导入。
- **保存商品筛选视图（已删除）**：删除前，店铺、状态、关键词在服务端持久化，按工作空间和当前用户隔离。当时支持应用、保存、重命名、删除，每人每工作空间最多 30 个。独立数据库回读、同组织其他用户和跨组织拒绝、重复名称及坏输入回归曾通过。
- **店铺上架策略**：店铺操作中的“上架策略”维护每日商品数上限和最小请求发送间隔，默认不限制。每日按北京时间重置；计数来自实际 import 发送账本，未知发送保守计入，明确未发送不计入。同批商品共同发送，超过剩余额度时原子拆批；等待保留原因与下次时间，不消耗错误重试次数。修改策略会唤醒本店等待任务。
- **跨店任务记录**：`?screen=task-records` 读取已有提交意图、素材任务和商品同步任务，可按可见店铺、任务类型与状态筛选，并打开原上架方案。排队任务的下次时间取实际承载 job；没有可核对次数时保留 null。平台已受理、执行完成与待核对分开展示，不据此声称商品在售。浏览器中的受理/未知样例来自临时库夹具，仅验证真实读取、权限和状态投影。

策略恢复回归复现“拆批事务已提交、发送准备前进程退出”之后的数据库状态，经正式租约回收、`ProbeDue`、领取和执行链验证：两个 scanner 只恢复一次；旧 worker 围栏拒绝；任何未知、已发放凭据或发送证据均不自动重发。没有实际终止运行中的真实 Seller 进程，也没有实际等待 24 小时；跨日验证只调整本测试记录的时间。

持久化由新增迁移 `00018_saved_product_views.sql` 和 `00019_store_listing_policies.sql` 提供。已有迁移、架构基线和 Rust/WASM 产物未因本轮改动重写。上架仍受已有能力准入、凭据与写入闸门约束；这些内部运营验证不扩大库存、促销、OGL、批量外部发布或真实在售的准入范围。

**页面验收**：桌面 1728px 与 390px 窄屏查看五项入口、表单及真实数据。商品视图完成保存、重命名、重新登录后应用和删除；实际 CSV 文件 26,712 字节、305 条记录，包含最后一条 `QA-305`。店铺策略从页面保存 10 件/日、5 秒间隔并 GET 回读一致；邀请从页面创建并在成员目录回读。任务记录的窄屏店铺合并进任务列，保留状态、查看与分页操作，时间仍可在详情读取。测试数据与图片保存在[本机验收目录](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/five-features)，不随仓库分发。临时验收库独立于现有开发数据库，验收后清理。

**现有开发库复验（同日）**：先保存 PostgreSQL 自定义格式备份，再将现有 `podhub-dev-pg` 从版本 17 迁移至 19，应用 `00018/00019`，没有重置数据库。通过正式开发脚本重启 `127.0.0.1:8080` API；`1420` 前端代理与 API 健康检查通过，API 使用普通数据库登录角色。两张新增表均启用并强制 RLS，最初重启没有操作另一条 `18080` 验收服务。

使用 `admin@pod.com`、`manager@pod.com`、`user@pod.com`、`platform-admin@pod.com` 的正常 Cookie 会话完成 100 项 HTTP 检查。邀请创建、站内通知、接受、拒绝、撤销、重放及角色拒绝通过；视图重命名、全新登录会话回读、同组织其他用户和跨组织拒绝、重名拒绝及删除通过。策略保存 7 件/日、5 秒间隔，HTTP 与独立 SQL 回读一致；负值拒绝且不改存储。未分配店铺的普通成员和跨工作空间账号不能读取、修改策略或导出该店铺。

浏览器实际下载当前筛选 CSV：页面单页 100 条，文件包含 301 条匹配商品，排除 4 条对照样例；公式货号已转义，19 位 SKU 完整保留。owner 与 manager 的同筛选 CSV 摘要一致。本轮现有开发库任务记录为 7 条真实媒体任务，分页无重复，6 条已处理、1 条已取消；manager 可读 7 条，普通成员不能读取他人的未绑定店铺任务，6 个原方案 GET 均成功。没有为任务记录伪造外部受理或在售结果。

用户授权后继续现有开发库页面验收。原浏览器会话消失、本地服务停止后，经授权重建验收会话，复用原数据库卷恢复服务，数据库仍为版本 19。页面完成视图创建、重命名、退出登录后从 `/admin` 重新登录、应用全部三个筛选条件和删除；策略保存 7 件/日、5 秒间隔，重开回读后从页面恢复默认；邀请表单创建、私密链接一次性确认、成员目录回读和确认撤销均通过。任务页面的状态、类型、店铺筛选和 390px 详情通过，可跳转至正确原方案。原靠枕套受控样例缺可用 PSD，页面如实提示；本轮只读核对，原行仍为 revision 2、`ready`、未提交，没有修改或重跑方案。

页面实下载发现已选 CSV 会丢弃 19 位 SKU：原商品镜像读 DTO 使用 JSON number，浏览器无法无损保留全部 int64。现已把工作空间及平台只读观察两条投影的 SKU 改为十进制字符串，从源 OpenAPI 重新生成 TypeScript 契约；列表、链接和已选 CSV 保留原值。原数字库存接口只转换正安全整数，超范围 SKU 不提供库存编辑。重启 API 后，正常本地登录会话实下载两条已选商品，普通 SKU 和 `1234567890123456789` 均完整，长标识和公式货号转义仍有效。1728px 与 390px 已查看，窄屏文档宽度为 390px，无页面横向溢出。

SKU 修复的 Go 受影响单元测试、架构检查、两项真实临时 PostgreSQL 回归、全部 Go 包编译、相关产品/观察前端测试、TypeScript、生产构建和 API 契约一致性检查通过。文案收尾另跑直接相关回归。没有在此轮重复全量 Go 和前端测试；此前全量结果与本轮受影响检查分开记录。

前轮 305 条及恢复页面验收新增的 3 条商品样例、验收状态字典、验收视图、新增成员及策略行均已清理，策略恢复默认，接收账号恢复原工作空间。最终仍为 8 个工作空间、7 个账号、7 个方案、6 个商品行和 49 个 job；商品镜像与提交意图恢复原先的 0 条。保留四条已处理邀请的历史、通知及审计，本轮新增验收通知已精确标记为已读。Seller 发送账本仍为 0，没有发送邀请邮件，也没有执行真实 Seller 提交、同步、库存或价格操作。

本机证据：[重启与迁移记录](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/local-api-acceptance/restart-migration-proof.json)、[邀请与视图隔离](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/local-api-acceptance/invitation-runtime.json)、[策略与 CSV 权限](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/local-api-acceptance/policy-permissions-runtime.json)、[持久化与任务分页](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/local-api-acceptance/remaining-runtime.json)、[清理回读](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/local-api-acceptance/cleanup-proof.json)。

补充证据：[现有开发库页面流程](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/local-api-acceptance/ui-runtime.json)、[SKU 修复及检查](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/local-api-acceptance/sku-fix-proof.json)、[页面验收清理回读](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/local-api-acceptance/ui-cleanup-proof.json)。

## 系统 R2 环境配置与控制台清理实测（2026-10-31）

正常开发 API 与 React 已重启，保留原数据库持久卷，健康检查 200。系统存储分别读取 `R2_ASSETS_*`、`R2_PRIVATE_*`，本轮真实连接的桶为 `podhub-test-supplier` 与 `podhub-test-delegate`，没有使用存储替身。

两个桶均完成实际 PUT 200、重复 PUT 拒绝 412、签名 GET 200 与完整 SHA-256 比对、精确前缀列举 200、DELETE 204、删除后 HEAD 404 和空前缀回查。素材库公开 URL 回读 200；私有桶无公开域名，匿名 S3 请求返回 400，XML 为 `InvalidArgument / Authorization`，确认是缺少鉴权的拒绝。两轮实测产生的精确对象均已删除，未修改其他桶对象。

真实控制台不再提供平台素材库或私有 R2 配置入口，个人切片 R2 设置保留且 GET 200。后台配置只返回 AI 相关字段；四种旧存储字段的写入均为 400，配置 revision 和 AI 账号数量保持不变。两个系统桶的后台统计接口均为 200，审计记录已在开发数据库回读。

实测修复后台存储统计的审计权限问题：普通 NOINHERIT 数据库登录直接插入 `audit_logs` 会返回 500，现改用 `db.Staff()` 事务。新增正常 API 角色下的统计、审计持久化及连接角色复位回归。受影响服务、架构、正常数据库角色及计费快照回归通过，全部 Go 包和测试包编译通过；旧 AI 实测脚本同步改为读取服务端 R2 环境配置。本轮未调用付费模型或 Seller 发布，也未验证生产桶。

脱敏证据：[系统 R2 与正常服务实测报告](/Users/xxww/.codex/visualizations/2026/10/31/01a1920a-0ffc-72c2-8357-6004cf5f437b/r2-live/report.json)。服务继续运行于 `http://127.0.0.1:1420` / `http://127.0.0.1:8080`。


## Ozon 商品促销管理（2026-10-31）

入口位于「Ozon 商品」工具栏，保留勾选商品的批量入口和单商品详情。当前店铺可直接读取活动目录，以及按 100 件分页的已参加/可参加商品；无需先同步本地商品镜像。展示真实名称、货号、完整 SKU、售价及币种、活动价、实际活动上限、承诺库存和加入来源。未知数量不显示为零。冻结活动只读。

产品写入口只放行本轮真实验证的 `ELASTIC_BOOSTING`。其他活动类型可读取，`PROMOCODE`、`STOCK_DISCOUNT` 的协议与隔离测试不计为其真实外部写入通过。加入、成员改价和退出均明确预览统一售价的变动；金额以十进制字符串和币种传输，不自动压低至活动上限，不做隐式汇率换算。

### 真实三次写入与原状恢复

用户明确批准 LUAN4 的零库存测试商品 `TEST-20261010-JELLY01` / product `6572728397`，只针对活动 `1977747`：55.80 CNY 加入、55.79 CNY 成员改价、60.00 CNY 退出恢复。基线独立读取证明未参加、售价 60.00 CNY、上限 55.81 CNY、`has_stock=false`，各库存和预留数量均明确为零；原划线价/最低价为零，自动促销标志已保存。

真实 cookie 来自本地 `admin@pod.com` 正常登录。受控 TLS 服务复用正式 Ops HTTP 挂载、鉴权、AppRole 租户事务、v2 凭据、普通 `podhub_login_api`（NOINHERIT/NOSUPERUSER/NOBYPASSRLS）和专用官方 HTTPS 出口。写出口只接受已审阅的三个逐字节请求，发送前排他持久化并 fsync 预算；`httptrace.WroteRequest` 独立计数为 **3**。正常本地 API 始终保持 `OZON_WRITE_KILL_SWITCH=1`，没有开放其他商品或全局 Seller 写入。

第一笔报名返回明确 active ID，但平台读模型短暂不一致，服务如实持久化 Unknown；独立读回目标已参加且价格 55.80 CNY，正常只读 Reconcile 转为 reconciled。第二笔的首次本地请求在读取预检阶段遇到候选计数不一致，settled 502，零 Seller 派发。确认该已决拒绝后，仅更换本地操作键，继续消费原预算的第二个精确请求；不是重复报名，也没有新增外部写预算。成员改价正常返回 200，独立回读 55.79 CNY；同键回放没有新增 Seller 请求。

第三笔退出返回 deactivated ID 和相应提示。即时核对仍有短暂不一致，保留 Unknown；后续只读核对证明完整参与列表中已缺席、卡片统一价格为 60 CNY，再由正常 Reconcile 收敛。最终独立官方 info、prices、stocks 与原基线比较通过：恢复未参加和 60.00 CNY，库存/预留仍为零，划线价、最低价和自动促销设置均未改变。三个允许的物理请求预算已全部消费，不得复跑该验收。

- [原始计划及三个精确请求](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/promotions-management/planned-writes.json)、[用户授权记录](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/promotions-management/approved-plan.json)、[已消费预算](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/promotions-management/write-budget.jsonl)。
- [真实写入与普通角色账本](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/promotions-management/live-write-proof.json)、[最终官方状态](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/promotions-management/final-official-state.json)。临时验收源程序保存在同目录，已从项目源码移除。

### 分页、失败与权限

实际 Ozon 末页仍会返回 last_id；完整扫描按稳定 total 和唯一商品数判断完成，不能仅凭短页终止。真实报名后，参与列表为 108/108，但候选实际 54 条而 total 仍为 55，后续为空且游标不变。管理分页保留真实总数，不伪报完整；已找到的完整目标行可证明目标资格，已参加商品的改价不再依赖无关候选统计。未找到目标或需要证明退出缺席时仍须完整读取；重复页、循环或缺页保留失败/Unknown。

逐项 ACK 必须覆盖全部请求身份，成功项还要独立核对成员状态与统一价格。Unknown、未决派发和同商品普通改价共用持久目标锁，新操作 ID 或其他活动不能绕过。前端分块部分成功时保留后块 Unknown 的提示和核实操作；核实接口 HTTP 200 仍需检查本次 outcome，不把 still_unknown、skipped、conflict 当作成功，也不自动重发。

本地真实账号复核：Test 所有者和 manager 读取成功；未分配店铺的 member、其他工作空间的平台管理员均 404；匿名为空商品选择也必须 401。隔离 PostgreSQL 普通角色测试另覆盖跨租户、未知持久化、成功/拒绝回放、跨活动/普通价格目标互斥与并发竞争。证据见 [角色读取](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/promotions-management/local-role-read-proof.json)、[协议、回核和持久化](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/promotions-management/promotion-read-confirm-proof.json)、[目标正证据回归](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/promotions-management/promotion-target-evidence-fix-proof.json)。

准入仅覆盖上述弹性促销管理构件，不证明商品在售、库存写入、所有促销类型、自动营销策略或生产部署。没有新增数据库迁移，也没有修改 Rust/WASM 输入与产物。

最终应用页面验收：桌面完整加载 107 件参与商品，390px 窄屏无页面溢出；活动选择、确认后售价与上限错误可见，超过上限确认禁用，返回商品列表正常。候选55条/平台total56的尾页失败保留原行，重新读取可恢复页面且不假报完整。49项相关前端测试、TypeScript与构建、OpenAPI生成一致性、修改前端文件lint、受影响Go/架构测试和全部Go包编译通过。浏览器夹具另外验证101件分块中前块成功/后块Unknown时保留对话框，以及HTTP200的still_unknown必须继续保持未知；夹具不作为外部能力证据。汇总及截图见[验收记录](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/promotions-management/acceptance-proof.json)。

退出后立即采样的 v5 `marketing_seller_price` 曾短暂保留55.79和旧活动条目；后续仅执行只读复查，营销价已回到60且actions为空。该次复查完整参与列表107/107中目标缺席，info售价60.00CNY、has_stock=false且各库存/预留为0；v5 price对象全部字段与原基线相等。最终收敛证据见[官方完整复查](/Users/xxww/.codex/visualizations/2026/10/31/01a190dd-8d76-7630-8ed7-58a42fdb0af1/promotions-management/final-official-verified.json)。没有额外Seller写入。

## 2026-11-02：数字油画 Go 真实上架与图片回读

本轮修复与运行目标是 `podhub-go`。输入为用户 `0605/数字油画-贴图/SZ-9BXIE0605-0001.jpg`（SHA-256 `1477a6fca6706f73470535a0a2340227920bdb7f63589448b6708dfe857d54ca`）及指定 `数字油画 PSD.psd`（93,243,996 字节，SHA-256 `22990c6e485e6b607e6f12a9917b5f09d20d502a342159235fd0150c79f05fb8`）。店铺以 Client-Id `4877007` 核对；本地名称为 LUAN4。原货号已存在且归档，本轮保留原商品、价格和库存，使用独立零库存测试货号。

Chrome 真实 React 页面完成本机 PSD 绑定、图片导入、真实 AI 识别、WASM 切片、R2 上传、服务端摘要确认和正常 HTTP 提交。Go 方案 `7b10e602-e1f4-4e88-9f65-7f0663e7a832` 产生 9 张切片；独立公网 GET 与 SHA-256 比对通过。发现并修复 Caddy 缺少渲染隔离响应头、供货配置错误投影系统媒体组、行校验与提交冻结丢失已确认词典搜索材料、构建待更新行无法启动正常冻结发送四处阻塞。

较早的托管站复现创建了 `PH-TEST-20261102-0605-0001`，task `5947231814`；它只计为托管站证据，不计为 Go 验证。随后 Go 新货号 `PH-GO-20261102-0605-0001` 的 task `5947461064` 被平台以 `SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT` 拒绝，重复对象正是上述测试商品。平台任务仍返回 `status=imported` 并附 `level=error`。现已修复 scanner 和 Intent/行投影对这种响应的处理；保留已受理历史、持久化拒绝证据，Chrome 刷新后显示「受理后未通过」，不允许自动重发。

最终 Go 使用同一测试货号 `PH-TEST-20261102-0605-0001` 更新已创建的测试商品，避免再建重复卡片。正常队列 job `77816cf7-f123-4f7f-9419-b781fc81a782`、intent `d650e510-0ff7-431a-a370-05c0683f7fc1` 实际派发一次，平台 task `5947512494`。官方独立回读确认 product `6824084999`、SKU `6212731209`、`is_created=true`、`moderate_status=approved`、`validation_status=success`、`errors=[]`；Go 新上传的原始链接经历平台处理后，主图及 8 张附图全部转为 `ir-20.ozone.ru`。售价 60.00 CNY、`has_stock=false`。正常只读 scanner 已持久化相同 product/SKU，不据此宣称在售。

本轮没有复现用户截图中的图片下载失败，不能据此声称已修复其原始根因。R2 公网探测中，Python 默认 UA 曾返回 Cloudflare 1010，而 curl/Go 请求成功；这只是客户端差异观察，不等于已识别原事故原因，未修改 Cloudflare 防护。Ozon 买家页在 Chrome 出现验证码，未完成该页访问；平台结果以上述官方 API 回读为准。worker 日志另有上架计费读取 `jobs` 的权限错误，未纳入本轮修复，不计为计费链路通过。

受影响 Go 与架构测试 261 项通过，真实临时 PostgreSQL 的行保存/词典材料回归 3 项通过，全部 Go 包编译及 API/web 镜像构建通过；Caddy 实际返回两项隔离响应头。没有修改 Rust/WASM 输入、架构基线或数据库迁移。正常本地 API、listing/reconcile worker 和 web 已重建，全部 Seller 写入闸门恢复关闭；保留验收数据，没有执行 60 张整批、库存写入或生产部署。

本机证据：[验收汇总](/Users/xxww/.codex/visualizations/2026/11/02/01a19a3a-ccfb-74e1-b782-294b8e10a709/painting-live/verification.json)、[Go 更新后的官方商品结果](/Users/xxww/.codex/visualizations/2026/11/02/01a19a3a-ccfb-74e1-b782-294b8e10a709/painting-live/go-update-offer-current.json)、[Chrome 回执截图](/Users/xxww/.codex/visualizations/2026/11/02/01a19a3a-ccfb-74e1-b782-294b8e10a709/painting-live/go-final.png)。

## 2026-11-02：上架计费普通 worker 权限修复

前节发现的 `permission denied for table jobs` 已完成本地修复。原计费路径只设置组织 GUC，没有从 NOINHERIT 登录切换事务角色；失败退款还调用了 worker 无权进入的维护角色。现在任务读取、回执标记、扣费及退款均通过 `tenantx.EnterApp` 进入目标工作空间。预留清理仍用维护角色扫描候选，随后按候选组织进入租户事务锁定和释放；没有新增数据库授权或迁移。

新增正常 `podhub_login_listing_worker` 密码连接回归，修改前稳定复现 SQLSTATE `42501`，修复后通过。真实隔离 PostgreSQL 验证 100 微分只扣一次、失败预留只释放一次、钱包从 10,000 变为 9,900 且预留归零、零费率不扣款、跨组织任务不可见；单连接复用后仍是 NOINHERIT/NOSUPERUSER/NOBYPASSRLS 登录，组织设置已清除，裸读 `jobs` 仍拒绝。原 API 维护清理与计费回归同时通过。

受影响包及架构测试 95 项、相关集成测试 29 项通过，全部 Go 包编译及应用镜像构建通过。本地 API、listing worker 和 `18080` 验收 API 已更新。使用当前开发库正常 worker 凭据，对上轮两笔已成功 job 再调用计费函数，均未报权限错误。当前费率未配置，实际为 0；余额、预留和这两笔任务的账本行数不变，没有重排或重发商品，也没有 Seller 调用。付费扣款与退款的证据来自隔离库，不算生产计费实测；本轮未部署生产。

本机证据：[计费权限验收汇总](/Users/xxww/.codex/visualizations/2026/11/02/01a19a3a-ccfb-74e1-b782-294b8e10a709/painting-live/billing-permission/verification.json)、[现有开发库普通 worker 复核](/Users/xxww/.codex/visualizations/2026/11/02/01a19a3a-ccfb-74e1-b782-294b8e10a709/painting-live/billing-permission/runtime.json)。

## 2026-11-02：工作空间 R2 自动创建与可视化管理（外部链路待验证）

本节记录 2026-11-02 的验收状态；2026-11-03 的真实 Cloudflare 验收结果见本文件末尾。

切片存储从个人配置迁移为工作空间共享配置；只有所有者可连接 Cloudflare、自动创建、删除对象或清理切片。一个空间一个有效桶，同一物理桶不能成为两个空间的有效配置。移除手工桶/密钥表单和个人接口，上传与发送前检查及清理均改用当前空间。设置新增实际 React 存储桶管理页面，支持路径分页、对象详情/预览、下载、选择删除和实际容量统计；保留注册 Cloudflare、开通 R2、付款方式与价格的官方链接，无 GIF。

隔离 PostgreSQL 已完成 00031 迁移、成员共享与跨空间隔离、数据库所有者写约束、物理桶唯一性、候选凭据加密落库，以及 HTTP OAuth 回调到建桶、失败验证恢复和未知令牌结果停止重试的回归。HTTP 上游和探针在这组创建流程测试中被替换，不能作为真实 Cloudflare 证据。媒体普通 API、上架媒体准备和上传确认相关回归通过。OAuth 本地测试含 PKCE、空间/用户/会话隔离、到期篡改、CSRF；R2 列举测试拒绝跨前缀及坏游标，下载/删除接口测试覆盖成员只读及未过期 PUT 防护。已通过相关 Go/架构测试、全部 Go 编译、前端类型与构建及 API 生成一致性检查。

浏览器验收使用生产组件与隔离接口夹具，检查桌面和 390px 窄屏、详情、删除确认、空状态、普通成员无管理按钮以及未注册应用时的注册/付款引导。浏览器验收不是 Cloudflare 实测。未修改共享开发数据库或重启服务。

验证状态：本地构件已验证；外部链路待验证。用户确认尚未注册本系统的 Cloudflare OAuth 应用，真实授权、自动建桶、桶级凭据签发及回读没有执行；真实外部测试保持 opt-in 并跳过。缺少 OAuth 配置时不显示可用的连接或创建按钮。应用注册后仍需完成实际授权、创建、凭据签发、上传和公开/私有字节回读、列举、精确删除、撤销及失败处理验收，才可标记完整功能通过。配置及迁移说明见 [工作空间 R2](architecture/cloudflare-r2-provisioning.md)。

## 2026-11-02：工作空间存储桶本地运行接线修复

真实 Chrome 设置页出现“接口不存在”，原因是 8080 仍运行旧版 Go API，开发库停在迁移 29，而前端已使用工作空间存储接口。本地 API 启动脚本还只加载 `.env`，没有读取独立测试 OAuth 配置。现已按顺序加载 `.env` 和 `.env.local`，后者覆盖前者；服务端凭据不传入 Vite。README 已同步。

先将原开发库保存为受保护的 PostgreSQL 自定义格式备份，再通过正式 `dev.sh` 启动新版 API 和 Vite，应用 00030/00031 至版本 31，没有重置数据卷。迁移前后均为 8 个账号、11 个工作空间、1 条有效切片配置。旧个人桶配置已映射到所有者的 Test 工作空间。新接口在 8080 与 1420 代理下均返回正常未登录 401，已不再返回 404。

使用 Chrome 真实登录会话验收，工作空间设置成功显示原有 `podhub-test-slices` 测试桶，实际 R2 列举和容量统计返回 27 个对象、约 5.7 MB，并展示日期目录。证据为 [真实设置页截图](/Users/xxww/.codex/visualizations/2026/11/02/01a19b25-11b5-7ac3-98ad-ffdb33438cbd/r2-local-upgrade/workspace-storage-fixed.png)。启动脚本语法与本地覆盖加载校验、全部 Go 包编译、相关 Go/架构 131 项测试通过。

本轮只修复本地运行与读取链路。没有创建新桶、提交清理、删除对象或执行真实 OAuth 授权；媒体删除开关保持关闭，OAuth 自动建桶与凭据签发仍待独立验收。既有开发库备份保存在同目录的 `dev-before-workspace-r2-8d57b47e68404687b1c8326701baeade.dump`，权限为 0600。生产 Compose 服务未重启。

## 2026-11-02：存储桶文件夹递归删除（本地构件已验证）

实际 React 存储管理页增加所有者可见的文件夹删除按钮与递归删除确认框。确认后按每批最多 100 项执行，显示已删除数量，回读目录后继续；部分失败停止并显示已完成数量，列表与统计刷新，离开页面时停止后续请求。请求携带包含配置 UUID 的完整前缀，空间切换后的旧视图不能误删另一个空间的同名目录。删除总开关关闭时显示原因并禁用删除按钮；成员没有目录删除入口。

后端复用现有签名列举和精确批量删除，不支持删除整个 uploads 根目录，拒绝其他配置的前缀、非规范目录及未超过 16 分钟的上传。仍先退休租约再删除对象。修复同一租约已退休时再次写退休时间导致的不可逆约束错误，使部分删除失败后的重试可用。更新 OpenAPI、生成的前端类型及界面接口接线。

隔离 PostgreSQL 与回环 S3 服务验证 205 个对象分三批递归删除、兄弟与外部前缀保留、空目录重复删除、部分失败明确回执及重试、租约先退休、成员拒绝、活跃上传保护和关闭删除开关；race 测试通过。相关 Go/架构 170 项、前端相关测试、TypeScript、构建、API 生成一致性、全部 Go 包编译通过。Chrome 生产组件夹具验收两批完成、部分失败停止、16 分钟提示及成员无入口。[删除确认界面（隔离夹具）](/Users/xxww/.codex/visualizations/2026/11/02/01a19b25-11b5-7ac3-98ad-ffdb33438cbd/r2-folder-delete/folder-confirm-fixture.png)。

本轮没有向真实 Cloudflare 发送删除或清理请求。现有开发环境的删除开关保持关闭，真实目录删除链路尚待使用专用可丢弃数据验收；本地 PostgreSQL/回环 S3 和界面夹具结果不计作真实 R2 删除证据。

## 2026-11-02：存储桶文件夹与图片网格（界面与真实读取已验证）

实际 React 设置页替换表格为自适应文件夹和图片网格，参考 Nextcloud 的缩略图与面包屑交互，沿用项目 Nova 组件与语义主题。保留前缀搜索、上一级、目录回退、详情、下载、所有者选择与递归删除；缩略图固定比例、懒加载，失败时显示回退，不增加依赖或修改删除开关。

Chrome 真实 Test 工作空间逐级进入 R2 目录并读取 9 张切片，9 张图片均成功加载；总量仍为 27 个对象、约 5.7 MB。[真实图片网格](/Users/xxww/.codex/visualizations/2026/11/02/01a19b25-11b5-7ac3-98ad-ffdb33438cbd/r2-folder-grid/actual-image-grid.png)。隔离生产组件夹具验证键盘选择不会打开详情、详情预览与下载请求、目录删除确认与取消、成员无删除与选择入口、空状态、读取错误与重试入口，以及长名称和预览失败回退。375px 两列、812px 横屏四列，无页面横向溢出；浅色与深色主题检查通过，下载操作命中区为 44×44px。

实际设置页在保留图标侧栏的 375px 视口中仍为两列（112px × 2），页面宽度为 375px，无横向溢出；窄容器为删除按钮预留顶部位置。[真实手机文件夹网格](/Users/xxww/.codex/visualizations/2026/11/02/01a19b25-11b5-7ac3-98ad-ffdb33438cbd/r2-folder-grid/actual-mobile-folders.png)。

后续布局调整让文件浏览区填满设置面板剩余高度，分页并入底部，网格区域单独滚动，避免分页后出现整片闲置区域。Chrome 真实桌面页面不增加外层滚动；80 个目录的隔离夹具通过 Page Down 滚动文件区时，分页位置保持不变，375px 两列且分页可见。此次仅调整界面布局，前端构建与相关 4 项测试通过。[填满后的真实浏览区](/Users/xxww/.codex/visualizations/2026/11/02/01a19b25-11b5-7ac3-98ad-ffdb33438cbd/r2-browser-fill/actual-desktop.png)。

前端 TypeScript、生产构建与相关 4 项测试通过，设计扫描无发现。夹具中的样例图片与下载请求不代表真实云端写入；本轮未执行真实 R2 删除、清理或 OAuth 建桶，现有删除开关保持关闭。

## 2026-11-02：默认随机桶名与创建前自定义名称（本地构件已验证）

已授权的工作空间所有者可选填写桶名；留空不提交 `bucket` 字段，由后端生成 `podhub-<无连字符随机 UUID>`。前后端校验 3–63 个字符、小写 ASCII 字母、数字和连字符，首尾为字母或数字，拒绝中文、大写、空格和非法长度。名称开始创建后锁定，重试沿用已保存名称，配置激活后拒绝改名。

迁移 00032 保存自定义名称来源，并将保留名称的唯一范围改为 Cloudflare 账户与桶名。自定义名称在外部创建前持久化阻断检查点，未知结果不重复创建，也不接管已有桶；明确创建拒绝时只释放本地保留记录，同名冲突允许用户换名。隔离 PostgreSQL 与固定上游验证默认和自定义名称、验证失败恢复、同名冲突后换名、未知创建和凭据结果停止写入、创建中与激活后改名拒绝，以及不同账户同名和同账户冲突。Go/架构 131 项、流程 6 项、所有权及命名范围 2 项、前端 5 项测试、全部 Go 包编译、TypeScript、生产构建与 OpenAPI 一致性检查通过。

Chrome 生产组件夹具确认中文提示与提交禁用、自定义名称进入请求、留空采用随机名、创建中名称禁用，以及 375px 表单无横向溢出。[命名表单（隔离验收）](/Users/xxww/.codex/visualizations/2026/11/02/01a19b25-11b5-7ac3-98ad-ffdb33438cbd/r2-bucket-names/custom-name-fixture.png)。本地开发库已迁移至 32，原桶 `podhub-test-slices` 仍为 27 个对象、约 5.7 MB，删除开关保持关闭。没有执行真实 Cloudflare 建桶、改名、授权或对象删除；夹具与上游替身不计作外部链路通过。

## 2026-11-03：识图描述与五个画面标签（限定样例已通过）

共享识图契约升级为 `artwork-theme-v3`。清晰图使用同一次模型调用生成短主题、完整俄文画面描述和恰好 5 个不同的图片相关标签，再与固定标签合并、去重、过滤受限标签，总数最多 30 个。商品类型和确认属性仍由配置确定，不恢复已移除的独立固定描述。免费公式测试只预览标题和固定标签；旧主题回包保留账单，不能补造新结果。

三张真实数字油画原图经生产浏览器预处理、真实私有 R2 上传及服务端字节校验、正常 Cookie/标准数据库角色调用 `qwen3.7-flash`，均返回完整描述与 5 个标签；与 2 个固定标签组合为 7 个，回读与独立 PostgreSQL 查询一致。每次一条预占与一条结算，合计实扣 ¥0.00265920，重复读取不新增购买。正式任务的描述和组合标签落入商品字段、刷新及回执恢复由隔离数据库集成测试验证，没有额外向真实商品行发起正式付费任务。

Rust/WASM 重建、相关 Go 与架构测试、数据库集成测试、全包编译、相关前端 345 项测试、TypeScript 与生产构建通过。全量前端另有 18 项钱包表单、导航与 AppShell SSR 失败，未将全量检查标为通过。三张样例的内容验证和 390px 真实界面通过不代表所有图案、纯色/模糊图、远端部署或 Ozon 审核与在售状态通过。

详细边界及费用见[当前识图验收](architecture/artwork-ocr.md#2026-11-03画面描述与五个标签实测)，原始模型响应、图片摘要和账本计数见[真实夹具](../rust/crates/listing-core/tests/fixtures/ocr-qwen-live-20261103.json)。

## 2026-11-03：切片清理策略（本地构件已验证）

工作空间所有者可设置每天北京时间的清理时刻，或选择仅手动清理；默认 04:00。策略变更从下一个设定时间生效，运行中的自动清理释放租约后才能切换。删除仅限该配置的规范切片，早期实现以自动清理时间栅栏撤销旧批次；目前自动清理已改为下述抓图证据与引用判断，显式手动清理仍撤销旧批次。

隔离 PostgreSQL 验证设置持久化、所有者权限、手动模式不认领自动任务、修改时间不立即清理、切换后的下一次认领、运行中禁止切换，以及旧数据库的清理栅栏迁移。Go 媒体与提交测试、架构检查、全部 Go 包编译、前端测试与构建通过。隔离浏览器夹具验证手动和自动时间保存、成员只读、键盘操作、深色主题、失败提示及 375px 布局。

本轮未连接真实 R2 或执行真实对象删除；夹具不能证明外部链路通过。Cloudflare 桶自身的生命周期规则需另行核对。

## 2026-11-03：启用文件夹直接删除（本地构件已验证）

本地 API 启用删除开关，清理 worker 保持停止，工作空间所有者可在目录卡片上直接发起递归删除。自动清理和全量清理请求仍需要启动 worker 才能执行。显式关闭 `CLOUD_MEDIA_GC_DELETE` 时删除仍被禁止。

删除前检查最近一次上传授权或确认时间，包括尚未落桶的对象；重复签发上传链接会更新租约时间，授权与删除通过同一工作空间锁串行化。隔离 PostgreSQL 与回环 S3 验证旧批次重新授权、未落桶上传、并发授权、按键删除、跨前缀和成员隔离、205 项分批删除与部分失败重试。真实本地设置页的三个文件夹删除按钮已启用并打开确认框；浏览器夹具验证多批成功、部分失败停止及成员无入口。

本轮没有向真实 Cloudflare 提交删除；外部删除链路仍待使用专用可丢弃数据验证。升级前旧进程可能签发过未记录续签时间的链接，需在最后一个旧进程停止后等待 16 分钟，再删除最近四小时的上传；之后并发新上传仍可能在目录删除后出现。

验收期间，工作区的另一项改动将上传键改为扁平格式，并重启了本地 API；本机存量租约仍使用嵌套格式。当前代码不识别旧格式的目录对象，扁平化迁移完成前，不把存量目录删除标为通过。该并行改动后的跨工作空间确认回归返回 400，现有测试期望 409，复跑仍失败；授权仍被拒绝，但响应契约尚不一致。

## 2026-11-03：工作空间切片路径简化（本地构件已验证）

新切片使用 `podhub-slices/{配置 UUID}/uploads/{UTC 日期}/{批次毫秒}-{批次 UUID}/{SHA256}.{jpg|png}`。服务端签名与确认、前端上传和批次缓存、WASM 批次确认、发送前的工作空间租约检查、存储管理和清理均使用新形状。数据库媒体识别按配置 UUID 与摘要区分切片身份，保留引用写入与租约退休之间的并发栅栏；长期媒体原有形状继续由原规则识别。

隔离 PostgreSQL 与回环对象存储验证新路径上传、私有及公开回读、跨工作空间拒绝、错误公开域名拒绝、清理栅栏、退休对象不可重新引用、并发身份锁和目录分批删除。跨工作空间确认仍返回 409；对应上节未解决的响应差异已复核。相关 Go、架构测试和全部 Go 包编译通过，`make wasm` 完整重建通过；前端工作流与存储页面 1,502 项测试、类型检查及构建通过。桌面与 375px 浏览器夹具检查了日期、批次面包屑及图片网格。

本轮未向真实 R2 写入或删除对象，未部署应用或迁移共享数据库；外部链路待验证。旧形状对象及公开链接保留原位，新解析器和自动清理不再处理它们，旧切片需重新准备才能经新代码提交；须先核对在途任务和外部取图，再按清单单独清退。

## 2026-11-03：Cloudflare OAuth 与工作空间建桶（同账户真实链路已验证）

在独立的本地工作空间「Cloudflare OAuth 验收」中，已有 Cloudflare 账号通过私有 `PodHub Local` 客户端完成真实 OAuth 授权、PKCE 回调和账户读取。Cloudflare 将 `Account API Tokens Write` 放在默认关闭的敏感权限区，即使客户端配置为必需，实际授权时仍需主动打开；设置页已增加提示。

自动流程在 Cloudflare 创建 `podhub-23dc0e88bffe467bb916dfd8bd84733c`，配置公开地址与本地来源 CORS，并签发桶级凭据。首次 PUT 探针失败，原因未确认；配置保持未激活，重试复用同一桶和凭据。随后实际 PUT、CORS 预检、私有和公开字节回读、列举、精确删除及删除后回读均通过，配置才激活。另一次独立 PUT 返回 200、删除返回 204。真实撤销 OAuth 返回 204 后，连接状态变为未连接，桶配置回读和对象列举仍通过；验收桶保留，统计为 0 个对象和 0 字节。

真实拒绝授权曾返回原始 JSON。现将授权拒绝、状态无效和令牌兑换失败返回存储设置页并显示可重试提示；回调不回传上游错误或授权码。使用当前代码的独立本地 API 和真实 Cloudflare 授权页复验，点击 Cancel 后正确返回设置页、显示错误并清除地址片段；随后在真实页面重新授权，再通过「重新登录并授权」和「退出授权」完成撤销与重连，桶配置和对象列举保持可用。

生产 `PodHub` OAuth 客户端的回调、徽标和必需权限已配置；已添加发布者 DNS TXT 且经公共 DNS 回读，Cloudflare 已显示域名验证通过，并在用户确认后设为 Public。生产 0.0.2 已配置 OAuth 参数并部署本轮存储桶改动；API、数据库、写入租约、工作进程及旧站健康检查通过，数据库无新增迁移。未验证其他 Cloudflare 账户、生产公开客户端或真实权限不足场景，不将多租户外部链路标为全部通过。首次 PUT 失败的根因未确定，不能归因于 DNS 或 Cloudflare 凭据传播。配置细节见 [工作空间 R2](architecture/cloudflare-r2-provisioning.md)。


## 2026-11-03：切片去重复用与抓图后清理（本地构件已验证，外部链路待验证）

同一工作空间和存储修订内按摘要、扩展名及大小复用切片。已验证对象跨批次返回 ready，不再传字节；并发首传共用一个对象键和一次额度预占，仍需条件 PUT 和独立签名确认。不同物理批次可在一批中确认，授权仍绑定完整对象键、用户和工作空间。切换配置、退休及删除对象不会重新获得上传或提交权限。

冻结提交保存不可改写的切片 URL。Ozon 异步导入及商品回读之后，再用 `/v2/product/pictures/info` 核对同一商品、全部来源 URL 和空错误列表，按数据库时间记录抓图回执。任务受理和商品存在不作为抓图成功；缺项、错误、仅 CDN 回链、过期扫描租约均不能提交抓图证据。未知情况持续延后重读，不重发导入。

自动清理沿用每天北京时间的设置，只回收所有引用抓图已确认满 24 小时、使用租约过期且上传授权安全窗口已过的切片。待处理商品和任务、商品源图、供应商素材及长期媒体引用阻止回收；身份排他锁与锁后重查阻止并发引用穿透。查询失败停止清理，分页跳过受保护对象后继续，删除结果按原回执记录。迁移前的对象没有完整历史引用证据，保留供复用和手动核对；未用、失败或未知对象也不按年龄猜测可删。未做多账号轮换。

隔离 PostgreSQL 和回环 S3 验证上传、公开与私有字节回读、首传合并、跨批次复用与单次额度预占、租户隔离、冻结引用不可更改、抓图回执持久化、过期扫描拒绝、共享引用、24 小时窗口、旧对象保护、并发引用及退休后禁止引用。相关后端、架构和数据库迁移测试、全部 Go 包编译、前端媒体/准备/存储测试、TypeScript 和生产构建通过；混合物理批次确认与跨页保留测试也通过。

本轮没有应用共享数据库迁移、启用真实清理 worker、向真实 Ozon 写入测试商品或删除真实 R2 对象。新的 Ozon 抓图回读到 R2 删除整链未作真实验收，不能沿用前面的 OAuth 建桶结果宣称它已通过。上线前需应用 `00039_slice_reuse_cleanup.sql`，验证平台实际图片回执的来源 URL 语义，并运行 reconciler 与媒体清理 worker；Cloudflare 自身的生命周期规则仍需单独核对。
