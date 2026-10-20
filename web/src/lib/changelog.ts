/**
 * Release notes for the workbench changelog dialog.
 *
 * Root `CHANGELOG.md` is the only copy. Vite parses「已发布版本」at build time
 * and injects the newest entries as `import.meta.env.PODHUB_CHANGELOG`.
 * A `### x.y.z` block with `#### 新增` / `优化` / `修复` is the release format.
 * Older rows that are still a single conventional-commit summary stay in the
 * table; section titles then come from that type (`feat` → 新增, `fix` → 修复,
 * …) and a parenthetical list split on `、` becomes the bullets. A version
 * written both ways keeps the grouped block. Anything the parser cannot read
 * becomes an empty list; the dialog still opens.
 */

export const CHANGELOG_VISIBLE_LIMIT = 3

/** `X.Y.Z` of the product version whose notes the operator has opened. */
export const CHANGELOG_SEEN_KEY = "podhub.changelog.seen"

const SECTION_BY_TYPE: Record<string, string> = {
  feat: "新增",
  fix: "修复",
  perf: "优化",
  refactor: "优化",
  chore: "发布",
  test: "测试",
  docs: "文档",
  build: "构建",
  ci: "工程",
  style: "样式",
  revert: "回退",
}

const CONVENTIONAL =
  /^([A-Za-z]+)(?:\(([^)]*)\))?(!)?:\s*([\s\S]*)$/

const VERSION = /^v?(\d+\.\d+\.\d+)$/

const REDUNDANT_LEAD = /^(发布|登记)\s+v?\d+\.\d+\.\d+$/

export type ChangelogSpan =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }

export type ChangelogItem = { spans: ChangelogSpan[] }

export type ChangelogSection = { title: string; items: ChangelogItem[] }

export type ChangelogRelease = {
  version: string
  date: string
  /** Shown under the version when the release has no git tag. */
  note: string
  sections: ChangelogSection[]
}

export function parseChangelog(
  markdown: string,
  limit = CHANGELOG_VISIBLE_LIMIT,
): ChangelogRelease[] {
  if (!Number.isFinite(limit) || limit <= 0) return []
  const taken = Math.floor(limit)
  const byVersion = new Map<string, ChangelogRelease>()
  for (const release of structuredReleases(markdown)) {
    byVersion.set(release.version, release)
  }
  for (const row of tableRows(markdown)) {
    const release = parseRow(row)
    if (!release || byVersion.has(release.version)) continue
    byVersion.set(release.version, release)
  }
  return [...byVersion.values()]
    .sort((left, right) => compareSemverDesc(left.version, right.version))
    .slice(0, taken)
}

/** Accepts the build-time JSON string, an already-parsed array, or junk. */
export function changelogReleasesFromJson(
  raw: unknown,
  limit = CHANGELOG_VISIBLE_LIMIT,
): ChangelogRelease[] {
  if (!Number.isFinite(limit) || limit <= 0) return []
  try {
    let parsed = raw
    if (typeof raw === "string") {
      if (raw.trim() === "") return []
      parsed = JSON.parse(raw) as unknown
    }
    if (!Array.isArray(parsed)) return []
    const releases: ChangelogRelease[] = []
    for (const entry of parsed) {
      const release = sanitizeRelease(entry)
      if (!release) continue
      releases.push(release)
      if (releases.length >= Math.floor(limit)) break
    }
    return releases
  } catch {
    return []
  }
}

export function bundledChangelogReleases(): ChangelogRelease[] {
  try {
    return changelogReleasesFromJson(import.meta.env.PODHUB_CHANGELOG)
  } catch {
    return []
  }
}

export function changelogHasUnread(current: string, seen: string): boolean {
  const version = current.trim()
  return version !== "" && version !== seen.trim()
}

export function readSeenChangelogVersion(
  storage: Pick<Storage, "getItem"> | null,
): string {
  if (!storage) return ""
  try {
    return storage.getItem(CHANGELOG_SEEN_KEY)?.trim() ?? ""
  } catch {
    return ""
  }
}

export function writeSeenChangelogVersion(
  version: string,
  storage: Pick<Storage, "setItem"> | null,
): void {
  const trimmed = version.trim()
  if (!storage || trimmed === "") return
  try {
    storage.setItem(CHANGELOG_SEEN_KEY, trimmed)
  } catch {
    // Private mode and quota failures leave the dot in place; the dialog still opens.
  }
}

export function browserStorage(): Storage | null {
  try {
    if (typeof globalThis.localStorage === "undefined") return null
    const storage = globalThis.localStorage
    if (typeof storage.getItem !== "function" || typeof storage.setItem !== "function") {
      return null
    }
    return storage
  } catch {
    return null
  }
}

function tableRows(markdown: string): string[] {
  if (typeof markdown !== "string" || markdown.trim() === "") return []
  const normalized = markdown.replace(/\r\n/g, "\n")
  const heading = normalized.indexOf("## 已发布版本")
  const slice = heading === -1 ? normalized : normalized.slice(heading)
  const lines = slice.split("\n")
  const header = lines.findIndex((line) => /^\|\s*版本 tag\s*\|/.test(line.trim()))
  if (header === -1) return []
  const rows: string[] = []
  for (const line of lines.slice(header + 1)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) break
    if (/^\|\s*-/.test(trimmed)) continue
    rows.push(trimmed)
  }
  return rows
}

function parseRow(line: string): ChangelogRelease | null {
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim())
  if (cells.length < 3) return null
  const version = versionOf(cells[0] ?? "")
  if (!version) return null
  const dateCell = cells[1] ?? ""
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateCell) ? dateCell : ""
  const summary = cells.slice(2).join(" | ").trim()
  return { version, date, note: "", sections: sectionsFromSummary(summary) }
}

const RELEASE_HEADING = /^###\s+v?(\d+\.\d+\.\d+)\s*$/
const GROUP_HEADING = /^####\s+(新增|优化|修复)\s*$/
const DATE_LINE = /^(?:[-*]\s*)?日期[：:]\s*(\d{4}-\d{2}-\d{2})\s*$/
const TAG_LINE = /^(?:[-*]\s*)?tag[：:]\s*(.+?)\s*$/i

function structuredReleases(markdown: string): ChangelogRelease[] {
  if (typeof markdown !== "string" || markdown.trim() === "") return []
  const normalized = markdown.replace(/\r\n/g, "\n")
  const heading = normalized.indexOf("## 已发布版本")
  const slice = heading === -1 ? "" : normalized.slice(heading)
  const end = slice.slice(1).search(/\n## [^#]/)
  const body = end === -1 ? slice : slice.slice(0, end + 1)
  const releases: ChangelogRelease[] = []
  const lines = body.split("\n")
  let index = 0
  while (index < lines.length) {
    const matched = lines[index]?.trim().match(RELEASE_HEADING)
    if (!matched?.[1]) {
      index += 1
      continue
    }
    const version = matched[1]
    index += 1
    let date = ""
    let note = ""
    const sections: ChangelogSection[] = []
    let current: ChangelogSection | null = null
    while (index < lines.length && !RELEASE_HEADING.test(lines[index]?.trim() ?? "")) {
      const line = lines[index]?.trim() ?? ""
      index += 1
      if (line.startsWith("## ")) break
      const dated = line.match(DATE_LINE)
      if (dated?.[1]) {
        date = dated[1]
        continue
      }
      const tagged = line.match(TAG_LINE)
      if (tagged?.[1]) {
        note = /无/.test(tagged[1]) ? "没有 git tag" : ""
        continue
      }
      const group = line.match(GROUP_HEADING)
      if (group?.[1]) {
        current = { title: group[1], items: [] }
        sections.push(current)
        continue
      }
      if (!current || !line.startsWith("- ")) continue
      const text = line.slice(2).trim()
      const spans = parseInline(text)
      if (spans.length > 0) current.items.push({ spans })
    }
    const kept = sections.filter((section) => section.items.length > 0)
    if (kept.length === 0) continue
    releases.push({ version, date, note, sections: kept })
  }
  return releases
}

function versionOf(cell: string): string | null {
  const matched = cell.replaceAll("`", "").trim().match(VERSION)
  return matched?.[1] ?? null
}

function sectionsFromSummary(summary: string): ChangelogSection[] {
  const trimmed = summary.trim()
  if (trimmed === "") return []
  const matched = trimmed.match(CONVENTIONAL)
  let title = "更新"
  let body = trimmed
  if (matched) {
    const message = matched[4]?.trim() ?? ""
    if (message !== "") {
      title = SECTION_BY_TYPE[matched[1]?.toLowerCase() ?? ""] ?? "更新"
      body = message
    }
  }
  const items = splitBullets(body)
    .map((text) => ({ spans: parseInline(text) }))
    .filter((item) => item.spans.length > 0)
  if (items.length === 0) return []
  return [{ title, items }]
}

function splitBullets(text: string): string[] {
  if (text.includes("`")) return [text]
  const matched = text.match(/^([^（）()]*)[（(]([^）)]+)[）)](.*)$/)
  if (!matched) return [text]
  const before = matched[1]?.trim() ?? ""
  const inside = matched[2] ?? ""
  const after = matched[3]?.trim() ?? ""
  if (!inside.includes("、")) return [text]
  const parts = inside.split("、").map((part) => part.trim()).filter((part) => part !== "")
  if (parts.length < 2) return [text]
  const bullets: string[] = []
  if (before !== "" && !REDUNDANT_LEAD.test(before)) bullets.push(before)
  bullets.push(...parts)
  if (after !== "") bullets.push(after)
  return bullets.length > 0 ? bullets : [text]
}

function parseInline(source: string): ChangelogSpan[] {
  const parts = source.split("`")
  if (parts.length % 2 === 0) return textSpan(source)
  const spans: ChangelogSpan[] = []
  parts.forEach((part, index) => {
    if (part.length === 0) return
    spans.push(index % 2 === 0 ? { kind: "text", text: part } : { kind: "code", text: part })
  })
  return spans.length > 0 ? spans : textSpan(source)
}

function textSpan(text: string): ChangelogSpan[] {
  return text.length > 0 ? [{ kind: "text", text }] : []
}

function compareSemverDesc(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part))
  const b = right.split(".").map((part) => Number(part))
  for (let index = 0; index < 3; index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function sanitizeRelease(value: unknown): ChangelogRelease | null {
  if (!value || typeof value !== "object") return null
  const row = value as { version?: unknown; date?: unknown; sections?: unknown }
  if (typeof row.version !== "string" || !/^\d+\.\d+\.\d+$/.test(row.version)) return null
  const date = typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : ""
  const noteSource = (value as { note?: unknown }).note
  const note = typeof noteSource === "string" ? noteSource.trim() : ""
  return { version: row.version, date, note, sections: sanitizeSections(row.sections) }
}

function sanitizeSections(value: unknown): ChangelogSection[] {
  if (!Array.isArray(value)) return []
  const sections: ChangelogSection[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const section = entry as { title?: unknown; items?: unknown }
    if (typeof section.title !== "string" || section.title.trim() === "") continue
    const items = sanitizeItems(section.items)
    if (items.length === 0) continue
    sections.push({ title: section.title, items })
  }
  return sections
}

function sanitizeItems(value: unknown): ChangelogItem[] {
  if (!Array.isArray(value)) return []
  const items: ChangelogItem[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const spans = sanitizeSpans((entry as { spans?: unknown }).spans)
    if (spans.length === 0) continue
    items.push({ spans })
  }
  return items
}

function sanitizeSpans(value: unknown): ChangelogSpan[] {
  if (!Array.isArray(value)) return []
  const spans: ChangelogSpan[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const span = entry as { kind?: unknown; text?: unknown }
    if ((span.kind !== "text" && span.kind !== "code") || typeof span.text !== "string") continue
    if (span.text.length === 0) continue
    spans.push({ kind: span.kind, text: span.text })
  }
  return spans
}
