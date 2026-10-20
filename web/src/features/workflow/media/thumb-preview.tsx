import { useState } from "react"
import { createPortal } from "react-dom"

export function ThumbPreview({ src, alt }: { src: string; alt: string }) {
  const [preview, setPreview] = useState<{ x: number; y: number }>()

  // 悬停与聚焦走同一条路径：这是个真按钮，键盘 Tab 到它也必须出预览。
  function show(event: { currentTarget: HTMLElement }) {
    const rect = event.currentTarget.getBoundingClientRect()
    const width = 236
    const height = 300
    const x = Math.min(rect.right + 10, window.innerWidth - width - 12)
    const y = Math.min(Math.max(12, rect.top - 24), window.innerHeight - height - 12)
    setPreview({ x, y })
  }

  function hide() {
    setPreview(undefined)
  }

  const extMatch = alt.match(/\.([a-zA-Z0-9]+)$/)
  const ext = extMatch ? extMatch[1]?.toUpperCase() : undefined

  return (
    <>
      <button
        type="button"
        className="group relative size-12 shrink-0 overflow-hidden rounded-md border border-border bg-muted/30 transition-[border-color] duration-150 ease-settle hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-label={`${alt} 预览`}
      >
        <img
          src={src}
          alt={alt}
          width={48}
          height={48}
          loading="lazy"
          decoding="async"
          className="size-12 object-cover transition-transform duration-200 group-hover:scale-105"
        />
      </button>
      {preview && typeof document !== "undefined"
        ? createPortal(
            <div
              aria-hidden="true"
              className="pointer-events-none fixed z-[300] overflow-hidden rounded-xl border border-border/90 bg-card p-1.5 shadow-overlay transition-opacity duration-150"
              style={{ left: preview.x, top: preview.y, width: 236 }}
            >
              <div className="relative h-64 w-full overflow-hidden rounded-lg bg-muted/60">
                <img
                  src={src}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="size-full object-contain"
                />
                {ext ? (
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 font-mono text-meta font-semibold text-white/90 backdrop-blur-sm">
                    {ext}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center justify-between gap-1.5 px-1.5 pt-1.5 pb-0.5">
                <p className="truncate font-mono text-meta text-foreground font-medium" title={alt}>
                  {alt}
                </p>
                <span className="shrink-0 text-meta text-muted-foreground">原图</span>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
