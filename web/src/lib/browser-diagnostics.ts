import { reportError } from "./diag-log"
import { resumeErrorTelemetry } from "./error-telemetry"

/** Capture resource failures too: their error events do not bubble. */
export function installBrowserDiagnostics(target: Window): () => void {
  const onError = (event: Event) => {
    if ("message" in event) {
      const error = event as ErrorEvent
      reportError("[browser]", error.error ?? error.message, {
        source: "uncaught",
        line: error.lineno,
        column: error.colno,
      })
    } else {
      const element = event.target as Element | null
      reportError("[browser]", "Resource failed to load", {
        source: "resource",
        tag: element?.tagName,
      })
    }
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    reportError("[browser]", event.reason, { source: "unhandledrejection" })
  }
  target.addEventListener("error", onError, true)
  target.addEventListener("unhandledrejection", onRejection)
  target.addEventListener("online", resumeErrorTelemetry)
  return () => {
    target.removeEventListener("error", onError, true)
    target.removeEventListener("unhandledrejection", onRejection)
    target.removeEventListener("online", resumeErrorTelemetry)
  }
}

function reactError(source: string) {
  return (error: unknown, info: { componentStack?: string | null }) => {
    reportError("[react]", error, { source, componentStack: info.componentStack })
  }
}

export const reactErrorHandlers = {
  onUncaughtError: reactError("uncaught"),
  onCaughtError: reactError("caught"),
  onRecoverableError: reactError("recoverable"),
}
