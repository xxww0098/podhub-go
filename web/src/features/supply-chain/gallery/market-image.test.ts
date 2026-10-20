import assert from "node:assert/strict"
import test from "node:test"

import { route } from "@/api/routes"
import { marketImageSrc } from "./market-image"

const source = "src_" + "a".repeat(32)
const id = "ab".repeat(32)

test("货盘图改走本站缩略图地址", () => {
  const url = `https://cdn.example/media/supplier-dbs/${source}/${id}.JPG?x=1`
  assert.equal(
    marketImageSrc(url, 640),
    `${route("supplierDbsCatalogImagesBySourceIdByFile", { source_id: source, file: `${id}.jpg` })}?edge=640`,
  )
  assert.equal(
    marketImageSrc(url, 256),
    `${route("supplierDbsCatalogImagesBySourceIdByFile", { source_id: source, file: `${id}.jpg` })}?edge=256`,
  )
})

test("不是本桶图集的地址保持原样", () => {
  assert.equal(marketImageSrc("https://img.example/1.jpg", 640), "https://img.example/1.jpg")
  assert.equal(marketImageSrc("not a url", 1280), "not a url")
})
