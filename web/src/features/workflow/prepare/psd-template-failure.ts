import { errorMessage } from "@/lib/error-message"
import type { ListingRow } from "../model/listing-row"

/**
 * Why the current slicing attempt could not reach its PSD template.
 *
 * - `template_unbound`: the card binds no PSD template.
 * - `supplier_template_unbound`: a supplier card whose online product resolves
 *   no unique template.
 * - `template_restore_failed`: a template is bound, but restoring or verifying
 *   its bytes for this attempt failed.
 *
 * None of these is a source-image fact: the row's own source handle is never
 * touched, so a template failure can not read as a missing source.
 */
export type PsdTemplateFailureCause =
  | "template_unbound"
  | "supplier_template_unbound"
  | "template_restore_failed"

export type PsdTemplateFailure = {
  cause: PsdTemplateFailureCause
  /** Operator copy for this cause; a restore failure keeps Cloud's own words. */
  message: string
  /** Start of the slicing attempt this failure belongs to. */
  attemptSinceMs: number
}

const CAUSE_COPY: Record<Exclude<PsdTemplateFailureCause, "template_restore_failed">, string> = {
  template_unbound: "请先在建卡页配置 PSD 模板。",
  supplier_template_unbound: "请在在线商库配置唯一的 PSD 模板。",
}

export function psdTemplateFailure(
  cause: PsdTemplateFailureCause,
  attemptSinceMs: number,
  reason?: unknown,
): PsdTemplateFailure {
  const message = cause === "template_restore_failed"
    ? errorMessage(reason, "当前切片无法恢复 PSD 模板；请检查原模板绑定和本机文件权限后重试切片")
    : CAUSE_COPY[cause]
  return { cause, message, attemptSinceMs }
}

/**
 * The row facts one template failure writes. The failure lands as the render
 * leg's own progress entry stamped with its attempt, so the publish cell names
 * this attempt's cause; the next slicing attempt's start patch clears it, and a
 * completed render hides it (`visiblePreparationProgress`).
 */
export function psdTemplateFailurePatch(failure: PsdTemplateFailure): Partial<ListingRow> {
  return {
    psdTemplateFailure: failure,
    status: "failed",
    render: "failed",
    // Without a template nothing was sliced, so nothing is waiting to upload.
    // A restore failure keeps the upload leg as it stood, as it always has.
    ...(failure.cause === "template_restore_failed" ? {} : { upload: "idle" as const }),
    log: failure.message,
    preparationRender: {
      stage: "render",
      state: "failed",
      message: failure.message,
      since_ms: failure.attemptSinceMs,
    },
  }
}
