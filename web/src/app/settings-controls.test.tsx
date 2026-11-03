import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AppearanceRows } from "./settings-controls"

test("主题选择是单选组，三个选项恰有一个选中", () => {
  const html = renderToStaticMarkup(<AppearanceRows />)
  const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []
  assert.equal(radios.length, 3)
  assert.ok(radios.every((radio) => radio.includes('name="appearance-theme"')))
  assert.equal(radios.filter((radio) => radio.includes('checked=""')).length, 1)
  assert.match(html, /跟随系统/)
  assert.match(html, /浅色/)
  assert.match(html, /深色/)
})
