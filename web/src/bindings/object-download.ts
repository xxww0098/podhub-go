/**
 * Authorized object bytes. Cloud checks the caller, then returns a short-lived
 * presigned GET. The browser reads the object from storage directly.
 *
 * The URL is a bearer. It must not be written into a Card, a log, a toast, or
 * a thrown message.
 */
import { request } from "@/api/client"
import type { components } from "@/api/schema"
import { requestDeadline } from "@/api/client-options"
import { refuse } from "./refusal"

export type ObjectDownloadGrant = components["schemas"]["ObjectDownloadGrant"]

const GRANT_HEADERS = { Accept: "application/json" }

export async function downloadGrant(path: string, timeoutMs = 30_000): Promise<ObjectDownloadGrant> {
  const grant = await request<ObjectDownloadGrant>("GET", path, undefined, GRANT_HEADERS, timeoutMs)
  assertGrant(grant)
  return grant
}

export async function readPresignedObject(
  grant: ObjectDownloadGrant,
  timeoutMs?: number,
): Promise<Uint8Array<ArrayBuffer>> {
  assertGrant(grant)
  const timeout = requestDeadline(timeoutMs)
  let response: Response | undefined
  try {
    try {
      response = await fetch(grant.url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: timeout?.signal,
      })
    } catch {
      throw refuse(
        "cloud_unavailable",
        "对象直连下载未完成，请检查网络及对象存储跨域配置",
        "请稍后重试。",
      )
    }
    if (!response.ok) {
      throw refuse("cloud_unavailable", `对象存储拒绝下载（HTTP ${response.status}）`, "请稍后重试。")
    }
    let bytes: ArrayBuffer
    try {
      bytes = await response.arrayBuffer()
    } catch {
      throw refuse("cloud_bad_response", "对象内容无法读完", "请稍后重试。")
    }
    if (grant.bytes > 0 && bytes.byteLength !== grant.bytes) {
      throw refuse("workflow_template_digest_mismatch", "对象长度与授权不一致", "请稍后重试。")
    }
    return new Uint8Array(bytes)
  } finally {
    timeout?.clear()
    if (response && !response.bodyUsed) await response.body?.cancel().catch(() => {})
  }
}

/** Browser download manager. `Content-Disposition` on the object response names the file. */
export function startPresignedDownload(grant: ObjectDownloadGrant): void {
  assertGrant(grant)
  const anchor = document.createElement("a")
  anchor.href = grant.url
  anchor.rel = "noopener noreferrer"
  anchor.referrerPolicy = "no-referrer"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function assertGrant(grant: ObjectDownloadGrant): void {
  if (!grant || typeof grant.url !== "string" || !Number.isFinite(grant.expires_at_ms) || grant.expires_at_ms <= Date.now()) {
    throw refuse("cloud_unavailable", "下载授权无效或已过期", "请稍后重试。")
  }
  let url: URL
  try {
    url = new URL(grant.url)
  } catch {
    throw refuse("cloud_unavailable", "下载地址无效", "请稍后重试。")
  }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if ((!localHttp && url.protocol !== "https:") || url.username || url.password || url.hash) {
    throw refuse("cloud_unavailable", "下载地址不安全", "请稍后重试。")
  }
}
