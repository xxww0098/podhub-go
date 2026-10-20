import { useMemo, useRef, useState } from "react"
import type { CategorySchemaView, WorkflowCategoryDraft, WorkflowValidationIssue, PickedPsdAsset, ListingCardSummary, FieldValueOrigin } from "@/bindings/commands"
import { createWorkflowDraft } from "./workflow-draft"
import { readWorkflowCardId } from "./workflow-navigation"
import { DEFAULT_AI_PROMPT, type WorkflowShellMode } from "./workflow-shared"
import { useStoreRoster } from "@/features/stores/store-roster-cache"
import { cardStoreAvailability } from "./store-availability"
import { createPreparationTracks } from "./prepare/preparation-tracks"

const PROTECTED_FIELD = /price|dimension|weight|brand|certif|offer|image|video|cover|media|url/i
export const TEMPLATE_NOTICE_ID = "listing-template-readiness"

/** State and generation fences owned by one mounted workbench screen. */
export function useWorkflowScreenState(initialSchema: CategorySchemaView | undefined, workspaceId: number | undefined, active: boolean) {
  const [mode, setMode] = useState<WorkflowShellMode>(initialSchema ? "runner" : "library")
  // A cardId in the URL marks this mount as a refresh mid-card. Gate the first
  // paint behind a restoring placeholder until Cloud answers, or the library
  // flashes before the runner takes over (the "先跳回列表" refresh flicker).
  const [restoringCard, setRestoringCard] = useState(
    () =>
      typeof window !== "undefined" &&
      !initialSchema &&
      Boolean(readWorkflowCardId(window.location.search)),
  )
  const [schema, setSchema] = useState(initialSchema)
  const [draft, setDraft] = useState<WorkflowCategoryDraft | undefined>(
    initialSchema ? createWorkflowDraft(initialSchema) : undefined,
  )
  const [draftId, setDraftId] = useState<string>()
  const [supplierProductId, setSupplierProductId] = useState<string>()
  const supplierBound = Boolean(supplierProductId)
  const [cardTemplateId, setCardTemplateId] = useState<string>()
  const [formName, setFormName] = useState(
    initialSchema ? `类目 ${initialSchema.description_category_id} 模板` : "",
  )
  const [issues, setIssues] = useState<WorkflowValidationIssue[]>([])
  const [busy, setBusy] = useState(false)
  const [psdAsset, setPsdAsset] = useState<PickedPsdAsset>()
  const psdAssetTemplateIdRef = useRef("")
  const [psdTemplateAssetId, setPsdTemplateAssetId] = useState("")
  const [psdTemplateFileName, setPsdTemplateFileName] = useState("")
  const [aiPromptId, setAiPromptId] = useState("")
  const [aiPrompt, setAiPrompt] = useState(DEFAULT_AI_PROMPT)
  const [aiPromptFileName, setAiPromptFileName] = useState("")
  const [savedForms, setSavedForms] = useState<ListingCardSummary[]>([])
  const [libraryBusy, setLibraryBusy] = useState(true)
  const [streamHealthy, setStreamHealthy] = useState(false)
  const [cardFieldOrigins, setCardFieldOrigins] = useState<FieldValueOrigin[]>([])
  const [targetStoreId, setTargetStoreId] = useState("")
  const [aiAllowedFieldKeys, setAiAllowedFieldKeys] = useState<string[]>([])
  // Cards whose videos are still uploading after the create dialog closed.
  // Held here rather than in the library host so an in-flight upload keeps its
  // tile progress across a runner round-trip.
  const [videoUploads, setVideoUploads] = useState<
    Record<string, { done: number; total: number }>
  >({})
  const aiProtectedFieldKeys = useMemo(
    () =>
      schema
        ? schema.fields.flatMap((field) =>
            PROTECTED_FIELD.test(`${field.key} ${field.name}`) ? [field.key] : [],
          )
        : [],
    [schema],
  )
  const ozonStores = useStoreRoster(workspaceId)?.overview.stores ?? []
  const storeAvailability = useMemo(
    () => cardStoreAvailability(targetStoreId, ozonStores),
    [ozonStores, targetStoreId],
  )
  const storeConfigured = storeAvailability.ready
  const storeLabel = storeAvailability.label

  // Shared fences. 识别 / 切片 / 上传 hold rows, not each other: the registry
  // is the fence a second click reads synchronously, `activity` in the
  // workbench store is the copy the toolbar draws.
  const preparationTracks = useRef(createPreparationTracks())
  const guidedPreparationLock = useRef(false)
  const rowClearLock = useRef(false)
  const runnerOpenLock = useRef(false)
  const runnerGeneration = useRef(0)
  const stopCardStream = useRef<(() => void) | undefined>(undefined)
  const wasActive = useRef(active)

  const handledAddressCardId = useRef<string | undefined>(undefined)
  const dispatchedRunnerGeneration = useRef(0)
  return {
    mode, setMode, restoringCard, setRestoringCard, schema, setSchema,
    draft, setDraft, draftId, setDraftId, supplierProductId, setSupplierProductId,
    supplierBound, cardTemplateId, setCardTemplateId, formName, setFormName, issues,
    setIssues, busy, setBusy, psdAsset, setPsdAsset, psdAssetTemplateIdRef,
    psdTemplateAssetId, setPsdTemplateAssetId, psdTemplateFileName, setPsdTemplateFileName, aiPromptId, setAiPromptId,
    aiPrompt, setAiPrompt, aiPromptFileName, setAiPromptFileName, savedForms, setSavedForms,
    libraryBusy, setLibraryBusy, streamHealthy, setStreamHealthy, cardFieldOrigins, setCardFieldOrigins,
    targetStoreId, setTargetStoreId, aiAllowedFieldKeys, setAiAllowedFieldKeys, videoUploads, setVideoUploads,
    aiProtectedFieldKeys, ozonStores, storeAvailability, storeConfigured, storeLabel, preparationTracks,
    guidedPreparationLock, rowClearLock, runnerOpenLock, runnerGeneration, stopCardStream, wasActive,
    handledAddressCardId, dispatchedRunnerGeneration
  }
}
export type WorkflowScreenState = ReturnType<typeof useWorkflowScreenState>
