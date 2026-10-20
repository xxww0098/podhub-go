/**
 * 固定标签的同步预览。权威规则在 `listing_core::ocr_contract`（保存与识图仍由
 * Cloud 用同一份拒绝）。这里留在渲染路径上，是因为标签编辑器按键即判，不能等
 * WASM 模块；词身规则与那份契约相同：`#` 前缀、整 tag 2–30 个码点；词身按 `_`
 * 分词，每段仅西里尔字母与数字且至少含一个西里尔字母；大小写不敏感去重。
 * 前端配置共 1–25 个（服务端仍允许 1–30 个）。
 */

/** 前端配置上限：为 OCR 的 5 个图片标签留出空间；至少 1 个。 */
export const FIXED_TAGS_MAX = 25

const TAG_WORD_CHARS = /^[а-яёА-ЯЁ0-9]+$/u
const TAG_WORD_CYRILLIC = /[а-яёА-ЯЁ]/u

function fixedTagBodyOk(body: string): boolean {
  return body
    .split("_")
    .every(
      (word) =>
        word.length > 0 &&
        TAG_WORD_CHARS.test(word) &&
        TAG_WORD_CYRILLIC.test(word),
    )
}

/** 单 tag 契约：`#` 前缀 + 全 tag 计 2–30 个码点（与 Rust `chars().count()` 一致）。 */
export function isValidFixedTag(tag: string): boolean {
  const chars = [...tag].length
  if (chars < 2 || chars > 30) return false
  if (!tag.startsWith("#")) return false
  return fixedTagBodyOk(tag.slice(1))
}

/** 1–25 个合法且不重复（大小写不敏感）的固定 tags。 */
export function fixedTagsReady(tags: readonly string[]): boolean {
  if (tags.length < 1 || tags.length > FIXED_TAGS_MAX) return false
  const seen = new Set<string>()
  for (const tag of tags) {
    if (!isValidFixedTag(tag)) return false
    const key = tag.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}
