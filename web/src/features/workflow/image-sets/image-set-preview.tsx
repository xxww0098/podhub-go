import { useState } from "react"
import { ChevronLeft, ChevronRight, Images } from "lucide-react"
import { ErrorNotice } from "@/components/error-notice"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"

/** These URLs came from this source's confirmed AI set, never from arbitrary manual text. */
export function ImageSetPreview({ urls, primary }: { urls: string[]; primary: boolean }) {
  const [at, setAt] = useState(0)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const current = Math.min(at, urls.length - 1)
  function step(delta: number) { setAt((current + delta + urls.length) % urls.length); setFailed(false) }
  return <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (value) { setAt(0); setFailed(false) } }}>
    <DialogTrigger render={<Button size="xs" variant="ghost" aria-label={primary ? "查看 AI 主图" : `查看 AI 商品图（${urls.length} 张）`} />}><Images />{primary ? "主图" : `${urls.length} 张`} · AI</DialogTrigger>
    <DialogContent className="sm:max-w-3xl" aria-describedby={undefined} onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); step(event.key === "ArrowLeft" ? -1 : 1) }
    }}>
      <DialogTitle className="sr-only">{primary ? "AI 主图" : "AI 商品图"}</DialogTitle>
      <div className="grid min-h-32 place-items-center">
        {failed ? <ErrorNotice layout="block" className="min-h-32" title="图片加载失败" description="请关闭后重试。" /> : <img key={urls[current]} src={urls[current]} alt={`AI 商品图 ${current + 1}`} className="max-h-[75dvh] max-w-full object-contain" onError={() => setFailed(true)} />}
      </div>
      <div className="flex items-center justify-center gap-2">
        <IconButton icon={ChevronLeft} label="上一张 AI 图片" size="icon-xs" disabled={urls.length < 2} onClick={() => step(-1)} />
        <span className="text-meta tabular-nums">{current + 1}/{urls.length}</span>
        <IconButton icon={ChevronRight} label="下一张 AI 图片" size="icon-xs" disabled={urls.length < 2} onClick={() => step(1)} />
      </div>
    </DialogContent>
  </Dialog>
}
