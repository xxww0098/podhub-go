import { useId } from "react"
import { SlidersHorizontal } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ocrEstimateText, ocrModelFace, ocrUnitPriceText, type OcrPriceRates } from "../prepare/ocr-model-choice"
import { writeOcrModelChoice } from "../prepare/ocr-model-preference"
import { useOcrCatalogue, type OcrCatalogue, type OcrModelRouting } from "../prepare/ocr-model-routing"
import { patchListingWorkbench, useListingWorkbenchStore } from "./listing-workbench-store"

export function commitOcrModelChoice(routing: OcrModelRouting | undefined): void {
  writeOcrModelChoice(routing)
  patchListingWorkbench({ modelRouting: routing })
}

export function OcrModelControls({ disabled }: { disabled: boolean }) {
  const catalogue = useOcrCatalogue()
  const routing = useListingWorkbenchStore(state => state.modelRouting)
  return <Popover>
    <PopoverTrigger render={<Button size="sm" variant="ghost" disabled={disabled}>
      <SlidersHorizontal aria-hidden />识图模型
    </Button>} />
    <PopoverContent>
      <OcrModelSelects {...catalogue} disabled={disabled} routing={routing} onChange={commitOcrModelChoice} />
    </PopoverContent>
  </Popover>
}

function priceFor(data: OcrCatalogue | undefined, model: string | undefined): OcrPriceRates | undefined {
  if (!model) return undefined
  return data?.prices.find(price => price.model === model)
}

function ModelLines({ model, data, system = false }: { model?: string; data?: OcrCatalogue; system?: boolean }) {
  const face = model ? ocrModelFace(model) : undefined
  const price = priceFor(data, model)
  return <span className="grid min-w-0 gap-0.5 whitespace-normal">
    <span>{system ? "系统默认" : face?.headline}</span>
    {system && face ? <span>{face.headline}</span> : null}
    {face ? <span className="break-all font-mono text-meta text-muted-foreground">{face.modelId}</span> : null}
    {price ? <span className="text-meta text-muted-foreground">{ocrUnitPriceText(price)}</span> : null}
    {price ? <span className="text-meta text-muted-foreground">{ocrEstimateText(price)}</span> : null}
    {system ? <span className="text-meta text-muted-foreground">不启用备用</span> : null}
  </span>
}

function PriceNote({ model, data }: { model?: string; data?: OcrCatalogue }) {
  if (!model) return null
  const price = priceFor(data, model)
  return <div className="grid gap-0.5">
    <p className="break-all font-mono text-meta text-muted-foreground">{ocrModelFace(model).modelId}</p>
    {price ? <p className="text-meta text-muted-foreground" title="按典型识图 4 万输入 + 3.5 千输出估算">
      <span className="block">{ocrUnitPriceText(price)}</span>
      <span className="block">{ocrEstimateText(price)}</span>
    </p> : null}
  </div>
}

export function OcrModelSelects({ data, loading, retry, disabled, routing, onChange }: {
  data?: OcrCatalogue; loading: boolean; retry: () => void; disabled: boolean
  routing?: OcrModelRouting; onChange: (routing: OcrModelRouting | undefined) => void
}) {
  const id = useId()
  const models = data?.ocr_models ?? []
  const unavailable = !!routing && (!models.includes(routing.primary_model) || !!routing.backup_model && !models.includes(routing.backup_model))
  const pinned = routing?.primary_model ?? data?.default_ocr_model ?? undefined
  const primaryLabel = loading
    ? "加载模型…"
    : routing?.primary_model
      ? ocrModelFace(routing.primary_model).headline
      : data?.default_ocr_model
        ? `系统默认 · ${ocrModelFace(data.default_ocr_model).headline}`
        : "系统默认"
  return <div role="group" aria-label="识图模型" className="grid min-w-0 gap-2">
    <label htmlFor={`${id}-primary`} className="text-meta text-muted-foreground">主模型</label>
    <Select value={routing?.primary_model ?? ""} disabled={disabled || loading}
      onValueChange={value => onChange(value ? { primary_model: value, ...(routing?.backup_model && routing.backup_model !== value ? { backup_model: routing.backup_model } : {}) } : undefined)}>
      <SelectTrigger id={`${id}-primary`} size="sm" className="w-full min-w-0" aria-invalid={unavailable || undefined}>
        <SelectValue className="min-w-0 truncate">{primaryLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent className="w-80 max-w-full">
        <SelectItem value=""><ModelLines model={data?.default_ocr_model ?? undefined} data={data} system /></SelectItem>
        {models.map(model => <SelectItem key={model} value={model}><ModelLines model={model} data={data} /></SelectItem>)}
      </SelectContent>
    </Select>
    <PriceNote model={pinned} data={data} />
    <label htmlFor={`${id}-backup`} className="text-meta text-muted-foreground">备用模型</label>
    <Select value={routing?.backup_model ?? ""} disabled={disabled || loading || !routing || !models.includes(routing.primary_model)}
      onValueChange={value => { if (routing) onChange({ primary_model: routing.primary_model, ...(value ? { backup_model: value } : {}) }) }}>
      <SelectTrigger id={`${id}-backup`} size="sm" className="w-full min-w-0"><SelectValue className="min-w-0 truncate">{routing?.backup_model ? ocrModelFace(routing.backup_model).headline : "无"}</SelectValue></SelectTrigger>
      <SelectContent className="w-80 max-w-full">
        <SelectItem value="">无</SelectItem>
        {models.filter(model => model !== routing?.primary_model).map(model => <SelectItem key={model} value={model}><ModelLines model={model} data={data} /></SelectItem>)}
      </SelectContent>
    </Select>
    {routing?.backup_model ? <PriceNote model={routing.backup_model} data={data} /> : null}
    <p className="text-meta text-muted-foreground">单次估算按 4 万未缓存输入 + 3.5 千普通输出计算，不含额外思考用量，实际按用量结算。</p>
    <p className="text-meta text-muted-foreground">请在首次准备前选择。系统默认会在创建任务时固定为当时的默认识图模型。已创建的识图任务保留原选择。备用默认关闭，仅未派发或明确认证拒绝时切换；按实际模型计费。</p>
    {!loading && (!data || !models.length || unavailable) ? <>
      {data && !models.length ? <span className="text-meta text-muted-foreground">暂无可选模型</span> : null}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={retry}>刷新模型</Button>
    </> : null}
  </div>
}
