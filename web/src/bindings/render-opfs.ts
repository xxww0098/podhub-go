/**
 * Browser-local render / OPFS execution infrastructure.
 *
 * Preview and ordinary restore talk to Origin Private File System. A verified
 * plan template is recovered by asking Cloud for a short-lived download grant,
 * then reading the object from storage. `web/src/render/opfs.ts` owns the
 * storage layout; delivery and writeback stay in the workflow feature.
 */
import {
  getRender,
  getRenderPreview,
  getSource,
  getSourcePreview,
  getTemplate,
  putKnownTemplate,
  putTemplate,
  sha256Hex,
} from "@/render/opfs"
import { PSD_CONTENT_REFUSAL_COPY, psdFileStructuralRefusal } from "@/render/psd-admission"
import { hashFile } from "./sha256-stream"
import { noteTemplateHandle, rememberTemplateFile } from "./template-file"
import { pickPsdFile, psdTemplateRefusal, stagedFile } from "./file-picker"
import { downloadSupplierTemplate, verifySupplierProductMedia } from "./http-media"
import { downloadCardTemplate } from "./http-templates"
import { refuse } from "./refusal"
import type { WorkflowRestoredProductInstance, WorkflowTemplatePsdAsset } from "./commands"

/** The one URL an operator's browser may hold for a picked local file. */
function objectUrl(bytes: Uint8Array, mime?: string): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
}

/** `{sha256}/{fileName}` — the OPFS source key, carried as the asset handle. */
function splitSourceHandle(handle: string): { sha256: string, fileName: string } {
  const slash = handle.indexOf("/")
  return slash < 0
    ? { sha256: handle, fileName: "" }
    : { sha256: handle.slice(0, slash), fileName: handle.slice(slash + 1) }
}

/**
 * A PSD template, filed under its own digest.
 *
 * There is no managed-asset table in a browser, and the card already stores
 * `psdTemplateSha256` — so the identity the card names and the key OPFS files
 * the bytes under are the same string, and a reload can ask one question
 * ("do I still have it?").
 */
function templatePsdAsset(sha256: string, fileName: string): WorkflowTemplatePsdAsset {
  return {
    asset_id: sha256,
    asset: { handle: sha256, file_name: fileName },
    // The renderer no longer inspects a PSD without rendering it (`rust/crates/render`
    // exposes parse, render and prepare only). Group names reach the workbench
    // on the first render, through the slice `group_name` the media writeback
    // carries.
    summary: {
      handle: sha256,
      file_name: fileName,
      canvas: { width: 0, height: 0, bits_per_channel: 0 },
      features: {
        layers: 0,
        groups: 0,
        smart_objects: 0,
        masks: 0,
        warped_smart_objects: 0,
        blend_modes: {},
      },
      top_groups: [],
      slots: [],
      capabilities: [],
    },
  }
}

async function stageTemplatePsd(
  file: File,
  options?: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void },
): Promise<WorkflowTemplatePsdAsset> {
  const refusal = psdTemplateRefusal(file)
  if (refusal) throw refusal
  // Refuse a structurally unrenderable template before it replaces the
  // card's current binding; the renderer re-checks every template it loads.
  const structural = await psdFileStructuralRefusal(file)
  if (structural) throw refuse(structural, PSD_CONTENT_REFUSAL_COPY[structural])
  let sha256: string
  try {
    sha256 = await hashFile(file, { signal: options?.signal, onProgress: options?.onProgress })
  } catch (reason) {
    if (options?.signal?.aborted || (reason as { name?: string })?.name === "AbortError") {
      throw refuse("workflow_template_cancelled", "未选择 PSD 模板")
    }
    throw reason
  }
  rememberTemplateFile(sha256, file)
  // Overlaps the cloud backup. getTemplate waits if a render needs the bytes first.
  void putKnownTemplate(sha256, file).catch(() => {})
  return templatePsdAsset(sha256, file.name)
}

async function stageSupplierTemplate(
  productId: string,
  sha256: string,
  fileName = "",
): Promise<WorkflowTemplatePsdAsset> {
  const current = await verifySupplierProductMedia(productId)
  if (current.psd_sha256.toLowerCase() !== sha256.toLowerCase()) {
    throw refuse(
      "workflow_template_missing",
      "本机没有该 PSD 模板，请在上架方案重新选择模板文件",
      "此摘要不是平台货源当前的 PSD，不能从平台货源恢复。",
    )
  }
  const actual = await putTemplate(await downloadSupplierTemplate(productId, sha256))
  if (actual !== sha256.toLowerCase()) {
    throw refuse(
      "workflow_template_digest_mismatch",
      "供应商 PSD 内容与云端校验摘要不一致",
      "请联系平台管理员重新校验供应商素材。",
    )
  }
  return templatePsdAsset(actual, fileName)
}

const restores = new Map<string, Promise<WorkflowTemplatePsdAsset>>()

async function restoreTemplate(sha256: string, supplierProductId?: string, cardId?: string) {
  const cached = await getTemplate(sha256)
  if (cached && await sha256Hex(cached) === sha256) return templatePsdAsset(sha256, "")
  if (cardId) {
    const bytes = await downloadCardTemplate(cardId, sha256)
    // Check before writing: a corrupt download must not replace the local cache.
    if (await sha256Hex(bytes) !== sha256) {
      throw refuse("workflow_template_digest_mismatch", "云端 PSD 内容与固定版本摘要不一致，请重试")
    }
    await putTemplate(bytes)
    return templatePsdAsset(sha256, "")
  }
  if (supplierProductId) return stageSupplierTemplate(supplierProductId, sha256)
  throw refuse("workflow_template_missing", "本机没有该 PSD 模板，请从上架方案重新打开或绑定文件")
}

export const renderOpfs = {
  workflowSourcePreview: async (handle: string, edge?: number) => {
    const staged = stagedFile(handle)
    if (staged) return { data_url: URL.createObjectURL(staged) }
    const { sha256, fileName } = splitSourceHandle(handle)
    // With an edge the OPFS worker downscales there and only the thumbnail
    // crosses to this thread; without one the stored bytes come back whole.
    if (edge) {
      const preview = await getSourcePreview(sha256, fileName, edge)
      if (!preview) throw refuse("workflow_source_missing", "本机没有该源图，请重新导入")
      // Source bytes retain their original format; let the browser detect it.
      return { data_url: objectUrl(preview.bytes) }
    }
    const bytes = await getSource(sha256, fileName)
    if (!bytes) throw refuse("workflow_source_missing", "本机没有该源图，请重新导入")
    // Source bytes retain their original format; let the browser detect it.
    return { data_url: objectUrl(bytes) }
  },
  workflowRenderedSlicePreview: async (rowId: string, fileName: string, edge?: number) => {
    if (edge) {
      const preview = await getRenderPreview(rowId, fileName, edge)
      if (!preview) throw refuse("workflow_slice_missing", "本机没有该切片，请重新切片")
      return { data_url: objectUrl(preview.bytes, "image/jpeg"), byte_size: preview.byteSize }
    }
    const bytes = await getRender(rowId, fileName)
    if (!bytes) throw refuse("workflow_slice_missing", "本机没有该切片，请重新切片")
    return { data_url: objectUrl(bytes, "image/jpeg"), byte_size: bytes.length }
  },
  /**
   * Which of these rows still have their source image on *this* device.
   *
   * Purely an OPFS question — the row itself came back with the listing, and
   * asking Cloud again per row would be an N+1 for facts already in hand. No
   * bytes here means no preview and no re-render, which the row has to say
   * rather than silently pretend (`docs/listing-design.md` §3.7).
   */
  workflowRestoreProductInstances: (
    sources: Array<{ draft_id: string, handle: string }>,
  ) =>
    Promise.all(
      sources.map(async ({ draft_id, handle }): Promise<WorkflowRestoredProductInstance> => {
        const { sha256, fileName } = splitSourceHandle(handle)
        const bytes = sha256 ? await getSource(sha256, fileName).catch(() => null) : null
        return {
          draft_id,
          source: bytes ? { handle, file_name: fileName } : undefined,
        }
      }),
    ),
  workflowPickTemplatePsd: async (options?: {
    signal?: AbortSignal
    onFile?: (file: File) => void
    onProgress?: (loaded: number, total: number) => void
  }) => {
    const picked = await pickPsdFile()
    if (!picked.file) throw refuse("workflow_template_cancelled", "未选择 PSD 模板")
    if (picked.handle) noteTemplateHandle(picked.file, picked.handle)
    options?.onFile?.(picked.file)
    return stageTemplatePsd(picked.file, options)
  },
  /**
   * Verify cached bytes; on a miss recover the card's fixed, authorized version.
   * Concurrent calls share one recovery; a rejected call is retried explicitly.
   */
  workflowRestoreTemplatePsd: (sha256: string, supplierProductId?: string, cardId?: string) => {
    const key = `${cardId ?? ""}/${supplierProductId ?? ""}/${sha256}`
    const existing = restores.get(key)
    if (existing) return existing
    const pending = restoreTemplate(sha256, supplierProductId, cardId)
      .finally(() => { if (restores.get(key) === pending) restores.delete(key) })
    restores.set(key, pending)
    return pending
  },
  workflowStageSupplierTemplate: stageSupplierTemplate,
}
