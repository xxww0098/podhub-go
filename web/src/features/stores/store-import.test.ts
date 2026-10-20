import assert from "node:assert/strict"
import test from "node:test"

import { formatStoreImportText, parseStoreImportText } from "./store-import"

test("a clean line yields name, client id and key", () => {
  const { rows, issues } = parseStoreImportText(
    "test,4995868,763954c3-5e68-48c9-b2a9-fa5dcbcd77e9",
  )
  assert.equal(issues.length, 0)
  assert.deepEqual(rows, [
    {
      line: 1,
      name: "test",
      clientId: "4995868",
      apiKey: "763954c3-5e68-48c9-b2a9-fa5dcbcd77e9",
      source: "test,4995868,763954c3-5e68-48c9-b2a9-fa5dcbcd77e9",
    },
  ])
})

test("one row per line; blank lines and CRLF are absorbed", () => {
  const { rows, issues } = parseStoreImportText(
    "a店,111,key-a\r\n\r\n  \nb店,222,key-b\n",
  )
  assert.equal(issues.length, 0)
  assert.deepEqual(
    rows.map((row) => [row.line, row.name, row.clientId, row.apiKey]),
    [
      [1, "a店", "111", "key-a"],
      [4, "b店", "222", "key-b"],
    ],
  )
})

test("full-width commas separate fields too", () => {
  const { rows, issues } = parseStoreImportText("主店，4995868，key-1")
  assert.equal(issues.length, 0)
  assert.equal(rows[0].name, "主店")
  assert.equal(rows[0].clientId, "4995868")
  assert.equal(rows[0].apiKey, "key-1")
})

test("a name containing commas survives because id and key come from the right edge", () => {
  const { rows, issues } = parseStoreImportText("旗舰店, 二号仓,4995868,key-1")
  assert.equal(issues.length, 0)
  assert.equal(rows[0].name, "旗舰店, 二号仓")
  assert.equal(rows[0].clientId, "4995868")
  assert.equal(rows[0].apiKey, "key-1")
})

test("lines short on fields or with an empty field become issues, keeping their line numbers", () => {
  const { rows, issues } = parseStoreImportText(
    "ok,1,k\n只有两个字段,4995868\n,4995868,key\n店,,\n店,4995868,",
  )
  assert.deepEqual(rows.map((row) => row.line), [1])
  assert.deepEqual(
    issues.map((issue) => [issue.line, issue.reason]),
    [
      [2, "格式应为 店铺名,Client ID,API Key"],
      [3, "缺少店铺名"],
      [4, "缺少 Client ID"],
      [5, "缺少 API Key"],
    ],
  )
})

test("fields are trimmed", () => {
  const { rows } = parseStoreImportText("  主店 , 4995868 , key-1  ")
  assert.equal(rows[0].name, "主店")
  assert.equal(rows[0].clientId, "4995868")
  assert.equal(rows[0].apiKey, "key-1")
})

test("export formats one store per line and parses back losslessly", () => {
  const text = formatStoreImportText([
    { name: "test", client_id: "4995868", api_key: "763954c3-5e68-48c9-b2a9-fa5dcbcd77e9" },
    { name: "旗舰店, 二号仓", client_id: "1", api_key: "k" },
  ])
  assert.equal(
    text,
    "test,4995868,763954c3-5e68-48c9-b2a9-fa5dcbcd77e9\n旗舰店, 二号仓,1,k",
  )
  const { rows, issues } = parseStoreImportText(text)
  assert.equal(issues.length, 0)
  assert.deepEqual(
    rows.map((row) => [row.name, row.clientId, row.apiKey]),
    [
      ["test", "4995868", "763954c3-5e68-48c9-b2a9-fa5dcbcd77e9"],
      ["旗舰店, 二号仓", "1", "k"],
    ],
  )
})

test("#标签 tokens after the API Key become the row's tag set", () => {
  const { rows, issues } = parseStoreImportText(
    "a店,111,key-a #华东 #VIP\nb店,222,key-b#自营\nc店,333,key-c #华东 #华东\n主店，444，key-d ＃全角",
  )
  assert.equal(issues.length, 0)
  assert.deepEqual(rows[0].tags, ["华东", "VIP"])
  assert.deepEqual(rows[1].tags, ["自营"])
  assert.deepEqual(rows[2].tags, ["华东"])
  assert.deepEqual(rows[3].tags, ["全角"])
})

test("a line without a marker leaves tags undefined; a bare marker clears", () => {
  const { rows, issues } = parseStoreImportText("a店,111,key-a\nb店,222,key-b #\n")
  assert.equal(issues.length, 0)
  assert.equal(rows[0].tags, undefined)
  assert.deepEqual(rows[1].tags, [])
})

test("a name carrying # keeps it because only the last field is scanned", () => {
  const { rows, issues } = parseStoreImportText("店#1铺,123,key #a")
  assert.equal(issues.length, 0)
  assert.equal(rows[0].name, "店#1铺")
  assert.deepEqual(rows[0].tags, ["a"])
})

test("an overlong tag name turns the line into an issue", () => {
  const { rows, issues } = parseStoreImportText(`a店,111,key #${"长".repeat(65)}`)
  assert.equal(rows.length, 0)
  assert.deepEqual(issues, [
    {
      line: 1,
      source: `a店,111,key #${"长".repeat(65)}`,
      reason: "标签名过长",
    },
  ])
})

test("export writes tags as # suffixes and skips names it cannot encode", () => {
  const text = formatStoreImportText([
    { name: "a店", client_id: "1", api_key: "k-1", tags: ["华东", "VIP 仓"] },
    { name: "b店", client_id: "2", api_key: "k-2", tags: ["逗,号", "好#名", "正常"] },
    { name: "c店", client_id: "3", api_key: "k-3", tags: [] },
    { name: "d店", client_id: "4", api_key: "k-4" },
  ])
  assert.equal(text, "a店,1,k-1 #华东 #VIP 仓\nb店,2,k-2 #正常\nc店,3,k-3\nd店,4,k-4")
  const { rows, issues } = parseStoreImportText(text)
  assert.equal(issues.length, 0)
  assert.deepEqual(rows[0].tags, ["华东", "VIP 仓"])
  assert.deepEqual(rows[1].tags, ["正常"])
  assert.equal(rows[2].tags, undefined)
  assert.equal(rows[3].tags, undefined)
})
