import { route } from "@/api/routes"
import { getSupplierMe } from "@/bindings/http-supplier-portal"
import { commandErrorCode } from "@/lib/error-message"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { signOutSupplier } from "./supplier-app"

type Fetch = typeof globalThis.fetch

function stubFetch(next: Fetch): () => void {
  const previous = globalThis.fetch
  globalThis.fetch = next
  return () => {
    globalThis.fetch = previous
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

test("退出登录清掉会话，随后 /api/supplier/me 未登录", async () => {
  // httpOnly 会话 Cookie 脚本读不到。这里用一只罐子代替：logout 清掉它，
  // 之后的请求不再带上，/api/supplier/me 按未登录拒绝。
  let session: string | undefined = "sid"
  const calls: string[] = []
  const restore = stubFetch(async (input, init) => {
    const path = String(input)
    const method = init?.method ?? "GET"
    calls.push(`${method} ${path}`)
    assert.equal(init?.credentials, "include")
    if (path === route("authLogout") && method === "POST") {
      assert.equal(session, "sid")
      session = undefined
      return new Response(null, { status: 204 })
    }
    if (path === route("supplierMe") && method === "GET") {
      if (session) {
        return jsonResponse(200, { data: { sources: [{ sourceId: "src", name: "厂" }] } })
      }
      return jsonResponse(401, { error: "未登录", code: "UNAUTHENTICATED" })
    }
    throw new Error(`unexpected ${method} ${path}`)
  })

  try {
    const me = await getSupplierMe()
    assert.equal(me.sources[0]?.name, "厂")
    let afterLogout: Promise<unknown> | undefined
    await signOutSupplier(() => {
      assert.equal(session, undefined)
      afterLogout = getSupplierMe()
    })
    assert.ok(afterLogout)
    await assert.rejects(afterLogout, (reason: unknown) => {
      assert.equal(commandErrorCode(reason), "unauthenticated")
      return true
    })
    assert.deepEqual(calls, [
      `GET ${route("supplierMe")}`,
      `POST ${route("authLogout")}`,
      `GET ${route("supplierMe")}`,
    ])
  } finally {
    restore()
  }
})

test("拒入门和排单屏的退出登录都走 signOutSupplier，进入工作台是链接", () => {
  const source = readFileSync(new URL("./supplier-app.tsx", import.meta.url), "utf8")
  assert.match(source, /nativeButton=\{false\} render=\{<a href="\/">进入工作台<\/a>\}/)
  assert.match(source, /onClick=\{signOut\}/)
  assert.match(source, /onSignedOut=\{onSignedOut \? signOut : undefined\}/)
  assert.match(source, /signOutSupplier\(onSignedOut\)/)
})
