/** WB records share the fixture's CardRows lock; they never enter the submit queue. */
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { notifyError } from "@/lib/notify"
import type { ListingCoreClient } from "@/listing-core/client"
import type { CardRows } from "@/features/workflow/rows/card-rows"
import { createWbCache } from "@/features/workflow/platforms/wb/cache"
import { createWbAdapter, wbSendCapability } from "@/features/workflow/platforms/wb/adapter"
import { wbPublishProblem } from "@/features/workflow/platforms/wb/publish-problem"
import type { WbPreview } from "@/listing-core/wb-types"
import type { PublishDiagnosticReference } from "@/features/workflow/model/publish-diagnostic"
import { resolvePublishRemediation } from "@/features/workflow/model/publish-remediation"
import { PublishDiagnosticDetails } from "@/features/workflow/workbench/publish-diagnostic-details"
import { PipelineProblem } from "./publish-pipeline-evidence"
import { beginAction, endAction, recordCommit, recordNative, type ActionName } from "./publish-pipeline-metrics"
import { wbConfigFixture, wbCoordinateConfigFixture, wbFixtureState, setWbMaterialFixture, type WbCoordinateSample } from "./publish-pipeline-fixtures"
import { runWbRemediationComponentTests } from "@/features/workflow/workbench/publish-wb-remediation.test"

const coordinate = { subjectId: 105, language: "ru" as const }
export function PublishPipelineWb({ core, rows }: { core: ListingCoreClient; rows: CardRows }) {
  const cache = useRef<ReturnType<typeof createWbCache> | null>(null)
  const [busy, setBusy] = useState(false)
  const working = useRef(false)
  const [version, setVersion] = useState(0)
  const [empty, setEmpty] = useState(false)
  const [characteristicCase, setCharacteristicCase] = useState("valid")
  const [coordinateCase, setCoordinateCase] = useState("single")
  const [materialCase, setMaterialCase] = useState("valid")
  const componentHost = useRef<HTMLDivElement>(null)
  const live = useRef(true)
  const [diagnostic, setDiagnostic] = useState<{ recordId: string; revision: number; reference: PublishDiagnosticReference }>()
  useEffect(() => {
    live.current = true
    const resident = createWbCache({ core, scope: { accountId: "fixture-account", workspaceUuid: "fixture-workspace", sessionFence: "fixture-session" }, current: () => live.current })
    cache.current = resident
    const unsubscribe = rows.subscribe(() => setVersion((value) => value + 1))
    return () => { live.current = false; unsubscribe(); cache.current = null; void resident.close().catch(() => {}) }
  }, [core, rows])
  const run = (name: ActionName, action: () => Promise<void>) => {
    if (working.current) return
    const measured = beginAction(name)
    let ok = true
    working.current = true; setBusy(true)
    void action().catch(() => { ok = false; notifyError("WB 预览未完成，请显式刷新类目并核对当前记录；仍失败请重新打开夹具") })
      .finally(async () => { working.current = false; setBusy(false); setVersion((value) => value + 1); await endAction(measured, ok) })
  }
  void version
  const record = rows.wb.all()[0]
  const material = cache.current?.get(coordinate)
  return <section aria-busy={busy} className="flex flex-col gap-3" aria-label="WB 原生预览">
    <h2 className="text-lg font-semibold">WB 原生预览</h2>
    <p className="text-muted-foreground">每条记录是一组有序变体，类目和特征使用 WB 自身编号。</p>
    <label className="flex items-center gap-2"><input type="checkbox" checked={empty} disabled={busy || !!material} onChange={(event) => { setEmpty(event.target.checked); wbFixtureState.empty = event.target.checked }} />模拟目录尚未采集</label>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || !!record} onClick={() => run("wb-import", async () => { rows.wb.create(crypto.randomUUID(), wbConfigFixture()); await rows.flush() })}>导入 WB 预览记录</Button>
      <Button variant="outline" disabled={busy || !!material} onClick={() => run("wb-open", async () => { await cache.current!.open(coordinate) })}>打开 WB 类目</Button>
      <Button variant="outline" disabled={busy || !material} onClick={() => run("wb-refresh", async () => { await cache.current!.refresh(coordinate) })}>显式刷新 WB 类目</Button>
      <Button disabled={busy || !record || !material} onClick={() => run("wb-edit-validate", async () => {
        const captured = rows.wb.get(record!.id)!
        const observed: { preview?: WbPreview; nativeCalls: number; reference?: PublishDiagnosticReference } = { nativeCalls: 0 }
        const adapter = createWbAdapter({ async wbPreview(handle, config) {
          observed.nativeCalls++; const result = await core.wbPreview(handle, config); observed.preview = result; return result
        } }, (issue) => {
          const problem = wbPublishProblem(issue, { recordId: captured.id, variantCount: captured.config.variants.length })
          const solution = resolvePublishRemediation(problem)
          if (!solution) throw new Error("Canonical WB solution missing")
          return { platform: "wb", stage: issue.key.stage, field: issue.field, code: issue.key.code,
            message: solution.reason, remediation: solution.steps.join("；") }
        }, (recordId, reference) => {
          if (live.current && rows.writable && recordId === captured.id && rows.wb.get(recordId)?.rev === captured.rev)
            observed.reference = reference
        })
        try {
          const built = await adapter.build({ material: () => cache.current!.requireHandle(coordinate), groups: [{ key: captured.id, config: captured.config }] })
          const preview = observed.preview
          if (observed.nativeCalls !== 1 || !preview) throw new Error("WB adapter must use exactly one actual native preview")
          const settled = rows.wb.settle(captured.id, captured.rev, preview)
          const current = rows.wb.get(captured.id)
          if (settled && live.current && rows.writable && current && observed.reference)
            setDiagnostic({ recordId: current.id, revision: current.rev, reference: observed.reference })
          recordNative("wb-preview", { recordId: captured.id, revision: captured.rev, settled, nativeCalls: observed.nativeCalls, frozen: built.frozen.length,
            issues: preview.issues.map((issue) => ({ ...issue.key, field: issue.field, scope: issue.scope, characteristicId: issue.characteristicId, variantIndex: issue.variantIndex })),
            inputVariants: captured.config.variants.length, group: !!preview.group, bytes: preview.uploadBytes?.length ?? 0, variants: preview.group?.variants.length ?? 0 })
          await rows.flush()
        } catch (reason) {
          if (live.current && rows.writable && rows.wb.get(captured.id)?.rev === captured.rev && observed.reference)
            setDiagnostic({ recordId: captured.id, revision: captured.rev, reference: observed.reference })
          throw reason
        }
      })}>本地校验与预览</Button>
      <Button disabled={!wbSendCapability.enabled}>WB 发送尚未开通</Button>
      <Button variant="outline" disabled={busy} onClick={() => run("wb-edit-validate", async () => {
        const results = await runWbRemediationComponentTests(core, componentHost.current!, recordCommit)
        recordNative("wb-mounted-remediation-checks", { results })
      })}>运行 WB 方案组件检查</Button>
    </div>
    {!record ? <p>尚无 WB 预览记录，请导入后编辑。</p> : <label className="flex items-center gap-2">首个变体货号
      <input className="border border-input" value={record.config.variants[0]?.vendorCode ?? ""} disabled={busy} onChange={(event) => {
        const config = structuredClone(record.config)
        if (config.variants[0]) config.variants[0].vendorCode = event.target.value
        const measured = beginAction("wb-edit-validate")
        rows.wb.edit(record.id, record.rev, config)
        void rows.flush().then(() => endAction(measured), () => endAction(measured, false))
      }} />
    </label>}
    <label>WB 原生特征样本<select value={characteristicCase} disabled={busy || !record} onChange={(event) => {
      const measured = beginAction("wb-edit-validate"), sample = event.target.value
      setCharacteristicCase(sample)
      const config = structuredClone(record!.config), variant = config.variants[0]!
      variant.characteristics = { "300": ["Хлопок"], ...(sample === "blank" ? { "100": ["   "] }
        : sample === "unknown" ? { "9999": ["Fixture"] } : sample === "max-count" ? { "100": ["Красный", "Синий", "Белый"] }
        : sample === "number-type" ? { "100": ["Красный"], "200": ["Fixture"] } : { "100": ["Красный"], "200": 5 }) }
      rows.wb.edit(record!.id, record!.rev, config)
      void rows.flush().then(() => endAction(measured), () => endAction(measured, false))
    }}><option value="valid">有效文本数组与有限数字</option><option value="blank">空白文本</option>
      <option value="unknown">未知特征 ID</option><option value="max-count">超出 maxCount</option>
      <option value="number-type">数字特征使用文本数组</option></select></label>
    <label>WB 有序变体定位样本<select value={coordinateCase} disabled={busy || !record} onChange={(event) => {
      const measured = beginAction("wb-edit-validate"), sample = event.target.value
      setCoordinateCase(sample)
      const config = sample === "single" ? wbConfigFixture() : wbCoordinateConfigFixture(sample as WbCoordinateSample)
      rows.wb.edit(record!.id, record!.rev, config)
      void rows.flush().then(() => endAction(measured), () => endAction(measured, false))
    }}><option value="single">原单变体样本</option><option value="valid">两个有效有序变体</option>
      <option value="second-only">仅第二变体特征为空白</option><option value="both">两个变体同一特征为空白</option>
      <option value="group">商品组 subject 不匹配</option><option value="variant">第二变体缺少货号</option></select></label>
    <label>WB 类目材料样本<select value={materialCase} disabled={busy} onChange={(event) => {
      const measured = beginAction("wb-edit-validate"), sample = event.target.value as "valid" | "blank-default"
      setMaterialCase(sample); setWbMaterialFixture(sample)
      void endAction(measured)
    }}><option value="valid">有效类目与默认特征</option><option value="blank-default">材料默认特征为空白</option></select></label>
    <p className="text-muted-foreground">材料样本只改变下次显式打开或刷新的夹具响应；选择和编辑不会请求后端。</p>
    <p role="status">{busy ? "正在处理 WB 预览" : !material ? "尚未加载 WB 类目" : material.response.catalog === null ? "WB 目录为空，已保留商品输入" : !record?.preview ? "等待本地校验" : record.preview.issues.length ? `预览未生成，${record.preview.issues.length} 项需要处理` : "WB 本地预览已生成"}</p>
    {material?.response.catalog === null && <p>请管理员通过 WB 目录采集后续切片补充该类目，再显式刷新；当前只读接口不会访问 Seller 或填充目录。</p>}
    <section aria-label="WB 原生校验问题">
      {record?.preview?.issues.map((issue, index) => <PipelineProblem key={index}
        problem={wbPublishProblem(issue, { recordId: record.id, variantCount: record.config.variants.length })} />)}
    </section>
    <div ref={componentHost} aria-label="WB 挂载组件检查" />
    {diagnostic && record?.id === diagnostic.recordId && record.rev === diagnostic.revision
      && <PublishDiagnosticDetails diagnosticId={diagnostic.reference.diagnosticId} traceId={diagnostic.reference.traceId} />}
    {record?.preview?.uploadBytes && <output>原生上传预览 {record.preview.uploadBytes.length} UTF-8 字节；变体顺序 {record.preview.group?.variants.map((variant) => variant.vendorCode).join(" → ")}</output>}
    <PipelineProblem problem={{ platform: "wb", stage: "submit", family: "control", code: wbSendCapability.code }} />
  </section>
}
