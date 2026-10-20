import assert from "node:assert/strict"
import test from "node:test"

import { route } from "@/api/routes"

import { integrationsHttp } from "./http-integrations"

test("切片媒体文件树请求始终携带所选账号与相对路径", async () => {
  const previous = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({ data: { prefix: "成品", items: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch

  try {
    await integrationsHttp.mediaStorageObjects("media/备用", "成品 图", "next/+=")
    await integrationsHttp.createMediaStorageDirectory("media/备用", "成品 图/九月")
    await integrationsHttp.moveMediaStorageObject(
      "media/备用",
      "成品 图/a.jpg",
      "归档/a.jpg",
      "file",
    )
    await integrationsHttp.deleteMediaStorageObject("media/备用", "归档/a.jpg", "file")
  } finally {
    globalThis.fetch = previous
  }

  assert.equal(
    calls[0]?.url,
    `${route("adminMediaObjects")}?accountId=media%2F%E5%A4%87%E7%94%A8&prefix=%E6%88%90%E5%93%81+%E5%9B%BE&cursor=next%2F%2B%3D`,
  )
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    accountId: "media/备用",
    path: "成品 图/九月",
  })
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
    accountId: "media/备用",
    sourcePath: "成品 图/a.jpg",
    destinationPath: "归档/a.jpg",
    kind: "file",
  })
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), {
    accountId: "media/备用",
    path: "归档/a.jpg",
    kind: "file",
  })
})

test("供应商文件树进入目录和翻页使用查询参数，不改变接口路径", async () => {
  const previous = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return Response.json({ data: { prefix: "", items: [] } })
  }) as typeof globalThis.fetch

  try {
    await integrationsHttp.supplierDbStorageObjects()
    await integrationsHttp.supplierDbStorageObjects("supplier-dbs")
    await integrationsHttp.supplierDbStorageObjects("supplier-dbs/成品 图", "next/+=")
    await integrationsHttp.supplierDbStorageObjects("", "next/+=")
    await integrationsHttp.integrationsMediaStorage({ id: "media/备用", prefix: "成品 图" })
  } finally {
    globalThis.fetch = previous
  }

  for (const [index, prefix, cursor] of [
    [0, null, null],
    [1, "supplier-dbs", null],
    [2, "supplier-dbs/成品 图", "next/+="],
    [3, null, "next/+="],
  ] as const) {
    const url = new URL(calls[index]!, "https://example.invalid")
    assert.equal(url.pathname, route("adminSupplierDbStorageObjects"))
    assert.equal(url.searchParams.get("prefix"), prefix)
    assert.equal(url.searchParams.get("cursor"), cursor)
  }
  const media = new URL(calls[4]!, "https://example.invalid")
  assert.equal(media.pathname, route("adminMediaStorage"))
  assert.equal(media.searchParams.get("accountId"), "media/备用")
  assert.equal(media.searchParams.get("prefix"), "成品 图")
})
