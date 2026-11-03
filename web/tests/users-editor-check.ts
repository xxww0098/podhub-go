export {}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
async function settle(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 3000
  while (!predicate()) {
    check(performance.now() < deadline, message)
    await frame()
  }
}
const rows = (email: string) => [...document.querySelectorAll<HTMLTableRowElement>("tbody tr")]
  .filter((row) => row.textContent?.includes(email))
const popup = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]')

async function openEditor(button: HTMLButtonElement, name: string) {
  button.click()
  await settle(() => document.querySelector("#user-editor-title")?.textContent === name
    && button.getAttribute("aria-expanded") === "true", `${name} editor did not open from its trigger`)
  await frame()
  await frame()
  const anchor = button.getBoundingClientRect()
  const editor = popup()!.getBoundingClientRect()
  check(editor.top <= anchor.bottom && editor.bottom >= anchor.top
    && Math.abs(editor.left - anchor.right) < editor.width + anchor.width + 32,
  `${name} editor is not positioned near its trigger`)
}

try {
  await settle(() => rows("xu@example.invalid").length === 1, "directory did not load")
  const edit = rows("xu@example.invalid")[0]!.querySelector<HTMLButtonElement>('[aria-label="编辑账号"]')!
  await openEditor(edit, "许禾")

  const sharedRows = rows("zhou@example.invalid")
  check(sharedRows.length === 2, "shared account should have two membership rows")
  const name = [...sharedRows[1]!.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "周予安")!
  await openEditor(name, "周予安")
  document.querySelector<HTMLInputElement>('input[name="user-platform-role"][value="user"]')!.click()
  ;[...popup()!.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "保存更改")!.click()
  await settle(() => !!document.documentElement.dataset.fixtureUpdate, "account update was not saved")
  const update = JSON.parse(document.documentElement.dataset.fixtureUpdate!)
  check(update.uuid === "fictional-zhou" && update.role === "user" && update.enabled === true, "wrong account update")
  await settle(() => !document.querySelector("#user-editor-title"), "editor did not close after saving")
  await openEditor(name, "周予安")
  check(document.querySelector<HTMLInputElement>('input[name="user-platform-role"]:checked')?.value === "user", "saved role was not read back")
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await settle(() => !document.querySelector("#user-editor-title"), "Escape did not close the editor")
  await settle(() => document.activeElement === name, "focus did not return to the trigger")

  const view = rows("lin@example.invalid")[0]!.querySelector<HTMLButtonElement>('[aria-label="查看账号"]')!
  await openEditor(view, "林知夏")
  check(popup()?.textContent?.includes("系统只读") && !popup()?.textContent?.includes("保存更改"), "system account is not read-only")
  document.documentElement.dataset.usersEditorCheck = "passed"
} catch (reason) {
  document.documentElement.dataset.usersEditorCheck = `failed: ${reason instanceof Error ? reason.message : String(reason)}`
}
