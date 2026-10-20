import { useState } from "react"
import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react"
import type { WorkflowImageLifecycle } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { notifyError, notifySuccess } from "@/lib/notify"
import { formatFileSize, useSlicePreviews } from "../media/rendered-image"
import { MEDIA_ROLE_LABEL, type MediaRoleKey } from "../media/workflow-media-roles"

export function MediaDeliveryInspector({
  draftId,
  role,
  slices,
  urls,
  onRetryMedia,
}: {
  draftId: string
  role: MediaRoleKey
  slices: WorkflowImageLifecycle[]
  urls: string[]
  onRetryMedia: () => void
}) {
  // This popover is the only place slice thumbnails still paint. It mounts on
  // open and holds one role's slices, so the decode is bounded by what the
  // operator actually asked to inspect.
  const previews = useSlicePreviews(draftId, slices)
  const [copiedAll, setCopiedAll] = useState(false)
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  const copyAll = async () => {
    if (!urls.length) return
    try {
      await navigator.clipboard.writeText(urls.join("\n"))
      setCopiedAll(true)
      notifySuccess(`已复制 ${urls.length} 条${MEDIA_ROLE_LABEL[role]}公网链接`)
      setTimeout(() => setCopiedAll(false), 2000)
    } catch {
      notifyError("复制失败，请重试")
    }
  }

  const copySingle = async (url: string, index: number) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedIndex(index)
      notifySuccess(`已复制第 ${index + 1} 张图片公网链接`)
      setTimeout(() => setCopiedIndex(null), 2000)
    } catch {
      notifyError("复制失败，请重试")
    }
  }

  return (
    <div className="flex flex-col text-left text-xs">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-3 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate font-semibold text-foreground">
            {MEDIA_ROLE_LABEL[role]}
          </span>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-meta font-medium text-muted-foreground">
            {urls.length} 张已就绪
          </span>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-6 shrink-0 gap-1 px-2 text-meta"
          onClick={copyAll}
          disabled={!urls.length}
          aria-label="复制全部公网链接"
        >
          {copiedAll ? (
            <>
              <Check className="size-3 text-st-good-ink" />
              <span>已复制</span>
            </>
          ) : (
            <>
              <Copy className="size-3" />
              <span>复制全部链接</span>
            </>
          )}
        </Button>
      </div>

      <div className="max-h-60 divide-y divide-border/40 overflow-y-auto p-1">
        {slices.map((image) => {
          const key = `${image.index}:${image.content_hash}`
          const preview = previews[key]
          const url = image.public_url
          const isCopied = copiedIndex === image.index

          return (
            <div
              key={key}
              className="flex items-center gap-2.5 rounded-md p-1.5 transition-colors hover:bg-muted/50"
            >
              <div className="size-8 shrink-0 overflow-hidden rounded border border-border/70 bg-muted">
                {preview ? (
                  <img
                    src={preview}
                    alt={image.file_name}
                    className="size-full object-contain"
                  />
                ) : (
                  <div className="grid size-full place-items-center font-mono text-meta text-muted-foreground">
                    #{image.index + 1}
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-foreground text-meta" title={image.file_name}>
                  #{image.index + 1} · {image.file_name}
                </div>
                <div className="flex items-center gap-1 font-mono text-meta text-muted-foreground">
                  <span>{image.width}×{image.height}</span>
                  {image.byte_size ? (
                    <>
                      <span>·</span>
                      <span>{formatFileSize(image.byte_size)}</span>
                    </>
                  ) : null}
                </div>
              </div>

              {url ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 text-muted-foreground hover:text-foreground"
                    title="复制此链接"
                    aria-label={`复制第 ${image.index + 1} 张图片链接`}
                    onClick={() => copySingle(url, image.index)}
                  >
                    {isCopied ? (
                      <Check className="size-3 text-st-good-ink" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                  </Button>
                  <Button
                    render={<a href={url} target="_blank" rel="noreferrer" />}
                    nativeButton={false}
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 text-muted-foreground hover:text-foreground"
                    title="在浏览器打开图片"
                    aria-label={`在浏览器查看第 ${image.index + 1} 张图片`}
                  >
                    <ExternalLink className="size-3" />
                  </Button>
                </div>
              ) : image.phase === "uploading" ? (
                <span className="text-meta text-st-flight-ink">上传中</span>
              ) : (
                // No public URL means nothing to copy or open — the only honest
                // control here is the one that tries again.
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="h-6 shrink-0 gap-1 px-2 text-meta"
                  title={image.error_code ? `失败：${image.error_code}` : "尚未交付"}
                  aria-label={`重试第 ${image.index + 1} 张图片`}
                  onClick={onRetryMedia}
                >
                  <RefreshCw className="size-3" />
                  <span>重试</span>
                </Button>
              )}
            </div>
          )
        })}
      </div>

      <div className="border-t border-border/40 bg-muted/20 px-3 py-1.5 text-meta text-muted-foreground">
        发布商品时将直接引用以上公网地址
      </div>
    </div>
  )
}
