/** Exact legacy Cloud IO boundaries; no submit handler and no wildcard responses. */
import { route } from "@/api/routes"
import type { EditRowOutput } from "@/listing-core/types"
import { rowStatusView } from "@/features/workflow/model/row-state"
import { patchListingWorkbench } from "@/features/workflow/workbench/listing-workbench-store"
import { listingProjection } from "./listing-row-fixture"
import { workbenchIds, workbenchSchema, type WorkbenchData } from "./publish-pipeline-workbench-fixtures"
import { recordBusiness, recordNative, type BusinessEvent } from "./publish-pipeline-metrics"

export function createWorkbenchMocks() {
  let data: WorkbenchData | undefined, edited: EditRowOutput | undefined, released = false
  let holdNative = false, releaseNative: (() => void) | undefined
  const rowPath = `${route("listingRows")}/${workbenchIds.row}`
  return {
    select(next: WorkbenchData) { data = next; edited = undefined; released = false },
    hold(value: boolean) { holdNative = value },
    release() { releaseNative?.(); releaseNative = undefined },
    async observeEdit(result: EditRowOutput) {
      edited = result
      const original = data?.raw.payload as EditRowOutput["row"] | undefined
      recordNative("brand-native-edit", { fact: result.fact, cleared: result.row.draft.cleared ?? [],
        handEditedKeys: result.row.handEditedKeys, manual: JSON.stringify(result.row.fieldOrigins).toLowerCase().includes("manual"),
        tagsAbsent: !Object.hasOwn(result.row.draft.values, "native_search_tags"),
        mediaPreserved: JSON.stringify(result.row.media) === JSON.stringify(original?.media),
        aiPreserved: JSON.stringify(result.row.ai) === JSON.stringify(original?.ai),
        sourcePreserved: JSON.stringify(result.row.source) === JSON.stringify(original?.source),
        otherFieldsPreserved: !!original && Object.entries(original.draft.values).every(([key, value]) => key === "native_search_tags"
          || JSON.stringify(result.row.draft.values[key]) === JSON.stringify(value)) })
      if (holdNative) { recordNative("brand-native-held", { held: true }); await new Promise<void>((resolve) => { releaseNative = resolve }) }
    },
    async handle(url: URL, method: string, init: RequestInit | undefined,
      base: Pick<BusinessEvent, "request" | "method" | "path" | "requestBytes">): Promise<Response | undefined> {
      if (url.origin !== location.origin) return undefined
      const schema = method === "GET" && url.pathname === route("catalogSchema")
      const row = url.pathname === rowPath && (method === "PATCH" || method === "GET")
      const intents = method === "GET" && url.pathname === route("listingIntents") && url.searchParams.get("storeId") === workbenchIds.store
      const release = method === "POST" && url.pathname === route("listingIntentsReleaseUnknown")
      if (!schema && !row && !intents && !release) return undefined
      const operation = schema ? "schema" : release ? "release" : intents ? "intents" : method === "PATCH" ? "row-patch" : "row-read"
      const ledger = { ...base, operation, category: schema ? "C" : row ? "legacy-row" : "E",
        destination: workbenchIds.store, rowIds: [workbenchIds.row] } satisfies Omit<BusinessEvent, "sequence" | "at" | "event">
      recordBusiness({ ...ledger, event: "dispatch", ...(intents ? { latestPerRow: url.searchParams.get("latestPerRow") === "true", limit: Number(url.searchParams.get("limit")) } : {}) })
      try {
        if (!data) throw new Error("Workbench mock has no seeded Cloud row")
        let response: Response
        if (schema) {
          const expected = new URLSearchParams({ descriptionCategoryId: String(workbenchSchema.description_category_id), typeId: String(workbenchSchema.type_id), language: "default" })
          if (url.searchParams.toString() !== expected.toString()) throw new Error("Unexpected workbench schema coordinate")
          response = Response.json({ data: { description_category_id: workbenchSchema.description_category_id, type_id: workbenchSchema.type_id,
            language: "default", fetched_at_ms: 1, fields: [], nativeMaterial: { snapshot: workbenchSchema, searchMaterials: [] } } })
        } else if (intents) {
          const expected = new URLSearchParams({ storeId: workbenchIds.store, rowIds: data.raw.id, limit: "100", latestPerRow: "true" })
          if (url.searchParams.toString() !== expected.toString()) throw new Error("Intent inspection changed store/row/latest/limit")
          response = Response.json({ data: { items: [{ ...data.intent, ...(released ? { state: "superseded", updatedAtMs: 11 } : {}) }], nextCursor: null } })
        } else if (release) {
          if (url.search || JSON.stringify(JSON.parse(String(init?.body))) !== JSON.stringify({ intentIds: [data.intent.id] })) throw new Error("Release omitted exact original Intent")
          const after = { ...data.intent, state: "superseded", updatedAtMs: 11 }
          delete after.has_live_reconcile_claim; delete after.has_unfinished_dispatch_job
          released = true
          const releasedIntentIds = data.mode === "unknown-missing-id" ? [] : [data.intent.id]
          recordBusiness({ ...ledger, event: "response", status: 200, releasedIntentIds })
          return Response.json({ data: { releasedIntentIds, intents: [after] } })
        } else if (method === "PATCH") {
          const body = JSON.parse(String(init?.body)) as { baseRevision: number; draft: EditRowOutput["row"]["draft"] }
          if (url.search || Object.keys(body).sort().join() !== "baseRevision,draft" || body.baseRevision !== data.raw.revision || !edited
            || JSON.stringify(body.draft) !== JSON.stringify(edited.row.draft)
            || !body.draft.cleared?.includes("native_search_tags") || Object.hasOwn(body.draft.values, "native_search_tags")) throw new Error("CAS PATCH differs from real native clearing")
          const payload = structuredClone(edited.row)
          payload.draft = structuredClone(body.draft)
          data.raw = { ...data.raw, draft: payload.draft, payload: payload as unknown as WorkbenchData["raw"]["payload"],
            revision: body.baseRevision + 1, view_revision: data.raw.view_revision + 1, projection: listingProjection() }
          // Server projection may arrive before PATCH resolves, as in production SSE.
          patchListingWorkbench((state) => ({ productDrafts: { ...state.productBases,
            [data!.raw.id]: { ...state.productBases[data!.raw.id]!, ...rowStatusView(data!.raw) } } }))
          recordBusiness({ ...ledger, event: "response", status: 200, baseRevision: body.baseRevision, revision: data.raw.revision, viewRevision: data.raw.view_revision })
          return Response.json({ data: data.raw })
        } else {
          if (url.search) throw new Error("Unexpected fresh row query")
          if (released && data.mode === "unknown-readback-failed") throw new TypeError("Fixture readback disconnected")
          const fresh = released ? { ...data.raw, viewRevision: data.raw.view_revision + 1,
            submissionState: "none", projection: listingProjection(), updatedAtMs: 11 } : data.raw
          response = Response.json({ data: fresh })
          recordBusiness({ ...ledger, event: "response", status: response.status, revision: fresh.revision, viewRevision: fresh.view_revision,
            contentUnchanged: JSON.stringify(fresh.payload) === JSON.stringify(data.raw.payload) })
          return response
        }
        recordBusiness({ ...ledger, event: "response", status: response.status })
        return response
      } catch (reason) { recordBusiness({ ...ledger, event: "rejection" }); throw reason }
    },
  }
}
