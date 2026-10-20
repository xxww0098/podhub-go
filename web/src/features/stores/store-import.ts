/**
 * Paste-format parser for batch credential import: one Store per line,
 * `店铺名,Client ID,API Key` — e.g. `test,4995868,763954c3-…-fa5dcbcd77e9`.
 * Roster tags ride at the end of the line as ` #标签` tokens:
 * `test,4995868,763954c3-… #华东 #VIP`.
 *
 * ASCII and full-width commas both separate fields. Because the Client ID and
 * API Key are taken from the right edge, a 店铺名 that itself contains a comma
 * still parses; the `#` hunt happens only inside that last field, so a name
 * may itself carry `#`. Lines that cannot produce all three fields come back
 * as issues with their 1-based line number; blank lines are skipped.
 */
export type StoreImportRow = {
  line: number
  name: string
  clientId: string
  apiKey: string
  /**
   * Tag names from the `#…` fragments after the API Key. `undefined` when the
   * line carries no `#` marker at all — the Store's tags stay untouched —
   * while an empty list (a bare trailing `#`) clears them.
   */
  tags?: string[]
  /** The trimmed raw line, for repopulating the textarea on retry. */
  source: string
}

export type StoreImportIssue = {
  line: number
  source: string
  reason: string
}

const FIELD_SEPARATOR = /[,，]/

/**
 * A tag token starts with `#` (full-width ＃ accepted). Separator glyphs —
 * the markers, the commas and any line break — can never be written into a
 * tag name on the line, so export filters names carrying them.
 */
const TAG_MARKER = /[#＃]/
const TAG_NAME_UNWRITABLE = /[#＃,，\r\n]/
const MAX_TAG_NAME_CHARS = 64

/** The subset of tag names the text format can carry back losslessly. */
export function writableTagNames(tags: readonly string[] | undefined): string[] {
  return (tags ?? []).filter((name) => !TAG_NAME_UNWRITABLE.test(name))
}

export function parseStoreImportText(text: string): {
  rows: StoreImportRow[]
  issues: StoreImportIssue[]
} {
  const rows: StoreImportRow[] = []
  const issues: StoreImportIssue[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const source = raw.trim()
    if (!source) return
    const line = index + 1
    const parts = raw.split(FIELD_SEPARATOR)
    if (parts.length < 3) {
      issues.push({ line, source, reason: "格式应为 店铺名,Client ID,API Key" })
      return
    }
    const tail = parts[parts.length - 1] ?? ""
    const markerAt = tail.search(TAG_MARKER)
    const apiKey = (markerAt < 0 ? tail : tail.slice(0, markerAt)).trim()
    const clientId = (parts[parts.length - 2] ?? "").trim()
    const name = parts.slice(0, -2).join(",").trim()
    const tagNames: string[] = []
    if (markerAt >= 0) {
      const seen = new Set<string>()
      for (const fragment of tail.slice(markerAt + 1).split(TAG_MARKER)) {
        const tag = fragment.trim()
        const key = tag.toLowerCase()
        if (!tag || seen.has(key)) continue
        seen.add(key)
        tagNames.push(tag)
      }
    }
    const reason = !name
      ? "缺少店铺名"
      : !clientId
        ? "缺少 Client ID"
        : clientId.length > 128
          ? "Client ID 过长"
          : !apiKey
            ? "缺少 API Key"
            : apiKey.length > 512
              ? "API Key 过长"
              : tagNames.some((tag) => [...tag].length > MAX_TAG_NAME_CHARS)
                ? "标签名过长"
                : undefined
    if (reason) {
      issues.push({ line, source, reason })
      return
    }
    rows.push({
      line,
      name,
      clientId,
      apiKey,
      ...(markerAt < 0 ? {} : { tags: tagNames }),
      source,
    })
  })
  return { rows, issues }
}

/**
 * The export half of the same line format. A 店铺名 containing commas still
 * round-trips: the parser reads Client ID and API Key from the right edge.
 * Tags follow the API Key as ` #标签` tokens; a Store with no tags carries no
 * marker, so re-importing leaves any existing tags on the target alone.
 */
export function formatStoreImportText(
  items: Array<{ name: string; client_id: string; api_key: string; tags?: string[] }>,
): string {
  return items
    .map((item) => {
      const tags = writableTagNames(item.tags)
      return `${item.name},${item.client_id},${item.api_key}${tags.length ? ` #${tags.join(" #")}` : ""}`
    })
    .join("\n")
}
