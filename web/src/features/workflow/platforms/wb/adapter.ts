/** WB rules and upload bytes have exactly one owner: listing-core op14. */
import type { WbIssue, WbPreview, WbProductConfig, WbSchemaHandle } from "@/listing-core/wb-types"
import { ListingCoreError } from "@/listing-core/wasm"
import { createSliceBudget, deepFreeze, sha256, type PlatformAdapter, type PlatformIssue, type FrozenItem } from "../core"
import type { WbBuildInput, WbBody } from "./model"
import { capturePublishDiagnostic, type PublishDiagnosticReference } from "../../model/publish-diagnostic"

export type WbPreviewCore = {
  wbPreview(handle: WbSchemaHandle, config: WbProductConfig): WbPreview | Promise<WbPreview>
}
export type WbAdapterIssue = WbIssue | {
  key: { platform: "wb"; stage: "identity"; code: "group_key_invalid" }
  field: "record_id"; characteristicId: null; variantIndex: null; scope: "record"
}
export type WbIssuePresenter = (issue: WbAdapterIssue, recordId: string) => PlatformIssue

/** No parallel solution table: the assembly root supplies the canonical presenter. */
export function createWbAdapter(core: WbPreviewCore, describe: WbIssuePresenter,
  onDiagnostic?: (recordId: string, reference: PublishDiagnosticReference) => void): PlatformAdapter<WbBuildInput, WbBody> {
  return {
    platform: "wb", label: "Wildberries",
    async build(input) {
      // Record identity is a browser concern. No native group is aliased or silently dropped.
      const counts = new Map<string, number>()
      for (const { key } of input.groups) counts.set(key, (counts.get(key) ?? 0) + 1)
      const frozen: FrozenItem<WbBody>[] = []
      const blocked: Array<{ key: string; issues: PlatformIssue[] }> = []
      for (const [key, count] of counts) if (!key.trim() || key.trim() !== key || count > 1) {
        blocked.push({ key, issues: [describe({ key: { platform: "wb", stage: "identity", code: "group_key_invalid" },
          field: "record_id", characteristicId: null, variantIndex: null, scope: "record" }, key)] })
      }
      const refused = new Set(blocked.map((entry) => entry.key))
      const tick = createSliceBudget()
      for (const { key, config } of input.groups) {
        if (refused.has(key)) continue
        let preview: WbPreview
        try { preview = await core.wbPreview(input.material(), config) }
        catch (reason) {
          const interrupted = reason instanceof WebAssembly.RuntimeError || (reason instanceof ListingCoreError && reason.code === "CORE_OOM")
          const detail = await capturePublishDiagnostic({ platform: "wb", stage: "preview", family: "control", code: interrupted ? "wasm_failed" : "contract_invalid" })
          if (detail?.event) {
            try { onDiagnostic?.(key, { eventKey: detail.diagnosticId, diagnosticId: detail.diagnosticId, traceId: detail.event.trace_id }) }
            catch { /* A diagnostic observer cannot replace the actual native failure. */ }
          }
          throw reason
        }
        if (preview.issues.length) {
          blocked.push({ key, issues: preview.issues.map((issue) => describe(issue, key)) })
          for (const issue of preview.issues) {
            const detail = await capturePublishDiagnostic({ ...issue.key, field: issue.field })
            if (detail?.event) {
              try { onDiagnostic?.(key, { eventKey: detail.diagnosticId, diagnosticId: detail.diagnosticId, traceId: detail.event.trace_id }) }
              catch { /* Observation cannot change the native issue or its permitted actions. */ }
            }
          }
        } else {
          if (!preview.group || !preview.uploadBytes) {
            let jsonText: string | null = null
            try { if (preview.uploadBytes) jsonText = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(preview.uploadBytes)) } catch { /* No exact JSON text. */ }
            const detail = await capturePublishDiagnostic({ platform: "wb", stage: "preview", family: "control", code: "contract_invalid" },
              { exactOperation: jsonText === null ? null : { provenance: "native_freeze", jsonText } })
            if (detail?.event) {
              try { onDiagnostic?.(key, { eventKey: detail.diagnosticId, diagnosticId: detail.diagnosticId, traceId: detail.event.trace_id }) }
              catch { /* Read-only observation. */ }
            }
            throw new Error("WB native preview omitted its upload evidence")
          }
          // Hash the native UTF-8 body, never re-encode the group as a new upload.
          const digest = await sha256(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(preview.uploadBytes)))
          frozen.push({ key, body: { group: preview.group, uploadBytes: preview.uploadBytes }, digest,
            clientOperationId: `wb-preview:${key}:${digest}`, provenance: [] })
        }
        await tick()
      }
      return deepFreeze({ frozen, blocked })
    },
  }
}

/** This is a local capability result, never an S16 SendCapability or Intent. */
export const wbSendCapability = Object.freeze({ enabled: false, platform: "wb", stage: "send", code: "not_enabled" } as const)
