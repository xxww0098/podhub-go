import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CatalogArchiveAction, archiveBlockReason } from "./catalog-manager-screen"

test("商品负责人不能归档已发布商品，并给出可悬停的原因", () => {
  assert.equal(archiveBlockReason(true, false), "已发布商品仅超级管理员可归档")
  assert.equal(archiveBlockReason(true, true), undefined)
  assert.equal(archiveBlockReason(false, false), undefined)

  const blocked = renderToStaticMarkup(
    <CatalogArchiveAction row={{ title: "已发布商品", published: true }} canPublish={false} busy={false} onArchive={() => {}} />,
  )
  assert.match(blocked, /title="已发布商品仅超级管理员可归档"/)
  assert.match(blocked, /aria-label="归档 已发布商品"/)
  assert.match(blocked, /disabled=""/)

  const allowed = renderToStaticMarkup(
    <CatalogArchiveAction row={{ title: "已发布商品", published: true }} canPublish busy={false} onArchive={() => {}} />,
  )
  assert.doesNotMatch(allowed, /title="已发布商品仅超级管理员可归档"/)
  assert.doesNotMatch(allowed, /disabled=""/)
})
