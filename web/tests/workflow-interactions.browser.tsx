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
import { createWorkflowPublishCapabilities } from "@/features/workflow/workflow-publish-capabilities"
import { createWorkflowPublishNative } from "@/features/workflow/workflow-publish-native"
import type { BrandRepairCapability } from "@/features/workflow/submit/use-repair-publish"
import { primeCardSession, resetCardSessions } from "@/features/workflow/card/card-session"
import { rememberListingRows, rowCacheScope } from "@/bindings/listing-row-cache"
import { readListingRowFresh } from "@/bindings/listing-row-cache"
import { patchListingRow } from "@/bindings/http-listing"
import type { ListingCardView, ListingRowView } from "@/bindings/listing-projection"
import { readCategorySchema } from "@/bindings/listing-material-cache"
import { rememberStoreRoster } from "@/features/stores/store-roster-cache"
import { rowStatusView } from "@/features/workflow/model/row-state"
import { projectListingRowLifecycle } from "@/features/workflow/model/listing-row-lifecycle"
import type { RowStage } from "@/bindings/commands"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { ListingCoreClient, type CardPayload, type CategorySchemaSnapshot, type EditRowOutput, type LeanRow } from "@/listing-core/client"
import { defaultSendCore } from "@/features/workflow/submit/send-native"
import { createPreparationTracks, NO_GUIDED_PREPARATION, NO_PREPARATION_ACTIVITY, NO_PREPARATION_PROGRESS } from "@/features/workflow/prepare/preparation-tracks"
import goldenJson from "./fixtures/listing-core/ozon-publish-input.json"
import schemaJson from "./fixtures/listing-core/decorative-wall-art-schema.json"
import wasmUrl from "../../wasm/dist/browser/listing-state.wasm?url"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const unexpectedRequests: string[] = []
const golden = goldenJson as unknown as { row: LeanRow; card: CardPayload }
const nativeSchema: CategorySchemaSnapshot = {
  ...schemaJson as unknown as CategorySchemaSnapshot,
  fields: [...schemaJson.fields, { ...schemaJson.fields.find((field) => field.key === "name")!,
    key: "attribute_23171", attribute_id: "23171", complex_id: null, required: false }] as CategorySchemaSnapshot["fields"],
}
const localFetch = window.fetch.bind(window)
const wasmAddress = new URL(wasmUrl, location.href)
let wasmBytes: ArrayBuffer
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  if (url.origin === location.origin && method === "GET") {
    if (url.href === wasmAddress.href) return localFetch(input, init)
    if (url.pathname === "/api/ai/prices") return Response.json({ data: { prices: [] } })
    if (url.pathname === "/api/catalog/schema"
      && url.searchParams.get("descriptionCategoryId") === String(nativeSchema.description_category_id)
      && url.searchParams.get("typeId") === String(nativeSchema.type_id)
      && url.searchParams.get("language") === "default") return Response.json({ data: {
      description_category_id: nativeSchema.description_category_id, type_id: nativeSchema.type_id,
      language: "default", fetched_at_ms: 1, fields: [], nativeMaterial: { snapshot: nativeSchema, searchMaterials: [] },
    } })
  }
  unexpectedRequests.push(`${method} ${url.pathname}`)
  throw new Error(`Unexpected network request: ${method} ${url.href}`)
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
    .filter((element) => element.textContent?.trim() === text && !element.closest('[aria-hidden="true"], [data-closed]'))
  check(matches.length === 1, `Expected one button '${text}', got ${matches.length}`)
  return matches[0]!
}
function ariaButton(label: string, container: ParentNode = document): HTMLButtonElement {
  const matches = [...container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)]
    .filter((element) => !element.closest('[aria-hidden="true"], [data-closed]'))
  check(matches.length === 1, `Expected one aria button '${label}', got ${matches.length}; available=${[...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")].map((element) => element.getAttribute("aria-label")).join("|")}; text=${container.textContent?.slice(0, 180)}`)
  return matches[0]!
}
function sendDialog(count = 1, selected = false): HTMLElement {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .filter((element) => !element.closest('[aria-hidden="true"], [data-closed]'))
  check(dialogs.length === 1, `Expected one open confirmation portal, got ${dialogs.length}`)
  const dialog = dialogs[0]!
  const title = dialog.getAttribute("aria-labelledby")
  check(title && document.getElementById(title)?.textContent === `确认发送${selected ? "选中的" : ""} ${count} 件商品？`, "Confirmation portal must name the exact frozen count")
  return dialog
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
  description_category_id: nativeSchema.description_category_id, type_id: nativeSchema.type_id, language: "default", complex_groups: [],
  fields: [{ key: "name", name: "名称", description: "", group_name: "基本", editor: "text", source: "fixed",
    read_only: false, complex_group_collection: false, aspect: null, constraints: { required: true, collection: false },
    options: [], options_truncated: false },
  { key: "attribute_23171", name: "搜索标签", description: "", group_name: "基本", editor: "text", source: "attribute",
    attribute_id: 23171, read_only: false, complex_group_collection: false, aspect: null,
    constraints: { required: false, collection: false }, options: [], options_truncated: false }],
}
export const ready: ListingRow = {
  id: "row-a", draftId: "row-a", imageName: "product.jpg", stage: "ready_to_publish", status: "ready", ai: "done", render: "done", upload: "done", log: "ready",
  readiness: { ready_to_publish: true, can_start_publish_attempt: true, blockers: [], allowed_actions: ["publish", "edit_fields"] },
}
export const product: WorkflowDraftView = {
  draft_id: ready.draftId, kind: "instance", parent_card_id: "card", display_name: "Product", schema,
  draft: { ...structuredClone(golden.row.draft), values: { ...structuredClone(golden.row.draft.values), offer_id: { kind: "text", value: "offer-a" } } },
  validation_state: "draft", issues: [], ai_prompt_id: "prompt", ai_prompt: "", ai_prompt_file_name: "",
  psd_template_asset_id: "psd", psd_template_file_name: "template.psd", target_store_id: "store",
  ai_field_policy: { allowed_field_keys: ["name"], protected_field_keys: [] }, updated_at_ms: 1,
  lifecycle: { revision: 1, view_revision: 1, image_total: 1, image_completed: 1, stage: "ready_to_publish", ai: "ready", media: "ready", fields: "valid",
    images: structuredClone(golden.row.media.images).map((image) => ({ ...image,
      public_url: image.public_url ?? undefined, object_key: image.object_key ?? undefined,
      error_code: image.error_code ?? undefined, account_id: image.account_id ?? undefined })),
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

const signedIn: AccountOverview = {
  session: { authenticated: true, uuid: "fixture-actor", email: "actor@example.invalid" }, owned_count: 1, owned_limit: 1, workspaces: [],
  active_workspace: { id: 1, uuid: "fixture-workspace", is_owned: true, name: "Fixture", plan: "test", role: "owner" },
}

function listingApiRow(stage: "ready_to_publish" | "submitting" | "accepted", viewRevision = 1): ListingRowView {
  const payload = structuredClone(golden.row)
  payload.draft = structuredClone(product.draft)
  payload.source.fileName = ready.imageName
  return {
    id: ready.id, card_id: "card", store_id: "store", revision: 1, view_revision: viewRevision,
    projection: listingProjection({ stage, image_total: 1, image_completed: 1,
      ...(stage === "ready_to_publish" ? {} : { readiness: {
        ready_to_publish: false, can_start_publish_attempt: false, blockers: [], allowed_actions: [],
      } }) }),
    content_state: "ready", media_state: "ready", validation_state: "passed",
    submission_state: stage === "submitting" ? "queued" : stage === "accepted" ? "accepted" : "none",
    draft: payload.draft, validation_issues: [], media: payload.media, ai: payload.ai,
    source: payload.source, payload: payload as never, build: { state: "built", sources: [] }, updated_at_ms: viewRevision,
  }
}

async function seedQueue() {
  invalidateAllSessionCaches()
  resetCardSessions()
  resetListingWorkbench()
  rememberAccountOverview(signedIn)
  rememberStoreRoster({ stores: [{
    id: "store", cloud_store_uuid: "store", active: true, label: "Browser Test Store", configured: true,
    cloud_status: "active", can_manage: true, can_edit_credential: false,
    client_id: "", advertising_client_id: "", advertising_configured: false, needs_reentry: false,
    ref_id: "", secret_status: "present", updated_at_ms: 1, watermark_name: "",
    permissions: { manage_store: true, manage_key: false, delete_store: false,
      edit_name: false, manage_tags: false, test_key: false },
  }] }, 1)
  await readCategorySchema({ descriptionCategoryId: nativeSchema.description_category_id, typeId: nativeSchema.type_id, language: "default" })
  const card = queueCard()
  primeCardSession(card)
  const raw = listingApiRow("ready_to_publish")
  rememberListingRows([raw], rowCacheScope())
  patchListingWorkbench({ cardId: "card", rows: [ready], queueFrozenIds: [ready.draftId],
    productDrafts: { [ready.draftId]: { ...product, ...rowStatusView(raw) } } })
  return card
}

function MountedQueue({ onHook, repair, onRepairStarted }: {
  onHook: (hook: ReturnType<typeof usePublishQueue>) => void
  repair?: BrandRepairCapability
  onRepairStarted?: (operation: Promise<void>) => void
}) {
  const hook = usePublishQueue({
    cardTemplateId: "card", busy: false, storeConfigured: true, brandRepairCapability: repair,
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
    onRepairRows={(ids) => {
      const operation = hook.repairRows(ids)
      onRepairStarted?.(operation)
      void operation
    }}
    brandRepairAvailable={Boolean(repair)} canRepairRow={repair?.current}
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
    let dialog = sendDialog()
    check(dialog.textContent?.includes("库存 0"), "Confirmation must explain initial inventory")
    check(dialog.textContent?.includes("发送后展示本次响应"), "Confirmation must explain how to inspect the result")
    check(dialog.textContent?.includes("确认未收到后再恢复发送"), "Confirmation must require reconciliation before an uncertain retry")
    const description = dialog.getAttribute("aria-describedby")
    check(description && document.getElementById(description)?.textContent, "Confirmation description must resolve in the DOM")
    await click(button("取消", dialog))
    check(sent.length === 0, "Cancel must not send")
    await click(send())
    dialog = sendDialog()
    await click(button("确认发送", dialog))
    check(JSON.stringify(sent) === JSON.stringify([[ready.draftId]]), "Confirm must dispatch exactly the frozen row once")
  })
}

async function proseEditorFocusAndEscape() {
  let committed = 0
  await mounted(<FieldWorkbench {...workbench} onEditCell={() => { committed += 1 }} onEditField={() => { committed += 1 }} />, async () => {
    const opener = ariaButton("商品名称 product.jpg", fixture)
    opener.focus()
    await click(opener)
    const editor = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="商品名称 product.jpg"]')
    check(editor, "The real product-name button must open its textarea editor")
    const dialog = editor.closest<HTMLElement>('[role="dialog"]')!
    await waitUntil(() => document.activeElement === editor, "The editor must receive the dialog's initial focus")
    // Base UI's AT-hidden guards are the popup's adjacent siblings in the same portal.
    const guards = [dialog.previousElementSibling, dialog.nextElementSibling]
    check(guards.every((element) => element instanceof HTMLElement
      && element.matches('[data-base-ui-focus-guard][data-type="inside"]')
      && element.parentElement === dialog.parentElement), "The open modal must own both adjacent keyboard focus guards")
    // Reproduce the focus-boundary events. Native Tab navigation is checked separately in ?editor-preview.
    ;(guards[0] as HTMLElement).focus()
    const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')]
      .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)
    await waitUntil(() => document.activeElement === controls.at(-1), "The leading guard must wrap focus to the last modal control")
    ;(guards[1] as HTMLElement).focus()
    await waitUntil(() => document.activeElement === editor, "The trailing guard must wrap focus to the textarea")
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    flushSync(() => { setValue.call(editor, "Discard this fixture edit"); editor.dispatchEvent(new Event("input", { bubbles: true })) })
    flushSync(() => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    await waitUntil(() => document.activeElement === opener, "Escape must restore focus to the exact product-name button")
    check(committed === 0, "Escape must discard the edited draft without saving")
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

function stageFixture() {
  const definitions: Array<[string, RowStage]> = [["material", "awaiting_content"], ["process", "fields_invalid"],
    ["ready-one", "ready_to_publish"], ["ready-two", "build_stale"], ["receipt", "accepted"],
    ["checking", "outcome_unknown"], ["manual", "outcome_unknown"]]
  const drafts: Record<string, WorkflowDraftView> = {}, raw: Record<string, ListingRowView> = {}
  const rows = definitions.map(([id, stage]) => {
    const wire = listingApiRow("ready_to_publish")
    const canSend = stage === "ready_to_publish" || stage === "build_stale"
    wire.id = id
    wire.draft = { ...wire.draft, values: { ...wire.draft.values, offer_id: { kind: "text", value: id } } }
    wire.payload = { ...wire.payload as LeanRow, draft: wire.draft }
    wire.source = { fileName: `${id}.jpg` }
    wire.projection = listingProjection({ stage, readiness: { ready_to_publish: canSend, can_start_publish_attempt: canSend,
      blockers: [], allowed_actions: canSend ? ["publish", "edit_fields"] : ["edit_fields"] },
      import_probe: id === "manual" ? { phase: "needs_manual", passes: 3 } : undefined })
    raw[id] = wire
    const status = rowStatusView(wire)
    drafts[id] = { ...product, draft_id: id, ...status }
    return projectListingRowLifecycle({ ...ready, id, draftId: id, imageName: `${id}.jpg` }, status.lifecycle, status.readiness)
  })
  return { rows, drafts, raw }
}

function StageWorkbench({ onSend = noop, onPause = noop, onStop = noop, onEdit = noop, initialView = "all" }: {
  onSend?: (ids: string[]) => void; onPause?: () => void; onStop?: () => void
  onEdit?: FieldWorkbenchProps["onEditCell"]; initialView?: FieldWorkbenchProps["initialView"]
}) {
  const state = useListingWorkbenchStore()
  return <FieldWorkbench {...workbench} initialView={initialView} rows={state.rows} productDrafts={state.productDrafts}
    selectedRowIds={new Set(state.selectedIds)} onSelectionChange={(ids) => patchListingWorkbench({ selectedIds: ids })}
    queueRunning={state.queueRunning} queuePaused={state.queuePaused} onSendRows={onSend}
    onPauseQueue={onPause} onCancelQueue={onStop} onEditCell={onEdit} />
}

async function changeStage(view: string) {
  const tab = fixture.querySelector<HTMLElement>(`[role="tab"][data-workflow-view="${view}"]`)
  check(tab, `Missing real Nova stage tab: ${view}`)
  await click(tab)
  const panelId = tab.getAttribute("aria-controls")
  const panel = panelId ? document.getElementById(panelId) : null
  check(tab.getAttribute("aria-selected") === "true" && panel?.getAttribute("role") === "tabpanel"
    && panel.getAttribute("aria-labelledby") === tab.id, "The active Nova tab must own its mounted, labelled panel")
}

async function stageScopeAndKeyboard() {
  resetListingWorkbench()
  const data = stageFixture()
  patchListingWorkbench({ rows: data.rows, productDrafts: data.drafts, selectedIds: ["material", "ready-one"] })
  const sent: string[][] = []
  let pauses = 0, stops = 0
  await mounted(<StageWorkbench onSend={(ids) => sent.push(ids)} onPause={() => { pauses += 1 }} onStop={() => { stops += 1 }} />, async () => {
    check(fixture.querySelectorAll('[role="tablist"][aria-label="精铺流程阶段"] [role="tab"]').length === 5, "Four real stages and the full overview must be available")
    const matrix = fixture.querySelector<HTMLElement>('[aria-label="批量上架数据表格矩阵"]')!
    for (const view of ["materials", "processing", "ready", "receipts"]) {
      await changeStage(view)
      check(fixture.querySelector('[aria-label="批量上架数据表格矩阵"]') === matrix, "Switching stages must retain the same matrix instance")
      check(useListingWorkbenchStore.getState().selectedIds.length === 0, "Changing stages must clear the previous selection")
    }
    check(!fixture.textContent?.includes("已在售") && !fixture.textContent?.includes("上架成功"), "Accepted receipts must never claim actual sale")
    await changeStage("ready")
    const all = fixture.querySelector<HTMLElement>('[aria-label="选择当前视图全部商品"]')!
    await click(all)
    check(JSON.stringify(useListingWorkbenchStore.getState().selectedIds) === JSON.stringify(["ready-one", "ready-two"]), "View Select All must exclude hidden stages")
    await click(ariaButton("发送选中（2）到 Browser Test Store", fixture))
    await click(button("确认发送", sendDialog(2, true)))
    check(JSON.stringify(sent) === JSON.stringify([["ready-one", "ready-two"]]), "Confirmed send must freeze only visible selected rows")
    flushSync(() => patchListingWorkbench({ selectedIds: ["material", "ready-one"] }))
    await settle()
    await click(ariaButton("发送选中（1）到 Browser Test Store", fixture))
    await click(button("确认发送", sendDialog(1, true)))
    check(JSON.stringify(sent[1]) === JSON.stringify(["ready-one"]), "A hidden parent selection must not leak into send")
    await changeStage("processing")
    flushSync(() => matrix.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })))
    await settle()
    check(fixture.querySelector('[aria-label="工作台键盘矩阵导航状态"]')?.textContent?.includes("R1:"), "Grid navigation must acquire a coordinate in its current view")
    await changeStage("ready")
    check(!fixture.querySelector('[aria-label="工作台键盘矩阵导航状态"]')?.textContent?.match(/R\d+:C\d+/), "View changes must reset the previous grid coordinate")
    flushSync(() => matrix.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })))
    await settle()
    check(useListingWorkbenchStore.getState().selectedIds.length === 0, "Space after a view reset must not toggle the old row")
    await changeStage("receipts")
    await click(button("需人工核对 1", fixture))
    check(fixture.querySelectorAll('tr[data-row-index]').length === 1
      && fixture.querySelector('[aria-label="商品名称 manual.jpg"]'), "Stage and reconciliation filters must intersect")
    await click(fixture.querySelector<HTMLElement>('[aria-label="选择当前视图全部商品"]')!)
    check(JSON.stringify(useListingWorkbenchStore.getState().selectedIds) === JSON.stringify(["manual"]), "Reconciliation Select All must cover only its visible intersection")
    await changeStage("materials")
    flushSync(() => patchListingWorkbench({ queueRunning: true, queuePaused: false }))
    await settle()
    check(fixture.querySelector('[aria-label="全方案运行状态"]')?.textContent?.includes("发送队列进行中"), "A filtered material view must retain the global queue's running fact")
    await click(ariaButton("暂停发送队列", fixture))
    check(pauses === 1, "Filtered views must still reach the global pause callback")
    await click(ariaButton("运行状态：发送队列进行中", fixture))
    await click(button("停止后续发送"))
    check(stops === 1, "Filtered views must still reach the global stop callback")
  })
}

async function savedRowMovesBetweenStageViews() {
  resetListingWorkbench()
  const data = stageFixture()
  const before = data.drafts.material!
  patchListingWorkbench({ rows: [data.rows[0]!], productDrafts: { material: before } })
  const originalFetch = window.fetch
  let saved = data.raw.material!, writes = 0, reads = 0, error: unknown
  window.fetch = async (input, init) => {
    const path = new URL(String(input), location.href).pathname
    if (path === "/api/listing/rows/material" && init?.method === "PATCH") {
      writes += 1
      const body = JSON.parse(String(init.body))
      check(body.baseRevision === 1, "Editing must save against the actual captured row revision")
      saved = { ...saved, revision: 2, view_revision: 2, draft: body.draft,
        payload: { ...saved.payload as LeanRow, draft: body.draft }, projection: listingProjection() }
      return Response.json({ data: saved })
    }
    if (path === "/api/listing/rows/material" && (!init?.method || init.method === "GET")) { reads += 1; return Response.json({ data: saved }) }
    return originalFetch(input, init)
  }
  const edit: FieldWorkbenchProps["onEditCell"] = (id, column, value) => {
    void (async () => {
      check(column === "name", "This check edits the real product-name field")
      await patchListingRow(id, { baseRevision: 1, draft: { ...before.draft,
        values: { ...before.draft.values, name: { kind: "text", value } } } })
      const fresh = await readListingRowFresh(id)
      const status = rowStatusView(fresh)
      receiveListingProducts([{ product: { ...before, ...status }, readiness: status.readiness }], new Set(), listingWorkbenchScope())
    })().catch((reason) => { error = reason })
  }
  try {
    await mounted(<StageWorkbench initialView="materials" onEdit={edit} />, async () => {
      await click(ariaButton("商品名称 material.jpg", fixture))
      const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="商品名称 material.jpg"]')!
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
      flushSync(() => { setValue.call(input, "Saved fixture title"); input.dispatchEvent(new Event("input", { bubbles: true })) })
      await click(button("只改这一格", input.closest('[role="dialog"]')!))
      await waitUntil(() => useListingWorkbenchStore.getState().productDrafts.material?.lifecycle.revision === 2 || !!error, "Saved readback did not reach the real workbench projection")
      check(!error && writes === 1 && reads === 1, `Saving must perform one CAS and one actual binding readback: ${String(error)}`)
      check(fixture.textContent?.includes("当前视图没有商品") && fixture.querySelector('[data-workflow-view="all"]')?.textContent?.endsWith("1"), "A row that moved stages must leave a scoped empty view and retain the real overview count")
      receiveListingProducts([{ product: before, readiness: data.rows[0]!.readiness! }], new Set(), listingWorkbenchScope())
      await settle()
      check(useListingWorkbenchStore.getState().productDrafts.material!.lifecycle.revision === 2, "A late older projection must not return the saved row to its previous stage")
      await changeStage("ready")
      check(fixture.querySelector('[aria-label="商品名称 material.jpg"]')?.textContent?.includes("Saved fixture title"), "The saved title must appear in the new stage without another edit")
      await changeStage("materials")
      await click(button("查看全部总览", fixture))
      check(fixture.querySelector('[data-workflow-active-view="all"] [aria-label="商品名称 material.jpg"]'), "Scoped empty recovery must show the same saved row in the overview")
    })
  } finally { window.fetch = originalFetch }
}

function queueCard(): ListingCardView {
  return { id: "card", title: "Fixture", store_id: "store", revision: 1,
    payload: { ...structuredClone(golden.card), targetStoreId: "store", queue: {
      frozenRowIds: [ready.draftId], paused: false, stopAfterCurrent: false, nextPosition: 0,
    } }, updated_at_ms: 1 }
}

function patchQueueCard(card: ListingCardView, init: RequestInit): ListingCardView {
  const body = JSON.parse(String(init.body))
  check(body.baseRevision === card.revision, "Queue PATCH must use the current Card CAS revision")
  return { ...card, revision: card.revision + 1, payload: body.payload, updated_at_ms: card.updated_at_ms + 1 }
}

function submitIntent(id: string, rowId = ready.id, revision = 1, state = "queued") {
  return { id, listing_row_id: rowId, row_revision: revision, store_id: "store", state,
    client_operation_id: `fixture-${id}`, can_resume: false, current_issue_status: "absent",
    submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 1 }
}

function checkSubmit(init: RequestInit, rowId = ready.id, revision = 1) {
  check(init.method === "POST", "Submit must be a POST")
  check(JSON.stringify(JSON.parse(String(init.body))) === JSON.stringify({ store_id: "store", row_ids: [rowId],
    expected_revisions: [{ row_id: rowId, revision }] }), "Submit must pin only the chosen row and revision in the original Store")
}

async function mountedSendPauseKeepsLateSseTerminal() {
  let card = await seedQueue()
  const originalFetch = window.fetch
  let releaseSubmit!: () => void
  const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve })
  let submitStarted = false
  let submitCalls = 0
  let pauseWrites = 0
  window.fetch = async (input, init) => {
    const url = new URL(String(input), location.href)
    if (url.pathname === "/api/listing/rows" && (!init?.method || init.method === "GET")) return Response.json({ data: { items: [listingApiRow("ready_to_publish")], nextCursor: null } })
    if (url.pathname === "/api/listing/cards/card" && init?.method === "PATCH") {
      card = patchQueueCard(card, init)
      if ((card.payload as CardPayload).queue?.paused) pauseWrites += 1
      return Response.json({ data: card })
    }
    if (url.pathname === "/api/listing/submit") {
      checkSubmit(init!)
      submitCalls += 1
      submitStarted = true
      await submitGate
      return Response.json({ data: { items: [{ row_id: ready.id, created: true, blockers: [], intent: submitIntent("intent-late"), row: listingApiRow("submitting", 2) }] } })
    }
    return originalFetch(input, init)
  }
  try {
    await mounted(<QueueBoundary><MountedQueue onHook={() => {}} /></QueueBoundary>, async () => {
      await click(ariaButton('全部发送（1）到 Browser Test Store', fixture))
      const dialog = sendDialog()
      await click(button("确认发送", dialog))
      await waitUntil(() => submitStarted, "Mounted send did not reach the deferred submit")
      check(peekQueueRunning(), "Queue must stay locked while submit is pending")
      await click(ariaButton("暂停发送队列", fixture))
      await waitUntil(() => useListingWorkbenchStore.getState().queuePaused, "Pause callback did not update the workbench")
      await waitUntil(() => pauseWrites === 1, "Pause must persist exactly one paused Card state")
      const terminal = { ...product, lifecycle: { ...product.lifecycle, stage: "accepted" as const, view_revision: 3 } }
      receiveListingProducts([{ product: terminal, readiness: ready.readiness as never }], new Set(), listingWorkbenchScope())
      releaseSubmit()
      await waitUntil(() => useListingWorkbenchStore.getState().productBases[ready.draftId]?.lifecycle.stage === "accepted", "Late submit receipt overwrote the SSE terminal state")
      await waitUntil(() => !peekQueueRunning(), "Settled late receipt must release the local in-flight lock")
      check(submitCalls === 1 && useListingWorkbenchStore.getState().queuePaused, "Pause must preserve its fence without a second submit")
    })
  } finally {
    releaseSubmit?.()
    window.fetch = originalFetch
    invalidateAccountOverview()
    resetCardSessions()
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
    lifecycle: { ...product.lifecycle, stage: code ? "publish_rejected" : "accepted", fields: "valid", last_error_code: code,
      submission_issue: code ? {
        code: "OZON_ROW_REJECTED", phase: "submit", allowed_actions: ["edit_row"], input_revision: 1,
        dispatch_evidence: "rejected", row_id: id, store_id: "store", intent_id: `old-${id}`,
        trace_id: "fixture-trace", created_at_ms: 1, credential_revision: 1, endpoint: "import",
        request_hash: "fixture-hash", safe_message: "", remediation: "删除品牌词", summary: "搜索标签含品牌词",
        scope: "row", retry_after_fallback: false,
      } : undefined },
  }))
  const rows = definitions.map(({ id, code }): ListingRow => ({
    ...ready, id, draftId: id, imageName: `${id}.jpg`, stage: code ? "publish_rejected" : "accepted", status: code ? "exception" : "sent",
    log: code ?? "已上架",
    readiness: { ready_to_publish: false, can_start_publish_attempt: !!code,
      blockers: code ? ["publish_conflict"] : [], allowed_actions: code ? ["edit_fields", "publish"] : [] },
  }))
  return { rows, productDrafts: Object.fromEntries(products.map((item) => [item.draft_id, item])) }
}

async function mountedBrandRepairKeepsPreparation() {
  let card = await seedQueue()
  const initial = repairFixture()
  const originalFetch = window.fetch
  const writes: Array<{ method: string; url: string; body: any }> = []
  const requests: string[] = []
  const repairOperations: Promise<void>[] = []
  const nativeCalls: string[] = []
  let releaseRepair!: () => void
  const gate = new Promise<void>((resolve) => { releaseRepair = resolve })
  let raw: ListingRowView = { ...listingApiRow("ready_to_publish"), id: "brand",
    draft: initial.productDrafts.brand!.draft, source: { fileName: "brand.jpg" },
    payload: { ...structuredClone(golden.row), draft: initial.productDrafts.brand!.draft },
    submission_state: "rejected", projection: listingProjection({ stage: "publish_rejected", error_code: "BR_hashtag_brand",
      submission_issue: initial.productDrafts.brand!.lifecycle.submission_issue,
      current_issue_status: "present", image_total: 1, image_completed: 1, readiness: initial.rows[1]!.readiness as never }) }
  initial.productDrafts.brand = { ...initial.productDrafts.brand!, ...rowStatusView(raw) }
  patchListingWorkbench(initial)
  rememberListingRows([raw], rowCacheScope())
  const core = new ListingCoreClient(wasmBytes)
  const nativeEdit = core.editRow.bind(core), nativeValidate = core.revalidate.bind(core)
  let edited: EditRowOutput | undefined
  core.editRow = async (...args) => { nativeCalls.push("edit"); return edited = await nativeEdit(...args) }
  core.revalidate = async (...args) => { nativeCalls.push("validate"); return nativeValidate(...args) }
  const capabilities = createWorkflowPublishCapabilities(() => ({ workspaceId: 1, cardId: "card", generation: 1,
    controlVersion: 0, active: true, blocked: false }), createWorkflowPublishNative(() => core))
  check(capabilities.brandRepair.current(initial.rows[1]!, 1), "Production repair capability must recognize the exact brand issue")
  check(!capabilities.brandRepair.current(initial.rows[0]!, 1), "An unavailable resident row must not gain a repair capability")
  let readbacks = 0
  const diagnostic = () => JSON.stringify({
    requests,
    writes: writes.map(({ method, url, body }) => ({ method, url, baseRevision: body.baseRevision, row_ids: body.row_ids })),
    nativeCalls, readbacks, repairInvocations: repairOperations.length,
    stage: useListingWorkbenchStore.getState().productDrafts.brand?.lifecycle.stage,
  })
  window.fetch = async (input, init) => {
    const url = new URL(String(input), location.href)
    const method = init?.method ?? "GET"
    requests.push(`${method} ${url.pathname}${url.search}`)
    if (url.pathname === "/api/listing/rows/brand" && method === "PATCH") {
      const body = JSON.parse(String(init!.body))
      writes.push({ method, url: url.pathname, body })
      check(body.baseRevision === 1 && !body.draft.values.attribute_23171 && body.draft.cleared.includes("attribute_23171"), "Native repair must CAS-save the exact cleared search-tag address")
      check(edited && JSON.stringify(body.draft) === JSON.stringify(edited.row.draft), "Repair save must contain the native edit result")
      await gate
      raw = { ...raw, revision: 2, view_revision: 2, draft: body.draft, payload: edited!.row,
        submission_state: "none", projection: listingProjection({ image_total: 1, image_completed: 1 }) }
      return Response.json({ data: raw })
    }
    if (url.pathname === "/api/listing/rows/brand" && method === "GET") { readbacks += 1; return Response.json({ data: raw }) }
    if (url.pathname === "/api/listing/cards/card" && method === "PATCH") {
      writes.push({ method, url: url.pathname, body: JSON.parse(String(init!.body)) })
      card = patchQueueCard(card, init!)
      return Response.json({ data: card })
    }
    if (url.pathname === "/api/listing/rows" && method === "GET") return Response.json({ data: { items: [raw], nextCursor: null } })
    if (url.pathname === "/api/listing/submit") {
      checkSubmit(init!, "brand", 2)
      writes.push({ method, url: url.pathname, body: JSON.parse(String(init!.body)) })
      raw = { ...raw, view_revision: 3, submission_state: "queued", projection: listingProjection({ stage: "submitting",
        image_total: 1, image_completed: 1, readiness: { ready_to_publish: false, can_start_publish_attempt: false, blockers: [], allowed_actions: [] } }) }
      return Response.json({ data: { items: [{ row_id: "brand", created: true, blockers: [], intent: submitIntent("repair-intent", "brand", 2), row: raw }] } })
    }
    return originalFetch(input, init)
  }
  try {
    await mounted(<QueueBoundary><MountedQueue repair={capabilities.brandRepair} onHook={() => {}}
      onRepairStarted={(operation) => repairOperations.push(operation)} /></QueueBoundary>, async () => {
      const action = ariaButton("修复标签并发送 1", fixture)
      await click(action)
      await waitUntil(() => writes.length === 1, "Repair button did not dispatch")
      await settle()
      const pendingAction = ariaButton("修复标签并发送 0", fixture)
      check(pendingAction.getAttribute("aria-busy") === "true", "Native repair must stay busy until its save finishes")
      check(pendingAction.disabled || pendingAction.getAttribute("aria-disabled") === "true", "Repair must disable repeat clicks while pending")
      pendingAction.click()
      releaseRepair()
      check(repairOperations.length > 0, `Repair click did not expose its completion: ${diagnostic()}`)
      // `submitting` is optimistic, before queue CAS and HTTP dispatch. Wait for the real action.
      await Promise.all(repairOperations)
      await settle()
      check(useListingWorkbenchStore.getState().productDrafts.brand?.lifecycle.stage === "submitting",
        `Repair receipt did not update the row: ${diagnostic()}`)
      const after = useListingWorkbenchStore.getState().productDrafts
      check(JSON.stringify(writes.map(({ method, url }) => `${method} ${url}`)) === JSON.stringify([
        "PATCH /api/listing/rows/brand", "PATCH /api/listing/cards/card", "POST /api/listing/submit",
      ]), `Repair must use one native row save, one queue CAS and one ordinary submit; no preparation or second send: ${diagnostic()}`)
      check(readbacks === 1 && JSON.stringify(nativeCalls) === JSON.stringify(["edit", "validate", "validate"]), `Repair must natively edit, validate, read back once and validate the saved revision: ${diagnostic()}`)
      check(!after.brand?.draft.values.attribute_23171, "Old tags remained in editor after repair")
      check(after.brand?.draft.cleared?.includes("attribute_23171"), "Saved clearing must survive the submit projection")
      check(JSON.stringify(after.brand?.lifecycle.images) === JSON.stringify(initial.productDrafts.brand!.lifecycle.images), "Repair discarded or changed the exact resident uploaded media")
      check(after.unavailable === initial.productDrafts.unavailable && after.duplicate === initial.productDrafts.duplicate && after.published === initial.productDrafts.published, "Repair changed unrelated or failed rows")
    })
  } finally {
    releaseRepair?.()
    capabilities.dispose()
    window.fetch = originalFetch
    invalidateAccountOverview()
    resetCardSessions()
    resetListingWorkbench()
  }
}

async function mountedSingleRowCancelRescansIntent() {
  let card = await seedQueue()
  const originalFetch = window.fetch
  let releaseSubmit!: () => void
  const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve })
  let submitStarted = false
  let intentReads = 0
  let cancelCalls = 0
  let submitCalls = 0
  window.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin)
    if (url.pathname === "/api/listing/rows" && (!init?.method || init.method === "GET")) return Response.json({ data: { items: [listingApiRow("ready_to_publish")], nextCursor: null } })
    if (url.pathname === "/api/listing/cards/card" && init?.method === "PATCH") {
      card = patchQueueCard(card, init)
      return Response.json({ data: card })
    }
    if (url.pathname === "/api/listing/submit") {
      checkSubmit(init!)
      submitCalls += 1
      submitStarted = true
      await submitGate
      return Response.json({ data: { items: [{ row_id: ready.id, created: true, blockers: [], intent: submitIntent("intent-cancel") }] } })
    }
    if (url.pathname === "/api/listing/intents") {
      intentReads += 1
      check(url.searchParams.get("rowId") === ready.id && url.searchParams.get("stableOrder") === "true", "Cancellation must scan the original row's stable Intent list")
      return intentReads === 1
        ? Response.json({ data: { items: [], next_cursor: null } })
        : Response.json({ data: { items: [submitIntent("intent-cancel")], next_cursor: null } })
    }
    if (url.pathname === "/api/listing/intents/intent-cancel/cancel" && init?.method === "POST") {
      cancelCalls += 1
      return Response.json({ data: submitIntent("intent-cancel", ready.id, 1, "cancelled") })
    }
    return originalFetch(input, init)
  }
  try {
    await mounted(<QueueBoundary><MountedQueue onHook={() => {}} /></QueueBoundary>, async () => {
      await click(ariaButton('全部发送（1）到 Browser Test Store', fixture))
      const dialog = sendDialog()
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
      check(submitCalls === 1, "Cancelling must never create a second submit")
    })
  } finally {
    releaseSubmit?.()
    window.fetch = originalFetch
    invalidateAccountOverview()
    resetCardSessions()
    resetListingWorkbench()
  }
}

run.onclick = async () => {
  run.disabled = true
  results.textContent = "运行中"
  results.dataset.result = "running"
  unexpectedRequests.length = 0
  const lines: string[] = []
  try {
    wasmBytes ??= await (await window.fetch(wasmAddress)).arrayBuffer()
    await defaultSendCore(wasmBytes).loadSchema({ snapshot: nativeSchema })
  } catch (error) {
    results.textContent = `FAIL Local production WASM initialization: ${String(error)}`
    results.dataset.result = "failed"
    run.disabled = false
    return
  }
  for (const [name, action] of [["Bind form actions and validation focus", bindForm], ["Send confirmation portal", sendConfirmation], ["Prose editor initial focus, guard wrapping and Escape return", proseEditorFocusAndEscape], ["Stage scope, hidden selection, keyboard reset and global queue controls", stageScopeAndKeyboard], ["Saved row readback moves stages without a false empty-plan claim", savedRowMovesBetweenStageViews], ["Mounted progress subscription", progressSubscription], ["Failure, unknown and save retry feedback", failureUnknownAndSaveFeedback], ["Mounted send pause and late SSE terminal", mountedSendPauseKeepsLateSseTerminal], ["Mounted single-row cancel rescan", mountedSingleRowCancelRescansIntent], ["Brand repair reuses preparation and isolates rows", mountedBrandRepairKeepsPreparation]] as const) {
    try { await action(); lines.push(`PASS ${name}`) }
    catch (error) { lines.push(`FAIL ${name}: ${String(error)}`) }
    results.textContent = lines.join("\n")
  }
  if (unexpectedRequests.length) lines.push(`FAIL Unexpected network: ${unexpectedRequests.join(", ")}`)
  results.textContent = lines.join("\n")
  results.dataset.result = lines.some((line) => line.startsWith("FAIL")) ? "failed" : "passed"
  run.disabled = false
}

const preview = new URL(location.href).searchParams
if (preview.has("repair-preview") || preview.has("editor-preview")) {
  run.hidden = true
  results.textContent = preview.has("editor-preview")
    ? "编辑焦点预览：点「商品名称 product.jpg」，检查初始聚焦、原生 Tab / Shift+Tab 环绕与 Escape 后返回原按钮；不会持久化。"
    : "修复只在实际生产 capability 接通后可用；#run 会验证真实原生修复、CAS、回读与常规发送协议。"
  const root = createRoot(fixture)
  root.render(<FieldWorkbench {...workbench} {...(preview.has("repair-preview") ? repairFixture() : {})} />)
  import.meta.hot?.dispose(() => root.unmount())
}
