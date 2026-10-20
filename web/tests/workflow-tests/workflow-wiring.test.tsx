/**
 * How the workflow screen, runner and workbench are wired: schema refresh,
 * one-click preparation, restore order, the ribbon and the table layout.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { prerender } from "react-dom/static"
import { WorkflowScreen } from "../../src/features/workflow/workflow-screen"
import { schema } from "./workflow-fixtures"

test("category fields refresh before send without blocking recognition or slicing", () => {
  const source = readFileSync(
    new URL("../../src/features/workflow/workflow-screen.tsx", import.meta.url),
    "utf8",
  )
  const library = readFileSync(
    new URL("../../src/features/workflow/card-library-host.tsx", import.meta.url),
    "utf8",
  )
  const edits = readFileSync(
    new URL("../../src/features/workflow/workflow-screen-edits.ts", import.meta.url),
    "utf8",
  )
  const preparation = readFileSync(
    new URL("../../src/features/workflow/prepare/use-preparation.ts", import.meta.url),
    "utf8",
  )
  const publish = readFileSync(
    new URL("../../src/features/workflow/submit/use-publish-queue.ts", import.meta.url),
    "utf8",
  )
  const policy = readFileSync(new URL("../../src/features/workflow/submit/publish-policy.ts", import.meta.url), "utf8")
  const actions = readFileSync(new URL("../../src/features/workflow/workflow-actions.ts", import.meta.url), "utf8")
  const sendRows = readFileSync(new URL("../../src/features/workflow/submit/send-rows.ts", import.meta.url), "utf8")
  const native = readFileSync(new URL("../../src/features/workflow/submit/send-native.ts", import.meta.url), "utf8")
  const dialog = readFileSync(
    new URL("../../src/features/workflow/default-fields-dialog.tsx", import.meta.url),
    "utf8",
  )
  const selectCompose = library.indexOf("function selectComposeStore")
  const selectComposeEnd = library.indexOf("async function applyComposePsd", selectCompose)
  // The saved Card now fixes its category; its editable binding is the Store.
  const editStores = library.indexOf("async function bindCardStores")
  const editStoresEnd = library.indexOf("async function bindCardPsd", editStores)
  const saveCompose = library.indexOf("async function saveCompose")
  const saveComposeEnd = library.indexOf("async function uploadComposeVideos", saveCompose)
  const refresh = edits.indexOf("async function refreshCategorySchema")
  const refreshEnd = edits.indexOf("async function previewSkuImport", refresh)
  const prepare = preparation.indexOf("async function runGuidedPreparation")
  const send = publish.indexOf("async function startPublish")
  assert.ok(selectCompose >= 0 && selectComposeEnd > selectCompose)
  assert.ok(editStores >= 0 && editStoresEnd > editStores)
  assert.ok(saveCompose >= 0 && saveComposeEnd > saveCompose)
  const composeBody = library.slice(selectCompose, selectComposeEnd)
  const editBody = library.slice(editStores, editStoresEnd)

  assert.doesNotMatch(composeBody, /listingCardLoadCategorySchema/)
  assert.doesNotMatch(editBody, /listingCardLoadCategorySchema/)
  assert.match(editBody, /listingCardSaveStore/)
  assert.match(library, /onBindStores=\{\(form, storeIds\) => bindCardStores\(form, storeIds\)\}/)
  assert.match(library.slice(saveCompose, saveComposeEnd), /listingCardLoadCategorySchema/)
  assert.match(source, /import \{ CardLibraryHost \} from "\.\/card-library-host"/)
  assert.match(source, /<CardLibraryHost/)
  assert.match(source, /import \{ useWorkflowScreenEdits \} from "\.\/workflow-screen-edits"/)
  assert.match(source, /const \{ updateValue, refreshCategorySchema, previewSkuImport, applySkuImport, clearGeneratedRows \} = useWorkflowScreenEdits\(\{\s*state,/)
  assert.match(edits, /export function useWorkflowScreenEdits/)
  assert.match(edits, /return \{ updateValue, refreshCategorySchema, previewSkuImport, applySkuImport, clearGeneratedRows \}/)
  assert.match(source, /onFetchCategorySchema=\{refreshCategorySchema\}/)
  assert.ok(refresh >= 0 && refreshEnd > refresh)
  assert.match(edits.slice(refresh, refreshEnd), /listingCardLoadCategorySchema/)
  assert.doesNotMatch(edits.slice(refresh, refreshEnd), /setDraft/)
  // Scoped to the function, not to a byte window: where the call lands is
  // decided by the two constraints asserted below, not by how many characters
  // precede it. A missed anchor would make `slice` run to end-of-file and
  // silently widen every assertion here, so it is an error, not a fallback.
  const prepareEnd = preparation.indexOf("function stopPreparation", prepare)
  assert.ok(prepare >= 0 && prepareEnd > prepare, "runGuidedPreparation's anchors moved")
  const guided = preparation.slice(prepare, prepareEnd)
  assert.doesNotMatch(guided, /refreshCategorySchema|listingCardLoadCategorySchema|loadMaterial/)

  // The two constraints themselves, so the comment in the source and the test
  // guard the same thing: the claim is taken before the first await, and it is
  // taken inside the `try` whose `finally` releases it.
  const opensTry = guided.indexOf("try {")
  const claims = guided.indexOf("guidedPreparationLock.current = true")
  const firstAwait = guided.search(/\bawait\s+\w+\(/)
  assert.ok(
    opensTry >= 0 && claims >= 0 && firstAwait >= 0,
    "one-click preparation must claim before its first Cloud read",
  )
  assert.ok(
    opensTry < claims,
    "the claim must be inside the try, or a throw leaves 一键准备 locked forever",
  )
  assert.ok(
    claims < firstAwait,
    "the claim must precede the first await, or a second click races into the run",
  )
  assert.match(guided, /finally \{[\s\S]*guidedPreparationLock\.current = false/)
  assert.match(source, /import \{ usePublishQueue \} from "\.\/submit\/use-publish-queue"/)
  assert.match(source, /\} = usePublishQueue\(\{/)
  const sendEnd = publish.indexOf("async function pausePublish", send)
  assert.ok(send >= 0 && sendEnd > send)
  const sending = publish.slice(send, sendEnd)
  // Send now delegates schema material and native validation to the actual
  // send core; refreshing the screen's display schema is not that authority.
  const preflight = sending.indexOf("publishPreflight(clicked, selection, peekAccountOverview())")
  const flush = sending.indexOf("await flushAutosave()")
  const dispatch = sending.indexOf("flight.send = workflowActions.workflowSend(")
  assert.ok(preflight >= 0 && flush > preflight && dispatch > flush)
  assert.match(sending, /if \(refusePublish\(preflight\)\) return/)
  assert.match(sending, /if \(!flushed\) \{/)
  assert.match(sending, /if \(!listingScopeCurrent\(scope\) \|\| flight\.stopped\) return/)
  assert.match(sending, /flushAutosave\(\)/)
  const policyStart = policy.indexOf("export function publishPreflight")
  const policyEnd = policy.indexOf("return { ok: true, draftIds, rows }", policyStart)
  assert.ok(policyStart >= 0 && policyEnd > policyStart)
  const preflightBody = policy.slice(policyStart, policyEnd)
  assert.match(preflightBody, /if \(!account\) return \{ ok: false/)
  assert.match(preflightBody, /if \(composeBlockedBySignedOut\(account\)\) return \{ ok: false/)
  assert.match(actions, /workflowSend: \(request: WorkflowRowsActionRequest, shouldStop\?: \(rowId: string\) => boolean,\s*diagnostics\?: import\("\.\/model\/publish-diagnostic"\)\.PublishDiagnosticDispatch\) => sendRows\(request, shouldStop, \{ diagnostics \}\)/)
  assert.match(sendRows, /import \{ defaultSendCore, refusedBeforeDispatch, resolveNativeRow, sendNativeChunk, type SendCore \} from "\.\/send-native"/)
  assert.match(sendRows, /await sendNativeChunk\(\{ core, storeId, rowIds: chunk, pins, shouldStop, nowMs: nowMs\(\), diagnostics: deps\.diagnostics \}\)/)
  const chunkStart = native.indexOf("export async function sendNativeChunk")
  const chunkEnd = native.indexOf("return rowIds.flatMap((rowId) => results.get(rowId) ?? [])", chunkStart)
  assert.ok(chunkStart >= 0 && chunkEnd > chunkStart)
  assert.match(native.slice(chunkStart, chunkEnd), /await publishGroups\(core, \[\.\.\.groups\.values\(\)\], context, false, nowMs\)/)
  const groupsStart = native.indexOf("async function publishGroups")
  const groupsEnd = native.indexOf("export type NativeChunk", groupsStart)
  assert.ok(groupsStart >= 0 && groupsEnd > groupsStart)
  const groups = native.slice(groupsStart, groupsEnd)
  const material = groups.indexOf("await loadMaterial(group.coordinate, { force })")
  const handle = groups.indexOf("await nativeHandle(core, material)")
  const build = groups.indexOf("await adapter.build(")
  const submit = groups.indexOf("await submitOzonChunk(context, frozen)")
  assert.ok(material >= 0 && handle > material && build > handle && submit > build)
  assert.match(groups, /for \(const item of built\.blocked\) out\.set\(item\.key, await issuesResult\(item\.key, item\.issues\)\)/)
  assert.match(groups, /frozen\.push\(\.\.\.built\.frozen\)/)
  assert.match(dialog, /onFetchSchemaRef/)
  assert.doesNotMatch(dialog, /获取类目字段|schemaReady/)
  assert.match(dialog, /CategoryFieldsForm/)
})

test("workflow screen renders the unified batch workbench without a redundant stepper", async () => {
  // CardRunner loads with the execution screen. prerender waits for that chunk;
  // renderToStaticMarkup would only see the skeleton.
  const { prelude } = await prerender(<WorkflowScreen initialSchema={schema} />)
  const html = await new Response(prelude).text()
  assert.match(html, /默认字段/)
  assert.doesNotMatch(html, /aria-label="PSD 与提示词"|AI 商品文案提示词/)
  assert.doesNotMatch(html, /共 0 行 · 识别 0\/0 · 媒体 0\/0 · 已上架 0\/0 · 异常 0/)
  assert.match(html, /拖入图片，每张建一行/)
  assert.doesNotMatch(html, /审核与发送/)
  assert.doesNotMatch(html, /完整类目字段/)
  assert.doesNotMatch(html, /查找字段/)
  assert.doesNotMatch(html, /建卡时锁定|更换类目/)
  assert.doesNotMatch(html, /Description category|Product type/)
  assert.doesNotMatch(html, /输入至少 2 个字符/)
  assert.doesNotMatch(html, /aria-label="搜索 品牌"/)
  assert.doesNotMatch(html, /蓝色|现代/)
  assert.doesNotMatch(html, /PSD 模板与 AI 提示词/)
  assert.doesNotMatch(html, /aria-controls="listing-runner-form-panel"/)
  assert.doesNotMatch(html, /aria-controls="listing-runner-media-panel"/)
  assert.match(html, /aria-label="商品批量操作"/)
  assert.doesNotMatch(html, /商品视频与封面|上传本地文件|绑定已有公共 HTTPS 链接/)
  assert.doesNotMatch(html, /选择店铺/)
  assert.doesNotMatch(html, /确认发送/)
  assert.doesNotMatch(html, /最终上架/)
  assert.doesNotMatch(html, /新建上架方案/)
  assert.doesNotMatch(html, /提交上架/)
})

test("one-click preparation delegates composition to the fixed Cloud operation", () => {
  const source = readFileSync(
    new URL("../../src/features/workflow/prepare/use-preparation.ts", import.meta.url),
    "utf8",
  )
  const start = source.indexOf("async function runGuidedPreparation")
  const end = source.indexOf("function stopPreparation", start)
  assert.ok(start >= 0 && end > start)
  const guided = source.slice(start, end)

  assert.match(guided, /workflowActions\.workflowPrepare/)
  assert.doesNotMatch(guided, /guidedPreparationLanes\(|runAiRows\(|runRenderRows\(|runDeliverRows\(/)
})

test("workflow rows paint before source assets finish restoring", () => {
  const screen = readFileSync(
    new URL("../../src/features/workflow/workflow-screen.tsx", import.meta.url),
    "utf8",
  )
  const source = readFileSync(new URL("../../src/features/workflow/workflow-screen-stream.ts", import.meta.url), "utf8")
  const library = readFileSync(new URL("../../src/features/workflow/workflow-screen-library.ts", import.meta.url), "utf8")
  assert.match(screen, /import \{ useWorkflowScreenStream \} from "\.\/workflow-screen-stream"/)
  assert.match(screen, /const \{ restoreProductInstances \} = useWorkflowScreenStream\(\{ state, forgetRows, resetRowAutosaves, setCustomStoreQuotas \}\)/)
  assert.match(source, /export function useWorkflowScreenStream/)
  assert.match(source, /return \{ restoreProductInstances \}/)
  assert.match(screen, /useWorkflowScreenLibrary\(\{\s*state,[\s\S]*?projectQueueState, restoreProductInstances, leaveRunner,/)
  assert.match(library, /restoreProductInstances\(card, generation\)/)
  const restoreStart = source.indexOf("function restoreProductInstances")
  const restoreEnd = source.indexOf("return { restoreProductInstances }", restoreStart)
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart)
  const restore = source.slice(restoreStart, restoreEnd)
  const initialPaint = restore.indexOf("receiveListingProducts(instances, removed, scope)")
  const hydration = restore.indexOf("renderOpfs.workflowRestoreProductInstances")

  assert.notEqual(initialPaint, -1, "persisted lifecycle rows should paint immediately")
  assert.notEqual(hydration, -1, "source assets should still hydrate in one browser batch")
  assert.equal(
    restore.indexOf("overlayCurrentCardDefaults"),
    -1,
    "opening a card must not rewrite category fields; send overlay is resolve_send_values",
  )
  assert.doesNotMatch(restore, /workflowMarkFieldsChanged/)
  assert.doesNotMatch(restore, /attachSourcePreviews|workflowSourcePreview/)
  assert.ok(initialPaint < hydration, "the table must paint before the slowest restore finishes")
})

test("workflow refreshes the Store roster when its keep-alive screen is revisited", () => {
  const source = readFileSync(
    new URL("../../src/features/workflow/workflow-screen.tsx", import.meta.url),
    "utf8",
  )
  const appSource = readFileSync(
    new URL("../../src/app/authenticated-app.tsx", import.meta.url),
    "utf8",
  )
  const lifecycle = readFileSync(new URL("../../src/features/workflow/workflow-screen-lifecycle.ts", import.meta.url), "utf8")

  assert.match(source, /useScreenActive\(\)/)
  assert.match(source, /import \{ useWorkflowScreenLifecycle \} from "\.\/workflow-screen-lifecycle"/)
  assert.match(source, /useWorkflowScreenLifecycle\(\{ state, active,/)
  assert.match(source, /refreshSavedForms, reloadOzonStores, openRunner, leaveRunner \}\)/)
  const hook = lifecycle.indexOf("export function useWorkflowScreenLifecycle")
  const activation = lifecycle.indexOf("const becameActive = active && !wasActive.current", hook)
  const activationStart = lifecycle.lastIndexOf("useEffect(() => {", activation)
  const activationEnd = lifecycle.indexOf("}, [active])", activation)
  assert.ok(hook >= 0 && activationStart > hook && activation > activationStart && activationEnd > activation)
  const revisit = lifecycle.slice(activationStart, activationEnd + "}, [active])".length)
  assert.match(revisit, /const becameActive = active && !wasActive\.current/)
  assert.match(revisit, /wasActive\.current = active/)
  assert.match(revisit, /if \(!becameActive\) return/)
  assert.match(revisit, /void reloadOzonStores\(\{ soft: true \}\)/)
  assert.match(revisit, /\}, \[active\]\)/)
  assert.ok(revisit.indexOf("if (!becameActive) return") < revisit.indexOf("void reloadOzonStores("))
  // Nothing may make a still-hidden pane pay for a navigation: the shell owns
  // the address, and no activation counter crosses the screen boundary.
  assert.doesNotMatch(source, /activationEpoch/)
  assert.doesNotMatch(lifecycle, /activationEpoch/)
  assert.doesNotMatch(appSource, /screenEpoch/)
  assert.doesNotMatch(
    readFileSync(new URL("../../src/app/screen-catalog.tsx", import.meta.url), "utf8"),
    /activationEpoch/,
  )
  assert.match(appSource, /NotificationsProvider/)
  assert.doesNotMatch(appSource, /useNotifications\(/)
  assert.doesNotMatch(appSource, /headerActivity/)
  assert.match(source, /resetListingWorkbench/)
  assert.doesNotMatch(source, /useSetWorkflowProgress\(\)/)
})

test("runner isolates one full category form with inline SKU import from row rerenders", () => {
  const runner = readFileSync(
    new URL("../../src/features/workflow/card-runner.tsx", import.meta.url),
    "utf8",
  )
  const dialog = readFileSync(
    new URL("../../src/features/workflow/default-fields-dialog.tsx", import.meta.url),
    "utf8",
  )
  const fields = readFileSync(
    new URL("../../src/features/workflow/category-fields-form.tsx", import.meta.url),
    "utf8",
  )

  assert.match(runner, /<FieldWorkbench/)
  assert.doesNotMatch(runner, /RunnerSectionNav/)
  assert.doesNotMatch(runner, /mountedTabs/)
  assert.match(dialog, /DefaultFieldsDialog/)
  assert.match(dialog, /当前方案默认字段/)
  assert.match(dialog, /<SkuImportPanel/)
  assert.match(dialog, /<CategoryFieldsForm/)
  assert.doesNotMatch(dialog, /获取类目字段|schemaReady/)
  assert.doesNotMatch(dialog, /DEFAULT_FIELDS_DIALOG_TABS|role="tab"|activeTab|常用默认字段/)
  assert.match(fields, /memo\(function CategoryFieldsForm/)
})

test("thumbnail hover escapes sticky table stacking contexts and defers image decoding", () => {
  const source = readFileSync(
    new URL("../../src/features/workflow/media/thumb-preview.tsx", import.meta.url),
    "utf8",
  )
  assert.doesNotMatch(source, /onMouseMove=/)
  assert.match(source, /createPortal/)
  assert.match(source, /document\.body/)
  assert.match(source, /loading="lazy"/)
  assert.match(source, /decoding="async"/)
})

test("batch actions use a compact command ribbon without repeating the page tally", () => {
  // Each fact is read from the module that owns it: the ribbon markup, the
  // ribbon's track geometry, and the prepare step controls it composes.
  const source = readFileSync(
    new URL("../../src/features/workflow/workbench/workbench-ribbon.tsx", import.meta.url),
    "utf8",
  )
  const classes = readFileSync(
    new URL("../../src/features/workflow/workbench/workbench-ribbon-classes.ts", import.meta.url),
    "utf8",
  )
  const prepare = readFileSync(
    new URL("../../src/features/workflow/workbench/workbench-prepare-controls.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /data-slot="workbench-action-ribbon"/)
  assert.match(source, /role="group"\s+aria-label="选择商品"/)
  assert.match(source, /role="group"\s+aria-label="图片与字段"/)
  assert.match(source, /role="group"\s+aria-label="准备商品"/)
  assert.match(source, /role="group"\s+aria-label="发布商品"/)
  assert.match(source, /overflow-x-auto/)
  assert.match(source, /no-scrollbar/)
  assert.match(classes, /const RIBBON_BUTTON = "[^"]*w-full[^"]*text-xs/)
  assert.match(classes, /const RIBBON_PREPARE_GROUP =\s+"[^"]*grid-cols-\[64px_repeat\(3,32px\)_84px\]/)
  assert.match(classes, /const RIBBON_MEDIA_GROUP =\s+"[^"]*w-\[174px\]/)
  assert.match(classes, /const RIBBON_MEDIA_GROUP_WITH_STORES =\s+"[^"]*w-\[280px\]/)
  assert.match(classes, /const RIBBON_SELECT_GROUP_PICKED =\s+"[^"]*w-\[212px\]/)
  assert.doesNotMatch(classes, /RIBBON_SELECTION_GROUP/)
  assert.doesNotMatch(source, /RIBBON_SELECTION_GROUP|data-toolbar-slot="selection-actions"/)
  assert.doesNotMatch(classes, /const RIBBON_BUTTON = "[^"]*(?:h-16|flex-col)/)
  assert.doesNotMatch(source, /共 \{rows\.length\} 行 · 识别/)
  assert.match(source, /size="sm"/)
  assert.match(prepare, /function PreparationStepSequence/)
  assert.doesNotMatch(prepare, /function PreparationLaneButtons|function AdvancedPreparationMenu/)
})

test("the selection menu keeps its Base UI label inside a menu group", () => {
  const source = readFileSync(
    new URL("../../src/features/workflow/workbench/workbench-ribbon.tsx", import.meta.url),
    "utf8",
  )
  const menuStart = source.indexOf('<DropdownMenuContent align="start"')
  const menuEnd = source.indexOf("</DropdownMenuContent>", menuStart)

  assert.notEqual(menuStart, -1)
  assert.notEqual(menuEnd, -1)
  assert.ok(menuEnd > menuStart)
  const selectionMenu = source.slice(menuStart, menuEnd)
  assert.match(
    selectionMenu,
    /<DropdownMenuGroup>[\s\S]*<DropdownMenuLabel>按下一步选择<\/DropdownMenuLabel>[\s\S]*<\/DropdownMenuGroup>/,
  )
})

test("the shadcn workbench table owns vertical scrolling inside a finite runner", () => {
  const runner = readFileSync(
    new URL("../../src/features/workflow/card-runner.tsx", import.meta.url),
    "utf8",
  )
  // The table and its sticky header live in the workbench grid.
  const workbench = readFileSync(
    new URL("../../src/features/workflow/workbench/workbench-grid.tsx", import.meta.url),
    "utf8",
  )

  assert.match(
    runner,
    /className="wf-pipe flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"/,
  )
  assert.match(workbench, /<Table\b/)
  assert.doesNotMatch(workbench, /<table\b/)
  assert.match(workbench, /containerClassName="[^"]*flex-1[^"]*min-h-0[^"]*overflow-auto/)
  assert.match(workbench, /<TableHeader className="sticky top-0/)
})

test("a paused queue never makes its own recovery controls inert", () => {
  const source = readFileSync(
    new URL("../../src/features/workflow/card-runner.tsx", import.meta.url),
    "utf8",
  )
  assert.doesNotMatch(source, /inert=\{tab !== "media" \|\| queueLocked\}/)
})

test("source images can be added before category defaults are complete", () => {
  // The import button is rendered by the ribbon.
  const source = readFileSync(
    new URL("../../src/features/workflow/workbench/workbench-ribbon.tsx", import.meta.url),
    "utf8",
  )
  // Importing is what produces the rows every other column reads, so it can
  // never wait on the card form being complete — only on the locks that mean
  // Cloud is already writing this card or one of its Product Instances.
  assert.doesNotMatch(source, /formReady/)
  assert.match(
    source,
    /disabled=\{busy \|\| queueLocked \|\| preparing\}\s+onClick=\{onImportImages\}\s+aria-label="导入图片"/,
  )
})
