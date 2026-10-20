import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import type { AccountOverview, WorkflowAiCandidate, WorkflowDraftView } from "@/bindings/commands"
import { toast } from "@/components/ui/toast"
import { invalidateAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"
import { resetCardSessions } from "../card/card-session"
import type { ListingRow } from "../model/listing-row"
import {
  createPreparationTracks,
  NO_GUIDED_PREPARATION,
  type GuidedPreparation,
  type PreparationActivity,
} from "../prepare/preparation-tracks"
import {
  patchListingWorkbench,
  peekListingWorkbench,
  resetListingWorkbench,
} from "../workbench/listing-workbench-store"
import { preparationBlockedRows, publishPreflight } from "./publish-policy"
import { usePublishQueue } from "./use-publish-queue"

/**
 * The standing a signed-in shell already holds. No active Workspace, so the
 * cache keeps error telemetry paused and the fixture adds no request.
 */
const SIGNED_IN: AccountOverview = {
  session: { authenticated: true },
  workspaces: [],
  owned_count: 0,
  owned_limit: 0,
}
const NOT_LOADED = "账户状态尚未载入，请完成登录后再发送。"

function modelRow(id: string, overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    id,
    draftId: `draft-${id}`,
    imageName: `${id}.png`,
    status: "pending",
    ai: "idle",
    render: "idle",
    upload: "idle",
    log: "",
    ...overrides,
  }
}

const NO_GUIDED: GuidedPreparation = { ...NO_GUIDED_PREPARATION }

function activityOf(overrides: Partial<Record<keyof PreparationActivity, string[]>>): PreparationActivity {
  return {
    ai: new Set(overrides.ai ?? []),
    render: new Set(overrides.render ?? []),
    deliver: new Set(overrides.deliver ?? []),
  }
}

const UNRESOLVED = { state: "unresolved" } as unknown as WorkflowAiCandidate

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 })
}

type SetupOptions = {
  flushFor?: (draftIds: readonly string[]) => Promise<boolean>
  fetch?: (path: string, init?: RequestInit) => Promise<Response>
  /** The shell's cached standing; `null` is a tab that has not loaded one. */
  account?: AccountOverview | null
  /** A supplier card verifies its media over HTTP once the flush passes. */
  supplierProductId?: string
}

function setup(options: SetupOptions = {}) {
  resetListingWorkbench()
  resetCardSessions()
  invalidateAccountOverview()
  const account = options.account === undefined ? SIGNED_IN : options.account
  if (account) rememberAccountOverview(account)
  patchListingWorkbench({ rows: [modelRow("A"), modelRow("B")], queueFrozenIds: ["draft-B"] })
  const tracks = { current: createPreparationTracks() }
  const guidedLock = { current: false }
  const flushed: string[][] = []
  let wholeCardFlushes = 0
  const fetched: string[] = []
  const notices: string[] = []
  const previousAdd = toast.add
  toast.add = ((notice: { title?: unknown }) => {
    notices.push(String(notice.title))
    return "notice"
  }) as typeof toast.add
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    fetched.push(path)
    if (options.fetch) return options.fetch(path, init)
    throw new Error("the gate test never reaches HTTP")
  }) as typeof fetch
  let hook!: ReturnType<typeof usePublishQueue>
  function Capture() {
    hook = usePublishQueue({
      cardTemplateId: "card",
      supplierProductId: options.supplierProductId,
      busy: false,
      storeConfigured: true,
      preparationTracks: tracks,
      guidedPreparationLock: guidedLock,
      flushAutosave: async () => {
        wholeCardFlushes += 1
        return false
      },
      flushAutosavesFor: async (draftIds) => {
        flushed.push([...draftIds])
        return options.flushFor ? options.flushFor(draftIds) : false
      },
    })
    return null
  }
  renderToStaticMarkup(<Capture />)
  return {
    hook,
    tracks,
    guidedLock,
    flushed,
    wholeCardFlushes: () => wholeCardFlushes,
    fetched,
    fetchCalls: () => fetched.length,
    notices,
    restore() {
      globalThis.fetch = previousFetch
      toast.add = previousAdd
      invalidateAccountOverview()
      resetCardSessions()
      resetListingWorkbench()
    },
  }
}

/** Nothing flushed, nothing requested, and no flight left claimed. */
function assertLocalRefusal(fx: ReturnType<typeof setup>) {
  assert.deepEqual(fx.flushed, [])
  assert.equal(fx.wholeCardFlushes(), 0)
  assert.equal(fx.fetchCalls(), 0)
  assert.equal(fx.hook.submissionPending(), false)
  assert.equal(peekListingWorkbench().queueRunning, false)
}

test("an explicit selection sends while another row is preparing", async () => {
  const fx = setup()
  try {
    fx.tracks.current.claim("render", ["A"])
    await fx.hook.startPublish(["B"])
    assert.deepEqual(fx.flushed, [["draft-B"]])
    assert.equal(fx.wholeCardFlushes(), 0)
    assert.equal(fx.fetchCalls(), 0)
  } finally {
    fx.restore()
  }
})

test("a selected row that is itself preparing stays blocked", async () => {
  const fx = setup()
  try {
    fx.tracks.current.claim("render", ["A"])
    await fx.hook.startPublish(["A"])
    assert.deepEqual(fx.flushed, [])
    assert.equal(fx.wholeCardFlushes(), 0)
    assert.equal(fx.fetchCalls(), 0)
  } finally {
    fx.restore()
  }
})

test("the queue's own continuation still answers for the whole card", async () => {
  const fx = setup()
  try {
    fx.tracks.current.claim("ai", ["A"])
    await fx.hook.startPublish()
    assert.deepEqual(fx.flushed, [])
    assert.equal(fx.wholeCardFlushes(), 0)
    assert.equal(fx.fetchCalls(), 0)
  } finally {
    fx.restore()
  }
})

test("a running guided batch only blocks the rows it planned", async () => {
  const fx = setup()
  try {
    patchListingWorkbench({
      guidedPreparation: { active: true, total: 1, rowIds: ["A"], stopRequested: false },
    })
    fx.guidedLock.current = true
    await fx.hook.startPublish(["B"])
    assert.deepEqual(fx.flushed, [["draft-B"]])
  } finally {
    fx.restore()
  }
})

test("a selected row inside the running guided batch stays blocked", async () => {
  const fx = setup()
  try {
    patchListingWorkbench({
      guidedPreparation: { active: true, total: 1, rowIds: ["A"], stopRequested: false },
    })
    fx.guidedLock.current = true
    await fx.hook.startPublish(["A"])
    assert.deepEqual(fx.flushed, [])
  } finally {
    fx.restore()
  }
})

test("a guided lock without planned rows still blocks the whole card", async () => {
  const fx = setup()
  try {
    fx.guidedLock.current = true
    await fx.hook.startPublish(["B"])
    assert.deepEqual(fx.flushed, [])
  } finally {
    fx.restore()
  }
})

test("an empty queue continuation is refused locally", async () => {
  const fx = setup()
  try {
    patchListingWorkbench({ queueFrozenIds: [] })
    await fx.hook.startPublish()
    assertLocalRefusal(fx)
  } finally {
    fx.restore()
  }
})

test("an explicit empty selection never widens to the frozen queue", async () => {
  const fx = setup()
  try {
    await fx.hook.startPublish([])
    assertLocalRefusal(fx)
  } finally {
    fx.restore()
  }
})

test("an unconfirmed AI candidate is refused locally and focused", async () => {
  const fx = setup()
  try {
    patchListingWorkbench({ rows: [modelRow("A"), modelRow("B", { candidates: [UNRESOLVED] })] })
    await fx.hook.startPublish(["B"])
    assertLocalRefusal(fx)
    assert.deepEqual(peekListingWorkbench().selectedIds, ["B"])
  } finally {
    fx.restore()
  }
})

test("a duplicate offer ID from source stems is refused locally", async () => {
  const fx = setup()
  try {
    patchListingWorkbench({
      rows: [modelRow("A", { imageName: "same.png" }), modelRow("B", { imageName: "same.jpg" })],
    })
    await fx.hook.startPublish(["A", "B"])
    assertLocalRefusal(fx)
  } finally {
    fx.restore()
  }
})

test("a missing offer ID is refused locally", async () => {
  const fx = setup()
  try {
    patchListingWorkbench({ rows: [modelRow("A", { imageName: "" }), modelRow("B")] })
    await fx.hook.startPublish(["A"])
    assertLocalRefusal(fx)
  } finally {
    fx.restore()
  }
})

test("a blocker introduced during the flush is refused before supplier verification", async () => {
  const fx = setup({
    supplierProductId: "online-product",
    flushFor: async () => {
      patchListingWorkbench((current) => ({
        rows: current.rows.map((row) => row.id === "B" ? { ...row, candidates: [UNRESOLVED] } : row),
      }))
      return true
    },
  })
  try {
    await fx.hook.startPublish(["B"])
    assert.deepEqual(fx.flushed, [["draft-B"]])
    assert.deepEqual(fx.fetched, [])
    assert.deepEqual(peekListingWorkbench().selectedIds, ["B"])
    assert.equal(fx.hook.submissionPending(), false)
    assert.equal(peekListingWorkbench().queueRunning, false)
  } finally {
    fx.restore()
  }
})

test("a tab without a loaded account standing refuses before any flush or request", async () => {
  const fx = setup({ account: null, flushFor: async () => true })
  try {
    await fx.hook.startPublish(["B"])
    assertLocalRefusal(fx)
    assert.deepEqual(fx.notices, [NOT_LOADED])
  } finally {
    fx.restore()
  }
})

test("a sign-out during the flush is refused before supplier verification", async () => {
  const fx = setup({
    supplierProductId: "online-product",
    flushFor: async () => {
      invalidateAccountOverview()
      return true
    },
  })
  try {
    await fx.hook.startPublish(["B"])
    assert.deepEqual(fx.flushed, [["draft-B"]])
    assert.deepEqual(fx.fetched, [])
    assert.deepEqual(fx.notices, [NOT_LOADED])
    assert.equal(fx.hook.submissionPending(), false)
    assert.equal(peekListingWorkbench().queueRunning, false)
  } finally {
    fx.restore()
  }
})

test("a frozen queue id whose row is gone targets nothing", async () => {
  const fx = setup({ flushFor: async () => true })
  try {
    patchListingWorkbench({ queueFrozenIds: ["draft-gone"] })
    await fx.hook.startPublish()
    assertLocalRefusal(fx)
  } finally {
    fx.restore()
  }
})

for (const blocker of ["candidate", "sign-out"] as const) {
  test(`a ${blocker} landing during the queue save stops the dispatch without stuck rows`, async () => {
    const cardPath = route("listingCardsById", { id: "card" })
    const rowsPath = route("listingRows")
    const fx = setup({
      flushFor: async () => true,
      fetch: async (path, init) => {
        const { pathname } = new URL(path, "http://localhost")
        if (pathname === cardPath && init?.method === "PATCH") {
          if (blocker === "candidate") {
            patchListingWorkbench((current) => ({
              rows: current.rows.map((row) => row.id === "B" ? { ...row, candidates: [UNRESOLVED] } : row),
            }))
          } else invalidateAccountOverview()
          return jsonResponse({ id: "card", revision: 2, payload: {}, updatedAtMs: 2 })
        }
        if (pathname === cardPath) return jsonResponse({ id: "card", revision: 1, payload: {}, updatedAtMs: 1 })
        if (pathname === rowsPath) return jsonResponse({ items: [], nextCursor: null })
        throw new Error(`dispatch must not be reached: ${path}`)
      },
    })
    try {
      await fx.hook.startPublish(["B"])
      assert.deepEqual(fx.flushed, [["draft-B"]])
      assert.equal(fx.fetched.some((path) => new URL(path, "http://localhost").pathname === cardPath), true, "the queue save ran")
      assert.equal(fx.fetched.some((path) => path.includes("/batch/")), false)
      const row = peekListingWorkbench().rows.find((item) => item.id === "B")!
      assert.equal(row.status, "pending")
      assert.equal(row.log, "")
      assert.equal(fx.hook.submissionPending(), false)
      assert.equal(peekListingWorkbench().queueRunning, false)
      assert.equal(fx.notices.at(-1), blocker === "candidate"
        ? "图片 B.png 仍有未确认的 AI 候选，队列未启动。"
        : NOT_LOADED)
    } finally {
      fx.restore()
    }
  })
}

test("publishPreflight answers for the account, then listed rows in queue order", () => {
  const workbench = {
    rows: [modelRow("A"), modelRow("B")],
    productDrafts: {},
    queueFrozenIds: ["draft-gone", "draft-B", "draft-A", "draft-B"],
  }
  const ready = publishPreflight(workbench, undefined, SIGNED_IN)
  assert.deepEqual(ready.ok ? ready.draftIds : ready, ["draft-B", "draft-A"])
  assert.deepEqual(publishPreflight({ ...workbench, queueFrozenIds: ["draft-gone"] }, undefined, SIGNED_IN),
    { ok: false, message: "没有可发送的商品。" })
  assert.deepEqual(publishPreflight(workbench, undefined, null), { ok: false, message: NOT_LOADED })
  assert.deepEqual(publishPreflight(workbench, undefined, { session: { authenticated: false } }),
    { ok: false, message: "尚未登录，请先登录后再发送。" })
})

test("a locally ineligible repair never flushes or reads Cloud", async () => {
  const fx = setup()
  try {
    await fx.hook.repairRows(["A"])
    assert.deepEqual(fx.flushed, [])
    assert.equal(fx.fetchCalls(), 0)
  } finally {
    fx.restore()
  }
})

test("an eligible legacy repair without native capability stays manual and never calls retired endpoints", async () => {
  const fx = setup()
  try {
    patchListingWorkbench({
      rows: [
        modelRow("A", { readiness: { blockers: ["publish_conflict"] } as unknown as ListingRow["readiness"] }),
        modelRow("B"),
      ],
      productDrafts: {
        "draft-A": {
          draft_id: "draft-A",
          lifecycle: {
            view_revision: 1,
            stage: "publish_rejected",
            last_error_code: "BR_hashtag_brand",
            ai: "ready",
            media: "ready",
          },
        } as unknown as WorkflowDraftView,
      },
    })
    await fx.hook.repairRows(["A", "B"])
    assert.deepEqual(fx.flushed, [])
    assert.match(fx.notices.at(-1)!, /未接入一键原生修复/)
    assert.equal(fx.fetchCalls(), 0)
  } finally {
    fx.restore()
  }
})

test("repeat cancel clicks for one draft share a single intent scan", async () => {
  const pending: Array<() => void> = []
  const fx = setup({
    // Intent list reads stay open until `release`, so repeat clicks overlap.
    fetch: () => new Promise<Response>((resolve) => {
      pending.push(() => resolve(jsonResponse({ items: [], nextCursor: null })))
    }),
  })
  const release = () => { for (const resolve of pending.splice(0)) resolve() }
  const reads = (draftId: string) => fx.fetched.filter((path) => path.includes(`rowId=${draftId}&`)).length
  try {
    const first = fx.hook.cancelRowIntent("draft-A")
    let secondSettled = false
    const second = fx.hook.cancelRowIntent("draft-A").then(() => { secondSettled = true })
    const other = fx.hook.cancelRowIntent("draft-B")
    await fx.hook.cancelRowIntent("  ")
    await Promise.resolve()
    assert.equal(secondSettled, true)
    assert.equal(reads("draft-A"), 1)
    assert.equal(reads("draft-B"), 1)
    assert.equal(fx.fetchCalls(), 2)
    release()
    await Promise.all([first, second, other])
    assert.equal(reads("draft-A"), 1)

    const again = fx.hook.cancelRowIntent("draft-A")
    release()
    await again
    assert.equal(reads("draft-A"), 2)
  } finally {
    fx.restore()
  }
})

test("preparationBlockedRows answers for the selection or the whole card", () => {
  const rows = [{ id: "A" }, { id: "B" }]
  const busy = activityOf({ ai: ["A"] })
  assert.deepEqual(preparationBlockedRows(rows, new Set(["B"]), busy, NO_GUIDED), [])
  assert.deepEqual(preparationBlockedRows(rows, new Set(["A"]), busy, NO_GUIDED), ["A"])
  assert.deepEqual(preparationBlockedRows(rows, undefined, busy, NO_GUIDED), ["A"])
  assert.deepEqual(preparationBlockedRows(rows, new Set(["A", "B"]), busy, NO_GUIDED), ["A"])
  const guided: GuidedPreparation = { active: true, total: 2, rowIds: ["A"], stopRequested: false }
  assert.deepEqual(preparationBlockedRows(rows, new Set(["B"]), activityOf({}), guided), [])
  assert.deepEqual(preparationBlockedRows(rows, new Set(["A"]), activityOf({}), guided), ["A"])
})
