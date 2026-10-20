import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ListingCardActions,
  listingCardMatchesQuery,
  listingCardVisibleForms,
} from "./card-library"
import { renderLibrary, sampleCard } from "./card-library-test-support"

function renderActions(props: { busy?: boolean; uploading?: boolean }) {
  return renderToStaticMarkup(
    <ListingCardActions
      title="测试卡"
      busy={props.busy ?? false}
      uploading={props.uploading}
      dimmed={false}
      copying={false}
      onRun={() => undefined}
      onCopy={() => undefined}
      onDelete={() => undefined}
    />,
  )
}

function buttonFor(html: string, ariaLabel: string): string {
  const labelAt = html.indexOf(`aria-label="${ariaLabel}"`)
  assert.notEqual(labelAt, -1, `${ariaLabel} 按钮必须存在`)
  const start = html.lastIndexOf("<button", labelAt)
  return html.slice(start, html.indexOf(">", labelAt))
}

test("行内上架是带文案的描边按钮，不是幽灵图标", () => {
  const html = renderActions({})
  const labelAt = html.indexOf('aria-label="上架 测试卡"')
  assert.notEqual(labelAt, -1)
  const start = html.lastIndexOf("<button", labelAt)
  const end = html.indexOf("</button>", labelAt)
  const button = html.slice(start, end + "</button>".length)
  assert.match(button, /border-border/)
  assert.match(button, /<\/svg>上架<\/button>/)
})

test("背景视频上传中 上架 仍可点击，复制/删除 保持锁定", () => {
  const html = renderActions({ uploading: true })

  assert.doesNotMatch(
    buttonFor(html, "上架 测试卡"),
    / disabled=""/,
    "上传中不得阻塞打开上架方案",
  )
  for (const label of ["复制 测试卡", "删除 测试卡"]) {
    assert.match(
      buttonFor(html, label),
      / disabled=""/,
      `上传完成前 ${label} 必须锁定`,
    )
  }
})

test("busy 时 上架 与其余按钮一起锁定", () => {
  const html = renderActions({ busy: true })
  assert.match(buttonFor(html, "上架 测试卡"), / disabled=""/)
})

test("上架方案名册是 shadcn Table，不再是卡片网格", () => {
  const html = renderLibrary()
  assert.match(html, /<table[\s>]/)
  assert.match(html, /<tr[\s>]/)
  assert.match(html, /aria-label="选择全部上架方案"/)
  assert.match(html, /aria-label="选择 夏季T恤"/)
  assert.match(html, /aria-label="搜索上架方案"/)
  assert.match(html, /placeholder="搜索名称、规格、类目或店铺"/)
  assert.doesNotMatch(html, /aria-label="批量操作"/)
  assert.doesNotMatch(html, /<th[^>]*>主图</)
  assert.match(html, /<th[^>]*scope="col"[^>]*>名称</)
  assert.match(html, /<th[^>]*>规格与提示词</)
  assert.match(html, /<th[^>]*>销售价</)
  assert.match(html, /aria-label="销售价 夏季T恤"/)
  assert.match(html, /<th[^>]*>类目</)
  assert.match(html, /<th[^>]*>店铺</)
  assert.doesNotMatch(html, /<th[^>]*>保存时间</)
  assert.doesNotMatch(html, /<th[^>]*>上传进度</)
  assert.match(html, /<th[^>]*>操作</)
  assert.match(html, /data-testid="card-store-chips"/)
  assert.match(html, />夏季T恤</)
  assert.doesNotMatch(html, /夏季T恤 · 40x50/)
  assert.match(html, /aria-label="规格 40x50 · 提示词 prompt\.txt"/)
  assert.match(html, />40x50</)
  assert.match(html, />prompt\.txt</)
  assert.match(html, />tee\.psd</)
  assert.match(html, />1<\/span>\s*个上架方案/)
  const rowAt = html.indexOf('data-listing-card="card-1"')
  const rowTag = html.slice(html.lastIndexOf("<tr", rowAt), html.indexOf(">", rowAt))
  assert.doesNotMatch(rowTag, /cursor-pointer/, "行不再整体可点，绑定都走行内控件")
  assert.doesNotMatch(html, /aria-label="编辑 夏季T恤"/)
  assert.match(html, /aria-label="上架 夏季T恤"/)
  assert.match(html, /aria-label="类目 11 \/ 类型 22"/)
  assert.doesNotMatch(html, /aria-label="上传进度空闲/)
  assert.doesNotMatch(html, /<article/)
  assert.doesNotMatch(html, /minmax\(min\(100%,18rem\)/)
  assert.doesNotMatch(html, /h-\[9rem\]/)
  assert.doesNotMatch(html, /<h1/)
  assert.doesNotMatch(html, /title="类目/)
  assert.doesNotMatch(html, /LayoutGrid/)
})

test("名册不再单独披露保存时间与上传进度列", () => {
  const html = renderLibrary([sampleCard], { "card-1": { done: 1, total: 3 } })
  assert.doesNotMatch(html, /aria-label="上传进度 1\/3"/)
  assert.doesNotMatch(html, />1\/3</)
  assert.doesNotMatch(html, /aria-label="保存时间 /)
})

test("高亮行带 data-highlighted，供地址深链跳转定位", () => {
  const html = renderLibrary([sampleCard], {}, { highlightDraftId: "card-1" })
  assert.match(html, /data-listing-card="card-1"/)
  assert.match(html, /data-highlighted="true"/)
})

test("规格与提示词在独立列，缺一则只披露有的那项", () => {
  const onlySpec = renderLibrary([{ ...sampleCard, ai_prompt_file_name: "" }])
  assert.match(onlySpec, /aria-label="规格 40x50"/)
  assert.doesNotMatch(onlySpec, /prompt\.txt/)

  const onlyPrompt = renderLibrary([{ ...sampleCard, size: undefined, ai_prompt_file_name: "数字油画.md" }])
  assert.match(onlyPrompt, /aria-label="提示词 数字油画\.md"/)
  assert.doesNotMatch(onlyPrompt, />40x50</)

  const empty = renderLibrary([{ ...sampleCard, size: "", ai_prompt_file_name: "" }])
  assert.match(empty, /aria-label="无规格与提示词"/)
})

test("列表还在加载时用骨架，不先画出空态", () => {
  const html = renderLibrary([], {}, { busy: true })
  assert.match(html, /data-listing-library-skeleton/)
  assert.match(html, /正在加载上架方案/)
  assert.doesNotMatch(html, /还没有上架方案/)
  assert.doesNotMatch(html, /data-slot="table"/)
})

test("没有上架方案时仍用 Empty，不画一张空表", () => {
  const html = renderLibrary([])
  assert.match(html, /还没有上架方案/)
  assert.match(html, /去平台货源选品/)
  assert.match(html, /同一商品只保留一份引用/)
  assert.doesNotMatch(html, /创建第一个上架方案/)
  assert.doesNotMatch(html, /data-slot="table"/)
})

test("商库方案不提供复制入口，添加回到在线商库", () => {
  const html = renderLibrary([{ ...sampleCard, supplier_product_id: "supplier-1" }])
  assert.match(html, /从商库添加/)
  assert.doesNotMatch(html, /aria-label="复制 /)
  assert.match(html, /aria-label="上架 夏季T恤"/)
})

test("失效引用留在列表但不能上架", () => {
  const html = renderLibrary([{ ...sampleCard, supplier_product_id: "supplier-1", supplier_unavailable: true }])
  assert.match(html, /来源不可用/)
  assert.match(buttonFor(html, "上架 夏季T恤"), / disabled=""/)
  assert.doesNotMatch(buttonFor(html, "删除 夏季T恤"), / disabled=""/)
})

test("失效来源行：名称旁渲染语义 token 徽标，脚注保留", () => {
  const html = renderLibrary([{ ...sampleCard, supplier_product_id: "supplier-1", supplier_unavailable: true }])
  // 名称仍是身份（不因失效被顶替），徽标只标状态。
  assert.match(html, />夏季T恤</)
  const badgeAt = html.indexOf('data-slot="badge"')
  assert.notEqual(badgeAt, -1, "来源不可用行必须渲染 Badge")
  const badge = html.slice(badgeAt, html.indexOf("</span>", badgeAt))
  assert.match(badge, /来源不可用\s*$/, "徽标文本为「来源不可用」")
  assert.match(badge, /st-bad/, "徽标用 destructive 语义 token（st-bad）")
  // 现有脚注保留：徽标标状态，脚注给指引。
  assert.match(html, /来源不可用 · 请在商库确认配置/)
  // 健康行不带失效徽标（店铺 chips 有自己的 badge，不误伤）。
  const healthy = renderLibrary([sampleCard])
  assert.doesNotMatch(healthy, /data-variant="destructive"[^>]*>来源不可用/)
})

test("搜索按名称、规格、提示词、类目与店铺过滤", () => {
  const tree = [
    {
      description_category_id: 1,
      category_name: "爱好和创作",
      type_id: 0,
      type_name: "",
      disabled: false,
      children: [
        {
          description_category_id: 11,
          category_name: "手工制作套件",
          type_id: 0,
          type_name: "",
          disabled: false,
          children: [
            {
              description_category_id: 11,
              category_name: "",
              type_id: 22,
              type_name: "数字油画",
              disabled: false,
              children: [],
            },
          ],
        },
      ],
    },
  ]
  const stores = [{ id: "store-1", label: "莫斯科一店" }] as never as import("@/bindings/commands").OzonStoreView[]

  assert.equal(listingCardMatchesQuery(sampleCard, "", tree, stores), true)
  assert.equal(listingCardMatchesQuery(sampleCard, "夏季", tree, stores), true)
  assert.equal(listingCardMatchesQuery(sampleCard, "40x50", tree, stores), true)
  assert.equal(listingCardMatchesQuery(sampleCard, "prompt.txt", tree, stores), true)
  assert.equal(listingCardMatchesQuery(sampleCard, "数字油画", tree, stores), true)
  assert.equal(listingCardMatchesQuery(sampleCard, "莫斯科", tree, stores), true)
  assert.equal(listingCardMatchesQuery(sampleCard, "tee.psd", tree, stores), true)
  assert.equal(listingCardMatchesQuery(sampleCard, "不存在的词", tree, stores), false)
  assert.equal(
    listingCardMatchesQuery({ ...sampleCard, price: "1990" }, "1990", tree, stores),
    true,
  )
})

test("店铺列是行内下拉：已绑显示店铺名，未绑给可点入口", () => {
  const bound = renderLibrary([sampleCard], {}, { bindStores: true })
  // stores=[] → label falls back to the raw id
  assert.match(bound, /aria-label="店铺绑定：store-1"/)
  assert.match(bound, /data-testid="card-store-chips"/)
  assert.doesNotMatch(bound, /aria-label="绑定店铺"/)

  const unbound = renderLibrary(
    [{ ...sampleCard, target_store_id: "" }],
    {},
    { bindStores: true },
  )
  assert.match(unbound, /aria-label="绑定店铺"/)
  assert.match(unbound, /border-dashed/)
})

test("来源不可用的方案锁定行内店铺绑定", () => {
  const html = renderLibrary(
    [
      {
        ...sampleCard,
        supplier_product_id: "supplier-1",
        supplier_unavailable: true,
        target_store_id: "",
      },
    ],
    {},
    { bindStores: true },
  )
  assert.match(buttonFor(html, "绑定店铺"), / disabled=""/)
})

test("行内店铺绑定复用 listingCardSaveStore 并回写列表", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./card-library-host.tsx", import.meta.url), "utf8")

  assert.match(source, /listingCardSaveStore\(\s*form\.draft_id,/)
  assert.match(source, /onBindStores=\{/)
})

test("行内 PSD 绑定显示当前模板并可改绑", () => {
  const bound = renderLibrary([sampleCard], {}, { bindPsd: true })
  assert.match(bound, /aria-label="PSD 绑定：tee.psd"/)
  assert.match(bound, /tee\.psd/)

  const unbound = renderLibrary(
    [{ ...sampleCard, psd_template_file_name: "" }],
    {},
    { bindPsd: true },
  )
  assert.match(unbound, /aria-label="绑定 PSD"/)
})

test("商库软链接卡的 PSD 也能在列表里改绑", () => {
  const html = renderLibrary(
    [
      {
        ...sampleCard,
        supplier_product_id: "supplier-1",
        psd_template_file_name: "supplier.psd",
      },
    ],
    {},
    { bindPsd: true },
  )
  assert.match(html, /aria-label="PSD 绑定：supplier.psd"/)
})

test("来源不可用的方案锁定行内 PSD 绑定", () => {
  const html = renderLibrary(
    [
      {
        ...sampleCard,
        supplier_product_id: "supplier-1",
        supplier_unavailable: true,
      },
    ],
    {},
    { bindPsd: true },
  )
  assert.match(buttonFor(html, "PSD 绑定：tee.psd"), / disabled=""/)
})

test("来源不可用的 PSD 绑定禁用态带原因提示", () => {
  const html = renderLibrary(
    [
      {
        ...sampleCard,
        supplier_product_id: "supplier-1",
        supplier_unavailable: true,
      },
    ],
    {},
    { bindPsd: true },
  )
  // 禁用按钮自身在 card-psd-picker.tsx，不收 title；usage 侧用包装 span 的
  // title 兜底 + Tooltip 原因（同 stores-screen 新增店铺的 disabledReason 模式）。
  assert.match(html, /title="来源不可用 · 请在商库确认配置"/)
  // 健康行不带这个兜底提示。
  const healthy = renderLibrary([sampleCard], {}, { bindPsd: true })
  assert.doesNotMatch(healthy, /title="来源不可用/)
})

test("PSD 绑定失败走 notifyCommandError，取消保持静默", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./card-library-host.tsx", import.meta.url), "utf8")
  const fn = source.slice(
    source.indexOf("async function bindCardPsd"),
    source.indexOf("async function clearCardPsd"),
  )
  // 走查「点绑定 PSD 无反馈」按代码事实复验：取消（workflow_template_cancelled）
  // 静默是设计；其余失败 notifyCommandError，文案走 toast 不进 DOM。
  assert.match(fn, /commandCode\(reason\) !== "workflow_template_cancelled"/)
  assert.match(fn, /notifyCommandError\(\s*reason,\s*"无法保存 PSD 绑定，请稍后重试。",?\s*\)/)
})

test("行内 PSD 绑定复用 listingCardSavePsd 并回写列表", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./card-library-host.tsx", import.meta.url), "utf8")

  assert.match(source, /listingCardSavePsd\(\s*form\.draft_id,/)
  assert.match(source, /onBindPsd=\{/)
  assert.match(source, /onClearPsd=\{/)
})

test("携带 highlight 目标时目标行不被筛选吞掉，其余行照常过滤", () => {
  const forms = [sampleCard, { ...sampleCard, draft_id: "card-2", display_name: "冬季卫衣" }]
  const query = "夏季"
  // 无目标：只有匹配行可见（现有过滤行为保持）。
  assert.deepEqual(
    listingCardVisibleForms(forms, query, [], []).map((form) => form.draft_id),
    ["card-1"],
  )
  // 目标本身匹配：结果不变。
  assert.deepEqual(
    listingCardVisibleForms(forms, query, [], [], "card-1").map((form) => form.draft_id),
    ["card-1"],
  )
  // 目标被筛选排除：目标行钉住在表（走查「已加入并复用却显示 0/2」的坑），
  // 但其余不匹配行仍被过滤——cardId 在场不能把搜索框变成无效输入。
  assert.deepEqual(
    listingCardVisibleForms(forms, query, [], [], "card-2").map((form) => form.draft_id),
    ["card-1", "card-2"],
  )
  // 完全不匹配的词：只剩钉住的目标行。
  assert.deepEqual(
    listingCardVisibleForms(forms, "不存在的词", [], [], "card-2").map((form) => form.draft_id),
    ["card-2"],
  )
})

test("highlight 到来时清空搜索框，无目标不重置", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./card-library.tsx", import.meta.url), "utf8")
  const effectAt = source.indexOf("if (!highlightDraftId) return")
  assert.notEqual(effectAt, -1)
  assert.match(
    source.slice(effectAt, effectAt + 120),
    /setQuery\(""\)/,
    "highlight 目标到达即清空筛选",
  )
})

test("workflow-screen 把地址 cardId 交给库列表做 highlight", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./workflow-screen.tsx", import.meta.url), "utf8")
  assert.match(source, /highlightDraftId=\{addressCardId\}/)
})

test("删除方案成功有 notifySuccess，失败路径不弹成功", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./card-library-host.tsx", import.meta.url), "utf8")
  const fn = source.slice(
    source.indexOf("async function deleteSavedForm"),
    source.indexOf("async function copySavedForm"),
  )
  const successAt = fn.indexOf("notifySuccess(`已删除「${savedFormTitle(form)}」`)")
  const catchAt = fn.indexOf("} catch")
  assert.ok(
    successAt !== -1 && catchAt !== -1 && successAt < catchAt,
    "成功提示在 try 内（删除与刷新都完成后），catch 只走 notifyCommandError",
  )
  assert.doesNotMatch(fn.slice(catchAt), /notifySuccess/)
})

test("新建上架方案 auto-loads the Seller tree after a store is chosen", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./card-library-host.tsx", import.meta.url), "utf8")

  assert.match(source, /defaultListingCardStoreId\(ozonStores, fallbackStoreId\)/)
  assert.match(source, /composeSellerCredentialIssue\(composeStoreId, ozonStores\)/)
  assert.match(source, /\[composing, composeStoreId\]/)
  assert.match(source, /onOpenStores=\{onOpenStores\}/)
})
