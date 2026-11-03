import assert from "node:assert/strict"
import test from "node:test"
import type { ComponentProps, ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { StoreProductRow } from "./products-api"
import { buildDiscountMutation } from "./product-list-model"
import { ProductPriceDialog } from "./products-price-dialog"
import { useProductWrites } from "./use-product-writes"

test("a second price change uses the strike price returned by the first write", () => {
  let rows: StoreProductRow[] = [
    { store_id: "store", store_name: "店铺", product_id: 1, offer_id: "SKU", price: "100.00", old_price: "200.00", gone: false },
    { store_id: "other-store", store_name: "其他店铺", product_id: 1, offer_id: "SKU", price: "50.00", old_price: "100.00", gone: false },
  ]
  let opened = false
  let writes!: ReturnType<typeof useProductWrites>
  function Capture() {
    writes = useProductWrites({
      stores: [], syncDisabled: false, scopeKey: "workspace:store",
      setRows: (next) => { rows = typeof next === "function" ? next(rows) : next },
      clearSelection: () => {}, reloadOverview: async () => {}, reloadList: async () => {},
      listStatus: undefined, onArchived: () => {},
    })
    if (!opened) {
      opened = true
      writes.runAction("price", [rows[0]!])
    }
    return null
  }
  renderToStaticMarkup(<Capture />)
  const dialogs = writes.dialogs as ReactElement<{ children: ReactElement<ComponentProps<typeof ProductPriceDialog>>[] }>
  dialogs.props.children[0]!.props.onApplied([{ productId: 1, price: "80.00", oldPrice: "160.00" }])
  assert.equal(rows[0]!.old_price, "160.00")
  assert.equal(rows[1]!.old_price, "100.00", "another store's same product id is not patched")
  const row = rows[0]!
  const next = buildDiscountMutation([{
    productId: row.product_id, offerId: row.offer_id,
    price: Number(row.price), oldPrice: Number(row.old_price), currencyCode: "CNY",
  }], 10)
  assert.ok(next.kind === "price")
  assert.deepEqual(next.items.map((item) => [item.price, item.old_price]), [["144.00", "160.00"]])
})
