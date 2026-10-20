/** Tab-wide stage capacity. Waiting work holds metadata, not image bytes or a render lane. */
import type { CommandError } from "@/bindings/commands"
import { elapsedMs } from "@/lib/diag-log"
import { renderClient } from "@/render/client"
import { AI_CONCURRENCY } from "../ai-job"
import { JOB_AI, JOB_RENDER, JOB_UPLOAD } from "../execution-context"
import { UPLOAD_CONCURRENCY } from "../media-job"

export const RENDER_ISOLATION_ERROR: CommandError = {
  code: "RENDER_ISOLATION_REQUIRED",
  message: "当前浏览器环境无法切片，请在 Chrome 或 Edge 中打开此页面后重试。",
  remediation: null,
}

/** A slot owns only one stage; waiting rows carry metadata, never image bytes. */
function stagePool(limit: number | (() => number)) {
  let active = 0
  const waiting: Array<() => void> = []
  const cap = () => (typeof limit === "function" ? limit() : limit)
  return async <T>(run: () => Promise<T>, feedback?: { onWait?: () => void, onReady?: (waitedMs: number) => void }): Promise<T> => {
    const queuedAt = performance.now()
    if (active >= cap()) {
      feedback?.onWait?.()
      await new Promise<void>((resolve) => waiting.push(resolve))
      feedback?.onReady?.(elapsedMs(queuedAt))
    }
    else active++
    try { return await run() }
    finally { const next = waiting.shift(); if (next) next(); else active-- }
  }
}

/**
 * AI, render and upload have independent local pools. OCR claims its Cloud
 * lease after local admission; dependent uploads queue after the render slot is
 * released. The render client owns measured wasm residency and its dedicated
 * recognition preprocessing worker. Byte transfers share the browser's upload
 * limit across rows and verbs.
 */

export const planStage = stagePool(4)
const preparationStages: Record<string, ReturnType<typeof stagePool>> = {
  [JOB_AI]: stagePool(AI_CONCURRENCY),
  [JOB_RENDER]: stagePool(() => renderClient.maxLanes),
  [JOB_UPLOAD]: stagePool(UPLOAD_CONCURRENCY),
}

/** Unknown job kinds have no local executor. The pools themselves stay private. */
export function preparationStage(kind: string) {
  return preparationStages[kind]
}
