import assert from "node:assert/strict"
import test from "node:test"
import {
  readCatalogPick,
  readWorkflowCardId,
  withCatalogPick,
  withoutCatalogPick,
  writeWorkflowCardId,
} from "./workflow-navigation"

test("上架表刷新恢复 cardId，并保留 screen 与 hash", () => {
  const href = "https://example.test/?screen=listing&cardId=card-old#main"
  assert.equal(readWorkflowCardId("?screen=listing&cardId=card-old"), "card-old")
  assert.equal(readWorkflowCardId("?screen=listing&cardId=%20"), undefined)
  assert.equal(
    writeWorkflowCardId(href, "card-current"),
    "/?screen=listing&cardId=card-current#main",
  )
  assert.equal(
    writeWorkflowCardId(href),
    "/?screen=listing#main",
  )
  assert.equal(
    writeWorkflowCardId(
      "https://example.test/?screen=listing&product=scp_1&q=hat#main",
    ),
    "/?screen=listing#main",
  )
})

test("选品意图 ?pick=1 带上与收掉，其余参数原位保留", () => {
  const search = "?screen=listing&db=src_1&q=hat"
  assert.equal(withCatalogPick(search), "?screen=listing&db=src_1&q=hat&pick=1")
  assert.equal(withoutCatalogPick(`${search}&pick=1`), search)
  // 与 withScreen 同口径：URLSearchParams 归一编码，值本身不丢。
  assert.equal(withCatalogPick("?q=帽"), "?q=%E5%B8%BD&pick=1")
  // 无意图时读作 false；非 "1" 的脏值不收。
  assert.equal(readCatalogPick(search), false)
  assert.equal(readCatalogPick("?pick=0"), false)
  assert.equal(readCatalogPick("?pick=1"), true)
})

test("收掉商库之外的参数：只剩 pick 时回空串而不是裸问号", () => {
  assert.equal(withoutCatalogPick("?pick=1"), "")
  assert.equal(withCatalogPick(""), "?pick=1")
})
