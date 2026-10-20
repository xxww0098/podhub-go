import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "@/components/ui/toast"
import { peekListingWorkbench, resetListingWorkbench } from "../workbench/listing-workbench-store"
import { runnerOpenRefused } from "../workflow-screen"

test("supplier_not_listable refusal pauses the queue and toasts the classified copy", () => {
  resetListingWorkbench()
  // 拒绝原文是 fetch client 的落名：code 带 cloud_ 前缀、denial 原样透传。
  // message 置空 → 走分类 fallback（后端 message 在场时仍优先，见下一条断言）。
  const refusal = {
    code: "cloud_supplier_not_listable",
    message: "",
    denial: "catalog_expired",
  }
  const lines: unknown[][] = []
  const original = console.log
  const originalAdd = toast.add
  console.log = (...args: unknown[]) => {
    if (String(args[0]).startsWith("[notify]")) lines.push(args)
  }
  toast.add = (() => "spy") as typeof toast.add
  try {
    runnerOpenRefused(refusal)
    assert.equal(peekListingWorkbench().queuePaused, true, "进入上架失败仍暂停队列")
    assert.equal(lines.length, 1)
    assert.match(String(lines[0]?.[0]), /^\[notify\] error code=cloud_supplier_not_listable errorId=[0-9]{20} message=平台正在复核该商品的 Ozon 配置，暂不可上架$/)

    // 停售归停售句；后端写了话就照旧用原文——前端只是兜底。
    lines.length = 0
    runnerOpenRefused({ code: "cloud_supplier_not_listable", message: "", denial: "product_archived" })
    assert.equal(lines.length, 1)
    assert.match(String(lines[0]?.[0]), /^\[notify\] error code=cloud_supplier_not_listable errorId=[0-9]{20} message=该商品已停售，不可上架$/)
    lines.length = 0
    runnerOpenRefused({
      code: "cloud_supplier_not_listable",
      message: "Ozon 配置已过期，等待平台复核",
      denial: "catalog_expired",
    })
    assert.equal(lines.length, 1)
    assert.match(String(lines[0]?.[0]), /^\[notify\] error code=cloud_supplier_not_listable errorId=[0-9]{20} message=Ozon 配置已过期，等待平台复核$/)

    // 别的拒绝码不吃这条规则——通用 fallback 不变。
    lines.length = 0
    runnerOpenRefused({ code: "cloud_unavailable", message: "" })
    assert.equal(lines.length, 1)
    assert.match(String(lines[0]?.[0]), /^\[notify\] error code=cloud_unavailable errorId=[0-9]{20} message=无法进入上架执行，请稍后重试。$/)
  } finally {
    console.log = original
    toast.add = originalAdd
    toast.close()
    resetListingWorkbench()
  }
})
