/**
 * In-cell edit helpers for the batch workbench. The stored value may refresh
 * (autosave echo, status poll) while the operator is still typing; the draft
 * on the focused cell is the only value that may change during that window.
 */

export function displayedCellValue(
  editing: boolean,
  draft: string,
  stored: string,
): string {
  return editing ? draft : stored
}

/** Space-separated `#tag` string the operator sees and types. */
export function formatTagString(tags: readonly string[]): string {
  return tags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .join(" ")
}

export function parseTagString(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((tag) => tag.replace(/^#/, "").trim())
    .filter(Boolean)
}

type LifecycleWithSummary = {
  ai_summary?: { tags: string[]; model: string } | null
}

/**
 * Cloud status / save echoes and the preparation verbs' streamed Product
 * projections all replace the whole lifecycle. Tag edits live on `ai_summary`
 * (no Category Schema field), so landing one of those would otherwise wipe
 * them; the draft the projection carries is committed either way.
 */
export function keepLocalAiTags<T extends LifecycleWithSummary>(
  current: LifecycleWithSummary | undefined,
  incoming: T,
): T {
  const local = current?.ai_summary
  if (!local) return incoming
  if (!incoming.ai_summary) {
    return { ...incoming, ai_summary: local }
  }
  if (local.tags.join("\0") === incoming.ai_summary.tags.join("\0")) return incoming
  return {
    ...incoming,
    ai_summary: { ...incoming.ai_summary, tags: local.tags },
  }
}

export function cellEditKey(
  key: string,
  opts: { multiline: boolean; metaKey: boolean; ctrlKey: boolean },
): "commit" | "cancel" | null {
  if (key === "Escape") return "cancel"
  if (key !== "Enter") return null
  if (!opts.multiline || opts.metaKey || opts.ctrlKey) return "commit"
  return null
}

export type ProseSkipKind = "sealed" | "ai" | "publishing" | "occupied" | "missing"

export type ProseScopeRow = {
  draftId: string
  writable: boolean
  empty: boolean
  skip: Exclude<ProseSkipKind, "occupied"> | null
}

const SKIP_LABEL: Record<ProseSkipKind, string> = {
  sealed: "已上架",
  ai: "识别中",
  publishing: "发送中",
  occupied: "已有内容",
  missing: "无草稿",
}

export function planProseColumnFill(input: {
  selected: boolean
  openedDraftId: string
  emptyOnly: boolean
  rows: readonly ProseScopeRow[]
}): {
  selected: boolean
  scopeCount: number
  writableCount: number
  writeDraftIds: string[]
  skip: Partial<Record<ProseSkipKind, number>>
  sameAsOpened: boolean
} {
  const skip: Partial<Record<ProseSkipKind, number>> = {}
  const writeDraftIds: string[] = []
  let writableCount = 0
  for (const row of input.rows) {
    if (!row.writable) {
      if (row.skip) skip[row.skip] = (skip[row.skip] ?? 0) + 1
      continue
    }
    writableCount += 1
    if (input.emptyOnly && !row.empty) {
      skip.occupied = (skip.occupied ?? 0) + 1
      continue
    }
    writeDraftIds.push(row.draftId)
  }
  return {
    selected: input.selected,
    scopeCount: input.rows.length,
    writableCount,
    writeDraftIds,
    skip,
    sameAsOpened:
      writeDraftIds.length === 1 && writeDraftIds[0] === input.openedDraftId,
  }
}

export function proseScopeCopy(plan: {
  selected: boolean
  scopeCount: number
  writableCount: number
}): string {
  return plan.selected
    ? `写入已选 ${plan.scopeCount} 行`
    : `写入全部可改 ${plan.writableCount} 行`
}

export function proseSkipCopy(skip: Partial<Record<ProseSkipKind, number>>): string {
  const parts = (["sealed", "ai", "publishing", "occupied", "missing"] as const)
    .filter((kind) => (skip[kind] ?? 0) > 0)
    .map((kind) => `${skip[kind]} 行${SKIP_LABEL[kind]}`)
  return parts.length ? `${parts.join("、")}，未写入` : ""
}
