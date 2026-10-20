/**
 * Verification gate for specs/browser-owned-listing/slices/04-card-session.md:
 * open costs exactly one GET; sequential patches cost zero further GETs; a
 * CAS conflict costs exactly one GET plus one replayed PATCH; a repeat
 * conflict is reported as `card_conflict`; `verifySupplierOnce` collapses
 * repeat calls into one network request.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { closeCardSession, openCardSession, peekCardSession, primeCardSession, resetCardSessions, type CardPayloadView } from "./card-session"

const CARD_URL = (id: string) => `${route("listingCards")}/${id}`
const VERIFY_URL = (productId: string) =>
  route("mediaSupplierProductsByProductIdVerify", { product_id: productId })

function card(
  id: string,
  revision: number,
  payload: Record<string, unknown> = {},
): CardPayloadView {
  return {
    id,
    revision,
    title: "测试方案",
    store_id: null,
    updated_at_ms: 1,
    payload,
  } as CardPayloadView
}

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function conflictResponse(): Response {
  return new Response(JSON.stringify({ error: "上架方案已被他人更新，请刷新后重试", code: "CONFLICT" }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  })
}

/** Swaps `globalThis.fetch` for the test body, and always restores it after. */
async function withFetch<T>(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(input, init))) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

test("open costs exactly one GET, even opened twice for the same card", async () => {
  const id = "open-once"
  let gets = 0
  try {
    await withFetch((input, init) => {
      const url = String(input)
      assert.equal(url, CARD_URL(id))
      assert.equal(init?.method ?? "GET", "GET")
      gets += 1
      return envelope(card(id, 1))
    }, async () => {
      const [a, b] = await Promise.all([openCardSession(id), openCardSession(id)])
      assert.equal(a, b, "a card already opening is returned as-is, not re-GET")
      const c = await openCardSession(id)
      assert.equal(a, c)
    })
    assert.equal(gets, 1)
  } finally {
    closeCardSession(id)
  }
})

test("three sequential patches: three PATCH, zero further GETs", async () => {
  const id = "three-patches"
  let gets = 0
  let patches = 0
  let revision = 1
  try {
    const session = await withFetch(() => {
      gets += 1
      return envelope(card(id, revision, { defaults: { values: {}, complex_values: [] } }))
    }, () => openCardSession(id))
    assert.equal(gets, 1)

    await withFetch((input, init) => {
      assert.equal(String(input), CARD_URL(id))
      assert.equal(init?.method, "PATCH")
      const body = JSON.parse(String(init?.body))
      assert.equal(body.baseRevision, revision)
      patches += 1
      revision += 1
      return envelope(card(id, revision, body.payload))
    }, async () => {
      for (let i = 0; i < 3; i += 1) {
        await session.patch((current) => ({
          payload: { ...(current.payload as Record<string, unknown>), size: String(i) },
        }))
      }
    })
    assert.equal(patches, 3)
    assert.equal(gets, 1, "no GET must happen between or during the three patches")
    assert.equal(session.revision(), 4)
    assert.equal(peekCardSession(id), session)
    assert.equal(peekCardSession(id)?.card().revision, 4)
  } finally {
    closeCardSession(id)
  }
})

test("a CAS conflict costs one GET plus one replayed PATCH, then succeeds", async () => {
  const id = "conflict-once"
  let gets = 0
  let patches = 0
  try {
    const session = primeCardSession(card(id, 1, { title: "旧" }))
    await withFetch((input, init) => {
      const url = String(input)
      if (init?.method === "GET") {
        assert.equal(url, CARD_URL(id))
        gets += 1
        return envelope(card(id, 5, { title: "服务端最新" }))
      }
      assert.equal(init?.method, "PATCH")
      patches += 1
      const body = JSON.parse(String(init?.body))
      if (patches === 1) {
        assert.equal(body.baseRevision, 1, "the first attempt uses the session's stale revision")
        return conflictResponse()
      }
      assert.equal(patches, 2)
      assert.equal(body.baseRevision, 5, "the replay uses the freshly re-read revision")
      return envelope(card(id, 6, body.payload))
    }, async () => {
      const result = await session.patch((current) => ({
        payload: { ...(current.payload as Record<string, unknown>), size: "edited" },
      }))
      assert.equal(result.revision, 6)
    })
    assert.equal(gets, 1)
    assert.equal(patches, 2)
    assert.equal(session.revision(), 6)
    assert.equal(peekCardSession(id)?.revision(), 6)
  } finally {
    closeCardSession(id)
  }
})

test("a second conflict on the replay throws card_conflict instead of looping", async () => {
  const id = "conflict-twice"
  let gets = 0
  let patches = 0
  try {
    const session = primeCardSession(card(id, 1))
    await withFetch((input, init) => {
      if (init?.method === "GET") {
        gets += 1
        return envelope(card(id, 2))
      }
      patches += 1
      return conflictResponse()
    }, async () => {
      await assert.rejects(
        session.patch((current) => ({ payload: { ...(current.payload as Record<string, unknown>) } })),
        (reason: unknown) => {
          assert.equal((reason as { code?: string }).code, "card_conflict")
          return true
        },
      )
    })
    // One GET (the single re-read) and exactly two PATCH attempts (the
    // original conflict plus the one replay) — no unbounded retry loop.
    assert.equal(gets, 1)
    assert.equal(patches, 2)
  } finally {
    closeCardSession(id)
  }
})

test("verifySupplierOnce called three times issues exactly one network call", async () => {
  const id = "verify-once"
  const productId = "supplier-1"
  let verifications = 0
  try {
    const session = primeCardSession(card(id, 1, { supplierProductId: productId }))
    await withFetch((input, init) => {
      assert.equal(String(input), VERIFY_URL(productId))
      assert.equal(init?.method, "POST")
      verifications += 1
      return envelope({ productId, psdFileName: "template.psd", psdSha256: "abc123", videoCount: 2 })
    }, async () => {
      const [a, b, c] = await Promise.all([
        session.verifySupplierOnce(),
        session.verifySupplierOnce(),
        session.verifySupplierOnce(),
      ])
      assert.deepEqual(a, { productId, psdFileName: "template.psd", psdSha256: "abc123", videoCount: 2 })
      assert.deepEqual(a, b)
      assert.deepEqual(b, c)
    })
    assert.equal(verifications, 1)

    // A later call after the cached result already resolved must still be
    // free — this is the "打开/动词点击/发送各一次" scenario, not just the
    // in-flight de-dup above.
    await withFetch(() => {
      verifications += 1
      return envelope({ productId, psdFileName: "template.psd", psdSha256: "abc123", videoCount: 2 })
    }, () => session.verifySupplierOnce())
    assert.equal(verifications, 1)
  } finally {
    closeCardSession(id)
  }
})

test("verifySupplierOnce returns null for a card with no bound supplier product, without a network call", async () => {
  const id = "verify-non-supplier"
  let calls = 0
  try {
    const session = primeCardSession(card(id, 1))
    await withFetch(() => {
      calls += 1
      throw new Error("must not call verify for a non-supplier card")
    }, async () => {
      assert.equal(await session.verifySupplierOnce(), null)
    })
    assert.equal(calls, 0)
  } finally {
    closeCardSession(id)
  }
})

test("close() forgets the session: the next open re-GETs", async () => {
  const id = "close-reopens"
  let gets = 0
  const session = await withFetch(() => {
    gets += 1
    return envelope(card(id, 1))
  }, () => openCardSession(id))
  session.close()
  await withFetch(() => {
    gets += 1
    return envelope(card(id, 1))
  }, () => openCardSession(id))
  assert.equal(gets, 2, "closing a session must not be sticky across a later open")
})

test("a failed verification is not cached: the next call checks again", async () => {
  const id = "verify-retry"
  const productId = "supplier-2"
  let verifications = 0
  try {
    const session = primeCardSession(card(id, 1, { supplierProductId: productId }))
    await withFetch(() => {
      verifications += 1
      return new Response(JSON.stringify({ error: "供应商校验失败", code: "supplier_unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    }, async () => {
      await assert.rejects(session.verifySupplierOnce())
    })
    assert.equal(verifications, 1)

    await withFetch(() => {
      verifications += 1
      return envelope({ productId, psdFileName: "t.psd", psdSha256: "sha", videoCount: 0 })
    }, async () => {
      assert.ok(await session.verifySupplierOnce())
    })
    assert.equal(verifications, 2, "a retry after a failed check must hit the network again")
  } finally {
    closeCardSession(id)
  }
})

test("resident peek is synchronous and never fetches a missing or pending session; opening still coalesces one GET", async () => {
  const id = "peek-pending"
  let calls = 0
  let finish!: (response: Response) => void
  try {
    await withFetch(() => {
      calls++
      return new Promise<Response>((resolve) => { finish = resolve })
    }, async () => {
      assert.equal(peekCardSession(id), undefined)
      assert.equal(calls, 0)
      const opening = openCardSession(id), joining = openCardSession(id)
      assert.equal(opening, joining)
      assert.equal(peekCardSession(id), undefined)
      assert.equal(peekCardSession(id), undefined)
      assert.equal(calls, 1)
      finish(envelope(card(id, 3)))
      const session = await opening
      assert.equal(peekCardSession(id), session)
      assert.equal(peekCardSession(id)?.revision(), 3)
      assert.equal(calls, 1)
      session.close()
      assert.equal(peekCardSession(id), undefined)
      assert.equal(calls, 1)
    })
  } finally { closeCardSession(id) }
})

test("a late closed opening and old close cannot repopulate or evict the exact primed replacement", async () => {
  const id = "peek-replacement"
  let finish!: (response: Response) => void
  try {
    await withFetch(() => new Promise<Response>((resolve) => { finish = resolve }), async () => {
      const opening = openCardSession(id)
      closeCardSession(id)
      assert.equal(peekCardSession(id), undefined)
      const replacement = primeCardSession(card(id, 8))
      assert.equal(peekCardSession(id), replacement)
      finish(envelope(card(id, 1)))
      const old = await opening
      assert.notEqual(old, replacement)
      assert.equal(peekCardSession(id), replacement)
      old.close()
      old.close()
      assert.equal(peekCardSession(id), replacement)
      assert.equal(await openCardSession(id), replacement)
    })
  } finally { closeCardSession(id) }
})

test("reset invalidates resolved and pending resident entries without a late opening restoring them", async () => {
  const id = "peek-reset-pending", resolvedId = "peek-reset-resolved"
  let finish!: (response: Response) => void
  try {
    await withFetch(() => new Promise<Response>((resolve) => { finish = resolve }), async () => {
      const opening = openCardSession(id)
      primeCardSession(card(resolvedId, 2))
      resetCardSessions()
      assert.equal(peekCardSession(resolvedId), undefined)
      assert.equal(peekCardSession(id), undefined)
      finish(envelope(card(id, 1)))
      const stale = await opening
      assert.equal(peekCardSession(id), undefined)
      const current = primeCardSession(card(id, 4))
      stale.close()
      assert.equal(peekCardSession(id), current)
    })
  } finally { closeCardSession(id); closeCardSession(resolvedId) }
})

test("resident peek fails closed for a response naming another Card", async () => {
  const id = "peek-foreign"
  try {
    await withFetch(() => envelope(card("different-card", 1)), async () => {
      await openCardSession(id)
      assert.equal(peekCardSession(id), undefined)
    })
  } finally { closeCardSession(id) }
})

test("identity invalidation fences resolved and pending Cards; a fresh opening does not reuse the old account", async () => {
  const id = "peek-account-pending", resolvedId = "peek-account-resolved"
  let finish!: (response: Response) => void, gets = 0
  try {
    await withFetch(() => {
      if (++gets === 1) return new Promise<Response>((resolve) => { finish = resolve })
      return envelope(card(id, 9))
    }, async () => {
      const opening = openCardSession(id)
      primeCardSession(card(resolvedId, 2))
      invalidateAllSessionCaches()
      assert.equal(peekCardSession(resolvedId), undefined)
      assert.equal(peekCardSession(id), undefined)
      finish(envelope(card(id, 1)))
      const stale = await opening
      assert.equal(peekCardSession(id), undefined, "a prior identity's late GET is not resident authority")
      const current = await openCardSession(id)
      assert.notEqual(current, stale)
      assert.equal(gets, 2)
      assert.equal(peekCardSession(id), current)
      stale.close()
      assert.equal(peekCardSession(id)?.revision(), 9)
    })
  } finally { closeCardSession(id); closeCardSession(resolvedId) }
})
