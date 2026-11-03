import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AccountOverview } from "@/bindings/commands"
import type { GrantInput } from "@/bindings/http-automation-grants"
import { McpGrantForm } from "@/features/automation/mcp-grant-form"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const button = (text: string) => [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text)

run.onclick = async () => {
  run.disabled = true
  delete results.dataset.result
  const requests: GrantInput[] = []
  const root = createRoot(fixture)
  const settle = async (predicate: () => boolean, message: string) => {
    const deadline = performance.now() + 1500
    while (!predicate()) { check(performance.now() < deadline, message); await frame() }
  }
  try {
    const overview = { session: { authenticated: true, role: "super_admin" } } as AccountOverview
    flushSync(() => root.render(<McpGrantForm scope="supplier_catalog" overview={overview} busy={false} onCreate={async (input) => { requests.push(input) }} />))
    const submit = button("申请令牌")!
    check(submit.disabled, "empty name must not be submitted")
    const name = fixture.querySelector<HTMLInputElement>('input[placeholder="请输入令牌名称"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "  测试助手  ")
    name.dispatchEvent(new Event("input", { bubbles: true }))
    await settle(() => !submit.disabled, "valid name should enable creation")
    const picker = fixture.querySelector<HTMLButtonElement>('button[aria-labelledby*="permissions"]')!
    picker.click()
    await settle(() => !!document.querySelector('[role="dialog"][aria-label="允许的操作"]'), "permission picker did not open")
    const option = [...document.querySelectorAll<HTMLLabelElement>('[role="dialog"] label')].find((item) => item.textContent?.includes("新增与修改资料"))
    check(option, "write permission option was missing")
    option.click()
    await settle(() => picker.textContent?.includes("新增与修改资料") === true, "selected permissions were not summarized")
    const read = [...document.querySelectorAll<HTMLLabelElement>('[role="dialog"] label')].find((item) => item.textContent?.includes("读取供应商资料"))
    check(read, "read permission option was missing")
    read.click()
    option.click()
    await settle(() => submit.disabled, "a grant without permissions must not be submitted")
    read.click()
    option.click()
    await settle(() => !submit.disabled, "selecting permissions should re-enable creation")
    picker.click()
    await settle(() => !document.querySelector('[role="dialog"][aria-label="允许的操作"]'), "permission picker did not close")
    const expiry = fixture.querySelector<HTMLButtonElement>('[role="combobox"]')!
    expiry.click()
    await settle(() => !!document.querySelector('[role="option"]'), "expiry choices did not open")
    const ninetyDays = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.trim() === "90 天")
    check(ninetyDays, "90-day expiry was missing")
    ninetyDays.click()
    await settle(() => expiry.textContent?.includes("90 天") === true, "expiry choice did not update")
    submit.click()
    await settle(() => requests.length === 1, "create callback did not run")
    check(requests[0].name === "测试助手" && requests[0].expiresInDays === 90, "name or expiry changed unexpectedly")
    check(JSON.stringify(requests[0].actions) === JSON.stringify(["supplier:read", "supplier:write"]), "unselected permissions were included")
    button("重置")!.click()
    await settle(() => name.value === "" && submit.disabled, "reset did not clear the name")
    check(expiry.textContent?.includes("30 天"), "reset did not restore the default expiry")
    check(picker.textContent?.includes("读取供应商资料") && !picker.textContent?.includes("新增与修改资料"), "reset did not restore read-only permissions")
    results.textContent = "PASS: selection, exact payload, expiry, and reset"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`
    results.dataset.result = "fail"
  } finally {
    flushSync(() => root.unmount())
    run.disabled = false
  }
}
