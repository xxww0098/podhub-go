import { renderToStaticMarkup } from "react-dom/server"
import type { ListingCardSummary } from "@/bindings/commands"
import { emptyTreeSelection } from "@/features/category-schema/category-tree"
import { CardLibrary } from "./card-library"

export const sampleCard: ListingCardSummary = {
  draft_id: "card-1",
  display_name: "夏季T恤",
  description_category_id: 11,
  type_id: 22,
  language: "zh_hans",
  size: "40x50",
  ai_prompt_file_name: "prompt.txt",
  psd_template_file_name: "tee.psd",
  target_store_id: "store-1",
  video_count: 2,
  updated_at_ms: 1_700_000_000_000,
}

function noop() {
  return undefined
}

/** Price saves in these fixtures never leave the page: no verdict. */
const noopPriceSave = () => Promise.resolve(undefined)

/** The default-field columns only read the schema on open; fixtures never open it. */
const noSchema = async () => {
  throw new Error("no schema in fixtures")
}

export function renderLibrary(
  forms: ListingCardSummary[] = [sampleCard],
  videoUploads: Record<string, { done: number; total: number }> = {},
  options: {
    bindStores?: boolean
    bindPsd?: boolean
    busy?: boolean
    highlightDraftId?: string
  } = {},
) {
  return renderToStaticMarkup(
    <CardLibrary
      forms={forms}
      videoUploads={videoUploads}
      busy={options.busy ?? false}
      highlightDraftId={options.highlightDraftId}
      composing={false}
      composeBusy={false}
      composeSaving={false}
      composeName=""
      composeSelection={emptyTreeSelection()}
      composeStoreId=""
      stores={[]}
      composePsdFileName=""
      composePrompts={[]}
      composePromptId=""
      composePendingVideos={[]}
      composePoolVideos={[]}
      composeVideoPhase="idle"
      categoryTree={[]}
      treeBusy={false}
      onComposeNameChange={noop}
      onComposeStoreChange={noop}
      onSelectL1={noop}
      onSelectL2={noop}
      onSelectType={noop}
      onRefreshCategoryTree={noop}
      onPickComposePsd={noop}
      onComposePromptChange={noop}
      onPickComposeVideos={noop}
      onPickComposePoolVideo={noop}
      onUploadComposeVideos={noop}
      onRemovePendingComposeVideo={noop}
      onCancelCompose={noop}
      onSaveCompose={noop}
      onRun={noop}
      onCopy={noop}
      onDelete={noop}
      onOpenCatalog={noop}
      onSavePrice={noopPriceSave}
      onSaveOldPrice={noopPriceSave}
      onSaveDefaultField={noopPriceSave}
      onLoadCardSchema={noSchema}
      {...(options.bindStores
        ? { onBindStores: async () => true }
        : {})}
      {...(options.bindPsd
        ? { onBindPsd: noop, onClearPsd: noop }
        : {})}
    />,
  )
}
