import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { AppCrashBoundary } from "./app-crash-boundary"

test("the crashed boundary paints a recovery link, not the error text", () => {
  const boundary = new AppCrashBoundary({ children: null })
  boundary.state = { crashed: true }
  const html = renderToStaticMarkup(boundary.render() as React.ReactElement)
  assert.match(html, /页面出现异常/)
  assert.match(html, /重新加载/)
  assert.doesNotMatch(html, /boom|Error/)
})

test("an intact subtree renders through", () => {
  const boundary = new AppCrashBoundary({ children: createElement("p", null, "ok") })
  const html = renderToStaticMarkup(boundary.render() as React.ReactElement)
  assert.match(html, /ok/)
})
