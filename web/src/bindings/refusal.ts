/**
 * A refusal the SPA decides on its own, in the shape `@/lib/error-message`
 * reads: `message`, `code`, `remediation`. `@/api/client` builds the same
 * shape from a Cloud response; this one is for the rules a composed thunk
 * checks before it spends a round trip (Cloud re-checks every one of them).
 */
export function refuse(code: string, message: string, remediation?: string): Error {
  return Object.assign(new Error(message), { code, remediation: remediation ?? null })
}
