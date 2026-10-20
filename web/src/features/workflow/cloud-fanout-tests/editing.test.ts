/** Real Hook callbacks, command adapters and HTTP boundaries. SSR supplies React's
 * refs; these checks cover explicit actions, not mounted effects or rerenders. */
import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { useRowAutosaves } from "../editing/use-row-autosaves"
import {
  patchListingWorkbench,
  peekListingWorkbench,
  resetListingWorkbench,
} from "../workbench/listing-workbench-store"
import { product } from "./fixtures"

test("row editing uses the current category fields while preserving the existing Draft", () => {
  resetListingWorkbench()
  const saved = product("current-fields")
  const schema = { ...saved.schema, fields: [...saved.schema.fields, {
    ...saved.schema.fields[0]!, key: "attribute_4191", attribute_id: 4191, source: "attribute" as const,
  }] }
  patchListingWorkbench({ productDrafts: { [saved.draft_id]: saved } })
  let hook!: ReturnType<typeof useRowAutosaves>
  function Capture() {
    hook = useRowAutosaves({ schema })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: () => 1, clearTimeout() {} } })
  try {
    hook.editRowCell(saved.draft_id, "description", "最新字段内容")
    const draft = peekListingWorkbench().productDrafts[saved.draft_id]!.draft
    assert.deepEqual(draft.values.attribute_4191, { kind: "text", value: "最新字段内容" })
    assert.deepEqual(draft.values.offer_id, saved.draft.values.offer_id)
    assert.equal(saved.draft.values.attribute_4191, undefined)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    resetListingWorkbench()
  }
})

test("a picked dictionary value is written onto the row exactly as it stands", () => {
  resetListingWorkbench()
  const saved = product("theme-fields")
  const schema = { ...saved.schema, fields: [...saved.schema.fields, {
    ...saved.schema.fields[0]!, key: "attribute_7109", attribute_id: 7109, source: "attribute" as const,
    editor: "multi_select" as const,
  }] }
  patchListingWorkbench({ productDrafts: { [saved.draft_id]: saved } })
  let hook!: ReturnType<typeof useRowAutosaves>
  function Capture() {
    hook = useRowAutosaves({ schema })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: () => 1, clearTimeout() {} } })
  try {
    hook.editRowField(saved.draft_id, "attribute_7109", {
      kind: "multi_select",
      value: [{ dictionary_value_id: 970742650, value: "花卉和植物" }],
    }, {})
    const draft = peekListingWorkbench().productDrafts[saved.draft_id]!.draft
    // The dictionary id travels with the label: nothing here rebuilds text, and
    // the row keeps everything the operator did not touch.
    assert.deepEqual(draft.values.attribute_7109, {
      kind: "multi_select",
      value: [{ dictionary_value_id: 970742650, value: "花卉和植物" }],
    })
    assert.deepEqual(draft.values.offer_id, saved.draft.values.offer_id)
    assert.equal(saved.draft.values.attribute_7109, undefined)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    resetListingWorkbench()
  }
})

test("a typed price lands on the row as a decimal", () => {
  resetListingWorkbench()
  const saved = product("price-fields")
  patchListingWorkbench({ productDrafts: { [saved.draft_id]: saved } })
  let hook!: ReturnType<typeof useRowAutosaves>
  function Capture() {
    hook = useRowAutosaves({ schema: saved.schema })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: () => 1, clearTimeout() {} } })
  try {
    hook.editRowField(saved.draft_id, "price", { kind: "decimal", value: 1500 }, {})
    // A decimal, not a string: the send overlay and the validator both read the
    // typed price as the row value that beats the card default.
    assert.deepEqual(
      peekListingWorkbench().productDrafts[saved.draft_id]!.draft.values.price,
      { kind: "decimal", value: 1500 },
    )
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    resetListingWorkbench()
  }
})

test("a typed field marks hand_edited_keys at once; rewriting the seeded value does not", () => {
  resetListingWorkbench()
  const typed = product("typed-row")
  const seeded = product("seeded-row")
  // seed_gaps baked the card default in at creation: a value is present, yet
  // nothing was ever typed on this row.
  seeded.draft.values.price = { kind: "decimal", value: 100 }
  patchListingWorkbench({
    productDrafts: {
      [typed.draft_id]: typed,
      [seeded.draft_id]: seeded,
    },
  })
  let hook!: ReturnType<typeof useRowAutosaves>
  function Capture() {
    hook = useRowAutosaves({ schema: typed.schema })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: () => 1, clearTimeout() {} } })
  try {
    hook.editRowField(typed.draft_id, "price", { kind: "decimal", value: 1500 }, {})
    assert.equal(
      peekListingWorkbench().productDrafts[typed.draft_id]!.hand_edited_keys?.includes("price"),
      true,
      "the typed echo reads as this row's own price before the PATCH answers",
    )
    hook.editRowField(seeded.draft_id, "price", { kind: "decimal", value: 100 }, {})
    assert.equal(
      peekListingWorkbench().productDrafts[seeded.draft_id]!.hand_edited_keys?.includes("price") ?? false,
      false,
      "retyping the seeded copy is no diff — the server would not mark it either",
    )
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    resetListingWorkbench()
  }
})
