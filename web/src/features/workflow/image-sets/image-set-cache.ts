import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { create } from "zustand"
import type { ImageSet } from "@/bindings/http-ai-image-sets"
import { imageSetsHttp } from "@/bindings/http-ai-image-sets"
import { useAccountOverview } from "@/features/account/account-overview-cache"
import { queryClient } from "@/lib/query-client"
import type { ListingRow } from "../model/listing-row"
import { useListingWorkbenchStore } from "../workbench/listing-workbench-store"
import { imageSetOwner, intentStorageKey, readImageSetIntent, readyImageSetURLs, type ImageSetIntent, type ImageSetScope } from "./image-set-state"

type Candidate = { intent: ImageSetIntent; view: ImageSet }
const useImageSetCandidates = create<{ entries: Record<string, Candidate> }>(() => ({ entries: {} }))
const queryKey = (intent: ImageSetIntent) => ["ai-image-set-result", intentStorageKey(intent), intent.key] as const

/** Candidate provenance stays separate from PSD delivery and rendering evidence. */
export function rememberImageSet(intent: ImageSetIntent, view: ImageSet): void {
  if (intent.setId !== view.id || readImageSetIntent(intent)?.key !== intent.key) return
  void queryClient.cancelQueries({ queryKey: queryKey(intent), exact: true })
  queryClient.setQueryData(queryKey(intent), view)
  useImageSetCandidates.setState((state) => ({ entries: { ...state.entries, [intentStorageKey(intent)]: { intent, view } } }))
}
export function rememberedImageSetURLs(scope: ImageSetScope): string[] {
  const intent = readImageSetIntent(scope)
  const candidate = useImageSetCandidates.getState().entries[intentStorageKey(scope)]
  return candidate && candidate.intent.key === intent?.key && candidate.intent.setId === candidate.view.id ? readyImageSetURLs(candidate.view) : []
}

export function useRowImageSetURLs(row: ListingRow): string[] {
  useAccountOverview()
  const owner = imageSetOwner()
  const cardId = useListingWorkbenchStore((state) => state.cardId)
  const scope: ImageSetScope = { owner, cardId: cardId ?? "", rowId: row.id, draftId: row.draftId, sourceHandle: row.source?.handle ?? "" }
  const key = intentStorageKey(scope)
  const intent = owner && cardId && scope.sourceHandle ? readImageSetIntent(scope) : undefined
  useImageSetCandidates((state) => state.entries[key])
  const result = useQuery({ queryKey: intent ? queryKey(intent) : ["ai-image-set-result", key, "none"], queryFn: () => imageSetsHttp.find(intent!.key, intent!.setId), enabled: Boolean(intent), staleTime: 30_000, retry: false }, queryClient)
  useEffect(() => {
    if (!intent || !result.data || readImageSetIntent(scope)?.key !== intent.key) return
    rememberImageSet({ ...intent, setId: result.data.id }, result.data)
  }, [key, intent?.key, result.data])
  return rememberedImageSetURLs(scope)
}
