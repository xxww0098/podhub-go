import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { SidebarProvider } from "@/components/ui/sidebar"
import { FactoryAccountMenu } from "./factory-account-menu"

test("工厂账号卡显示真实姓名和成员角色", () => {
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <FactoryAccountMenu name="李工" email="factory@example.com" onSignedOut={() => {}} />
    </SidebarProvider>,
  )
  assert.match(html, /账号菜单，李工/)
  assert.match(html, /工厂成员/)
  assert.doesNotMatch(html, /张工厂/)
})

test("账号无姓名时使用邮箱作为显示名称", () => {
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <FactoryAccountMenu name=" " email="factory@example.com" onSignedOut={() => {}} />
    </SidebarProvider>,
  )
  assert.match(html, /账号菜单，factory@example.com/)
})
