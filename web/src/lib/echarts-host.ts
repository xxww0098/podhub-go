import { useEffect, useRef, useState } from "react"
import * as echarts from "echarts/core"

let colorCanvas: HTMLCanvasElement | null = null
let colorCtx: CanvasRenderingContext2D | null = null

export function resolveCssColor(raw: string, fallback: string): string {
  const value = raw.trim()
  if (!value) return fallback
  if (value.startsWith("#") || value.startsWith("rgb(") || value.startsWith("rgba(")) {
    return value
  }
  if (typeof document === "undefined") return fallback
  try {
    if (!colorCanvas) {
      colorCanvas = document.createElement("canvas")
      colorCanvas.width = 1
      colorCanvas.height = 1
      colorCtx = colorCanvas.getContext("2d")
    }
    if (colorCtx) {
      colorCtx.clearRect(0, 0, 1, 1)
      colorCtx.fillStyle = fallback
      colorCtx.fillStyle = value
      colorCtx.fillRect(0, 0, 1, 1)
      const [red, green, blue, alpha] = colorCtx.getImageData(0, 0, 1, 1).data
      if (alpha) {
        return alpha === 255
          ? `rgb(${red}, ${green}, ${blue})`
          : `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`
      }
    }
  } catch {}
  return fallback
}

export function cssColor(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const raw = style.getPropertyValue(name)
  return resolveCssColor(raw, fallback)
}

/** Bumps whenever the root element's class list changes (light/dark switch). */
export function useThemeRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (typeof document === "undefined") return
    const observer = new MutationObserver(() => setRevision((value) => value + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  return revision
}

/**
 * Owns the echarts instance lifecycle: SVG init on mount, resize on host
 * resize, dispose on unmount. Module registration (`echarts.use`) stays with
 * the caller. Attach `hostRef` to the chart container div; `chartRef.current`
 * is the live instance for `setOption` effects.
 */
export function useEchart() {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const chart = echarts.init(host, undefined, { renderer: "svg" })
    chartRef.current = chart
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(host)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  return { hostRef, chartRef }
}
