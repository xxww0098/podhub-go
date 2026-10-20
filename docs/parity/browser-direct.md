# 浏览器直连发放（B1）

本文件是 D2 阶段 A、B、C 里由 Go 服务端承担的那一半；浏览器侧产物在 `wasm/dist/browser/`，TypeScript 适配在 `web/src/listing-core`。没有连接 Ozon、模型供应商或对象存储。

服务端嵌入 `wasm/dist/server/listing-core.wasm`（由 `wasm/embed.go` 嵌入 `dist/server/`），浏览器状态机是另一份文件。当前产物校验和以 [SOURCES.sha256](../../wasm/dist/SOURCES.sha256) 为准，不在文档中重复固定文件长度或哈希。

## 浏览器 wasm

`wasm/dist/browser/listing-state.wasm`

校验和记在 `wasm/dist/SOURCES.sha256`。

构建：`scripts/build-wasm.sh core`（其中一步是 `cargo build -p listing-core-wasm --release --target wasm32-unknown-unknown --features browser`）。`browser` 特性去掉 `snapshot_from_fields`。冻结（op 11）和 op 5 `record_render` 仍走 `call`。`send_transition` 是纯函数 `(state, event) -> {state, allowPost}`。没有 PSD 解码，没有套接字，没有 IndexedDB，没有密钥。

`allowPost` 只在 `(queued, key_present)` 为真。`fetch_started` 之后为假。`submitting`、`unknown`、`accepted`、`rejected` 再遇 `key_present` 也是假。`rejected` 不会把同一行重新武装；新的一次发送从 `queued` 开始。这是本地决定，不是 Rust 证据。

`TestBrowserStateWasmFreezeAndTransitions` 对这份 wasm 重放 `testdata/freeze_oracle.json` 的结果字节，并走完整张转移表。`TestCommittedBrowserWasmChecksum` 与 `TestCommittedWasmMatchesItsChecksum` 分别对照清单核对浏览器和服务端 SHA-256。WASM 在本地构建，CI 校验源码与产物指纹并重放结果 golden；`LISTING_CORE_WASM` 和 `LISTING_STATE_WASM` 始终指向已提交的 `wasm/dist/server` 与 `wasm/dist/browser` 模块。PSD 源码在 `rust/crates/`，浏览器渲染产物和 glue 也随源码提交，CI 不构建 Rust。

测试文件不能以 `_wasm_test.go` 结尾，否则 Go 把它当成 `GOARCH=wasm`，amd64 的 CI 不会编译它。转移表测试因此放在 `browser_state_test.go`。

服务端 `Open` 在加载时实例化一个 guest，缺 `snapshot_from_fields` 就拒绝，不再拖到第一次调用。成功路径使用已提交的服务端模块，冻结结果由 oracle 测试固定。

## 发放与报回

`POST /api/listing/browser/grant` 和 `POST /api/listing/browser/report`。两条都设 `Cache-Control: no-store`。能力位仍是 `CapListingSubmit`（审阅者 403）。租户仍是 `BeginApp`。不入队 `listing.submit` 或 `listing.submit.batch`，不写 `seller_upstream_writes`。

import/info 的错误不进 report。另有 `POST /api/listing/browser/import-info`，只收白名单字段，不发密钥，也不读开关。组织内观测是 `GET /api/listing/ozon-errors`。说明见 `docs/parity/ozon-error-catalog-parity.md`。

开关为真（进程启动时已经读到的那个布尔，发放路径不再读环境）时：不占 GCRA，不查密文，不调用 `OpenStore`。HTTP 503，`code` 为 `OZON_WRITES_DISABLED`，正文「Ozon 写入已停止」。响应里没有夹具密钥。

开关未关时：先占一个 GCRA 名额，再插入或重放 `submission_intents`，围栏通过后在同一事务里写成 `submitting` 并提交，然后才解密。成功是 HTTP 200，JSON 字段 `clientId`、`apiKey`、`expiresAtMs`、`ttlMs`。`expiresAtMs` 是 `credential_granted_at` 的毫秒加上 120000。`ttlMs` 固定 120000。`key_expires_at_ms` 仍是卖家密钥自己的过期，两套时钟没有合成一个字段。

报回复用现有 `Classify`。`taskId > 0` 记为 `accepted`。没有状态码记为 `unknown`（`OZON_DISPATCH_INTERRUPTED`），围栏继续占着。4xx 记为 `rejected` 并放开围栏；400/422 的错误码是现有的 `OZON_ROW_REJECTED`。浏览器报回不带供应商 code，所以 403 落在 `OZON_ACCESS_UNCLASSIFIED`。报回的 JSON 坏掉，或报回时行已经不是 `submitting`，行保持原状态，不再发第二把密钥。

旧 worker 仍只对 `queued` 调用 `Write`。已经是 `submitting` 的发放行走 `Recover`。这次发放没有 `seller_upstream_writes` 行，`Recover` 回滚并返回 `ErrIllegalEdge`，`Transport.Write` 计数为 0，意图停在 `submitting`。

迁移 `00315_browser_grant_revocation.sql` 只追加 `credential_granted_at` 和 `revoked_at`。没有改 00001–00307，没有改 `guard_submission_offer`。触发器是 `UPDATE OF state, offer_id`，这两列的写入不会再跑一遍围栏。指纹对照把这两列登记成 Rust 头之后的追加列（`tests/testkit/fingerprint.go` 的 `postRustColumns`），前面 21 列仍逐列比较。

## 阶段 A 已有证据

行为没有改的部分：

- `TestCommittedWasmMatchesItsChecksum`：服务端 wasm 的 SHA-256 与清单一致。
- `tests/integration/submit_parity_test.go` 的 `crash then recover does not send again`：崩溃后恢复不再 POST。
- 同文件的 `kill switch writes nothing and probe still reads`。
- `TestSubmissionOfferFence`：按今天的 `guard_submission_offer`（迁移 00260）锁定。`unknown` 且 `offer_id` 为空会挡住该店随后的具体货号，错误是 `23505` / `submission_intents_offer_busy`。两个不同的具体货号可以同时 `queued`。同一 `client_operation_id` 第二次插入仍是一行，约束名是 `submission_intents_client_op`。空店上直接插入 `queued` 且货号为空，也会 `submission_intents_offer_busy`。缺 `app.current_org_id` 时 `podhub_app` 看不到行，插入失败。

## 前端契约

本仓库没有页面。下面是给前端仓库的约定，来自 D2 第 2 节。

应用壳不加载这两个文件。

- 打开上架编辑：只加载 listing 状态机 wasm。不加载 PSD wasm。
- 用户选择 PSD，或对还没有清单摘要的图执行渲染：再加载 PSD wasm。渲染结束可以丢掉实例，清单 JSON 已经在 JS 里。
- 按下发送：若 listing wasm 还没加载则加载它。图上已经有 `manifestDigest` 时，发送路径不加载 PSD wasm。
- 服务端 wazero 继续用现有 `listing-core.wasm`，直到删除服务端冻结的那一步。不要让浏览器去实例化带 `snapshot_from_fields` 的那一份。

两个浏览器 wasm 不要打进同一个文件，也不要在启动时并行预取。

两者都只被 JS 调用。谁也不 `import` 谁，不共享线性内存，不共享一张表。JS 复制一份 JSON，然后各自释放。唯一允许跨过边界的数据是现有 op 5 `record_render` 的输入：

- `images[]`：从 0 起连续的 `index`，非空 `fileName` / `groupName`，`width` 和 `height` 大于 0，`contentHash` 为 `sha256:` 加 64 位小写十六进制，`phase` 为已渲染，并且还没有 `publicUrl` / `objectKey`。
- `rendererManifest`：一个 JSON 对象，其中 `slices` 的顺序、组名、文件名、摘要、宽高与 `images` 一致。对不齐时 op 5 拒绝，文案是「切片清单与渲染器组序不一致」。

op 5 的输出是 `images`、`manifest`、`manifestDigest`（`manifest:sha256:` 加摘要）。PSD wasm 只生产这份输入。它不生产 `/v3/product/import` 正文，不看到 offer，不看到密钥。listing wasm 在自己的内存里对这份 JSON 调用 op 5，不回调 PSD。

IndexedDB 不在 wasm 里。JS 把 `send_transition` 的结果写进 IndexedDB。PSD wasm 不读这个库。IndexedDB 里不放 `Api-Key`，不放 PSD 字节。PSD 原文件若要留在本机，那是另一份存储，不进状态机记录。

JS 发送顺序：

1. listing wasm 冻结，得到单条 import 字节、`offer_id`、`request_hash`。多条拼包不在这个 wasm 里重做。一条发送继续用冻结原字节。
2. JS 向 chi 要发放。服务端先写 `submitting` 再返回密钥。
3. JS 把 IndexedDB 写成 `fetch_started`，然后 `fetch` `https://api-seller.ozon.ru/v3/product/import`。`credentials: 'omit'`，避免带上探测里看到的 `abt_data`。预检允许 `include`，但没有证据表明必须带上那个 cookie。
4. HTTP 2xx 且有正的 `task_id`：把 `task_id` 报回服务端，行变为 `accepted`。4xx：报回，行变为 `rejected`，围栏放开。没有状态码或连接失败：报回 `unknown`，围栏继续占着。报回失败时，服务端停在 `submitting`，不再发放第二次密钥。
5. 页面重新打开：先读服务端这一行，再用 wasm 算 `allowPost`。服务端已是 `submitting` / `unknown` / `accepted`，或 IndexedDB 已是 `fetch_started`，就不再 POST。续传是把界面和报回补上，不是把 import 再打一遍。

明文不写日志，不进 IndexedDB，不进任何一个 wasm 的线性内存。JS 只在内存里留到这次 `fetch` 结束或期限到达，然后把该变量置空。

## 真实店铺自测

自测由店铺自己做，一次只打必要的请求。不要在 CI 或本仓库里做。

1. 发放上线后，用真实页面源站发一条只含一件商品的 `/v3/product/import`。记下 HTTP 状态、这一次 POST 响应上的 `Access-Control-Allow-Origin`（不是预检），以及有没有 `task_id`。到此停止。
2. 另发一条 `offer_id` 为空的请求。记下响应正文。不要自动重试。
3. 对店铺里已经存在的一个 `offer_id` 再发一条。记下任务结果是更新、错误，还是又出现一件商品。不要发第三条。
4. 若要看「不同 offer、同一商品」：只发这一对，记下任务结果。这一对不能推广成规则。
5. 让一个标签页先拿到密钥并保持打开。然后把 `OZON_WRITE_KILL_SWITCH` 设为 `1` 并重启 API。确认下一次发放的响应里没有密钥。确认这个已打开的标签页在丢掉明文或期限到达之前仍然能 POST。这就是不可拦的窗口。
6. 若这把密钥限制了 IP：在浏览器所在的网络上重做第 1 步，记下是 403 还是得到 `task_id`。

第 1 步若失败，直连停在未证明，不要继续删发送代码。第 5 步若已打开的页面不能再 POST，也要把现象记下来；预期是它还能 POST，因为没有任何代码能把已经发出的明文收回。

## 发放链路锁测试

回环 mock，夹具密钥是 `fixture-api-key-browser-direct`。不拨公网。

- `TestBrowserDirectImportRoundTrip`：发放后由测试模拟浏览器向回环 mock POST `/v3/product/import`，再报回。2xx 且 `task_id` 为 `accepted`；4xx 为 `rejected` 并放开围栏；连接被掐掉、没有状态码为 `unknown` 且围栏继续占着；报回因行修订对不上而失败时停在 `submitting`，重放同一请求不再给第二把密钥。
- `TestBrowserDirectConcurrentGrants`：同店同货号 8 路并发只有 1 路拿到密钥，其余 409；6 个不同货号都成功；已有 NULL offer 的 `unknown` 挡住该店随后的具体货号。`pg_stat_database.deadlocks` 增量为 0。
- `TestBrowserDirectKillSwitchHidesKey`：开关布尔只取 `config.Load().OzonWritesDisabled()`。捕获为真时，响应、slog、`audit_logs` 里夹具密钥共 0 次，`OpenGrant` 为 0，不插入占围栏的行。捕获为假时恰好 1 次，且只在响应体里。之后再 `Load` 不改变已经交给发放的那份布尔。
- `TestBrowserDirectGrantDeadlineAndRevocation`：期限内重放同一请求是 `grant_in_flight`；把 `credential_granted_at` 拨到 121 秒前是 `grant_expired`；`revoked_at` 之后是 `grant_revoked`。三次都没有密钥。
- `TestBrowserDirectTenantAndCapability`：另一个组织发放和报回都失败；审阅者 403；缺 `app.current_org_id` 时 `podhub_app` 看不到行、插不进行；报回只改自己那一行。
- `TestBrowserDirectWorkerDoesNotDialSubmitting`：发放不入队 `listing.submit`。旧 worker 对已经是 `submitting` 的行走 `Recover`，`Transport.Write` 为 0。
- `TestBrowserDirectModeRGrantCount`：`loadmode.Run("R")` 只做模式门。8 路并发发放的实测见该测试的日志行。

## 偏离 Rust 的点

- 新路由。Rust 0.0.112 没有浏览器发放。发送不再由 worker 拨号，这一阶段还没有删 worker；发放成功的行是 `submitting`，worker 领到它时不再 `Write`。
- 发放期限 120000 毫秒、上面的 HTTP 状态码，都不是从 Rust 抄来的。
- 限速用现有 GCRA，范围是 `browser-grant:` 加店铺 uuid，命名空间是 `seller/domain.Namespace()`（默认 `podhub`），速率沿用默认档（5 rps，突发 10，最长等待 5 秒）。名额在租户事务之前占下。围栏失败、店铺不存在，名额已经花掉。开关关掉的路径不占。这限制发放次数，限制不了浏览器拿着明文再 POST。
- 4xx 把围栏放开之后，另一个 `client_operation_id` 可以再要一把密钥。同一 `client_operation_id` 在期限内重放返回 `grant_in_flight`，过了 120000 毫秒返回 `grant_expired`，两次都没有密钥。
- `revoked_at` 只挡住下一次发放。已经写进响应的明文收不回来。本仓库没有 Ozon 撤回接口。SSE 不是紧急刹车。
- 浏览器 wasm 的文件字节和服务端 wasm 不同。冻结结果字节与 `freeze_oracle.json` 一致。
- 空货号不会拿到密钥：今天的围栏在空店上拒绝 `queued` 且货号为空的插入。函数没有改。

## 需要用户决定

- 发放期限用 120000 毫秒是否接受。
- 状态码：开关关 503 `OZON_WRITES_DISABLED`；货号忙 409 `submission_intents_offer_busy`；已撤销 409 `grant_revoked`；同一操作重放 409 `grant_in_flight`；过期 409 `grant_expired`；过频 429 `rate_limited`；坏 JSON 400；店铺不存在 404；解密失败或没有信封 503 `credential_unavailable`（行留在 `submitting`）；卖家密钥过期 503 `credential_expired`；成功 200；报回成功 200；报回时行不是 `submitting` 409；意图不存在 404；审阅者 403。
- 已经发出的明文不能由这个进程作废。
- 4xx 之后允许用新的 `client_operation_id` 再发放一把密钥。wasm 的同一行在 `rejected` 后不会把 `allowPost` 重新设为真。
- GCRA 名额在围栏和店铺查找之前扣除。
- 报回不带供应商 code 时，403 只能记成 `OZON_ACCESS_UNCLASSIFIED`。
