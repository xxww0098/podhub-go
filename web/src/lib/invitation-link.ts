import { useSyncExternalStore } from "react"
import { replaceAddress } from "@/lib/address"
import { notifyError } from "@/lib/notify"
import { isUuid } from "@/lib/utils"

export type InvitationCredential = { uuid: string; token: string }
const PARAM = "workspace_invitation"
const STORAGE = "podhub.pending-workspace-invitation"
let pending: InvitationCredential | null = null
const listeners = new Set<() => void>()

export function invitationToken(token: string): string {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("请使用创建者私下提供的邀请链接或凭据；旧邀请请联系创建者撤销重发。")
  }
  return token
}

/** Only fragments carry a link's proof; query parameters never authorize. */
export function parseInvitationCredential(input: string, expectedUuid?: string): InvitationCredential | null {
  const raw = input.trim()
  let value = raw
  if (raw.includes("#")) {
    const fragment = raw.slice(raw.indexOf("#") + 1)
    const params = new URLSearchParams(fragment)
    if (params.getAll(PARAM).length !== 1) return null
    value = params.get(PARAM) ?? ""
  } else if (raw.includes("/") || raw.includes("?")) return null
  const separator = value.indexOf(":")
  const uuid = separator < 0 ? expectedUuid : value.slice(0, separator)
  const token = separator < 0 ? value : value.slice(separator + 1)
  if (!uuid || !isUuid(uuid) || (expectedUuid && uuid.toLowerCase() !== expectedUuid.toLowerCase())) return null
  try { return { uuid: uuid.toLowerCase(), token: invitationToken(token) } } catch { return null }
}

export function privateInvitationLink(credential: InvitationCredential, origin: string): string {
  const validated = parseInvitationCredential(`${credential.uuid}:${credential.token}`)
  if (!validated) throw new Error("邀请凭据缺失，请撤销后重新创建邀请。")
  return `${new URL(origin).origin}/#${PARAM}=${validated.uuid}:${validated.token}`
}

function publish(value: InvitationCredential | null) {
  pending = value
  for (const listener of listeners) listener()
}

export function clearInvitationCredential(uuid?: string): void {
  if (uuid && pending?.uuid !== uuid.toLowerCase()) return
  if (typeof window !== "undefined") {
    try { window.sessionStorage.removeItem(STORAGE) } catch { /* Memory is still cleared. */ }
  }
  publish(null)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function useInvitationCredential(): InvitationCredential | null {
  return useSyncExternalStore(subscribe, pendingInvitationCredential, () => null)
}

export function pendingInvitationCredential(): InvitationCredential | null { return pending }

/** Scrub before diagnostics/auth reads, then keep proof only for this tab's login. */
export function installInvitationLink(): () => void {
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE) ?? "null")
    if (stored?.expiresAt > Date.now() && typeof stored.value === "string") {
      publish(parseInvitationCredential(stored.value))
    } else clearInvitationCredential()
  } catch { clearInvitationCredential() }
  const capture = () => {
    const params = new URLSearchParams(window.location.hash.slice(1))
    if (!params.has(PARAM)) return
    const credential = parseInvitationCredential(window.location.hash)
    params.delete(PARAM)
    const remainder = params.toString()
    replaceAddress({ hash: remainder ? `#${remainder}` : "" })
    clearInvitationCredential()
    if (!credential) {
      notifyError("邀请链接无效，请向创建者索取新的私密链接。")
      return
    }
    try {
      window.sessionStorage.setItem(STORAGE, JSON.stringify({
        value: `${credential.uuid}:${credential.token}`, expiresAt: Date.now() + 30 * 60_000,
      }))
    } catch { /* A blocked sessionStorage still permits confirmation before navigation. */ }
    publish(credential)
  }
  capture()
  window.addEventListener("hashchange", capture)
  window.addEventListener("popstate", capture)
  return () => {
    window.removeEventListener("hashchange", capture)
    window.removeEventListener("popstate", capture)
  }
}
