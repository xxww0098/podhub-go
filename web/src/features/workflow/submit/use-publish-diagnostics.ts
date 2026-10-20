import { createContext, useEffect, useRef } from "react"
import {
  createDiagnosticPublishAction, enterDiagnosticWorkflowRoute, getDiagnosticDetail, openDiagnosticPublishWindow,
} from "@/lib/error-telemetry"
import { notifyCommandError, notifyInfo } from "@/lib/notify"

export type PublishDiagnosticReporter = (diagnosticId: string) => Promise<boolean>
export const PublishDiagnosticReporterContext = createContext<PublishDiagnosticReporter | undefined>(undefined)

/** Route ownership only; business submit/repair/release is deliberately absent. */
export function createPublishDiagnosticRoute(current: () => boolean) {
  let release: (() => void) | undefined
  let reporting: AbortController | undefined
  let pending = false
  const leave = () => { release?.(); release = undefined; reporting?.abort() }
  return {
    enter() { if (!release && current()) release = enterDiagnosticWorkflowRoute() },
    leave,
    async report(diagnosticId: string): Promise<boolean> {
      if (pending) return false
      const detail = getDiagnosticDetail(diagnosticId)
      if (!release || !current() || detail.event?.diagnostic_id !== diagnosticId) {
        notifyCommandError(undefined, "诊断未上报；请在原账户的发布工作台重新打开当前诊断，再明确上报")
        return false
      }
      const action = createDiagnosticPublishAction(crypto.randomUUID())
      const controller = new AbortController()
      const window = action && openDiagnosticPublishWindow(action, controller.signal)
      if (!window) {
        notifyCommandError(undefined, "诊断上报窗口未开启；请确认已联网并仍在当前发布工作台，再明确上报")
        return false
      }
      reporting = controller
      pending = true
      try {
        notifyInfo("已开启本次诊断上报窗口；仅发送脱敏诊断，不发送商品或释放 Intent。")
        await window.flush()
        return true // Window admission, never a claim that Cloud acknowledged every record.
      } finally { pending = false }
    },
  }
}

/** ScreenPane may stay mounted while inactive: the synchronous guard moves with its real active state. */
export function usePublishDiagnostics(active: boolean, current: () => boolean) {
  const guard = useRef({ active, current })
  guard.current = { active, current }
  const owner = useRef<ReturnType<typeof createPublishDiagnosticRoute> | undefined>(undefined)
  owner.current ??= createPublishDiagnosticRoute(() => guard.current.active && guard.current.current())
  const route = owner.current
  useEffect(() => {
    if (active) route.enter()
    return route.leave
  }, [active, route])
  return route
}
