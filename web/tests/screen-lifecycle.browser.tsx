import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { useEffect, useState } from "react"
import type { AccountOverview } from "@/bindings/commands"
import type { AppScreen } from "@/lib/app-screens"
import { SCREEN_LOADERS } from "@/app/screen-loaders"
import { ScreenCatalog } from "@/app/screen-catalog"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const unexpectedRequests: string[] = []
const originalFetch = window.fetch
window.fetch = async (input) => {
  unexpectedRequests.push(String(input))
  throw new Error(`Unexpected network request: ${input}`)
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const settle = async () => { await frame(); await frame() }
async function waitFor<T extends Element>(selector: string, message: string, timeoutMs = 5000): Promise<T> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const element = fixture.querySelector<T>(selector)
    if (element) return element
    await frame()
  }
  throw new Error(message)
}
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

const mounts: Record<string, number> = { console: 0, listing: 0 }
const unmounts: Record<string, number> = { console: 0, listing: 0 }
function resetCounters() {
  for (const name of Object.keys(mounts)) { mounts[name] = 0; unmounts[name] = 0 }
}

function TestScreen({ name, label, withInput = false }: { name: string; label: string; withInput?: boolean }) {
  const [value, setValue] = useState("")
  useEffect(() => {
    mounts[name]++
    return () => { unmounts[name]++ }
  }, [name])
  return <section data-screen={name}><strong>{label}</strong>{withInput && <input aria-label={`${name} draft`} value={value} onChange={(event) => setValue(event.target.value)} />}</section>
}

function ConsoleScreen() { return <TestScreen name="console" label="Console" withInput /> }
function ListingScreen() { return <TestScreen name="listing" label="Listing" withInput /> }
const originalScreenLoaders = { ...SCREEN_LOADERS }
Object.assign(SCREEN_LOADERS as unknown as Record<AppScreen, typeof SCREEN_LOADERS[AppScreen]>, {
  console: async () => ({ ConsoleScreen }),
  listing: async () => ({ WorkflowScreen: ListingScreen }),
})

const overview = (workspaceId: number, role = "owner"): AccountOverview => ({
  session: { authenticated: true, email: "test@example.invalid", name: "test", role },
  active_workspace: { id: workspaceId, uuid: `workspace-${workspaceId}`, name: `Workspace ${workspaceId}`, plan: "pro", role: "owner", is_owned: true },
  workspaces: [], account_mode: "owner", owned_count: 1, owned_limit: 3,
})

function renderCatalog(root: Root, screen: AppScreen, visited: AppScreen[], data: AccountOverview) {
  flushSync(() => root.render(<ScreenCatalog screen={screen} visited={visited} overview={data} onOverviewChange={() => {}} onSignedOut={() => {}} onNavigate={() => {}} onRefreshOverview={async () => {}} />))
}

async function mounted(action: (root: Root) => Promise<void>) {
  const root = createRoot(fixture)
  try { await action(root) } finally { flushSync(() => root.unmount()); await settle() }
}

async function pageStateSurvivesSwitch() {
  await mounted(async (root) => {
    renderCatalog(root, "console", ["console"], overview(1))
    const input = await waitFor<HTMLInputElement>('[aria-label="console draft"]', "console screen did not load")
    setInput(input, "kept")
    renderCatalog(root, "listing", ["console", "listing"], overview(1))
    await waitFor<HTMLInputElement>('[aria-label="listing draft"]', "listing screen did not load")
    renderCatalog(root, "console", ["console", "listing"], overview(1))
    await waitFor<HTMLInputElement>('[aria-label="console draft"]', "console screen did not return")
    check(fixture.querySelector<HTMLInputElement>('[aria-label="console draft"]')?.value === "kept", "switching panes lost input state")
    check(mounts.console === 1, `console remounted during pane switch (${mounts.console})`)
  })
}

async function workspaceChangeRemountsOnReactivation() {
  await mounted(async (root) => {
    renderCatalog(root, "listing", ["listing"], overview(1))
    const input = await waitFor<HTMLInputElement>('[aria-label="listing draft"]', "listing screen did not load")
    setInput(input, "old workspace")
    renderCatalog(root, "console", ["listing", "console"], overview(1))
    await waitFor<HTMLElement>('[data-screen="console"]', "console screen did not load")
    const mountsBeforeWorkspaceUpdate = mounts.listing
    renderCatalog(root, "console", ["listing", "console"], overview(2))
    await settle()
    check(fixture.querySelector('[data-screen="listing"]')?.closest('[hidden]'), "listing should remain hidden while changing Workspace")
    check(mounts.listing === mountsBeforeWorkspaceUpdate, "hidden listing remounted before reactivation")
    renderCatalog(root, "listing", ["listing", "console"], overview(2))
    const nextInput = await waitFor<HTMLInputElement>('[aria-label="listing draft"]', "listing screen did not reactivate")
    check(nextInput.value === "", "workspace switch retained old workspace's screen state")
    check(mounts.listing === mountsBeforeWorkspaceUpdate + 1, `workspace switch remounted listing ${mounts.listing - mountsBeforeWorkspaceUpdate} times`)
  })
}

run.onclick = async () => {
  run.disabled = true
  results.textContent = "运行中"
  delete results.dataset.result
  unexpectedRequests.length = 0
  try {
    const checks: Array<[string, () => Promise<void>]> = [
      ["pane state survives navigation", pageStateSurvivesSwitch],
      ["workspace change remounts screen", workspaceChangeRemountsOnReactivation],
    ]
    const lines: string[] = []
    for (const [name, test] of checks) {
      resetCounters()
      try { await test(); lines.push(`PASS ${name}`) } catch (error) { lines.push(`FAIL ${name}: ${String(error)}`) }
    }
    if (unexpectedRequests.length) lines.push(`FAIL Unexpected network: ${unexpectedRequests.join(", ")}`)
    results.textContent = lines.join("\n")
    results.dataset.result = lines.some((line) => line.startsWith("FAIL")) ? "failed" : "passed"
  } finally {
    Object.assign(SCREEN_LOADERS as unknown as Record<AppScreen, typeof SCREEN_LOADERS[AppScreen]>, originalScreenLoaders)
    window.fetch = originalFetch
    run.disabled = false
  }
}
