import assert from "node:assert/strict"
import test from "node:test"
import { installBrowserDiagnostics, reactErrorHandlers } from "./browser-diagnostics"

test("browser and React errors retain safe context without raw exception text or resource URLs", () => {
  const target = new EventTarget()
  const original = console.log
  const lines: unknown[][] = []
  console.log = (...args) => { lines.push(args) }
  const cleanup = installBrowserDiagnostics(target as unknown as Window)
  try {
    const error = new Error("event handler failed")
    error.stack = "Error: secret\n    at onClick (https://app.invalid/app.js?token=secret:12:3)"
    target.dispatchEvent(Object.assign(new Event("error"), {
      error, message: error.message, filename: "/app.js?token=secret", lineno: 12, colno: 3,
    }))
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "promise failed" }))
    // A resource's captured event has its element as target.
    const resource = new Event("error")
    Object.defineProperty(resource, "target", {
      value: { tagName: "SCRIPT", getAttribute: () => "/chunk.js?token=secret" },
    })
    target.dispatchEvent(resource)
    for (const handler of Object.values(reactErrorHandlers)) {
      const renderError = new Error("render failed")
      renderError.stack = "Error: secret"
      handler(renderError, { componentStack: "at App" })
    }
    assert.equal(lines[0][0], "[browser] error code=operation_failed source=uncaught line=12 column=3 frames=onClick")
    assert.equal(lines[0].length, 1)
    assert.match(String(lines[1][0]), /source=unhandledrejection/)
    assert.match(String(lines[2][0]), /source=resource tag=SCRIPT$/)
    assert.match(String(lines[3][0]), /source=uncaught frames=App/)
    assert.match(String(lines[4][0]), /source=caught frames=App/)
    assert.match(String(lines[5][0]), /source=recoverable frames=App/)
    const inlineImage = new Event("error")
    Object.defineProperty(inlineImage, "target", {
      value: { tagName: "IMG", getAttribute: () => "data:image/jpeg;base64,secret" },
    })
    target.dispatchEvent(inlineImage)
    assert.match(String(lines[6][0]), /tag=IMG$/)
    assert.ok(!JSON.stringify(lines).includes("secret"))
    assert.ok(!JSON.stringify(lines).includes(".js"))
    cleanup()
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "after cleanup" }))
    assert.equal(lines.length, 7)
  } finally {
    cleanup()
    console.log = original
  }
})
