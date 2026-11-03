# Ozon Seller 出站连接

2026-10-27 更新。本文区分通用回环出口、显式官方传输和本地连接池基准；浏览器 WASM 不在范围。实际外部验证及未通过项见 [技术验证清单](../precision-listing-verification.md)，不以本地基准代替正式链路验收。

## 出口边界

| 入口 | 目标与授权 | 实现 |
| --- | --- | --- |
| 通用 `seller.New().Port()` / `Egress.Call` | 仍只允许回环服务；配置官方地址不会放开通用出口 | `internal/seller/ozon/domain/origin.go`、`internal/platform/httpx/transport.go` |
| listing 绑定传输 | 按任务绑定组织、店铺和凭据修订；官方端仅允许商品 import 与两种结果读取；未绑定不能发送 | `internal/app/worker/transport.go`、`internal/seller/ozon/listing.go`、`internal/seller/ozon/official.go` |
| 业务只读 `SellerReadCall` | 已完成店铺准入的凭据，或受控平台类目凭据；仅允许既有业务使用的精确方法/路径 | `internal/seller/ozon/seller_read.go` |
| 显式官方诊断读取 | 调用者提供已授权的店铺范围；只读，不创建持久凭据 | `NewOfficialReader` |
| 店铺凭据 probe | 仅官方 `/v1/roles`，用于凭据入库前检查 | `internal/seller/ozon/credential_probe.go` |
| 商品改价 | 已有店铺准入后的专用 `/v1/product/import/prices` 调用；受写闸限制 | `internal/seller/ozon/product_price.go` |

不能再把“通用 Egress 只走回环”概括成“进程从不拨官方域名”。也不能把几个显式出口推导成全部 Seller API 已开放。

`ListingTransport` 使用组织事务打开持久店铺凭据；回环模式用于本地替身，官方模式转为固定路径的 `officialPort`。只读绑定不能写入，写入还受 `OZON_WRITE_KILL_SWITCH` 约束。

## 两套连接池

| 配置 | 回环 Seller：`httpx.Ozon` | 显式官方：`officialHTTPTransport` |
| --- | --- | --- |
| 地址 | `dialRestricted` 只接受回环 | 固定 `api-seller.ozon.ru:443`；直连 DNS 结果过滤非全局单播、私有、回环、链路本地和 `198.18.0.0/15` 基准测试 IP |
| Proxy | `nil` | 不读取环境代理；显式 SOCKS5h 路由在 `DialContext` 中建立隧道 |
| 重定向 | 返回 3xx，不跟随 | 返回 3xx，不跟随 |
| 空闲连接总数 / 每主机 | 128 / 128 | 16 / 16 |
| 空闲超时 | 90s | 90s |
| TLS 握手超时 | 10s | 10s |
| 响应头超时 | 30s | 20s |
| HTTP/2 | 显式尝试；明文回环仍为 HTTP/1.1 | 显式尝试 |
| 整体超时 | `OzonClient` 不自设，由调用者的 Client 或 context 限制 | 共享 Client 30s，加调用者 context |

官方传输仅构造固定官方 HTTPS URL，正文最多 8 MiB、响应最多 1 MiB；响应超限失败。`httpx.Ozon` 的通用读取辅助则可能排空尾部以复用连接，不能把这一行为套用到官方端的有界读取。

连接池不承担业务重试。Egress 的准入槽位和持久预算控制请求，unknown / accepted 的后续处理由意图账本和扫描器决定；网络不确定不能当作可安全重发。受理、队列完成与商品在售状态分别核对。

## 原优化的理由

早期 Seller 与 `httpx.Restricted` 共用配置，每主机默认只保留 2 个空闲连接，并发请求后容易重新建连。独立 `httpx.Ozon` 将回环 Seller 池调到 128，并补齐空闲、握手和响应头超时。`Restricted` 仍是独立传输，不能因 Seller 优化而放宽它的地址策略。

这项优化证明的是连接复用及本地延迟变化。官方传输后来采用自己的连接池参数，本地池的收益不能直接外推为官方链路吞吐量。

## 本地基准

`tests/bench/ozon_egress_bench_test.go` 的 `BenchmarkOzon*` 使用 Mode R，在 `httptest` 的 `https://127.0.0.1:` TLS 服务上发送 `POST /v3/product/info/list`。服务同时提供 h2 和 HTTP/1.1；客户端 Clone `httpx.Ozon` 并仅信任本地测试证书，不经过 `ResolveBaseURL`，不读取生产凭据。

- `accepts/req`：预热后新建 TCP 连接数 / 请求数。
- `tls/req`：TLS 握手次数 / 请求数。
- `p50/ms`、`p95/ms`：顺序一请求或并发八请求一轮的墙钟分位值。
- `TestRestrictedBaselineConcurrentConns` 保留旧池形状的对照，不能用于证明当前官方出口行为。

在仓库根目录运行：

```sh
go test -count=1 -timeout 60s ./tests/bench/ -run Test
go test -bench BenchmarkOzon -benchtime=500ms -count=1 -timeout 180s -run '^$' ./tests/bench/
```

本次文档清理未重跑基准或真实 Seller 请求。对比耗时应记录命令、提交、机器及结果，不复制无上下文的“当前性能”数字。

## 业务只读接线与验收

`SellerReadCall` 复用官方连接池、L1 预算和 L2 读取槽位。它不会把 `write=false` 当作任意路径的准入条件：只接受 `seller_read.go` 列出的精确方法/路径；写路径、查询后缀、绝对 URL、方法不匹配与不合法 JSON 在发送前拒绝。只有活动列表使用无正文的 `GET /v1/actions`，其余白名单是明确的 POST 读取。通用 `Call` / `Forward`、listing 的两种结果读取权限及原有写闸保持原边界。

应用的 ops 读取、Ozon 商品镜像与卖家信息、仓库读取、类目读取和 ratings worker 均显式接入该端口；打开店铺凭据的租户和成员校验仍由各自准入方执行。类目平台凭据由正常配置 HTTP 保存为密文。类目刷新通过装配层注入现有 `core.Shared.Snapshot`，以普通 API 数据库角色注册并核对 `listing_schema_revisions`；已有 `schema_revision` 的新鲜读取直接返回注册快照，不再每次重算。旧行首次读取时补写版本号和注册快照。类目当前表与字典检索也使用应用角色事务。

本轮正常角色回归覆盖：实时类目 HTTP、字段/截断字典读取、缓存持久化、第二次缓存回读、快照注册一致性，以及随后的正常 HTTP 新卡和新商品行创建。真实店铺验收读取 `17027906 / 91976 / ru` 得到 55 字段，缓存 29,550 字节，并完成原生快照注册；未写入 Seller 商品或订单。每日自动抓取、立即抓取入口和 WB 凭据流程仍未实现，不能据此宣称已通过。

接口定义核对来源为 [Ozon 官方 Seller 文档](https://docs.ozon.ru/api/seller/)，本轮通过官方文档索引核对业务方法。完整 swagger 在本机下载受到重定向/403 限制；外部权限、空集合和未实际触达的读取分别记录在 `/tmp/podhub-backend-qa-20261027/ozon-followup.json`，不把官方 200 空集合当作有业务数据的完整验收。

## 正式代理路由

`CLOUD_SELLER_EGRESS_ROUTES` 在配置加载时捕获，启动时校验，按逗号或空白排列最多八项 `socks5h://host:port`，可在末尾配置 `direct`。空配置使用直连；代理 URL 不接受凭据、路径、查询或片段。`seller.New(cfg)` 捕获同一配置，因此业务只读、凭据检查、listing 和改价的专用官方传输，以及 worker 均使用该路由。通用回环出口不因此扩大。

SOCKS5h 仅把固定官方域名与 443 交给代理远程解析；HTTP 层仍验证 HTTPS 主机、正常 TLS 证书及 SNI，不读取系统环境代理，不跟随重定向。直连仍执行上述公网地址过滤。托管模式通过 `CLOUD_SELLER_RELAY_DIR/config.json` 的内容和可选 `CLOUD_SELLER_RELAY_SWITCH_DIR/active` 就绪标记识别节点切换；停用或等待 sidecar 时跳过代理，错误配置失败关闭。连接池在配置或就绪标记变化后关闭旧空闲连接，活动请求可自行完成。Go 进程不负责启动 sing-box；部署方须在加载生成配置后更新就绪标记。

按配置顺序回退只发生在 `DialContext` 建立连接阶段，早于 TLS 和 HTTP 请求字节。底层 `RoundTrip` 只调用一次：已收到请求后的断连、响应超时、503、重定向或 TLS 失败都不会通过代理切换或直连重发。若拨号阶段使用了后续路由，最多五秒后建立的新连接重新尝试首选路由，避免正常代理恢复后长期留在回退池。Seller 写入未知状态仍交给既有意图账本处理，写闸保持原规则。

管理端 `Probe` 经指定代理真实访问固定 `/v1/roles`，使用五秒限制且不带店铺凭据。它不回退直连；2xx 或表明官方服务已可达的 401、403、404 为 `reachable=true`，其余错误为 false。这证明节点到目标的连接可用，店铺授权须由独立凭据检查确认。

本轮验收包括普通数据库角色的完整管理 HTTP 与 Seller 业务出口、SOCKS 远程解析、节点切换、超时、停用、直连拨号回退，以及商品 import 已被目标接收后丢失响应时仅发送一次。真实 sing-box REALITY 在 Docker 内部网络运行：A 可用、切换 B 并停止 A 后仍可读取；错误 UUID、公钥、停止和停用均失败。目标使用固定官方域名的隔离 TLS 替身，没有访问公网 Seller 或公共代理节点。临时容器、网络和凭据已清理；公网代理链路仍待实际节点验收。证据见本轮 `backend-completion-20261027/relay.json`。
