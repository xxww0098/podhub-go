/**
 * 同款镜像事实保持只读；切换范围后写入弹窗不得保留上一店的商品。
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"

import { ProductRow } from "./product-row"
import type { StoreProductRow } from "./products-api"
import { openInScope, productScopeKey } from "./products-mutation"
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
    sku: "7",
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

test("同款事实来自镜像，缺席读「—」，没有预览入口", () => {
  const grouped = renderToStaticMarkup(<ProductVariantCell row={row({ model_id: 900, model_count: 3 })} />)
  assert.match(grouped, /3 件同款/)
  assert.doesNotMatch(grouped, /<button|<a\s/)
  assert.match(renderToStaticMarkup(<ProductVariantCell row={row({ model_id: 900 })} />), /已成组/)
  const unknown = renderToStaticMarkup(<ProductVariantCell row={row()} />)
  assert.match(unknown, /—/)
  assert.doesNotMatch(unknown, />0</)
  assert.doesNotMatch(unknown, /<button/)
})

test("商品行保留商品身份和操作入口", () => {
  const markup = renderToStaticMarkup(
    <table>
      <tbody>
        <ProductRow
          row={row({ model_id: 900, model_count: 2 })}
          showStore={false}
          verifying={false}
          verifyDisabled={false}
          onAction={() => {}}
        />
      </tbody>
    </table>,
  )
  assert.match(markup, /A-1/)
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
      snapshotAtOf={() => null}
      selectedKeys={new Set()}
      onSelectedKeys={() => {}}
      verifying={new Set()}
      verifyDisabled={false}
      onAction={() => {}}
      onApplied={() => {}}
      loading={false}
      failed={false}
      noStores={false}
      onRetry={() => {}}
      freshness={null}
      hasMore={false}
      onLoadMore={() => {}}
    />,
  )
  const heads = (markup.match(/<th /g) ?? []).length
  const span = Number(/col[Ss]pan="(\d+)"/.exec(markup)?.[1] ?? "0")
  assert.equal(heads, 8)
  assert.equal(span, heads)
  assert.match(markup, />商品信息 \/ 货号</)
})

test("换店铺清勾选和促销详情", () => {
  const source = sourceOf("products-screen.tsx")
  // 店铺选择器的回调里先清范围，再换店铺。
  assert.ok(
    nearby(source, /onValueChange=\{\(next\) => \{/, /resetScope\(\)/, 4),
    "换店铺前必须调用 resetScope",
  )
  for (const clear of [/setSelectedKeys\(new Set\(\)\)/, /setDetailKey\(null\)/]) {
    assert.ok(nearby(source, /const resetScope = useCallback/, clear, 8), String(clear))
  }
  assert.match(source, /productScopeKey\(workspaceId, storeId\)/)
  assert.doesNotMatch(source, /ProductVariantDetailSheet|onOpenVariant/)
  // 列表重载时勾选也清。
  assert.match(source, /if \(!cursor\) setSelectedKeys\(new Set\(\)\)/)
})

test("编排层按范围作废打开状态", () => {
  const source = sourceOf("use-product-writes.tsx")
  assert.match(source, /scope: scopeKey/)
  assert.match(source, /const opened = openInScope\(mutation, scopeKey\)/)
  assert.doesNotMatch(source, /ProductVariantDialog|productVariantsHttp/)
  // 四个对话框都用范围校验后的打开状态，没人绕过它。
  assert.doesNotMatch(source, /open=\{mutation\?\.action/)
})

test("工作空间或店铺变化时不复用先前打开的写入操作", () => {
  const opened = { scope: productScopeKey(1, "store-a"), action: "price" }
  assert.equal(openInScope(opened, productScopeKey(1, "store-a")), opened)
  assert.equal(openInScope(opened, productScopeKey(1, "store-b")), null)
  assert.equal(openInScope(opened, productScopeKey(2, "store-a")), null)
  assert.equal(openInScope(null, productScopeKey(1, "store-a")), null)
})
