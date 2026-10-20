import { memo, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { PublishRemediation } from "@/features/workflow/workbench/publish-remediation"
import { resolvePublishRemediation } from "@/features/workflow/model/publish-remediation"
import type { PublishProblem } from "@/features/workflow/model/publish-problem"
import { notifyError } from "@/lib/notify"
import { beginAction, bindTerminalEvidence, endAction, evidenceSnapshot } from "./publish-pipeline-metrics"
import { EVIDENCE_PREVIEW_PAGE_SIZE, serializeEvidence } from "./publish-pipeline-evidence-serialize"
export { EVIDENCE_PREVIEW_PAGE_SIZE } from "./publish-pipeline-evidence-serialize"

export function PipelineProblem({ problem }: { problem: PublishProblem }) {
  const remediation = resolvePublishRemediation(problem)
  return remediation ? <div onClickCapture={(event) => {
    if (event.target instanceof Element && event.target.closest("summary")) void endAction(beginAction("evidence-expand"))
  }}><PublishRemediation remediation={remediation} /></div> : null
}
export type EvidencePreview = { json: string; offsets: readonly number[]; pages?: readonly string[] }

export function createEvidencePreview(json: string): EvidencePreview {
  const offsets = [0]
  while (offsets[offsets.length - 1]! < json.length) {
    let end = Math.min(offsets[offsets.length - 1]! + EVIDENCE_PREVIEW_PAGE_SIZE, json.length)
    // Keep a Unicode surrogate pair on the same page without exceeding the bound.
    if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1]!) && /[\uDC00-\uDFFF]/.test(json[end]!)) end--
    offsets.push(end)
  }
  if (offsets.length === 1) offsets.push(0)
  return { json, offsets }
}

export function evidencePreviewPage(preview: EvidencePreview, page: number): string {
  if (!Number.isInteger(page) || page < 0 || page >= preview.offsets.length - 1) throw new RangeError("Evidence preview page is outside the snapshot")
  return preview.pages?.[page] ?? preview.json.slice(preview.offsets[page], preview.offsets[page + 1])
}

export const PipelineEvidencePanel = memo(function PipelineEvidencePanel() {
  const [preview, setPreview] = useState(() => createEvidencePreview(""))
  const [page, setPage] = useState(0)
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)
  const terminal = useRef<HTMLPreElement>(null)
  useEffect(() => terminal.current ? bindTerminalEvidence(terminal.current) : undefined, [])
  const pages = preview.offsets.length - 1
  const navigate = (next: number) => {
    const action = beginAction("evidence-expand")
    setPage(next)
    void endAction(action)
  }
  const exportComplete = async () => {
    if (exportingRef.current) return
    exportingRef.current = true
    const action = beginAction("evidence-export"), filename = `publish-pipeline-${Date.now()}.json`
    let ok = false, url: string | undefined
    try {
      const snapshot = evidenceSnapshot() // freeze click-time content before yielding
      setExporting(true)
      const result = await serializeEvidence(snapshot)
      url = URL.createObjectURL(result.blob)
      const anchor = document.createElement("a")
      anchor.href = url; anchor.download = filename; anchor.click()
      setPreview(result); setPage(0)
      ok = true
    } catch {
      notifyError("完整测量 JSON 未导出；原冻结预览仍可查看，请再次导出，仍失败请重新打开夹具后重做测量。")
    } finally {
      if (url) { const completedUrl = url; setTimeout(() => URL.revokeObjectURL(completedUrl), 1000) }
      setExporting(false)
      try { await endAction(action, ok) } finally { exportingRef.current = false }
    }
  }
  return <section aria-label="只读测量证据" className="flex flex-col gap-2">
    <h2 className="text-lg font-semibold">本轮测量证据</h2>
    <p>首屏、命名交互与证据导出分别记录；所有长任务保留。诊断、WB adapter、生产方案按钮和修复/释放能力已接入；实际动作授权、真实剪贴板、投递回执与浏览器性能仍待独立验收。</p>
    <p>预览分页显示；下载包含点击导出时的完整快照（紧凑 JSON，保留所有字段、事件与时间戳）。翻页不会重新采集快照。</p>
    <Button variant="outline" disabled={exporting} aria-busy={exporting} onClick={() => { void exportComplete() }}>导出测量 JSON</Button>
    {exporting && <p role="status">正在生成完整快照，完成后将下载并更新冻结预览。</p>}
    <p id="evidence-preview-page" role="status">第 {page + 1} 页，共 {pages} 页；完整 JSON 长度 {preview.json.length}；每页最多 {EVIDENCE_PREVIEW_PAGE_SIZE} 个 UTF-16 代码单元。</p>
    <div className="flex gap-2">
      <Button variant="outline" disabled={exporting || page === 0} onClick={() => navigate(page - 1)}>上一页</Button>
      <Button variant="outline" disabled={exporting || page + 1 === pages} onClick={() => navigate(page + 1)}>下一页</Button>
    </div>
    <textarea aria-label="测量 JSON（只读）" aria-describedby="evidence-preview-page" readOnly value={evidencePreviewPage(preview, page)} rows={8} />
    <h3 className="font-semibold">当前终态测量</h3>
    <p>此处随实际动作完成、Profiler commit 和长任务回执更新；包含导出、翻页及之后的测量。上方下载与分页仍是导出时的冻结快照。</p>
    <pre ref={terminal} role="region" aria-label="终态测量证据（只读）" className="whitespace-pre-wrap break-words text-sm" />
  </section>
})
