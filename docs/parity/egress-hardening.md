# H1 出站加固

R4 第 5 项。用户在 2026-10-17 回复「好」，授权实现。不改 AGPL / LICENSE、切换计划和员工 GUC。不改迁移。`OZON_WRITE_KILL_SWITCH` 与 `CLOUD_MEDIA_GC_DELETE` 的解析函数没有动，仍只有 `internal/platform/config` 一处。

合法回环 mock 返回 2xx 时，请求字节、响应字节、状态机和重试语义不变。收掉的是三条缝：跟随 307/308、走 `HTTP_PROXY` / `HTTPS_PROXY`、拨号目标不是回环。

## 做了什么

1. **受限出站客户端** `httpx.Restricted` / `httpx.RestrictedClient`。`Transport.Proxy` 为 nil，不读环境代理。`CheckRedirect` 返回 `http.ErrUseLastResponse`，调用方仍拿到 3xx 的状态和正文，下一个地址不会被请求。拨号前拒绝非回环主机；连上之后若对端地址不是回环，关掉连接并返回 `ErrNotLoopback`。拨号超时 30 秒，与原来的默认传输相同。

   改用它的路径：Seller `Egress`、AI `HTTPUpstream`（`internal/ai/http/relay.go`）、已接受扫描 `postInfoList`、委托 Seller 读 `postDelegateSeller`。这四处不再使用 `httpx.Plain()`。

2. **AI 模型探测默认不拨公网。** 新开关 `CLOUD_AI_EGRESS_ALLOW_PUBLIC` 只在 `config.Load` 解析，只有去掉空白后正好是 `1` 才打开，未设置和其它值都是关。关闭时，公网 IP、公网主机名和私网 IP 都在拨号前返回与「回环未被允许」相同的 `dns refused`（`Fetch` 的第三个返回值仍为 true）。服务层因此仍是 `400 VALIDATION`，正文「接口地址不是允许的公网 https 端点」。不解析公网主机名，也不对它拨号。`CLOUD_AI_EGRESS_ALLOW_LOOPBACK=1` 时，回环 mock 仍可探测。两个开关都不走 `isTruthy`，不碰杀开关和删除开关。

3. **`CLOUD_SELLER_BASE_URL` 并入 `config.Load`。** `Config.SellerBaseURL()` 是去掉空白后的原文字符串，只在 `Load` 时读一次。`seller/domain.ResolveBaseURL` 仍按原来的回环规则处理：不是 `http` + 回环 + 显式端口 + 路径 `/` + 无用户信息、查询和片段，就换成 `https://api-seller.ozon.ru`，随后拒绝拨号。`Egress`、已接受扫描和委托读都用这次捕获的值，不再各自 `os.Getenv`。

## 改了哪个流程，结果为什么不变

| 流程 | 改了什么 | 为什么结果不变 |
| --- | --- | --- |
| Seller `Read` / `Forward`，杀开关打开 | 客户端从默认传输换成受限客户端。写仍在拨号前返回 `ErrWritesDisabled`，`WritePosts` 仍是 0 | 回环 mock 返回 200 时，方法、路径、查询、`Content-Type`、`Client-Id`、`Api-Key`、正文和响应字节与旧的默认客户端对同一 mock 的输出相同。`TestKillSwitchReadForwardMatchesOldClient` |
| Seller 写、AI 补全、已接受扫描、委托读的 2xx 回环 | 同上，只换客户端 | 2xx 没有重定向可跟随，代理函数为 nil 时回环请求直接拨到 mock。响应状态和正文与 `httpx.Plain()` 打同一个 mock 相同。重试循环、槽位和账本代码没有改 |
| 307 / 308 | 不再跟随。第二个回环 mock 收到 0 个请求，因此不会带上 `Client-Id`、`Api-Key`、`Authorization` | 这是要堵的缝。Seller `Read` / `Forward` 和 AI `Complete`、已接受扫描把第一个响应的状态和正文交回去（`ErrUseLastResponse`）。委托读保持原来的失败语义：3xx 是 `connect` / `redirect left loopback`，状态 0，正文不作为成功的 Seller JSON。以前最多跟随 3 次仍在回环上的重定向，现在也不跟随 |
| `HTTP_PROXY` | 受限传输不咨询代理。计数 mock 在控制请求之后不再增加 | Go 1.27 对回环目标本来就会跳过环境代理；公网目标和「传输上显式设置了代理」仍会打到代理。受限拨号在公网主机上直接 `ErrNotLoopback`，代理计数不变 |
| AI 探测 | 默认拒绝公网。回环仍要 `CLOUD_AI_EGRESS_ALLOW_LOOPBACK=1` | 已有回环用例仍返回模型列表字节，302 仍不跟随。公网拒绝与回环被拒绝是同一个 `dns refused`，服务层句子不变 |
| `CLOUD_SELLER_BASE_URL` | 读取点从每次调用改到 `Load` | 同一个字符串的接受或替换结果不变。非回环仍是官方域且不拨号。进程起来之后再改环境变量不会改已经捕获的值，与杀开关相同 |

不在本次：对象存储删除、RelayKit 许可、影子流量、员工 GUC、写租约。

## 如何验证

本环境没有 Docker，`PODHUB_PARITY_DSN` 未设置。下面的包测试不连库。集成测试在没有这两样时跳过；CI 有 Docker，会跑 `tests/integration`，其中 `TestGap` 的已接受扫描仍打回环 mock。

```text
gofmt -l internal/platform/httpx internal/platform/config internal/seller internal/ai/http internal/app internal/admin tests/archtest
go test -count=1 -timeout 120s \
  ./internal/platform/httpx/ ./internal/platform/config/ \
  ./internal/seller/ ./internal/seller/domain/ \
  ./internal/ai/http/ ./internal/app/scans/ ./internal/app/ \
  ./internal/admin/http/ ./internal/admin/service/ ./tests/archtest/
```

2026-10-17 在本机的结果：`gofmt -l` 为空，`go build ./...` 通过。上述 `go test` 全部 `ok`（`httpx`、`config`、`seller`、`seller/domain`、`ai/http`、`app/scans`、`admin/http`、`admin/service`、`archtest`、`app`）。

`go test -count=1 -timeout 25m ./...` 里，本次改过的包和 `tests/integration`、`tests/parity` 都是 `ok`。三处失败与这次改动无关，是本机没有 Docker、也没有 `postgres` 可执行文件：`internal/listing/read/http`（`exec: "postgres"`）、`internal/listing/submit` 与 `internal/queue/repo`（`docker daemon is not available`）。CI 有 Docker，这三处会真正跑库。

覆盖的断言：

- 回环 mock 返回 307 和 308，`Location` 指向第二个回环 mock。第二个 mock 的请求数是 0，没有 `Client-Id` / `Api-Key` / `Authorization`。
- `HTTP_PROXY` 指向计数 mock。控制请求（传输上显式设置该代理，目标 `http://example.com`，代理自己返回 599，不转发出去）计 1。随后的 Seller / AI / 扫描 / 委托请求不再增加。
- 杀开关为 `1` 时 `Write` 是 `ErrWritesDisabled` 且写计数为 0；`Read` 和 `Forward` 的状态与正文等于旧默认客户端对同一 200 mock 的输出。
- 未设置 `CLOUD_AI_EGRESS_ALLOW_PUBLIC` 时，`Fetch("https://1.2.3.4/models")`、`Fetch("https://example.com/models")`、`Fetch("https://10.1.1.1/models")` 与「回环开关关闭时的回环 URL」一样，`dns refused` 为 true，且回环服务器没有收到连接。
- `CLOUD_AI_EGRESS_ALLOW_PUBLIC=1` 不改变杀开关和删除开关。`1` 以外的值保持关闭。
- 非回环的 `CLOUD_SELLER_BASE_URL` 仍解析成官方域；`Load` 之后再改环境变量，已捕获的值不变。

## 需要用户决定

1. 公网模型探测何时打开。本 PR 默认关。要探测真实供应商时把 `CLOUD_AI_EGRESS_ALLOW_PUBLIC` 设为 `1`。不设则管理端「验证供应商」对公网 URL 失败，错误句与原来的拒绝相同。
2. 该开关目前只认 `1`，与 `CLOUD_AI_EGRESS_ALLOW_LOOPBACK` 相同，不用杀开关的 `1/true/yes/on`。若要改成那一套，需要另说；本 PR 不改那两个受保护开关的解析。
3. 委托 Seller 读不再跟随「仍在回环上」的 307/308，改为原来的连接失败。若某个回环 mock 依赖这种跳转才能返回 200，需要明确说；Ozon 正式读路径不依赖它。Seller 代理、AI 补全和已接受扫描则把 3xx 状态交回调用方，不把跳转正文当成 200。
