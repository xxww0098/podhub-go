# 来源

公式文件来自 [QuantumNous/new-api](https://github.com/QuantumNous/new-api) 提交 `3e2ce2c8856e32ca7054d673f8cd059ae466e80c`（2026-10-17 14:04:03 +0800，`fix: align model card summary with status bar hours (#7847)`）。

许可证是 GNU AGPL-3.0，全文在本目录 `LICENSE`。`NOTICE` 未改。用户已接受 AGPL-3.0 第 13 条。本目录不包含 new-api 的钱包写入、用户表或日志 UI。

下表「逐字」表示与该提交同路径文件的 SHA-256 相同。适配文件是 podhub 写的，不在上游路径上。

## 逐字文件

| SHA-256 | 路径 |
| --- | --- |
| `8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef` | `LICENSE` |
| `528067fcdf4f9d7e3fdb489d02cbdd36a0efa63fc2eb1686340612c26beb9f33` | `NOTICE` |
| `c624ccd0bcbe04a0408172077317e294636db63dedebe4c65001a4e57957cfb3` | `common/constants.go` |
| `db8f9f15b27a95f43651e69e47b41800ad775d9cf7f5fdfb5336e73822260092` | `common/quota_math.go` |
| `fdba6bc274d3c29ee8ebbc1d299ba95c95b1ec81bb1d47fcc646514da1272200` | `common/quota_math_test.go` |
| `6f43250f586422e8c847d1285444040f45195209a455325e6d3e21ed3dcf0c97` | `constant/channel.go` |
| `dd7798570c89a2a1f8cf631b387de9e8704de9184f5a22a9cd902f0d745c6958` | `constant/context_key.go` |
| `19bed80c1d761bad78a1b0fc64d24393a1ab99cda37224364f310285f733f2f7` | `pkg/billingexpr/billingexpr_test.go` |
| `a2b7bf9eb5435ed250627fda0fb9cef00b8835acf96e8df8a15eb1783c8d0432` | `pkg/billingexpr/compile.go` |
| `a040f75c55ec48e10fa7de7cebc462c9e4739c9612f4fdf51ee62b12e84b29fe` | `pkg/billingexpr/compile_usage_test.go` |
| `ec43b209f4b0c85cb5fbacded17e79a7c702edf8cb9bcc2850c71f276b2ca2f1` | `pkg/billingexpr/expr.md` |
| `809b64433338a99bc7f36b57da52e5edf6b24893a252d4df8a1ed0f66d467d29` | `pkg/billingexpr/fixed.go` |
| `c500c6ae0f7275305283ce03215d259d1daca733b89362f31b98c96a4cdf0bb6` | `pkg/billingexpr/round.go` |
| `ae18b4f6c619f473e87c39c776ba2a597c7b6fa0a35e2d196e6fc2297adec738` | `pkg/billingexpr/run.go` |
| `22ac04a7f0a5cdab8d47eda3bcbe9a85710f83494ddce87482bad5f914182dd3` | `pkg/billingexpr/settle.go` |
| `c6af9ef10da6644c9b4363475b8a391fef5362381529b08e44870e0fd8f77ac3` | `pkg/billingexpr/settle_clamp_test.go` |
| `2e2fdeba594a56a004864efb5ab488cdb06b4861ae1c2eb0c6f85b2ad9d3851a` | `pkg/billingexpr/task_usage_test.go` |
| `1569342ecacee420addba7b777c1d87a6594cb72ff0acd667d779ce40b8335e3` | `pkg/billingexpr/testdata/frontend_simulation.json` |
| `e030cf8a6dbc8660dd396a9b759987822e524c2156ba066d6e9defe30b69f2ce` | `pkg/billingexpr/types.go` |
| `9fcbc713ce9b4f6ed8fac81180c44a8307e7ecbe514c3245c843e8cab00bd464` | `relay/constant/relay_mode.go` |
| `5ff785ecb76798210d32223792bd7ee7f960afde04bacad4f92d7b6645cb82ae` | `relay/constant/relay_mode_test.go` |
| `c49639636852468a502604c3e237f7ef0ce343ba901ea73b882b7ee0912842a2` | `setting/billing_setting/builtin_billing.go` |
| `86739616eae283319edc72b894d190872dab5fcdfcfb5208cdc93e581fcd2e34` | `setting/billing_setting/tiered_billing.go` |
| `8a74712e641c4a86ed863c458574737182bde9d637ed351729d9d3e386c5b392` | `setting/billing_setting/tiered_billing_test.go` |
| `903323599a92c2d04e22ee0a190ced1f825e6a63ab3b7fb1ba2f89326850b22a` | `setting/config/config.go` |
| `c54083eed11d47dfcecea900be630bc1fb09e524b0ff32ca41b81183d6894db4` | `setting/config/config_test.go` |
| `c85f697a8ed52b39517e7ddba0d49e29867a2c4f22bff8e0c465f38880dde8af` | `setting/model_setting/claude.go` |
| `d0947dc6169bef013675b04d31babaa72d87a6303ed48c583aa05ae0762401e5` | `setting/model_setting/gemini.go` |
| `2a32ee0413acdda5aeadaeb79797c9ae2114b75fa2d9e023f6c1757f9eae6175` | `setting/model_setting/global.go` |
| `eab982ed083c5b61055dc568e78a151fd35e8c45b2b335cb52b34a5a6aabb1ec` | `setting/model_setting/grok.go` |
| `4218b3b59bd03172a42daaa05cc53da30162b70f0b4b623c3be02110d5e25f2f` | `setting/operation_setting/operation_setting.go` |
| `330bf1fe1db20eb64b0f08bae24feff991a667692002c03c5d9f6650293321bf` | `setting/operation_setting/quota_setting.go` |
| `bc08274610b04f140e925b9d0f4a02c7c78288209df092bc01a2426f92643315` | `setting/operation_setting/tools.go` |
| `44b9ebcf9349d3d2e7cf2ac6d625c855a0fef5b8d346c0c3fb61e6ce6d0a6cf6` | `setting/operation_setting/tools_price_test.go` |
| `8b81ca3fa0c33ba50392019db73694563af71e1306f8a1ba4c801f4fa61eeca6` | `setting/ratio_setting/cache_ratio.go` |
| `98d6dca1af6222cebca2e33c5cbf146ebe42b6537204497c2722857b635571a7` | `setting/ratio_setting/expose_ratio.go` |
| `c1b91b699249df607199aeca3bb6a7ce17145191ca1186a26cf25e411060120a` | `setting/ratio_setting/group_ratio.go` |
| `4928d4e8d9dad22dd1659f8123d6df25db93ecf27bb1f3953551c4ae2d324d09` | `setting/ratio_setting/matching_test.go` |
| `45382d83e32a5c6fcbfa8090fd1a244b13e7e7a9b82884589876b5fea8f624fc` | `setting/ratio_setting/model_ratio.go` |
| `a67ff0be486631b7e618da154380be8d1a7812062c367edff64009543e8302dd` | `setting/reasoning/suffix.go` |
| `9aacbac95226a860fffe193e0a19d4d72601fe245b47c803af9d2707391f4781` | `types/price_data.go` |
| `b1f91e3a39cfd43a6c89fba992d7d2c1ecdfffd3e99c0b2ad55aae6ea10cc43a` | `types/rw_map.go` |

## 改动文件（只去掉 gin）

下面 6 个文件原本逐字拷贝，为了不把 gin 链进进程，改了 import 和签名里的 gin 类型。除 import 块外，每一行与上游相同，或只把 `gin.Context` / `gin.H` / `binding.Validator` 换成 `hostctx` 里的同名符号；函数体、分支、常量都没动。上游原文按字节保存在 `testdata/upstream/<路径>.orig`。`internal/platform/newapibilling` 的 `TestModifiedFormulaDiffersOnlyInGinTypes` 校验原文 SHA-256 等于下表「上游」列，并逐行比较。

| 路径 | 上游 SHA-256 | 当前 SHA-256 | 改了什么 |
| --- | --- | --- | --- |
| `service/text_quota.go` | `bfc67843b14994e1a996b0e010a183fd187e3d03d50251b2a73cba92f19bd919` | `1fd1b6039a94bccafdc84f5c53348288cfb180af0caabb7672bb21d3ad9a81af` | `*gin.Context` → `*hostctx.Context`（`calculateTextToolCallSurcharge`、`calculateTextQuotaSummary`、`PostTextConsumeQuota` 的参数） |
| `relay/helper/billing_expr_request.go` | `eaf726ee45ca4b78633e75e63ba39b1fbe0c3ea0f0b237b90f6a2008fa830289` | `e1454f3deec7ef27a57a11b97bb4038648a927cf6f81ee6324e7a4f5dea40d5f` | `*gin.Context` → `*hostctx.Context`（三个函数的参数）；import 按 gofmt 重新排序 |
| `relay/helper/price.go` | `cba578ed51690a0628abba97b8743a04788d81569503bb94520612e2ba67b3b1` | `1c09da84dbfdaca0b6e6ac684b0e7789d7e6de302e73ef7653643fb541b00a4c` | `*gin.Context` → `*hostctx.Context`（`ModelPriceHelper`、`ModelPriceHelperPerCall`、`HandleGroupRatio` 等的参数） |
| `setting/ratio_setting/exposed_cache.go` | `3a568fe9bfeded55627807c4e5152614cff955b1d8c632da13d9d2b635efde77` | `dc6748ef7f7d679e8c25e6c3b05e9ec87c210f8c0827885158d53a7fcc7b3d3b` | `gin.H` → `hostctx.H` |
| `common/message.go` | `8ce5bf4161176d064a1920739cefb084e9c667cd6c736741d128fd16ec206d77` | `760c536bf5dc024fbff727fe4751512a25b5734b214d0312bf52f4381ddfbb24` | `gin.H` → `hostctx.H`（`Message.Fields`） |
| `common/json.go` | `6e18f45f05aa15c13fb664ddc9dbeb608d182a7c84d20016249e42ffeb0e3e26` | `856f84b0ec46121ad3d90cde8382931062afb79e257ea1ae30dde65697b6f4f3` | import `github.com/gin-gonic/gin/binding` 换成 `hostctx`，`binding.Validator` → `hostctx.Validator`；import 按 gofmt 重新排序 |

唯一可观察的语义差别在 `common.DecodeJsonWithValidation`：上游用 gin 默认的 go-playground 校验器检查 `binding` 标签，这里 `hostctx.Validator` 为 nil，只解码不校验。该函数在本目录和 podhub 里都没有调用方。

`service/quota_formula.go` 不是整文件拷贝。函数体是 `service/quota.go` 同提交的第 26–39、41–47、49–86、266–290 行（`TokenDetails`、`QuotaInfo`、`hasCustomModelRatio`、`calculateAudioQuota`、`CalcOpenRouterCacheCreateTokens`）。该文件其余部分写 new-api 钱包，没有拷。

## 适配（podhub 写的）

这些符号让逐字文件和上面的改动文件能编译。结算、记日志、改用户额度的函数直接 panic，测试不调用它们。

| 文件 | 替代了什么 |
| --- | --- |
| `common/adapter_log.go` | `SysLog` / `SysError` 改为 `log.Print`。`LogText` 走英文 `fmt.Sprintf`（上游翻译表为空时的默认路径）。`GetContextKeyString` / `GetContextKeyBool` 是 `common/gin.go` 第 177–179 与 241–243 行的函数体。`gin.go` 的主机掩码没有拷。 |
| `common/adapter_body.go` | `GetBodyStorage` 固定返回错误。阶梯预扣若要读未冻结的请求体，会失败。gpt-4o 倍率路径不读请求体。 |
| `relay/common/adapter_limits.go` | `MaxTaskDurationSeconds = 3600`，`MaxBillableToolCallCount = 10000`。来自上游 `relay_utils.go` 与 `tool_usage.go` 的同名常量。 |
| `relay/common/adapter_relay_info.go` | `RelayInfo` 只留计价要读的字段。`SetEstimatePromptTokens`、`GetEstimatePromptTokens`、`GetOriginModelName`、`GetBillingModelName`、`GetFinalRequestRelayFormat` 的函数体来自 `relay_info.go` 第 820–832、841–846、850–858、777–788 行。没有拷渠道、websocket 和整份 gin 请求状态。 |
| `service/adapter_oracle.go` | `init` 调用 `ratio_setting.InitRatioSettings`（上游在 `main` 里调用）。`QuoteText` / `QuotePerCall` 只调用 `ModelPriceHelper`、`ModelPriceHelperPerCall` 和 `calculateTextQuotaSummary`，不重写公式。`QuotaFromDecimalInt` 把整数交给拷来的 `QuotaFromDecimal`，避免测试再引一份 decimal。 |
| `service/adapter_settlement.go` | `SettleBilling`、`effectiveBillingUsage`、`GenerateTextOtherInfo`、`GenerateClaudeOtherInfo`、`TryTieredSettle` 以及同文件其余被 `text_quota.go` 引用的符号全部 panic。 |
| `model/adapter_log.go` | `RecordConsumeLog`、`UpdateUserUsedQuotaAndRequestCount`、`UpdateChannelUsedQuota` panic。`IsAdmin` 恒为 false。`LogOther.SetPublic` / `SetAdmin` 返回 false。 |
| `logger/adapter_log.go` | `LogDebug` / `LogWarn` / `LogError` 空实现，`ctx` 参数为 `any`（调用方传的是 `*hostctx.Context`，不是 `context.Context`）。`FormatQuota` 只打印整数。`calculateTextQuotaSummary` 不调用它们。 |
| `hostctx/adapter_hostctx.go` | 代替 gin 的三个符号：`Context`（`Request` 字段与 `Keys`；`Get` / `GetString` / `GetBool` 是 gin v1.10.1 `context.go` 的函数体）、`H`（`map[string]any`，没有拷 `MarshalXML`）、`Validator`（nil）。`service/adapter_oracle.go` 的测试上下文由 `gin.CreateTestContext` 改为空的 `&hostctx.Context{}`，两者都没有 Request 和键。 |
| `i18n/adapter_i18n.go` | 两个消息键常量。`T` 返回键本身。 |
| `pkg/jsplugin/adapter_schema.go` | `ValidPluginKey`（`^[a-z0-9][a-z0-9_-]*$`，长度不超过 30）和 `UsageFieldSchema` 的 `Type` / `Unit` / `Enum`。没有拷插件注册表。 |

`github.com/QuantumNous/new-api/relaykit` 仍是已发布的 v0.3.4，不在本目录里替换。

没有定义额度到 microfen 的换算常数。没有调用 `HoldTx`、`SettleTx`、`ReleaseTx`。
