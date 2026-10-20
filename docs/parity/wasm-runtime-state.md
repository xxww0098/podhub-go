# WASM 运行时状态与取消边界

基线：`main@be364cb76e87dc9ea178cd322b888ab3b641d998`。
本批落实 FSM-01/02/03：默认原生状态测试、完整调用方取消边界、租约三态。
不包含 Go WASM 宿主或 PSD 行复制优化，不改变上架行的业务状态。

## 单一状态所有者

Rust `scheduler/admission.rs` 仍独占准入、FIFO、租约与模板；
`compute.rs` 仍统一结算计算完成；浏览器适配移到 `scheduler/runtime.rs`。
TypeScript 只管理 Worker 生命周期、调用方等待、结果交付和 watchdog。
没有增加状态机库、第二个任务队列或兼容路径。

| 租约阶段 | 含义 | 迁移 |
|---|---|---|
| Reserved | 已准入、当前没有计算 | start → Running；release/dispose → 删除 |
| Running | 计算占用资源 | finish → Reserved；release/dispose → Draining |
| Draining | 调用方放弃，但计算尚未结束 | finish → 删除且不交付结果 |

完成计算不等于释放整个租约：同一租约可以先解析模板、再渲染产品。
在 Reserved 上调用 finish 不再报告成功；这不是给任意旧计算回调提供去重协议。
真实计算适配仍通过一次性 channel 完成，活动计算不得提前归还通道。
取消中的计算仍受 watchdog 监督；trap 仍销毁整个共享 runtime，不自动重放。

## 调用方取消与物理停止分开

批次使用 AbortController 通知其等待者。初始化、调用方异步 I/O 与释放确认
都能停止等待，而不关闭其他 owner 使用的 runtime。迟到结果或失败仍被观察，
但不能恢复已取消的批次；缓存句柄也不能从已取消 owner 重新取出使用。

不能只依赖 Promise.race 或 Promise 的一次拒绝：wait 已兑现与 await 续执行之间
仍有微任务窗口。代码在清理之后、最终返回之前再次检查 owner 的有效性。
这不声称强制中止任意调用方 I/O 或正在运行的 WASM CPU 计算。

新增七项回归覆盖初始化、调用方 I/O、成功回复与取消交错、释放确认等待、
缓存句柄，以及工作等待和清理等待各自兑现后的微任务窗口。

## 默认测试必须真的执行状态逻辑

以前普通 `cargo test -p render-wasm` 只列出 5 项 ABI/packing 测试，整个 scheduler
被 threads feature 隐藏。现在测试编译共享状态模块，浏览器/Rayon 适配仍按 feature
编译。测试复用原有 futures-channel 版本作为 dev-dependency，没有增加生产依赖。

`bash scripts/test-wasm-state.sh` 先核对关键测试的完整名称确实出现在测试列表，再执行。
独立的 `wasm-state / native-state` CI 使用 workspace 指定工具链运行此门禁，
不把空测试集的退出码 0 当成成功。普通 Go/Web CI 继续消费已提交的 WASM。

原生租约测试包含四种事件、深度六的 4096 组序列，逐步比较独立模型、租约归属
以及后继等待者的实际准入；它不是对无限事件空间的形式化证明。

## 已执行证据

[原生与重建验证](https://github.com/xxww0098/podhub-go/actions/runs/39454755996) 的 verify job 成功：
- 仅开放测试入口、保持原状态逻辑：21 项通过；最终 render-wasm 默认测试：24 项通过，其中 19 项为调度器测试。
- render/psdx/render-wasm 合计 382 项通过、0 失败、2 项原有手动性能用例忽略。
- 固定工具链执行 make wasm，真实重建产物并校验 manifest；真实 Chrome 渲染 fixture 通过。
- 该运行的首次 publish 因 GITHUB_TOKEN 没有 workflows 写权限失败；不是测试失败，未扩大令牌权限。

[最终交付边界验证](https://github.com/xxww0098/podhub-go/actions/runs/39456031670) 的 verify/publish 均成功：
- 在第一候选上新增微任务回归：16 通过、2 失败；最终实现 18 通过、0 失败。
- 最终专项测试连续运行 20 轮，全部通过；完整前端 3118 通过、2 跳过、0 失败。
- 真实 Chrome 验证初始化取消、微任务取消、另一 owner 仍能继续，以及原有多线程渲染 fixture。
- 最后只调整 TypeScript；逐项比较 Rust/WASM Git blob，确认与前一成功验证的产物完全相同。
- CI 文件由有权限的仓库连接器单独提交，其内容与受测 artifact 相同。

完整 PR 的 Go/Web/lint 和新增 native-state CI 仍是独立验收，不用专项结果替代。
所有计时阈值、资源预算、并发上限、像素算法和输出 golden 均未放宽。
没有生产部署、数据库写入或自动合并。

## 复现

```sh
bash scripts/test-wasm-state.sh
(cd rust && cargo test --locked -p render -p psdx -p render-wasm)
make wasm
bash scripts/check-wasm-dist.sh
(cd web && bun test --preload ./tests/network-guard.preload.ts ./src/render/client.test.ts)
(cd web && bun run build && bun run api:check && bun run test)
```

FSM-04 的 closed/peaks 历史集合淘汰未混入本批；删除 owner 墓碑需要先证明迟到请求
不会被重新接受。软内存预算和未知模板单任务推进策略保持原样。
