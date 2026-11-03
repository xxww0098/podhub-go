import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CardThemeCell } from "./card-default-cells"

test("无主题属性的卡片显示禁用提示，不保留旧主题也不能打开选择器", () => {
  const html = renderToStaticMarkup(
    <CardThemeCell
      title="15盎司白色马克杯"
      value="旧主题"
      disabled
      unsupported
      onOpen={() => { throw new Error("must not open") }}
    />,
  )
  assert.match(html, /<p[^>]*aria-label="主题 15盎司白色马克杯"/)
  assert.match(html, /当前类目无主题属性/)
  assert.doesNotMatch(html, /旧主题|<button/)
})
