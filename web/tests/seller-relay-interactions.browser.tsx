import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

import type { SellerRelayData } from "@/bindings/commands"
import { SellerRelayPanel } from "@/features/platform/seller-relay"
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
  const root = createRoot(fixture)
  let calls = 0
  let imports = 0
  let probes = 0
  let reads = 0
  let config: SellerRelayData = {
    relay_route: "socks5h://seller-relay:1080",
    sidecar_managed: true,
    nodes: [{ id: "test-node", name: "测试节点", address: "example.invalid:443", active: true }],
  }
  const settle = async (predicate: () => boolean, message: string) => {
    const deadline = performance.now() + 3000
    while (!predicate()) { check(performance.now() < deadline, message); await frame() }
  }
  const switchControl = () => fixture.querySelector<HTMLElement>('[role="switch"][aria-label="代理节点选择"]')!
  try {
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      const method = init?.method ?? "GET"
      if (url.pathname === "/api/admin/seller-relay" && method === "GET") {
        reads++
        if (reads === 1) return Response.json({ code: "INTERNAL", error: "状态暂不可读" }, { status: 500 })
        return Response.json({ data: config })
      }
      if (url.pathname === "/api/admin/seller-relay/active" && method === "PUT") {
        const nodeId = JSON.parse(String(init?.body)).nodeId as string | null
        if (nodeId === null) {
          calls++
          if (calls === 1) return Response.json({ code: "INTERNAL", error: "暂时不可用" }, { status: 500 })
        }
        config = { ...config, nodes: config.nodes.map((node) => ({ ...node, active: node.id === nodeId })) }
        return Response.json({ data: config })
      }
      if (url.pathname === "/api/admin/seller-relay/nodes" && method === "POST") {
        imports++
        if (imports === 1) return Response.json({ code: "VALIDATION", error: "链接无效" }, { status: 400 })
        check(JSON.parse(String(init?.body)).links === "vless://first\nvless://second", "multiline links were not sent intact")
        config = { ...config, nodes: [...config.nodes, { id: "new-node", name: "隔离节点", address: "example.invalid:444", active: false }] }
        return Response.json({ data: config })
      }
      if (url.pathname === "/api/admin/seller-relay/probe" && method === "POST") {
        probes++
        if (probes === 2) return Response.json({ code: "INTERNAL", error: "检测失败" }, { status: 500 })
        return Response.json({ data: { reachable: true, latency_ms: 12 } })
      }
      if (url.pathname === "/api/admin/seller-relay/nodes/test-node" && method === "DELETE") {
        config = { ...config, nodes: config.nodes.filter((node) => node.id !== "test-node") }
        return Response.json({ data: config })
      }
      throw new Error(`unexpected fixture request: ${method} ${url.pathname}`)
    }
    flushSync(() => root.render(<SellerRelayPanel initialConfig={config} />))
    check(switchControl().getAttribute("aria-checked") === "true", "active node did not render selected")
    switchControl().click()
    await settle(() => calls === 1 && reads === 1 && fixture.textContent?.includes("状态未确认") === true, "failed refresh did not mark unknown")
    check(switchControl().getAttribute("aria-disabled") === "true", "unknown state must block another switch")
    check(switchControl().getAttribute("aria-checked") === "true", "failed switch lost the selected node")
    const retry = Array.from(fixture.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === "重试读取")!
    await settle(() => !retry.disabled, "retry remained disabled after failed read")
    retry.click()
    await settle(() => reads === 2 && switchControl().getAttribute("aria-disabled") !== "true", "retry did not recover confirmed state")
    switchControl().click()
    await settle(() => calls === 2 && switchControl().getAttribute("aria-checked") === "false", "disable was not reflected")
    check(switchControl().getAttribute("aria-disabled") === "true", "unselected switch could enable an unspecified node")
    check(fixture.textContent?.includes("请在下方选择节点启用"), "selection guidance missing")
    const links = fixture.querySelector<HTMLTextAreaElement>("#seller-relay-links")!
    const fillLinks = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(links, value)
      links.dispatchEvent(new Event("input", { bubbles: true }))
    }
    const button = (text: string) => Array.from(fixture.querySelectorAll("button")).find((item) => item.textContent?.trim() === text)!
    fillLinks("bad")
    await settle(() => !button("导入").disabled, "import did not become available")
    button("导入").click()
    await settle(() => imports === 1 && links.getAttribute("aria-invalid") === "true", "invalid link was not marked")
    check(links.value === "bad", "failed import lost the input")
    fillLinks("vless://first\nvless://second")
    await settle(() => links.getAttribute("aria-invalid") !== "true" && !button("导入").disabled, "editing did not clear the error")
    button("导入").click()
    await settle(() => imports === 2 && fixture.textContent?.includes("隔离节点") === true, "imported node was not shown")
    check(String(links.value) === "", "successful import did not clear the input")
    const newRow = Array.from(fixture.querySelectorAll("tr")).find((row) => row.textContent?.includes("隔离节点"))!
    newRow.querySelector<HTMLButtonElement>("button")!.click()
    await settle(() => switchControl().getAttribute("aria-checked") === "true", "node selection did not update")
    fixture.querySelector<HTMLButtonElement>('[aria-label="检测连通"]')!.click()
    await settle(() => probes === 1 && fixture.textContent?.includes("连通 · 12 ms") === true, "probe success was not shown")
    fixture.querySelector<HTMLButtonElement>('[aria-label="检测连通"]')!.click()
    await settle(() => probes === 2 && !fixture.textContent?.includes("连通 · 12 ms"), "failed probe retained an old success")
    fixture.querySelector<HTMLButtonElement>('[aria-label="删除节点 测试节点"]')!.click()
    await settle(() => !fixture.textContent?.includes("测试节点"), "deleted node is still visible")
    results.textContent = "PASS: unknown-state retry, multiline import, node selection, probe failure and deletion"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`
    results.dataset.result = "fail"
  } finally {
    flushSync(() => root.unmount())
    window.fetch = originalFetch
    run.disabled = false
  }
}
