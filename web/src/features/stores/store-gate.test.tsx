import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { StoreGate } from "./store-gate"

const base = {
  hasUnavailableStores: false,
  onRetry: () => {},
  children: <div>queue</div>,
}

test("StoreGate keeps the queue visible and the failure off the page", () => {
  const html = renderToStaticMarkup(
    <StoreGate {...base} loading={false} error="网络错误" storeCount={1} />,
  )
  // The failure rides the live toast; the page never paints error text.
  assert.doesNotMatch(html, /网络错误/)
  assert.doesNotMatch(html, /role="alert"/)
  assert.match(html, /queue/)
})

test("StoreGate exposes loading, retry, unavailable, and open-store branches", () => {
  assert.match(renderToStaticMarkup(<StoreGate {...base} loading error="" storeCount={0} />), /正在读取店铺配置/)
  const failed = renderToStaticMarkup(<StoreGate {...base} loading={false} error="失败" storeCount={0} />)
  assert.doesNotMatch(failed, /失败/)
  assert.match(failed, /重试/)
  assert.match(renderToStaticMarkup(<StoreGate {...base} loading={false} error="" storeCount={0} hasUnavailableStores />), /当前不可用/)
  assert.match(renderToStaticMarkup(<StoreGate {...base} loading={false} error="" storeCount={0} onOpenStores={() => {}} />), /打开店铺/)
})
