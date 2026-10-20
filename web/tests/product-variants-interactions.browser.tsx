// Dev-only mounted dialog checks. Every request is answered at the HTTP boundary;
// this fixture never connects to Cloud or Seller and fails on unknown requests.
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import { Toaster, useToastManager } from "@/components/ui/toast"
import type { StoreProductRow } from "@/features/products/products-api"
import { LIVE_VARIANT_OPEN, ProductVariantDialog } from "@/features/products/products-variant-dialog"
import type { VariantProductAction } from "@/features/products/products-variant-model"
import "../src/index.css"

type Schema = components["schemas"]
type Item = Schema["ProductVariantOperationItem"]
const STORE = "11111111-2222-4333-8444-555555555555"
const OPERATION = "22222222-3333-4444-8555-666666666666"
const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const previewPath = route("workspaceOpsProductVariantsPreviews")
const operationPath = route("workspaceOpsProductVariantsOperations")
const statusPath = route("workspaceOpsProductVariantsOperationsByOperationId", { operation_id: OPERATION })
const unexpectedRequests: string[] = []
const previewRequests: Schema["ProductVariantPreviewRequest"][] = []
const operationRequests: Schema["ProductVariantOperationRequest"][] = []
let statusReads = 0
let initialItems: Item[] = []
let statusReply: () => Promise<Response>
let appliedCallbacks = 0

const rows: StoreProductRow[] = [101, 102].map((productId) => ({
  store_id: STORE, store_name: "测试店", product_id: productId, offer_id: `A-${productId}`,
  name: `规格 ${productId}`, sku: productId, state: "on_sale", gone: false,
}))
const member = (productId: string, modelId: number): Schema["ProductVariantMemberView"] => ({
  product_id: productId, offer_id: `A-${productId}`, name: `成员 ${productId}`, model_id: modelId,
})
function preview(request: Schema["ProductVariantPreviewRequest"]): Schema["ProductVariantPreviewData"] {
  const existing = request.action === "move" ? [member("201", 900), member("202", 900)] : []
  return {
    digest: `preview-${request.action}`, action: request.action, store_id: STORE,
    target: { model_id: request.action === "move" ? 900 : null, model_value: "共同设计", existing_members: existing },
    products: rows.map((row, index) => ({
      product_id: String(row.product_id), offer_id: row.offer_id, name: row.name ?? "测试规格",
      current_model_id: 7, target_model_id: request.action === "split" ? 901 + index : 900,
      combination_key: `size-${index}`,
      variant_values: [{ attribute_id: 100, dictionary_value_id: 200 + index, label: "尺寸", value: `${40 + index} cm` }],
    })),
    source_remaining: [member("103", 7)], target_existing: existing, problems: [],
  }
}
function item(productId: string, state: Item["state"]): Item {
  return { product_id: productId, offer_id: `A-${productId}`, state, ...(state === "pending" ? { task_id: 777 } : {}) }
}
function json(data: unknown) {
  return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } })
}
function status(items: Item[]): Schema["ProductVariantOperationStatusData"] {
  return { operation_id: OPERATION, state: "partial", passes: 1, items, last_checked_at_ms: Date.now() }
}
window.fetch = async (input, init) => {
  const url = String(input)
  const method = init?.method ?? "GET"
  if (url === previewPath && method === "POST") {
    const request: Schema["ProductVariantPreviewRequest"] = JSON.parse(String(init?.body))
    previewRequests.push(request)
    return json(preview(request))
  }
  if (url === operationPath && method === "POST") {
    operationRequests.push(JSON.parse(String(init?.body)))
    const data: Schema["ProductVariantOperationData"] = {
      operation_id: OPERATION, accepted: true, items: initialItems,
    }
    return json(data)
  }
  if (url === statusPath && method === "GET") {
    statusReads += 1
    return statusReply()
  }
  unexpectedRequests.push(`${method} ${url}`)
  throw new Error(`Unexpected network request: ${method} ${url}`)
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() { await frame(); await frame() }
async function until(test: () => boolean, message: string) {
  for (let frameCount = 0; frameCount < 120; frameCount += 1) {
    if (test()) return
    await frame()
  }
  throw new Error(message)
}
function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((candidate) => candidate.textContent?.trim() === text)
}
function button(text: string): HTMLButtonElement {
  const found = findButton(text)
  check(found, `Missing dialog button: ${text}`)
  return found
}
async function click(control: HTMLButtonElement) {
  check(!control.disabled, "Cannot click disabled control")
  flushSync(() => control.click())
  await settle()
}
function liveOpen() {
  return fixture.querySelector("[data-live-open]")?.getAttribute("data-live-open") === "true"
}
// Read the real mounted toast provider's state; an ending toast is already closed.
function LiveNoticeProbe() {
  const { toasts } = useToastManager()
  const open = toasts.some((entry) => entry.id === LIVE_VARIANT_OPEN && entry.transitionStatus !== "ending")
  return <output hidden data-live-open={String(open)} />
}
async function mounted(action: VariantProductAction, body: () => Promise<void>) {
  previewRequests.length = 0
  operationRequests.length = 0
  statusReads = 0
  appliedCallbacks = 0
  const root = createRoot(fixture)
  try {
    flushSync(() => root.render(
      <Toaster>
        <LiveNoticeProbe />
        <ProductVariantDialog action={action} rows={rows} storeName="测试店" scopeKey={`workspace:${STORE}`}
          targets={[{ storeId: STORE, modelId: "900", label: "同款 2 件 · 型号 900" }]}
          onClose={() => {}} onApplied={() => { appliedCallbacks += 1 }} />
      </Toaster>,
    ))
    await until(() => findButton("确认执行")?.disabled === false, "Preview did not become executable")
    await body()
  } finally {
    flushSync(() => root.unmount())
    await settle()
  }
}
async function focusAgain() {
  check(document.visibilityState === "visible", "Run this fixture in a visible browser tab")
  for (let attempt = 0; attempt < 3; attempt += 1) {
    window.dispatchEvent(new Event("focus"))
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
  }
}

async function targetChecks() {
  await mounted("variant-move", async () => {
    const request = previewRequests[0]!
    check(request.target_model_id === 900 && typeof request.target_model_id === "number", "Move must send a numeric targetModelId")
    check(document.querySelector('[aria-label="已核实的同款"]'), "Move must offer verified targets")
    check(!document.querySelector('[role="dialog"] input:not([aria-hidden="true"]):not([type="hidden"])'), "Move must not offer unsupported free-form targets")
    const count = [...document.querySelectorAll("dt")].find((entry) => entry.textContent === "目标组现有成员")
    check(count?.nextElementSibling?.textContent === "2 件", "Wire existingMembers array must render its count")
    for (const offer of ["A-101", "A-102", "A-103", "A-201", "A-202"]) {
      check(document.querySelector('[data-slot="dialog-content"]')?.textContent?.includes(offer), `Missing preview member ${offer}`)
    }
  })
  for (const action of ["variant-merge", "variant-split"] as const) {
    await mounted(action, async () => {
      check(previewRequests[0]?.target_model_id == null, `${action} must not send an existing target`)
      check(!document.querySelector('[role="dialog"] [role="combobox"]'), `${action} must not offer target selection`)
      check(!document.querySelector('[role="dialog"] input:not([aria-hidden="true"]):not([type="hidden"])'), `${action} must not offer free-form targets`)
    })
  }
}
async function terminalChecks() {
  for (const items of [[item("101", "rejected"), item("102", "rejected")], [item("101", "applied"), item("102", "rejected")]]) {
    initialItems = items
    statusReply = async () => json(status(items))
    await mounted("variant-merge", async () => {
      await click(button("确认执行"))
      check(operationRequests.length === 1, `Confirm must send exactly one operation, got ${operationRequests.length}`)
      await until(() => document.querySelector('[data-slot="dialog-content"]')?.textContent?.includes("逐项结果") === true, "Operation results missing")
      await focusAgain()
      check(statusReads === 0, "Terminal initial results must never poll status")
      check(!liveOpen(), "Terminal results must not retain a pending live notice")
      check(appliedCallbacks === 1 && operationRequests.length === 1, "Execute must notify once and write once")
      const command = operationRequests[0]!
      check(command.preview_digest === "preview-merge", "Execute must use the returned preview digest")
      check(/^[0-9a-f-]{36}$/.test(command.operation_id), "Execute must send a UUID operation id")
    })
  }
}
async function pendingCheck() {
  initialItems = [item("101", "applied"), item("102", "pending")]
  let finishStatus: (response: Response) => void = () => { throw new Error("Status request has not started") }
  statusReply = () => new Promise<Response>((resolve) => { finishStatus = resolve })
  await mounted("variant-merge", async () => {
    await click(button("确认执行"))
    await until(() => statusReads === 1 && liveOpen(), "Pending operation must poll and show a live notice")
    check(document.querySelector('[data-slot="dialog-content"]')?.textContent?.includes("等待 Ozon 生效"), "Pending item must remain pending")
    finishStatus(json(status([item("101", "applied"), item("102", "rejected")])))
    await until(() => !liveOpen() && document.querySelector('[data-slot="dialog-content"]')?.textContent?.includes("Ozon 已拒绝") === true,
      "Terminal status read must update the item and clear the live notice")
    await focusAgain()
    check(statusReads === 1, "After terminal status, focus must not restart polling")
    check(operationRequests.length === 1, "Status observation must not repeat the write")
  })
}

run.onclick = async () => {
  run.disabled = true
  results.textContent = "运行中"
  unexpectedRequests.length = 0
  const lines: string[] = []
  try {
    await targetChecks(); lines.push("PASS numeric target IDs, complete preview members, and action-specific controls")
    await terminalChecks(); lines.push("PASS rejected and mixed terminal initial results do not poll")
    await pendingCheck(); lines.push("PASS pending status settles, clears the live notice, and stops polling")
  } catch (error) {
    lines.push(`FAIL ${error instanceof Error ? error.stack : String(error)}`)
  }
  if (unexpectedRequests.length) lines.push(`FAIL Unexpected network: ${unexpectedRequests.join(", ")}`)
  results.textContent = lines.join("\n")
  results.dataset.result = lines.some((line) => line.startsWith("FAIL")) ? "failed" : "passed"
  run.disabled = false
}
