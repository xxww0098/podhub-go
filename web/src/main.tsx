import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { App } from "@/app/App"
import { EmailLinkHost } from "@/features/account/email-link"
import { AppCrashBoundary } from "@/components/app-crash-boundary"
import { Toaster } from "@/components/ui/toast"
import { initTheme } from "@/lib/theme"
import { queryClient } from "@/lib/query-client"
import { migrateLegacyStorage } from "@/lib/legacy-storage"
import { installAddressSync } from "@/lib/address"
import { installBrowserDiagnostics, reactErrorHandlers } from "@/lib/browser-diagnostics"
import { installInvitationLink } from "@/lib/invitation-link"
import "@/index.css"
import "@/features/site/public-site.css"
import "@/features/site/public-site-pages.css"
import "@/features/site/public-site-catalog.css"
import "@/features/site/public-site-responsive.css"
import "@/features/site/public-site-c.css"
import "@/features/site/public-site-c-responsive.css"
import "@/features/site/public-site-c-pages.css"

const removeInvitationLink = installInvitationLink()
const removeDiagnostics = installBrowserDiagnostics(window)
// The address is the router: back/forward and a bfcache restore must repaint
// from what the URL says, exactly like a first paint does.
const removeAddressSync = installAddressSync()
if (import.meta.hot) import.meta.hot.dispose(() => {
  removeDiagnostics()
  removeAddressSync()
  removeInvitationLink()
})

// Before any module reads a stored preference.
migrateLegacyStorage()
initTheme()
// Desktop-app chrome suppresses the native menu, but editable surfaces keep
// paste/spellcheck and the public site keeps link actions.
document.addEventListener("contextmenu", (event) => {
  const target = event.target
  if (
    target instanceof Element
    && target.closest("input, textarea, select, [contenteditable], .public-site")
  ) {
    return
  }
  event.preventDefault()
})

const root = document.getElementById("root")
if (!root) throw new Error("SPA root element is missing")
createRoot(root, reactErrorHandlers).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Toaster>
        <AppCrashBoundary>
          <App />
          <EmailLinkHost />
        </AppCrashBoundary>
      </Toaster>
    </QueryClientProvider>
  </StrictMode>,
)
