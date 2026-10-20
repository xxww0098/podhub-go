import { createContext, useContext, useRef, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * Whether the enclosing screen pane is the active module. Hidden keep-alive
 * panes stay mounted (state, scroll, fetch results) but must not publish shell
 * chrome such as the breadcrumb trail.
 */
const ScreenActiveContext = createContext(true)

export function useScreenActive() {
  return useContext(ScreenActiveContext)
}

/**
 * One module surface inside the shell. Inactive panes stay in the React tree
 * (`display: none` + `inert`) so revisiting is a local reveal, not a remount.
 *
 * While inactive, the last active element tree is frozen by reference so App /
 * shell re-renders (nav, trail) do not re-execute hidden screens. React bails
 * out when the child element identity is unchanged. Notification polls and
 * 上架 progress ticks must not live in AuthenticatedApp — they would still
 * rebuild this child element for the *active* pane.
 */
export function ScreenPane({
  active,
  children,
  className,
}: {
  active: boolean
  children: ReactNode
  className?: string
}) {
  const cached = useRef(children)
  if (active) {
    cached.current = children
  }

  return (
    <ScreenActiveContext.Provider value={active}>
      <div
        className={cn(
          "flex min-h-0 w-full flex-1 flex-col gap-4 overflow-y-auto",
          !active && "hidden",
          className,
        )}
        hidden={!active}
        aria-hidden={!active}
        inert={!active}
      >
        {cached.current}
      </div>
    </ScreenActiveContext.Provider>
  )
}
