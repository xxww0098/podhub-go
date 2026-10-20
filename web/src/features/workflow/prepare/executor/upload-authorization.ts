/** One shared authorization promise per preparation batch, including concurrent rejection recovery. */
import { createMediaUploadBatch, currentMediaWorkspaceUuid, type MediaUploadBatch } from "../../media/media-objects"
import type { MediaExecution, RowBatch } from "../execution-context"

export async function authorizeBatchUpload(batch: RowBatch | undefined, execution: MediaExecution, rejectedBatch?: string): Promise<MediaUploadBatch> {
  execution.assertCurrent()
  const current = batch?.uploadBatch
  if (current) {
    try {
      const issued = await current
      if (!rejectedBatch || issued.uploadBatch !== rejectedBatch) return issued
      // A concurrent row may already have replaced this rejected batch.
      if (batch?.uploadBatch === current) batch.uploadBatch = undefined
      else if (batch?.uploadBatch) return await batch.uploadBatch
    }
    catch (reason) {
      if (batch?.uploadBatch === current) batch.uploadBatch = undefined
      throw reason
    }
  }
  execution.assertCurrent()
  const workspaceUuid = currentMediaWorkspaceUuid()
  if (!workspaceUuid) throw Object.assign(new Error("当前没有可用的 Workspace"), { code: "workflow_workspace_missing" })
  const next = createMediaUploadBatch(workspaceUuid)
  if (batch) batch.uploadBatch = next
  try { return await next }
  catch (reason) {
    if (batch?.uploadBatch === next) batch.uploadBatch = undefined
    throw reason
  }
}
