export {}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const directory = () => document.querySelector<HTMLElement>('section[aria-label="用户目录"]')
const rows = () => directory()?.querySelectorAll("tbody tr").length ?? 0
const control = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`)

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

try {
  await settle(() => rows() === 10, "first page did not render ten rows")
  check(control("编辑账号") && control("重置密码"), "account actions are named and available")
  control("选择当前筛选的全部账户")!.click()
  await settle(() => directory()?.textContent?.includes("已选 19 个账户") === true, "filtered selection did not deduplicate accounts")
  control("下一页")!.click()
  await settle(() => control("第 2 页，共 2 页") !== null, "next page did not open")
  check([...directory()!.querySelectorAll('tbody [role="checkbox"]')].every((item) => item.getAttribute("aria-checked") === "true"), "selection did not carry across pages")
  control("清除选择")!.click()
  control("更多操作 分页用户 1")!.click()
  await settle(() => control("停用") !== null, "more menu did not open")
  control("停用")!.click()
  await settle(() => document.querySelector('[data-slot="dialog-content"]')?.textContent?.includes("分页用户 1") === true, "disable confirmation did not open")
  check(!document.querySelector('[data-slot="popover-content"]')?.textContent?.includes("停用账户"), "more menu remained open behind the confirmation")
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-content"] button')].find((item) => item.textContent?.trim() === "取消")
  check(cancel, "cancel action missing")
  cancel.click()
  await settle(() => !document.querySelector('[data-slot="dialog-content"]'), "confirmation did not close")
  const search = control("搜索工作空间或账户") as HTMLInputElement
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "分页用户 1")
  search.dispatchEvent(new Event("input", { bubbles: true }))
  await settle(() => rows() === 2, "filter did not reduce the result set")
  check(control("第 1 页，共 1 页"), "filter did not reset the page")
  document.documentElement.dataset.usersPaginationCheck = "passed"
} catch (reason) {
  document.documentElement.dataset.usersPaginationCheck = `failed: ${reason instanceof Error ? reason.message : String(reason)}`
}
