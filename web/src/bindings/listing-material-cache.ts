/**
 * One session cache record per category coordinate: the schema view the
 * screens read and the native material `schema_load` takes, from the same
 * `GET /api/catalog/schema` reply, so the two can never drift apart.
 *
 * `nativeMaterial` is Cloud's own snapshot plus the Seller-confirmed search
 * bag native validation reads (`src/listing/catalog/listing_material.rs`).
 * `schema_revision` names the fields only; search hits keep growing, so a
 * resident material's `signature` is coordinate + revision + digest of its
 * hits, and any change yields a new signature for the WASM handle to follow.
 *
 * Built on `createSessionCache`: identity/Workspace switches
 * (`invalidateAllSessionCaches`) clear every record and fence replies that
 * were in flight, so a reply born before a switch never repopulates it.
 * Local material is never authoritative — Cloud rebuilds its own on send.
 */
import { api } from "@/api/client"
import { retryWhenBusy } from "@/api/busy-retry"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type { CategorySchemaSnapshot, SchemaLoadInput, SearchMaterialEntry } from "@/listing-core/types"
import { createSessionCache } from "@/lib/session-cache"
import { positiveId } from "@/lib/utils"
import type { CategorySchemaView, WorkflowLanguage } from "./commands"
import { catalogSchemaView } from "./listing-projection"
import { refuse } from "./refusal"

export type CategoryCoordinate = {
  descriptionCategoryId: number
  typeId: number
  language?: WorkflowLanguage
}

export type NativeSchemaMaterial = {
  input: Required<SchemaLoadInput>
  /** `{category}:{type}|{schema_revision}#{sha256 of searchMaterials}`: the WASM handle key. */
  signature: string
}

export type CategorySchemaEntry = { view: CategorySchemaView, material?: NativeSchemaMaterial }

// ponytail: local read of the additive field until the parent regenerates `schema.d.ts`.
type ServedSchemaData = components["schemas"]["CatalogSchemaData"] & {
  nativeMaterial?: { snapshot: CategorySchemaSnapshot, searchMaterials: SearchMaterialEntry[] }
}

/** A live fill may run up to the router's 30 s timeout; outwait it, not more. */
export const CATALOG_FILL_RETRY = { attempts: 15, maxWaitMs: 45_000 }

const LANGUAGES = new Set<string>(["default", "ru", "en", "tr", "zh_hans"])

/** Refuses a coordinate Cloud would 400 on, before any round trip. */
function coordinateKey(coordinate: CategoryCoordinate): string {
  const language = coordinate.language ?? "default"
  if (!positiveId(coordinate.descriptionCategoryId) || !positiveId(coordinate.typeId) || !LANGUAGES.has(language)) {
    throw refuse("workflow_category_coordinate_invalid", "类目坐标无效", "请重新选择商品类目后重试")
  }
  return `${coordinate.descriptionCategoryId}:${coordinate.typeId}:${language}`
}

function compareEntries(left: SearchMaterialEntry, right: SearchMaterialEntry): number {
  return left.descriptionCategoryId - right.descriptionCategoryId ||
    left.attributeId - right.attributeId ||
    left.dictionaryId - right.dictionaryId ||
    left.valueId - right.valueId
}

async function nativeMaterial(
  snapshot: CategorySchemaSnapshot,
  entries: readonly SearchMaterialEntry[],
): Promise<NativeSchemaMaterial> {
  // Same order as the server's BTreeMap, so equal bags digest equally.
  const searchMaterials = [...entries].sort(compareEntries)
  const bytes = new TextEncoder().encode(JSON.stringify(searchMaterials))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return { input: { snapshot, searchMaterials }, signature: `${snapshot.description_category_id}:${snapshot.type_id}|${snapshot.schema_revision}#${hex}` }
}

/** Untrusted reply: a material for another coordinate or without a revision is absent, not empty. */
function servedMaterial(key: string, data: ServedSchemaData): Promise<NativeSchemaMaterial> | undefined {
  const native = data.nativeMaterial
  const snapshot = native?.snapshot
  if (
    !snapshot ||
    !Array.isArray(native.searchMaterials) ||
    typeof snapshot.schema_revision !== "string" ||
    snapshot.schema_revision === "" ||
    `${snapshot.description_category_id}:${snapshot.type_id}` !== key.split(":").slice(0, 2).join(":")
  ) {
    return undefined
  }
  return nativeMaterial(snapshot, native.searchMaterials)
}

async function fetchEntry(key: string): Promise<CategorySchemaEntry> {
  const [category, type, language] = key.split(":")
  const data = await retryWhenBusy(() => api.get<ServedSchemaData | null>(
    `${route("catalogSchema")}?descriptionCategoryId=${category}&typeId=${type}&language=${language}`,
  ), CATALOG_FILL_RETRY)
  if (!data) throw refuse("workflow_category_schema_missing", "该类目尚未同步，请检查平台类目密钥后重试")
  return { view: catalogSchemaView(data), material: await servedMaterial(key, data) }
}

const cache = createSessionCache<CategorySchemaEntry>(fetchEntry)

/** The normal category read: always GETs (sharing an in-flight one) and publishes the pair. */
export function readCategorySchema(
  coordinate: CategoryCoordinate,
  options?: { force?: boolean },
): Promise<CategorySchemaEntry> {
  return cache.load(coordinateKey(coordinate), options)
}

/** The resident record, or one read of it on a miss. */
export async function residentCategorySchema(coordinate: CategoryCoordinate): Promise<CategorySchemaEntry> {
  const key = coordinateKey(coordinate)
  return cache.peek(key)?.value ?? cache.load(key)
}

/** Zero-request peek for the send preflight. */
export function cachedMaterial(coordinate: CategoryCoordinate): NativeSchemaMaterial | undefined {
  return cache.peek(coordinateKey(coordinate))?.value.material
}

/**
 * The resident material, reading the coordinate once on a miss (concurrent
 * misses share one GET). Returns only what is resident after the read, so a
 * reply fenced by an identity switch is never handed out.
 */
export async function loadMaterial(
  coordinate: CategoryCoordinate,
  options?: { force?: boolean },
): Promise<NativeSchemaMaterial> {
  const key = coordinateKey(coordinate)
  const hit = options?.force ? undefined : cache.peek(key)?.value.material
  if (hit) return hit
  await cache.load(key, options)
  const entry = cache.peek(key)?.value
  if (!entry) {
    throw refuse("workflow_schema_material_stale", "类目字段素材已失效", "账号或工作区已切换，请重新操作")
  }
  if (!entry.material) {
    throw refuse("workflow_schema_material_missing", "类目字段素材缺失，无法在本地校验", "请刷新页面后重试；仍失败请联系管理员")
  }
  return entry.material
}

/**
 * Fold one server-confirmed dictionary search reply into `base`'s material.
 * Written only while `base` is still the resident record: an invalidate or a
 * newer read in between wins, and nothing is fabricated for a missing material.
 */
export async function rememberDictionaryHits(
  coordinate: CategoryCoordinate,
  base: CategorySchemaEntry,
  attributeId: number,
  dictionaryId: number,
  options: ReadonlyArray<{ id: string | number, value: string }>,
): Promise<void> {
  const key = coordinateKey(coordinate)
  if (!base.material) return
  const hits = options.flatMap((option) => {
    const valueId = Number(option.id)
    return positiveId(valueId) && option.value.trim()
      ? [{ descriptionCategoryId: coordinate.descriptionCategoryId, attributeId, dictionaryId, valueId, label: option.value }]
      : []
  })
  if (hits.length === 0) return
  // Cloud upserts by (coordinate, attribute, dictionary, option): the latest label wins.
  const merged = new Map<string, SearchMaterialEntry>()
  for (const entry of [...base.material.input.searchMaterials, ...hits]) {
    merged.set(`${entry.descriptionCategoryId}:${entry.attributeId}:${entry.dictionaryId}:${entry.valueId}`, entry)
  }
  const material = await nativeMaterial(base.material.input.snapshot, [...merged.values()])
  if (cache.peek(key)?.value !== base) return
  cache.remember(key, { view: base.view, material })
}
