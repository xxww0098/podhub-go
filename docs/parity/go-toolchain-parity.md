# Go 工具链升级

只改编译器版本。没有改函数体、业务状态、`db/migrations` 或 `api/openapi.yaml`。没有升级任何依赖。

## 版本

| 项 | 升级前 | 升级后 |
| --- | --- | --- |
| `go` 行 | 1.26.0 | 1.27.0 |
| `toolchain` 行 | go1.26.9 | go1.27.2 |
| 实际编译 | go1.26.9 | go1.27.2 |
| 镜像 | `golang:1.26-bookworm` | `golang:1.27.2-bookworm` |

2026-10-16 用 https://go.dev/dl/?mode=json 核对，最新稳定版是 go1.27.2。`go` 行仍写该 minor 的 1.27.0，`toolchain` 行钉死补丁，和原来的 1.26.0 / go1.26.9 一样。`go mod tidy` 不改 `go.sum`；把两行都写成 1.27.2 时 tidy 会删掉重复的 `toolchain` 行，所以保留这个拆分。

CI 用 `actions/setup-go@v5` 的 `go-version-file: go.mod`。v5 只解析 `go` 行，补丁号按精确版本安装，所以它先装 1.27.0。工作流没有设置 `GOTOOLCHAIN=local`，随后 `go test` 按 `toolchain go1.27.2` 使用 go1.27.2。官方镜像里 `GOTOOLCHAIN=local`，因此 Dockerfile 直接钉 `golang:1.27.2-bookworm`，镜像里的编译器就是 go1.27.2。

sqlc v1.31.1 和 oapi-codegen v2.8.0 没有升级。它们自己的模块仍用 Go 1.26 安装，生成物 `git diff --exit-code` 为空。

## wasm

合并 `origin/main`（`f39065c`，PR #23）之后，窄 wasm 在 `wasm/dist`，源码当时还在 `wasm/` 下的独立 Rust 工程里。字节没有变。相对 `origin/main` 的 diff 只有 `Dockerfile`、`README.md`、`docs/architecture.md`、`go.mod`。当时的 CI 路径过滤不命中，不会重编 wasm。`scripts/check-wasm-dist.sh` 输出 `wasm dist hash ok`。

现在源码在 `rust/crates/{listing-tags,wasm-host-probe}`，与其余 crate 同属一个 workspace；CI 不再有路径过滤，每次运行都校验 `wasm/dist/SOURCES.sha256`。

| 产物 | 升级前的位置与 sha256 | 升级后 |
| --- | --- | --- |
| 禁用标签窄 wasm | `internal/listing/wasm/`，`348ce3082e387934b495203bbcf8d4775c66eb696e267f954b498ae3bc5008d4` | 字节未变，只是搬到了 `wasm/dist/` 下 |
| 宿主探针 | `internal/listing/wasm/`，`8f03a260981c468f4fc9191af84ecb6cb04fa9ef94e9b6e7c92db6ed28fb4b0d` | 字节未变，只是搬到了 `wasm/dist/` 下 |
| 服务端 listing-core | `3a99fa89dca739430e69d10d3c40a924a3ba9345716d57152c54e2d59b72520f` | 字节未变，只是搬到了 `wasm/dist/` 下 |

这次工具链升级没有改产物字节。之后的布局迁移把这几份产物分到 `wasm/dist/{server,test,browser}/` 并重编过一次，字节因此变了：当前哈希以 `wasm/dist/SOURCES.sha256` 为准，`scripts/check-wasm-dist.sh` 通过（`wasm dist hash ok`）。

## 测试

本机没有 Docker。集成测试用回环 PostgreSQL 16.15，`PODHUB_PARITY_DSN` 指向由已迁移模板克隆出的独立库，避免多个测试共用一个库时互相留下行。wasm 环境变量与 CI 相同。

升级前（`7eeb839`，go1.26.9）和合并 main 之后（go1.27.2）都是 435 个测试通过、0 跳过、0 失败。测试函数名一致。17 个测试的包路径变了，因为 PR #23 把 `internal/listing` 的一部分挪到 `internal/listing/core/...` 和 `internal/listing/rules`，不是这次工具链改的。

合并后的命令：`gofmt -l` 为空，`go vet ./...`、`go build ./...`、`go test -count=1`（非数据库包一次跑完，数据库测试按上面的隔离方式跑）通过。

## 结果为什么不变

没有改流程。Go 1.27 的 `gofmt` 对齐修正没有碰到本仓库的文件。`go vet` 没有新的告警。`encoding/json` 换了实现，但现有测试比较的是响应字节和状态，没有断言标准库错误文案；这些测试仍然通过。

## 需要用户决定

无。
