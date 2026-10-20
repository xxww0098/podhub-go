import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { FieldWorkbench } from "./field-workbench"
import { idleLifecycle, instance, row, schema } from "./workbench-test-fixtures"
import { workbenchProps } from "./workbench-test-harness"

test("long AI tag lists stay a compact preview of the full #tag string", () => {
  const entry = row(1)
  const tags = ["море", "постер", "деревянная рама", "настенный декор", "для гостиной"]
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[entry]}
      productDrafts={{
        [entry.draftId]: instance(entry, {
          ...idleLifecycle,
          ai_summary: { tags, model: "test" },
        }),
      }}
      selectedRowIds={new Set()}
    />,
  )

  assert.match(html, /aria-label="搜索标签 SZ-0001\.png"/)
  assert.match(html, /#море #постер #деревянная рама #настенный декор #для гостиной/)
  assert.doesNotMatch(html, />\+3</)
})

test("AI-filled ru, tags and desc stay editable after recognition, even while media runs", () => {
  const filled = row(1, { ai: "done" })
  const slicing = row(2, { ai: "done", status: "running", render: "running" })
  const empty = row(3, { ai: "failed" })
  const recognising = row(4, { ai: "running", status: "running" })
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[filled, slicing, empty, recognising]}
      productDrafts={{
        [filled.draftId]: instance(filled, {
          ...idleLifecycle,
          ai: "ready",
          ai_summary: { tags: ["море", "постер"], model: "test" },
        }),
        [slicing.draftId]: instance(slicing, {
          ...idleLifecycle,
          ai: "ready",
          media: "rendering",
          ai_summary: { tags: ["море"], model: "test" },
        }),
        [empty.draftId]: instance(empty, { ...idleLifecycle, ai: "failed" }),
        [recognising.draftId]: instance(recognising, { ...idleLifecycle, ai: "running" }),
      }}
      selectedRowIds={new Set()}
    />,
  )

  const control = (label: string) => {
    const index = html.indexOf(`aria-label="${label}"`)
    assert.notEqual(index, -1, `missing ${label}`)
    const start = html.lastIndexOf("<button", index)
    return html.slice(start, html.indexOf(">", start))
  }
  for (const label of [
    "商品名称 SZ-0001.png",
    "商品简介 SZ-0001.png",
    "搜索标签 SZ-0001.png",
    "JSON富内容 SZ-0001.png",
    "商品名称 SZ-0002.png",
    "商品简介 SZ-0002.png",
    "搜索标签 SZ-0002.png",
    "JSON富内容 SZ-0002.png",
    "商品名称 SZ-0003.png",
    "商品简介 SZ-0003.png",
    "搜索标签 SZ-0003.png",
    "JSON富内容 SZ-0003.png",
  ]) {
    assert.doesNotMatch(control(label), /\bdisabled(?:=|\s|$)/, `${label} must stay editable`)
  }
  assert.match(html, /<p[^>]*aria-label="商品名称 SZ-0004\.png"/)
  assert.match(html, /<p[^>]*aria-label="商品简介 SZ-0004\.png"/)
  assert.match(html, /<p[^>]*aria-label="搜索标签 SZ-0004\.png"/)
  assert.match(html, /<p[^>]*aria-label="JSON富内容 SZ-0004\.png"/)
  assert.match(html, /#море #постер/)
})

test("a sealed row keeps its cells read-only while an open one stays editable", () => {
  const open = row(1)
  const sealed = row(2, { status: "sent" })
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[open, sealed]}
      productDrafts={{
        [open.draftId]: instance(open),
        [sealed.draftId]: instance(sealed, { ...idleLifecycle, stage: "accepted" }),
      }}
      selectedRowIds={new Set()}
    />,
  )

  const openNameIndex = html.indexOf('aria-label="商品名称 SZ-0001.png"')
  assert.notEqual(openNameIndex, -1, "missing 商品名称 SZ-0001.png")
  const openName = html.slice(
    html.lastIndexOf("<button", openNameIndex),
    html.indexOf(">", html.lastIndexOf("<button", openNameIndex)),
  )
  assert.doesNotMatch(openName, /\bdisabled(?:=|\s|$)/)
  assert.match(
    html,
    /<p[^>]*aria-label="商品名称 SZ-0002\.png"/,
    "a row with a terminal Ozon receipt must not accept an edit Cloud would refuse",
  )
  assert.doesNotMatch(html, /共 2 行 · 识别 0\/2 · 媒体 0\/2 · 已上架 1\/2/)
})

test("clearing a schema-backed tag field never revives the old recognition summary", () => {
  const target = row(1)
  const product = instance(target, { ...idleLifecycle, ai_summary: { tags: ["obsolete-summary-tag"], model: "test" } })
  const tagSchema = { ...schema, fields: [...schema.fields, { ...schema.fields[0]!, key: "attribute_23171", name: "标签", attribute_id: 23171 }] }
  const html = renderToStaticMarkup(<FieldWorkbench {...workbenchProps} schema={tagSchema} rows={[target]} productDrafts={{ [target.draftId]: product }} selectedRowIds={new Set()} />)
  assert.doesNotMatch(html, /obsolete-summary-tag/)
})

test("the 主题 cell previews the row's own pick and shows the card default as the fallback", () => {
  const picked = row(1)
  const blank = row(2)
  const recognising = row(3, { status: "running", ai: "running" })
  // seed_gaps baked the card theme into this row at creation; the row never
  // picked it, so the cell keeps following the current card default.
  const seeded = row(4)
  const themes = {
    kind: "multi_select" as const,
    value: [
      { dictionary_value_id: 970742650, value: "花卉和植物" },
      { dictionary_value_id: 970742668, value: "猫" },
    ],
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[picked, blank, recognising, seeded]}
      cardDraft={{
        values: {
          attribute_7109: {
            kind: "multi_select",
            value: [{ dictionary_value_id: 970742650, value: "花卉和植物" }],
          },
        },
        complex_values: [],
      }}
      productDrafts={{
        [picked.draftId]: {
          ...instance(picked),
          hand_edited_keys: ["attribute_7109"],
          draft: {
            values: { offer_id: { kind: "text", value: "SZ-0001" }, attribute_7109: themes },
            complex_values: [],
          },
        },
        [blank.draftId]: instance(blank),
        [recognising.draftId]: instance(recognising, { ...idleLifecycle, ai: "running" }),
        [seeded.draftId]: {
          ...instance(seeded),
          draft: {
            values: { offer_id: { kind: "text", value: "SZ-0004" }, attribute_7109: themes },
            complex_values: [],
          },
        },
      }}
      selectedRowIds={new Set()}
    />,
  )
  const themeCell = (image: string) => {
    const start = html.indexOf(`aria-label="主题 ${image}"`)
    assert.notEqual(start, -1, `missing 主题 ${image}`)
    const next = html.indexOf('aria-label="主题 ', start + 1)
    return html.slice(start, next === -1 ? undefined : next)
  }

  // The header is one more column; the value is the labels Ozon will receive.
  assert.match(html, /<th[^>]*>主题<\/th>/)
  assert.match(themeCell("SZ-0001.png"), /花卉和植物、猫/)

  // No pick on the row: the muted preview is the card default, not the seeded
  // multi-select copy the row inherited at creation.
  assert.match(themeCell("SZ-0002.png"), /花卉和植物/)
  assert.doesNotMatch(themeCell("SZ-0002.png"), /猫/)
  assert.match(themeCell("SZ-0004.png"), /花卉和植物/)
  assert.doesNotMatch(themeCell("SZ-0004.png"), /猫/)

  // A row that is still recognising stays read-only, exactly like a prose cell.
  assert.match(html, /<p[^>]*aria-label="主题 SZ-0003\.png"/)
})

test("a category without 主题 says so instead of inventing a picker", () => {
  const withoutTheme = {
    ...schema,
    fields: schema.fields.filter((candidate) => candidate.attribute_id !== 7109),
  }
  const target = row(1)
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={withoutTheme}
      rows={[target]}
      productDrafts={{ [target.draftId]: instance(target) }}
      selectedRowIds={new Set()}
    />,
  )
  assert.match(html, /当前类目无主题属性/)
  assert.match(html, /<p[^>]*aria-label="主题 SZ-0001\.png"/)
  assert.doesNotMatch(html, /<button[^>]*aria-label="主题 SZ-0001\.png"/)
})

test("销售价/划线价 are typed per row and show the default fields as the fallback", () => {
  const typed = row(1)
  const untouched = row(2)
  const recognising = row(3, { status: "running", ai: "running" })
  // seed_gaps baked the old card price into this row at creation; the row
  // never typed it, so the cell still follows the current card default.
  const seeded = row(4)
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[typed, untouched, recognising, seeded]}
      cardDraft={{
        values: {
          price: { kind: "decimal", value: 1990 },
          old_price: { kind: "decimal", value: 2490 },
        },
        complex_values: [],
      }}
      productDrafts={{
        [typed.draftId]: {
          ...instance(typed),
          hand_edited_keys: ["price"],
          draft: {
            values: { offer_id: { kind: "text", value: "SZ-0001" }, price: { kind: "decimal", value: 1500 } },
            complex_values: [],
          },
        },
        [untouched.draftId]: instance(untouched),
        [recognising.draftId]: instance(recognising, { ...idleLifecycle, ai: "running" }),
        [seeded.draftId]: {
          ...instance(seeded),
          draft: {
            values: { offer_id: { kind: "text", value: "SZ-0004" }, price: { kind: "decimal", value: 900 } },
            complex_values: [],
          },
        },
      }}
      selectedRowIds={new Set()}
    />,
  )

  const input = (label: string) => {
    const index = html.indexOf(`aria-label="${label}"`)
    assert.notEqual(index, -1, `missing ${label}`)
    const start = html.lastIndexOf("<input", index)
    return html.slice(start, html.indexOf(">", index))
  }

  // The row's own price is the value; the card price is only the muted fallback.
  const typedPrice = input("销售价 SZ-0001.png")
  assert.match(typedPrice, /value="1500"/)
  assert.match(typedPrice, /aria-label="销售价 SZ-0001\.png"/)

  const inherited = input("销售价 SZ-0002.png")
  assert.match(inherited, /placeholder="1990"/)
  assert.match(input("划线价 SZ-0002.png"), /placeholder="2490"/)
  assert.match(inherited, /inputmode="decimal"/i)

  // A seeded copy is not the row's answer: the cell reads empty and the
  // fallback is today's card default, not the baked 900.
  const seededCell = input("销售价 SZ-0004.png")
  assert.match(seededCell, /value=""/)
  assert.match(seededCell, /placeholder="1990"/)
  assert.doesNotMatch(seededCell, /value="900"/)

  // A row that is still recognising is read-only, like every other editable cell.
  assert.match(input("销售价 SZ-0003.png"), /disabled=""/)
})

test("JSON富内容 is typed per row and shows the card default as the fallback", () => {
  const typed = row(1)
  const untouched = row(2)
  // seed_gaps baked the old card rich content into this row at creation; the
  // row never pasted its own, so the cell follows the current card default.
  const seeded = row(3)
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[typed, untouched, seeded]}
      cardDraft={{
        values: {
          attribute_11254: {
            kind: "text",
            value: '{"content":[{"type":"text","text":"卡默认富内容"}]}',
          },
        },
        complex_values: [],
      }}
      productDrafts={{
        [typed.draftId]: {
          ...instance(typed),
          hand_edited_keys: ["attribute_11254"],
          draft: {
            values: {
              offer_id: { kind: "text", value: "SZ-0001" },
              attribute_11254: {
                kind: "text",
                value: '{"content":[{"type":"text","text":"本行粘贴"}]}',
              },
            },
            complex_values: [],
          },
        },
        [untouched.draftId]: instance(untouched),
        [seeded.draftId]: {
          ...instance(seeded),
          draft: {
            values: {
              offer_id: { kind: "text", value: "SZ-0003" },
              attribute_11254: {
                kind: "text",
                value: '{"content":[{"type":"text","text":"旧卡默认"}]}',
              },
            },
            complex_values: [],
          },
        },
      }}
      selectedRowIds={new Set()}
    />,
  )
  const cell = (image: string) => {
    const start = html.indexOf(`aria-label="JSON富内容 ${image}"`)
    assert.notEqual(start, -1, `missing JSON富内容 ${image}`)
    const next = html.indexOf('aria-label="JSON富内容 ', start + 1)
    return html.slice(start, next === -1 ? undefined : next)
  }

  // The row's own paste is the value; the card default is only the muted fallback.
  assert.match(cell("SZ-0001.png"), /本行粘贴/)
  assert.doesNotMatch(cell("SZ-0001.png"), /卡默认富内容/)

  // An untouched or seeded row reads empty and shows today's card default.
  for (const image of ["SZ-0002.png", "SZ-0003.png"]) {
    assert.match(cell(image), /卡默认富内容/)
    assert.doesNotMatch(cell(image), /旧卡默认/)
  }
})

test("货号 and 型号 are two cells: a written model never moves the instance identity", () => {
  const written = row(1)
  const inherited = row(2)
  const sealed = row(3, { status: "sent" })
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[written, inherited, sealed]}
      productDrafts={{
        [written.draftId]: {
          ...instance(written),
          hand_edited_keys: ["model_name"],
          draft: {
            values: {
              offer_id: { kind: "text", value: "SZ-0001" },
              model_name: { kind: "text", value: "SZ-ART-01" },
            },
            complex_values: [],
          },
        },
        [inherited.draftId]: instance(inherited),
        [sealed.draftId]: instance(sealed, { ...idleLifecycle, stage: "accepted" }),
      }}
      selectedRowIds={new Set()}
    />,
  )
  /** The whole table cell carrying one aria-labelled value. */
  const cell = (label: string) => {
    const start = html.indexOf(`aria-label="${label}"`)
    assert.notEqual(start, -1, `missing ${label}`)
    return html.slice(html.lastIndexOf("<td", start), html.indexOf("</td>", start))
  }

  // Two headers, not one merged 货号/型号.
  assert.match(html, />货号</)
  assert.match(html, />型号</)
  assert.doesNotMatch(html, /货号\/型号/)

  // The written model stays in the 型号 cell; the 货号 cell keeps the identity.
  const modelCell = cell("型号 SZ-0001.png")
  assert.match(modelCell, /line-clamp-3[^>]*>SZ-ART-01</)
  assert.doesNotMatch(modelCell, /font-mono text-compact">SZ-0001</)
  const offerCell = cell("货号 SZ-0001.png")
  assert.match(offerCell, /font-mono text-compact">SZ-0001</)
  assert.doesNotMatch(offerCell, /SZ-ART-01/)

  // A row nobody wrote a model on shows the file-name stem the build would
  // inject, in the muted tone of every inherited value.
  assert.match(cell("型号 SZ-0002.png"), /text-muted-foreground\/60[^>]*>SZ-0002</)

  // A sealed row renders the read-only preview, exactly like the prose cells.
  assert.match(cell("型号 SZ-0003.png"), /<p[^>]*aria-label="型号 SZ-0003\.png"/)
})

test("a category without the price fields says so instead of inventing a cell", () => {
  const withoutPrices = {
    ...schema,
    fields: schema.fields.filter(
      (candidate) => candidate.key !== "price" && candidate.key !== "old_price",
    ),
  }
  const target = row(1)
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={withoutPrices}
      rows={[target]}
      productDrafts={{ [target.draftId]: instance(target) }}
      selectedRowIds={new Set()}
    />,
  )
  assert.match(html, /当前类目无销售价/)
  assert.match(html, /当前类目无划线价/)
  assert.doesNotMatch(html, /aria-label="销售价 SZ-0001\.png"/)
})

test("a category without 9048 says so instead of inventing a model cell", () => {
  const withoutModel = {
    ...schema,
    fields: schema.fields.filter((candidate) => candidate.attribute_id !== 9048),
  }
  const target = row(1)
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={withoutModel}
      rows={[target]}
      productDrafts={{ [target.draftId]: instance(target) }}
      selectedRowIds={new Set([target.id])}
    />,
  )
  assert.match(html, /当前类目无型号属性/)
  assert.doesNotMatch(html, /aria-label="型号 SZ-0001\.png"/)
  // No 9048 to write means no 型号 batch verb either.
  assert.doesNotMatch(html, /aria-label="设置所选/)
})
