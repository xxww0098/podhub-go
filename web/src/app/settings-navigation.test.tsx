import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SidebarProvider } from "@/components/ui/sidebar"
import { settingsRowsFor } from "@/lib/settings-sections"
import { SettingsNavigation } from "./settings-navigation"

test("settings navigation exposes only permitted sections and marks the current pane", () => {
  const render = (role: string) => renderToStaticMarkup(
    <SidebarProvider>
      <SettingsNavigation rows={settingsRowsFor(role)} pane="account" onSelect={() => {}} />
    </SidebarProvider>,
  )
  const personal = render("user")
  assert.match(personal, /aria-current="page"/)
  assert.doesNotMatch(personal, /<input|搜索设置/)
  assert.doesNotMatch(personal, /AI 账号|厂家账号/)
  const admin = render("super_admin")
  for (const row of settingsRowsFor("super_admin")) {
    assert.ok(admin.includes(`aria-label="${row.label}"`), row.label)
  }
  assert.doesNotMatch(admin, /role="dialog"/)
})

test("settings groups remain expanded for every selected section", () => {
  const render = (pane: "account" | "plans" | "ai-accounts") => renderToStaticMarkup(
    <SidebarProvider>
      <SettingsNavigation rows={settingsRowsFor("super_admin")} pane={pane} onSelect={() => {}} />
    </SidebarProvider>,
  )
  const group = (html: string, label: string) =>
    html.match(new RegExp(`<div(?=[^>]*data-settings-group="${label}")[^>]*>`))?.[0] ?? ""

  for (const pane of ["account", "plans", "ai-accounts"] as const) {
    const html = render(pane)
    for (const label of ["个人", "工作空间", "平台管理"]) {
      assert.ok(group(html, label), label)
      assert.doesNotMatch(group(html, label), /aria-expanded|role="button"|bg-sidebar-accent|text-sidebar-accent-foreground/)
    }
    for (const row of settingsRowsFor("super_admin")) {
      assert.ok(html.includes(`aria-label="${row.label}"`), row.label)
    }
    assert.doesNotMatch(html, /\shidden(?:=""|[ >])/)
  }
  assert.match(render("ai-accounts"), /aria-label="AI 账号" aria-current="page"/)
  assert.doesNotMatch(render("ai-accounts"), /aria-label="AI识图"/)
  assert.doesNotMatch(render("ai-accounts"), /AI 账号池/)
})
