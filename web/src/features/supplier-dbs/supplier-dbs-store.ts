/** Supplier database session cache, detail reconciliation and row CAS writes. */
import { useSyncExternalStore } from "react"
import { supplierDbsHttp, type SupplierDb, type SupplierDbDetail, type SupplierDbRow, type SupplierDbPropDef, type UpsertSupplierDbRequest, type UpsertSupplierDbPropRequest, type UpsertSupplierDbRowRequest } from "@/bindings/http-supplier-dbs"
import { errorMessage } from "@/lib/error-message"
import { createSessionCache } from "@/lib/session-cache"
import { copySupplierOzonConfig, supplierOzonConfigIO, type SupplierOzonConfigIO } from "./supplier-ozon-config"
import { EMPTY_ROW_REQUEST, rowToUpsert, propToUpsert, type SupplierDbsClient, type SupplierDbsState, type SupplierDbsStore, type SupplierDbDetailState, type SupplierDbDraft, type MutationResult } from "./supplier-dbs-model"
import { failed } from "./supplier-dbs-errors"
import { bindSupplierDbsAuthority } from "./supplier-dbs-authority"
import { databaseCommands } from "./supplier-dbs-database-commands"
export { EMPTY_DB_DRAFT, EMPTY_ROW_REQUEST } from "./supplier-dbs-model"
export type { SupplierDbsClient, SupplierDbsStore, SupplierDbsState, SupplierDbDetailState, SupplierDbDraft, MutationResult } from "./supplier-dbs-model"

const IDLE: SupplierDbsState = { status: "idle", dbs: [], details: {}, pendingRows: [] }

export function createSupplierDbsStore(
  client: SupplierDbsClient,
  configIO: SupplierOzonConfigIO = supplierOzonConfigIO,
): SupplierDbsStore {
  let state: SupplierDbsState = IDLE
  let sessionGeneration = 0
  const listeners = new Set<() => void>()
  const detailInFlight = new Map<string, Promise<void>>()
  /** Refcount per productId — two overlapping cell writes keep the row grey. */
  const pendingCount = new Map<string, number>()
  /**
   * Per-row write chain: CAS reads `row.revision` at call time, so two cell
   * commits racing one PUT would collide on the user's *own* edit. Chaining
   * makes each write re-read the reconciled row first.
   */
  const rowWriteChains = new Map<string, Promise<unknown>>()

  const emit = (next: SupplierDbsState) => {
    state = next
    for (const listener of listeners) listener()
  }

  const session = createSessionCache<SupplierDbsState>(
    async () => {
      try {
        const data = await client.supplierDbsList()
        return { ...state, status: "ready", error: undefined, reason: undefined, dbs: data.dbs }
      } catch (reason) {
        return {
          ...state,
          status: "error",
          error: errorMessage(reason, "无法读取平台货源"),
          reason,
        }
      }
    },
    {
      commit: ({ next, write }) => {
        write(next)
        emit(next)
      },
    },
  )
  // Sign-out empties the session cache; every cached detail goes with it.
  session.subscribe(() => {
    if (session.peek("") !== undefined) return
    sessionGeneration += 1
    detailInFlight.clear()
    pendingCount.clear()
    rowWriteChains.clear()
    emit(IDLE)
  })

  const detailState = (sourceId: string): SupplierDbDetailState =>
    state.details[sourceId] ?? { status: "idle" }

  const emitDetail = (sourceId: string, next: SupplierDbDetailState) => {
    emit({ ...state, details: { ...state.details, [sourceId]: next } })
  }

  const applyDb = (db: SupplierDb) => {
    const known = state.dbs.some((row) => row.sourceId === db.sourceId)
    emit({
      ...state,
      dbs: known
        ? state.dbs.map((row) => (row.sourceId === db.sourceId ? db : row))
        : [...state.dbs, db],
      details: state.details[db.sourceId]?.detail
        ? {
            ...state.details,
            [db.sourceId]: {
              ...state.details[db.sourceId],
              detail: { ...state.details[db.sourceId].detail!, db },
            },
          }
        : state.details,
    })
  }

  const applyDetail = (sourceId: string, patch: (detail: SupplierDbDetail) => SupplierDbDetail) => {
    const current = state.details[sourceId]?.detail
    if (!current) return
    emitDetail(sourceId, { status: "ready", detail: patch(current) })
  }

  const applyRow = (sourceId: string, row: SupplierDbRow, created: boolean) => {
    applyDetail(sourceId, (detail) => {
      const known = detail.rows.some((item) => item.productId === row.productId)
      const rows = known
        ? detail.rows.map((item) => (item.productId === row.productId ? row : item))
        : [...detail.rows, row]
      const previous = detail.rows.find((item) => item.productId === row.productId)
      const publishedDelta =
        (row.published ? 1 : 0) - (previous?.published ? 1 : 0)
      // 归档即离开默认表格（NOT archived 口径），rowCount 跟随表视图计数。
      const archivedDelta = (row.archived ? 1 : 0) - (previous?.archived ? 1 : 0)
      const db = {
        ...detail.db,
        rowCount: Math.max(
          0,
          detail.db.rowCount + (created ? 1 : 0) - archivedDelta,
        ),
        publishedCount: Math.max(0, detail.db.publishedCount + publishedDelta),
        updatedAtMs: row.updatedAtMs,
      }
      applyDb(db)
      return { ...detail, db, rows }
    })
  }

  const dropRow = (sourceId: string, productId: string) => {
    applyDetail(sourceId, (detail) => {
      const removed = detail.rows.find((item) => item.productId === productId)
      const db = {
        ...detail.db,
        rowCount: Math.max(0, detail.db.rowCount - (removed ? 1 : 0)),
        publishedCount: Math.max(
          0,
          detail.db.publishedCount - (removed?.published ? 1 : 0),
        ),
      }
      applyDb(db)
      return {
        ...detail,
        db,
        rows: detail.rows.filter((item) => item.productId !== productId),
      }
    })
  }

  const applyProp = (prop: SupplierDbPropDef) => {
    applyDetail(prop.sourceId, (detail) => {
      const known = detail.propDefs.some((item) => item.propId === prop.propId)
      return {
        ...detail,
        propDefs: known
          ? detail.propDefs.map((item) => (item.propId === prop.propId ? prop : item))
          : [...detail.propDefs, prop].sort((a, b) => a.position - b.position),
      }
    })
  }

  const rowPending = (productId: string, delta: 1 | -1) => {
    const next = (pendingCount.get(productId) ?? 0) + delta
    if (next <= 0) pendingCount.delete(productId)
    else pendingCount.set(productId, next)
    emit({ ...state, pendingRows: [...pendingCount.keys()] })
  }

  /** Row writes funnel here so the table greys the row while a save flies. */
  const withRowPending = async <T>(
    productId: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const generation = sessionGeneration
    rowPending(productId, 1)
    try {
      return await run()
    } finally {
      if (generation === sessionGeneration) rowPending(productId, -1)
    }
  }

  /** Every row-mutating op (save, patch, archive, delete, publish, price)
   * rides the per-row chain: a click whose CAS runs beside the user's own
   * in-flight edit would 409 against itself. */
  const queueRowWrite = <T>(productId: string, run: () => Promise<MutationResult<T>>): Promise<MutationResult<T>> => {
    const generation = sessionGeneration
    rowPending(productId, 1)
    const previous = rowWriteChains.get(productId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(() => generation === sessionGeneration ? run() : failed("会话已变化，请重新打开商品", "保存已取消"))
    rowWriteChains.set(productId, next as Promise<unknown>)
    const settle = () => {
      if (generation !== sessionGeneration) return
      rowPending(productId, -1)
      if (rowWriteChains.get(productId) === next) rowWriteChains.delete(productId)
    }
    void next.then(settle, settle)
    return next
  }

  const draftBody = (draft: SupplierDbDraft): UpsertSupplierDbRequest => ({
    name: draft.name.trim(),
    country: draft.country.trim().toUpperCase(),
    contact: draft.contact.trim(),
    internalNote: draft.internalNote.trim(),
    listed: draft.listed,
    icon: draft.icon.trim(),
    template: draft.template ?? null,
    ...(draft.acceptsDelegate === undefined
      ? {}
      : { acceptsDelegate: draft.acceptsDelegate }),
    ...(draft.accountEmail?.trim()
      ? { accountEmail: draft.accountEmail.trim().toLowerCase() }
      : {}),
  })

  const savePropImpl = async (
    sourceId: string,
    request: UpsertSupplierDbPropRequest,
    propId?: string,
  ): Promise<MutationResult<SupplierDbPropDef>> => {
    const generation = sessionGeneration
    try {
      const data = propId
        ? await client.supplierDbPropUpdate(sourceId, propId, request)
        : await client.supplierDbPropCreate(sourceId, request)
      if (generation === sessionGeneration) applyProp(data.prop)
      return { ok: true, value: data.prop }
    } catch (reason) {
      return failed(reason, "保存属性失败")
    }
  }

  const reorderPropsImpl = async (
    sourceId: string,
    propIds: string[],
  ): Promise<MutationResult<void>> => {
    const detail = state.details[sourceId]?.detail
    if (!detail) {
      return { ok: false, issues: [{ field: "", message: "平台货源尚未加载" }] }
    }
    const defsById = new Map(detail.propDefs.map((def) => [def.propId, def]))
    const generation = sessionGeneration
    try {
      for (const [index, propId] of propIds.entries()) {
        if (generation !== sessionGeneration) return failed("会话已变化，请重新打开库", "调整已取消")
        const def = defsById.get(propId)
        if (!def || def.position === index) continue
        const data = await client.supplierDbPropUpdate(sourceId, propId, {
          ...propToUpsert(def),
          position: index,
        })
        if (generation === sessionGeneration) applyProp(data.prop)
      }
      return { ok: true, value: undefined }
    } catch (reason) {
      return failed(reason, "调整属性顺序失败")
    }
  }

  /** The one row write: merge patch → whole-row PUT → CAS → reconcile. */
  const writeRowImpl = (
    sourceId: string,
    productId: string,
    patch: Partial<UpsertSupplierDbRowRequest>,
  ): Promise<MutationResult<SupplierDbRow>> =>
    queueRowWrite(productId, () => writeRowOnce(sourceId, productId, patch))

  const writeRowOnce = async (
    sourceId: string,
    productId: string,
    patch: Partial<UpsertSupplierDbRowRequest>,
  ): Promise<MutationResult<SupplierDbRow>> => {
    const row = state.details[sourceId]?.detail?.rows.find(
      (item) => item.productId === productId,
    )
    if (!row) {
      return { ok: false, issues: [{ field: "", message: "行不存在或尚未加载" }] }
    }
    const generation = sessionGeneration
    return withRowPending(productId, async () => {
      try {
        const data = await client.supplierDbRowUpdate(sourceId, productId, {
          ...rowToUpsert(row),
          ...patch,
          expectedRevision: row.revision,
        })
        if (generation === sessionGeneration) applyRow(sourceId, data.row, false)
        return { ok: true, value: data.row }
      } catch (reason) {
        return failed(reason, "保存行失败")
      }
    })
  }

  return {
    reset: () => session.invalidate(),
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    loadList: async () => {
      emit({ ...state, status: "loading", error: undefined, reason: undefined })
      await session.load("")
    },
    loadDetail: async (sourceId, options) => {
      const current = detailState(sourceId)
      if (
        !options?.force &&
        (current.status === "ready" || current.status === "loading")
      ) {
        return
      }
      const generation = sessionGeneration
      emitDetail(sourceId, { status: "loading", detail: current.detail })
      const request = client
        .supplierDbGet(sourceId)
        .then((detail) => {
          if (generation === sessionGeneration) {
            emitDetail(sourceId, { status: "ready", detail })
          }
        })
        .catch((reason: unknown) => {
          if (generation === sessionGeneration) {
            emitDetail(sourceId, {
              status: "error",
              detail: current.detail,
              error: errorMessage(reason, "无法读取平台货源"),
              reason,
            })
          }
        })
      detailInFlight.set(sourceId, request)
      try {
        await request
      } finally {
        if (detailInFlight.get(sourceId) === request) detailInFlight.delete(sourceId)
      }
    },
    ...databaseCommands({ client, getState: () => state, generation: () => sessionGeneration, applyDb, emit, applyDetail, draftBody, savePropImpl, reorderPropsImpl }),
    createRow: async (sourceId, initial) => {
      const generation = sessionGeneration
      try {
        const data = await client.supplierDbRowCreate(sourceId, { ...EMPTY_ROW_REQUEST, ...initial })
        if (generation === sessionGeneration) applyRow(sourceId, data.row, true)
        return { ok: true, value: data.row }
      } catch (reason) {
        return failed(reason, "新建行失败")
      }
    },
    updateRow: writeRowImpl,
    patchCell: writeRowImpl,
    duplicateRow: async (sourceId, productId) => {
      const row = state.details[sourceId]?.detail?.rows.find(
        (item) => item.productId === productId,
      )
      if (!row) {
        return { ok: false, issues: [{ field: "", message: "行不存在或尚未加载" }] }
      }
      const generation = sessionGeneration
      try {
        const data = await client.supplierDbRowCreate(sourceId, {
          ...rowToUpsert(row),
          title: `${row.title.trim() || "未命名"} 副本`,
          variantGroup: "",
          // platform_code is 全库唯一 — suffix it so the copy does not collide.
          platformCode: row.platformCode ? `${row.platformCode}-副本` : "",
          expectedRevision: null,
        })
        if (generation === sessionGeneration) applyRow(sourceId, data.row, true)
        if (generation !== sessionGeneration) return failed("会话已变化，请重新打开商品", "复制已取消")
        if (row.descriptionCategoryId == null || row.typeId == null) {
          return { ok: true, value: { row: data.row } }
        }
        try {
          await copySupplierOzonConfig(configIO, sourceId, productId, data.row.productId, {
            description_category_id: row.descriptionCategoryId,
            type_id: row.typeId,
          })
          return { ok: true, value: { row: data.row } }
        } catch (configCopyError) {
          return { ok: true, value: { row: data.row, configCopyError } }
        }
      } catch (reason) {
        return failed(reason, "复制行失败")
      }
    },
    archiveRow: async (sourceId, productId) => {
      const row = state.details[sourceId]?.detail?.rows.find(
        (item) => item.productId === productId,
      )
      if (!row) {
        return { ok: false, issues: [{ field: "", message: "行不存在或尚未加载" }] }
      }
      const generation = sessionGeneration
      return queueRowWrite(productId, async () => {
        try {
          const body: UpsertSupplierDbRowRequest = {
            ...rowToUpsert(row),
            archived: true,
            expectedRevision: row.revision,
          }
          const data = await client.supplierDbRowUpdate(sourceId, productId, body)
          const next = data.row.archived ? data.row : { ...data.row, archived: true }
          if (generation === sessionGeneration) applyRow(sourceId, next, false)
          return { ok: true, value: next }
        } catch (reason) {
          return failed(reason, "归档行失败")
        }
      })
    },
    deleteRow: async (sourceId, productId) => {
      const generation = sessionGeneration
      return queueRowWrite(productId, async () => {
        try {
          await client.supplierDbRowDelete(sourceId, productId)
          if (generation === sessionGeneration) dropRow(sourceId, productId)
          return { ok: true, value: undefined }
        } catch (reason) {
          return failed(reason, "删除行失败")
        }
      })
    },
    publishRow: async (sourceId, productId) => {
      const generation = sessionGeneration
      return queueRowWrite(productId, async () => {
        try {
          const data = await client.supplierDbRowPublish(sourceId, productId)
          if (generation === sessionGeneration) applyRow(sourceId, data.row, false)
          return { ok: true, value: data.row }
        } catch (reason) {
          return failed(reason, "上架失败")
        }
      })
    },
    unpublishRow: async (sourceId, productId) => {
      const generation = sessionGeneration
      return queueRowWrite(productId, async () => {
        try {
          const data = await client.supplierDbRowUnpublish(sourceId, productId)
          if (generation === sessionGeneration) applyRow(sourceId, data.row, false)
          return { ok: true, value: data.row }
        } catch (reason) {
          return failed(reason, "下架失败")
        }
      })
    },
    adjustPrice: async (sourceId, productId, priceCents, note) => {
      const generation = sessionGeneration
      return queueRowWrite(productId, async () => {
        try {
          const data = await client.supplierDbRowAdjustPrice(sourceId, productId, {
            priceCents,
            note,
          })
          if (generation === sessionGeneration) applyRow(sourceId, data.row, false)
          return { ok: true, value: data.row }
        } catch (reason) {
          return failed(reason, "调价失败")
        }
      })
    },
    presignUpload: async (sourceId, request) => {
      try {
        const data = await client.supplierDbUploadPresign(sourceId, request)
        return { ok: true, value: data.upload }
      } catch (reason) {
        return failed(reason, "无法创建上传")
      }
    },
  }
}

/** Production store: the generated command object is the client. */
export const supplierDbs = createSupplierDbsStore(supplierDbsHttp)
bindSupplierDbsAuthority(supplierDbs)

export function useSupplierDbsStore(store: SupplierDbsStore): SupplierDbsState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
