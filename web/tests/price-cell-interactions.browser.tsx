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

  await step("S4 分页保留跨页选择，搜索返回第一页", async () => {
    const forms = Array.from({ length: 25 }, (_, index) => baseCard({
      draft_id: `paged-${index}`,
      display_name: `方案 ${index}`,
    }))
    mount(libraryProps({ forms, onSavePrice: async () => true }))
    const search = document.querySelector<HTMLInputElement>('input[aria-label="搜索上架方案"]')!
    setInput(search, "")
    await settle()
    check(document.querySelectorAll("[data-listing-card]").length === 20, "第一页应有 20 条")
    document.querySelector<HTMLElement>('[aria-label="选择 方案 0"]')!.click()
    document.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click()
    await settle()
    check(document.querySelectorAll("[data-listing-card]").length === 5, "第二页应有 5 条")
    document.querySelector<HTMLElement>('[aria-label="选择 方案 20"]')!.click()
    await settle()
    check(fixture.textContent?.includes("已选 2 个方案"), "跨页选择应一起计数")
    document.querySelector<HTMLButtonElement>('[aria-label="上一页"]')!.click()
    await settle()
    check(document.querySelector('[aria-label="选择 方案 0"]')?.getAttribute("aria-checked") === "true", "返回后第一页选择仍在")
    document.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click()
    await settle()
    setInput(search, "方案 24")
    await settle()
    check(document.querySelector('[data-listing-card="paged-24"]'), "搜索应从第一页显示匹配行")
    check(document.querySelector<HTMLButtonElement>('[aria-label="下一页"]')?.disabled, "筛选结果只有一页")
  })

  await step("S5 供应商商品显示目录返回的封面和编号", async () => {
    window.fetch = async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href)
      if (url.pathname !== "/api/supplier-dbs/catalog") throw new Error(`Unexpected network request: ${url}`)
      return Response.json({ data: { dbs: [], propDefs: [], rows: [
        { productId: "supplier-1", platformCode: "TEE-01", gallery: [{ url: "/app-icon.svg", w: 28, h: 28 }] },
      ] } })
    }
    mount(libraryProps({ forms: [baseCard({ supplier_product_id: "supplier-1" })], onSavePrice: async () => true }))
    setInput(document.querySelector<HTMLInputElement>('input[aria-label="搜索上架方案"]')!, "")
    await settle()
    const image = document.querySelector<HTMLImageElement>('img[alt="夏季T恤 商品图片"]')
    check(image?.getAttribute("src") === "/app-icon.svg", "封面必须来自该商品的目录记录")
    check(fixture.textContent?.includes("编号：TEE-01"), "编号必须来自该商品的目录记录")
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
