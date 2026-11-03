import { ArrowDown, ArrowUp, Image, Images } from "lucide-react"
import { useEffect, useState } from "react"
import type { WorkflowCategoryDraft, WorkflowProductLifecycle } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useSlicePreviews } from "../media/rendered-image"
import { deliveredMediaSlices, selectedMediaState, type SelectableMediaRole } from "./media-selection"

export function MediaSelectionPicker({ draftId, role, lifecycle, draft, disabled, onSelect }: {
  draftId: string
  role: SelectableMediaRole
  lifecycle?: WorkflowProductLifecycle
  draft?: WorkflowCategoryDraft
  disabled: boolean
  onSelect: (urls: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener("resize", close)
    return () => window.removeEventListener("resize", close)
  }, [open])
  const slices = deliveredMediaSlices(lifecycle)
  if (!slices.length || !draft) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="ghost" size="xs" disabled={disabled} aria-label={role === "images" ? "选择商品图片" : "选择商品主图"} title={role === "images" ? "选择商品图片与排序" : "选择商品主图"} />}>
        {role === "images" ? <Images data-icon="inline-start" /> : <Image data-icon="inline-start" />}
        {role === "images" ? "选图" : "选主图"}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-24px)] p-2" aria-label={role === "images" ? "商品图片选择与排序" : "商品主图选择"}>
        <MediaSelectionOptions {...{ draftId, role, lifecycle, draft, disabled, onSelect }} />
      </PopoverContent>
    </Popover>
  )
}

function MediaSelectionOptions({ draftId, role, lifecycle, draft, disabled, onSelect }: {
  draftId: string
  role: SelectableMediaRole
  lifecycle?: WorkflowProductLifecycle
  draft: WorkflowCategoryDraft
  disabled: boolean
  onSelect: (urls: string[]) => void
}) {
  const available = deliveredMediaSlices(lifecycle)
  const urls = selectedMediaState(lifecycle, draft, role).urls
  const images = selectedMediaState(lifecycle, draft, "images").urls
  const primaryValue = draft.values.primary_image
  const pinned = primaryValue?.kind === "text" || primaryValue?.kind === "url" ? primaryValue.value.trim() : undefined
  const unknown = urls.some((url) => !available.some((image) => image.public_url === url))
  const choices = role === "primary_image" ? available.filter((image) => images.includes(image.public_url!)) : [
    ...urls.flatMap((url) => available.find((image) => image.public_url === url) ?? []),
    ...available.filter((image) => !urls.includes(image.public_url!)),
  ]
  const previews = useSlicePreviews(draftId, choices)
  const move = (index: number, delta: number) => {
    const next = [...urls]
    ;[next[index], next[index + delta]] = [next[index + delta]!, next[index]!]
    onSelect(next)
  }
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums">{role === "images" ? `已选 ${urls.length}/${available.length}` : "主图"}</span>
        {role === "images" ? <Button size="xs" variant="outline" disabled={disabled} onClick={() => onSelect(available.map((image) => image.public_url!))}>全选切片</Button> : null}
      </div>
      {unknown ? <p className="text-xs text-destructive">当前设置含非本行切片，请重新选择{role === "images" ? "全部切片" : "主图"}。</p> : null}
      <div className="grid max-h-72 gap-1 overflow-y-auto">
        {choices.map((image) => {
          const url = image.public_url!
          const at = urls.indexOf(url)
          const selected = at >= 0
          const preview = previews[`${image.index}:${image.content_hash}`]
          return (
            <div key={url} className="flex min-w-0 items-center gap-2 rounded-md p-1 hover:bg-muted">
              {role === "images" ? <Checkbox aria-label={`选用 ${image.file_name}`} checked={selected} disabled={disabled || unknown || selected && (urls.length === 1 || pinned === url)} onCheckedChange={(checked) => onSelect(checked ? [...urls, url] : urls.filter((item) => item !== url))} /> : null}
              <div className="grid size-9 shrink-0 place-items-center overflow-hidden rounded border bg-muted text-meta text-muted-foreground">
                {preview ? <img src={preview} alt={image.file_name} className="size-full object-contain" /> : `#${image.index + 1}`}
              </div>
              <span className="min-w-0 flex-1 truncate text-xs" title={image.file_name}>{image.file_name}</span>
              {role === "primary_image" ? (
                <Button size="xs" variant={selected ? "secondary" : "outline"} disabled={disabled || selected} aria-pressed={selected} aria-label={`设为主图 ${image.file_name}`} onClick={() => onSelect([url])}>{selected ? "当前主图" : "设为主图"}</Button>
              ) : selected ? (
                <div className="flex shrink-0 items-center gap-1">
                  <span className="text-meta tabular-nums text-muted-foreground">{at + 1}</span>
                  <IconButton icon={ArrowUp} label={`上移 ${image.file_name}`} size="icon-xs" disabled={disabled || unknown || at === 0} onClick={() => move(at, -1)} />
                  <IconButton icon={ArrowDown} label={`下移 ${image.file_name}`} size="icon-xs" disabled={disabled || unknown || at === urls.length - 1} onClick={() => move(at, 1)} />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
