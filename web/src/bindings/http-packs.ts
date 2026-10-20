/**
 * Field Pack HTTP wire.
 *
 * Screens import `packsHttp` directly.
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type {
  FieldPackIdRequest,
  FieldPackListRequest,
  FieldPackSaveRequest,
  FieldPackShareRequest,
  FieldPackView,
  WorkflowCategoryDraft,
} from "./commands"

type CloudFieldPackView = components["schemas"]["FieldPackView"]

/** `library_id` is nullable on the wire and absent in the renderer's view. */
function fieldPackView(pack: CloudFieldPackView): FieldPackView {
  return { ...pack, library_id: pack.library_id ?? undefined }
}

/** The Field Library body vocabulary: a Pack is a Draft under a coordinate. */
function fieldLibraryBody(draft: WorkflowCategoryDraft): unknown {
  return {
    values: draft.values,
    complex_values: draft.complex_values,
    ...(draft.cleared?.length ? { cleared: draft.cleared } : {}),
  }
}

export const packsHttp = {
  fieldPackList: async (request: FieldPackListRequest) =>
    (
      await api.get<components["schemas"]["FieldPackListData"]>(
        `${route("fieldPacks")}?descriptionCategoryId=${request.description_category_id}` +
          `&typeId=${request.type_id}&language=${request.language ?? "default"}`,
      )
    ).packs.map(fieldPackView),
  fieldPackSaveFromCard: async (request: FieldPackSaveRequest) =>
    fieldPackView(await api.post<CloudFieldPackView>(route("fieldPacks"), {
      name: request.name,
      coordinate: {
        description_category_id: request.schema.description_category_id,
        type_id: request.schema.type_id,
        language: request.language ?? request.schema.language ?? "default",
      },
      draft: fieldLibraryBody(request.draft),
    })),
  fieldPackSetActive: async (request: FieldPackIdRequest) =>
    fieldPackView(
      await api.patch<CloudFieldPackView>(
        route("fieldPacksById", { id: request.pack_id }),
        { active: true },
      ),
    ),
  fieldPackSetShared: async (request: FieldPackShareRequest) =>
    fieldPackView(
      await api.post<CloudFieldPackView>(
        route("fieldPacksByIdShare", { id: request.pack_id }),
        { shared: request.shared },
      ),
    ),
  fieldPackDelete: async (request: FieldPackIdRequest) => {
    await api.del<{ ok: boolean }>(
      route("fieldPacksById", { id: request.pack_id }),
    )
  },
}
