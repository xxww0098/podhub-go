// Dev-only browser checks: real React DOM, portals and native DOM events.
// No Cloud, Seller or AI request is allowed by this fixture.
import { listingProjection } from "./listing-row-fixture"
import { Component, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { Toaster, toast } from "@/components/ui/toast"
import { useRef } from "react"
import type { AccountOverview, CategorySchemaView, WorkflowDraftView } from "@/bindings/commands"
import { invalidateAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"
import { CardBindForm } from "@/features/workflow/card-bind-form"
import { emptyTreeSelection } from "@/features/category-schema/category-tree"
import type { ListingRow } from "@/features/workflow/model/listing-row"
import { FieldWorkbench, type FieldWorkbenchProps } from "@/features/workflow/workbench/field-workbench"
import { listingWorkbenchScope, patchListingWorkbench, projectListingRows, receiveListingProducts, resetListingWorkbench, useListingWorkbenchStore, useWorkflowProgress } from "@/features/workflow/workbench/listing-workbench-store"
import { usePublishQueue } from "@/features/workflow/submit/use-publish-queue"
import { createPreparationTracks, NO_GUIDED_PREPARATION, NO_PREPARATION_ACTIVITY, NO_PREPARATION_PROGRESS } from "@/features/workflow/prepare/preparation-tracks"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const unexpectedRequests: string[] = []
window.fetch = async (input) => {
  unexpectedRequests.push(String(input))
  throw new Error(`Unexpected network request: ${input}`)
}
const noop = () => {}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() { await frame(); await frame() }
async function mounted(node: ReactNode, action: () => Promise<void>) {
  const root = createRoot(fixture)
  try {
    flushSync(() => root.render(<Toaster>{node}</Toaster>))
    await settle()
    await action()
  } finally {
    flushSync(() => root.unmount())
    toast.close()
    resetListingWorkbench()
    await settle()
  }
}
function button(text: string, container: ParentNode = document): HTMLButtonElement {
  const matches = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .filter((element) => element.textContent?.trim() === text && !element.closest('[aria-hidden="true"]'))
  check(matches.length === 1, `Expected one button '${text}', got ${matches.length}`)
  return matches[0]!
}
function ariaButton(label: string, container: ParentNode = document): HTMLButtonElement {
  const matches = [...container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)]
    .filter((element) => !element.closest('[aria-hidden="true"]'))
  check(matches.length === 1, `Expected one aria button '${label}', got ${matches.length}; available=${[...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")].map((element) => element.getAttribute("aria-label")).join("|")}; text=${container.textContent?.slice(0, 180)}`)
  return matches[0]!
}
async function click(element: HTMLElement) {
  check(!element.hasAttribute("disabled"), "Cannot click disabled control")
  flushSync(() => element.click())
  await settle()
}

async function bindForm() {
  let opened = 0
  let saved = 0
  await mounted(<CardBindForm idPrefix="check" name="" tree={[]} selection={emptyTreeSelection()}
    stores={[]} storeId="" psdFileName="" prompts={[]} promptId=""
    onNameChange={noop} onStoreChange={noop} onSelectL1={noop} onSelectL2={noop}
    onSelectType={noop} onRefreshTree={noop} onPickPsd={noop} onPromptChange={noop}
    onOpenStores={() => { opened += 1 }} onSubmitSave={() => { saved += 1 }} />,
  async () => {
    await click(button("打开店铺", fixture))
    check(opened === 1, "Open Stores must reach the supplied action")
    const form = fixture.querySelector("form")!
    flushSync(() => form.requestSubmit())
    await settle()
    check(saved === 0, "Invalid form must not save")
    check(!fixture.querySelector('[role="alert"]'), "Validation errors belong in the notification host")
    const notice = document.querySelector('[data-slot="toast"]')
    check(notice, "Missing validation notification host")
    check(notice?.textContent?.includes("无法保存，请补全下列项"), "Missing validation notification")
    check(["名称", "类目", "提示词"].every((label) => notice.textContent?.includes(label)), "Notification must name each missing field")
    const name = document.getElementById("check-name")!
    check(name.getAttribute("aria-invalid") === "true", "Invalid field must be marked")
    check(document.activeElement === name, "First invalid submit must focus its first invalid field")
    name.focus()
    flushSync(() => form.requestSubmit())
    await settle()
    check(document.activeElement === name, "Repeated invalid submit must retain the invalid field focus")
  })
}

export const schema: CategorySchemaView = {
  description_category_id: 1, type_id: 1, language: "zh_hans", complex_groups: [],
  fields: [{ key: "name", name: "名称", description: "", group_name: "基本", editor: "text", source: "fixed",
    read_only: false, complex_group_collection: false, aspect: null, constraints: { required: true, collection: false },
    options: [], options_truncated: false },
  { key: "attribute_23171", name: "搜索标签", description: "", group_name: "基本", editor: "text", source: "attribute",
    attribute_id: 23171, read_only: false, complex_group_collection: false, aspect: null,
    constraints: { required: false, collection: false }, options: [], options_truncated: false }],
}
export const ready: ListingRow = {
  id: "row-a", draftId: "row-a", imageName: "product.jpg", status: "ready", ai: "done", render: "done", upload: "done", log: "ready",
  readiness: { ready_to_publish: true, can_start_publish_attempt: true, blockers: [], allowed_actions: ["publish", "edit_fields"] },
}
export const product: WorkflowDraftView = {
  draft_id: ready.draftId, kind: "instance", parent_card_id: "card", display_name: "Product", schema,
  draft: { values: { name: { kind: "text", value: "Product" }, offer_id: { kind: "text", value: "offer-a" } }, complex_values: [] },
  validation_state: "draft", issues: [], ai_prompt_id: "prompt", ai_prompt: "", ai_prompt_file_name: "",
  psd_template_asset_id: "psd", psd_template_file_name: "template.psd", target_store_id: "store",
  ai_field_policy: { allowed_field_keys: ["name"], protected_field_keys: [] }, updated_at_ms: 1,
  lifecycle: { revision: 1, view_revision: 1, image_total: 1, image_completed: 1, stage: "ready_to_publish", ai: "ready", media: "ready", fields: "dirty",
    images: [{ index: 0, file_name: "slice.jpg", content_hash: "hash", group_name: "主体", width: 900, height: 1200,
      phase: "public_ready", public_url: "https://example.invalid/slice.jpg" }],
    failure_log: [], ai_candidates: [], product_videos: [] },
}
export const workbench: FieldWorkbenchProps = {
  schema, rows: [ready], productDrafts: { [ready.draftId]: product }, rowSaveStates: {},
  cardDraft: { values: {}, complex_values: [] }, cardIssues: [], cardFieldOrigins: [], targetStoreId: "store",
  busy: false, activity: NO_PREPARATION_ACTIVITY, preparationProgress: NO_PREPARATION_PROGRESS,
  guidedPreparation: NO_GUIDED_PREPARATION, queuePaused: false, queueRunning: false, queueStopRequested: false,
  storeConfigured: true, storeLabel: "Browser Test Store", dragging: false, selectedRowIds: new Set(),
  onSelectionChange: noop, onImportImages: noop, onClearRows: noop, onRemoveRows: noop, onEditCell: noop,
  onEditField: noop,
  onFlushRows: async () => true, onRetryRowSave: noop, onRunAiRows: noop, onRunRenderRows: noop, onRunDeliverRows: noop, onPrepareRows: noop,
  onStopPreparation: noop, onCancelRowIntent: noop, onSendRows: noop, onPauseQueue: noop,
  onUpdateCardDefault: noop, onCancelQueue: noop, onResumeQueue: noop,
}

/** The standing a signed-in shell already holds; no Workspace keeps telemetry paused. */
const signedIn: AccountOverview = { session: { authenticated: true }, workspaces: [], owned_count: 0, owned_limit: 0 }

function listingApiRow(stage: "ready_to_publish" | "submitting" | "accepted", viewRevision = 1) {
  return {
    id: ready.id, cardId: "card", storeId: "store", revision: viewRevision, viewRevision,
    projection: listingProjection({ stage }),
    contentState: "ready", mediaState: "ready", validationState: "passed",
    submissionState: stage === "submitting" ? "queued" : "none",
    draft: product.draft, validationIssues: [], media: { images: [], videos: [] },
    ai: { candidates: [] }, source: { fileName: ready.imageName }, payload: {},
updatedAtMs: viewRevision,
  }
}

function MountedQueue({ onHook }: { onHook: (hook: ReturnType<typeof usePublishQueue>) => void }) {
  const hook = usePublishQueue({
    cardTemplateId: "card", busy: false, storeConfigured: true,
    preparationTracks: useRef(createPreparationTracks()),
    guidedPreparationLock: useRef(false), flushAutosave: async () => true, flushAutosavesFor: async () => true,
  })
  const rows = useListingWorkbenchStore((current) => current.rows)
  const productDrafts = useListingWorkbenchStore((current) => current.productDrafts)
  const queuePaused = useListingWorkbenchStore((current) => current.queuePaused)
  const queueRunning = useListingWorkbenchStore((current) => current.queueRunning)
  onHook(hook)
  return <FieldWorkbench {...workbench} rows={rows} productDrafts={productDrafts} queuePaused={queuePaused} queueRunning={queueRunning}
    queueStopRequested={hook.queueStopRequested}
    onSendRows={(ids) => void hook.startPublish(ids)}
    onRepairRows={(ids) => void hook.repairRows(ids)}
    repairing={hook.repairInFlight}
    onPauseQueue={() => void hook.pausePublish()}
    onCancelRowIntent={(id) => void hook.cancelRowIntent(id)}
    onResumeQueue={() => void hook.resumePublish()}
  />
}

class QueueBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) { return { error } }
  render() { return this.state.error ? <pre>{this.state.error.stack ?? this.state.error.message}</pre> : this.props.children }
}
async function sendConfirmation() {
  const sent: string[][] = []
  await mounted(<FieldWorkbench {...workbench} onSendRows={(ids) => sent.push(ids)} />, async () => {
    const send = () => {
      const element = fixture.querySelector<HTMLButtonElement>('[aria-label="全部发送（1）到 Browser Test Store"]')
      check(element, "Missing Send control")
      return element
    }
    await click(send())
    check(sent.length === 0, "Opening confirmation must not send")
    let dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    check(dialog, "Missing confirmation portal")
    check(dialog.textContent?.includes("确认发送 1 件商品"), "Confirmation portal must show the chosen count")
    check(dialog.textContent.includes("库存 0"), "Confirmation must explain initial inventory")
    check(dialog.textContent.includes("发送后展示本次响应"), "Confirmation must explain how to inspect the result")
    check(dialog.textContent.includes("确认未收到后再恢复发送"), "Confirmation must require reconciliation before an uncertain retry")
    const description = dialog.getAttribute("aria-describedby")
    check(description && document.getElementById(description)?.textContent, "Confirmation description must resolve in the DOM")
    await click(button("取消", dialog))
    check(sent.length === 0, "Cancel must not send")
    await click(send())
    dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    check(dialog, "Confirmation must reopen")
    await click(button("确认发送", dialog))
    check(JSON.stringify(sent) === JSON.stringify([[ready.draftId]]), "Confirm must dispatch exactly the frozen row once")
  })
}

async function progressSubscription() {
  let renders = 0
  function Header() {
    const progress = useWorkflowProgress()
    renders += 1
    return <output id="progress">{JSON.stringify(progress)}</output>
  }
  resetListingWorkbench()
  patchListingWorkbench({ cardName: "Test", rows: [ready], queueRunning: true, queueFrozenIds: [ready.draftId] })
  await mounted(<Header />, async () => {
    const before = renders
    const value = document.getElementById("progress")!.textContent
    flushSync(() => projectListingRows((rows) => rows.map((row) => ({ ...row, log: "changed log" }))))
    await settle()
    check(renders === before, "Row log changes must not rerender mounted header")
    check(document.getElementById("progress")!.textContent === value, "Log must not change progress values")
    flushSync(() => patchListingWorkbench({ queuePaused: true }))
    await settle()
    check(renders > before && document.getElementById("progress")!.textContent?.includes('"state":"paused"'), "Paused queue must update mounted header")
  })
}

async function failureUnknownAndSaveFeedback() {
  let uploaded = 0
  const failure = "图片上传未完成，请检查网络后重试"
  const failedProduct: WorkflowDraftView = { ...product, lifecycle: {
    ...product.lifecycle, stage: "media_failed", media: "failed", last_error_detail: failure,
  } }
  const failedRow: ListingRow = { ...ready, stage: "media_failed", status: "exception", upload: "failed", log: failure,
    readiness: { ready_to_publish: false, can_start_publish_attempt: false, blockers: ["media_failed"], allowed_actions: ["retry_media"] } }
  await mounted(<FieldWorkbench {...workbench} rows={[failedRow]} productDrafts={{ [ready.id]: failedProduct }}
    onRunDeliverRows={(ids) => { check(ids[0] === ready.id, "Upload retry must select the failed row"); uploaded++ }} />,
  async () => {
    check(fixture.textContent?.includes(failure), "Failed upload must retain its precise recovery copy")
    await click(ariaButton("上传：失败，重试上传", fixture))
    check(uploaded === 1, "Upload failure must expose the upload retry action")
  })
  const unknownProduct: WorkflowDraftView = { ...product, lifecycle: { ...product.lifecycle, stage: "outcome_unknown" } }
  const unknownRow: ListingRow = { ...ready, stage: "outcome_unknown", status: "exception", log: "未取得响应",
    readiness: { ready_to_publish: false, can_start_publish_attempt: false, blockers: ["outcome_unknown"], allowed_actions: [] } }
  await mounted(<FieldWorkbench {...workbench} rows={[unknownRow]} productDrafts={{ [ready.id]: unknownProduct }} />, async () => {
    check(fixture.textContent?.includes("核对中") && fixture.textContent.includes("已提交 Ozon，结果未返回，系统会自动核对"), "Unknown must request reconciliation")
    const send = fixture.querySelector<HTMLButtonElement>('button[aria-label^="全部发送"]')
    check(send && (send.disabled || send.getAttribute("aria-disabled") === "true"), "Unknown result must not allow another send")
  })
  let retries = 0
  await mounted(<FieldWorkbench {...workbench} rowSaveStates={{ [ready.id]: "error" }}
    onRetryRowSave={(id) => { check(id === ready.id, "Save retry must select the dirty row"); retries++ }} />, async () => {
    check(fixture.textContent?.includes("保存失败"), "Save failure must remain visible")
    check(!fixture.textContent?.includes("已保存到云端"), "Failed save must not claim completion")
    await click(ariaButton("重试", fixture))
    check(retries === 1, "Dirty input must offer a save retry")
  })
}

async function waitUntil(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 120 && !predicate(); attempt += 1) await settle()
  check(predicate(), message)
}

function queueCard(paused = false) {
  return { id: "card", revision: 1, payload: { queue: { frozenRowIds: [ready.draftId], paused, stopAfterCurrent: paused, nextPosition: 0 } }, updatedAtMs: 1 }
}

async function mountedSendPauseKeepsLateSseTerminal() {
  resetListingWorkbench()
  rememberAccountOverview(signedIn)
  patchListingWorkbench({ rows: [ready], queueFrozenIds: [ready.draftId], productDrafts: { [ready.draftId]: product } })
  const originalFetch = window.fetch
  let releaseSubmit!: () => void
  const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve })
  let submitStarted = false
  window.fetch = async (input, init) => {
    const url = String(input)
    if (url === "/api/view/account-overview") return Response.json({ data: { session: { authenticated: true } } })
    if (url === "/api/ops/products/sync") return Response.json({ data: { products: [] } })
    if (url === `/api/listing/rows/${ready.id}`) return Response.json({ data: listingApiRow("ready_to_publish") })
    if (url === "/api/listing/rows" || url.startsWith("/api/listing/rows?")) return Response.json({ data: { items: [listingApiRow("ready_to_publish")], nextCursor: null } })
    if (url === "/api/listing/cards/card" && init?.method === "PATCH") return Response.json({ data: queueCard(true) })
    if (url === "/api/listing/cards/card") return Response.json({ data: queueCard() })
    if (url === "/api/listing/batch/submit") {
      submitStarted = true
      await submitGate
      return Response.json({ data: { items: [{ rowId: ready.id, created: true, intent: { id: "intent-late" }, row: listingApiRow("submitting", 2) }] } })
    }
    if (url.startsWith("/api/listing/intents?")) return Response.json({ data: { items: [], nextCursor: null } })
    throw new Error(`unexpected request ${url}`)
  }
  try {
    await mounted(<QueueBoundary><MountedQueue onHook={() => {}} /></QueueBoundary>, async () => {
      await click(ariaButton('全部发送（1）到 Browser Test Store', fixture))
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
      check(dialog, "Missing mounted send confirmation")
      await click(button("确认发送", dialog))
      await waitUntil(() => submitStarted, "Mounted send did not reach the deferred submit")
      check(peekQueueRunning(), "Queue must stay locked while submit is pending")
      await click(ariaButton("暂停发送队列", fixture))
      await waitUntil(() => useListingWorkbenchStore.getState().queuePaused, "Pause callback did not update the workbench")
      const terminal = { ...product, lifecycle: { ...product.lifecycle, stage: "accepted" as const, view_revision: 3 } }
      receiveListingProducts([{ product: terminal, readiness: ready.readiness as never }], new Set(), listingWorkbenchScope())
      releaseSubmit()
      await waitUntil(() => useListingWorkbenchStore.getState().productBases[ready.draftId]?.lifecycle.stage === "accepted", "Late submit receipt overwrote the SSE terminal state")
    })
  } finally {
    releaseSubmit?.()
    window.fetch = originalFetch
    invalidateAccountOverview()
    resetListingWorkbench()
  }
}

function peekQueueRunning() {
  return useListingWorkbenchStore.getState().queueRunning
}

function repairFixture() {
  const definitions = [
    { id: "unavailable", code: "BR_hashtag_brand" },
    { id: "brand", code: "BR_hashtag_brand" },
    { id: "duplicate", code: "SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT" },
    { id: "published", code: undefined },
  ]
  const products = definitions.map(({ id, code }): WorkflowDraftView => ({
    ...product, draft_id: id, display_name: `${id}.jpg`,
    draft: { ...product.draft, values: { ...product.draft.values, attribute_23171: { kind: "text", value: "#brand #art" } } },
    lifecycle: { ...product.lifecycle, stage: "publish_rejected", fields: "valid", last_error_code: code },
  }))
  const rows = definitions.map(({ id, code }): ListingRow => ({
    ...ready, id, draftId: id, imageName: `${id}.jpg`, status: code ? "exception" : "sent",
    log: code ?? "已上架",
    readiness: { ready_to_publish: false, can_start_publish_attempt: !!code,
      blockers: code ? ["publish_conflict"] : [], allowed_actions: code ? ["edit_fields", "publish"] : [] },
  }))
  return { rows, productDrafts: Object.fromEntries(products.map((item) => [item.draft_id, item])) }
}

async function mountedBrandRepairKeepsPreparation() {
  resetListingWorkbench()
  const initial = repairFixture()
  patchListingWorkbench(initial)
  const originalFetch = window.fetch
  const writes: Array<{ url: string; body: unknown }> = []
  let releaseRepair!: () => void
  const gate = new Promise<void>((resolve) => { releaseRepair = resolve })
  let repaired = false
  const apiRow = () => ({
    ...listingApiRow(repaired ? "submitting" : "ready_to_publish", repaired ? 2 : 1),
    id: "brand", source: { fileName: "brand.jpg" },
    submissionState: repaired ? "queued" : "rejected",
    projection: listingProjection({ stage: repaired ? "submitting" : "publish_rejected", error_code: repaired ? undefined : "BR_hashtag_brand",
      readiness: { ready_to_publish: false, can_start_publish_attempt: !repaired,
        blockers: repaired ? [] : ["publish_conflict"], allowed_actions: repaired ? [] : ["edit_fields", "publish"] } }),
    draft: repaired
      ? { ...product.draft, cleared: ["attribute_23171"] }
      : initial.productDrafts.brand!.draft,
    media: { images: product.lifecycle.images, videos: [] },
  })
  window.fetch = async (input, init) => {
    const url = String(input)
    if (url === "/api/listing/rows/unavailable") return Response.json({ error: { message: "该商品暂时不可读" } }, { status: 404 })
    if (url === "/api/listing/rows/brand" && (!init?.method || init.method === "GET")) {
      return Response.json({ data: apiRow() })
    }
    if (init?.method && init.method !== "GET") writes.push({ url, body: JSON.parse(String(init.body)) })
    if (url === "/api/listing/rows/brand/repair-and-submit" && init?.method === "POST") {
      await gate
      repaired = true
      return Response.json({ data: { items: [{ rowId: "brand", created: true, intent: { id: "repair-intent" }, row: apiRow() }] } })
    }
    unexpectedRequests.push(url)
    throw new Error(`Unexpected repair request: ${url}`)
  }
  try {
    await mounted(<QueueBoundary><MountedQueue onHook={() => {}} /></QueueBoundary>, async () => {
      const action = ariaButton("修复并重试 2", fixture)
      await click(action)
      await waitUntil(() => writes.length === 1, "Repair button did not dispatch")
      await settle()
      const pendingAction = ariaButton("修复并重试 2", fixture)
      check(pendingAction.disabled || pendingAction.getAttribute("aria-disabled") === "true", "Repair must disable repeat clicks while pending")
      pendingAction.click()
      releaseRepair()
      await waitUntil(() => useListingWorkbenchStore.getState().productDrafts.brand?.lifecycle.stage === "submitting", "Repair receipt did not update the row")
      const after = useListingWorkbenchStore.getState().productDrafts
      check(JSON.stringify(writes) === JSON.stringify([{ url: "/api/listing/rows/brand/repair-and-submit", body: { expectedRevision: 1 } }]), "Repair must issue only one targeted write, with no preparation or second submit")
      check(!after.brand?.draft.values.attribute_23171, "Old tags remained in editor after repair")
      check(JSON.stringify(after.brand?.lifecycle.images) === JSON.stringify(product.lifecycle.images), "Repair discarded uploaded media")
      check(after.unavailable === initial.productDrafts.unavailable && after.duplicate === initial.productDrafts.duplicate && after.published === initial.productDrafts.published, "Repair changed unrelated or failed rows")
    })
  } finally {
    releaseRepair?.()
    window.fetch = originalFetch
    resetListingWorkbench()
  }
}

async function mountedSingleRowCancelRescansIntent() {
  resetListingWorkbench()
  rememberAccountOverview(signedIn)
  patchListingWorkbench({ rows: [ready], queueFrozenIds: [ready.draftId], productDrafts: { [ready.draftId]: product } })
  const originalFetch = window.fetch
  let releaseSubmit!: () => void
  const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve })
  let submitStarted = false
  let intentReads = 0
  let cancelCalls = 0
  window.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin)
    if (url.pathname === "/api/view/account-overview") return Response.json({ data: { session: { authenticated: true } } })
    if (url.pathname === "/api/ops/products/sync") return Response.json({ data: { products: [] } })
    if (url.pathname === `/api/listing/rows/${ready.id}`) return Response.json({ data: listingApiRow("ready_to_publish") })
    if (url.pathname === "/api/listing/rows" ) return Response.json({ data: { items: [listingApiRow("ready_to_publish")], nextCursor: null } })
    if (url.pathname === "/api/listing/cards/card" && init?.method === "PATCH") return Response.json({ data: queueCard() })
    if (url.pathname === "/api/listing/cards/card") return Response.json({ data: queueCard() })
    if (url.pathname === "/api/listing/batch/submit") {
      submitStarted = true
      await submitGate
      return Response.json({ data: { items: [{ rowId: ready.id, created: true, intent: { id: "intent-cancel" } }] } })
    }
    if (url.pathname === "/api/listing/intents") {
      intentReads += 1
      return intentReads === 1
        ? Response.json({ data: { items: [], nextCursor: null } })
        : Response.json({ data: { items: [{ id: "intent-cancel", listingRowId: ready.id, state: "queued" }], nextCursor: null } })
    }
    if (url.pathname === "/api/listing/intents/intent-cancel/cancel" && init?.method === "POST") {
      cancelCalls += 1
      return Response.json({ data: { id: "intent-cancel", state: "queued" } })
    }
    throw new Error(`unexpected request ${url}`)
  }
  try {
    await mounted(<QueueBoundary><MountedQueue onHook={() => {}} /></QueueBoundary>, async () => {
      await click(ariaButton('全部发送（1）到 Browser Test Store', fixture))
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
      await click(button("确认发送", dialog))
      await waitUntil(() => submitStarted, "Mounted send did not reach the deferred submit")
      // Cloud can publish its queued fact before the submit HTTP response arrives.
      receiveListingProducts([{ product: { ...product, lifecycle: { ...product.lifecycle, stage: "queued", view_revision: 2 } },
        readiness: { ready_to_publish: false, can_start_publish_attempt: false, blockers: [], allowed_actions: [] } }], new Set(), listingWorkbenchScope())
      await waitUntil(() => !!fixture.querySelector('[aria-label="取消发送 product.jpg"]'), "Mounted row cancel action did not appear")
      await click(fixture.querySelector('[aria-label="取消发送 product.jpg"]') as HTMLButtonElement)
      releaseSubmit()
      await waitUntil(() => cancelCalls === 1, "Single-row cancel did not rescan and cancel the late Intent")
      check(intentReads === 2, "Single-row cancel should perform the final in-flight rescan")
    })
  } finally {
    releaseSubmit?.()
    window.fetch = originalFetch
    invalidateAccountOverview()
    resetListingWorkbench()
  }
}

run.onclick = async () => {
  run.disabled = true
  results.textContent = "运行中"
  results.dataset.result = "running"
  unexpectedRequests.length = 0
  const lines: string[] = []
  for (const [name, action] of [["Bind form actions and validation focus", bindForm], ["Send confirmation portal", sendConfirmation], ["Mounted progress subscription", progressSubscription], ["Failure, unknown and save retry feedback", failureUnknownAndSaveFeedback], ["Mounted send pause and late SSE terminal", mountedSendPauseKeepsLateSseTerminal], ["Mounted single-row cancel rescan", mountedSingleRowCancelRescansIntent], ["Brand repair reuses preparation and isolates rows", mountedBrandRepairKeepsPreparation]] as const) {
    try { await action(); lines.push(`PASS ${name}`) }
    catch (error) { lines.push(`FAIL ${name}: ${String(error)}`) }
    results.textContent = lines.join("\n")
  }
  if (unexpectedRequests.length) lines.push(`FAIL Unexpected network: ${unexpectedRequests.join(", ")}`)
  results.textContent = lines.join("\n")
  results.dataset.result = lines.some((line) => line.startsWith("FAIL")) ? "failed" : "passed"
  run.disabled = false
}

if (new URL(location.href).searchParams.has("repair-preview")) {
  run.hidden = true
  results.textContent = "修复操作预览；此页面不会发送请求。"
  const root = createRoot(fixture)
  root.render(<FieldWorkbench {...workbench} {...repairFixture()} />)
  import.meta.hot?.dispose(() => root.unmount())
}
