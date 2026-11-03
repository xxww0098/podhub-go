import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { delegateHttp } from "./delegate-http"
import { uploadDelegateAsset } from "./delegate-upload"

const source = { source_id: "source-1", name: "Factory", country: "CN", icon: "" }
const asset = { asset_id: "asset-1", binding_id: "binding-1", file_name: "original.png", sha256: "a".repeat(64),
  bytes: 3, mime: "image/png", position: 0, verified: true, verified_at_ms: 2, created_at_ms: 1 }
const binding = { binding_id: "binding-1", store_id: "store-1", offer_id: "offer-1", source, assets: [asset],
  note: "", active: true, revision: 2, created_at_ms: 1, updated_at_ms: 2 }
const envelope = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } })

function stubFetch(fetcher: typeof fetch): () => void {
  const previous = globalThis.fetch
  globalThis.fetch = fetcher
  return () => { globalThis.fetch = previous }
}

test("delegate source and binding lists decode the snake_case DTO inside data", async (t) => {
  t.after(stubFetch(async (input, init) => {
    assert.equal(init?.credentials, "include")
    if (String(input).endsWith("/sources")) return envelope({ sources: [source] })
    assert.equal(String(input), `${route("sellerDelegateBindings")}?store_id=store-1`)
    return envelope({ bindings: [binding] })
  }))
  assert.deepEqual(await delegateHttp.sources(), [{ source_id: "source-1", name: "Factory", country: "CN", icon: "" }])
  const [row] = await delegateHttp.listBindings("store-1")
  assert.equal(row?.binding_id, "binding-1")
  assert.equal(row?.source.source_id, "source-1")
  assert.equal(row?.assets[0]?.asset_id, "asset-1")
  assert.equal(row?.assets[0]?.verified_at_ms, 2)
})

test("binding writes send snake_case fields and retain optimistic revision", async (t) => {
  const bodies: unknown[] = []
  t.after(stubFetch(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return envelope({ binding })
  }))
  assert.equal((await delegateHttp.createBinding({ store_id: "store-1", offer_id: "offer-1", source_id: "source-1", note: "private" })).binding_id, "binding-1")
  assert.equal((await delegateHttp.patchBinding("binding-1", { expected_revision: 2, source_id: "source-2", active: false })).revision, 2)
  assert.deepEqual(bodies, [
    { store_id: "store-1", offer_id: "offer-1", source_id: "source-1", note: "private" },
    { expected_revision: 2, source_id: "source-2", active: false },
  ])
})

test("delegate upload crosses the actual presign, anonymous PUT and confirmation wire shapes", async (t) => {
  const file = new File([new Uint8Array([1, 2, 3])], "original.png", { type: "image/png" })
  const checksum = "A".repeat(43) + "="
  const calls: string[] = []
  t.after(stubFetch(async (input, init) => {
    const path = String(input)
    calls.push(`${init?.method} ${path}`)
    if (init?.method === "PUT") {
      assert.equal(path, "https://r2.example/original")
      assert.equal(init.credentials, "omit")
      assert.equal(init.body, file)
      const headers = new Headers(init.headers)
      assert.equal(headers.get("content-type"), "image/png")
      assert.equal(headers.get("if-none-match"), "*")
      assert.equal(headers.get("x-amz-checksum-sha256"), checksum)
      assert.equal(headers.get("cookie"), null)
      return new Response(null, { status: 200 })
    }
    assert.equal(init?.credentials, "include")
    const body = JSON.parse(String(init?.body))
    if (path.endsWith("/presign")) {
      assert.deepEqual(Object.keys(body).sort(), ["binding_id", "bytes", "file_name", "mime", "sha256"])
      assert.equal(body.binding_id, "binding-1")
      assert.equal(body.file_name, file.name)
      assert.equal(new Headers(init?.headers).get("x-podhub-store-checksum"), "sha256")
      return envelope({ upload: { object_key: "42/hash.png", upload_ticket: "receipt-1", upload: {
        url: "https://r2.example/original", expires_at_ms: Date.now() + 60_000,
        headers: { content_type: "image/png", if_none_match: "*", checksum_sha256: checksum },
      } } })
    }
    assert.equal(path, route("sellerDelegateAssets"))
    assert.deepEqual(body, { binding_id: "binding-1", upload_ticket: "receipt-1", file_name: file.name, position: 0 })
    return envelope({ asset })
  }))
  const uploaded = await uploadDelegateAsset({ presign: delegateHttp.presignAsset, putObject: delegateHttp.putAssetObject,
    finalize: delegateHttp.finalizeAsset, report: async () => {} }, { binding_id: "binding-1", file, position: 0 })
  assert.equal(uploaded.asset_id, "asset-1")
  assert.equal(uploaded.verified, true)
  assert.equal(uploaded.file_name, file.name)
  assert.deepEqual(calls, [`POST ${route("sellerDelegateAssetsPresign")}`, "PUT https://r2.example/original", `POST ${route("sellerDelegateAssets")}`])
})

test("delegate asset deletion maps its confirmed identity", async (t) => {
  t.after(stubFetch(async () => envelope({ asset_id: "asset-1", reclaimed: false })))
  assert.deepEqual(await delegateHttp.deleteAsset("asset-1"), { asset_id: "asset-1", reclaimed: false })
})

test("delegate order and posting-state queries use the documented snake_case keys", async (t) => {
  const paths: string[] = []
  t.after(stubFetch(async (input) => {
    paths.push(String(input))
    return String(input).includes("posting-states")
      ? envelope({ store_id: "store-1", states: [] })
      : envelope({ orders: [], has_next: false, cursor: "" })
  }))
  await delegateHttp.listOrders({ storeId: "store-1", state: "ready", search: "厂%", limit: 20 })
  assert.deepEqual(await delegateHttp.postingStates("store-1", ["one", "two"]), [])
  assert.deepEqual(paths, [
    `${route("sellerDelegateOrders")}?store_id=store-1&state=ready&search=%E5%8E%82%25&limit=20`,
    `${route("sellerDelegatePostingStates")}?store_id=store-1&posting_numbers=one%2Ctwo`,
  ])
})
