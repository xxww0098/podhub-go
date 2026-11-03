import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

/** 面板外壳：标题 + 副标题 + 右侧动作区，白卡发丝线。 */
export function Panel({
  title,
  icon: Icon,
  subtitle,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string
  icon?: LucideIcon
  subtitle?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col rounded-lg border border-border bg-card p-4",
        className,
      )}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[0.9375rem] font-semibold tracking-[-0.01em] text-foreground">{Icon ? <Icon aria-hidden className="size-4 shrink-0" /> : null}{title}</h2>
          {subtitle ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col", bodyClassName)}>{children}</div>
    </section>
  )
}
