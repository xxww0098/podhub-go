import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("name, description, tags and 型号 share one editor dialog", () => {
  // The prose previews live on the row and the one dialog on the dialog host
  // since the workbench split; the counts below span the whole workbench.
  const workbench = ["./field-workbench.tsx", "./workbench-row.tsx", "./workbench-dialogs.tsx"]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n")
  const editor = readFileSync(
    new URL("./workbench-cell-editor.tsx", import.meta.url),
    "utf8",
  )
  // 名称 / 简介 / 搜索标签 / 型号 are editor-dialog cells; 主题 reuses
  // the same preview component but opens its dictionary picker instead of the
  // dialog, and its two branches (category has the attribute / does not) each
  // render one preview — 4 dialog cells + 2 theme = 6.
  assert.equal((workbench.match(/<WorkbenchCellPreview/g) ?? []).length, 6)
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
