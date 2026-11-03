import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { FactoryWorkspaceMenu } from "./factory-workspace-menu"

test("工作空间卡显示当前工厂并提供可访问的切换入口", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider><SidebarProvider>
      <FactoryWorkspaceMenu
        sources={[
          { source_id: "a", name: "工厂甲", country: "", icon: "" },
          { source_id: "b", name: "工厂乙", country: "", icon: "" },
        ]}
        selectedId="b"
        onSelect={() => {}}
      />
    </SidebarProvider></TooltipProvider>,
  )
  assert.match(html, /工厂工作空间：工厂乙/)
  assert.match(html, /工厂工作空间/)
  assert.doesNotMatch(html, /示例工厂/)
})

test("选中项缺失时不冒用其他工厂", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider><SidebarProvider>
      <FactoryWorkspaceMenu
        sources={[{ source_id: "a", name: "工厂甲", country: "", icon: "" }]}
        selectedId="missing"
        onSelect={() => {}}
      />
    </SidebarProvider></TooltipProvider>,
  )
  assert.match(html, /未选择工作空间/)
  assert.doesNotMatch(html, /工厂甲/)
})
