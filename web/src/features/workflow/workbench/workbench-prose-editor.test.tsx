import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { Children, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Textarea } from "@/components/ui/textarea"
import { ProseDraftValidation, WorkbenchProseEditor } from "./workbench-cell-editor"

test("name, description, tags, JSON富内容 and 型号 share one editor dialog", () => {
  // The prose previews live on the row and the one dialog on the dialog host
  // since the workbench split; the counts below span the whole workbench.
  const workbench = ["./field-workbench.tsx", "./workbench-row.tsx", "./workbench-dialogs.tsx"]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n")
  const editor = readFileSync(
    new URL("./workbench-cell-editor.tsx", import.meta.url),
    "utf8",
  )
  // 名称 / 简介 / 搜索标签 / JSON富内容 / 型号 are editor-dialog cells; 主题 reuses
  // the same preview component but opens its dictionary picker instead of the
  // dialog, and its two branches (category has the attribute / does not) each
  // render one preview — 5 dialog cells + 2 theme = 7.
  assert.equal((workbench.match(/<WorkbenchCellPreview/g) ?? []).length, 7)
  assert.equal((workbench.match(/<WorkbenchProseEditor/g) ?? []).length, 1)
  assert.match(workbench, /onCommitColumn/)
  assert.doesNotMatch(workbench, /WorkbenchCellEditor/)
  assert.match(editor, /export function WorkbenchProseEditor/)
  const spec = readFileSync(new URL("./workbench-prose-spec.tsx", import.meta.url), "utf8")
  assert.match(spec, /export const PROSE_EDITOR/)
  assert.match(editor, /覆盖已有内容/)
  assert.match(editor, /填入 \$\{plan\.writeDraftIds\.length\} 行/)
  assert.match(editor, /const \[overwrite, setOverwrite\] = useState\(false\)/)
  assert.match(editor, /正在编辑 \$\{edit\.imageName\}/)
  assert.match(editor, /if \(!open\) finish\(false\)/)
})

test("rich_content 行编辑弹窗实时校验 JSON，非法即锁定两个提交按钮", () => {
  // SSR 不挂 Base UI 的 portal（同 defaultFieldsTree）：在 portal 边界之前
  // 截获组件产出的元素树，再逐个子元素断言。
  let root!: ReactElement
  function Capture() {
    root = WorkbenchProseEditor({
      edit: {
        draftId: "draft-1",
        column: "rich_content",
        imageName: "SZ-0001.png",
        value: '{"broken',
      },
      scope: {
        selected: false,
        rows: [
          { draftId: "draft-1", writable: true, empty: true, skip: null },
          { draftId: "draft-2", writable: true, empty: true, skip: null },
        ],
      },
      onClose: () => undefined,
      onCommit: () => undefined,
      onCommitColumn: () => undefined,
    })
    return null
  }
  renderToStaticMarkup(<Capture />)
  const pending: ReactNode[] = [root]
  const elements: ReactElement<Record<string, unknown>>[] = []
  while (pending.length) {
    const element = pending.pop()
    if (!isValidElement<Record<string, unknown>>(element)) continue
    elements.push(element)
    pending.push(...Children.toArray(element.props.children as ReactNode))
  }
  const label = (name: string) =>
    elements.find((element) => element.props.children === name)
  const status = elements.find(
    (element) => element.type === ProseDraftValidation,
  )

  const textarea = elements.find((element) => element.type === Textarea)
  assert.ok(textarea, "missing Textarea")
  assert.equal(textarea.props["aria-invalid"], true)
  assert.ok(status, "missing validation status line")
  assert.match(renderToStaticMarkup(status), /✗ JSON 格式错误/)
  assert.equal(label("填入 2 行")?.props.disabled, true)
  assert.equal(label("只改这一格")?.props.disabled, true)
})
