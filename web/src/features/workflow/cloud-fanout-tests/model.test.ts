/** 型号 batch verbs over the real row autosave, the real command adapter and the
 * real HTTP boundary: one PATCH per written row, nothing invented for a refused
 * one, and the written value — never the file-name fallback — is what the row's
 * own draft carries. */
import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import type {
  WorkflowCategoryDraft,
  WorkflowDraftView,
} from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import { useRowAutosaves } from "../editing/use-row-autosaves"
import type { ListingRow } from "../model/listing-row"
import {
  planModelBatch,
  runModelBatch,
  type ModelBatchMode,
} from "../workbench/workbench-model"
import {
  patchListingWorkbench,
  peekListingWorkbench,
  resetListingWorkbench,
} from "../workbench/listing-workbench-store"
import { idleLifecycle, instance, row as rowFixture, schema } from "../workbench/workbench-test-fixtures"
import { cloudRow } from "./fixtures"

/** The 型号 field of the fixture schema — a live schema names it `attribute_9048`. */
const field = schema.fields.find((entry) => entry.attribute_id === 9048)!

type PatchBody = {
  baseRevision: number
  draft: WorkflowCategoryDraft
}

type Patch = { id: string; url: string; method: string; body: PatchBody }

function modelOf(patch: Patch): string {
  const value = patch.body.draft.values[field.key]
  return value?.kind === "text" ? value.value : ""
}

/** One selected cohort over the shared four-column workbench store. */
function installRows(ids: readonly string[]) {
  const rows: ListingRow[] = ids.map((id) =>
    rowFixture(0, { id, draftId: id, imageName: `${id}.png` }),
  )
  const drafts: Record<string, WorkflowDraftView> = Object.fromEntries(
    rows.map((entry) => [entry.draftId, instance(entry)]),
  )
  patchListingWorkbench({ rows, productDrafts: drafts })
  let hook!: ReturnType<typeof useRowAutosaves>
  function Capture() {
    hook = useRowAutosaves({ schema })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  const patches: Patch[] = []
  const reports: string[] = []
  const stored = new Map<string, ListingRowView>(
    ids.map((id) => [id, cloudRow(id)]),
  )
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout },
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const id = url.split("/").at(-1)!
    const body = JSON.parse(String(init?.body)) as PatchBody
    patches.push({ id, url, method: init?.method ?? "GET", body })
    const current = stored.get(id)!
    const saved: ListingRowView = {
      ...current,
      revision: current.revision + 1,
      view_revision: current.view_revision + 1,
      draft: body.draft,
      payload: {
        ...(current.payload as Record<string, unknown>),
        handEditedKeys: [field.key],
      },
    }
    stored.set(id, saved)
    return new Response(JSON.stringify({ data: saved }), {
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return {
    rows,
    patches,
    reports,
    /** Run one verb exactly as the dialog does: plan, one-row edits, flush. */
    run: (mode: ModelBatchMode, selected: readonly string[], value?: string) =>
      runModelBatch({
        plan: planModelBatch({
          rows: peekListingWorkbench().rows,
          productDrafts: peekListingWorkbench().productDrafts,
          selectedRowIds: new Set(selected),
          field,
          mode,
          value,
        }),
        edit: (draftId, model) => hook.editRowCell(draftId, "model", model),
        flush: (draftIds) => hook.flushRowsFor(draftIds),
        report: (message) => reports.push(message),
      }),
    restore() {
      hook.resetRowAutosaves()
      globalThis.fetch = originalFetch
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
      resetListingWorkbench()
    },
  }
}

test("每个型号批量动作只 PATCH 选中行，写入自己算出的值", async () => {
  const fixture = installRows(["row-a", "row-b", "row-c"])
  const selected = ["row-a", "row-b"]
  try {
    // 设置共同型号
    await fixture.run("common", selected, "  SZ-COMMON  ")
    assert.deepEqual(
      fixture.patches.map((patch) => [patch.id, patch.method, modelOf(patch)]),
      [
        ["row-a", "PATCH", "SZ-COMMON"],
        ["row-b", "PATCH", "SZ-COMMON"],
      ],
      "one PATCH per selected row, and the unselected row is never written",
    )
    for (const patch of fixture.patches) {
      assert.equal(patch.url, `${route("listingRows")}/${patch.id}`)
      assert.equal(typeof patch.body.baseRevision, "number")
    }
    assert.deepEqual(fixture.reports, [])

    // 加入已知型号：本卡已经在用的型号
    fixture.patches.length = 0
    await fixture.run("join", selected, "SZ-ART-01")
    assert.deepEqual(
      fixture.patches.map((patch) => modelOf(patch)),
      ["SZ-ART-01", "SZ-ART-01"],
    )

    // 恢复独立型号：新写一个固定值，不是清空——清空会被下一次构建用文件名填回
    fixture.patches.length = 0
    await fixture.run("independent", selected)
    assert.deepEqual(
      fixture.patches.map((patch) => [patch.id, modelOf(patch)]),
      [
        ["row-a", "row-a"],
        ["row-b", "row-b"],
      ],
    )
    for (const patch of fixture.patches) {
      assert.equal(
        (patch.body.draft.cleared ?? []).includes(field.key),
        false,
        "恢复独立型号 must not leave a cleared 型号 behind",
      )
    }
    // The explicit value is the row's own answer now, so the send overlay's
    // manual-wins boundary keeps it and the injector leaves it alone.
    assert.equal(
      peekListingWorkbench().productDrafts["row-a"]?.draft.values[field.key]?.value,
      "row-a",
    )
  } finally {
    fixture.restore()
  }
})

test("部分失败只报一次错：成功的行照常落盘，封存的行不发 PATCH", async () => {
  const fixture = installRows(["row-open", "row-sealed"])
  // A patch of `productDrafts` replaces the set, so the open row rides along.
  const bases = peekListingWorkbench().productBases
  patchListingWorkbench({
    productDrafts: {
      ...bases,
      ["row-sealed"]: {
        ...bases["row-sealed"]!,
        lifecycle: { ...idleLifecycle, stage: "accepted" },
      },
    },
  })
  try {
    await fixture.run("common", ["row-open", "row-sealed"], "SZ-COMMON")
    assert.deepEqual(
      fixture.patches.map((patch) => [patch.id, modelOf(patch)]),
      [["row-open", "SZ-COMMON"]],
    )
    assert.deepEqual(fixture.reports, ["1 行未写入：row-sealed.png（已上架）"])
    assert.equal(
      peekListingWorkbench().productDrafts["row-open"]?.draft.values[field.key]?.value,
      "SZ-COMMON",
      "the successful row is not rolled back by the refused one",
    )
    assert.equal(
      peekListingWorkbench().productDrafts["row-sealed"]?.draft.values[field.key],
      undefined,
    )
  } finally {
    fixture.restore()
  }
})

test("全是封存行时不发任何 PATCH，只报逐项失败", async () => {
  const fixture = installRows(["row-sealed"])
  const bases = peekListingWorkbench().productBases
  patchListingWorkbench({
    productDrafts: {
      ["row-sealed"]: {
        ...bases["row-sealed"]!,
        lifecycle: { ...idleLifecycle, stage: "operator_attested" },
      },
    },
  })
  try {
    await fixture.run("common", ["row-sealed"], "SZ-COMMON")
    assert.deepEqual(fixture.patches, [])
    assert.deepEqual(fixture.reports, ["1 行未写入：row-sealed.png（已上架）"])
  } finally {
    fixture.restore()
  }
})
