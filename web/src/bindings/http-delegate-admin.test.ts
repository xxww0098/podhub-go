import assert from "node:assert/strict"
import test from "node:test"

import { listAdminDelegateOrders } from "./http-delegate-admin"
import { route } from "@/api/routes"

test("admin delegate list forwards its page size and cursor together with filters", async () => {
  const originalFetch = globalThis.fetch
  let requested = ""
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    return Response.json({ data: { orders: [], has_next: false, cursor: "" } })
  }) as typeof globalThis.fetch
  try {
    await listAdminDelegateOrders({ state: "ready", sourceId: "factory-a", orgId: "9223372036854775807", cursor: "next-token", limit: 20 })
    const url = new URL(requested, "http://localhost")
    assert.equal(url.pathname, route("adminDelegateOrders"))
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      state: "ready", sourceId: "factory-a", orgId: "9223372036854775807", cursor: "next-token", limit: "20",
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
