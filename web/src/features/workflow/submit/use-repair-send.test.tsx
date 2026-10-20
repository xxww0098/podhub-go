import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { AccountOverview, WorkflowDraftView } from "@/bindings/commands"
import { toast } from "@/components/ui/toast"
import { invalidateAccountOverview, rememberAccountOverview } from "@/features/account/account-overview-cache"
import { resetCardSessions } from "../card/card-session"
import type { ListingRow } from "../model/listing-row"
import { createPreparationTracks } from "../prepare/preparation-tracks"
import { patchListingWorkbench, resetListingWorkbench } from "../workbench/listing-workbench-store"
import { usePublishQueue } from "./use-publish-queue"
import type { BrandRepairCapability } from "./use-repair-publish"

const SIGNED_IN: AccountOverview = {
  session: { authenticated: true },
  workspaces: [],
  owned_count: 0,
  owned_limit: 0,
}

test("clearing a brand-tag conflict sends those rows on the same click", async () => {
  resetListingWorkbench()
  resetCardSessions()
  invalidateAccountOverview()
  rememberAccountOverview(SIGNED_IN)
  const notices: string[] = []
  const previousAdd = toast.add
  const previousFetch = globalThis.fetch
  toast.add = ((notice: { title?: unknown }) => {
    notices.push(String(notice.title))
    return "notice"
  }) as typeof toast.add
  globalThis.fetch = (async () => {
    throw new Error("submit transport is past the send notice")
  }) as typeof fetch
  const capability: BrandRepairCapability = {
    current: () => true,
    clearSearchTagsAndRevalidate: async () => ({
      current: () => true,
      status: {
        draft_id: "draft-A",
        target_store_id: "store",
        lifecycle: { revision: 2, view_revision: 2, stage: "ready_to_publish", fields: "valid", ai: "ready", media: "ready" },
        readiness: { ready_to_publish: true, can_start_publish_attempt: true, blockers: [], allowed_actions: ["publish"] },
      } as never,
    }),
  }
  let hook!: ReturnType<typeof usePublishQueue>
  function Capture() {
    hook = usePublishQueue({
      cardTemplateId: "card",
      brandRepairCapability: capability,
      busy: false,
      storeConfigured: true,
      preparationTracks: { current: createPreparationTracks() },
      guidedPreparationLock: { current: false },
      flushAutosave: async () => false,
      flushAutosavesFor: async () => true,
    })
    return null
  }
  renderToStaticMarkup(<Capture />)
  const issue = {
    code: "OZON_ROW_REJECTED", phase: "submit", allowed_actions: ["edit_row"], input_revision: 1,
    dispatch_evidence: "rejected", row_id: "draft-A", store_id: "store", intent_id: "intent", resolved_at_ms: null,
  }
  const row: ListingRow = {
    id: "A", draftId: "draft-A", imageName: "A.png", status: "failed", ai: "idle", render: "idle", upload: "idle", log: "",
    readiness: { ready_to_publish: false, can_start_publish_attempt: true, blockers: ["publish_conflict"], allowed_actions: ["publish"] },
  }
  patchListingWorkbench({
    rows: [row],
    productDrafts: {
      "draft-A": {
        draft_id: "draft-A",
        target_store_id: "store",
        draft: { values: { offer_id: { kind: "text", value: "A" } }, cleared: [], complex_values: [] },
        lifecycle: {
          revision: 1, view_revision: 1, stage: "publish_rejected", fields: "valid",
          last_error_code: "BR_hashtag_brand", ai: "ready", media: "ready", submission_issue: issue,
        },
      } as unknown as WorkflowDraftView,
    },
  })
  try {
    await hook.repairRows(["A"])
    const shown = notices.join("\n")
    assert.match(shown, /已清空 1 件商品的违规搜索标签/)
    assert.match(shown, /正在提交 1 件商品发送/)
  } finally {
    globalThis.fetch = previousFetch
    toast.add = previousAdd
    invalidateAccountOverview()
    resetCardSessions()
    resetListingWorkbench()
  }
})
