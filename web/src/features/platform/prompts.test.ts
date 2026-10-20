import assert from "node:assert/strict"
import test from "node:test"

import type { SupplierPrompt, SupplierPromptSync } from "@/bindings/http-supplier-dbs"
import type { CategoryTreeNodeView, WorkflowPromptDirEntry } from "@/bindings/commands"
import {
  categoryCoordinatesByPath,
  categoryPathKey,
  formatFixedTags,
  parseFixedTags,
  promptPatch,
  uniquePromptForImport,
} from "./prompts"
import { syncCountsText, syncMissReasonLabel, syncResultGroups, syncUnlistedCount } from "./prompts-sync"

test("prompt directory category paths ignore Seller category whitespace", () => {
  assert.equal(
    categoryPathKey("住宅和花园", "炊具", "马克杯，杯子，玻璃盖"),
    categoryPathKey("住宅和花园", "炊具", "马克杯， 杯子， 玻璃盖 "),
  )
})

test("prompt directory skips category paths made ambiguous by whitespace normalization", () => {
  const tree: CategoryTreeNodeView[] = [{
    description_category_id: 1,
    category_name: "住宅",
    type_id: 0,
    type_name: "",
    disabled: false,
    children: [{
      description_category_id: 10,
      category_name: "炊具",
      type_id: 0,
      type_name: "",
      disabled: false,
      children: [
        { description_category_id: 10, category_name: "", type_id: 20, type_name: "马克 杯", disabled: false, children: [] },
        { description_category_id: 10, category_name: "", type_id: 21, type_name: "马克杯", disabled: false, children: [] },
      ],
    }],
  }]

  assert.equal(categoryCoordinatesByPath(tree).get(categoryPathKey("住宅", "炊具", "马克杯")), undefined)
})

test("fixed tags round-trip as one tag per line", () => {
  const tags = Array.from({ length: 16 }, (_, index) => `#tag_${index + 1}`)
  assert.deepEqual(parseFixedTags(formatFixedTags(tags)), tags)
})

test("directory import only targets one existing prompt in the same category", () => {
  const prompt: SupplierPrompt = {
    productId: "scp_1",
    sourceId: "src_1",
    productTitle: "马克杯",
    descriptionCategoryId: 10,
    typeId: 20,
    promptName: "马克杯提示词",
    promptFileName: "mug.md",
    promptContent: "旧正文",
    fixedTags: ["cup"],
    revision: 1,
  }
  const entry: WorkflowPromptDirEntry = {
    l1_name: "住宅",
    l2_name: "炊具",
    type_name: "马克杯",
    name: "马克杯提示词",
    file_name: "mug.md",
    content: "新正文",
  }
  const coordinates = { descriptionCategoryId: 10, typeId: 20 }

  assert.equal(uniquePromptForImport([prompt], entry, coordinates)?.productId, "scp_1")
  assert.equal(uniquePromptForImport([{ ...prompt, typeId: 21 }], entry, coordinates), undefined)
  assert.equal(uniquePromptForImport([prompt, { ...prompt, productId: "scp_2" }], entry, coordinates), undefined)
})

test("directory import sends only the brief body and keeps the product's own fixed tags", () => {
  const prompt: SupplierPrompt = {
    productId: "scp_1",
    sourceId: "src_1",
    productTitle: "马克杯",
    descriptionCategoryId: 10,
    typeId: 20,
    promptName: "马克杯提示词",
    promptFileName: "mug.md",
    promptContent: "旧正文",
    fixedTags: ["#кружка", "#подарок"],
    revision: 7,
  }
  // 条目没有任何标签来源（仓库的 .fixed-tags.txt 不再参与导入）。
  const entry: WorkflowPromptDirEntry = {
    l1_name: "住宅",
    l2_name: "炊具",
    type_name: "马克杯",
    name: "",
    file_name: "mug.md",
    content: "新正文",
  }

  assert.deepEqual(promptPatch(prompt, entry), {
    promptName: "马克杯提示词",
    promptFileName: "mug.md",
    promptContent: "新正文",
    fixedTags: ["#кружка", "#подарок"],
    expectedRevision: 7,
  })
})

const SYNC_REPORT: SupplierPromptSync = {
  counts: { updated: 1, upToDate: 1, unmatched: 2, failed: 1 },
  updated: [{ productId: "scp_a", productTitle: "短袖", promptFileName: "tee.md", revision: 2 }],
  upToDate: [{ productId: "scp_b", productTitle: "马克杯", promptFileName: "mug.md", revision: 1 }],
  unmatched: [
    { productId: "scp_c", productTitle: "没有文件", promptFileName: "missing.md", reason: "no_match" },
    { productId: "scp_d", productTitle: "同名两条", promptFileName: "dup.md", reason: "ambiguous" },
  ],
  failed: [{ productId: "scp_e", productTitle: "坏标签", promptFileName: "tee.md", reason: "固定标签不可读" }],
  detailsTruncated: false,
}

test("sync result groups keep the exact counts and label every miss", () => {
  const groups = syncResultGroups(SYNC_REPORT)
  assert.deepEqual(
    groups.map((group) => [group.key, group.title, group.count]),
    [
      ["updated", "已更新", 1],
      ["upToDate", "已是最新", 1],
      ["unmatched", "无匹配", 2],
      ["failed", "失败", 1],
    ],
  )
  assert.deepEqual(
    groups[2]?.entries.map((entry) => entry.note),
    ["类目里没有这个文件名", "类目里同名文件有多条"],
  )
  assert.equal(groups[3]?.entries[0]?.note, "固定标签不可读")
  assert.equal(syncMissReasonLabel("no_match"), "类目里没有这个文件名")
  assert.equal(syncMissReasonLabel("ambiguous"), "类目里同名文件有多条")
  assert.equal(syncCountsText(SYNC_REPORT.counts), "更新 1；已是最新 1；无匹配 2；失败 1")
})

test("sync report uses authoritative totals when server details are capped", () => {
  const report: SupplierPromptSync = {
    ...SYNC_REPORT,
    counts: { ...SYNC_REPORT.counts, upToDate: 500 },
    upToDate: Array.from({ length: 200 }, (_, index) => ({
      productId: "scp_" + index,
      productTitle: "产品 " + index,
      promptFileName: "prompt-" + index + ".md",
      revision: 1,
    })),
    detailsTruncated: true,
  }
  const group = syncResultGroups(report).find(({ key }) => key === "upToDate")

  assert.ok(group)
  assert.equal(report.detailsTruncated, true)
  assert.equal(group.count, 500)
  assert.equal(group.entries.length, 200)
  assert.equal(syncUnlistedCount(group.count, group.entries), 480)
})
