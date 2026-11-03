import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { motion, useReducedMotion } from "motion/react"
import { LoaderCircle, Pin, RefreshCw, Sparkles } from "lucide-react"
import { availableImageSetCapability, imageSetsHttp, type ImageSet } from "@/bindings/http-ai-image-sets"
import { ErrorNotice } from "@/components/error-notice"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAccountOverview } from "@/features/account/account-overview-cache"
import { errorMessage } from "@/lib/error-message"
import { formatYuan } from "@/lib/money"
import { queryClient } from "@/lib/query-client"
import type { ListingRow } from "../model/listing-row"
import { peekListingWorkbench, useListingWorkbenchStore } from "../workbench/listing-workbench-store"
import { imageSetSource } from "./image-set-source"
import { rememberImageSet } from "./image-set-cache"
import { imageSetEditOpen, imageSetOwner, imageSetUnknown, intentStorageKey, readImageSetIntent, readyImageSetURLs, reserveImageSetIntent, retryableImageSet, updateImageSetIntent, type ImageSetIntent, type ImageSetMediaEdit, type ImageSetScope } from "./image-set-state"

export function ImageSetButton({ row, sourceReadable, onApply }: {
  row: ListingRow; sourceReadable: boolean
  onApply?: (draftId: string, edit: ImageSetMediaEdit) => Promise<boolean>
}) {
  useAccountOverview()
  const owner = imageSetOwner()
  const cardId = useListingWorkbenchStore((state) => state.cardId)
  const [open, setOpen] = useState(false)
  const [, setStorageVersion] = useState(0)
  const scope: ImageSetScope = { owner, cardId: cardId ?? "", rowId: row.id, draftId: row.draftId, sourceHandle: row.source?.handle ?? "" }
  const editable = useListingWorkbenchStore((state) => imageSetEditOpen(state, scope, owner))
  const storageKey = intentStorageKey(scope)
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === storageKey) setStorageVersion((v) => v + 1) }
    window.addEventListener("storage", changed)
    return () => window.removeEventListener("storage", changed)
  }, [storageKey])
  const capability = useQuery({ queryKey: ["ai-image-set-capability", owner], queryFn: imageSetsHttp.capability, enabled: Boolean(owner && sourceReadable && row.source?.handle && cardId && onApply), staleTime: 30_000, retry: false }, queryClient)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener("resize", close)
    return () => window.removeEventListener("resize", close)
  }, [open])
  const available = capability.data && availableImageSetCapability(capability.data) ? capability.data : undefined
  const existing = owner && cardId && row.source?.handle ? readImageSetIntent(scope) : undefined
  if (!owner || !cardId || !row.source?.handle || !onApply || !existing && (!sourceReadable || !available)) return null
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`AI 套图 ${row.imageName}`} title="AI 套图" />}><Sparkles /></PopoverTrigger>
    <PopoverContent align="start" className="w-[26rem] max-w-[calc(100vw-24px)] p-2" aria-label="AI 套图">
      <ImageSetPanel key={storageKey} {...{ scope, open, onApply }} capability={available} refreshCapability={() => capability.refetch()} disabled={!sourceReadable || !editable} />
    </PopoverContent>
  </Popover>
}

function ImageSetPanel({ scope, open, capability, refreshCapability, disabled, onApply }: {
  scope: ImageSetScope; open: boolean; capability?: import("@/bindings/http-ai-image-sets").AvailableImageSetCapability
  refreshCapability: () => Promise<unknown>; disabled: boolean
  onApply: (draftId: string, edit: ImageSetMediaEdit) => Promise<boolean>
}) {
  const [intent, setIntent] = useState<ImageSetIntent | undefined>(() => readImageSetIntent(scope))
  const [view, setView] = useState<ImageSet>()
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [applied, setApplied] = useState(false)
  const busyRef = useRef(false)
  const alive = useRef(true)
  const bornScope = useRef(peekListingWorkbench().scope)
  const reducedMotion = useReducedMotion()
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  function current() {
    const state = peekListingWorkbench()
    const row = state.rows.find((item) => item.id === scope.rowId && item.draftId === scope.draftId)
    return alive.current && state.scope === bornScope.current && state.cardId === scope.cardId && imageSetOwner() === scope.owner && row?.source?.handle === scope.sourceHandle
  }
  async function accept(next: ImageSet, purchase: ImageSetIntent) {
    if (!current()) return
    const saved = await updateImageSetIntent(scope, purchase.key, next.id)
    if (!current()) return
    if (!saved || saved.key !== purchase.key) { setIntent(saved); setView(undefined); setSelected([]); setError("原请求记录已变化，请重新查询"); return }
    setIntent(saved)
    setView(next)
    setSelected(readyImageSetURLs(next))
    rememberImageSet(saved, next)
  }
  async function recover() {
    const purchase = readImageSetIntent(scope)
    if (!purchase || busyRef.current) return
    busyRef.current = true; setBusy(true); setError("")
    try { await accept(await imageSetsHttp.find(purchase.key, purchase.setId), purchase) }
    catch (reason) { if (current()) setError((reason as { status?: number }).status === 404 ? "暂未查到原请求，保留记录，请稍后查询" : errorMessage(reason, "结果未确认，请查询原请求")) }
    finally { busyRef.current = false; if (alive.current) setBusy(false) }
  }
  useEffect(() => { if (open && intent && !view) void recover() }, [open]) // The same key is read only; opening never purchases.
  async function generate(retry = false) {
    if (busyRef.current || disabled || !capability || !current()) return
    const existing = readImageSetIntent(scope)
    if (existing && !retry) { setIntent(existing); setError("已有原请求，请查询结果"); return }
    if (retry && (!existing || !view || !retryableImageSet(view) || existing.key !== intent?.key)) return
    busyRef.current = true; setBusy(true); setError("")
    let purchase: ImageSetIntent | undefined
    try {
      if (retry) {
        const confirmed = await imageSetsHttp.find(existing!.key, existing!.setId)
        if (!retryableImageSet(confirmed)) { await accept(confirmed, existing!); throw new Error("原请求状态已变化，不能再次生成") }
      }
      const source = await imageSetSource(scope.sourceHandle)
      if (retry && source.sha256 !== existing!.rawSHA256) throw new Error("本行源图已变化，不能重试旧请求")
      if (!current()) return
      if (!imageSetEditOpen(peekListingWorkbench(), scope)) throw new Error("商品状态已变化，暂不能生成")
      const reserved = await reserveImageSetIntent(scope, source.sha256, () => {
        return current() && imageSetEditOpen(peekListingWorkbench(), scope)
      }, navigator.locks, localStorage, retry ? existing!.key : undefined)
      purchase = reserved.intent
      setIntent(purchase)
      if (!reserved.created) { setError("已有原请求，请查询结果"); return }
      setView(undefined); setSelected([]); setApplied(false)
      await accept(await imageSetsHttp.create({ account_id: capability.account_id, model: capability.model, source_base64: source.base64, expected_unit_microfen: capability.unit_microfen }, purchase.key), purchase)
    } catch (reason) {
      if ((reason as { serverCode?: string }).serverCode === "IMAGE_PRICE_CHANGED") {
        const remaining = purchase ? await updateImageSetIntent(scope, purchase.key, null) : readImageSetIntent(scope)
        if (current()) {
          setIntent(remaining)
          await refreshCapability()
          if (current()) setError("价格已变化，未购买；请确认新费用")
        }
      } else if (current()) setError(errorMessage(reason, purchase ? "结果未确认，请查询原请求" : "源图不可读取"))
    } finally { busyRef.current = false; if (alive.current) setBusy(false) }
  }
  async function apply(restore: boolean) {
    if (busyRef.current || disabled || !intent || !current() || !restore && !view) return
    busyRef.current = true; setBusy(true); setError("")
    try {
      const source = await imageSetSource(scope.sourceHandle)
      if (!current() || source.sha256 !== intent.rawSHA256) throw new Error("本行源图已变化，不能使用旧结果")
      if (readImageSetIntent(scope)?.key !== intent.key) throw new Error("套图请求已变化，请重新查询")
      const ok = await onApply(scope.draftId, restore ? { intent, restore: true } : { intent, view: view!, urls: selected })
      if (!ok) throw new Error("图片尚未保存，请检查本行保存状态")
      if (current()) setApplied(!restore)
    } catch (reason) { if (current()) setError(errorMessage(reason, "图片未保存")) }
    finally { busyRef.current = false; if (alive.current) setBusy(false) }
  }
  const ready = view ? readyImageSetURLs(view) : []
  const unresolved = intent && (!view || imageSetUnknown(view))
  return <div className="grid gap-2" onClick={(event) => event.stopPropagation()}>
    {!intent && capability ? <div className="flex flex-wrap items-center gap-2"><Button size="xs" disabled={busy || disabled} title={capability.model} onClick={() => void generate()}>{busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}生成 {capability.count} 张 · {formatYuan(capability.set_microfen)}</Button></div> : null}
    {view ? <motion.div initial={reducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }} className="grid grid-cols-3 gap-2">
      {[0, 1, 2].map((ordinal) => {
        const item = view.items.find((item) => item.ordinal === ordinal)
        const url = item?.asset?.url
        const usable = Boolean(url && ready.includes(url))
        return <div key={ordinal} className="grid min-w-0 gap-1 text-xs">
          <div className="relative grid aspect-square place-items-center overflow-hidden rounded-md border bg-muted">
            {usable ? <a href={url} target="_blank" rel="noreferrer" aria-label={`查看${["白底", "场景", "细节"][ordinal]}套图`}><img src={url} alt={["白底", "场景", "细节"][ordinal]} className="aspect-square size-full object-contain" /></a> : <span className="text-meta text-muted-foreground">{item?.status === "processing" ? "处理中" : item?.status === "unknown" ? "结果未知" : "未生成"}</span>}
            {usable && selected.includes(url!) ? <Button size="icon-xs" variant={selected[0] === url ? "default" : "outline"} className="absolute bottom-1 right-1" aria-label={`设为主图 ${["白底", "场景", "细节"][ordinal]}`} aria-pressed={selected[0] === url} title={selected[0] === url ? "当前主图" : "设为主图"} disabled={busy || disabled} onClick={() => setSelected((prev) => [url!, ...prev.filter((value) => value !== url)])}><Pin /></Button> : null}
          </div>
          <span className="flex items-center gap-1"><Checkbox checked={Boolean(url && selected.includes(url))} disabled={busy || disabled || !usable} aria-label={`选用${["白底", "场景", "细节"][ordinal]}套图`} onCheckedChange={(checked) => setSelected((prev) => checked ? [...prev, url!] : prev.filter((v) => v !== url))} />{["白底", "场景", "细节"][ordinal]}</span>
        </div>
      })}
    </motion.div> : null}
    {intent ? <div className="flex flex-wrap items-center gap-2">
      {unresolved ? <Button size="xs" variant="ghost" disabled={busy} aria-label="查询套图结果" onClick={() => void recover()}><RefreshCw className={busy ? "animate-spin" : ""} />查询结果</Button> : <IconButton icon={RefreshCw} label="查询套图结果" size="icon-xs" disabled={busy} className={busy ? "[&_svg]:animate-spin" : undefined} onClick={() => void recover()} />}
      <Button size="xs" disabled={busy || disabled || !selected.length || !view} onClick={() => void apply(false)}>{applied ? "重新选用" : "选用"} {selected.length} 张</Button>
      <Button size="xs" variant="ghost" disabled={busy || disabled} onClick={() => void apply(true)}>恢复切片</Button>
      {view ? <span className="text-meta text-muted-foreground">已计费 {formatYuan(view.items.reduce((sum, item) => sum + item.charged_microfen, 0))}</span> : null}
      {view && retryableImageSet(view) && capability ? <Button size="xs" variant="outline" disabled={busy || disabled} onClick={() => void generate(true)}>重试生成 · {formatYuan(capability.set_microfen)}</Button> : null}
    </div> : null}
    {disabled ? <p className="text-xs text-muted-foreground">当前商品锁定，暂不能生成或选用</p> : unresolved ? <p className="text-xs text-muted-foreground" role="status">{busy ? "正在核对原请求" : "结果未确认，仅查询原请求"}</p> : null}
    {view?.status === "partial" ? <p className="text-xs text-muted-foreground">部分图片未完成，可选用已就绪图片</p> : view?.status === "failed" ? <p className="text-xs text-st-bad-ink">生成失败，未生成的图片未计费</p> : null}
    {error ? <ErrorNotice layout="text" title={error} /> : applied ? <span role="status" className="text-xs text-muted-foreground">已保存本行图片</span> : null}
  </div>
}
