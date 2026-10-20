/**
 * The address, as one subscribable fact.
 *
 * There is no shadow copy of the location: the snapshot IS
 * `window.location.href`, and the only way to change it is `replaceAddress`,
 * which rewrites the URL and notifies. That is what lets the shell derive what
 * it paints from the address ([app-route](./app-route.ts)) without keeping a
 * second navigation state beside the URL that could drift from it.
 *
 * DOM-only and free of app imports; every function stays safe under
 * `renderToStaticMarkup`, where `window` does not exist.
 */
export type Address = { pathname: string; search: string; hash: string }

function emptyAddress(): Address {
  return { pathname: "/", search: "", hash: "" }
}

/** Parse any href — absolute or root-relative — into its three parts. */
export function addressOf(href: string): Address {
  const url = new URL(href, "http://localhost")
  return { pathname: url.pathname || "/", search: url.search, hash: url.hash }
}

export function hrefOf(address: Address): string {
  return address.pathname + address.search + address.hash
}

/** The current address; a document-less render gets the empty address. */
export function readAddress(): Address {
  return typeof window === "undefined" ? emptyAddress() : addressOf(window.location.href)
}

/**
 * The store snapshot: a primitive read straight from the URL, so React
 * compares values rather than objects.
 */
export function currentHref(): string {
  return typeof window === "undefined" ? "/" : window.location.href
}

const listeners = new Set<() => void>()

export function subscribeAddress(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyAddress(): void {
  // Snapshot: a listener that (un)subscribes mid-notification must not change
  // who else hears this one.
  const snapshot = [...listeners]
  for (const listener of snapshot) listener()
}

/**
 * The one writer of the address.
 *
 * `replaceState` keeps the shell's back-button story (a jump inside a surface
 * is not a history entry) and the notification is what makes the rewrite
 * visible to React. Parts left out keep their current value.
 */
export function replaceAddress(next: string | Partial<Address>): void {
  if (typeof window === "undefined") return
  const current = readAddress()
  const wanted =
    typeof next === "string"
      ? addressOf(next)
      : {
          pathname: next.pathname ?? current.pathname,
          search: next.search ?? current.search,
          hash: next.hash ?? current.hash,
        }
  // A write that changes nothing is not an event: re-clicking the current
  // destination must not wake every subscriber.
  if (hrefOf(wanted) === hrefOf(current)) return
  window.history.replaceState({}, "", hrefOf(wanted))
  notifyAddress()
}

/**
 * Back/forward and a bfcache restore repaint from the URL exactly like a first
 * paint does. Installed once by the entry point; returns its own teardown.
 */
export function installAddressSync(): () => void {
  if (typeof window === "undefined") return () => {}
  const notify = () => notifyAddress()
  window.addEventListener("popstate", notify)
  window.addEventListener("pageshow", notify)
  return () => {
    window.removeEventListener("popstate", notify)
    window.removeEventListener("pageshow", notify)
  }
}
