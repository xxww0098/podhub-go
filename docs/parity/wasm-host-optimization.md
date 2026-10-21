# WASM 宿主与加载优化（2026-10-20）

目标基线：`main@be364cb76e87dc9ea178cd322b888ab3b641d998`。
这次不改 Rust 规则、WASM ABI、已提交二进制、线程数或实例池容量。

## Go 热路径

`Guest.Call` 原先每次调用 `Module.ExportedFunction`。仓库锁定的
wazero v1.9.0 会在这里创建调用引擎及其栈，而不是只查询一个函数指针。
一个规则操作包含 alloc、执行、free、读取结果等多次 ABI 调用，分配被放大。

现在每个 Guest 惰性保存自己的 `api.Function`，`Exported` 和 `Call` 共用该查找。
不跨 Guest 缓存；仍由 Pool 独占借出实例。Guest 不是并发安全对象。
结果仍使用 `Function.Call` 返回的独立切片，不复用会覆盖上一调用结果的缓冲区。
trap 后调用方仍丢弃对应 Guest，新实例建立自己的缓存。

`env.fill_random` 先用 Memory.Read 校验范围，再直接填充这段 Guest 内存。
移除了临时 Go 切片及后续复制；零长度仍是 no-op。
非空越界请求转为 trap，不再忽略 Memory.Write=false 后伪装成功。

## 浏览器加载

`web/src/lib/wasm-loader.ts` 是两个手写加载器的共同入口：

- 一次 fetch，先检查 HTTP 状态。
- MIME 为 application/wasm 时使用 instantiateStreaming。
- 其它 MIME 直接消费同一个 Response 的 arrayBuffer，不 clone、不重新请求。
- 网络、编译、链接和 start trap 原样失败，不自动重放模块初始化。

ListingCoreClient 的本地文件/字节入口及 restart 编译模块复用不变。
render/wasm.ts 中修改的是旧 C-ABI 测试/基准加载器；生产多线程渲染器的
wasm-bindgen glue、Rust 调度、内存预算和线程池没有变更。

## 本地测量

Go 1.27.2，wazero v1.9.0，Linux amd64 / Xeon Platinum 8573C，GOMAXPROCS=4。
每项三次，benchtime=200ms，表中为中位数；业务基准使用现有 oracle 校验输出。
本地源码来自先前 runner 导出的归档；本次涉及的三个既有生产文件
已按 Git blob SHA 与上述 main 基线核对一致。完整合并基线由 PR CI 验证。

| 基准 | 修改前 | 修改后 |
|---|---:|---:|
| GuestCall | 2,433 ns/op；11,664 B/op；4 allocs/op | 45.37 ns/op；16 B/op；2 allocs/op |
| FillRandom/16 | 72.66 ns/op；16 B/op；1 alloc/op | 59.33 ns/op；0 B/op；0 alloc/op |
| ListingCorePool/pool2/conc1 | 392,451 ns/op；157,563 B/op | 328,395 ns/op；14,825 B/op |
| ListingTagsPool/pool2/conc1 | 17,985 ns/op；59,722 B/op | 10,063 ns/op；1,199 B/op |

这些是宿主微基准与固定规则样本，不是整个上架流水线或真实 PSD 渲染的加速比。
并发 ListingCore 延迟有明显噪声，不据此宣称并发吞吐提高。
不将墙钟基准写成 CI 的硬性断言。

## 回归与复现

新增 Go 回归覆盖重复调用结果所有权、trap/关闭/替换后的实例隔离、
函数缓存的内存隔离、随机数写入边界。越界三例在旧实现上失败。

新增浏览器回归使用真实 dist 模块，覆盖正确/错误/缺失 MIME、HTTP 错误、
网络错误、编译错误、链接错误、start trap，以及 restart 零额外请求。
旧实现 3 pass / 14 fail，修改后 17 pass / 0 fail。

```sh
go test -count=1 ./internal/platform/wasm ./internal/listing/core/... ./wasm ./tests/archtest ./tests/parity
go test -race -count=1 ./internal/platform/wasm ./internal/listing/core ./internal/listing/core/service/engine
go test -run '^$' -bench . -benchmem -count=3 ./internal/platform/wasm
go test -run '^$' -bench 'BenchmarkListing(Core|Tags)Pool/pool2' -benchmem -count=3 ./internal/listing/core ./internal/listing/core/service/engine
bash scripts/check-wasm-dist.sh
cd web
bun test --preload ./tests/network-guard.preload.ts ./tests/wasm-loading.test.ts ./tests/render-wasm.test.ts ./tests/render-worker.test.ts ./tests/listing-core-wasm.test.ts ./src/render ./src/listing-core ./src/features/workflow/platforms
bun run build
```

未安装 Rust 工具链、未重建 WASM，也没有修改 manifest 来掩盖产物变化。
未调整取消执行语义、实例内存上限或服务端 schema 缓存策略。
