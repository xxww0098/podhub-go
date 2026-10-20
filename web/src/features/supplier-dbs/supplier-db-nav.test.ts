import assert from "node:assert/strict"
import test from "node:test"

import { openSupplierDbId, writeOpenSupplierDb } from "./supplier-db-nav"

/**
 * Borrow the window for one test: `replaceAddress` needs `location` +
 * `history.replaceState`, and nothing else in the module touches the DOM.
 */
function withWindow(href: string) {
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  const location = new URL(href)
  globals.window = {
    location,
    history: {
      replaceState(_state: unknown, _title: string, next: string) {
        location.href = new URL(next, location).href
      },
    },
  }
  return {
    location,
    restore: () => {
      if (previous === undefined) delete globals.window
      else globals.window = previous
    },
  }
}

test("?open= 读作打开态：空白与空串都算没打开", () => {
  assert.equal(openSupplierDbId("?screen=supplier-dbs&open=src_1"), "src_1")
  assert.equal(openSupplierDbId("?open=%20src_1%20"), "src_1")
  assert.equal(openSupplierDbId("?open="), null)
  assert.equal(openSupplierDbId("?open=%20"), null)
  assert.equal(openSupplierDbId("?screen=supplier-dbs"), null)
  assert.equal(openSupplierDbId(""), null)
})

test("进库写地址、回列表清键——刷新才停在同一个库页", () => {
  const { location, restore } = withWindow(
    "http://localhost/?screen=supplier-dbs&q=keep",
  )
  try {
    writeOpenSupplierDb("src_1")
    assert.equal(location.searchParams.get("screen"), "supplier-dbs")
    assert.equal(location.searchParams.get("open"), "src_1")
    // 别的键是别人的事：写打开态不打扫地址。
    assert.equal(location.searchParams.get("q"), "keep")
    // 换库只改同一个键，不新增浏览器历史条目。
    writeOpenSupplierDb("src_2")
    assert.equal(location.searchParams.get("open"), "src_2")
    assert.equal(location.searchParams.get("q"), "keep")
    writeOpenSupplierDb(null)
    assert.equal(location.searchParams.has("open"), false)
    assert.equal(location.searchParams.get("screen"), "supplier-dbs")
    // 已经是「没有打开态」时不写地址（replaceAddress 对同址不通知）。
    const settled = location.href
    writeOpenSupplierDb(null)
    assert.equal(location.href, settled)
  } finally {
    restore()
  }
})

test("库页打开态不写到别的屏上", () => {
  const { location, restore } = withWindow("http://localhost/?screen=listing")
  try {
    writeOpenSupplierDb("src_1")
    assert.equal(location.search, "?screen=listing")
  } finally {
    restore()
  }
})

test("地址里遗留的 open 键在别的屏上会被收掉", () => {
  const { location, restore } = withWindow(
    "http://localhost/?screen=listing&open=src_1",
  )
  try {
    writeOpenSupplierDb(null)
    assert.equal(location.search, "?screen=listing")
  } finally {
    restore()
  }
})
