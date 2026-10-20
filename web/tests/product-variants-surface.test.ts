/**
 * 平台观察面保持只读：分组写入客户端只能被 `features/products` 使用，而且只有
 * 冻结契约里的三条路由。这个扫描是「admin-products 不挂写入入口」的机械化守卫——
 * 平台商品表（只读镜像 + 无核实按钮）一旦引入分组动作就会在这里变红。
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { productVariantsHttp } from "../src/bindings/http-product-variants"

const SRC = fileURLToPath(new URL("../src", import.meta.url))
const OWNER = join("features", "products")

function sources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") sources(path, found)
      continue
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(path)
  }
  return found
}

test("分组写入客户端只有冻结契约里的三条调用", () => {
  assert.deepEqual(Object.keys(productVariantsHttp).sort(), ["operate", "operation", "preview"])
  const source = readFileSync(join(SRC, "bindings", "http-product-variants.ts"), "utf8")
  // 只有预览 / 执行 / 回读三条路径，而且全部取自生成的路由权威表——
  // 没有自拼的第四条路径，也没有顺手加一个「批量改属性」的直通代理。
  assert.deepEqual(
    [...source.matchAll(/route\("(workspaceOpsProductVariants[A-Za-z]*)"[,)]/g)].map(
      (match) => match[1],
    ),
    [
      "workspaceOpsProductVariantsPreviews",
      "workspaceOpsProductVariantsOperations",
      "workspaceOpsProductVariantsOperationsByOperationId",
    ],
  )
  assert.doesNotMatch(source, /attributes/)
})

test("除店铺商品功能外，没有任何界面导入分组写入客户端", () => {
  const offenders: string[] = []
  for (const absolute of sources(SRC)) {
    const path = relative(SRC, absolute)
    const source = readFileSync(absolute, "utf8")
    if (!source.includes("@/bindings/http-product-variants")) continue
    if (path.startsWith(OWNER + "/") || path === join("bindings", "http-product-variants.ts")) continue
    offenders.push(path)
  }
  assert.deepEqual(
    offenders,
    [],
    "分组写入只属于店铺商品页；平台观察面与其它功能不得挂载它",
  )
})

test("分组写入不出现在平台观察面或其它屏的源码里", () => {
  const groups = ["platform", "workflow", "app", "components"]
  const offenders: string[] = []
  for (const group of groups) {
    let files: string[] = []
    try {
      files = sources(join(SRC, group))
    } catch {
      continue
    }
    for (const absolute of files) {
      const source = readFileSync(absolute, "utf8")
      if (/product-variants|productVariantsHttp|variant-merge|variant-move|variant-split/.test(source)) {
        offenders.push(relative(SRC, absolute))
      }
    }
  }
  assert.deepEqual(offenders, [])
})
