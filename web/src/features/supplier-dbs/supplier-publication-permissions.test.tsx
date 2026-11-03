import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SupplierDbsScreen } from "./supplier-dbs-screen"
import { SupplierDbBulkBar, type useSupplierDbActions } from "./supplier-db-actions"
import { db, row, readyStore } from "./supplier-dbs-screen-fixtures"

test("publication status is read-only for ordinary platform administrators", async () => {
  const { store } = await readyStore([{ db: db("src", "Factory"), propDefs: [], rows: [row("p", "src", { published: true })] }])
  await store.loadDetail("src")
  const render = (role: string) => renderToStaticMarkup(<TooltipProvider><SupplierDbsScreen role={role} store={store} /></TooltipProvider>)
  assert.doesNotMatch(render("admin"), /aria-label="状态 已发布"/)
  assert.match(render("super_admin"), /aria-label="状态 已发布"/)
})

test("bulk publication actions require the super administrator flag", () => {
  for (const canPublish of [false, true]) {
    const actions: ReturnType<typeof useSupplierDbActions> = { selectedIds: new Set(["p"]), setSelectedIds: () => {}, bulkBusy: null, bulkConfirm: null, setBulkConfirm: () => {}, runBulk: async () => {}, canPublish }
    const bulk = renderToStaticMarkup(<TooltipProvider><SupplierDbBulkBar actions={actions} /></TooltipProvider>)
    assert.equal(bulk.includes('aria-label="发布所选"'), canPublish)
    assert.equal(bulk.includes('aria-label="停用所选"'), canPublish)
  }
})
