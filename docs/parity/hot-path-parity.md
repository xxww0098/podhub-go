# 连接池、缩略图、wasm 实例池

这三项只改执行方式。签名 URL、重试次数、op 编号、错误文案、禁词 1 秒缓存、`deleteAllowed` 都没有改。`OZON_WRITE_KILL_SWITCH` 与 `CLOUD_MEDIA_GC_DELETE` 仍只有 `internal/platform/config` 一个解析点。没有对真实 Ozon、模型供应商或 R2 发请求。

## 1. 回环对象存储与出站 HTTP 共用 Transport

改了哪些调用：

- `internal/platform/r2/origin.go` 的 `Exchange`
- `internal/supplier/repo/media.go` 的 `fetchLoopback`（货源图 20s，原图 65 分钟）
- `internal/admin/http/catalogue.go` 的模型探测（20s）
- `internal/ai/http/relay.go` 在没有注入 Client 时的默认客户端（60s）
- `internal/app/scans/accepted.go`（10s）
- `internal/admin/http/catalog_blob.go` 在没有注入 Client 时（5s）
- `internal/app/delegate_edge.go` 的卖家回环 POST（30s，最多 3 次且仍在回环内的重定向）

`internal/seller/egress.go` 的 Client 槽位和 30s 超时没有动。

进程级 Transport 按两档分开，再加探测自己的一档：

- 固定回环拨号，`DisableCompression` 由 `Request.NoCompress` 选择。非回环地址在拨号时拒绝，错误文本仍是 `refusing non-loopback media host`。`CheckRedirect` 返回 `http.ErrUseLastResponse`。
- 非回环拨号：`http.DefaultTransport` 的克隆，仍走环境代理，压缩开着。AI、扫描、委托卖家 POST 用这一档。委托的重定向策略没换成 `ErrUseLastResponse`。
- 模型探测：`Proxy: nil`，拨号仍是原来的 DNS 钉扎。允许回环与拒绝回环各一个 Transport，不复用上面两档。

超时在请求 context 上，数值与原来的 `Client.Timeout` 相同。`fetchLoopback` 的父 context 取消时，请求一起取消。超限截断仍是读到 `MaxBytes+1` 后切到 `MaxBytes`，并返回 `Fault` 文本 `response exceeds limit`。

`DeleteObject` / `DeleteKeys` 仍先经过 `internal/platform/r2/r2.go` 的 `deleteAllowed`。`CLOUD_MEDIA_GC_DELETE` 关闭时是 `ErrDeleteDisabled`。非 `127.0.0.1` 且打开删除时，`New` 返回 `ErrRewriteBucketRefuse`，不建会删对象的客户端。

结果为什么不变：同一 URL、头和 body 下，共享 Transport 与「每次 new Transport」的响应 status、去掉 `Date` 后的 header、body 字节一致，包括 gzip 自动解压、不跟随重定向、以及超限截断。连接复用只影响下一次拨号，不改这一次的响应字节。

测试：

- `TestExchangeMatchesIsolatedTransport`
- `TestExchangeReusesLoopbackConn`（200 次 GET，`httptrace.GotConn.Reused`）
- `TestTransportBucketsStayApart`、`TestLoopbackDialRefusesPublicAddresses`
- `TestProbeTransportStaysOffProxyAndPlain`、`TestProbeFetchLoopbackBytes`
- `TestFetchLoopbackReturnsBody`、`TestFetchLoopbackStopsWhenParentCancels`
- `TestExplicitOffDoesNotDelete`、`TestCredentialsWithDeleteEnabledAreRefused`、`TestCredentialsWhileDeleteOffDoNotCallR2`（含 `DeleteKeys`）

基准（`go test -bench BenchmarkExchangeGET -benchtime=300ms -count=1 ./internal/platform/r2`，每次迭代对同一 httptest 打 200 次 GET）：

```
BenchmarkExchangeGET-4    10    40716833 ns/op    0 fresh-reused/200    199.9 shared-reused/200
```

隔离 Transport 的 `Reused` 是 0。共享 Transport 约 199.9/200。

## 2. 货源缩略图

`fitImage` 仍是：解码失败返回原 body 和 `ContentTypeForExt`；长边大于 `edge` 时按 `sx := b.Min.X + x*b.Dx()/w` 做最近邻；铺白底后 `draw.Over`；`jpeg.Encode` Quality 75；长边已不大于 `edge` 且原图不大于重编码结果时返回原字节。没有注册 webp 解码器，没有换插值。

变的只有采样写入。`*image.YCbCr`、`*image.RGBA`、`*image.NRGBA` 直接写目标 `Pix`。RGBA 原样拷贝 4 字节（`RGBAModel` 对 `color.RGBA` 是恒等）。YCbCr 与 NRGBA 走 `RGBA()` 再右移 8 位，和 `image.RGBA.Set` 使用的 `color.RGBAModel` 相同。NRGBA 的部分透明仍先预乘。其它图像类型仍走 `At` + `Set`。

结果为什么不变：采样坐标、白底、`draw.Over` 和 JPEG 参数没变，像素字节与旧的 `At`+`Set` 一致，所以 JPEG 输出字节和 Content-Type 一致。

测试：`TestFitImageMatchesAtSet`（jpg、带透明的 png、长边已小于 edge 的小图、解码失败、未注册的 webp）、`TestScaleNearestMatchesRGBASet`。

基准（`go test -bench BenchmarkFitImage -benchmem -benchtime=300ms -count=1 ./internal/supplier/repo`，320×240 JPEG 缩到长边 128）：

```
BenchmarkFitImage-4              459    795812 ns/op    245532 B/op      21 allocs/op
BenchmarkFitImageOracle-4        358   1013409 ns/op    343824 B/op   24597 allocs/op
BenchmarkFitImageConc8-4        1552    215855 ns/op    245520 B/op      21 allocs/op
```

8 路并发的 allocs/op 仍是 21。旧的逐像素 `color.Color` 是 24597 allocs/op。

## 3. listing-core 与禁词 wasm 实例池

`internal/listing/core/host.go` 的 `Call` / `snapshotWasm`，以及 `internal/listing/core/service/engine/engine.go` 的 `Call`，以前用一把 `sync.Mutex` 守一个实例（一个结果槽）。现在每个调用从有界池借一个 Guest，用完归还。池大小是常量 `guestPoolSize = 4`。池空时阻塞排队，不丢调用，不改错误文案，不改 op 编号。trap 只关闭当前这一个实例，下次借到该槽再实例化。schema 与 body 仍按原字节写入。返回值仍是结果槽的拷贝。`schema_drop` 在归还槽位之前、在持有该实例的同一次调用里执行。

`internal/listing/rules/banned.go` 的 1 秒规则缓存没有改。`TestBannedTagCacheServesTheSameRulesUntilTheTTL` 仍通过。

结果为什么不变：每个实例仍独占结果槽，输入字节不变，所以同一 op/schema/body 的结果字节与优化前以及 `testdata/freeze_oracle.json`（来自 `rust/crates` 的 golden）一致。禁词 `kept` / `rejected` 顺序不变：`#роза` 留下，`#сигареты` 拒绝。

测试：

- `TestWazeroFreezeMatchesNativeOracle`、`TestConcurrentPoolMatchesFreezeOracle`、`TestTrapDropsOnlyThatGuest`
- `TestWasmMatchesNativeOracle`、`TestBannedOutcomeOrderUnderPool`、`TestTrapDropsOnlyThatTagsGuest`
- `TestBannedTagCacheServesTheSameRulesUntilTheTTL`

这些测试加载的是提交进仓库的 wasm，不依赖 `LISTING_CORE_WASM`。`TestRebuiltListingCoreWasmMatchesNativeOracle` 只在该变量未设置时跳过。CI 始终把它指到 `wasm/dist/server/listing-core.wasm`，`LISTING_TAGS_WASM` 指到 `wasm/dist/server/listing-tags.wasm`，然后运行 `go test ./...`。WASM 只在本地重建并提交，CI 校验清单与结果 golden，不安装 Rust 或临时构建 WASM。

基准（`go test -bench 'BenchmarkListingCorePool|BenchmarkListingTagsPool' -benchtime=300ms -count=1`）。本机 `GOMAXPROCS` 为 4，所以「2 与 GOMAXPROCS」就是 pool2 与 pool4。夹具是 freeze oracle 的第一条，以及禁词 `partition`（`#роза` / `#сигареты`）。

listing-core：

```
BenchmarkListingCorePool/pool2/conc1-4     966    330878 ns/op     3022 ops/s     636 p99-us
BenchmarkListingCorePool/pool2/conc8-4    1734    181086 ns/op     5522 ops/s    2504 p99-us
BenchmarkListingCorePool/pool4/conc1-4     915    369903 ns/op     2703 ops/s     730 p99-us
BenchmarkListingCorePool/pool4/conc8-4    3501    101993 ns/op     9805 ops/s    2076 p99-us
```

禁词 wasm：

```
BenchmarkListingTagsPool/pool2/conc1-4    15415    24492 ns/op    40829 ops/s    168 p99-us
BenchmarkListingTagsPool/pool2/conc8-4    19118    18639 ns/op    53651 ops/s    546 p99-us
BenchmarkListingTagsPool/pool4/conc1-4    15762    21433 ns/op    46657 ops/s    121 p99-us
BenchmarkListingTagsPool/pool4/conc8-4    27438    11305 ns/op    88453 ops/s    477 p99-us
```

8 路并发时，池大小 4 的吞吐高于池大小 2。生产常量取 4。

## 需要用户决定

回环对象存储（`Exchange` 的压缩开着的那一档、`fetchLoopback`、`catalog_blob` 的默认客户端）固定 `Proxy: nil`，不再走 `HTTP_PROXY`。回环 httptest 上的 status、header、body 与旧实现一致。没有在设置了 `HTTP_PROXY` 且未把回环列入 `NO_PROXY` 的环境里对拍。若必须把 `127.0.0.1` 的预签名请求送进代理，这三处应改回 Plain 桶。
