import assert from "node:assert/strict"
import test from "node:test"
import {
  cellEditKey,
  displayedCellValue,
  formatTagString,
  keepLocalAiTags,
  parseTagString,
  planProseColumnFill,
  proseScopeCopy,
  proseSkipCopy,
} from "./workbench-cell-edit"

test("an in-progress edit is not clobbered by a later filled-value rerender", () => {
  const filled = "Постер с морем"
  const typed = "Постер с морем (правка)"

  assert.equal(displayedCellValue(true, typed, filled), typed)
  assert.equal(displayedCellValue(true, typed, filled), "Постер с морем (правка)")
  assert.equal(
    displayedCellValue(false, typed, "Новое имя с AI"),
    "Новое имя с AI",
    "a new recognition may overwrite once the cell is not being edited",
  )
})

test("tags round-trip as a space-separated #tag string", () => {
  assert.equal(formatTagString(["море", "#постер", "  "]), "#море #постер")
  assert.deepEqual(parseTagString("#море #постер декор"), ["море", "постер", "декор"])
  assert.deepEqual(parseTagString(""), [])
})

test("Enter commits a single-line cell; Cmd/Ctrl-Enter commits multiline; Esc cancels", () => {
  assert.equal(cellEditKey("Enter", { multiline: false, metaKey: false, ctrlKey: false }), "commit")
  assert.equal(cellEditKey("Enter", { multiline: true, metaKey: false, ctrlKey: false }), null)
  assert.equal(cellEditKey("Enter", { multiline: true, metaKey: true, ctrlKey: false }), "commit")
  assert.equal(cellEditKey("Enter", { multiline: true, metaKey: false, ctrlKey: true }), "commit")
  assert.equal(cellEditKey("Escape", { multiline: true, metaKey: false, ctrlKey: false }), "cancel")
  assert.equal(cellEditKey("Tab", { multiline: false, metaKey: false, ctrlKey: false }), null)
})

test("a host lifecycle refresh keeps operator tag edits from the same recognition", () => {
  const current = {
    revision: 2,
    ai_summary: { tags: ["море", "правка"], model: "test" },
  }
  const incoming = {
    revision: 3,
    ai_summary: { tags: ["море", "постер"], model: "test" },
  }
  assert.deepEqual(keepLocalAiTags(current, incoming).ai_summary?.tags, ["море", "правка"])
  assert.equal(keepLocalAiTags(current, incoming).revision, 3)
})

test("a missing incoming summary does not drop tags the operator already typed", () => {
  const current = {
    revision: 1,
    ai_summary: { tags: ["ручная"], model: "" },
  }
  const incoming: { revision: number; ai_summary?: { tags: string[]; model: string } } = {
    revision: 2,
  }
  assert.deepEqual(keepLocalAiTags(current, incoming).ai_summary?.tags, ["ручная"])
})

test("column fill writes the selection, skips sealed and running rows, and can spare occupied cells", () => {
  const opened = {
    draftId: "a",
    writable: true,
    empty: false,
    skip: null,
  }
  const filled = {
    draftId: "b",
    writable: true,
    empty: false,
    skip: null,
  }
  const blank = {
    draftId: "c",
    writable: true,
    empty: true,
    skip: null,
  }
  const sealed = {
    draftId: "d",
    writable: false,
    empty: true,
    skip: "sealed" as const,
  }
  const recognising = {
    draftId: "e",
    writable: false,
    empty: true,
    skip: "ai" as const,
  }
  const overwrite = planProseColumnFill({
    selected: true,
    openedDraftId: "seed",
    emptyOnly: false,
    rows: [opened, filled, blank, sealed, recognising],
  })
  assert.deepEqual(overwrite.writeDraftIds, ["a", "b", "c"])
  assert.equal(overwrite.sameAsOpened, false)
  assert.equal(proseScopeCopy(overwrite), "写入已选 5 行")
  assert.equal(proseSkipCopy(overwrite.skip), "1 行已上架、1 行识别中，未写入")

  const emptyOnly = planProseColumnFill({
    selected: false,
    openedDraftId: "a",
    emptyOnly: true,
    rows: [opened, filled, blank],
  })
  assert.deepEqual(emptyOnly.writeDraftIds, ["c"])
  assert.equal(proseScopeCopy(emptyOnly), "写入全部可改 3 行")
  assert.equal(proseSkipCopy(emptyOnly.skip), "2 行已有内容，未写入")

  const oneCell = planProseColumnFill({
    selected: false,
    openedDraftId: "a",
    emptyOnly: false,
    rows: [opened],
  })
  assert.equal(oneCell.sameAsOpened, true)
  assert.deepEqual(oneCell.writeDraftIds, ["a"])
})
