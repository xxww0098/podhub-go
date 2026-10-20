/** Editing value validation/conversion, option identity and keyboard navigation. */
import assert from "node:assert/strict"
import test from "node:test"
import {
  WEIGHT_UNITS,
  categoryShortLabel,
  defaultWeightUnit,
  nextCellIndex,
  nextOptionValue,
  nonNegativeCentsFromYuan,
  priceCentsFromYuan,
  toggleInList,
  weightDisplayValue,
  weightGramsFromInput,
} from "./supplier-prop-editors"
import { missingFromRefusal } from "./supplier-readiness"
import { TREE } from "./supplier-editing-fixtures"

test("priceCentsFromYuan：空 = 清空，非法/非正 = 拒写（Esc 等价的取消路径）", () => {
  assert.equal(priceCentsFromYuan("8.00"), 800)
  assert.equal(priceCentsFromYuan("¥8"), 800)
  assert.equal(priceCentsFromYuan(""), null)
  assert.equal(priceCentsFromYuan("  "), null)
  assert.equal(priceCentsFromYuan("abc"), undefined)
  assert.equal(priceCentsFromYuan("0"), undefined)
  assert.equal(priceCentsFromYuan("-1"), undefined)
})


test("nonNegativeCentsFromYuan：空 = 未填，0 合法（运费零值），负数/非法拒写", () => {
  assert.equal(nonNegativeCentsFromYuan("2.00"), 200)
  assert.equal(nonNegativeCentsFromYuan("¥2"), 200)
  assert.equal(nonNegativeCentsFromYuan("0"), 0)
  assert.equal(nonNegativeCentsFromYuan("0.00"), 0)
  assert.equal(nonNegativeCentsFromYuan(""), null)
  assert.equal(nonNegativeCentsFromYuan("  "), null)
  assert.equal(nonNegativeCentsFromYuan("abc"), undefined)
  assert.equal(nonNegativeCentsFromYuan("-1"), undefined)
})


test("重量单位：数值双向换算、默认单位、非法拒写", () => {
  assert.deepEqual(
    WEIGHT_UNITS.map((unit) => unit.label),
    ["g", "kg"],
    "单位只列英文符号",
  )
  assert.equal(defaultWeightUnit(null), "g")
  assert.equal(defaultWeightUnit(350), "g")
  assert.equal(defaultWeightUnit(999), "g")
  assert.equal(defaultWeightUnit(1500), "kg", "≥ 1 kg 读作 1.5 kg，不写 1500 g")
  assert.equal(defaultWeightUnit(2000), "kg")

  assert.equal(weightDisplayValue(null, "kg"), "")
  assert.equal(weightDisplayValue(350, "g"), "350")
  assert.equal(weightDisplayValue(1500, "kg"), "1.5")
  assert.equal(weightDisplayValue(2000, "kg"), "2")

  assert.equal(weightGramsFromInput("350", "g"), 350)
  assert.equal(weightGramsFromInput("1.5", "kg"), 1500)
  assert.equal(weightGramsFromInput(" ", "kg"), null)
  assert.equal(weightGramsFromInput("0", "kg"), undefined)
  assert.equal(weightGramsFromInput("-1", "g"), undefined)
  assert.equal(weightGramsFromInput("abc", "g"), undefined)
})


test("nextOptionValue：slug 化 + 撞名追加序号；纯中文回落 option-N", () => {
  const options = [{ value: "cotton", label: "棉" }]
  assert.equal(nextOptionValue("Polyester", options), "polyester")
  assert.equal(nextOptionValue("cotton", options), "cotton-2")
  assert.equal(nextOptionValue("棉", options), "option-2")
})


test("toggleInList：多选逐项翻转", () => {
  assert.deepEqual(toggleInList(["a"], "b"), ["a", "b"])
  assert.deepEqual(toggleInList(["a", "b"], "a"), ["b"])
})


test("nextCellIndex：Tab 横移越界不动", () => {
  assert.equal(nextCellIndex(5, 0, 1), 1)
  assert.equal(nextCellIndex(5, 0, -1), -1)
  assert.equal(nextCellIndex(5, 4, 1), -1)
  assert.equal(nextCellIndex(5, 4, -1), 3)
})


test("missingFromRefusal：服务端 400 的 missing 键翻成中文缺项", () => {
  assert.deepEqual(
    missingFromRefusal({ missing: ["category", "prompt", "unknown_key"] }),
    ["类目", "提示词", "unknown_key"],
  )
  assert.deepEqual(missingFromRefusal(new Error("x")), [])
  assert.deepEqual(missingFromRefusal({ missing: "nope" }), [])
})


test("categoryShortLabel：解析树给「L2 · 类型」，断链退坐标对", () => {
  assert.equal(categoryShortLabel(11, 101, TREE), "节日 · 帽子")
  assert.equal(categoryShortLabel(99, 999, TREE), "类目 99 / 类型 999")
  assert.equal(categoryShortLabel(null, null, TREE), "")
})
