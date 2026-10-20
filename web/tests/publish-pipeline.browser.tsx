/** Isolated S16 plus production workbench controls. Business IO stays in this page's mocks. */
import { Profiler, StrictMode, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/toast"
import { ListingCoreClient } from "@/listing-core/client"
import type { CardPayload, CategorySchemaSnapshot, LeanRow } from "@/listing-core/types"
import { createSchemaCache } from "@/features/workflow/schema-cache"
import { sha256 } from "@/features/workflow/platforms/core"
import { createListingSendCapabilities } from "@/features/workflow/platforms"
import { createOzonRepair } from "@/features/workflow/platforms/ozon-repair"
import { PublishPipelineWb } from "./publish-pipeline-wb"
import { installPipelineMocks, type FixtureMode } from "./publish-pipeline-mocks"
import { beginAction, endAction, markReady, recordCommit, recordNative, recordQueue, recordState, evidenceSnapshot, settlePaint, type ActionName } from "./publish-pipeline-metrics"
import { PipelineEvidencePanel } from "./publish-pipeline-evidence"
import { PipelineDiagnosticRoute, PipelineRowDiagnostic } from "./publish-pipeline-diagnostics"
import { PublishPipelineWorkbench } from "./publish-pipeline-workbench"
import { PublishPipelineKeepalive } from "./publish-pipeline-keepalive"
import { seedFixtureIdentity } from "./publish-pipeline-workbench-fixtures"
import { ozonAdmissionFailure, type OzonSubmissionError } from "@/features/workflow/submit/ozon-admission-refusal"
import { capturePublishRequestEvidence } from "@/features/workflow/model/publish-request-evidence"
import type { ReconcileResult, ReconcileSelection } from "@/features/workflow/submit/queue/types"
import { openCardRows, type CardRows } from "@/features/workflow/rows/card-rows"
import { idbRowRepo } from "@/features/workflow/rows/row-repo"
import { createSendQueue } from "@/features/workflow/submit/send-queue"
import { waitForAdmission } from "@/features/workflow/submit/queue/budgets"
import { notifyError } from "@/lib/notify"
import goldenJson from "./fixtures/listing-core/ozon-publish-input.json"
import schemaJson from "./fixtures/listing-core/decorative-wall-art-schema.json"

const golden = goldenJson as unknown as { row: LeanRow; card: CardPayload }
const initialSchema = schemaJson as unknown as CategorySchemaSnapshot
const mocks = installPipelineMocks(initialSchema)
seedFixtureIdentity()
const core = new ListingCoreClient(new URL("../../wasm/dist/browser/listing-state.wasm", import.meta.url).href)
const scope = { workspaceUuid: "fixture-workspace", cardId: "fixture-card" }
const stateLabel = { idle: "尚未发送", running: "发送中", stopping: "等待在途块完成", paused: "已暂停", complete: "本次处理完成" }
const rowLabel = { queued: "云端待决", submitting: "提交中", unconfirmed: "未确认，需核对", accepted: "已受理", rejected: "未发送，需处理", unknown: "未确认", cancelled: "已取消" }

type Harness = { dispose(): void; capture(): void; reload(): Promise<void>; refreshQueue(): void; editFirst(): Promise<void>; rows: CardRows; queue: ReturnType<typeof createSendQueue>; capability: ReturnType<typeof createListingSendCapabilities>["ozon"] }
function Fixture() {
  const harness = useRef<Harness | null>(null)
  const requestFailure = useRef<{ error: OzonSubmissionError; revisions: ReadonlyMap<string, number> } | null>(null)
  const reconciliation = useRef<ReconcileResult | undefined>(undefined)
  const [queryBatch, setQueryBatch] = useState("")
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [loaded, setLoaded] = useState(false)
  const [built, setBuilt] = useState(0)
  const [closed, setClosed] = useState(false)
  const [sample, setSample] = useState(false)
  const [scenario, setScenario] = useState<FixtureMode>("accepted")
  const [keepalive, setKeepalive] = useState(false)
  useEffect(() => {
    let live = true, writerLive = true
    let unsubscribe = () => {}
    let owner: Harness | undefined, ownedRows: CardRows | undefined
    let closing: Promise<void> | undefined
    const schemas = createSchemaCache(core)
    // Each setup closes only its resources. Wait for an unfinished schema/open
    // before dropping handles, and retain row writes until dispatched receipts settle.
    function closeResources(): Promise<void> {
      return closing ??= (async () => {
        await initialized.catch(() => {})
        try { await owner?.queue.settled(); owner?.capture() }
        finally {
          unsubscribe()
          try { await ownedRows?.close() }
          finally { writerLive = false; await schemas.close() }
        }
      })()
    }
    const initialized = (async () => {
      const loadSchema = async (snapshot: CategorySchemaSnapshot) => (await schemas.load({
        platform: "ozon", coordinate: [snapshot.description_category_id, snapshot.type_id], language: "default",
        materialDigest: await sha256(JSON.stringify(snapshot)), defaultsRevision: "fixture-1", sessionFence: "fixture-session",
      }, { snapshot })).handle
      let material = initialSchema
      let handle = await loadSchema(material)
      if (!live) return
      const rows = await openCardRows(idbRowRepo(`listing-fixture-publish-${crypto.randomUUID()}`), scope, undefined, () => writerLive)
      ownedRows = rows
      if (!live) return
      const repair = createOzonRepair({ rows, core, schemas, initialHandle: handle, card: () => golden.card, current: () => live, accountId: "fixture-account",
        async refreshSchema(signal) {
          const response = await fetch("/api/catalog/schemas/fixture", { signal })
          material = (await response.json() as { data: CategorySchemaSnapshot }).data
          return { identity: { platform: "ozon", coordinate: [material.description_category_id, material.type_id], language: "default", materialDigest: await sha256(JSON.stringify(material)), defaultsRevision: "fixture-1", sessionFence: "fixture-session" }, material: { snapshot: material } }
        },
        async reuploadRows(selected, signal) {
          const response = await fetch("/api/media/fixture-reupload", { method: "POST", signal, body: JSON.stringify(selected.map((row) => ({ id: row.id, rev: row.rev, images: (row.row as LeanRow).media.images }))) })
          if (!response.ok) throw new Error("Fixture media owner refused upload")
          return (await response.json() as { data: import("@/features/workflow/platforms/ozon-repair").ConfirmedRowUpload[] }).data
        },
      })
      const capabilities = createListingSendCapabilities({ ...repair, core, card: () => golden.card, cardId: scope.cardId })
      const observed = { ...capabilities.ozon, async send(...args: Parameters<typeof capabilities.ozon.send>) {
        try { return await capabilities.ozon.send(...args) }
        catch (reason) {
          requestFailure.current = { error: ozonAdmissionFailure(reason, args[0], args[1].map((item) => item.rowId)),
            revisions: new Map(args[1].map((item) => [item.rowId, (rows.get(item.rowId)?.rev ?? -1) + 1])) }
          throw reason
        }
      } }
      const queueOptions = { rows, ...scope, current: () => live, capabilities: { ozon: observed },
        async wait(requestedMs: number, signal: AbortSignal) {
          const startedAt = Date.now(), publish = rows.cardState()?.publish
          const reservations = publish ? publish.blocks.filter((block) => block.busyRetryAt !== undefined).map((block) => ({
            blockId: block.id, platform: block.platform, destination: block.destination, dueAt: block.busyRetryAt,
            submits: block.budget.submits, busy: publish.busy[JSON.stringify([block.platform, block.destination])],
          })) : []
          await waitForAdmission(requestedMs, signal) // The production timer and Stop semantics, with the real browser clock.
          recordNative("busy-admission-wait", { actionId: publish?.actionId, requestedMs, startedAt, endedAt: Date.now(), aborted: signal.aborted, reservations })
        },
      }
      let queue = createSendQueue(queueOptions)
      const capture = () => {
        const local = rows.all()
        const value = { snapshot: queue.snapshot(), rowCount: local.length, destinations: [...new Set(local.map((row) => row.storeId))],
          rows: local.map((row) => ({ id: row.id, destination: row.storeId, state: row.submission?.state ?? "ready", rev: row.rev })),
          actionId: rows.cardState()?.publish?.actionId, busy: rows.cardState()?.publish?.busy, reconciliation: reconciliation.current,
          parents: rows.cardState()?.publish?.blocks.map((block) => ({ id: block.id, destination: block.destination, state: block.state, budget: block.budget, remaining: block.remainingRowIds.length, haltReason: block.haltReason })), closed: !live }
        recordState(value)
        // Full current rows remain in state; historical ticks need only scheduler facts.
        const { rows: _rows, ...tick } = value
        recordQueue(tick)
      }
      const changed = () => { capture(); if (live) setVersion((value) => value + 1) }
      let repaint: number | undefined
      let offQueue = queue.subscribe(changed)
      const offRows = rows.subscribe(() => {
        // Observe every CardRows batch notification with one repaint per frame.
        repaint ??= requestAnimationFrame(() => { repaint = undefined; changed() })
      })
      const off = () => { offQueue(); offRows(); if (repaint !== undefined) cancelAnimationFrame(repaint) }
      owner = { rows, queue, capability: capabilities.ozon, capture,
        refreshQueue() { offQueue(); queue = createSendQueue(queueOptions); owner!.queue = queue; offQueue = queue.subscribe(changed); changed() },
        dispose() { if (!live) return
          live = false; queue.stop(); capture(); setClosed(true); setLoaded(false)
          void closeResources().catch(() => {})
        },
        async reload() { schemas.invalidate(); await core.restart(); handle = await loadSchema(material); repair.replaceResidentHandle(handle) },
        async editFirst() {
          const local = rows.all()[0]
          if (!local || local.submission) return
          const row = local.row as LeanRow
          const draft = structuredClone(row.draft)
          draft.values.price = { kind: "text", value: "120" }
          const edited = await core.editRow(repair.schemaHandle(), { row, card: golden.card, nowMs: Date.now(), edit: { kind: "draft", draft } })
          rows.update(local.id, (value) => ({ ...value, row: edited.row, verdict: edited.fact }), { expectRev: local.rev })
          await rows.flush()
        },
      }
      unsubscribe = off
      harness.current = owner
      capture(); setLoaded(true); await settlePaint()
      if (live && harness.current === owner) markReady()
    })()
    function retire() {
      live = false; unsubscribe(); owner?.queue.stop()
      if (harness.current === owner) harness.current = null
      void closeResources().catch(() => {})
    }
    void initialized.catch(() => {
      if (live) notifyError("夹具初始化失败，请重新打开夹具页后检查本地 WASM 与存储权限")
      retire()
    })
    return retire
  }, [])
  const run = (name: ActionName, action: (h: Harness) => Promise<void>) => {
    if (!harness.current || busyRef.current) return
    const measured = beginAction(name)
    busyRef.current = true; setBusy(true)
    let ok = true
    void action(harness.current).catch(() => { ok = false; notifyError("夹具操作未完成；请核对行状态，再重新打开夹具重试") })
      .finally(async () => { harness.current?.capture(); busyRef.current = false; setBusy(false); setVersion((value) => value + 1); await endAction(measured, ok) })
  }
  const current = harness.current
  const snapshot = current?.queue.snapshot()
  const rows = closed ? [] : current?.rows.all() ?? []
  const groups = new Map<string, { selection: ReconcileSelection & { rowIds: string[] }; label: string }>()
  for (const row of rows) {
    const submission = row.submission
    if (!submission?.platform || !["unconfirmed", "unknown", "queued", "submitting"].includes(submission.state)) continue
    const identity = !!submission.intentId && !!submission.clientOperationId && Number.isSafeInteger(submission.serverRevision) && submission.serverRevision! >= 0 ? "known"
      : submission.intentId === undefined && submission.clientOperationId === undefined && submission.serverRevision === undefined ? "lost" : "partial"
    const key = JSON.stringify([submission.platform, submission.storeId, identity])
    const group = groups.get(key) ?? { selection: { platform: submission.platform, destination: submission.storeId, rowIds: [] }, label: { known: "已有权威身份", lost: "无响应身份，人工核对", partial: "响应身份不完整，保留锁定" }[identity] }
    group.selection.rowIds.push(row.id); groups.set(key, group)
  }
  const batches = [...groups].flatMap(([key, group]) => Array.from({ length: Math.ceil(group.selection.rowIds.length / 100) }, (_, index) => ({
    key: `${key}:${index}`, selection: { ...group.selection, rowIds: group.selection.rowIds.slice(index * 100, (index + 1) * 100) },
    label: `${group.selection.platform} / ${group.selection.destination} / ${group.label} / 第 ${index + 1} 批（${Math.min(100, group.selection.rowIds.length - index * 100)} 行）`,
  })))
  const selectedBatch = batches.find((batch) => batch.key === queryBatch) ?? batches[0]
  void version
  return <PipelineDiagnosticRoute current={!closed} mocks={mocks.diagnostics}><main aria-busy={busy || (!loaded && !closed)} data-ready={loaded} data-closed={closed} data-phase={snapshot?.phase ?? "idle"} className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
    <h1 className="text-xl font-semibold">发布流水线夹具</h1>
    <p className="text-muted-foreground">独立本地数据；导入 → 本地校验与拼接 → 模拟发送 → 结果。WB 仅本地预览，所有业务网络均为夹具模拟。</p>
    <div className="flex flex-wrap gap-2">
      {(["accepted", "unknown", "schema", "media", "stop", "late", "diagnostic", "request-400", "request-409", "admission-store-unavailable", "admission-capacity-full", "admission-offer-busy", "admission-busy-exhausted", "reconcile-pending-200", "reconcile-lost-history"] as const).map((value) => <Button key={value} variant={scenario === value ? "default" : "outline"} disabled={busy || rows.length > 0} onClick={() => { mocks.select(value); setScenario(value) }}>
        {{ accepted: "受理成功", unknown: "第二块断网", schema: "Schema 修复", media: "媒体修复", stop: "在途停止", late: "切方案迟到", diagnostic: "停止后响应丢失", "request-400": "整块请求 400", "request-409": "整块请求 409",
          "admission-store-unavailable": "多块店铺不可用", "admission-capacity-full": "多块容量已满", "admission-offer-busy": "多块货号占用", "admission-busy-exhausted": "持续店铺忙", "reconcile-pending-200": "多批权威待决", "reconcile-lost-history": "提交已落库但响应丢失" }[value]}
      </Button>)}
    </div>
    <label><input type="checkbox" disabled={busy} onChange={(event) => mocks.holdFirst(event.target.checked)} />保持首块响应以取证</label>
    <label><input type="checkbox" checked={sample} disabled={busy || !!rows[0]?.submission} onChange={(event) => setSample(event.target.checked)} />仅发送首块修复样本（100 行）</label>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={!loaded || busy || rows.length > 0} onClick={() => run("import", async (h) => {
        const row = structuredClone(golden.row)
        row.draft.values.offer_id = { kind: "text", value: "FIXTURE-DIAGNOSTIC" }
        h.rows.create([{ v: 1, id: crypto.randomUUID(), ...scope, storeId: "fixture-a", position: 100, row }]); await h.rows.flush()
      })}>导入实际诊断样本</Button>
      <Button disabled={!loaded || busy || rows.length > 0} onClick={() => run("import", async (h) => {
        for (let start = 0; start < 1000; start += 20) {
          const batch: Parameters<CardRows["create"]>[0] = []
          for (let i = start; i < Math.min(start + 20, 1000); i++) {
            const row = structuredClone(golden.row)
            row.draft.values.offer_id = { kind: "text", value: `FIXTURE-${i}` }
            batch.push({ v: 1, id: crypto.randomUUID(), ...scope, storeId: i < 500 ? "fixture-a" : "fixture-b", position: i, row })
          }
          h.rows.create(batch)
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        await h.rows.flush()
      })}>导入 1000 行</Button>
      <Button variant="outline" disabled={busy || rows.length === 0 || !!rows[0]?.submission} onClick={() => run("single-edit", async (h) => { await h.editFirst(); setBuilt(0) })}>编辑首行价格</Button>
      <Button variant="outline" disabled={busy || !loaded} onClick={() => run("reload", (h) => h.reload())}>重载本地内核</Button>
      <Button variant="outline" disabled={busy || !loaded} onClick={() => run("reload", async (h) => { h.refreshQueue(); await h.rows.flush() })}>重新载入本地队列</Button>
      <Button disabled={busy || rows.length === 0} onClick={() => run("validate-compose", async (h) => {
        const before = evidenceSnapshot().business.length
        const result = await h.capability.prepare(h.rows.all(), new AbortController().signal)
        recordNative("validate-compose", { requested: h.rows.all().length, prepared: result.items.length, blocked: result.blocked.length })
        if (evidenceSnapshot().business.length !== before) throw new Error("Local build exceeded zero-call budget")
        setBuilt(result.items.length)
      })}>校验与拼接</Button>
      <Button variant="brand" disabled={busy || built === 0 || snapshot?.phase === "stopping"} onClick={() => run("normal-send", async (h) => {
        await h.queue.start(["fixture-a", "fixture-b"].map((destination) => ({ platform: "ozon", destination, rowIds: h.rows.all().filter((row) => row.storeId === destination && (!sample || row.position < 100)).map((row) => row.id) })))
      })}>发送</Button>
      <Button variant="outline" disabled={snapshot?.phase !== "running"} onClick={() => { const action = beginAction("stop"); current?.queue.stop(); void endAction(action) }}>停止</Button>
      <Button variant="outline" disabled={busy || snapshot?.phase !== "paused"} onClick={() => run("continue", (h) => h.queue.continue())}>继续</Button>
      <Button variant="outline" disabled={busy || !selectedBatch || snapshot?.phase === "running" || snapshot?.phase === "stopping"} onClick={() => run("query", async (h) => {
        const result = await h.queue.reconcile(selectedBatch!.selection)
        reconciliation.current = result
        recordNative("reconcile-result", result)
        if (result.mode === "history") recordNative("missing-identity-query", { rows: result.rowIds.length,
          returned: result.rows.reduce((sum, row) => sum + row.candidates.length, 0), applied: result.appliedRowIds.length > 0 })
      })}>核对结果</Button>
      <Button variant="outline" onClick={() => { const action = beginAction("mock-release"); mocks.release(); void endAction(action) }}>释放模拟响应或修复</Button>
      <Button variant="outline" disabled={!busy || closed} onClick={() => { const action = beginAction("scope-switch"); current?.dispose(); void endAction(action) }}>切换方案并关闭原作用域</Button>
      <Button variant="outline" disabled={busy} onClick={() => { void settlePaint().then(() => { const action = beginAction("idle"); setTimeout(() => void endAction(action), 2000) }) }}>测量空闲 2 秒</Button>
    </div>
    <p role="status" aria-atomic="true">{closed ? "原作用域已关闭" : !loaded ? "正在加载本地内核" : stateLabel[snapshot?.phase ?? "idle"]}；已导入 {rows.length} 行，已拼接 {built} 行，在途 {snapshot?.inFlight ?? 0} 块。</p>
    <p>已受理 {snapshot?.counts.accepted ?? 0} 行，待决 {snapshot?.counts.pending ?? 0} 行，拒绝 {snapshot?.counts.rejected ?? 0} 行，未确认 {snapshot?.counts.unknown ?? 0} 行。</p>
    {!!snapshot?.halts.length && <section aria-label="目的地发送已暂停" className="flex flex-col gap-2">
      {snapshot.halts.map((halt) => <div key={halt.blockId} data-halt-code={halt.reason.code} data-halt-cause={halt.reason.cause}>
        <p>{halt.platform} / {halt.destination}：{{ store_unavailable: "店铺当前不可用；检查原店铺绑定与权限。", submit_capacity_full: "提交容量已满；等待原店铺任务完成。", offer_busy: "货号正在占用；在原店铺核对该货号的在途任务。", store_busy: "店铺忙重试预算已耗尽；核对原店铺任务后再操作。" }[halt.reason.code]}后续块保留待发送，继续或核对不会清除本次拒绝。</p>
        <Button variant="outline" disabled={busy} onClick={() => run("continue", (h) => h.queue.retry(halt.blockId))}>{halt.destination} 显式重试原块</Button>
      </div>)}
    </section>}
    <label>核对批次（每次至多 100 行、一次只读请求）<select aria-label="核对批次" disabled={busy || !batches.length} value={selectedBatch?.key ?? ""} onChange={(event) => setQueryBatch(event.target.value)}>
      {!batches.length && <option value="">没有待核对行</option>}{batches.map((batch) => <option key={batch.key} value={batch.key}>{batch.label}</option>)}
    </select></label>
    {reconciliation.current && <section aria-label="所选批次核对结果" data-query-status={reconciliation.current.status} data-query-mode={reconciliation.current.mode}>
      <p>已核对 {reconciliation.current.rowIds.length} 行；返回 {reconciliation.current.rows.reduce((sum, row) => sum + row.candidates.length, 0)} 条候选记录；权威更新 {reconciliation.current.appliedRowIds.length} 行。{reconciliation.current.mode === "history" ? "历史候选不能证明本次操作，未确认行仍锁定；请在原店铺人工核对。" : "只有匹配原 Intent、操作与修订的记录可以更新，其他行仍保留原状态。"}</p>
      {reconciliation.current.status === "mixed_identity" && <p>请分别选择已有权威身份与无响应身份的商品批次核对。</p>}
      {reconciliation.current.status === "invalid_selection" && <p>请重新选择同平台、同店铺且身份与锁一致的至多 100 行；身份不完整时在原店铺人工核对，保留锁定。</p>}
      {reconciliation.current.status === "stale" && <p>读取期间商品修订、身份或作用域已变化；未匹配的行与锁保持原状态，请重新选择当前批次核对。</p>}
      {reconciliation.current.status === "unavailable" && <p>该平台尚未提供只读核对能力；请在原平台查看原店铺记录，保留未确认行。</p>}
      <details onToggle={() => { const action = beginAction("evidence-expand"); void endAction(action) }}><summary>查看所选批次的候选身份与状态</summary>
        <ul>{reconciliation.current.rows.map((row) => <li key={row.rowId}>{row.rowId}：{row.candidates.length === 0 ? "未找到可关联的记录" : row.candidates.map((candidate) => <p key={candidate.intentId}>Intent {candidate.intentId}；操作 {candidate.serverOperationId}；修订 {candidate.serverRevision}；{{ accepted: "已受理", pending: "待决", rejected: "已拒绝", unknown: "未确认" }[candidate.state]}{candidate.taskId ? `；任务 ${candidate.taskId}` : ""}</p>)}</li>)}</ul>
      </details>
    </section>}
    {snapshot?.phase === "stopping" && <p>已停止后续准入。当前请求期限最多还剩 {Math.max(0, Math.ceil(((snapshot.deadlines[0] ?? Date.now()) - Date.now()) / 1000))} 秒。</p>}
    {rows.length === 0 ? <p className="text-muted-foreground">尚无商品，请先导入夹具。</p> : <table className="w-full text-sm">
      <caption className="text-left text-muted-foreground">前 20 行；完整状态保存在本页独立数据库中</caption>
      <thead><tr><th scope="col">商品</th><th scope="col">店铺</th><th scope="col">结果</th></tr></thead>
      <tbody>{rows.slice(0, 20).map((row) => <tr key={row.id}><td>{row.position + 1}</td><td>{row.storeId}</td><td>{current?.rows.error !== undefined ? "结果尚未持久化" : row.submission ? rowLabel[row.submission.state] : "待发送"}</td></tr>)}</tbody>
    </table>}
    <PipelineRowDiagnostic rows={rows} requestEvidence={(row) => {
      const failure = requestFailure.current
      return failure?.revisions.get(row.id) === row.rev ? capturePublishRequestEvidence(failure.error, {
        scope: 1, mediaEpoch: 0, cardId: scope.cardId, storeId: row.storeId ?? "", rowId: row.id, revision: row.rev, viewRevision: row.rev,
      }) : undefined
    }} />
    <PipelineEvidencePanel />
    {current && !closed && <PublishPipelineWb core={core} rows={current.rows} />}
    <Button variant="outline" disabled={!current || closed || busy || rows.length > 0 || keepalive} onClick={() => {
      const measured = beginAction("workbench-configure"); setKeepalive(true); void endAction(measured)
    }}>选择真实 ScreenPane 保活夹具</Button>
    {current && !closed && (keepalive ? <PublishPipelineKeepalive core={core} mocks={mocks.workbench} />
      : <PublishPipelineWorkbench core={core} mocks={mocks.workbench} />)}
    <Toaster />
  </main></PipelineDiagnosticRoute>
}

createRoot(document.getElementById("fixture")!).render(<StrictMode><Profiler id="publish-pipeline" onRender={recordCommit}><Fixture /></Profiler></StrictMode>)
