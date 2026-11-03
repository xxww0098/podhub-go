import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { PaymentConfigData } from "@/bindings/commands"
import { PaymentConfigPanel } from "./payment-config"

function config(alipayConfigured: boolean): PaymentConfigData {
  return {
    revision: 7,
    providers: [
      {
        provider: "alipay",
        enabled: alipayConfigured,
        configured: alipayConfigured,
        values: {
          appId: alipayConfigured ? "10001" : "",
          gateway: "https://openapi.alipay.com/gateway.do",
          notifyUrl: "https://cloud.example.com/api/billing/callback",
        },
        secretFieldsConfigured: alipayConfigured ? ["privateKey", "alipayPublicKey"] : [],
      },
      ...["easypay", "wechat", "stripe", "airwallex"].map((provider) => ({
        provider,
        enabled: false,
        configured: false,
        values: {},
        secretFieldsConfigured: [],
      })),
    ],
  }
}

test("payment settings expose all Sub2API provider families without stored secrets", () => {
  const html = renderToStaticMarkup(<PaymentConfigPanel initialConfig={config(true)} />)

  for (const label of ["易支付", "支付宝", "微信支付", "Stripe", "Airwallex"]) {
    assert.match(html, new RegExp(label))
  }
  assert.match(html, /保存全部支付配置/)
  assert.match(html, /已配置；只有轮换时才重新输入/)
  assert.match(html, /aria-label="支付宝配置"/)
  assert.match(html, /显示应用私钥/)
  assert.match(html, /已安全保存；留空保持不变/)
  assert.doesNotMatch(html, /BEGIN PRIVATE KEY/)
})

test("each provider shows its deployable notify endpoint and prefills empty callback fields", () => {
  const html = renderToStaticMarkup(<PaymentConfigPanel initialConfig={config(false)} />)

  assert.match(html, /通知地址 · POST/)
  assert.match(html, /\/api\/billing\/callback/)
  assert.match(html, /复制支付宝通知地址/)
  assert.match(html, /payment-alipay-gateway/)
})

test("an unconfigured provider clearly marks its first-use secret", () => {
  const html = renderToStaticMarkup(<PaymentConfigPanel initialConfig={config(false)} />)

  assert.match(html, /未配/)
  assert.match(html, /首次启用前必填/)
})

test("a missing provider is shown as unknown rather than unconfigured", () => {
  const partial = config(false)
  partial.providers = partial.providers.filter((provider) => provider.provider !== "stripe")
  const html = renderToStaticMarkup(<PaymentConfigPanel initialConfig={partial} />)

  assert.match(html, /Stripe[^]*?未知/)
  assert.match(html, /部分支付渠道未读取，无法保存/)
  assert.match(html, /<button(?=[^>]*disabled="")[^>]*>(?:(?!<\/button>)[^])*保存全部支付配置<\/button>/)
})
