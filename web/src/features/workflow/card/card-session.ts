/**
 * One Listing Card's read-write session (specs/browser-owned-listing S8,
 * slices/04-card-session.md): open once (`openCardSession`), write many
 * times without a GET first. `patch()` carries the session's own tracked
 * revision as the CAS base; a 409 re-reads exactly once and replays the same
 * field-level `build` against the fresh Card, and a second 409 is reported
 * to the caller instead of retried again. `verifySupplierOnce()` caches the
 * supplier media check for as long as the Card's bound supplier product
 * stays the same, so 打开/每次动词点击/发送 collapse into one network call.
 *
 * Single owner (README「单一所有者」「方案会话」行): every card write
 * (`card-writes.ts`'s `patchListingCard`, `listingCardSaveStore`,
 * `listingCardSavePsd`, `writeQueueState`, etc.) and every
 * `verifySupplierProductMedia` call from a screen or hook routes through a
 * session — nobody else GETs a Card immediately before PATCHing it.
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import {
  cardPayload,
  type CardPayload,
  type ListingCardView as CloudListingCardView,
} from "@/bindings/listing-projection"
import { verifySupplierProductMedia } from "@/bindings/http-media"
import { rowCacheScope } from "@/bindings/listing-row-cache"
import { refuse } from "@/bindings/refusal"

const LISTING_CARDS = route("listingCards")

function cardPath(cardId: string): string {
  return `${LISTING_CARDS}/${encodeURIComponent(cardId)}`
}

/** The session's read side: the last server-confirmed Card, unchanged shape. */
export type CardPayloadView = CloudListingCardView

type SupplierVerification = components["schemas"]["SupplierMediaVerificationData"]

/**
 * What one `patch()` sends. `payload` travels to Cloud exactly as `build`
 * returns it — a plain Card replaces its whole payload document, a
 * supplier-bound Card may only include the operator's own keys
 * (`write_card_patch`'s whitelist: `queue` / `targetStoreId` / `defaults` /
 * `psdTemplateAssetId` / `psdTemplateSha256` / `psdTemplateFileName`) or
 * Cloud answers 400. The session does not police this — every existing
 * caller in `http-listing.ts` already branches on `payload.supplierProductId`
 * the same way it did before this session existed.
 */
export interface CardPatchWrite {
  payload: Partial<CardPayload>
  /** Card-level rename. Cloud refuses this once the Card is supplier-bound. */
  title?: string
  /** Card-level Target Store rebind — a column, not a `payload` key. */
  storeId?: string | null
}

export interface CardSession {
  readonly cardId: string
  /** The last server-confirmed Card. No network. */
  card(): CardPayloadView
  /** `card().revision` — the CAS base the next `patch()` will send. */
  revision(): number
  /**
   * Serially queued: a second `patch()` waits for the first to settle before
   * `build` sees the result. `build` reads the session's latest confirmed
   * Card and returns the write; on a CAS conflict the session re-GETs once
   * and replays `build` against the fresh Card, and a repeat conflict throws
   * `card_conflict` instead of looping.
   */
  patch(build: (current: CardPayloadView) => CardPatchWrite): Promise<CardPayloadView>
  /**
   * `null` for a Card with no bound supplier product. Otherwise cached for
   * as long as the bound supplier product id stays the same; a failed check
   * is not cached, so the next call (a retry, the next verb) checks again.
   */
  verifySupplierOnce(): Promise<SupplierVerification | null>
  /** Forgets this session; the next `openCardSession` for this id re-GETs. */
  close(): void
}

function isConflict(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { status?: number }).status === 409
  )
}

function patchBody(baseRevision: number, write: CardPatchWrite): Record<string, unknown> {
  return {
    baseRevision,
    title: write.title?.trim() || undefined,
    ...("storeId" in write ? { storeId: write.storeId ?? null } : {}),
    payload: write.payload,
  }
}

class OpenCardSession implements CardSession {
  readonly cardId: string
  private latest: CloudListingCardView
  /** Serializes writes; each `patch()` chains onto whatever is still in flight. */
  private queue: Promise<unknown> = Promise.resolve()
  private verifyState: { productId: string, result: Promise<SupplierVerification> } | undefined

  constructor(cardId: string, initial: CloudListingCardView) {
    this.cardId = cardId
    this.latest = initial
  }

  card(): CardPayloadView {
    return this.latest
  }

  revision(): number {
    return this.latest.revision
  }

  patch(build: (current: CardPayloadView) => CardPatchWrite): Promise<CardPayloadView> {
    const result = this.queue.then(() => this.writeOnce(build))
    // A failed write must not wedge later, unrelated patches behind it.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async writeOnce(
    build: (current: CardPayloadView) => CardPatchWrite,
  ): Promise<CloudListingCardView> {
    try {
      return await this.send(build(this.latest))
    } catch (reason) {
      if (!isConflict(reason)) throw reason
      // One re-read, then one field-level replay against the fresh Card
      // (04's own 决定: "冲突时自动重放一次，不弹确认框").
      this.latest = await api.get<CloudListingCardView>(cardPath(this.cardId))
      try {
        return await this.send(build(this.latest))
      } catch (again) {
        if (isConflict(again)) {
          throw refuse("card_conflict", "方案已在别处修改，已载入最新版本")
        }
        throw again
      }
    }
  }

  private async send(write: CardPatchWrite): Promise<CloudListingCardView> {
    const card = await api.patch<CloudListingCardView>(
      cardPath(this.cardId),
      patchBody(this.latest.revision, write),
    )
    this.latest = card
    return card
  }

  async verifySupplierOnce(): Promise<SupplierVerification | null> {
    const productId = cardPayload(this.latest).supplierProductId
    if (!productId) {
      this.verifyState = undefined
      return null
    }
    if (this.verifyState?.productId !== productId) {
      const result = verifySupplierProductMedia(productId)
      this.verifyState = { productId, result }
      result.catch(() => {
        // A refused check must not stay cached: the next call (a retry, the
        // next verb) has to hit Cloud again.
        if (this.verifyState?.result === result) this.verifyState = undefined
      })
    }
    return this.verifyState.result
  }

  close(): void {
    if (sessions.get(this.cardId) === registryEntries.get(this)) {
      sessions.delete(this.cardId)
    }
    registryEntries.delete(this)
  }
}

type SessionEntry = { opening: Promise<OpenCardSession>; resolved?: OpenCardSession; current: () => boolean }
const sessions = new Map<string, SessionEntry>()
/** Each session instance remembers the exact registry entry it was created from, so `close()` never evicts a newer session that replaced it. */
const registryEntries = new WeakMap<OpenCardSession, SessionEntry>()

/** Current resolved session only. Missing / pending / closed entries cost zero network calls. */
export function peekCardSession(cardId: string): CardSession | undefined {
  const entry = sessions.get(cardId)
  const session = entry?.current() ? entry.resolved : undefined
  return session?.card().id === cardId ? session : undefined
}

/**
 * Exactly one GET the first time a Card is opened in this tab; a Card
 * already open (or opening) is returned as-is, with no further GET.
 */
export function openCardSession(cardId: string): Promise<CardSession> {
  const existing = sessions.get(cardId)
  if (existing?.current()) return existing.opening
  // Reuse the tab's existing identity / Workspace fence; a prior account's
  // resolved or pending Card must never supply resident release authority.
  const { current } = rowCacheScope()
  const opening: Promise<OpenCardSession> = api
    .get<CloudListingCardView>(cardPath(cardId))
    .then((card) => {
      const session = new OpenCardSession(cardId, card)
      registryEntries.set(session, entry)
      if (sessions.get(cardId) === entry && current()) entry.resolved = session
      return session
    })
  const entry: SessionEntry = { opening, current }
  sessions.set(cardId, entry)
  opening.catch(() => {
    if (sessions.get(cardId) === entry) sessions.delete(cardId)
  })
  return opening
}

/**
 * Seed a session from a Card the caller already has in hand — the
 * `POST /api/listing/cards` response for a brand-new Card, most notably — so
 * the very next `patch()` on it skips the open GET entirely.
 */
export function primeCardSession(card: CloudListingCardView): CardSession {
  const session = new OpenCardSession(card.id, card)
  const entry: SessionEntry = { opening: Promise.resolve(session), resolved: session, current: rowCacheScope().current }
  registryEntries.set(session, entry)
  sessions.set(card.id, entry)
  return session
}

/** Forgets an open session outright (the workbench closing/switching a Card). */
export function closeCardSession(cardId: string): void {
  sessions.delete(cardId)
}

/**
 * Test isolation: forgets every open session. A fixture that reuses the same
 * card id across tests (as `listing-commands.test.ts` does) must call this
 * before swapping in a fresh `fetch` stub, or a later test would silently
 * reuse an earlier test's cached revision — the same cross-test hazard
 * `resetCategorySchemaCache` in `bindings/http-listing.ts` guards against.
 */
export function resetCardSessions(): void {
  sessions.clear()
}
