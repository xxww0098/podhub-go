import { useEffect, useRef } from "react"

export function AlipayQr({ value }: { value: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    void import("qrcode").then((qrcode) => {
      if (cancelled || !canvas.current) return
      void qrcode.toCanvas(canvas.current, value, {
        width: 220,
        margin: 1,
        errorCorrectionLevel: "M",
      })
    })
    return () => {
      cancelled = true
    }
  }, [value])

  return <canvas ref={canvas} className="mx-auto" aria-label="扫码付款码" />
}
