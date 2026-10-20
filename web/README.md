# @podhub/web

React 前端的目录和三层边界见 [项目树](../docs/architecture-tree.md)。当前源码位置不变。

## WASM 产物

普通前端开发、构建和测试只需要 Bun，不需要 Rust。`bun run build` 先校验 `../wasm/dist/SOURCES.sha256`，再运行 TypeScript / Vite；产物缺失或与源码不一致时失败，不会自动调用 Cargo。测试也直接读取已提交 WASM。

浏览器产物统一放在仓库根的 `wasm/dist/browser/`：`listing-state.wasm`、`render/render_wasm.wasm` 与 `render/threaded/` 都随源码提交，位于 Vite root（`web/`）之上，开发期经 `/@fs` 读取。`listing-state.wasm` 是 `--features browser` 编出的唯一浏览器 listing-core 模块（不含服务端专用的 `snapshot_from_fields`），前端与 Go 浏览器侧测试读同一个文件。`threaded/` 中的 `.wasm`、JS、`.d.ts` 和 `snippets/` 必须来自同次构建。

修改 Rust 或 WASM 构建输入后，在仓库根执行 `make wasm`，它会生成全部服务端 / 浏览器产物并刷新清单。局部调试可以用 `bun run wasm:build`，它只构建浏览器渲染产物，不刷新全局清单；浏览器 listing-core 模块没有单独的构建入口，用仓库根的 `scripts/build-wasm.sh core --copy` 与服务端模块一起产出。固定工具版本为 Rust 1.99.0、nightly-2026-09-14（需 rust-src）和 wasm-bindgen 0.2.127；只有本地重建者需要安装它们，服务端标签组另需 Rust 1.83.0。

CI 只安装 Bun、使用已提交产物并运行构建、API 契约检查和测试。

## 守门脚本

`bun run check` = `build` → `test` → `api:check` → `deadcode`（knip）→ `lint`（oxlint + `@shadcn/lint`）。

### lint ratchet

`lint` 的 `--max-warnings` 是**只允许下调**的 ratchet：清理存量告警后把数字改小，任何情况下不许上调。新增违规会让 `bun run lint` 直接失败。

`.oxlintrc.json` 中五条 `shadcn/*` 规则暂以 `warn` 计入同一个 ratchet 数（基线以 `package.json` 的 `--max-warnings` 为准）；存量清零后应恢复为 `error`。

## 组件

`src/components` 是共享 UI，`src/features/<域>` 放该域自己的组件。新组件沿用已用的 shadcn 组合与 Tailwind token，不再引入第二套样式体系；交互元素要有可访问名与键盘路径，`bun run lint` 的 `shadcn/*` 规则会对缺失项告警。
