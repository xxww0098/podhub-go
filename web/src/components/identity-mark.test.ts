import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { IdentityMark, identityMarkAction, fileToSquareJpeg } from "./identity-mark"

test("crop emits the JPEG Blob directly without reading it into base64", async () => {
  const oldBitmap = globalThis.createImageBitmap
  const oldDocument = globalThis.document
  let closed = false
  let drawn: unknown[] = []
  const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" })
  Object.defineProperty(jpeg, "arrayBuffer", { value: () => { throw new Error("must remain a Blob") } })
  globalThis.createImageBitmap = (async () => ({ width: 400, height: 200, close() { closed = true } })) as typeof createImageBitmap
  globalThis.document = { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ drawImage(...args: unknown[]) { drawn = args.slice(1) } }),
    toBlob(callback: (blob: Blob) => void, mime: string) { assert.equal(mime, "image/jpeg"); callback(jpeg) },
  }) } as unknown as Document
  try {
    assert.equal(await fileToSquareJpeg(new File(["input"], "image.png")), jpeg)
    assert.deepEqual(drawn, [100, 0, 200, 200, 0, 0, 256, 256])
    assert.equal(closed, true)
  } finally { globalThis.createImageBitmap = oldBitmap; globalThis.document = oldDocument }
})

test("failed JPEG export closes its bitmap and does not produce an upload body", async () => {
  const oldBitmap = globalThis.createImageBitmap
  const oldDocument = globalThis.document
  let closed = false
  globalThis.createImageBitmap = (async () => ({ width: 1, height: 1, close() { closed = true } })) as typeof createImageBitmap
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob(callback: (blob: null) => void) { callback(null) } }) } as unknown as Document
  try {
    await assert.rejects(fileToSquareJpeg(new File(["input"], "image.png")), /无法导出 JPEG/)
    assert.equal(closed, true)
  } finally { globalThis.createImageBitmap = oldBitmap; globalThis.document = oldDocument }
})

test("editable action names the object being replaced", () => {
  assert.equal(identityMarkAction("user"), "更换头像")
  assert.equal(identityMarkAction("workspace"), "更换工作空间头像")
})

test("account avatars distinguish platform ranks and preserve uploaded images", () => {
  const render = (role: string, imageUrl?: string) => renderToStaticMarkup(
    createElement(IdentityMark, { kind: "user", name: "Alex", role, imageUrl }),
  )
  assert.match(render("super_admin"), /lucide-crown/)
  assert.match(render("admin"), /lucide-shield-check/)
  assert.match(render("user"), /lucide-user-round/)
  assert.doesNotMatch(render("owner"), /lucide-crown|lucide-shield-check/)
  assert.match(render("super_admin", "/avatar.jpg"), /<img[^>]+src="\/avatar.jpg"/)
  assert.doesNotMatch(render("super_admin", "/avatar.jpg"), /<svg/)
})


test("workspace avatars are team marks rather than account ranks", () => {
  const html = renderToStaticMarkup(createElement(IdentityMark, {
    kind: "workspace", name: "Team", workspaceId: 1, role: "super_admin",
  }))
  assert.match(html, /lucide-users-round/)
  assert.doesNotMatch(html, /lucide-crown|rounded-full/)
})

test("workspace defaults do not collide within an account or change with list order", () => {
  const ids = [1, 7, 13, 19, 25, 31, 37, 43]
  const render = (workspaceId: number, workspaceIds: number[]) => renderToStaticMarkup(
    createElement(IdentityMark, { kind: "workspace", name: "Same name", workspaceId, workspaceIds }),
  )
  for (const id of ids) {
    assert.equal(render(id, ids), render(id, [...ids].reverse()))
    assert.equal(
      render(id, ids).replace(/ style="[^"]*"/, ""),
      render(ids[0]!, ids).replace(/ style="[^"]*"/, ""),
    )
    for (const other of ids.filter((value) => value !== id)) {
      assert.notEqual(render(id, ids), render(other, ids))
    }
  }
})
