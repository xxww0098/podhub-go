import { useState } from "react"
import { ImageOff } from "lucide-react"
import { cn } from "@/lib/utils"

export function ProductionThumbnail({ url, className }: { url?: string | null; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string>()
  return <span className={cn("grid shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground", className)}>
    {url && failedUrl !== url
      ? <img src={url} alt="生产素材预览" loading="lazy" decoding="async" className="size-full object-cover" onError={() => setFailedUrl(url)} />
      : <ImageOff className="size-4" aria-label="暂无生产素材预览" />}
  </span>
}
