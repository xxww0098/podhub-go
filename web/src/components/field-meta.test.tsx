import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { FieldMeta } from "./field-meta"

test("字段元信息不显示填写状态标识", () => {
  assert.equal(renderToStaticMarkup(<FieldMeta name="字段" />), "")
})

test("保留必填徽标与具名问号入口，不显示说明文字", () => {
  const html = renderToStaticMarkup(<FieldMeta name="包装高度" required description="单位为毫米。" />)
  assert.match(html, />必填</)
  assert.match(html, /aria-label="查看“包装高度”填写说明"/)
  assert.match(html, /<svg\b/)
  assert.doesNotMatch(html, /<\/svg>\s*说明/)
  assert.doesNotMatch(html, /已填|未填|data-field-status/)
  const optional = renderToStaticMarkup(<FieldMeta name="运费" />)
  assert.doesNotMatch(optional, /必填|<button/)
})

test("建议是安静的提示文本，必填优先且只显示一个标记", () => {
  const essential = renderToStaticMarkup(<FieldMeta name="确认属性" essential />)
  assert.match(essential, />建议</)
  assert.doesNotMatch(essential, />必填<|data-slot="badge"/)
  const required = renderToStaticMarkup(<FieldMeta name="商品类型" essential required />)
  assert.match(required, />必填</)
  assert.doesNotMatch(required, />建议</)
  assert.equal(required.match(/data-slot="badge"/g)?.length, 1)
})
