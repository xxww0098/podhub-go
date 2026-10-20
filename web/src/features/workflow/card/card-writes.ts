/**
 * Card writes (README「单一所有者」「方案会话」行, specs/browser-owned-listing
 * slices/04-card-session.md): every Card write routes through a session,
 * built on `card-session.ts`'s `openCardSession`/`primeCardSession` — so
 * these functions live in `features/*` rather than in
 * `bindings/http-listing.ts`, which an architecture gate forbids importing
 * a `features/*` module (it must stay wire-only, no browser orchestration).
 * These build on the wire-only pieces `http-listing.ts` exports for them
 * instead of re-reading the Card themselves — duplicating that would be the
 * second copy the 单一所有者 table forbids.
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import {
  cardPayload,
  categoryKey,
  EMPTY_DRAFT,
  withDefaultFieldValue,
  type CardPayload,
  type CardQueue,
  type ListingCardView as CloudListingCardView,
} from "@/bindings/listing-projection"
import { sha256Hex } from "@/render/opfs"
import { rowCacheScope } from "@/bindings/listing-row-cache"
import {
  cardDraftView,
  cardQueueRunning,
  cardSummaryView,
  createListingCardBody,
  primaryStoreId,
  queueStateView,
} from "@/bindings/http-listing"
import type {
  ListingCardSummary,
  SaveWorkflowDraftRequest,
  WorkflowDraftValue,
  WorkflowQueueState,
  WorkflowQueueStateRequest,
} from "@/bindings/commands"
import { invalidateListingCardList } from "../listing-card-list-cache"
import { openCardSession, primeCardSession, type CardPatchWrite } from "./card-session"
import { backupUserTemplate } from "./template-assets"

const LISTING_CARDS = route("listingCards")

/**
 * A supplier softlink may only send its own keys — Cloud merges those into the
 * stored payload and re-projects the rest from the online config. A plain
 * card's payload is replaced wholesale, so the whole document rides back along.
 */
function cardPatch(
  payload: CardPayload,
  patch: Partial<CardPayload>,
): Partial<CardPayload> {
  return payload.supplierProductId ? patch : { ...payload, ...patch }
}

/**
 * Read-modify-write one card under its own revision CAS.
 *
 * `cas_patch_card` replaces `payload` wholesale, so the whole document travels
 * on every write — which is also what keeps the keys Cloud has no field for
 * alive (`listing-projection.ts::CardPayload`). Routed through the card's
 * session (S8): no GET before this PATCH unless the session has never been
 * opened in this tab, and a CAS conflict replays `build` once instead of
 * asking the caller to re-read.
 */
export async function patchListingCard(
  cardId: string,
  build: (payload: CardPayload, card: CloudListingCardView) => CardPayload,
  title?: string,
): Promise<CloudListingCardView> {
  const session = await openCardSession(cardId)
  const card = await session.patch((current) => ({
    payload: build(cardPayload(current), current),
    title,
  }))
  invalidateListingCardList()
  return card
}

/**
 * `POST /api/listing/cards`, seeding a session from the response: the very
 * first autosave on a brand-new card then skips the open GET too.
 */
async function createCardAndPrimeSession(
  body: ReturnType<typeof createListingCardBody>,
): Promise<CloudListingCardView> {
  const created = await api.post<CloudListingCardView>(LISTING_CARDS, body)
  primeCardSession(created)
  invalidateListingCardList()
  return created
}

/**
 * The card template's durable write: create on a blank id, otherwise a
 * `PATCH` under the card's own `revision`.
 *
 * The returned `schema` carries the coordinate and no fields — the request
 * only ever had a coordinate (`CategorySchemaRequest`), and inventing a
 * catalog read on the 700 ms autosave to fill it would buy nothing: every
 * caller of this reads `display_name`, `draft_id` and the coordinate.
 */
export async function listingCardSaveCategoryDraft(request: SaveWorkflowDraftRequest) {
  const current = rowCacheScope().current
  const previous = request.draft_id ? cardPayload((await openCardSession(request.draft_id)).card()) : undefined
  const backupChanged = request.psd_template_asset_id && (!previous
    || previous.psdTemplateSha256 !== request.psd_template_asset_id
    || previous.descriptionCategoryId !== request.schema.description_category_id
    || previous.typeId !== request.schema.type_id)
  const title = request.display_name?.trim() ?? ""
  const targetStoreId = request.target_store_id.trim()
  const promptSha256 = request.ai_prompt ? await sha256Hex(request.ai_prompt) : ""
  const write = (previous: CardPayload | undefined): CardPayload => ({
    ...previous,
    categoryKey: categoryKey(
      request.schema.description_category_id,
      request.schema.type_id,
      request.schema.language,
    ),
    descriptionCategoryId: request.schema.description_category_id,
    typeId: request.schema.type_id,
    language: request.schema.language ?? "default",
    defaults: request.draft,
    aiPromptId: request.ai_prompt_id,
    aiPromptSha256: promptSha256,
    aiPrompt: request.ai_prompt,
    aiPromptFileName: request.ai_prompt_file_name,
    psdTemplateAssetId: request.psd_template_asset_id,
    psdTemplateSha256: request.psd_template_asset_id,
    psdTemplateFileName: request.psd_template_file_name,
    targetStoreId,
    aiFieldPolicy: {
      allowed_field_keys: request.ai_allowed_field_keys,
      protected_field_keys: previous?.aiFieldPolicy.protected_field_keys ?? [],
    },
    videos: previous?.videos ?? [],
    videoCover: previous?.videoCover,
    queue: previous?.queue ?? { paused: false, stopAfterCurrent: false, nextPosition: 0, frozenRowIds: [] },
  })
  const card = request.draft_id
    ? await patchListingCard(request.draft_id, (previous) => write(previous), title)
    : await createCardAndPrimeSession(
        createListingCardBody(request, title, targetStoreId, write(undefined)),
      )
  const payload = cardPayload(card)
  if (backupChanged) backupUserTemplate(payload, current, card.id || request.draft_id)
  return cardDraftView(card, {
    description_category_id: request.schema.description_category_id,
    type_id: request.schema.type_id,
    language: request.schema.language,
    fields: [],
    complex_groups: [],
  })
}

/**
 * Write one card default field. A supplier softlink may only write the
 * card-owned table inputs (price / old_price / 主题 / JSON富内容); Cloud merges
 * those keys into the stored payload and re-projects the rest from the online
 * config on every read.
 */
async function saveCardDefaultField(
  cardId: string,
  fieldKey: string,
  value: WorkflowDraftValue | undefined,
): Promise<ListingCardSummary> {
  const session = await openCardSession(cardId)
  const next = await session.patch((current) => {
    const payload = cardPayload(current)
    const defaults = withDefaultFieldValue(
      payload.supplierProductId ? EMPTY_DRAFT : payload.defaults,
      fieldKey,
      value,
    )
    return { payload: cardPatch(payload, { defaults }) }
  })
  return cardSummaryView(next)
}

/**
 * Write one card default field — the four workbench table inputs (price /
 * old_price / 主题 / JSON富内容). Supplier softlinks keep the rest of the
 * config online.
 */
export function listingCardSaveDefaultField(
  cardId: string,
  fieldKey: string,
  value: WorkflowDraftValue | undefined,
): Promise<ListingCardSummary> {
  return saveCardDefaultField(cardId, fieldKey, value)
}

/**
 * Write one card default price field (`price` or `old_price`) only.
 * Supplier softlinks keep the rest of the config online; these two keys are
 * the only defaults the listing plan owns.
 */
export function listingCardSaveDefaultPrice(
  cardId: string,
  price: number | null,
  fieldKey = "price",
): Promise<ListingCardSummary> {
  return saveCardDefaultField(
    cardId,
    fieldKey,
    price == null ? undefined : { kind: "decimal", value: price },
  )
}

/**
 * Rebind the Card's target Stores and nothing else. A supplier softlink may
 * only write `targetStoreId` — Cloud merges that one key into the stored
 * payload; a plain card's payload is replaced wholesale, so the whole
 * document rides back along.
 */
export async function listingCardSaveStore(
  cardId: string,
  storeId: string,
): Promise<ListingCardSummary> {
  const session = await openCardSession(cardId)
  const next = await session.patch((current): CardPatchWrite => {
    const payload = cardPayload(current)
    const storeIdTrimmed = storeId.trim()
    return {
      payload: cardPatch(payload, { targetStoreId: storeIdTrimmed }),
      storeId: primaryStoreId(storeId) ?? null,
    }
  })
  return cardSummaryView(next)
}

/**
 * Rebind the Card's PSD template and nothing else.
 *
 * A supplier softlink may only write the template keys — Cloud merges them
 * into the stored payload, where a non-empty digest outranks the supplier
 * projection. An empty digest clears the override, handing the choice back
 * to the online supplier template.
 */
export async function listingCardSavePsd(
  cardId: string,
  assetId: string,
  fileName: string,
): Promise<ListingCardSummary> {
  const current = rowCacheScope().current
  const session = await openCardSession(cardId)
  const next = await session.patch((current) => {
    const payload = cardPayload(current)
    const psd = {
      psdTemplateAssetId: assetId.trim(),
      psdTemplateSha256: assetId.trim(),
      psdTemplateFileName: fileName.trim(),
    }
    return { payload: cardPatch(payload, psd) }
  })
  const payload = cardPayload(next)
  if (assetId.trim()) backupUserTemplate(payload, current, cardId)
  return cardSummaryView(next)
}

/** Every queue write is a card `PATCH` under the card's revision CAS. */
async function writeQueueState(
  cardId: string,
  build: (queue: CardQueue) => CardQueue,
): Promise<WorkflowQueueState> {
  const session = await openCardSession(cardId)
  const card = await session.patch((current) => {
    const payload = cardPayload(current)
    const queue = build(payload.queue)
    return { payload: cardPatch(payload, { queue }) }
  })
  return queueStateView(card, await cardQueueRunning(cardId, cardPayload(card).queue.frozenRowIds))
}

export function workflowSaveQueueState(request: WorkflowQueueStateRequest): Promise<WorkflowQueueState> {
  return writeQueueState(request.parent_card_id, () => ({
    paused: request.paused,
    stopAfterCurrent: request.stop_after_current,
    nextPosition: request.next_position,
    frozenRowIds: request.frozen_row_ids,
  }))
}

export function workflowPublishPause(parentCardId: string): Promise<WorkflowQueueState> {
  return writeQueueState(parentCardId, (queue) => ({
    ...queue,
    paused: true,
    haltReason: "operator_pause",
  }))
}

// Stop is pause plus "do not take the next row". Cancelling the intents that
// are already moving is `use-publish-queue.ts`'s second step, not this write.
export function workflowPublishStop(parentCardId: string): Promise<WorkflowQueueState> {
  return writeQueueState(parentCardId, (queue) => ({
    ...queue,
    paused: true,
    stopAfterCurrent: true,
    haltReason: "operator_stop",
  }))
}
