import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { rememberAccountOverview } from "@/features/account/account-overview-cache"
import { resetCardSessions } from "../card/card-session"
import { createPreparationTracks } from "../prepare/preparation-tracks"
import { usePublishQueue } from "../submit/use-publish-queue"
import { SIGNED_IN } from "./fixtures"

export function capturePublishQueue(options: Partial<Parameters<typeof usePublishQueue>[0]> = {}) {
  // Every fixture below defaults to `cardTemplateId: "card"`; without this, a
  // card session (and its cached `verifySupplierOnce`) opened by an earlier
  // test would silently answer this one instead of its own fetch mock.
  resetCardSessions()
  // A mounted app already holds the shell's standing; each test's finally
  // invalidates it again.
  rememberAccountOverview(SIGNED_IN)
  let hook!: ReturnType<typeof usePublishQueue>
  function Capture() {
    hook = usePublishQueue({
      cardTemplateId: "card", busy: false, storeConfigured: true,
      preparationTracks: { current: createPreparationTracks() },
      guidedPreparationLock: { current: false }, flushAutosave: async () => true,
      flushAutosavesFor: async () => true, ...options,
    })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  return hook
}
