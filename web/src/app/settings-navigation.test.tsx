import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { settingsRowsFor } from "@/lib/settings-sections"
import { SettingsNavigation } from "./settings-navigation"

test("settings search retains active context and respects the role-filtered rows", () => {
  const render = (role: string, query: string) => renderToStaticMarkup(<SettingsNavigation rows={settingsRowsFor(role)} pane="account" query={query} onQuery={() => {}} onSelect={() => {}} />)
  const personal = render("user", "")
  assert.match(personal, /aria-current="page"/)
  assert.doesNotMatch(personal, /AI 账号池|厂家账号/)
  assert.match(render("super_admin", ""), /AI 账号池/)
  const filtered = render("super_admin", "不存在的设置")
  assert.match(filtered, /没有匹配的设置/)
  assert.doesNotMatch(filtered, /aria-current="page"/)
})
