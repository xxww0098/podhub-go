/** Database and property writes reconcile through the store's session fence. */
import type { SupplierDb, SupplierDbDetail, SupplierDbPropDef, UpsertSupplierDbRequest, UpsertSupplierDbPropRequest } from "@/bindings/http-supplier-dbs"
import { dbToUpsert, type SupplierDbsClient, type SupplierDbsState, type SupplierDbsStore, type SupplierDbDraft, type MutationResult } from "./supplier-dbs-model"
import { failed, deleteDbMessage, validateDbDraft } from "./supplier-dbs-errors"

export function databaseCommands({ client, getState, generation, applyDb, emit, applyDetail, draftBody, savePropImpl, reorderPropsImpl }: {
  client: SupplierDbsClient
  getState: () => SupplierDbsState
  generation: () => number
  applyDb: (db: SupplierDb) => void
  emit: (state: SupplierDbsState) => void
  applyDetail: (sourceId: string, patch: (detail: SupplierDbDetail) => SupplierDbDetail) => void
  draftBody: (draft: SupplierDbDraft) => UpsertSupplierDbRequest
  savePropImpl: (sourceId: string, request: UpsertSupplierDbPropRequest, propId?: string) => Promise<MutationResult<SupplierDbPropDef>>
  reorderPropsImpl: (sourceId: string, propIds: string[]) => Promise<MutationResult<void>>
}): Pick<SupplierDbsStore, "createDb" | "updateDb" | "deleteDb" | "saveProp" | "createProp" | "updateProp" | "insertPropAt" | "reorderProps" | "deleteProp"> {
  return {
    createDb: async (draft) => {
      const issues = validateDbDraft(draft)
      const email = draft.accountEmail?.trim() ?? ""
      if (!email || !email.includes("@")) {
        issues.push({ field: "accountEmail", message: "请填写厂家登录邮箱" })
      }
      if (issues.length) return { ok: false, issues }
      const stamp = generation()
      try {
        const data = await client.supplierDbCreate(draftBody(draft))
        if (stamp === generation()) applyDb(data.db)
        return {
          ok: true,
          value: data.db,
          initialPassword: data.initialPassword || undefined,
        }
      } catch (reason) {
        return failed(reason, "创建平台货源失败")
      }
    },
    updateDb: async (sourceId, patch) => {
      const current =
        getState().details[sourceId]?.detail?.db ??
        getState().dbs.find((row) => row.sourceId === sourceId)
      if (!current) {
        return { ok: false, issues: [{ field: "", message: "平台货源不存在" }] }
      }
      const merged = { ...dbToUpsert(current), ...patch }
      const body: UpsertSupplierDbRequest = {
        ...merged,
        name: merged.name.trim(),
        country: merged.country.trim().toUpperCase(),
        contact: merged.contact.trim(),
        internalNote: merged.internalNote.trim(),
        icon: merged.icon.trim(),
      }
      const issues = body.name ? [] : [{ field: "name", message: "请填写库名称" }]
      if (patch.accountEmail !== undefined) {
        const email = patch.accountEmail.trim().toLowerCase()
        const currentEmail = (current.accountEmail ?? "").trim().toLowerCase()
        if (email !== currentEmail) {
          if (!email.includes("@")) {
            issues.push({ field: "accountEmail", message: "请填写厂家登录邮箱" })
          } else {
            body.accountEmail = email
          }
        } else {
          delete body.accountEmail
        }
      }
      if (issues.length) return { ok: false, issues }
      const stamp = generation()
      try {
        const data = await client.supplierDbUpdate(sourceId, body)
        if (stamp === generation()) applyDb(data.db)
        return {
          ok: true,
          value: data.db,
          initialPassword: data.initialPassword || undefined,
        }
      } catch (reason) {
        return failed(reason, "保存平台货源失败")
      }
    },
    deleteDb: async (sourceId) => {
      const stamp = generation()
      try {
        await client.supplierDbDelete(sourceId)
        if (stamp === generation()) {
          const details = { ...getState().details }
          delete details[sourceId]
          emit({
            ...getState(),
            dbs: getState().dbs.filter((row) => row.sourceId !== sourceId),
            details,
          })
        }
        return { ok: true, value: undefined }
      } catch (reason) {
        return {
          ok: false,
          issues: [{ field: "", message: deleteDbMessage(reason) }],
          reason,
        }
      }
    },
    saveProp: savePropImpl,
    createProp: async (sourceId, request) => savePropImpl(sourceId, request),
    updateProp: async (sourceId, propId, request) =>
      savePropImpl(sourceId, request, propId),
    insertPropAt: async (sourceId, request, index) => {
      const stamp = generation()
      const created = await savePropImpl(sourceId, { ...request, position: index })
      if (!created.ok) return created
      if (stamp !== generation()) return failed("会话已变化，请重新打开库", "插入已取消")
      const detail = getState().details[sourceId]?.detail
      if (!detail) return created
      const others = [...detail.propDefs]
        .sort((a, b) => a.position - b.position)
        .map((def) => def.propId)
        .filter((id) => id !== created.value.propId)
      const ordered = [
        ...others.slice(0, index),
        created.value.propId,
        ...others.slice(index),
      ]
      const reordered = await reorderPropsImpl(sourceId, ordered)
      return reordered.ok ? created : reordered
    },
    reorderProps: reorderPropsImpl,
    deleteProp: async (sourceId, propId) => {
      const stamp = generation()
      try {
        const result = await client.supplierDbPropDelete(sourceId, propId)
        if (stamp === generation()) {
          applyDetail(sourceId, (detail) => ({
            ...detail,
            propDefs: detail.propDefs.filter((item) => item.propId !== propId),
          }))
        }
        return { ok: true, value: result }
      } catch (reason) {
        return failed(reason, "删除属性失败")
      }
    },
  }
}
