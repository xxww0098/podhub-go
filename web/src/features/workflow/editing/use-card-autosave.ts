import {
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react"
import { listingHttp } from "@/bindings/http-listing"
import { listingCardSaveCategoryDraft } from "@/features/workflow/card/card-writes"
import type {
  CategorySchemaView,
  FieldValueOrigin,
  FieldValueOriginKind,
  ListingCardSummary,
  SaveWorkflowDraftRequest,
  WorkflowCategoryDraft,
  WorkflowDraftView,
} from "@/bindings/commands"
import { notifyCommandError } from "@/lib/notify"
import { DurableAutosave } from "./durable-autosave"
import { listingWorkbenchScope, listingScopeCurrent, projectListingProducts } from "../workbench/listing-workbench-store"
import {
  cardSummaryFromDraft,
  schemaRequest,
  upsertSavedForm,
  type WorkflowShellMode,
} from "../workflow-shared"

/** The debounce every durable Draft write in this screen shares. */
export const AUTOSAVE_DEBOUNCE_MS = 700

type UseCardAutosaveInput = {
  mode: WorkflowShellMode
  supplierBound?: boolean
  schema: CategorySchemaView | undefined
  draft: WorkflowCategoryDraft | undefined
  draftId: string | undefined
  setDraftId: (draftId: string) => void
  formName: string
  aiPromptId: string
  aiPrompt: string
  aiPromptFileName: string
  psdTemplateAssetId: string
  psdTemplateFileName: string
  targetStoreId: string
  aiAllowedFieldKeys: string[]
  initialSkip: boolean
  setSavedForms: Dispatch<SetStateAction<ListingCardSummary[]>>
  setCardFieldOrigins: Dispatch<SetStateAction<FieldValueOrigin[]>>
}

/** Card templates have no row document whose field origins can be read. */
export async function syncSavedFieldOrigins(
  saved: WorkflowDraftView,
  scope: number,
  setCardFieldOrigins: Dispatch<SetStateAction<FieldValueOrigin[]>>,
): Promise<void> {
  if (saved.kind === "template") {
    setCardFieldOrigins([])
    return
  }
  try {
    const origins = await listingHttp.listingRowFieldOrigins(saved.draft_id)
    if (listingScopeCurrent(scope)) setCardFieldOrigins(origins)
  } catch {
    // Preserve the existing soft-failure behavior for origin decoration.
  }
}

/** Debounced durable writer for the open card template Draft. */
export function useCardAutosave({
  mode,
  supplierBound = false,
  schema,
  draft,
  draftId,
  setDraftId,
  formName,
  aiPromptId,
  aiPrompt,
  aiPromptFileName,
  psdTemplateAssetId,
  psdTemplateFileName,
  targetStoreId,
  aiAllowedFieldKeys,
  initialSkip,
  setSavedForms,
  setCardFieldOrigins,
}: UseCardAutosaveInput) {
  const skipNextAutosave = useRef(initialSkip)
  const draftIdRef = useRef(draftId)
  const autosaveTimerRef = useRef<number | undefined>(undefined)
  const autosaveRequestRef = useRef<SaveWorkflowDraftRequest | undefined>(undefined)
  const pendingValueOriginRef = useRef<{
    kind: FieldValueOriginKind
    sourceRef?: string
  }>({ kind: "manual" })
  const autosaveRef = useRef<
    DurableAutosave<SaveWorkflowDraftRequest, { saved: WorkflowDraftView; scope: number }> | undefined
  >(undefined)
  draftIdRef.current = draftId

  if (!autosaveRef.current) {
    autosaveRef.current = new DurableAutosave(
      async (request) => {
        const scope = listingWorkbenchScope()
        try {
          return { saved: await listingCardSaveCategoryDraft(request), scope }
        } catch (reason) {
          notifyCommandError(reason, "本地草稿未能保存到云端，请稍后重试。")
          throw reason
        }
      },
      ({ saved, scope }) => {
        if (!listingScopeCurrent(scope)) return
        pendingValueOriginRef.current = { kind: "manual" }
        draftIdRef.current = saved.draft_id
        autosaveRef.current?.rebaseLatest((request) => ({
          ...request,
          draft_id: saved.draft_id,
        }))
        setDraftId(saved.draft_id)
        if (saved.kind === "template") {
          setSavedForms((current) => upsertSavedForm(current, cardSummaryFromDraft(saved)))
        }
        projectListingProducts((current) =>
          current[saved.draft_id]
            ? { ...current, [saved.draft_id]: saved }
            : current,
        )
        void syncSavedFieldOrigins(saved, scope, setCardFieldOrigins)
      },
      () => undefined,
    )
  }

  // Rebuilt only when a request input actually changes — the JSON key doubles
  // as the dirty detector, so serializing on every unrelated render is waste.
  const autosaveRequest = useMemo(
    () =>
      schema && draft
        ? {
            draft_id: draftId,
            display_name: formName,
            schema: schemaRequest(schema),
            draft,
            ai_prompt_id: aiPromptId,
            ai_prompt: aiPrompt,
            ai_prompt_file_name: aiPromptFileName,
            psd_template_asset_id: psdTemplateAssetId,
            psd_template_file_name: psdTemplateFileName,
            target_store_id: targetStoreId,
            ai_allowed_field_keys: aiAllowedFieldKeys,
            value_origin_kind: pendingValueOriginRef.current.kind,
            value_origin_source_ref: pendingValueOriginRef.current.sourceRef,
          }
        : undefined,
    [
      schema,
      draft,
      draftId,
      formName,
      aiPromptId,
      aiPrompt,
      aiPromptFileName,
      psdTemplateAssetId,
      psdTemplateFileName,
      targetStoreId,
      aiAllowedFieldKeys,
    ],
  )
  autosaveRequestRef.current = autosaveRequest
  const autosaveContentKey = useMemo(
    () => (autosaveRequest ? JSON.stringify({ ...autosaveRequest, draft_id: undefined }) : ""),
    [autosaveRequest],
  )

  useEffect(() => {
    window.clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = undefined
    const request = autosaveRequestRef.current
    if (supplierBound || mode !== "runner" || !request) {
      autosaveRef.current?.reset()
      return
    }
    if (skipNextAutosave.current) {
      skipNextAutosave.current = false
      autosaveRef.current?.reset(
        request,
        draftIdRef.current ? "saved" : "idle",
      )
      return
    }
    autosaveRef.current?.markDirty(request)
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = undefined
      void autosaveRef.current?.flush()
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(autosaveTimerRef.current)
  }, [mode, autosaveContentKey, supplierBound])

  async function flushCardAutosave() {
    window.clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = undefined
    return (await autosaveRef.current?.flush()) ?? true
  }

  function hasPendingCardChanges() {
    return autosaveRef.current?.hasPendingChanges() ?? false
  }

  return {
    pendingValueOriginRef,
    autosaveRequestRef,
    skipNextAutosave,
    flushCardAutosave,
    hasPendingCardChanges,
  }
}
