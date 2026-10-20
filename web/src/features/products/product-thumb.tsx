import { useState } from "react"
import { createPortal } from "react-dom"

/** 预览卡片宽度；大图按商品图的方形比例 contain，不裁边。 */
const PREVIEW_WIDTH = 236
/** 卡片总高的估算值（图 + 名称行 + 内边距），只用于视口夹取。 */
const PREVIEW_HEIGHT = 268

/**
 * 商品行缩略图：悬停或键盘聚焦时在右侧浮出大图。
 *
 * 浮层只读（pointer-events-none）并挂在 body 上，避免被表格横向滚动裁剪；
 * 悬停与聚焦走同一条路径。交互约定与 workflow/media/thumb-preview.tsx 一致，
 * 但那边展示的是文件名与扩展名，这里展示商品名——两者独立演进，暂不抽公共组件。
 */
export function ProductThumb({ src, name }: { src: string; name?: string | null }) {
  const [preview, setPreview] = useState<{ x: number; y: number }>()

  function show(event: { currentTarget: HTMLElement }) {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.min(rect.right + 10, window.innerWidth - PREVIEW_WIDTH - 12)
    const y = Math.min(
      Math.max(12, rect.top + rect.height / 2 - PREVIEW_HEIGHT / 2),
      window.innerHeight - PREVIEW_HEIGHT - 12,
    )
    setPreview({ x, y })
  }

  function hide() {
    setPreview(undefined)
  }

  return (
    <>
      <button
        type="button"
        className="group relative size-9 shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted/30 transition-[border-color] duration-150 ease-settle hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-label={name ? `${name} 大图预览` : "商品大图预览"}
      >
        <img
          src={src}
          alt=""
          width={36}
          height={36}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
        />
      </button>
      {preview && typeof document !== "undefined"
        ? createPortal(
            <div
              aria-hidden="true"
              className="pointer-events-none fixed z-[300] overflow-hidden rounded-xl border border-border/90 bg-card p-1.5 shadow-overlay"
              style={{ left: preview.x, top: preview.y, width: PREVIEW_WIDTH }}
            >
              <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-muted/60">
                <img src={src} alt="" decoding="async" className="size-full object-contain" />
              </div>
              {name ? (
                <p className="truncate px-1.5 pt-1.5 pb-0.5 text-meta font-medium" title={name}>
                  {name}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
