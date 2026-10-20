/**
 * Display-name rules for the account profile.
 *
 * The server (`PUT /api/auth/name`) is the authority for every rule; this
 * module only mirrors the bounds so the dialog can refuse early and the
 * trigger can show the cooldown without a round trip. The prohibited-word
 * list is server-side only — the client never re-states it.
 */

/** Mirrors `identity::profile::NAME_MAX_CHARS` (Unicode scalar values). */
export const ACCOUNT_NAME_MAX_CHARS = 24

/** Mirrors `identity::profile::RENAME_COOLDOWN_MS`: one rename per 24 hours. */
export const RENAME_COOLDOWN_MS = 24 * 60 * 60 * 1_000

/**
 * Milliseconds when the next rename unlocks, or `undefined` when the account
 * has never renamed. `undefined` also results from a missing stamp.
 */
export function renameLockedUntil(nameChangedAtMs: number | undefined): number | undefined {
  return nameChangedAtMs == null ? undefined : nameChangedAtMs + RENAME_COOLDOWN_MS
}

/**
 * `name` with its problem spelled for a toast, or `undefined` when the dialog
 * may submit. Server-side checks (prohibited words, the cooldown itself)
 * surface through the command error.
 */
export function accountNameProblem(raw: string, currentName: string): string | undefined {
  const name = raw.trim()
  if (name.length === 0) return "请输入名字"
  if (Array.from(name).length > ACCOUNT_NAME_MAX_CHARS)
    return `名字最长 ${ACCOUNT_NAME_MAX_CHARS} 个字符`
  if (name === currentName.trim()) return "新名字与当前相同"
  return undefined
}

/** "约 3 小时后可改名" — the locked state the trigger shows instead of a link. */
export function renameCooldownLabel(lockedUntilMs: number, nowMs: number): string {
  const remaining = Math.max(0, lockedUntilMs - nowMs)
  if (remaining >= 3_600_000) {
    const hours = Math.ceil(remaining / 3_600_000)
    return `约 ${hours} 小时后可改名`
  }
  const minutes = Math.max(1, Math.ceil(remaining / 60_000))
  return `约 ${minutes} 分钟后可改名`
}
