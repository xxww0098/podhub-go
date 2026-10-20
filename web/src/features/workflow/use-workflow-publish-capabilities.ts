import { useEffect, useRef, useState } from "react"
import { useScreenActive } from "@/components/screen-pane"
import { createWorkflowPublishCapabilities, type WorkflowPublishContext } from "./workflow-publish-capabilities"
import type { WorkflowPublishNative } from "./workflow-publish-native"
import type { CardSession } from "./card/card-session"

type Capabilities = ReturnType<typeof createWorkflowPublishCapabilities>

/** An active ScreenPane effect owns the factory: replay replaces, never revives, it.
 * Hiding retires its authority even when no capability getter is called.
 * No capability is admitted before setup. Ordinary renders only update the
 * context/accessor refs; their callback identities must not retire live pins. */
export function useWorkflowPublishCapabilities(
  context: () => WorkflowPublishContext,
  native?: WorkflowPublishNative,
  residentSession?: (cardId: string) => CardSession | undefined,
  observe?: (phase: "setup" | "cleanup", owner: Capabilities) => void,
): Capabilities | undefined {
  const active = useScreenActive()
  const latest = useRef({ context, native, residentSession, observe })
  latest.current = { context, native, residentSession, observe }
  const [owner, setOwner] = useState<Capabilities>()
  useEffect(() => {
    if (!active) {
      setOwner(undefined)
      return
    }
    let mounted = true
    const current = createWorkflowPublishCapabilities(() => {
      const value = latest.current.context()
      return { ...value, active: mounted && value.active }
    }, latest.current.native,
      (cardId) => latest.current.residentSession?.(cardId))
    setOwner(current)
    // Optional local evidence cannot prevent setup or synchronous revocation.
    try { latest.current.observe?.("setup", current) } catch {}
    return () => {
      mounted = false
      current.dispose()
      try { latest.current.observe?.("cleanup", current) } catch {}
    }
  }, [active])
  return active ? owner : undefined
}
