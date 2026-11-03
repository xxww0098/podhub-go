/**
 * Paste-format parser for batch credential import: one Store per line,
 * `店铺名,Client ID,API Key` — e.g. `test,4995868,763954c3-…-fa5dcbcd77e9`.
 * The Store's single group rides at the end of the line as one ` #分组` token:
 * `test,4995868,763954c3-… #华东`.
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
   * The group name after the `#` marker. `undefined` when the line carries no
   * `#` at all — the Store's group stays untouched — while an empty string (a
   * bare trailing `#`) clears it.
   */
  group?: string
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
 * A group token starts with `#` (full-width ＃ accepted). Separator glyphs —
 * the markers, the commas and any line break — can never be written into a
 * group name on the line, so export skips a name carrying them.
 */
const GROUP_MARKER = /[#＃]/
const GROUP_NAME_UNWRITABLE = /[#＃,，\r\n]/
const MAX_GROUP_NAME_CHARS = 64

/** The group name when the text format can carry it back losslessly. */
export function writableGroupName(name: string | null | undefined): string | undefined {
  const trimmed = name?.trim()
  return trimmed && !GROUP_NAME_UNWRITABLE.test(trimmed) ? trimmed : undefined
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
    const markerAt = tail.search(GROUP_MARKER)
    const apiKey = (markerAt < 0 ? tail : tail.slice(0, markerAt)).trim()
    const clientId = (parts[parts.length - 2] ?? "").trim()
    const name = parts.slice(0, -2).join(",").trim()
    const groupTokens = markerAt < 0 ? [] : tail.slice(markerAt + 1).split(GROUP_MARKER)
    const group = groupTokens[0]?.trim() ?? ""
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
              : groupTokens.length > 1
                ? "分组只能填一个"
                : [...group].length > MAX_GROUP_NAME_CHARS
                  ? "分组名过长"
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
      ...(markerAt < 0 ? {} : { group }),
      source,
    })
  })
  return { rows, issues }
}

/**
 * The export half of the same line format. A 店铺名 containing commas still
 * round-trips: the parser reads Client ID and API Key from the right edge.
 * The group follows the API Key as one ` #分组` token; a Store without a group
 * carries no marker, so re-importing leaves any existing group on the target
 * alone.
 */
export function formatStoreImportText(
  items: Array<{ name: string; client_id: string; api_key: string; group?: string | null }>,
): string {
  return items
    .map((item) => {
      const group = writableGroupName(item.group)
      return `${item.name},${item.client_id},${item.api_key}${group ? ` #${group}` : ""}`
    })
    .join("\n")
}
