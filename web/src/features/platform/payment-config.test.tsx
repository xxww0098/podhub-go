import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { PaymentConfigData } from "@/bindings/commands"
import { PaymentConfigPanel } from "./payment-config"

function config(easypayConfigured: boolean): PaymentConfigData {
  return {
    revision: 7,
    providers: [
      {
        provider: "easypay",
        enabled: easypayConfigured,
        configured: easypayConfigured,
        values: {
          pid: easypayConfigured ? "10001" : "",
          apiBase: "https://pay.example.com",
          notifyUrl: "https://cloud.example.com/api/billing/webhooks/easypay",
          returnUrl: "https://cloud.example.com/api/billing/callback/complete",
        },
        secretFieldsConfigured: easypayConfigured ? ["pkey"] : [],
      },
      ...["alipay", "wechat", "stripe", "airwallex"].map((provider) => ({
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

  for (const label of ["EasyPay", "支付宝", "微信支付", "Stripe", "Airwallex"]) {
    assert.match(html, new RegExp(label))
  }
  assert.match(html, /保存全部支付配置/)
  assert.match(html, /已配置；只有轮换时才重新输入/)
  assert.match(html, /显示商户密钥/)
  assert.doesNotMatch(html, /BEGIN PRIVATE KEY/)
})

test("each provider shows its deployable notify endpoint and prefills empty callback fields", () => {
  const html = renderToStaticMarkup(<PaymentConfigPanel initialConfig={config(false)} />)

  assert.match(html, /通知地址 · GET 或 POST/)
  assert.match(html, /\/api\/billing\/webhooks\/easypay/)
  assert.match(html, /复制EasyPay通知地址/)
  assert.match(html, /\/api\/billing\/callback\/complete/)
})

test("an unconfigured provider clearly marks its first-use secret", () => {
  const html = renderToStaticMarkup(<PaymentConfigPanel initialConfig={config(false)} />)

  assert.match(html, /未配/)
  assert.match(html, /首次启用前必填/)
})
