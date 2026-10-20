/**
 * Cloud answers failures with a `CommandError`, which already carries copy
 * written for the operator. Keep that copy, but never replace an operation's
 * fallback with a browser exception, response body, URL or stack trace.
 *
 * When Cloud also sends `remediation`, append it so the toast carries the
 * recovery hint without a second DOM banner. An `Error` carrying the three
 * fields takes the same branch as a plain object: the fetch client rejects
 * with one so `reason instanceof Error` still holds for callers that test it.
 */
/**
 * Copy that is not operator text: it opens like JSON/HTML, carries a control
 * character, leaks a URL, or names a credential. Rejecting control characters
 * is the point of this screen, so the rule stays off for this one expression.
 */
const NON_OPERATOR_COPY =
  // eslint-disable-next-line no-control-regex -- control characters are rejected on purpose
  /^[\s]*[[{]|<\/?[A-Za-z!]|[\r\n\x00-\x1f]|https?:\/\/|file:\/\/|blob:|data:|(?:password|token|api[-_]?key|authorization)\s*[:=]|bearer\s|\bat\s+\S+\s*\(/i

export function errorMessage(reason: unknown, fallback: string): string {
  const copy = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 500 &&
    /[\u3400-\u9fff]/.test(value) &&
    !NON_OPERATOR_COPY.test(value)
      ? value.trim()
      : undefined
  if (typeof reason === "string") return copy(reason) ?? fallback
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const nativeHints: Record<string, string> = {
      QuotaExceededError: "浏览器存储空间不足，内容尚未保存；请释放空间后重试",
      NotAllowedError: "浏览器未授予所需权限；请允许访问后重试",
      NotFoundError: "本地文件已不可用；请重新选择或导入文件",
      SecurityError: "浏览器限制了本地存储访问；请检查站点权限后重试",
      AbortError: "操作已中止；如需继续，请重试",
    }
    const name = commandErrorCode(reason) === "local_storage_full"
      ? "QuotaExceededError" : "name" in reason && typeof reason.name === "string" ? reason.name : ""
    if (nativeHints[name]) return `${fallback}：${nativeHints[name]}`
    const message = copy(reason.message)
    if (message) {
      const remediation =
        "remediation" in reason ? copy(reason.remediation) : undefined
      return remediation ? `${message} ${remediation}` : message
    }
  }
  return fallback
}

/** The host's `CommandError.code`, or `undefined` for any other reject shape. */
export function commandErrorCode(reason: unknown): string | undefined {
  if (typeof reason === "object" && reason !== null && "code" in reason) {
    return typeof reason.code === "string" && reason.code.length > 0
      ? reason.code
      : undefined
  }
  return undefined
}

/**
 * The cooperative-stop error every workflow rail throws when Stop landed
 * before a paid boundary (`准备已停止` / `workflow_cancelled`). The api layer,
 * the prepare executor and the media admission all surface the same one so
 * callers test a single code.
 */
export function cancelledError(): Error {
  return Object.assign(new Error("准备已停止"), { code: "workflow_cancelled" })
}

/**
 * Cloud refuses the owned-Workspace cap under its own code rather than with a
 * bare `FORBIDDEN`, and the host carries the code through as
 * `cloud_<lowercased Cloud code>`. The code distinguishes the cap from other
 * refusals; HTTP 400 alone does not identify a domain error.
 */
export const WORKSPACE_LIMIT_REACHED_CODE = "cloud_workspace_limit_reached"

/**
 * A paid write (order, redeem, top-up) carried the Workspace the dialog
 * was opened on, but the session resolves to a different one. The refused
 * entry must repaint from a fresh overview — the switch already landed
 * server-side.
 */
export const WORKSPACE_MISMATCH_CODE = "cloud_workspace_mismatch"

/**
 * A cap refusal is the one refusal retrying cannot clear. The way out is
 * dissolving an owned Workspace (or a different registration), which is not
 * something an operator reads and acts on inside a six-second toast.
 */
export function isWorkspaceCapRefusal(reason: unknown): boolean {
  const code = commandErrorCode(reason)
  return code === WORKSPACE_LIMIT_REACHED_CODE
}

/**
 * 运维 refusals, spelled the way the fetch client delivers them: Cloud's
 * `OpsErrorCode` lower-cased behind a `cloud_` prefix (`@/api/client`), with
 * `auth_required` arriving as the client's own `unauthenticated`. The 发货 /
 * 退货 / 口碑 / 供货 / 商品 / 客服 / 概览 screens branch on these names, so
 * they are spelled once here rather than in seven screen models.
 */
export const OZON_AUTH_FAILED_CODE = "cloud_ozon_auth_failed"
/** `OZON_WRITE_KILL_SWITCH` is set: nothing was sent to Ozon. */
export const WRITES_DISABLED_CODE = "cloud_writes_disabled"
/**
 * The write may have reached Ozon and Ozon never confirmed it. Never a
 * failure, never a success: the operator must reconcile, never resend.
 */
export const SELLER_RESULT_UNKNOWN_CODE = "cloud_seller_result_unknown"
/** Somebody else's refresh of this Workspace's Console metrics is still running. */
export const CONSOLE_REFRESH_BUSY_CODE = "cloud_console_refresh_busy"

/**
 * "You may not read this Store." Ozon refused the Store's key, the Cookie
 * session is gone, or the role carries no `StoreRead` — all three are cleared
 * by fixing an authorization, never by retrying the same request.
 */
export function isOpsAuthRefusal(code: string | undefined): boolean {
  return (
    code === OZON_AUTH_FAILED_CODE ||
    code === "unauthenticated" ||
    code === "cloud_auth_invalid" ||
    code === "cloud_forbidden"
  )
}
