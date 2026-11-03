# @podhub/web

React 前端的目录和三层边界见 [项目树](../docs/architecture-tree.md)，界面约束见 [AGENTS.md](../AGENTS.md)。产品实现位于 `src`；测试 HTML 和 fixture 仅用于验收。

## 开发与检查

在 `web/` 执行 `bun install --frozen-lockfile`，然后 `bun run dev`。Vite 固定监听 `127.0.0.1:1420`，默认把 `/api` 和 `/mcp` 转发到 `127.0.0.1:8080`；后端地址可用 `DEV_CLOUD_URL` 覆盖。Go API 需另行启动，构建与环境要求见 [根 README](../README.md)。

`bun run check` 依次运行 `build`、`test`、`api:check`、`deadcode`（knip）与 `lint`（oxlint + `@shadcn/lint`）。界面历史验收见 [design-qa.md](../design-qa.md)，精铺功能准入以 [技术验证清单](../docs/precision-listing-verification.md) 为准。

## WASM 产物

普通前端开发、构建和测试只需要 Bun，不需要 Rust。`bun run build` 先校验 `../wasm/dist/SOURCES.sha256`，再运行 TypeScript / Vite；产物缺失或与源码不一致时失败，不会自动调用 Cargo。测试也直接读取已提交 WASM。

浏览器产物统一放在仓库根的 `wasm/dist/browser/`：`listing-state.wasm` 与 `render/threaded/` 都随源码提交，位于 Vite root（`web/`）之上，开发期经 `/@fs` 读取。`listing-state.wasm` 是 `--features browser` 编出的唯一浏览器 listing-core 模块（不含服务端专用的 `snapshot_from_fields`），前端与 Go 浏览器侧测试读同一个文件。`threaded/` 中的 `.wasm`、JS、`.d.ts` 和 `snippets/` 必须来自同次构建。

修改 Rust 或 WASM 构建输入后，在仓库根执行 `make wasm`，生成全部服务端 / 浏览器产物并刷新清单。局部调试可用 `bun run wasm:build`（即 `scripts/build-wasm.sh render`）只构建渲染产物，或 `scripts/build-wasm.sh core` 同时产出服务端和浏览器 listing-core；局部构建后再运行 `scripts/check-wasm-dist.sh --update` 刷新清单。

重建所需版本以 [rust-toolchain.toml](../rust/rust-toolchain.toml) 和 [build-wasm.sh](../scripts/build-wasm.sh) 为准：稳定工具链统一为 Rust 1.99.0，多线程渲染另用 nightly-2026-09-14（需 rust-src）与 wasm-bindgen 0.2.127。普通前端开发无需安装这些工具。

前端 CI job 安装 Bun，消费已提交 WASM 并运行构建、API 契约检查和测试；仓库另有独立 Rust 原生测试 job，见 [CI 配置](../.github/workflows/ci.yml)。

## lint ratchet

`lint` 的 `--max-warnings` 是**只允许下调**的 ratchet：清理存量告警后把数字改小，任何情况下不许上调。总告警数超过预算时，`bun run lint` 失败。

`.oxlintrc.json` 中五条 `shadcn/*` 规则暂以 `warn` 计入同一个 ratchet 数（基线以 `package.json` 的 `--max-warnings` 为准）；存量清零后应恢复为 `error`。

## 组件

`src/components` 是共享 UI，`src/features/<域>` 放该域自己的组件。新组件沿用已用的 shadcn 组合与 Tailwind token，不再引入第二套样式体系；交互元素要有可访问名与键盘路径，lint 不能代替实际键盘验收。
