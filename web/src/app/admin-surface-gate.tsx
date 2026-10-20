import { ShieldAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

/**
 * The whole answer to a non-staff session that opened `/admin`.
 *
 * The surface gate is the URL's own boundary, so this paints no shell at all —
 * no platform nav, no section list, no settings entry. The copy is static: a
 * refusal is a state, not a failed operation, so nothing here goes through
 * `notifyError` and no `role="alert"` enters the page.
 */
export function AdminSurfaceDenied({ onLeave }: { onLeave: () => void }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6">
      <Empty
        role="status"
        className="max-w-md flex-none"
        data-admin-surface="forbidden"
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldAlert />
          </EmptyMedia>
          <EmptyTitle>仅平台管理员可以访问管理面</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={onLeave}>
            返回工作台
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  )
}
