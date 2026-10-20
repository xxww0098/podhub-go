import { commandErrorCode, errorMessage } from "@/lib/error-message"
import type { SupplierDbDraft, FieldIssue, MutationResult } from "./supplier-dbs-model"

export function failed(
  reason: unknown,
  fallback: string,
): { ok: false; issues: FieldIssue[]; reason: unknown } {
  return {
    ok: false,
    issues: [{ field: "", message: errorMessage(reason, fallback) }],
    reason,
  }
}

/** 失败结果的报错载荷：原始 reject 优先，退到第一条字段校验消息。 */
export function commandFailure(
  result: Extract<MutationResult<unknown>, { ok: false }>,
): unknown {
  return result.reason ?? result.issues[0]?.message
}

/** Cloud refuses a db delete while rows still reference it (RESTRICT). */
export function deleteDbMessage(reason: unknown): string {
  return commandErrorCode(reason) === "cloud_conflict"
    ? "库里还有行，先清空或下架后再删"
    : errorMessage(reason, "删除平台货源失败")
}

export function validateDbDraft(draft: SupplierDbDraft): FieldIssue[] {
  return draft.name.trim() ? [] : [{ field: "name", message: "请填写库名称" }]
}
