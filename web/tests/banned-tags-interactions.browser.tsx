import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { PlatformBannedTagsScreen } from "@/features/platform/banned-tags-screen"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }

run.onclick = async () => {
  run.disabled = true
  delete results.dataset.result
  const originalFetch = window.fetch
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  let clipboardText = ""
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { clipboardText = value } } })
  const root = createRoot(fixture)
  const longNote = "词干 табак。词尾前 к/ч 交替，因此 табачный 命中。覆盖 табака、табакерка，不命中 таблица、табор、табурет、табель。长备注完整内容。"
  let tags = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, term: `词${index + 1}`, matchMode: "stem", note: index === 0 ? longNote : "原备注", createdBy: "test", createdAt: "2026-10-28", enabled: true }))
  let postCount = 0
  let putCount = 0
  let deleteCount = 0
  let loadFails = false
  const settle = async (predicate: () => boolean, message: string) => {
    const deadline = performance.now() + 2000
    while (!predicate()) { check(performance.now() < deadline, message); await frame() }
  }
  const input = (element: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const controlTops = () => {
    const form = fixture.querySelector<HTMLFormElement>("form")!
    const top = form.getBoundingClientRect().top
    return ["#banned-tag-term", "#banned-tag-mode", "#banned-tag-note", '[role="switch"]', 'button[type="submit"]'].map(selector => form.querySelector<HTMLElement>(selector)!.getBoundingClientRect().top - top)
  }
  try {
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      const method = init?.method ?? "GET"
      if (url.pathname === "/api/admin/banned-tags" && method === "GET") {
        if (loadFails) return Response.json({ code: "INTERNAL", error: "暂时不可用" }, { status: 500 })
        return Response.json({ data: { tags } })
      }
      if (url.pathname === "/api/admin/banned-tags" && method === "POST") {
        postCount++
        const body = JSON.parse(String(init?.body)) as { term: string; matchMode: string; note: string; enabled: boolean }
        tags = [...tags, { ...body, id: 13, createdBy: "test", createdAt: "2026-10-28" }]
        return Response.json({ data: { tags } })
      }
      if (url.pathname === "/api/admin/banned-tags/1" && method === "PUT") {
        if (++putCount === 1) return Response.json({ code: "CONFLICT", error: "这个受限词已经存在" }, { status: 409 })
        const body = JSON.parse(String(init?.body)) as { term: string; matchMode: string; note: string; enabled: boolean }
        tags = tags.map((tag) => tag.id === 1 ? { ...tag, ...body } : tag)
        return Response.json({ data: { tags } })
      }
      if (url.pathname === "/api/admin/banned-tags/2" && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { term: string; matchMode: string; note: string; enabled: boolean }
        tags = tags.map((tag) => tag.id === 2 ? { ...tag, ...body } : tag)
        return Response.json({ data: { tags } })
      }
      if (url.pathname === "/api/admin/banned-tags/1" && method === "DELETE") {
        if (++deleteCount === 1) return Response.json({ code: "INTERNAL", error: "暂时不可用" }, { status: 500 })
        tags = tags.filter((tag) => tag.id !== 1)
        return Response.json({ data: { tags } })
      }
      throw new Error(`unexpected fixture request: ${method} ${url.pathname}`)
    }
    flushSync(() => root.render(<PlatformBannedTagsScreen />))
    await settle(() => Boolean(fixture.querySelector('[aria-label="编辑 词1"]')), "initial rows not loaded")
    check(!fixture.textContent?.includes("词11"), "first page exceeded 10 rows")
    check(!fixture.querySelector("#banned-tag-note-1"), "notes should start collapsed")
    fixture.querySelector<HTMLButtonElement>('[aria-label="展开 词1 的备注"]')!.click()
    await settle(() => fixture.querySelector("#banned-tag-note-1")?.textContent === longNote, "expanded note lost its full content")
    check(fixture.querySelector('[aria-label="收起 词1 的备注"]')?.getAttribute("aria-expanded") === "true", "expanded note was not announced")
    fixture.querySelector<HTMLButtonElement>('[aria-label="收起 词1 的备注"]')!.click()
    await settle(() => !fixture.querySelector("#banned-tag-note-1"), "note did not collapse")
    const beforeValidation = controlTops()
    fixture.querySelector<HTMLFormElement>('form')!.requestSubmit()
    await settle(() => Boolean(fixture.querySelector('#banned-tag-term[aria-invalid="true"]')), "empty term was not rejected")
    check(postCount === 0 && fixture.textContent?.includes("请输入受限词"), "empty term was submitted or not explained")
    check(controlTops().every((top, index) => (index > 1 && innerWidth < 1024) || Math.abs(top - beforeValidation[index]) < 1), "validation shifted unrelated controls")
    input(fixture.querySelector<HTMLInputElement>('#banned-tag-term')!, "词13")
    input(fixture.querySelector<HTMLInputElement>('#banned-tag-note')!, "新增备注")
    await frame()
    fixture.querySelector<HTMLFormElement>('form')!.requestSubmit()
    await settle(() => postCount === 1 && fixture.textContent?.includes("共 13 条") === true, "new rule was not saved")
    check(tags[12]?.term === "词13" && tags[12]?.note === "新增备注" && tags[12]?.enabled, "created rule fields were not sent")
    fixture.querySelector<HTMLButtonElement>('[aria-label="词2 启用"]')!.click()
    await settle(() => tags[1]?.enabled === false && fixture.querySelector('[aria-label="词2 启用"]')?.getAttribute("aria-checked") === "false", "enabled state was not saved")
    fixture.querySelector<HTMLButtonElement>('[aria-label="选择 词1"]')!.click()
    await settle(() => fixture.querySelector('[aria-label="选择 词1"]')?.getAttribute("aria-checked") === "true", "row selection did not update")
    check(fixture.querySelector('[aria-label="选择 词1"]')?.closest("tr")?.dataset.state === "selected", "selected row was not highlighted")
    ;[...fixture.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes("复制所选"))!.click()
    await settle(() => clipboardText === "词1", "selected term was not copied")
    fixture.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click()
    await settle(() => Boolean(fixture.querySelector('[aria-label="编辑 词11"]')), "next page did not show later rows")
    input(fixture.querySelector<HTMLInputElement>('[aria-label="搜索受限词"]')!, "词11")
    await settle(() => Boolean(fixture.querySelector('[aria-label="编辑 词11"]')) && !fixture.querySelector('[aria-label="编辑 词12"]'), "search did not filter or reset the page")
    check(fixture.textContent?.includes("共 1 条") === true && fixture.querySelector('[aria-label="第 1 页，共 1 页"]'), "search count or page was incorrect")
    input(fixture.querySelector<HTMLInputElement>('[aria-label="搜索受限词"]')!, "")
    await settle(() => Boolean(fixture.querySelector('[aria-label="编辑 词1"]')), "clearing search did not return to first page")
    check(fixture.querySelector('[aria-label="选择 词1"]')?.getAttribute("aria-checked") === "false", "selection survived a page or filter change")
    fixture.querySelector<HTMLButtonElement>('[aria-label="筛选状态"]')!.click()
    await settle(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')].some((option) => option.textContent?.includes("已禁用")), "status options did not open")
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("已禁用"))!.click()
    await settle(() => Boolean(fixture.querySelector('[aria-label="编辑 词2"]')) && !fixture.querySelector('[aria-label="编辑 词1"]'), "status filter did not show the disabled rule")
    fixture.querySelector<HTMLButtonElement>('[aria-label="筛选状态"]')!.click()
    await settle(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')].some((option) => option.textContent?.includes("全部状态")), "status options did not reopen")
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("全部状态"))!.click()
    await settle(() => Boolean(fixture.querySelector('[aria-label="编辑 词1"]')), "clearing status filter did not restore rows")

    fixture.querySelector<HTMLButtonElement>('[aria-label="编辑 词1"]')!.click()
    await settle(() => Boolean(fixture.querySelector('button[type="submit"]')?.textContent?.includes("保存修改")), "edit did not open")
    const term = fixture.querySelector<HTMLInputElement>('#banned-tag-term')!
    const note = fixture.querySelector<HTMLInputElement>('#banned-tag-note')!
    input(term, "")
    await frame()
    const beforeEditValidation = controlTops()
    fixture.querySelector<HTMLFormElement>('form')!.requestSubmit()
    await settle(() => Boolean(fixture.querySelector('#banned-tag-term[aria-invalid="true"]')), "empty edit term was not rejected")
    check(controlTops().every((top, index) => (index > 1 && innerWidth < 1024) || Math.abs(top - beforeEditValidation[index]) < 1), "edit validation shifted unrelated controls")
    input(term, "新词")
    input(note, "新备注")
    fixture.querySelector<HTMLFormElement>('form')!.requestSubmit()
    await settle(() => putCount === 1, "first save was not attempted")
    await frame()
    await settle(() => Boolean(fixture.querySelector('button[type="submit"]:not(:disabled)')), "failed save did not finish")
    check(term.value === "新词" && note.value === "新备注", "failed save discarded the draft")
    fixture.querySelector<HTMLFormElement>('form')!.requestSubmit()
    await settle(() => Boolean(fixture.querySelector('[aria-label="编辑 新词"]')), "successful edit was not reflected")
    check(fixture.textContent?.includes("新备注"), "saved note was not shown")

    fixture.querySelector<HTMLButtonElement>('[aria-label="删除 新词"]')!.click()
    await settle(() => Boolean(document.querySelector('[role="dialog"]')), "delete did not ask for confirmation")
    check(deleteCount === 0, "delete ran before confirmation")
    const dialogButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === name)
    dialogButton("取消")!.click()
    await settle(() => !document.querySelector('[role="dialog"]'), "cancel did not close confirmation")
    check(deleteCount === 0 && fixture.textContent?.includes("新词"), "cancel deleted a row")
    fixture.querySelector<HTMLButtonElement>('[aria-label="删除 新词"]')!.click()
    await settle(() => Boolean(dialogButton("删除")), "delete confirmation did not reopen")
    dialogButton("删除")!.click()
    await settle(() => deleteCount === 1, "first delete was not attempted")
    await frame()
    await settle(() => Boolean(dialogButton("删除") && !dialogButton("删除")!.disabled), "failed delete did not finish")
    check(Boolean(document.querySelector('[role="dialog"]')) && fixture.textContent?.includes("新词"), "failed delete lost confirmation or row")
    dialogButton("删除")!.click()
    await settle(() => deleteCount === 2 && !document.querySelector('[role="dialog"]'), "successful delete did not close")
    check(!fixture.textContent?.includes("新词"), "deleted row remained visible")
    tags = []
    flushSync(() => root.render(<PlatformBannedTagsScreen key="empty" />))
    await settle(() => fixture.textContent?.includes("暂无受限词") === true, "empty state did not load")
    check(Boolean(fixture.querySelector('[aria-label="全局受限标签"] th')) && fixture.textContent?.includes("共 0 条"), "empty state lost its table header or count")
    loadFails = true
    flushSync(() => root.render(<PlatformBannedTagsScreen key="failed" />))
    await settle(() => fixture.textContent?.includes("无法读取全局受限标签") === true, "read error was not shown")
    check(!fixture.textContent?.includes("暂无受限词"), "read error looked like an empty list")
    check(fixture.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled === true, "an unconfirmed rule list allowed writes")
    loadFails = false
    fixture.querySelector<HTMLButtonElement>('[aria-label="重试"]')!.click()
    await settle(() => fixture.textContent?.includes("暂无受限词") === true, "retry did not recover the list")
    results.textContent = "PASS: stable create/edit validation layout, note expand/collapse, selection highlight, create, toggle, copy, search/status filtering, paging, edit/delete retries, empty state, and read recovery"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`
    results.dataset.result = "fail"
  } finally {
    flushSync(() => root.unmount())
    window.fetch = originalFetch
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor)
    else Reflect.deleteProperty(navigator, "clipboard")
    run.disabled = false
  }
}
