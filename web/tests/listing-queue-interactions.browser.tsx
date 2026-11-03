import { useState } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { SellerSupplierDbRowData } from "@/bindings/http-supplier-dbs-catalog"
import { ScreenPane } from "@/components/screen-pane"
import { ListingQueueTray } from "@/features/supply-chain/gallery/listing-queue-tray"
import { clearQueue, isQueued, toggleQueued } from "@/features/supply-chain/gallery/listing-queue"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const root = createRoot(fixture)
const ready: SellerSupplierDbRowData = {
  productId: "fixture-ready", sourceId: "fixture-source", title: "可上架挂画", platformCode: "P001",
  listable: true, leadTime: "", gallery: [], productVideos: [], fixedTags: [], description: "", props: {}, listedAtMs: 0,
}
const blocked: SellerSupplierDbRowData = {
  ...ready, productId: "fixture-blocked", title: "待处理挂画", listable: false, denial: "config_needs_reconfiguration",
}
let imports: string[][] = []
let refreshes = 0
let generation = 0
let initialRows: SellerSupplierDbRowData[] = []
let refresh: () => Promise<SellerSupplierDbRowData[]>
let finishImport: () => Promise<void>

window.fetch = async () => { throw new Error("unexpected network request in listing queue fixture") }

function Fixture({ variant, active }: { variant: "toolbar" | "fab"; active: boolean }) {
  const [rows, setRows] = useState(initialRows)
  const [open, setOpen] = useState(variant === "fab")
  return <ScreenPane active={active}>
    <ListingQueueTray variant={variant} open={open} onOpenChange={setOpen} rows={rows}
      refreshRows={async () => { refreshes++; const fresh = await refresh(); setRows(fresh); return fresh }}
      onOpenDetail={() => {}}
      onOpenListing={async (products) => { imports.push(products.map((product) => product.productId)); await finishImport() }} />
  </ScreenPane>
}

function check(value: unknown, message: string): void { if (!value) throw new Error(message) }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 3000
  while (!predicate()) { check(performance.now() < deadline, message); await frame() }
}
function submit() {
  const button = document.querySelector<HTMLButtonElement>("[data-gallery-queue-direct-submit], [data-gallery-queue-submit]")
  if (!button) throw new Error("submit button missing")
  return button
}
function mount(rows: SellerSupplierDbRowData[], variant: "toolbar" | "fab" = "toolbar") {
  flushSync(() => root.render(null))
  clearQueue()
  rows.forEach(toggleQueued)
  initialRows = rows
  imports = []
  refreshes = 0
  refresh = async () => rows
  finishImport = async () => {}
  generation++
  flushSync(() => root.render(<Fixture key={generation} variant={variant} active />))
}

run.onclick = async () => {
  run.disabled = true
  const passed: string[] = []
  try {
    mount([blocked])
    check(!submit().disabled, "cached blocked status locked the refresh action")
    refresh = async () => [{ ...blocked, listable: true, denial: null }]
    submit().click()
    await settle(() => imports.length === 1 && !submit().disabled, "freshly available product was not imported")
    check(imports[0]?.[0] === blocked.productId && refreshes === 1, "stale facts were used for import")
    passed.push("cached blocked product is rechecked before import")

    mount([ready])
    refresh = async () => [{ ...ready, listable: false, denial: "config_needs_reconfiguration" }]
    submit().click()
    await settle(() => !!document.querySelector("[data-queue-blocked-reason]"), "blocked reason did not open")
    check(imports.length === 0 && isQueued(ready.productId), "blocked product was imported or removed")
    check(document.querySelector("[data-queue-blocked-reason]")?.textContent?.includes("需平台重新配置"), "specific recovery reason missing")
    check(!document.querySelector("[data-gallery-queue-bindings]"), "store/PSD setup still blocks selection")
    passed.push("newly blocked product stays in the queue with a reason")

    mount([ready, blocked])
    submit().click()
    await settle(() => imports.length === 1 && !submit().disabled, "mixed queue did not complete")
    check(JSON.stringify(imports) === JSON.stringify([[ready.productId]]), "mixed queue imported blocked products")
    passed.push("mixed queue only imports available products")

    mount([ready], "fab")
    let releaseImport!: () => void
    finishImport = () => new Promise<void>((resolve) => { releaseImport = resolve })
    await settle(() => !!document.querySelector("[data-gallery-queue-submit]"), "detail queue did not open")
    submit().click()
    await settle(() => imports.length === 1, "detail queue did not start import")
    check(submit().disabled && submit().getAttribute("aria-busy") === "true", "import lost its busy state")
    submit().click()
    check(imports.length === 1 && refreshes === 1, "repeat click started a second import")
    releaseImport()
    await settle(() => !document.querySelector("[data-gallery-queue-tray]"), "completed queue did not close")
    passed.push("detail queue rechecks once and stays busy until import completes")

    mount([ready])
    let releaseRefresh!: (rows: SellerSupplierDbRowData[]) => void
    refresh = () => new Promise((resolve) => { releaseRefresh = resolve })
    submit().click()
    await settle(() => refreshes === 1, "refresh did not start")
    flushSync(() => root.render(<Fixture key={generation} variant="toolbar" active={false} />))
    releaseRefresh([ready])
    await frame()
    await frame()
    check(imports.length === 0, "inactive screen imported late results")
    passed.push("leaving the screen cancels late handoff")

    mount([ready])
    refresh = () => new Promise((resolve) => { releaseRefresh = resolve })
    submit().click()
    await settle(() => refreshes === 1, "refresh did not start")
    flushSync(clearQueue)
    releaseRefresh([ready])
    await frame()
    await frame()
    check(imports.length === 0, "cleared queue was imported from a stale snapshot")
    passed.push("clearing the queue during refresh prevents import")

    results.textContent = `PASS ${passed.length}\n${passed.join("\n")}`
    results.dataset.status = "pass"
  } catch (reason) {
    results.textContent = `FAIL ${String(reason)}\n${passed.join("\n")}`
    results.dataset.status = "fail"
  } finally {
    flushSync(() => root.render(null))
    clearQueue()
    run.disabled = false
  }
}
