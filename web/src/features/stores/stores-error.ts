import { commandErrorCode } from "@/lib/error-message"

/** HTTP 401 arrives as unauthenticated; other explicit auth codes keep their namespace. */
export function shouldOpenAccount(reason: unknown): boolean {
  const code = commandErrorCode(reason)
  return code === "unauthenticated" || code === "cloud_auth_required" || code === "cloud_auth_invalid"
}
