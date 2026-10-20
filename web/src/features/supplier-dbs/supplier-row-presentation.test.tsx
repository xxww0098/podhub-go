/** Row editor sections, prompt/file/tag presentation and variant controls. */
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SupplierDbDetail, SupplierDbPropDef } from "@/bindings/http-supplier-dbs"
import { SupplierRowBody } from "./supplier-row-body"
import { db, row, readyStore } from "./supplier-dbs-screen-fixtures"

// 规范六行商品说明（马克杯形状）：让「分六行构建」模式在静态渲染里落地。
const BRIEF_BT = String.fromCharCode(96)
const BRIEF_FIXTURE = [
  "Товар: Керамическая кружка 330 мл с принтом на внешней стороне; это НЕ термокружка и НЕ стакан.",
  "Тема: Только принт, без стола, рук, посуды и фона съёмки. Неясно → «Абстрактный принт».",
  "Заголовок: " + BRIEF_BT + 'Кружка керамическая 330 мл с принтом "<тема>", для чая и кофе' + BRIEF_BT,
  "Не пиши: «чашка», «стакан», «термокружка».",
  "Описание: Керамическая кружка объёмом 330 мл с принтом. Принт: <видимый принт>. Основные цвета: <цвет1> и <цвет2>. Подойдёт для дома и офиса.",
  "Не выдумывай: посудомойку, микроволновку, стойкость принта, вес, упаковку.",
].join("\n")


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
      onTogglePublish={() => {}}
      onAdjustPrice={async () => true}
    />,
  )
  // 页签骨架：按事实类分三页；规格切换与就绪导航在页头。
  for (const label of ["主要信息", "平台字段", "提示词"]) {
    assert.ok(html.includes(`>${label}<`), `missing tab ${label}`)
  }
  for (const section of ["商品资料", "价格", "包装与清单", "素材", "描述与备注"]) {
    assert.ok(html.includes(`>${section}<`), `missing section ${section}`)
  }
  assert.match(html, /aria-label="名称"/)
  assert.match(html, /aria-label="编号"/)
  assert.match(html, /aria-label="规格"/)
  assert.match(html, /aria-label="材质"/)
  assert.match(html, /aria-label="工艺"/)
  assert.match(html, /aria-label="毛重（g）"/)
  assert.match(html, /aria-label="毛重单位"/)
  assert.match(html, /aria-label="包装重量（g）"/)
  assert.match(html, /aria-label="包装重量单位"/)
  // 单位只列英文符号：面板里不再出现中文「克」提示。
  assert.doesNotMatch(html, /克/)
  assert.match(html, /aria-label="款号（同款分组）"/)
  assert.doesNotMatch(html, /aria-label="Ozon 类目"/)
  assert.match(html, /aria-label="运费（元）"/)
  assert.match(html, /data-supplier-row-media="图集"/)
  assert.doesNotMatch(html, /role="alert"/)

  // 识图提示词页签：说明构建器（六行骨架）与固定 tags 在这里。
  const promptHtml = renderToStaticMarkup(
    <SupplierRowBody
      row={row("p9", "src-1", { promptContent: BRIEF_FIXTURE })}
      propDefs={[]}
      onPatch={async () => true}
      onTogglePublish={() => {}}
      onAdjustPrice={async () => true}
      initialTab="prompt"
    />,
  )
  for (const section of ["提示词信息", "六行识图说明", "固定标签"]) {
    assert.ok(promptHtml.includes(`>${section}<`), `missing prompt section ${section}`)
  }
  assert.match(promptHtml, /data-brief-builder=""/)
  // 六行骨架逐行渲染，模板句词库跟着行（不是只有一整块文本域）。
  assert.equal(promptHtml.match(/data-brief-line=/g)?.length, 6)
  assert.match(promptHtml, /Только принт/)
  assert.ok(promptHtml.includes("0 / 25"), "tags 计数在识图页签")
})


test("平台字段分 Ozon / WB：类目归属 Ozon，WB 可切换且不复用其字段", () => {
  const html = renderToStaticMarkup(
    <SupplierRowBody
      row={row("p1", "src-1", { descriptionCategoryId: 11, typeId: 101 })}
      initialTab="defaults" propDefs={[]}
      onPatch={async () => true} onTogglePublish={() => {}} onAdjustPrice={async () => true}
    />,
  )
  assert.match(html, /aria-label="销售平台"/)
  assert.match(html, /aria-label="Ozon 类目"/)
  const wb = html.match(/<button[^>]*>WB<\/button>/)?.[0] ?? ""
  assert.doesNotMatch(wb, /aria-disabled="true"|data-disabled| disabled(?:=|>|\s)/ )
  assert.match(html, /data-supplier-row-wb-empty=""/)
  assert.doesNotMatch(html, /role="alert"/)
})


test("行面板运费：没填即零运费（读出 ¥0.00），图标跟成本价同一套「#」", () => {
  const html = renderToStaticMarkup(
    <SupplierRowBody
      row={row("p1", "src-1", { shippingCostCents: null })}
      propDefs={[]}
      onPatch={async () => true}
      onTogglePublish={() => {}}
      onAdjustPrice={async () => true}
    />,
  )
  // 空值不是空框：面板按生效值 ¥0.00 读出。
  const shippingInput =
    html.match(/<input[^>]*aria-label="运费（元）"[^>]*>/)?.[0] ?? ""
  assert.match(shippingInput, /value="0\.00"/)
  // 价格区金额统一数字图标；卡车图标退场。
  assert.doesNotMatch(html, /lucide-truck/)
  assert.match(html, /lucide-hash[\s\S]*?<span class="[^"]*">运费<\/span>/)
})


test("行面板提示词文件：文件名与导入入口明确分开", () => {
  const withFile = renderToStaticMarkup(
    <SupplierRowBody
      row={row("p1", "src-1", { promptFileName: "数字油画-40x50cm.md" })}
      initialTab="prompt"
      propDefs={[]}
      onPatch={async () => true}
      onTogglePublish={() => {}}
      onAdjustPrice={async () => true}
    />,
  )
  assert.match(withFile, /aria-label="导入 Markdown 说明文件"/)
  assert.match(withFile, /数字油画-40x50cm\.md/)
  assert.equal(withFile.match(/数字油画-40x50cm\.md/g)?.length, 1)

  const withoutFile = renderToStaticMarkup(
    <SupplierRowBody
      row={row("p1", "src-1", { promptFileName: "" })}
      initialTab="prompt"
      propDefs={[]}
      onPatch={async () => true}
      onTogglePublish={() => {}}
      onAdjustPrice={async () => true}
    />,
  )
  assert.match(withoutFile, /aria-label="导入 Markdown 说明文件"/)
  assert.match(withoutFile, /尚未导入/)
})


test("行面板固定 tags：存量非法 tag 徽标挂 aria-invalid，合法的不挂", () => {
  const html = renderToStaticMarkup(
    <SupplierRowBody
      row={row("p1", "src-1", { fixedTags: ["#test", "#подарок"] })}
      initialTab="prompt"
      propDefs={[]}
      onPatch={async () => true}
      onTogglePublish={() => {}}
      onAdjustPrice={async () => true}
    />,
  )
  // 容器 + 非法徽标各一处 aria-invalid；#подарок 的徽标不带。
  assert.equal(html.match(/aria-invalid="true"/g)?.length, 2)
  assert.match(html, /title="不符合契约：须为 # 开头的俄语词"/)
  assert.match(html, /每个为 # 开头的俄语词/)
})


test("规格 tab 条：多规格时给出当前规格的删除入口", () => {
  const variants = [
    row("p1", "src-1", { title: "数字油画", variantGroup: "PAINT-01", size: "40x50" }),
    row("p2", "src-1", { title: "数字油画", variantGroup: "PAINT-01", size: "30x40" }),
  ]
  const base = {
    propDefs: [] as SupplierDbPropDef[],
    onPatch: async () => true,
    onTogglePublish: () => {},
    onAdjustPrice: async () => true,
  }
  const html = renderToStaticMarkup(
    <SupplierRowBody
      {...base}
      row={variants[0]}
      rows={variants}
      onDeleteVariant={() => {}}
    />,
  )
  assert.match(html, /aria-label="删除规格「40x50」"/)

  // 只剩一个规格时不挂删除钮——删它就是删行，归 ⋯ 菜单管。
  const single = renderToStaticMarkup(
    <SupplierRowBody
      {...base}
      row={variants[0]}
      rows={[variants[0]]}
      onDeleteVariant={() => {}}
    />,
  )
  assert.doesNotMatch(single, /删除规格/)

  // 没有删除回调（只读宿主）时同样不挂。
  const readonly = renderToStaticMarkup(
    <SupplierRowBody {...base} row={variants[0]} rows={variants} />,
  )
  assert.doesNotMatch(readonly, /删除规格/)
})
