import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const shellPath = fileURLToPath(new URL("./app-shell.tsx", import.meta.url))
const buttonPath = fileURLToPath(new URL("../components/bug-report-button.tsx", import.meta.url))

test("工作台顶栏不再挂报告问题，组件文件已删除", () => {
  assert.equal(existsSync(buttonPath), false)
  const shell = readFileSync(shellPath, "utf8")
  assert.doesNotMatch(shell, /BugReportButton|bug-report-button|报告问题|docs\.qq\.com/)
  assert.match(shell, /<ChangelogButton \/>/)
  assert.match(shell, /<NotificationBell/)
})
