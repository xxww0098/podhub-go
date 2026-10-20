import { Monitor, Moon, Sun } from "lucide-react"

import { cn } from "@/lib/utils"
import { useTheme, type ThemePreference } from "@/lib/theme"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "跟随系统", icon: Monitor },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
]

/**
 * Collapsed form. The icon rail is the intended mode at 1024 — the width this
 * app is most often docked at, beside Photoshop — so the theme control cannot
 * simply be hidden there. It folds into one button that cycles the same three
 * states and names the next one.
 */
export function ThemeToggleCompact({ className }: { className?: string } = {}) {
  const { preference, setPreference } = useTheme()
  const index = OPTIONS.findIndex((option) => option.value === preference)
  const current = OPTIONS[index === -1 ? 0 : index]
  const next = OPTIONS[(index + 1) % OPTIONS.length]
  const Icon = current.icon

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`外观：${current.label}，切换到${next.label}`}
            onClick={() => setPreference(next.value)}
            /* size-9 is the rail's column. The footer toolbar overrides this
               when expanded so the cycle sits on the same track as collapse
               and settings. */
            className={cn(
              "flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              className,
            )}
          />
        }
      >
        <Icon className="size-4" aria-hidden />
      </TooltipTrigger>
      <TooltipContent>{`外观：${current.label}`}</TooltipContent>
    </Tooltip>
  )
}
