import assert from "node:assert/strict"
import test from "node:test"
import { salePriceCommitPlan } from "./card-library"
import { defaultPricePairRejected } from "./card-library-host"
import { renderLibrary, sampleCard } from "./card-library-test-support"
import { parseSalePrice } from "./sale-price"

test("名册有主题与 JSON富内容两列，与价格并列展示卡默认", () => {
  const html = renderLibrary([
    {
      ...sampleCard,
      defaults: {
        values: {
          attribute_7109: {
            kind: "multi_select",
            value: [
              { dictionary_value_id: 970742650, value: "花卉和植物" },
              { dictionary_value_id: 970742668, value: "猫" },
            ],
          },
          attribute_11254: {
            kind: "text",
            value: '{"content":[{"type":"text","text":"油画"}]}',
          },
        },
        complex_values: [],
      },
    },
  ])

  assert.match(html, /<th[^>]*>主题</)
  assert.match(html, /<th[^>]*>JSON富内容</)
  assert.match(html, /aria-label="主题 夏季T恤"/)
  assert.match(html, /aria-label="JSON富内容 夏季T恤"/)
  assert.match(html, /花卉和植物、猫/)
  assert.match(html, /油画/)
})

test("销售价列展示卡默认并解析正小数", () => {
  const html = renderLibrary([{ ...sampleCard, price: "1990" }])
  assert.match(html, /aria-label="销售价 夏季T恤"/)
  assert.match(html, /value="1990"/)
  assert.equal(parseSalePrice(""), null)
  assert.equal(parseSalePrice(" 1990 "), 1990)
  assert.equal(parseSalePrice("19,5"), 19.5)
  assert.equal(parseSalePrice("0"), "invalid")
  assert.equal(parseSalePrice("abc"), "invalid")
})

test("划线价列与销售价并列展示卡默认", () => {
  const html = renderLibrary([{ ...sampleCard, price: "1990", old_price: "2490" }])
  assert.match(html, /aria-label="划线价 夏季T恤"/)
  assert.match(html, /value="2490"/)
})

test("走查复现：划线价为空时键入销售价 60 不会被预检拦下", () => {
  // 走查脚本二次输入的假象已由 defaultPricePairRejected 的行为断言钉死
  // （空侧不比较）；这里只复放走查的确切输入组合。
  assert.equal(defaultPricePairRejected(60, "price", ""), false)
  assert.equal(parseSalePrice(""), null)
})

test("价格对预检：另一侧为空不比较，两侧都有值时守严格大小", () => {
  assert.equal(defaultPricePairRejected(60, "price", undefined), false)
  assert.equal(defaultPricePairRejected(60, "price", ""), false)
  assert.equal(defaultPricePairRejected(60, "price", "50"), true)
  assert.equal(defaultPricePairRejected(60, "price", "60"), true)
  assert.equal(defaultPricePairRejected(50, "old_price", "60"), true)
  assert.equal(defaultPricePairRejected(70, "old_price", "60"), false)
  assert.equal(defaultPricePairRejected(70, "old_price", ""), false)
  assert.equal(defaultPricePairRejected(null, "old_price", "60"), false)
})

test("单元格提交计划：胡写不改写显示，等值不写，空输入是清空字段", () => {
  assert.deepEqual(salePriceCommitPlan(undefined, "60"), { kind: "save", value: 60 })
  assert.deepEqual(salePriceCommitPlan("1990", "abc"), { kind: "rejected" })
  assert.deepEqual(salePriceCommitPlan("1990", "0"), { kind: "rejected" })
  assert.deepEqual(salePriceCommitPlan("1990", "1990"), { kind: "unchanged" })
  assert.deepEqual(salePriceCommitPlan("1990", ""), { kind: "save", value: null })
})

test("保存失败保留输入并标 aria-invalid，只有 Escape 恢复原值", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./card-library.tsx", import.meta.url), "utf8")

  // 失败路径：不回滚成空，显示用户输入 + aria-invalid（文案走 toast 不进 DOM）。
  assert.match(source, /aria-invalid=\{invalid \|\| undefined\}/)
  assert.match(source, /value=\{focused \|\| invalid \? draft : \(price \?\? ""\)\}/)
  assert.match(source, /setInvalid\(saved === false\)/)
  assert.match(source, /setInvalid\(true\)/)
  // 外部同步（未失效时）与失效态各自 guarded，失效输入不被 price prop 覆写。
  assert.match(source, /if \(!focused && !invalid\) setDraft\(price \?\? ""\)/)
  // Escape 是唯一的静默恢复路径：丢弃草稿、清 invalid（在 skipCommit 的 blur 收尾里）。
  const cell = source.slice(source.indexOf("function CardSalePriceCell"))
  assert.notEqual(cell.indexOf('event.key === "Escape"'), -1)
  const skipAt = cell.indexOf("if (skipCommit.current) {")
  assert.notEqual(skipAt, -1)
  assert.match(cell.slice(skipAt, skipAt + 220), /setInvalid\(false\)/)
})

test("saveDefaultPrice 向单元格区分成败：守卫无判定，预检与请求失败 false，落库 true", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./card-library-host.tsx", import.meta.url), "utf8")
  const fn = source.slice(
    source.indexOf("async function saveDefaultPrice"),
    source.indexOf("async function bindCardStores"),
  )
  assert.match(fn, /: Promise<boolean \| undefined>/)
  // 守卫早退（忙/占用/来源失效）无判定：不置 invalid、不静默报错。
  assert.match(fn, /return undefined/)
  assert.match(fn, /return false/)
  assert.match(fn, /return true/)
  // 行同步失败只通知，价格本体已保存 → 仍算成功（显示跟随服务端真值）。
  const syncAt = fn.indexOf("syncRowsForDefaultField")
  const returnTrueAt = fn.indexOf("return true")
  assert.ok(syncAt !== -1 && returnTrueAt > syncAt)
})

test("主题与富内容走同一条卡默认可写与回写路径", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./card-library-host.tsx", import.meta.url), "utf8")
  const fn = source.slice(
    source.indexOf("async function saveDefaultField"),
    source.indexOf("async function bindCardStores"),
  )
  assert.match(fn, /listingCardSaveDefaultField\(/)
  assert.match(fn, /syncRowsForDefaultField\(/)
  // 键必须是打开时读到的 Schema key（调用方解析），不在宿主里硬编码属性 7109/11254。
  assert.doesNotMatch(fn, /attribute_7109|attribute_11254/)
})

test("富内容弹窗封顶：文本框到上限就框内滚动，保存按钮不被挤出视口", async () => {
  const { readFile } = await import("node:fs/promises")
  const editor = await readFile(
    new URL("./workbench/workbench-cell-editor.tsx", import.meta.url),
    "utf8",
  )
  const dialog = await readFile(
    new URL("./card-default-cells.tsx", import.meta.url),
    "utf8",
  )
  const spec = await readFile(
    new URL("./workbench/workbench-prose-spec.tsx", import.meta.url),
    "utf8",
  )
  // 回归：Textarea 的 field-sizing-content 会跟着 JSON 行数无限长高，弹窗被
  // 顶出屏幕后底部的保存 / 填入按钮点不到。文本框封顶 + 框内滚动，弹窗再兜底可滚。
  // 富内容（rich_content 规格）覆盖为宽弹窗 + 高文本框；散文列保持紧凑默认。
  assert.match(
    spec,
    /max-h-\[min\(46rem,calc\(100dvh-2rem\)\)\] overflow-y-auto sm:max-w-3xl/,
    "富内容弹窗要放宽并封顶",
  )
  assert.match(spec, /min-h-64 max-h-112/, "富内容文本框要更高并封顶")
  assert.match(
    editor,
    /max-h-\[min\(42rem,calc\(100dvh-2rem\)\)\] overflow-y-auto sm:max-w-xl/,
    "散文弹窗保持默认封顶",
  )
  assert.match(
    editor,
    /"min-h-24 max-h-72 overflow-y-auto text-compact leading-5"/,
    "散文文本框保持默认封顶",
  )
  // 两个消费端都跟随规格；校验规格字面量时同时保留接线回归。
  assert.match(editor, /const spec = edit \? PROSE_EDITOR\[edit\.column\] : PROSE_EDITOR\.name/)
  assert.match(editor, /spec\.dialogClassName/)
  assert.match(editor, /spec\.textareaClassName/)
  // 名册弹窗不复写尺寸字面量，全部跟随 PROSE_EDITOR.rich_content 的规格。
  assert.match(dialog, /className=\{spec\.dialogClassName\}/)
  assert.match(dialog, /spec\.textareaClassName/)
})

test("价格单元格接线必须转发保存判定，void 吞掉布尔即失败静默回滚", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("./card-library.tsx", import.meta.url), "utf8")
  // 回归：onSave 曾写成 `(price) => void onSavePrice(form, price)`，布尔被丢，
  // setInvalid(saved === false) 永远 false——保存判定契约在接线处被废掉。
  assert.match(source, /onSave=\{\(price\) => onSavePrice\(form, price\)\}/)
  assert.match(source, /onSave=\{\(price\) => onSaveOldPrice\(form, price\)\}/)
  assert.doesNotMatch(source, /void onSave(?:Old)?Price/)
})
