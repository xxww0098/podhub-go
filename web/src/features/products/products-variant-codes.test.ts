/**
 * 稳定码与中文文案的对账：后端今天能发出的每个码都必须有文案，文案表里也不许
 * 留后端已经不再发出的死码。
 *
 * 03b 当初按协议描述猜过一组码名（mirror_stale / deadline_reached …），与 03a
 * 真正发出的码不一致；页面因此会静默落到通用回退。这个测试把两边钉在一起：
 * 它直接读 Rust 源码里的常量与字面量，而不是再抄一份清单——抄一份就还是会漂。
 *
 * 码的归属：
 *   - 预览拒绝（problems[].code）：preview.rs 的 PROBLEM_* + listing_core 的
 *     OzonVariantsCode（validate_group 原样上报）；
 *   - 逐项结果（items[].detailCode）：operations.rs 的同步拒绝 + observe*.rs 的
 *     DETAIL_*。
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  VARIANT_DETAIL_COPY,
  VARIANT_DETAIL_FALLBACK,
  VARIANT_PROBLEM_COPY,
  VARIANT_PROBLEM_FALLBACK,
  variantItemDetailCopy,
  variantProblemCopy,
} from "./products-variant-model"

function read(path: string): string {
  return readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8")
}

/** `const DETAIL_X: &str = "code";` / `const PROBLEM_X: &str = "code";` */
function constants(source: string, prefix: "PROBLEM" | "DETAIL"): string[] {
  const pattern = new RegExp(`const ${prefix}_[A-Z_]+: &str = "([a-z_]+)"`, "g")
  return [...source.matchAll(pattern)].map((match) => match[1]!)
}

/**
 * `OzonVariantsCode` 的变体值。只取该枚举自己的代码块——同一文件里的 WB 码表
 * 也有 `variant_` 字样的取值名，整文件扫描会把它们一起捞进来。
 */
function listingCoreCodes(source: string): string[] {
  const start = source.indexOf("=> OzonVariantsCode {")
  assert.ok(start > 0, "issue_keys.rs 里找不到 OzonVariantsCode：枚举改名后要同步这里")
  const end = source.indexOf("\n    }", start)
  assert.ok(end > start, "issue_keys.rs 里 OzonVariantsCode 的代码块没有闭合")
  return [...source.slice(start, end).matchAll(/= "(variant_[a-z_]+)",/g)].map((match) => match[1]!)
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

// 本仓库只有 listing-core 的 Rust 源码；分组预览与逐项结果码由 Go 服务端发出，
// 对应的 Rust 常量表不在这里。这两项对账需要那份源码才能跑，现在跳过。
const RUST_SERVER_SOURCES = false

test("预览拒绝码：后端能发的每个码都有中文，文案表里没有死码", { skip: RUST_SERVER_SOURCES ? false : "needs Rust server sources" }, () => {
  const backend = sorted([
    ...constants(read("src/store/grouping/preview.rs"), "PROBLEM"),
    ...listingCoreCodes(read("rust/crates/listing-core/src/issue_keys.rs")),
  ])
  // 提取本身要有效：正则失配时不能让「两边都空」伪装成通过。
  assert.ok(backend.length >= 15, `预览码只提取到 ${backend.length} 个，检查源码扫描`)
  assert.ok(backend.includes("verify_first"), "没扫到 preview.rs 的 PROBLEM_VERIFY_FIRST")
  assert.ok(backend.includes("variant_combination_duplicate"), "没扫到 OzonVariantsCode")
  assert.deepEqual(
    sorted(Object.keys(VARIANT_PROBLEM_COPY)),
    backend,
    "预览拒绝码与中文文案表不一致：新增码要补文案，删掉的码要同步删除",
  )
  for (const code of backend) {
    const copy = variantProblemCopy({ code })
    assert.notEqual(copy, code)
    assert.equal(copy, VARIANT_PROBLEM_COPY[code])
    assert.match(copy!, /[\u4e00-\u9fff]/, `${code} 的文案不是中文`)
  }
  // 未收录的码走通用回退，绝不渲染原始码。
  assert.equal(variantProblemCopy({ code: "future_code" }), VARIANT_PROBLEM_FALLBACK)
  assert.doesNotMatch(VARIANT_PROBLEM_FALLBACK, /future_code/)
})

test("逐项结果码：后端能发的每个码都有中文，文案表里没有死码", { skip: RUST_SERVER_SOURCES ? false : "needs Rust server sources" }, () => {
  const backend = sorted([
    ...constants(read("src/store/grouping/observe.rs"), "DETAIL"),
    ...constants(read("src/store/grouping/observe_decide.rs"), "DETAIL"),
    ...[...read("src/ops/product_variants/operations.rs").matchAll(/detail_code: Some\("([a-z_]+)"/g)].map(
      (match) => match[1]!,
    ),
  ])
  assert.ok(backend.length >= 6, `结果码只提取到 ${backend.length} 个，检查源码扫描`)
  assert.ok(backend.includes("seller_account_changed"), "没扫到 observe.rs 的 DETAIL_ACCOUNT_CHANGED")
  assert.ok(backend.includes("ozon_rejected"), "没扫到 operations.rs 的同步拒绝码")
  assert.deepEqual(
    sorted(Object.keys(VARIANT_DETAIL_COPY)),
    backend,
    "逐项结果码与中文文案表不一致：新增码要补文案，删掉的码要同步删除",
  )
  for (const code of backend) {
    const copy = variantItemDetailCopy(code)
    assert.notEqual(copy, code)
    assert.equal(copy, VARIANT_DETAIL_COPY[code])
    assert.match(copy!, /[\u4e00-\u9fff]/, `${code} 的文案不是中文`)
  }
  assert.equal(variantItemDetailCopy("future_code"), VARIANT_DETAIL_FALLBACK)
  assert.doesNotMatch(VARIANT_DETAIL_FALLBACK, /future_code/)
})

test("两个回退文案都不含任何码名，也没有互相抄错", () => {
  assert.notEqual(VARIANT_PROBLEM_FALLBACK, VARIANT_DETAIL_FALLBACK)
  for (const copy of [...Object.values(VARIANT_PROBLEM_COPY), ...Object.values(VARIANT_DETAIL_COPY)]) {
    assert.doesNotMatch(copy, /[a-z]+_[a-z]+/, `文案里混进了稳定码：${copy}`)
  }
})
