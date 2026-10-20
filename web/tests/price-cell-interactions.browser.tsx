// Dev-only price-cell / highlight checks. The real CardLibrary is mounted;
// host bindings are stubbed so save verdicts are scriptable.
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import type { ListingCardSummary } from "@/bindings/commands"
import { CardLibrary } from "@/features/workflow/card-library"
import { emptyTreeSelection } from "@/features/category-schema/category-tree"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!

window.fetch = async (input) => {
  throw new Error(`Unexpected network request: ${input}`)
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() {
  await frame()
  await frame()
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function noop() {
  return undefined
}

const baseCard = (over: Partial<ListingCardSummary>): ListingCardSummary => ({
  draft_id: "card-1",
  display_name: "夏季T恤",
  description_category_id: 11,
  type_id: 22,
  language: "zh_hans",
  ai_prompt_file_name: "prompt.txt",
  psd_template_file_name: "tee.psd",
  target_store_id: "store-1",
  video_count: 0,
  updated_at_ms: 1_700_000_000_000,
  ...over,
})

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
}
function press(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
}
async function blur(input: HTMLInputElement) {
  input.blur()
  await settle()
}

type PriceSave = (form: ListingCardSummary, price: number | null) => Promise<boolean | undefined>

function libraryProps(over: {
  forms: ListingCardSummary[]
  onSavePrice: PriceSave
  highlightDraftId?: string
}) {
  return (
    <CardLibrary
      forms={over.forms}
      videoUploads={{}}
      busy={false}
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
      onSavePrice={over.onSavePrice}
      onSaveOldPrice={over.onSavePrice}
      onSaveDefaultField={async () => undefined}
      onLoadCardSchema={async () => {
        throw new Error("no schema in the price fixture")
      }}
      highlightDraftId={over.highlightDraftId}
    />
  )
}

let root: Root | undefined
function mount(node: React.ReactNode) {
  if (!root) root = createRoot(fixture)
  flushSync(() => root!.render(node))
}

const log: string[] = []
async function step(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    log.push(`✓ ${name}`)
  } catch (error) {
    log.push(`✗ ${name}\n  ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

async function main() {
  // --- S1: the wiring the walkthrough bug lived in — the real CardLibrary
  // table cell against a scripted host verdict. ---
  const saves: Array<{ form: string; price: number | null }> = []
  const refuse: PriceSave = async (form, price) => {
    saves.push({ form: form.draft_id, price })
    return false
  }

  await step("S1 空划线价 + 销售价 60：不被预检拦截，onSave 收到 (card-1, 60)", async () => {
    mount(libraryProps({ forms: [baseCard({})], onSavePrice: refuse }))
    const input = document.querySelector<HTMLInputElement>('input[aria-label="销售价 夏季T恤"]')
    check(input, "销售价输入框必须存在")
    input.focus()
    setInput(input, "60")
    await blur(input)
    check(
      saves.length === 1 && saves[0]!.form === "card-1" && saves[0]!.price === 60,
      `onSave 记录应为 card-1/60，实际 ${JSON.stringify(saves)}`,
    )
  })

  await step("S1 保存被拒：输入保留 60 且 aria-invalid=true（不静默回滚）", () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="销售价 夏季T恤"]')!
    check(input.value === "60", `失败后输入应保留 60，实际 ${JSON.stringify(input.value)}`)
    check(
      input.getAttribute("aria-invalid") === "true",
      `失败后应标 aria-invalid="true"，实际 ${input.getAttribute("aria-invalid")}`,
    )
  })

  await step("S1 Escape：丢弃草稿恢复原值并清 invalid", async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="销售价 夏季T恤"]')!
    input.focus()
    setInput(input, "99")
    press(input, "Escape")
    await settle()
    check(input.value === "", `Escape 后应恢复原值（空），实际 ${JSON.stringify(input.value)}`)
    check(!input.hasAttribute("aria-invalid"), "Escape 后 aria-invalid 应清除")
  })

  // --- S3: the highlight target is pinned through a stale filter, while the
  // filter keeps answering for every other row. ---
  await step("S3 highlight 目标行穿透不匹配筛选，其余行照常过滤", async () => {
    mount(
      libraryProps({
        forms: [
          baseCard({ draft_id: "card-1", display_name: "夏季T恤" }),
          baseCard({ draft_id: "card-2", display_name: "冬季卫衣" }),
        ],
        onSavePrice: async () => true,
        highlightDraftId: "card-2",
      }),
    )
    await settle()
    const search = document.querySelector<HTMLInputElement>('input[aria-label="搜索上架方案"]')
    check(search, "搜索框必须存在")
    check(
      document.querySelector('[data-listing-card="card-2"]')?.getAttribute("data-highlighted") ===
        "true",
      "目标行必须带 data-highlighted",
    )
    setInput(search, "不存在的词")
    await settle()
    check(
      document.querySelector('[data-listing-card="card-2"]') !== null,
      "目标行必须穿透筛选保持可见",
    )
    check(
      document.querySelector('[data-listing-card="card-1"]') === null,
      "不匹配的其余行应被过滤",
    )
  })
}

run.addEventListener("click", () => {
  log.length = 0
  results.textContent = "运行中…"
  main()
    .then(() => {
      results.textContent = log.join("\n")
    })
    .catch(() => {
      results.textContent = `${log.join("\n")}\n\n检查失败`
    })
})
