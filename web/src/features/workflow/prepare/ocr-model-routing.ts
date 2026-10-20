import { useEffect, useState } from "react"
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type { WorkflowRowsActionRequest } from "@/bindings/commands"
import { notifyCommandError } from "@/lib/notify"

export type OcrModelRouting = components["schemas"]["OcrModelRouting"]
export type PreparationRequest = WorkflowRowsActionRequest & { modelRouting?: OcrModelRouting }
export type OcrCatalogue = components["schemas"]["AiPricesData"]

let latestCatalogue: OcrCatalogue | undefined

/** Last prices payload this tab loaded. Task creation reads it to pin 系统默认. */
export function peekOcrCatalogue(): OcrCatalogue | undefined {
  return latestCatalogue
}

export function rememberOcrCatalogue(value: OcrCatalogue | undefined): void {
  latestCatalogue = value
}

/** Read once per mounted task; no upstream probing or credentials in the browser. */
export function useOcrCatalogue() {
  const [data, setData] = useState<OcrCatalogue>()
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setLoading(true)
    void api.get<OcrCatalogue>(route("aiPrices")).then(value => {
      if (!current) return
      rememberOcrCatalogue(value)
      setData(value)
    }).catch(reason => {
      if (current) notifyCommandError(reason, "无法读取识图模型，请重试。")
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [attempt])
  return { data, loading, retry: () => setAttempt(value => value + 1) }
}
