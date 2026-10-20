import type { AppRoute } from "@/lib/app-route"

/** The shell's execution seam: a platform surface never receives a runtime.
 * Injection lets tests exercise mount/cleanup without any delegated HTTP.
 */
export function mountWorkbenchRuntime(
  routeKind: AppRoute["kind"],
  workspaceId: number | undefined,
  mount: (workspaceId: number) => () => void,
): (() => void) | undefined {
  if (routeKind !== "workbench" || workspaceId === undefined) return
  return mount(workspaceId)
}
