import { diagnosticProperty } from "./diagnostic-context"

const TOKEN = /^(?:[a-z]+:)?[A-Za-z0-9_.-]{1,64}$/
const PLACEHOLDER = new Set(["operation_failed", "-"])

/** A machine token nightly counts can group. Placeholders and sentences are dropped. */
export function concreteToken(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN.test(value) && !PLACEHOLDER.has(value) ? value : undefined
}

function blockerToken(value: unknown): string | undefined {
  const direct = concreteToken(value)
  if (direct) return direct
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return concreteToken(Object.keys(value)[0])
  }
  if (typeof value !== "string" || value.length > 256 || !value.startsWith("{")) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    return concreteToken(Object.keys(parsed)[0])
  } catch {
    return undefined
  }
}

/**
 * `code` prefers serverCode, then code, then the first blocker key.
 * `refusal` prefers an explicit reason, then a blocker that differs from code.
 * Neither side is `operation_failed` or `-`.
 */
export function refusalPair(reason: unknown): { code: string; refusal: string } | undefined {
  const server = concreteToken(diagnosticProperty(reason, "serverCode"))
  const code = concreteToken(diagnosticProperty(reason, "code"))
  const explicit = concreteToken(diagnosticProperty(reason, "refusalReason"))
    ?? concreteToken(diagnosticProperty(reason, "refusal"))
  const blockers = diagnosticProperty(reason, "blockers")
  let blocker: string | undefined
  if (Array.isArray(blockers)) {
    for (const item of blockers) {
      blocker = blockerToken(item)
      if (blocker) break
    }
  }
  const primary = server ?? code ?? blocker ?? explicit
  if (!primary) return undefined
  const refusal = explicit ?? (blocker && blocker !== primary ? blocker : primary)
  return { code: primary, refusal }
}
