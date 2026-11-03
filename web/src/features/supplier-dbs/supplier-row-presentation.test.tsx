/** Row editor sections, prompt/file/tag presentation and variant controls. */
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SupplierDbDetail } from "@/bindings/http-supplier-dbs"
import { SupplierRowBody } from "./supplier-row-body"
import { SupplierRowCopyFields } from "./supplier-row-copy-fields"
import { db, row, readyStore } from "./supplier-dbs-screen-fixtures"

const BRIEF_FIXTURE = JSON.stringify({ product_type_ru:"Кружка",facts_ru:"керамическая 330 мл" })


test("＋新商品 creates a row and the sheet section anatomy holds", async () => {
  const detail: SupplierDbDetail = {
    db: db("src-1", "美国3C厂"),
    propDefs: [],
    rows: [],
  }
  const { store, calls } = await readyStore([detail])
  await store.loadDetail("src-1")
  const created = await store.createRow("src-1")
  assert.equal(created.ok, true)
  assert.equal(calls.createRow.length, 1)
  const detailNow = store.getState().details["src-1"].detail!
  assert.equal(detailNow.rows.length, 1)
  assert.equal(detailNow.db.rowCount, 1)

  const newRow = detailNow.rows[0]
  const updates: unknown[] = []
  const html = renderToStaticMarkup(
    <SupplierRowBody
      row={newRow}
      propDefs={[]}
      onPatch={async (patch) => {
        updates.push(patch)
        return true
      }}
      onAdjustPrice={async () => true}
    />,
  )
  // 商品资料、价格、规格与素材合并在平台商品信息中。
  for (const label of ["平台商品信息", "Ozon 字段", "AI 识图"]) {
    assert.ok(html.includes(`>${label}<`), `missing tab ${label}`)
  }
  for (const section of ["商品资料", "商品属性", "商品说明", "价格", "素材", "包装与清单"]) {
    assert.ok(html.includes(`>${section}<`), `missing section ${section}`)
  }
  assert.match(html, /aria-label="名称"/)
  assert.match(html, /aria-label="编号"/)
  assert.match(html, /aria-label="规格"/)
  assert.match(html, /aria-label="材质"/)
  assert.match(html, /aria-label="工艺"/)
  assert.doesNotMatch(html, /aria-label="包装重量/)
  // 单位只列英文符号：面板里不再出现中文「克」提示。
  assert.doesNotMatch(html, /克/)
  assert.doesNotMatch(html, /aria-label="款号（同款分组）"/)
  assert.doesNotMatch(html, /aria-label="Ozon 类目"/)
  assert.doesNotMatch(html, /role="alert"/)

  assert.match(html, /data-row-tab="ocr"/)

  // AI识图保留公式说明、免费公式预览和真实图片验证。
  const promptHtml = renderToStaticMarkup(
    <SupplierRowBody
      row={row("p9", "src-1", { promptContent: BRIEF_FIXTURE, descriptionCategoryId: 11, typeId: 101 })}
      propDefs={[]}
      onPatch={async () => true}
      onAdjustPrice={async () => true}
      initialTab="ocr"
    />,
  )
  for (const section of ["商品事实", "俄文商品类型", "确认属性（俄文）", "固定标签", "公式测试", "示例画面主题", "标题公式", "真实图片测试"]) {
    assert.ok(promptHtml.includes(section), `missing builder section ${section}`)
  }
  assert.match(promptHtml, /标题：Кружка керамическая 330 мл/)
  assert.match(promptHtml, /不调用模型，不扣费/)
  assert.doesNotMatch(promptHtml, /智能构建|试用图片|AI 复核|六行|读取本次结果|仅管理员可见|识图填入|data-supplier-ai-output/)
  assert.doesNotMatch(promptHtml, /data-brief-line=/)
})

test("AI识图仅维护商品类型与确认属性，核心输入按真实约束标记", () => {
  const html = renderToStaticMarkup(<SupplierRowCopyFields
    row={row("p1", "src-1", { promptContent: BRIEF_FIXTURE, descriptionCategoryId: 11, typeId: 101 })}
    onPatch={async () => true} />)
  const field = (name: string, marker: string) => {
    const label = html.indexOf(`>${name}</label>`)
    assert.ok(label >= 0, name)
    assert.match(html.slice(label, html.indexOf("</div>", label)), new RegExp(`>${marker}<`))
  }
  field("俄文商品类型", "必填")
  field("确认属性（俄文）", "建议")
  field("测试图片", "必填")
  assert.doesNotMatch(html, /识图填入|data-supplier-ai-output/)
  assert.match(html, /固定标签<\/span>[\s\S]*?>必填</)
  assert.doesNotMatch(html, /固定描述|description_ru|<textarea/)
  assert.match(html, /按实际用量扣工作空间钱包/)
})


test("平台字段只维护类目与属性，AI识图独立，不显示未开放的 WB 页签", () => {
  const html = renderToStaticMarkup(
    <SupplierRowBody row={row("p1", "src-1", { descriptionCategoryId: 11, typeId: 101 })}
      initialTab="defaults" propDefs={[]} onPatch={async () => true}
      onAdjustPrice={async () => true} />,
  )
  assert.match(html, /aria-label="Ozon 类目"/)
  assert.doesNotMatch(html, /data-supplier-row-copy-fields=""/)
  assert.doesNotMatch(html, />WB<|aria-label="销售平台"|data-supplier-row-wb-empty|data-row-tab="prompt"/)
  assert.doesNotMatch(html, /role="alert"/)
})


test("行面板运费：没填即零运费（读出 ¥0.00），字段名不带装饰图标", () => {
  const html = renderToStaticMarkup(
    <SupplierRowBody
      row={row("p1", "src-1", { shippingCostCents: null })} mode="variant"
      propDefs={[]}
      onPatch={async () => true}
      onAdjustPrice={async () => true}
    />,
  )
  // 空值不是空框：面板按生效值 ¥0.00 读出。
  const shippingInput =
    html.match(/<input[^>]*aria-label="运费（元）"[^>]*>/)?.[0] ?? ""
  assert.match(shippingInput, /value="0\.00"/)
  assert.doesNotMatch(html, /lucide-truck|lucide-hash/)
})


test("旧提示词要求重新确认事实，页面不再导入指令文件", () => {
  const html = renderToStaticMarkup(<SupplierRowCopyFields row={row("p1","src-1",{promptContent:"Товар: Кружка"})} onPatch={async () => true} />)
  assert.match(html,/旧说明需要重新填写为商品事实/)
  assert.doesNotMatch(html,/导入 Markdown|试用图片|AI 复核/)
})


test("行面板固定 tags：存量非法 tag 徽标挂 aria-invalid，合法的不挂", () => {
  const html = renderToStaticMarkup(
    <SupplierRowCopyFields
      row={row("p1", "src-1", { fixedTags: ["#test", "#подарок"] })}
      onPatch={async () => true}
    />,
  )
  // 容器 + 非法徽标各一处 aria-invalid；#подарок 的徽标不带。
  assert.equal(html.match(/aria-invalid="true"/g)?.length, 2)
  assert.match(html, /title="不符合契约：须为 # 开头的俄语词"/)
  assert.match(html, /aria-label="查看“固定标签”填写说明"/)
})


test("编辑器页头先说清规格上下文：单规格读数、同款分段切换与逐项状态", () => {
  const props = { propDefs: [], onPatch: async () => true, onAdjustPrice: async () => true }
  const single = renderToStaticMarkup(<SupplierRowBody row={row("p1", "src-1", { size: "40×50 cm" })} {...props} />)
  const singleHeader = single.slice(single.indexOf('class="supplier-editor-context"'), single.indexOf("data-supplier-row-content"))
  assert.match(singleHeader, />规格</)
  assert.match(singleHeader, /40×50 cm/)
  assert.doesNotMatch(singleHeader, /aria-selected=|role="tablist"/)

  const current = row("p1", "src-1", { size: "40×50 cm", variantGroup: "paint", published: true })
  const multi = renderToStaticMarkup(<SupplierRowBody row={current} rows={[current, row("p2", "src-1", { size: "50×70 cm", variantGroup: "paint" })]} {...props} />)
  const header = multi.slice(multi.indexOf('class="supplier-editor-context"'), multi.indexOf("data-supplier-row-content"))
  assert.match(header, />规格</)
  assert.match(header, /role="tablist"/)
  assert.match(header, /aria-label="同款规格"/)
  assert.match(header, /aria-selected="true"/)
  assert.match(header, /aria-label="40×50 cm，已发布"/)
  assert.match(header, /aria-label="50×70 cm，草稿"/)
  assert.match(header, /data-published="true"/)
  assert.match(header, /data-published="false"/)
})

test("规格流程提供可编辑的 Ozon 字段，并保留同款切换", () => {
  const current = row("p1", "src-1", { size: "40×50 cm", variantGroup: "paint" })
  const html = renderToStaticMarkup(<SupplierRowBody row={current} mode="variant" propDefs={[]} onPatch={async () => true} onAdjustPrice={async () => true} rows={[
    current,
    row("p2", "src-1", { size: "50×70 cm", variantGroup: "paint" }),
    row("p3", "src-2", { size: "其他货源", variantGroup: "paint" }),
    row("p4", "src-1", { size: "已归档规格", variantGroup: "paint", archived: true }),
    row("p5", "src-1", { size: "其他同款", variantGroup: "other" }),
  ]} />)
  assert.match(html, /40×50 cm/)
  assert.match(html, /50×70 cm/)
  assert.doesNotMatch(html, /其他货源|已归档规格|其他同款/)
  assert.match(html, /data-row-tab="defaults"/)
  assert.doesNotMatch(html, /Ozon 字段沿用商品配置|查看商品配置/)
  assert.equal(html.match(/data-row-tab=/g)?.length, 3)
  assert.doesNotMatch(html, /data-row-tab="review"|data-row-tab="spec"/gi)
  assert.match(html, /aria-label="同款规格"/)
  const editor = renderToStaticMarkup(<SupplierRowBody row={current} sharedRow={row("parent", "src-1")} mode="variant" initialTab="defaults" propDefs={[]} onPatch={async () => true} onAdjustPrice={async () => true} />)
  assert.match(editor, /data-supplier-row-platform/)
  assert.match(editor, /aria-label="Ozon 类目"/)
  assert.match(editor, /仅修改当前规格/)
})
