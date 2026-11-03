import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AutomationGrant } from "@/bindings/http-automation-grants"
import { McpGrantList } from "@/features/automation/mcp-grant-list"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const grant: AutomationGrant = { id: "test-id", name: "验收助手", token_prefix: "opa_test", created_at_ms: 1, actions: ["read"], scopeKind: "workspace", sourceIds: null }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const dialogButton = (text: string) => [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
  .find((button) => button.textContent?.trim() === text)

run.onclick = async () => {
  run.disabled = true
  delete results.dataset.result
  const root = createRoot(fixture)
  let revoked: AutomationGrant | null = null
  const settle = async (predicate: () => boolean, message: string) => {
    const deadline = performance.now() + 2000
    while (!predicate()) { check(performance.now() < deadline, message); await frame() }
  }
  try {
    flushSync(() => root.render(<McpGrantList grants={[grant]} loading={false} failed={false} busy={false} onRefresh={() => {}} onRevoke={async (value) => { revoked = value }} />))
    const remove = fixture.querySelector<HTMLButtonElement>('[aria-label="删除令牌 验收助手"]')!
    remove.click()
    await settle(() => !!dialogButton("取消"), "confirmation did not open")
    check(revoked === null, "opening confirmation revoked the grant")
    dialogButton("取消")!.click()
    await settle(() => !dialog(), "cancel did not close confirmation")
    check(revoked === null, "cancel revoked the grant")
    remove.click()
    await settle(() => !!dialogButton("删除令牌"), "confirmation did not reopen")
    dialogButton("删除令牌")!.click()
    await settle(() => revoked === grant && !dialog(), "confirm did not revoke the selected grant")
    results.textContent = "PASS: cancel and confirmed revoke"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`
    results.dataset.result = "fail"
  } finally {
    flushSync(() => root.unmount())
    run.disabled = false
  }
}
