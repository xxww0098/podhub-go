import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react"
import { listingHttp } from "@/bindings/http-listing"
import {
  listingCardSaveCategoryDraft,
  listingCardSaveDefaultField,
  listingCardSaveDefaultPrice,
  listingCardSavePsd,
  listingCardSaveStore,
} from "@/features/workflow/card/card-writes"
import type {
  CategorySchemaView,
  CategoryTreeNodeView,
  ListingCardSummary,
  WorkflowCategoryPrompt,
  WorkflowCategoryVideo,
  WorkflowDraftValue,
  WorkflowDraftView,
  WorkflowMediaBindingResult,
  WorkflowVideoMetadata,
} from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { renderOpfs } from "@/bindings/render-opfs"
import { beginPsdTransfer, clearPsdTransfer, failPsdTransfer, linkPsdTransfer, notePsdHash } from "./card/psd-transfer"
import { acceptUserTemplate, cancelUserTemplate, resumeReadablePsdUploads } from "./card/template-assets"
import { workflowActions } from "./workflow-actions"
import {
  clearLive,
  notifyCommandError,
  notifyError,
  notifyLive,
  notifySuccess,
} from "@/lib/notify"
import { CardLibrary } from "./card-library"
import { type PendingVideoItem, type VideoActionPhase } from "./media/card-video-panel"
import {
  emptyTreeSelection,
  promptBackedTree,
  resolveLeaf,
  selectionFromLeaf,
  type CategoryTreeSelection,
  type PromptBackedLeaf,
} from "@/features/category-schema/category-tree"
import {
  composeSellerCredentialIssue,
  defaultListingCardStoreId,
} from "./store-availability"
import { formatStoreIds, parseStoreIds } from "./store-quota"
import { readCategoryTreeCache } from "@/features/category-schema/category-tree-cache"
import { loadCategoryTree } from "@/features/category-schema/category-tree-load"
import { invalidateListingCardList } from "./listing-card-list-cache"
import {
  projectListingProducts,
  listingWorkbenchScope,
} from "./workbench/listing-workbench-store"
import { composeBlockedBySignedOut } from "./product-instances"
import { chunkItems, MUTATION_BATCH } from "./source-batch"
import { useStoreRoster } from "@/features/stores/store-roster-cache"
import { createWorkflowDraft } from "./workflow-draft"
import { parseSalePrice } from "./sale-price"
import { syncCardFieldToRows } from "./card-price-sync"
import { categorySchemaFlight } from "@/features/category-schema/schema-sync"
import {
  cardSummaryFromDraft,
  commandCode,
  commandError,
  copyListingCardTemplate,
  savedFormTitle,
  schemaRequest,
  upsertSavedForm,
} from "./workflow-shared"

/** Live rows carry page-read failures with their retry; none of it renders in the page. */
const CATEGORY_TREE_LIVE = "workflow-category-tree"
const COMPOSE_TREE_EMPTY_LIVE = "workflow-compose-tree-empty"

/**
 * The price-pair precheck both default-price cells share: Ozon refuses a
 * 划线价 that does not sit strictly above the 销售价. The other side being
 * empty parses to null and is deliberately not compared — clearing one field
 * must never block writing the other.
 */
export function defaultPricePairRejected(
  price: number | null,
  fieldKey: "price" | "old_price",
  otherRaw: string | undefined,
): boolean {
  const other = parseSalePrice(otherRaw ?? "")
  return (
    price != null &&
    typeof other === "number" &&
    (fieldKey === "price" ? price >= other : price <= other)
  )
}

/**
 * Read the platform video pool for one L3 leaf into `apply`, and hand back the
 * effect cleanup that drops a late response. An unreadable pool is an empty
 * pool: a missing pool must never block building a card.
 */
function loadPoolVideos(
  open: boolean,
  descriptionCategoryId: number,
  typeId: number,
  apply: (videos: WorkflowCategoryVideo[]) => void,
): (() => void) | undefined {
  if (!open || descriptionCategoryId <= 0 || typeId <= 0) {
    apply([])
    return undefined
  }
  let live = true
  void listingHttp
    .listingCardListCategoryVideos(descriptionCategoryId, typeId)
    .then((rows) => {
      if (live) apply(rows)
    })
    .catch(() => {
      if (live) apply([])
    })
  return () => {
    live = false
  }
}

type CardLibraryHostProps = {
  forms: ListingCardSummary[]
  setForms: Dispatch<SetStateAction<ListingCardSummary[]>>
  busy: boolean
  setBusy: (busy: boolean) => void
  refreshForms: () => Promise<void>
  videoUploads: Record<string, { done: number; total: number }>
  setVideoUploads: Dispatch<SetStateAction<Record<string, { done: number; total: number }>>>
  workspaceId?: number
  /** The open runner card's Store binding; last resort for the tree request. */
  fallbackStoreId: string
  onRun: (form: ListingCardSummary | WorkflowDraftView) => void
  onCardSaved: () => void
  onOpenStores?: () => void
  onOpenCatalog?: () => void
  highlightDraftId?: string
}

/**
 * The library shell: saved-card CRUD plus the create ("建卡") and edit-bind
 * dialogs. All dialog state lives here so typing a card name or staging a
 * video re-renders this host only, never the runner half of the screen.
 */
export function CardLibraryHost({
  forms,
  setForms,
  busy,
  setBusy,
  refreshForms,
  videoUploads,
  setVideoUploads,
  workspaceId,
  fallbackStoreId,
  onRun,
  onCardSaved,
  onOpenStores,
  onOpenCatalog,
  highlightDraftId,
}: CardLibraryHostProps) {
  const ozonStores = useStoreRoster(workspaceId)?.overview.stores ?? []
  const [copyingCardId, setCopyingCardId] = useState<string>()
  const [savingPriceId, setSavingPriceId] = useState<string>()
  const [savingDefaultFieldId, setSavingDefaultFieldId] = useState<string>()
  const [savingPsdId, setSavingPsdId] = useState<string>()
  const [composing, setComposing] = useState(false)
  const [composeBusy, setComposeBusy] = useState(false)
  const [composeSaving, setComposeSaving] = useState(false)
  const [composeSavingLabel, setComposeSavingLabel] = useState<string>()
  const [composeName, setComposeName] = useState("")
  const [composeStoreId, setComposeStoreId] = useState("")
  const [composeSelection, setComposeSelection] =
    useState<CategoryTreeSelection>(emptyTreeSelection)
  const [composePsdAssetId, setComposePsdAssetId] = useState("")
  const [composePsdFileName, setComposePsdFileName] = useState("")
  const [composePrompts, setComposePrompts] = useState<WorkflowCategoryPrompt[]>(
    [],
  )
  const [composePromptRefreshBusy, setComposePromptRefreshBusy] = useState(false)
  const [composePromptId, setComposePromptId] = useState("")
  const [composePendingVideos, setComposePendingVideos] = useState<PendingVideoItem[]>([])
  const [composePoolVideos, setComposePoolVideos] = useState<WorkflowCategoryVideo[]>([])
  const [composeVideoPhase, setComposeVideoPhase] = useState<VideoActionPhase>("idle")
  const [categoryTree, setCategoryTree] = useState<CategoryTreeNodeView[]>(
    () => readCategoryTreeCache() ?? [],
  )
  const [treeBusy, setTreeBusy] = useState(false)
  const [promptLeaves, setPromptLeaves] = useState<PromptBackedLeaf[]>([])
  const [promptLeavesBusy, setPromptLeavesBusy] = useState(false)

  useEffect(() => () => {
    clearLive(CATEGORY_TREE_LIVE)
    clearLive(COMPOSE_TREE_EMPTY_LIVE)
  }, [])

  useEffect(() => {
    void resumeReadablePsdUploads()
  }, [])

  useEffect(() => {
    if (!categoryTree.length) void refreshCategoryTree()
    // The tree is cached across mounts; only an empty cache warrants a fetch.
  }, [])

  // After a Store is chosen (or defaulted), pull the Seller tree. Manual
  // 「重新拉取」 is a second path, not the only one.
  useEffect(() => {
    if (!composing) return
    // A bound Store without credentials cannot pay for a live fill; an
    // unbound Card still reads the platform tree cache.
    if (composeStoreId.trim() && composeSellerCredentialIssue(composeStoreId, ozonStores)) return
    if (categoryTree.length) return
    void refreshCategoryTree()
  }, [composing, composeStoreId])

  useEffect(() => {
    if (!composing) return
    void refreshPromptLeaves({ silent: true })
  }, [composing])

  // The platform video pool follows the dialog's L3 leaf. Kept as its own
  // effect rather than threaded through every prompt-load call site; a failed
  // read is simply an empty pool.
  useEffect(() => {
    return loadPoolVideos(
      composing,
      composeSelection.descriptionCategoryId,
      composeSelection.typeId,
      setComposePoolVideos,
    )
  }, [composing, composeSelection.descriptionCategoryId, composeSelection.typeId])

  /**
   * Whose Seller key fills a Category Schema cache miss. A Card does not have
   * to bind a Store to exist, so the bound Store is preferred and any usable
   * Workspace Store is the fallback; with neither the read is cache-only and a miss
   * tells the operator to add a Store.
   */
  function schemaStoreId(boundStoreId: string): string | undefined {
    return (
      parseStoreIds(boundStoreId)[0] ||
      defaultListingCardStoreId(ozonStores, fallbackStoreId) ||
      undefined
    )
  }

  // Warm the schema caches while the operator is still typing the name: a
  // cold category costs a live Seller fan-out (~14 round trips), and the
  // catalog dedupes concurrent resolves, so paying it here makes 确认 a
  // cache hit instead of a minutes-long silent spinner.
  useEffect(() => {
    if (!composing) return
    if (composeSelection.descriptionCategoryId <= 0 || composeSelection.typeId <= 0) return
    void listingHttp
      .listingCardLoadCategorySchema({
        description_category_id: composeSelection.descriptionCategoryId,
        type_id: composeSelection.typeId,
        language: "zh_hans",
        target_store_id: schemaStoreId(composeStoreId),
      })
      .catch(() => {})
  }, [
    composing,
    composeSelection.descriptionCategoryId,
    composeSelection.typeId,
    composeStoreId,
  ])

  async function deleteSavedForm(form: ListingCardSummary | WorkflowDraftView) {
    setBusy(true)
    try {
      await listingHttp.listingCardDeleteSavedDraft(form.draft_id)
      invalidateListingCardList()
      setForms((current) =>
        current.filter((item) => item.draft_id !== form.draft_id),
      )
      await refreshForms()
      // The title is captured before the row disappears.
      notifySuccess(`已删除「${savedFormTitle(form)}」`)
    } catch (reason) {
      notifyCommandError(reason, "无法删除这个上架方案，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function copySavedForm(form: ListingCardSummary | WorkflowDraftView) {
    if (busy) return
    setBusy(true)
    setCopyingCardId(form.draft_id)
    try {
      const copied = await copyListingCardTemplate(
        form.draft_id,
        listingHttp.listingCardCopySavedDraft,
      )
      invalidateListingCardList()
      setForms((current) => upsertSavedForm(current, cardSummaryFromDraft(copied)))
      notifySuccess(`已复制为「${savedFormTitle(copied)}」`)
    } catch (reason) {
      notifyCommandError(reason, "无法复制这个上架方案，请稍后重试。")
    } finally {
      setCopyingCardId(undefined)
      setBusy(false)
    }
  }

  /**
   * One price cell writes one card default price field (`price` or
   * `old_price`). Ozon refuses 划线价 that does not sit strictly above
   * 销售价, so the pair is checked before the PATCH ever leaves — the same
   * relation `validate_prices` enforces downstream. Resolves false whenever
   * the write was refused (the reason rides a toast), so the cell keeps the
   * operator's input and marks itself invalid; a guard exit (another save in
   * flight) resolves undefined — no verdict, the cell lets the stored value
   * stand without an invalid mark.
   */
  /**
   * The workbench keeps per-row user state: rows the operator typed by hand do
   * not inherit the card default, so the card value has to be written onto
   * them for the table to follow. A row-sync complaint is its own toast — the
   * card default itself is already stored.
   */
  async function syncRowsForDefaultField(
    cardId: string,
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
  ) {
    try {
      const sync = await syncCardFieldToRows(cardId, fieldKey, value)
      if (sync.conflicts) {
        notifyError(`${sync.conflicts} 件商品的这个字段已被改成别的值，没有覆盖。`)
      }
      if (sync.failed) {
        notifyError(`${sync.failed} 件商品未能同步，请在上架表内核对后重试。`)
      }
    } catch (reason) {
      notifyCommandError(
        reason,
        "默认值已保存到方案，但商品行未能同步，请在上架表内核对。",
      )
    }
  }

  /**
   * One card default field write shared by the 名册's four tableInput columns.
   * `fieldKey` is the Card's own Schema key (resolved by the caller from the
   * Schema it just read), never a hard-coded attribute id.
   */
  async function saveDefaultField(
    form: ListingCardSummary,
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    failureCopy: string,
  ): Promise<boolean | undefined> {
    if (busy || savingDefaultFieldId || form.supplier_unavailable) return undefined
    setSavingDefaultFieldId(form.draft_id)
    try {
      const saved = await listingCardSaveDefaultField(
        form.draft_id,
        fieldKey,
        value,
      )
      setForms((current) => upsertSavedForm(current, saved))
      await syncRowsForDefaultField(form.draft_id, fieldKey, value)
      return true
    } catch (reason) {
      notifyCommandError(reason, failureCopy)
      return false
    } finally {
      setSavingDefaultFieldId(undefined)
    }
  }

  async function saveDefaultPrice(
    form: ListingCardSummary,
    price: number | null,
    fieldKey: "price" | "old_price" = "price",
  ): Promise<boolean | undefined> {
    if (busy || savingPriceId || form.supplier_unavailable) return undefined
    if (
      defaultPricePairRejected(
        price,
        fieldKey,
        fieldKey === "price" ? form.old_price : form.price,
      )
    ) {
      notifyError(
        fieldKey === "price" ? "销售价需小于划线价。" : "划线价需大于销售价。",
      )
      return false
    }
    setSavingPriceId(form.draft_id)
    try {
      const saved = await listingCardSaveDefaultPrice(
        form.draft_id,
        price,
        fieldKey,
      )
      setForms((current) => upsertSavedForm(current, saved))
      await syncRowsForDefaultField(
        form.draft_id,
        fieldKey,
        price == null ? undefined : { kind: "decimal", value: price },
      )
      // The price itself is stored; a row-sync complaint is its own toast, not
      // a reason for the cell to distrust the saved value.
      return true
    } catch (reason) {
      notifyCommandError(
        reason,
        fieldKey === "price"
          ? "无法保存销售价，请稍后重试。"
          : "无法保存划线价，请稍后重试。",
      )
      return false
    } finally {
      setSavingPriceId(undefined)
    }
  }

  /** 名册里主题 / JSON富内容 两列的写入口。 */
  async function saveDefaultFieldValue(
    form: ListingCardSummary,
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
  ): Promise<boolean | undefined> {
    return saveDefaultField(
      form,
      fieldKey,
      value,
      "无法保存方案默认值，请稍后重试。",
    )
  }

  /** One Card's Category Schema for the 主题 picker; the flight cache dedupes. */
  function loadCardSchema(form: ListingCardSummary): Promise<CategorySchemaView> {
    return categorySchemaFlight({
      description_category_id: form.description_category_id,
      type_id: form.type_id,
      language: form.language as CategorySchemaView["language"],
      target_store_id: form.target_store_id.split(",")[0]?.trim() || undefined,
    })
  }

  /**
   * The table cell's direct store rebind. Rows already produced
   * keep their Store; only the Card's target list moves.
   */
  async function bindCardStores(
    form: ListingCardSummary,
    storeIds: readonly string[],
  ): Promise<boolean> {
    const nextStoreId = formatStoreIds(storeIds)
    if (nextStoreId === formatStoreIds(parseStoreIds(form.target_store_id))) {
      return true
    }
    if (busy || form.supplier_unavailable) return false
    try {
      const saved = await listingCardSaveStore(
        form.draft_id,
        nextStoreId,
      )
      setForms((current) => upsertSavedForm(current, saved))
      return true
    } catch (reason) {
      notifyCommandError(reason, "无法保存店铺绑定，请稍后重试。")
      return false
    }
  }

  /**
   * The name cell's PSD rebind. The picker opens the system file chooser and
   * the bytes are staged into OPFS before the digest binds. On a supplier
   * softlink a non-empty digest outranks the online template, and clearing it
   * hands the field back to the supplier.
   */
  async function bindCardPsd(form: ListingCardSummary) {
    if (busy || savingPsdId || form.supplier_unavailable) return
    setSavingPsdId(form.draft_id)
    const controller = new AbortController()
    try {
      const managed = await renderOpfs.workflowPickTemplatePsd({
        signal: controller.signal,
        onFile: (file) => beginPsdTransfer({
          draftId: form.draft_id,
          fileName: file.name,
          abort: () => controller.abort(),
        }),
        onProgress: (loaded, total) => notePsdHash(form.draft_id, loaded, total),
      })
      acceptUserTemplate(managed.asset_id)
      linkPsdTransfer(form.draft_id, managed.asset_id, () => cancelUserTemplate(managed.asset_id))
      const saved = await listingCardSavePsd(
        form.draft_id,
        managed.asset_id,
        managed.asset.file_name,
      )
      setForms((current) => upsertSavedForm(current, saved))
    } catch (reason) {
      if (commandCode(reason) !== "workflow_template_cancelled") {
        notifyCommandError(reason, "无法保存 PSD 绑定，请稍后重试。")
        failPsdTransfer(form.draft_id, () => void bindCardPsd(form), reason)
      } else {
        clearPsdTransfer(form.draft_id)
      }
    } finally {
      setSavingPsdId(undefined)
    }
  }

  async function clearCardPsd(form: ListingCardSummary) {
    if (busy || savingPsdId || form.supplier_unavailable) return
    setSavingPsdId(form.draft_id)
    try {
      const saved = await listingCardSavePsd(form.draft_id, "", "")
      setForms((current) => upsertSavedForm(current, saved))
    } catch (reason) {
      notifyCommandError(reason, "无法清除 PSD 绑定，请稍后重试。")
    } finally {
      setSavingPsdId(undefined)
    }
  }

  async function refreshCategoryTree(options?: { force?: boolean }) {
    if (treeBusy) return
    setTreeBusy(true)
    try {
      const requestedStoreId = composing
        ? schemaStoreId(composeStoreId)
        : fallbackStoreId || undefined
      const tree = await loadCategoryTree({
        force: options?.force,
        storeId: requestedStoreId,
      })
      setCategoryTree(tree)
      clearLive(CATEGORY_TREE_LIVE)
    } catch (reason) {
      console.error("workflow/category: 类目树刷新失败", reason)
      notifyLive({
        id: CATEGORY_TREE_LIVE,
        type: "error",
        title: commandError(reason, "无法刷新 Ozon 类目树，请稍后重试。"),
        reason,
        action: { label: "重试", onClick: () => void refreshCategoryTree({ force: true }) },
      })
      // Keep the previous local cache so the form stays usable.
    } finally {
      setTreeBusy(false)
    }
  }

  async function refreshPromptLeaves(options?: { silent?: boolean }) {
    setPromptLeavesBusy(true)
    try {
      const rows = await listingHttp.listingCardListPromptLeaves()
      setPromptLeaves(
        rows.map((row) => ({
          descriptionCategoryId: row.description_category_id,
          typeId: row.type_id,
        })),
      )
    } catch (reason) {
      setPromptLeaves([])
      if (!options?.silent) {
        notifyCommandError(reason, "无法加载可用类目，请稍后重试。")
      }
    } finally {
      setPromptLeavesBusy(false)
    }
  }

  function resetComposeState() {
    setComposeSaving(false)
    setComposeName("")
    setComposeStoreId("")
    setComposeSelection(emptyTreeSelection())
    setComposePsdAssetId("")
    setComposePsdFileName("")
    setComposePrompts([])
    setComposePromptId("")
    setComposePendingVideos([])
    setComposeVideoPhase("idle")
  }

  async function loadCategoryPrompts(
    descriptionCategoryId: number,
    typeId: number,
    throwOnError = false,
  ): Promise<WorkflowCategoryPrompt[]> {
    if (descriptionCategoryId <= 0 || typeId <= 0) return []
    try {
      return await listingHttp.listingCardListCategoryPrompts(
        descriptionCategoryId,
        typeId,
      )
    } catch (reason) {
      if (throwOnError) throw reason
      notifyCommandError(reason, "无法加载该类目提示词，请稍后重试。")
      return []
    }
  }

  /**
   * A pooled video joins the pending list as a public-URL item; confirming it
   * attaches the existing S3 object instead of uploading bytes again.
   */
  function poolPendingVideo(video: WorkflowCategoryVideo): PendingVideoItem {
    const fileName = video.video_url.split("/").pop()?.split("?")[0] || `${video.name}.mp4`
    return {
      asset_handle: `pool:${video.video_id}`,
      status: "pending",
      metadata: {
        role: "product",
        origin: "public_url",
        file_name: fileName,
        content_type: fileName.toLowerCase().endsWith(".mov")
          ? "video/quicktime"
          : "video/mp4",
        size_bytes: 0,
        duration_ms: video.duration_ms,
        public_url: video.video_url,
        object_key: undefined,
        content_hash: undefined,
      },
    }
  }

  function identityOfVideo(video: WorkflowVideoMetadata): string | undefined {
    return video.content_hash ?? video.public_url
  }

  function appendPoolVideo(
    video: WorkflowCategoryVideo,
    current: PendingVideoItem[],
    apply: (next: PendingVideoItem[]) => void,
    alreadyBound: number,
  ) {
    const item = poolPendingVideo(video)
    if (current.some((pending) => pending.asset_handle === item.asset_handle)) return
    if (alreadyBound + current.length >= 15) {
      notifyError("这个上架方案最多只能包含 15 个视频。")
      return
    }
    apply([...current, item])
  }

  async function refreshComposePrompts() {
    const { descriptionCategoryId, typeId } = composeSelection
    if (descriptionCategoryId <= 0 || typeId <= 0 || composePromptRefreshBusy) return
    setComposePromptRefreshBusy(true)
    try {
      const prompts = await loadCategoryPrompts(descriptionCategoryId, typeId, true)
      setComposePrompts(prompts)
    } catch (reason) {
      notifyCommandError(reason, "无法刷新提示词，请稍后重试。")
    } finally {
      setComposePromptRefreshBusy(false)
    }
  }

  function cancelCompose() {
    setComposing(false)
    resetComposeState()
  }

  function selectComposeL1(l1Id: number) {
    setComposeSelection({
      l1Id,
      l2Id: 0,
      descriptionCategoryId: 0,
      typeId: 0,
    })
    setComposePrompts([])
    setComposePromptId("")
  }

  function selectComposeL2(l2Id: number) {
    setComposeSelection((current) => ({
      ...current,
      l2Id,
      descriptionCategoryId: 0,
      typeId: 0,
    }))
    setComposePrompts([])
    setComposePromptId("")
  }

  function selectComposeStore(storeId: string) {
    setComposeStoreId(storeId)
  }

  function selectComposeType(descriptionCategoryId: number, nextTypeId: number) {
    const leaf = resolveLeaf(descriptionCategoryId, nextTypeId, categoryTree)
    setComposeSelection(
      leaf
        ? selectionFromLeaf(leaf)
        : {
            l1Id: 0,
            l2Id: descriptionCategoryId,
            descriptionCategoryId,
            typeId: nextTypeId,
          },
    )
    setComposePromptId("")
    void loadCategoryPrompts(descriptionCategoryId, nextTypeId).then(
      setComposePrompts,
    )
  }

  async function applyComposePsd(
    load: () => Promise<{ asset_id: string; asset: { file_name: string } }>,
  ) {
    setComposeBusy(true)
    try {
      const managed = await load()
      setComposePsdAssetId(managed.asset_id)
      setComposePsdFileName(managed.asset.file_name)
    } catch (reason) {
      notifyCommandError(reason, "无法保存这份 PSD 模板，请稍后重试。")
    } finally {
      setComposeBusy(false)
    }
  }

  async function pickComposePsd() {
    await applyComposePsd(() => renderOpfs.workflowPickTemplatePsd())
  }

  async function pickComposeVideos() {
    if (composeBusy) return
    const selectionLimit = 15 - composePendingVideos.length
    if (selectionLimit <= 0) {
      notifyError("这个上架方案最多只能包含 15 个视频。")
      return
    }
    setComposeVideoPhase("selecting")
    setComposeBusy(true)
    try {
      const picked = await workflowActions.workflowPickVideo({
        draft_id: undefined,
        role: "product",
        paths: [],
        selection_limit: selectionLimit,
      })
      setComposePendingVideos((current) => {
        const known = new Set(current.map((video) => video.asset_handle))
        return [
          ...current,
          ...picked
            .filter((video) => !known.has(video.asset_handle))
            .map((video) => ({ ...video, status: "pending" as const })),
        ]
      })
    } catch (reason) {
      if (commandCode(reason) !== "workflow_video_cancelled") {
        notifyCommandError(reason, "无法读取视频。请检查格式和时长后重新选择。")
      }
    } finally {
      setComposeVideoPhase("idle")
      setComposeBusy(false)
    }
  }

  function removePendingComposeVideo(assetHandle: string) {
    if (composeBusy) return
    setComposePendingVideos((current) => current.filter(
      (video) => video.asset_handle !== assetHandle,
    ))
  }

  // 上架基础信息 gates the save: name, 商品类型 leaf and prompt. 店铺 and PSD
  // are bindings the workbench refuses 准备 / 发送 without, not preconditions
  // of the Card's existence (`bindFormIssues`).
  async function saveCompose(uploadVideos = false) {
    const { descriptionCategoryId, typeId: nextTypeId } = composeSelection
    if (!composeName.trim()) {
      notifyError("请填写卡片名称。")
      return
    }
    if (descriptionCategoryId <= 0 || nextTypeId <= 0) {
      notifyError("请选定三级类目。")
      return
    }
    const prompt = composePrompts.find(
      (item) => item.prompt_id === composePromptId,
    )
    if (!prompt?.prompt_id || !prompt.name.trim()) {
      notifyError("请选择本类目提示词。")
      return
    }
    const accountPromise = accountHttp.accountGetOverview().catch((reason) => {
      notifyCommandError(reason, "创建上架方案前无法核验登录状态。")
      return undefined
    })
    const schemaPromise = listingHttp.listingCardLoadCategorySchema({
      description_category_id: descriptionCategoryId,
      type_id: nextTypeId,
      language: "zh_hans",
      target_store_id: schemaStoreId(composeStoreId),
    })
    const account = await accountPromise
    if (!account || composeBlockedBySignedOut(account)) {
      void schemaPromise.catch(() => {})
      if (!account) return
      notifyError("尚未登录，请先登录后再创建上架方案。")
      return
    }
    setComposeSaving(true)
    setComposeBusy(true)
    setComposeSavingLabel("正在获取类目字段…")
    try {
      const nextSchema = await schemaPromise
      setComposeSavingLabel("正在保存卡片…")
      const nextDraft = createWorkflowDraft(nextSchema)
      const displayName = composeName.trim()
      const saved = await listingCardSaveCategoryDraft({
        draft_id: undefined,
        display_name: displayName,
        schema: schemaRequest(nextSchema),
        draft: nextDraft,
        ai_prompt_id: prompt.prompt_id,
        ai_prompt: prompt.content ?? "",
        ai_prompt_file_name: prompt.file_name,
        psd_template_asset_id: composePsdAssetId,
        psd_template_file_name: composePsdFileName,
        target_store_id: composeStoreId,
        ai_allowed_field_keys: [],
        createMode: "blank",
      })
      setForms((current) => upsertSavedForm(current, cardSummaryFromDraft(saved)))
      const pendingVideos = uploadVideos ? composePendingVideos : []
      onCardSaved()
      setComposing(false)
      resetComposeState()
      // The card exists the moment it is written; the S3 transfers keep running
      // behind the closed dialog and report on the card tile instead.
      if (pendingVideos.length) {
        void uploadCardVideos(saved.draft_id, displayName, pendingVideos)
      }
    } catch (reason) {
      notifyCommandError(reason, "无法创建上架方案，请稍后重试。")
    } finally {
      setComposeBusy(false)
      setComposeSaving(false)
      setComposeSavingLabel(undefined)
    }
  }

  async function uploadComposeVideos() {
    if (!composePendingVideos.length) return
    await saveCompose(true)
  }

  /**
   * The exact video that just landed is what the batch attach command
   * propagates. `VideoAttached` dedupes by content identity: instances that already
   * inherited the video at import time are untouched. Returns how many
   * instances could not be repaired.
   */
  async function rebindLandedVideoToInstances(
    draftId: string,
    videoIdentity: string,
  ): Promise<number> {
    const scope = listingWorkbenchScope()
    let targets: string[]
    try {
      targets = (await workflowActions.listingCardListProductInstances(draftId))
        .map((instance) => instance.draft_id)
    } catch {
      return 0
    }
    if (!targets.length) return 0
    let failed = 0
    const rebound: WorkflowMediaBindingResult[] = []
    for (const slice of chunkItems(targets, MUTATION_BATCH)) {
      try {
        rebound.push(
          ...(await workflowActions.listingCardAttachVideoToProducts({
            card_draft_id: draftId,
            target_draft_ids: slice,
            role: "product",
            video_identity: videoIdentity,
          })),
        )
      } catch {
        failed += slice.length
      }
    }
    failed += rebound.filter((result) => !result.lifecycle).length
    if (rebound.some((result) => result.lifecycle)) {
      projectListingProducts((current) => {
        const next = { ...current }
        for (const result of rebound) {
          if (result.lifecycle && next[result.draft_id]) {
            next[result.draft_id] = {
              ...next[result.draft_id]!,
              lifecycle: result.lifecycle,
            }
          }
        }
        return next
      }, scope)
    }
    return failed
  }

  // Uploads every confirmed video for one card, one at a time: after each
  // landing that exact video is rebound onto already-imported products.
  // Runs detached from the create dialog, so the card tile
  // shows progress while 上架 stays open; only 复制/删除 wait for the
  // last byte. The S3 delivery lane admits two transfers per media account
  // anyway, so serializing costs little.
  async function uploadCardVideos(
    draftId: string,
    cardName: string,
    pending: PendingVideoItem[],
  ) {
    setVideoUploads((current) => ({
      ...current,
      [draftId]: { done: 0, total: pending.length },
    }))
    let failedCount = 0
    let repairFailedCount = 0
    for (const candidate of pending) {
      try {
        // A pooled video already lives in S3; attaching it skips the transfer.
        const result = candidate.metadata.origin === "public_url"
          ? {
              metadata: candidate.metadata,
              lifecycle: await workflowActions.listingCardAttachVideo({
                draft_id: draftId,
                metadata: candidate.metadata,
              }),
            }
          : await workflowActions.listingCardUploadVideo({
            draft_id: draftId,
            role: "product",
            asset_handle: candidate.asset_handle,
          })
        const { lifecycle, metadata } = result
        setForms((current) => current.map((form) =>
          form.draft_id === draftId
            ? {
                ...form,
                video_count: Math.max(
                  form.video_count,
                  lifecycle.product_videos.length,
                ),
              }
            : form,
        ))
        const identity = identityOfVideo(metadata)
        repairFailedCount += identity
          ? await rebindLandedVideoToInstances(draftId, identity)
          : 1
      } catch {
        failedCount += 1
      } finally {
        setVideoUploads((current) => {
          const track = current[draftId]
          if (!track) return current
          return { ...current, [draftId]: { ...track, done: track.done + 1 } }
        })
      }
    }
    setVideoUploads((current) => {
      const next = { ...current }
      delete next[draftId]
      return next
    })
    if (failedCount) {
      notifyError(`「${cardName}」有 ${failedCount} 个视频上传失败。`)
    }
    if (repairFailedCount) {
      notifyError(
        `「${cardName}」有 ${repairFailedCount} 次已导入商品视频补绑失败。`,
      )
    }
  }

  const composeCategoryTree = useMemo(
    () => promptBackedTree(categoryTree, promptLeaves),
    [categoryTree, promptLeaves],
  )
  useEffect(() => {
    const noPromptBackedCategories =
      composing &&
      !treeBusy &&
      !promptLeavesBusy &&
      categoryTree.length > 0 &&
      composeCategoryTree.length === 0
    if (!noPromptBackedCategories) {
      clearLive(COMPOSE_TREE_EMPTY_LIVE)
      return
    }
    notifyLive({
      id: COMPOSE_TREE_EMPTY_LIVE,
      type: "info",
      title: "还没有配置可用类目。请先在平台为类目添加提示词。",
    })
    return () => clearLive(COMPOSE_TREE_EMPTY_LIVE)
  }, [composing, treeBusy, promptLeavesBusy, categoryTree.length, composeCategoryTree.length])

  return (
    <CardLibrary
      forms={forms}
      videoUploads={videoUploads}
      busy={busy || composeBusy}
      composing={composing}
      composeBusy={composeBusy}
      composeSaving={composeSaving}
      composeSavingLabel={composeSavingLabel}
      composeName={composeName}
      composeSelection={composeSelection}
      composeStoreId={composeStoreId}
      stores={ozonStores}
      composePsdFileName={composePsdFileName}
      composePrompts={composePrompts}
      composePromptId={composePromptId}
      composePromptRefreshBusy={composePromptRefreshBusy}
      composePendingVideos={composePendingVideos}
      composePoolVideos={composePoolVideos}
      composeVideoPhase={composeVideoPhase}
      copyingCardId={copyingCardId}
      categoryTree={composing ? composeCategoryTree : categoryTree}
      treeBusy={treeBusy || (composing && promptLeavesBusy)}
      onComposeNameChange={setComposeName}
      onComposeStoreChange={selectComposeStore}
      onSelectL1={selectComposeL1}
      onSelectL2={selectComposeL2}
      onSelectType={selectComposeType}
      onRefreshCategoryTree={() => {
        void refreshCategoryTree({ force: true })
        if (composing) void refreshPromptLeaves()
      }}
      onPickComposePsd={() => void pickComposePsd()}
      onComposePromptChange={setComposePromptId}
      onRefreshComposePrompts={() => void refreshComposePrompts()}
      onPickComposeVideos={() => void pickComposeVideos()}
      onPickComposePoolVideo={(video) =>
        appendPoolVideo(video, composePendingVideos, setComposePendingVideos, 0)
      }
      onUploadComposeVideos={() => void uploadComposeVideos()}
      onRemovePendingComposeVideo={removePendingComposeVideo}
      onCancelCompose={cancelCompose}
      onSaveCompose={() => void saveCompose()}
      onRun={(form) => onRun(form)}
      onCopy={(form) => void copySavedForm(form)}
      highlightDraftId={highlightDraftId}
      onDelete={(form) => void deleteSavedForm(form)}
      onOpenStores={onOpenStores}
      onOpenCatalog={onOpenCatalog}
      onBindStores={(form, storeIds) => bindCardStores(form, storeIds)}
      onBindPsd={(form) => void bindCardPsd(form)}
      onClearPsd={(form) => void clearCardPsd(form)}
      savingPsdId={savingPsdId}
      onSavePrice={(form, price) => saveDefaultPrice(form, price)}
      onSaveOldPrice={(form, price) => saveDefaultPrice(form, price, "old_price")}
      savingPriceId={savingPriceId}
      onSaveDefaultField={saveDefaultFieldValue}
      savingDefaultFieldId={savingDefaultFieldId}
      onLoadCardSchema={loadCardSchema}
    />
  )
}
