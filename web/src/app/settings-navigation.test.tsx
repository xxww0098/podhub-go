import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SidebarProvider } from "@/components/ui/sidebar"
import { settingsRowsFor } from "@/lib/settings-sections"
import { SettingsNavigation } from "./settings-navigation"

test("settings replaces the sidebar with permitted sections and a way back", () => {
  const render = (role: string) => renderToStaticMarkup(
    <SidebarProvider>
      <SettingsNavigation rows={settingsRowsFor(role)} pane="account" onBack={() => {}} onSelect={() => {}} />
    </SidebarProvider>,
  )
  const personal = render("user")
  assert.match(personal, /aria-current="page"/)
  assert.match(personal, /aria-label="返回业务页面"/)
  assert.doesNotMatch(personal, /<input|搜索设置/)
  assert.doesNotMatch(personal, /AI 账号池|厂家账号/)
  const admin = render("super_admin")
  for (const row of settingsRowsFor("super_admin")) {
    assert.ok(admin.includes(`aria-label="${row.label}"`), row.label)
  }
  assert.doesNotMatch(admin, /role="dialog"/)
})
