import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ProductionThumbnail } from "./production-thumbnail"
import { route } from "@/api/routes"

test("有授权生产素材时使用延迟加载，没有素材时说明未知", () => {
  const imageUrl = route("supplierDispatchesByDispatchIdAssetsByAssetId", { dispatch_id: "d", asset_id: "a" })
  const withImage = renderToStaticMarkup(<ProductionThumbnail url={imageUrl} />)
  assert.ok(withImage.includes(`src="${imageUrl}"`))
  assert.match(withImage, /loading="lazy"/)
  assert.match(withImage, /生产素材预览/)
  const empty = renderToStaticMarkup(<ProductionThumbnail />)
  assert.match(empty, /暂无生产素材预览/)
  assert.doesNotMatch(empty, /<img/)
})
