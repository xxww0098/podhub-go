import assert from "node:assert/strict"
import test from "node:test"

import { workflowActions } from "./workflow-actions"

test("directory scan reads brief bodies and silently ignores tag sidecars", async () => {
  const files = [
    new File(["prompt text"], "painting.md"),
    new File(["#тег0\n#тег1"], "painting.fixed-tags.txt"),
    new File(["other brief"], "mug.md"),
  ]
  for (const file of files) Object.defineProperty(file, "webkitRelativePath", { value: `root/l1/l2/type/${file.name}` })
  const original = Object.getOwnPropertyDescriptor(globalThis, "document")
  let change: (() => void) | undefined
  let mounted = false
  let removed = false
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { appendChild: (input: HTMLInputElement) => { assert.equal(input.hidden, true); mounted = true } },
      createElement: () => ({
        files,
        addEventListener: (event: string, listener: () => void) => { if (event === "change") change = listener },
        click: () => { assert.equal(mounted, true); change?.() },
        remove: () => { removed = true },
      }),
    },
  })
  try {
    const scan = await workflowActions.workflowScanPromptDir()
    assert.equal(removed, true, "the temporary chooser is removed after selection")
    assert.deepEqual(
      scan.entries.map(({ file_name, content }) => [file_name, content]),
      [["painting.md", "prompt text"], ["mug.md", "other brief"]],
    )
    assert.equal("fixed_tags" in scan.entries[0]!, false)
    assert.deepEqual(scan.skipped, [])
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original)
    else Reflect.deleteProperty(globalThis, "document")
  }
})
