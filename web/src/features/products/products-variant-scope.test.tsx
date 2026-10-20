/**
 * 分组列与详情入口的渲染契约，以及「换范围就清空」的接线契约。
 *
 * 交互无法在 node:test 里模拟，所以清理逻辑放在纯函数里（products-variant-model
 * 的 openInScope / VariantPreviewGuard），这里钉住两件事：列真的画出来了、
 * 屏幕与编排层真的把范围键接上了。
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"

import { ProductRow } from "./product-row"
import type { StoreProductRow } from "./products-api"
import { ProductsTable } from "./products-table"
import { ProductVariantCell } from "./products-variant-column"

/**
 * 镜像行。分组列的 `modelId` / `modelCount` 直接取自生成的列表 DTO——这里不再
 * 用交叉类型补字段，DTO 丢掉这两列时 `row({ modelId })` 会先编译不过。
 */
function row(over: Partial<StoreProductRow> = {}): StoreProductRow {
  return {
    store_id: "11111111-2222-3333-4444-555555555555",
    store_name: "测试店",
    product_id: 101,
    offer_id: "A-1",
    name: "杯垫",
    sku: 7,
    state: "on_sale",
    gone: false,
    ...over,
  }
}

function sourceOf(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8")
}

/** `first` 命中之后 `within` 行内必须出现 `second`——用来钉住跨行的接线。 */
function nearby(source: string, first: RegExp, second: RegExp, within = 10): boolean {
  const lines = source.split("\n")
  const start = lines.findIndex((line) => first.test(line))
  if (start < 0) return false
  return lines.slice(start, start + within).some((line) => second.test(line))
}

test("同款列画出分组事实，缺席读「—」，并接上详情入口", () => {
  assert.match(
    renderToStaticMarkup(<ProductVariantCell row={row({ model_id: 900, model_count: 3 })} />),
    /3 件同款/,
  )
  assert.match(renderToStaticMarkup(<ProductVariantCell row={row({ model_id: 900 })} />), /已成组/)
  const unknown = renderToStaticMarkup(<ProductVariantCell row={row()} />)
  assert.match(unknown, /—/)
  assert.doesNotMatch(unknown, />0</)
  // 详情入口是有名字的按钮；没有回调时这一格是纯文本。
  const open = renderToStaticMarkup(
    <ProductVariantCell row={row({ model_id: 900, model_count: 3 })} onOpen={() => {}} />,
  )
  assert.match(open, /aria-label="查看 A-1 的同款规格"/)
  assert.match(open, /<button/)
  assert.doesNotMatch(unknown, /<button/)
})

test("商品行带上同款格，且这一格没有写入入口", () => {
  const markup = renderToStaticMarkup(
    <table>
      <tbody>
        <ProductRow
          row={row({ model_id: 900, model_count: 2 })}
          showStore={false}
          verifying={false}
          verifyDisabled={false}
          onAction={() => {}}
          onOpenVariant={() => {}}
        />
      </tbody>
    </table>,
  )
  assert.match(markup, /2 件同款/)
  assert.match(markup, /aria-label="查看 A-1 的同款规格"/)
  // 行上仍然只有一个「⋯」操作入口，分组动作也没有被平铺进行里。
  assert.equal((markup.match(/aria-label="A-1 的操作"/g) ?? []).length, 1)
  assert.doesNotMatch(markup, />合并为同款</)
  assert.doesNotMatch(markup, />移入已有同款</)
})

test("表头列数与展开行/空状态的列跨度一致——加列不会漏改一处", () => {
  const markup = renderToStaticMarkup(
    <ProductsTable
      rows={[]}
      showStore={false}
      currencyOf={() => null}
      selectedKeys={new Set()}
      onSelectedKeys={() => {}}
      verifying={new Set()}
      verifyDisabled={false}
      onAction={() => {}}
      onApplied={() => {}}
      loading={false}
      freshness={null}
      hasMore={false}
      onLoadMore={() => {}}
    />,
  )
  const heads = (markup.match(/<th /g) ?? []).length
  const span = Number(/col[Ss]pan="(\d+)"/.exec(markup)?.[1] ?? "0")
  assert.equal(heads, 14)
  assert.equal(span, heads)
  assert.match(markup, />同款</)
})

test("换店铺清勾选、清促销详情、清同款详情", () => {
  const source = sourceOf("products-screen.tsx")
  // 店铺选择器的回调里先清范围，再换店铺。
  assert.ok(
    nearby(source, /onValueChange=\{\(next\) => \{/, /resetScope\(\)/, 4),
    "换店铺前必须调用 resetScope",
  )
  // resetScope 一次清三样：勾选、促销详情、同款详情。
  for (const clear of [/setSelectedKeys\(new Set\(\)\)/, /setDetailKey\(null\)/, /setVariantKey\(null\)/]) {
    assert.ok(nearby(source, /const resetScope = useCallback/, clear, 8), String(clear))
  }
  // 范围键由工作空间 + 店铺合成，并传给编排层与两个读取面。
  assert.match(source, /variantScopeKey\(workspaceId, storeId\)/)
  assert.match(source, /scopeKey=\{scopeKey\}/)
  assert.match(source, /<ProductVariantDetailSheet/)
  // 列表重载时勾选也清（既有语义，分组动作沿用）。
  assert.match(source, /if \(!cursor\) setSelectedKeys\(new Set\(\)\)/)
})

test("编排层按范围作废打开状态，预览只属于当前范围", () => {
  const source = sourceOf("use-product-writes.tsx")
  assert.match(source, /scope: scopeKey/)
  assert.match(source, /const opened = openInScope\(mutation, scopeKey\)/)
  assert.match(source, /isVariantAction\(opened\.action\)/)
  // 关掉再打开是一次新意图：只在打开时挂载，内部状态与 operation_id 都会换新。
  assert.ok(
    nearby(source, /\{variantAction \? \(/, /<ProductVariantDialog/, 4),
    "分组弹窗只在打开时挂载",
  )
  // 四个对话框都用范围校验后的打开状态，没人绕过它。
  assert.doesNotMatch(source, /open=\{mutation\?\.action/)
})

test("预览读取带作废守卫，换范围/关窗后晚到回包不能重填", () => {
  const source = sourceOf("products-variant-preview.ts")
  assert.match(source, /new VariantPreviewGuard\(\)/)
  assert.match(source, /guard\.current\.clear\(\)/)
  assert.match(source, /guard\.current\.accepts\(token\)/)
  assert.match(source, /scopeKey/)
})
