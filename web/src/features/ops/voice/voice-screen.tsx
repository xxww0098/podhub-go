import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2Icon, RefreshCw } from "lucide-react"

import { opsHttp } from "@/bindings/http-ops"
import {
  rosterHasUnavailableStores,
  useStoreRoster,
} from "@/features/stores/store-roster-cache"
import {
  OpsStoreSelect,
  opsStoresFromRoster,
  preferredStoreUid,
  useOpsStoreRoster,
  type OpsStore,
} from "@/features/ops/ops-store-roster"
import { PageToolbar } from "@/components/page-toolbar"
import { useScreenActive } from "@/components/screen-pane"
import { IconButton } from "@/components/ui/icon-button"
import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { errorMessage } from "@/lib/error-message"
import { clearLive, notifyLive } from "@/lib/notify"
import { StoreGate } from "@/features/stores/store-gate"

import { QuestionsSection, ReviewsSection } from "./voice-queue"
import {
  appendQuestions,
  appendReviews,
  emptyQuestions,
  emptyReviews,
  runVoiceRead,
  voiceReadState,
  type VoiceLoadMode,
} from "./voice-model"

type VoiceScreenProps = {
  workspaceId?: number
  onOpenStores?: () => void
}

const VOICE_REVIEWS_LIVE = "voice-reviews-read"
const VOICE_QUESTIONS_LIVE = "voice-questions-read"

/**
 * 口碑 — unreplied reviews, unreplied questions, chat roster. Breadcrumb
 * already names the module. This screen never writes to Ozon.
 */
export function VoiceScreen({ workspaceId, onOpenStores }: VoiceScreenProps) {
  const active = useScreenActive()
  const roster = useStoreRoster(workspaceId)
  const [stores, setStores] = useState<OpsStore[]>([])
  const [storeUid, setStoreUid] = useState("")
  const [hasUnavailableStores, setHasUnavailableStores] = useState(false)
  const [reviews, setReviews] = useState(() => voiceReadState(emptyReviews()))
  const [questions, setQuestions] = useState(() => voiceReadState(emptyQuestions()))
  const reviewsSequence = useRef(0)
  const questionsSequence = useRef(0)
  const storeUidRef = useRef(storeUid)
  const storesRef = useRef(stores)
  storeUidRef.current = storeUid
  storesRef.current = stores

  const { storesLoading, storesError, storesReason, retryStores } =
    useOpsStoreRoster({
      workspaceId,
      active,
      hasStores: () => storesRef.current.length > 0,
      onInvalidate: () => {
        reviewsSequence.current += 1
        questionsSequence.current += 1
        setReviews((current) => ({ ...current, loading: null }))
        setQuestions((current) => ({ ...current, loading: null }))
      },
      onRosterMiss: () => {
        if (storesRef.current.length === 0) selectStore("")
      },
      onCleanup: () => {
        clearLive(VOICE_REVIEWS_LIVE)
        clearLive(VOICE_QUESTIONS_LIVE)
      },
    })

  const loadReviews = useCallback(
    (nextStore: string, mode: VoiceLoadMode, lastId?: string) => {
      if (!nextStore.trim()) return Promise.resolve(false)
      const sequence = ++reviewsSequence.current
      const retry =
        mode === "append"
          ? () => {
              void loadReviews(nextStore, "append", lastId)
            }
          : () => {
              void loadReviews(nextStore, "replace")
            }
      return runVoiceRead({
        mode,
        request: () =>
          opsHttp.opsVoiceListReviews({
            store_id: nextStore,
            last_id: mode === "append" ? lastId : undefined,
          }),
        isCurrent: () =>
          sequence === reviewsSequence.current &&
          storeUidRef.current === nextStore,
        setState: setReviews,
        fallback: "无法读取评价",
        merge: mode === "append" ? appendReviews : undefined,
      })
        .then((loaded) => {
          if (loaded) clearLive(VOICE_REVIEWS_LIVE)
          return loaded
        })
        .catch((reason) => {
          notifyLive({
            id: VOICE_REVIEWS_LIVE,
            type: "error",
            reason,
            title: errorMessage(reason, "无法读取评价"),
            action: { label: "重试", onClick: retry },
          })
          return false
        })
    },
    [],
  )

  const loadQuestions = useCallback(
    (nextStore: string, mode: VoiceLoadMode, lastId?: string) => {
      if (!nextStore.trim()) return Promise.resolve(false)
      const sequence = ++questionsSequence.current
      const retry =
        mode === "append"
          ? () => {
              void loadQuestions(nextStore, "append", lastId)
            }
          : () => {
              void loadQuestions(nextStore, "replace")
            }
      return runVoiceRead({
        mode,
        request: () =>
          opsHttp.opsVoiceListQuestions({
            store_id: nextStore,
            last_id: mode === "append" ? lastId : undefined,
          }),
        isCurrent: () =>
          sequence === questionsSequence.current &&
          storeUidRef.current === nextStore,
        setState: setQuestions,
        fallback: "无法读取提问",
        merge: mode === "append" ? appendQuestions : undefined,
      })
        .then((loaded) => {
          if (loaded) clearLive(VOICE_QUESTIONS_LIVE)
          return loaded
        })
        .catch((reason) => {
          notifyLive({
            id: VOICE_QUESTIONS_LIVE,
            type: "error",
            reason,
            title: errorMessage(reason, "无法读取提问"),
            action: { label: "重试", onClick: retry },
          })
          return false
        })
    },
    [],
  )

  const selectStore = useCallback((nextStore: string) => {
    if (nextStore === storeUidRef.current) return false
    reviewsSequence.current += 1
    questionsSequence.current += 1
    storeUidRef.current = nextStore
    setStoreUid(nextStore)
    setReviews(voiceReadState(emptyReviews()))
    setQuestions(voiceReadState(emptyQuestions()))
    return true
  }, [])

  const refresh = useCallback(
    async (nextStore: string) => {
      if (!nextStore.trim()) return
      await Promise.all([
        loadReviews(nextStore, "replace"),
        loadQuestions(nextStore, "replace"),
      ])
    },
    [loadQuestions, loadReviews],
  )

  useEffect(() => {
    if (!roster) return
    const configured = opsStoresFromRoster(roster.overview.stores)
    setHasUnavailableStores(rosterHasUnavailableStores(roster.overview))
    setStores(configured)
    const current = storeUidRef.current
    const selected = configured.some((store) => store.storeUid === current)
      ? current
      : preferredStoreUid(configured, roster.overview.active_id)
    if (selected === current) return
    selectStore(selected)
    if (selected) void refresh(selected)
  }, [refresh, roster, selectStore])

  const busy = reviews.loading !== null || questions.loading !== null
  const refreshing =
    reviews.loading === "replace" || questions.loading === "replace"

  return (
    <Tabs defaultValue="reviews" className="min-h-0 w-full flex-1 overflow-hidden scroll-pt-14">
      <PageToolbar
        primary={
          <>
            <OpsStoreSelect
              value={storeUid}
              stores={stores}
              onChange={(next) => {
                selectStore(next)
                void refresh(next)
              }}
            />
            <TabsList aria-label="口碑队列">
              <TabsIndicator />
              <TabsTrigger value="reviews" className="h-7 px-2.5">
                评价
              </TabsTrigger>
              <TabsTrigger value="questions" className="h-7 px-2.5">
                提问
              </TabsTrigger>
            </TabsList>
          </>
        }
        secondary={
          <IconButton
            icon={refreshing ? Loader2Icon : RefreshCw}
            label="刷新"
            variant="outline"
            size="icon-sm"
            disabled={!storeUid.trim() || busy}
            className={cn(refreshing && "[&_svg]:animate-spin")}
            onClick={() => void refresh(storeUid)}
          />
        }
      />

      <StoreGate
        loading={storesLoading}
        error={storesError}
        reason={storesReason}
        storeCount={stores.length}
        hasUnavailableStores={hasUnavailableStores}
        onRetry={retryStores}
        onOpenStores={onOpenStores}
      >
        <>
          <TabsContent value="reviews" className="min-h-0">
            <ReviewsSection
              {...reviews}
              onRetry={() => {
                if (reviews.loading !== null) return
                void loadReviews(storeUid, "replace")
              }}
              onLoadMore={() => {
                if (reviews.loading !== null) return
                void loadReviews(storeUid, "append", reviews.view.last_id)
              }}
            />
          </TabsContent>
          <TabsContent value="questions" className="min-h-0">
            <QuestionsSection
              {...questions}
              onRetry={() => {
                if (questions.loading !== null) return
                void loadQuestions(storeUid, "replace")
              }}
              onLoadMore={() => {
                if (questions.loading !== null) return
                void loadQuestions(storeUid, "append", questions.view.last_id)
              }}
            />
          </TabsContent>
        </>
      </StoreGate>
    </Tabs>
  )
}
