import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { Children, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "@/components/ui/button"
import {
  ModelBatchPreview,
  WorkbenchModelDialog,
  type WorkbenchModelDialogProps,
} from "./workbench-model-dialog"
import { planModelBatch } from "./workbench-model"
import { idleLifecycle, instance, row, schema } from "./workbench-test-fixtures"

const field = schema.fields.find((entry) => entry.attribute_id === 9048)!

/**
 * SSR never mounts Base UI's portal, so the dialog is rendered through a
 * capture component and its element tree is walked (same technique as
 * `workbench-prose-editor.test.tsx`).
 */
function renderDialog(props: WorkbenchModelDialogProps) {
  let tree!: ReactElement
  function Capture() {
    tree = WorkbenchModelDialog(props)
    return null
  }
  renderToStaticMarkup(<Capture />)
  const pending: ReactNode[] = [tree]
  type Captured = ReactElement<{ children?: ReactNode; disabled?: boolean }>
  const elements: Captured[] = []
  while (pending.length) {
    const next = pending.pop()
    if (Array.isArray(next)) {
      pending.push(...next)
      continue
    }
    if (!isValidElement<{ children?: ReactNode; disabled?: boolean }>(next)) continue
    elements.push(next)
    pending.push(...Children.toArray(next.props.children))
  }
  const label = (node: ReactNode): string => {
    if (typeof node === "string" || typeof node === "number") return String(node)
    if (Array.isArray(node)) return node.map(label).join("")
    if (isValidElement<{ children?: ReactNode }>(node)) return label(node.props.children)
    return ""
  }
  return {
    elements,
    label,
    text: elements.map((element) => label(element.props.children)).join("\n"),
  }
}

function props(overrides: Partial<WorkbenchModelDialogProps> = {}): WorkbenchModelDialogProps {
  const written = row(1)
  const untouched = row(2)
  const sealed = row(3, { status: "sent" })
  return {
    open: true,
    onOpenChange: () => undefined,
    rows: [written, untouched, sealed],
    productDrafts: {
      [written.draftId]: instance(written),
      [untouched.draftId]: instance(untouched),
      [sealed.draftId]: instance(sealed, { ...idleLifecycle, stage: "accepted" }),
    },
    selectedRowIds: new Set([written.id, untouched.id, sealed.id]),
    field,
    onEditCell: () => undefined,
    onFlushRows: async () => true,
    ...overrides,
  }
}

test("型号 dialog names the three verbs and holds the write until a model is given", () => {
  const { elements, label, text } = renderDialog(props())

  assert.match(text, /批量设置型号/)
  for (const verb of ["设置共同型号", "加入已知型号", "恢复独立型号"]) {
    assert.match(text, new RegExp(verb))
  }
  // 设置共同型号 is open with an empty input: the preview asks for a value
  // instead of claiming every row has no model, and the button writes nothing —
  // an empty input never turns into a cleared 型号.
  assert.match(text, /选择或输入型号后才能写入/)

  const apply = elements.find(
    (element) => element.type === Button && label(element.props.children).startsWith("写入"),
  )
  assert.ok(apply, "missing the apply button")
  assert.equal(label(apply.props.children), "写入 0 行")
  assert.equal(apply.props.disabled, true)
})

test("the preview names the rows that take the write and the ones that refuse", () => {
  const written = row(1)
  const untouched = row(2)
  const sealed = row(3, { status: "sent" })
  const rows = [written, untouched, sealed]
  const productDrafts = {
    [written.draftId]: instance(written),
    [untouched.draftId]: instance(untouched),
    [sealed.draftId]: instance(sealed, { ...idleLifecycle, stage: "accepted" }),
  }
  const selectedRowIds = new Set(rows.map((entry) => entry.id))
  const plan = (mode: "common" | "independent") =>
    planModelBatch({ rows, productDrafts, selectedRowIds, field, mode, value: mode === "common" ? "SZ-COMMON" : undefined })

  assert.match(
    renderToStaticMarkup(<ModelBatchPreview plan={plan("common")} />),
    /将写入 2 行；1 行已上架，未写入/,
  )
  // 恢复独立型号 over the two open rows: every one takes its own value, so the
  // line carries no refusal clause at all.
  const independent = renderToStaticMarkup(
    <ModelBatchPreview
      plan={planModelBatch({
        rows,
        productDrafts,
        selectedRowIds: new Set([written.id, untouched.id]),
        field,
        mode: "independent",
      })}
    />,
  )
  assert.match(independent, /将写入 2 行<\/p>$/)
  assert.doesNotMatch(independent, /未写入/)
})

test("型号 dialog reports failures through notifyError, never into the page", () => {
  const source = readFileSync(new URL("./workbench-model-dialog.tsx", import.meta.url), "utf8")
  assert.match(source, /report: notifyError/)
  assert.doesNotMatch(source, /role="alert"/)
  assert.doesNotMatch(source, /\{error\}/)
})
