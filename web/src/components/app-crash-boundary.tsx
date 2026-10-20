import { Component, type ErrorInfo, type ReactNode } from "react"
import { reportError } from "@/lib/diag-log"

type AppCrashBoundaryState = {
  crashed: boolean
}

/**
 * Last-resort recovery surface. Without it an uncaught render error unmounts
 * the whole tree and leaves a blank page with no way back; the boundary keeps
 * a plain reload link on screen (docs/ui-recovery.md: component failures must
 * still show a normal recovery entry). The error itself is only reported —
 * never written into the page.
 */
export class AppCrashBoundary extends Component<
  { children: ReactNode },
  AppCrashBoundaryState
> {
  state: AppCrashBoundaryState = { crashed: false }

  static getDerivedStateFromError(): AppCrashBoundaryState {
    return { crashed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportError("[react]", error, {
      source: "boundary",
      componentStack: info.componentStack,
    })
  }

  render() {
    if (!this.state.crashed) return this.props.children
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">页面出现异常</p>
          <p className="text-compact text-muted-foreground">
            已记录诊断信息；重新加载通常可以恢复，未保存的输入无法找回。
          </p>
        </div>
        <a
          href={
            typeof window === "undefined"
              ? "/"
              : window.location.pathname + window.location.search
          }
          className="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/88"
        >
          重新加载
        </a>
      </div>
    )
  }
}
