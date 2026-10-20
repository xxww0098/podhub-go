// Dev-only real DOM workload. The shared fixture rejects all network requests.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { FieldWorkbench } from "@/features/workflow/workbench/field-workbench"
import { workbench, ready, product } from "./workflow-interactions.browser"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLOutputElement>("#results")!
const stream = document.querySelector<HTMLButtonElement>("#stream")!
const root = createRoot(fixture)
let timer: ReturnType<typeof setInterval> | undefined
let updates = 0
let update: () => void = () => {}
const metrics = { mountedMs: 0, longTasks: [] as number[], updates: 0, selected: 0, edits: 0 }
Object.assign(window, { workbenchPerformance: metrics })
const observer = new PerformanceObserver((list) => {
  metrics.longTasks.push(...list.getEntries().map((entry) => entry.duration))
})
observer.observe({ type: "longtask", buffered: false })

function Workload({ count }: { count: number }) {
  const [rows, setRows] = useState(() => Array.from({ length: count }, (_, index) => ({
    ...ready, id: `perf-${index}`, draftId: `perf-${index}`, imageName: `product-${index}.jpg`,
  })))
  const [products, setProducts] = useState(() => Object.fromEntries(rows.map((row) => [row.draftId, {
    ...product, draft_id: row.draftId, draft: { ...product.draft, values: {
      ...product.draft.values,
      name: { kind: "text" as const, value: row.imageName },
      offer_id: { kind: "text" as const, value: row.draftId },
    } },
  }])))
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  update = () => {
    updates += 1
    metrics.updates = updates
    setRows((current) => current.map((row, index) => index % 10 === updates % 10
      ? { ...row, log: `状态更新 ${updates}` } : row))
  }
  return <FieldWorkbench {...workbench} rows={rows} productDrafts={products} selectedRowIds={selected}
    onSelectionChange={(ids) => { metrics.selected = ids.length; setSelected(new Set(ids)) }}
    onEditCell={(draftId, column, value) => {
      metrics.edits += 1
      setProducts((current) => ({ ...current, [draftId]: {
        ...current[draftId]!, draft: { ...current[draftId]!.draft, values: {
          ...current[draftId]!.draft.values, [column]: { kind: "text", value },
        } },
      } }))
    }} />
}
function stop() {
  clearInterval(timer)
  timer = undefined
  stream.textContent = "开始状态更新"
}
document.querySelector<HTMLButtonElement>("#run")!.onclick = async () => {
  stop()
  updates = 0
  Object.assign(metrics, { mountedMs: 0, longTasks: [], updates: 0, selected: 0, edits: 0 })
  const count = Math.max(1, Math.min(10000, Number(document.querySelector<HTMLInputElement>("#count")!.value) || 1000))
  const start = performance.now()
  flushSync(() => root.render(<Workload key={`${count}-${start}`} count={count} />))
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  metrics.mountedMs = performance.now() - start
  results.textContent = `${count} 行已载入：${metrics.mountedMs.toFixed(1)} ms`
}
stream.onclick = () => {
  if (timer) stop()
  else { timer = setInterval(() => update(), 100); stream.textContent = "停止状态更新" }
}
