# Ozon Seller 出站连接

本文盘点 Go 服务端访问 Ozon Seller API 的出站 HTTP，并说明基准怎么跑。浏览器 wasm 不在范围。数字以 PR 描述里当次命令的输出为准，本文不抄一份会过期的计时。

进程不拨 `https://api-seller.ozon.ru`。`seller/domain.ResolveBaseURL` 只接受 `http` + 回环 + 显式端口 + 路径 `/`；其它字符串换成官方主机，随后在拨号前拒绝。压测只接受 Mode R（`internal/platform/loadmode`），基准只用 `127.0.0.1` 上的 TLS 模拟服务。

Seller 调用现在走 `httpx.Ozon`。下面「优化前」一节保留当时的 `Restricted` 形状，用来对照。AI 上游和 OTLP 仍用 `Restricted`。

## 共享传输（优化前）

当时所有 Seller 客户端都用 `httpx.Restricted` / `httpx.RestrictedClient`（`internal/platform/httpx/transport.go`）。`Restricted` 由 `sync.Once` 构造一次，进程内是同一个 `*http.Transport`。`Restricted` 的字段没有改，AI 上游和 OTLP 仍用它。

| 字段 | 当前值 | 含义 |
| --- | --- | --- |
| `Proxy` | `nil` | 不读 `HTTP_PROXY` / `HTTPS_PROXY` |
| `DialContext` | `dialRestricted` | 拨号前和连上之后都要求对端是回环，否则 `ErrNotLoopback` |
| `Dialer.Timeout` | 30s | 连接级拨号超时 |
| `Dialer.KeepAlive` | 30s | TCP keepalive |
| `MaxIdleConns` | 0 | 不限制全部主机的空闲连接总数 |
| `MaxIdleConnsPerHost` | 0 | 按 `http.DefaultMaxIdleConnsPerHost`（2）保留每个主机的空闲连接 |
| `IdleConnTimeout` | 0 | 空闲连接不因时间关闭 |
| `TLSHandshakeTimeout` | 0 | TLS 握手没有单独超时 |
| `ResponseHeaderTimeout` | 0 | 等响应头没有单独超时 |
| `ExpectContinueTimeout` | 0 | 请求不带 `Expect: 100-continue` 时正文立刻发出 |
| `ForceAttemptHTTP2` | false | 自定义 `DialContext` 下不会自动启用 HTTP/2 |

`RestrictedClient` 在这个 Transport 外面包一层 `traced`（每个请求一个客户端 span，不改请求头，不改响应体），`CheckRedirect` 返回 `http.ErrUseLastResponse`。3xx 的状态和正文交回调用方，不会请求下一个地址。

`http.Client` 不是进程里唯一的一个。当时 `seller.New` 每次调用都 `RestrictedClient()` 再把 `Timeout` 设为 30s。Transport 仍是上面那一个。下面两个包级变量各持有一个 Client，现在指向 `Ozon`，当时指向 `Restricted`：

- `internal/app/scans/accepted.go` 的 `infoListClient`
- `internal/app/delegate_edge.go` 的 `delegateSellerClient`

没有调用点在每次请求时 `new http.Client` 或 `new http.Transport`。

## 调用点

这些调用点的 Transport 已是 `httpx.Ozon`。下表的整体超时和响应体限额没有改。

| 域 | 位置 | Client | 整体超时 | 响应体 |
| --- | --- | --- | --- | --- |
| 类目直播读、listing 读探针 | `internal/app/app.go` `sellerPoster` → `Egress.Call`（`write=false`） | `seller.New` 一次 | Client 30s；调用方 ctx | `exchange`：最多 1MB，尾部排空 |
| 上架提交 | `internal/app/worker/worker.go` listing 角色 `seller.New` → `Egress.Port` 的 `Write` / `Read` | 同上，worker 启动时一次 | Client 30s | 同上 |
| 已接受扫描 `info/list` | `internal/app/scans/accepted.go` `postInfoList` | 包级 `infoListClient`，无 `Client.Timeout` | `readAccepted` 里 ctx 10s | 最多 1MB，尾部排空 |
| 对账扫描挂接 | `worker.go` reconcile 角色的 `seller.New`，HTTP 仍走上面的 `infoListClient` | 扫描本身不另建 Client | 同上 | 同上 |
| 仓库读 | `internal/app/wire_warehouse.go` `egressPoster` → `Egress.Call` | `seller.New` 一次 | Client 30s | `exchange` |
| 店铺 `/v1/seller/info` | `internal/app/wire_store.go` `sellerInfo` | `seller.New` 一次 | Client 30s | `exchange` |
| 评级同步 | `internal/app/worker/ratings.go` `postSellerInfo` → `Egress.Call` | `seller.New` 一次 | Client 30s | `exchange` |
| 委托 Seller 读 | `internal/app/delegate_edge.go` `postDelegateSeller` | 包级 `delegateSellerClient`，无 `Client.Timeout` | 函数内 ctx 30s | 3xx 仍当连接失败，正文排空后不返回；其它最多 1MB，尾部排空 |
| Seller 代理（含错误目录观察到的 import/info） | `internal/seller/upstream.go` `Forward` → `Egress.ForwardUpstream` | 与 ops/admin 共用的那次 `seller.New`（`wire_ops_admin_mcp.go`） | 代理 ctx 40s，Client 30s 更紧 | 正文全部读完再关闭 |
| ops / 运费 | 同一个 `Egress.Call` | 同上 | Client 30s；ops HTTP 层另有 120s，不改变 Client 30s | `exchange` |
| 错误码目录 | `internal/app/ozon_catalog.go` `observeImportInfo` | 不拨号 | 观察写入 ctx 2s，发生在响应已经写出之后 | 不读 Seller |

`exchange`、`postInfoList` 和 `ForwardUpstream` 经 `httpx.ReadLimit` 读取。限额大于 0 时返回的前缀与原来的 `LimitReader` 相同，尾部被读完后丢弃，连接可以回池。限额小于等于 0 时读完整文，代理这条路径用的是 0。排空失败不会替换已经成功读到的前缀。排空如果很慢，仍会计入这次请求的截止时间。委托读的 3xx 仍返回「redirect left loopback」，正文不作为成功载荷；`httpx.Discard` 只为了归还连接。

重试不在 HTTP 客户端里。一次 `Do` 就是一次往返。意图级重试是 `submission_intents` 上的状态和 `StampRetryRows` / `RequeueRetryable`，不在这次盘点的传输层。限速是 `seller/repo` 的 `Reserve` 和 `Egress` 的槽位（读 8、交互读 4、写 2、交互写 2），不在 `http.Transport`。写租约和 `OZON_WRITE_KILL_SWITCH` 在拨号之前返回。

## 不在这条路径上

这些客户端也出现在仓库里，但不是 Ozon Seller API，本次不改：

- AI 上游 `internal/ai/http/relay.go` 的 `defaultUpstreamClient`（同一个 `Restricted`，超时在它自己的 ctx）
- OTLP `internal/platform/observability/otlp.go`（`Restricted()`）
- 对象存储 `internal/platform/r2`
- 供应商拉图 `internal/supplier/repo/media.go`
- 模型探测 `internal/admin/http/catalogue.go`
- 缩略图 `internal/admin/observe/repo/fetch.go` 的 `http.DefaultClient`（只允许回环，不是 Seller API）

## 共享传输（优化后）

`httpx.Ozon` / `httpx.OzonClient` 与 `Restricted` 分开。拨号函数仍是 `dialRestricted`：回环检查、拨号超时 30s、TCP KeepAlive 30s。`Proxy` 仍是 nil。`CheckRedirect` 仍是 `UseLast`。外面仍是 `traced`。`OzonClient` 不设置 `Client.Timeout`。`seller.New` 仍把整体超时设为 30s。`readAccepted` 的 10s、`postDelegateSeller` 的 30s、代理 ctx 的 40s、ops HTTP 层的 120s 都没有改。

| 字段 | 优化后 | 相对优化前 |
| --- | --- | --- |
| `MaxIdleConns` | 128 | 原来是 0（不限制总数）。一个进程里可以有多份 Egress，每份仍受槽位限制 |
| `MaxIdleConnsPerHost` | 128 | 原来按 `DefaultMaxIdleConnsPerHost`（2） |
| `MaxConnsPerHost` | 0 | 不限制在途连接，避免在槽位之外再排队 |
| `IdleConnTimeout` | 90s | 新设置。只关闭空闲连接，不改变单次请求的整体超时 |
| `TLSHandshakeTimeout` | 10s | 新设置。握手超过 10s 失败，即使 `Client.Timeout` 是 30s |
| `ResponseHeaderTimeout` | 30s | 新设置。与现有最长整体超时相同，不缩短 30s 客户端超时，也不缩短 10s 和 30s 的 ctx。原先没有截止时间的调用（测试里用 `context.Background` 的 info/list 和委托读）现在最多等 30s 响应头 |
| `ExpectContinueTimeout` | 1s | 新设置。Seller 请求不带 `Expect`，正文仍立刻发出，线上字节不变 |
| `ForceAttemptHTTP2` | true | 明文 `http` 回环仍是 HTTP/1.1。对端提供 `h2` 时走 HTTP/2。方法、路径、`Content-Type`、`Client-Id`、`Api-Key`、正文不变 |

生产的 `Egress` 只拨 `http` 回环，所以生产路径是 HTTP/1.1，收益来自空闲池。基准服务器同时提供 `h2` 和 `http/1.1`，优化后的客户端会协商 HTTP/2。`TestRestrictedBaselineConcurrentConns` 仍测量 `Restricted`。

## 基线基准

`tests/bench` 不进 API 和 worker。`BenchmarkOzon*` 先调用 `loadmode.Run("R")`，再对 `httptest` 的 TLS 服务发 `POST /v3/product/info/list`。服务地址必须以 `https://127.0.0.1:` 开头。模拟服务同时声明 `h2` 和 `http/1.1`。`ozonTransport` 返回 `httpx.Ozon`，因此客户端提供 `h2` 和 `http/1.1`。延迟写在服务端 handler 里，基准分别用 0 和 1ms。优化前的同一条命令测的是 `Restricted`，当时客户端只提供 `http/1.1`。

客户端形状与 `seller.Egress.New` 相同：整体超时 30s、不跟随重定向、`Proxy` 为 nil。为了完成本地证书的 TLS 握手，基准 `Clone` 传输并只信任该模拟服务的证书。Clone 不带走空闲连接池，测的是同一套 Transport 字段。生产的 `Egress` 仍只拨 `http` 回环，这个基准不经过 `ResolveBaseURL`，也不读 `CLOUD_SELLER_BASE_URL`。

计数：

- `accepts/req`：模拟服务 `ConnState == StateNew`，即新建的 TCP 连接，除以请求数。计时前有一轮预热，预热的连接不计入。
- `tls/req`：`httptrace.TLSHandshakeStart`，除以请求数。
- `p50/ms`、`p95/ms`：每一轮（顺序 1 次，或并发 8 个店铺）的墙钟，在该轮样本上取分位。

`TestRestrictedBaselineConcurrentConns` 用同一套服务。8 次顺序请求是 1 次接受和 1 次握手。两轮各 8 个并发店铺、中间空出 30ms 让空闲连接入池之后，接受数高于 8 且不超过 16：第一轮每个在途请求一条连接，空闲池只留 2 条，第二轮要再握手。

```text
go test -count=1 -timeout 60s ./tests/bench/ -run Test
go test -bench 'BenchmarkOzon' -benchtime=500ms -count=1 -timeout 180s -run '^$' ./tests/bench/
```
