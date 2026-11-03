import type { ReactNode } from "react"
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WORKFLOW_STAGE_VIEWS, type WorkflowStageView, type WorkflowView } from "./workflow-stage-view"

const LABELS: Record<WorkflowView, string> = {
  all: "全部总览", materials: "准备素材", processing: "加工审阅", ready: "待发送", receipts: "平台回执",
}
const SHORT_LABELS: Record<WorkflowView, string> = { all: "总览", materials: "素材", processing: "加工", ready: "待发", receipts: "回执" }

export function WorkflowStageTabs({ value, counts, total, onChange, actions, children }: {
  value: WorkflowView
  counts: Record<WorkflowStageView, number>
  total: number
  onChange: (next: WorkflowView) => void
  actions?: ReactNode
  children: ReactNode
}) {
  return <Tabs value={value} onValueChange={(next) => onChange(next as WorkflowView)} className="min-h-0 min-w-0 flex-1">
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border">
    <div className="min-w-0 max-w-full flex-1 basis-full overflow-x-auto sm:basis-auto">
      <TabsList variant="line" aria-label="精铺流程阶段" className="w-max">
        {(["all", ...WORKFLOW_STAGE_VIEWS] as const).map((view) => <TabsTrigger key={view} value={view} variant="line" data-workflow-view={view} aria-label={`${LABELS[view]} ${view === "all" ? total : counts[view]}`}>
          <span className="whitespace-nowrap sm:hidden">{SHORT_LABELS[view]}</span>
          <span className="hidden whitespace-nowrap sm:inline">{LABELS[view]}</span>
          <span className="font-mono text-meta tabular-nums text-muted-foreground">{view === "all" ? total : counts[view]}</span>
        </TabsTrigger>)}
        <TabsIndicator variant="line" />
      </TabsList>
    </div>
    {actions}
    </div>
    {/* One active panel changes its value, keeping the grid and editors mounted across views. */}
    <TabsContent value={value} keepMounted className="min-h-0 min-w-0">
      <div className="flex h-full min-h-0 min-w-0 flex-col gap-1" data-workflow-active-view={value}>{children}</div>
    </TabsContent>
  </Tabs>
}
