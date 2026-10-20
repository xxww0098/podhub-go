import { Monitor, Moon, Sun } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useTheme, type ThemePreference } from "@/lib/theme"

export function PaneLoading({ label }: { label: string }) {
  return <div className="flex min-h-48 items-center justify-center gap-2 text-compact text-muted-foreground" role="status"><Spinner aria-hidden />正在加载{label}</div>
}

/** One labelled control line, shared by simple settings panes. */
export function SettingRow({ title, description, control }: {
  title: string
  description: string
  control: ReactNode
}) {
  return <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-border py-5">
    <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
      <p className="text-compact font-medium">{title}</p>
      <p className="text-meta leading-relaxed text-muted-foreground">{description}</p>
    </div>
    <div className="shrink-0">{control}</div>
  </div>
}

const THEME_OPTIONS = [
  { value: "system", label: "跟随系统", icon: Monitor },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
] as const satisfies readonly { value: ThemePreference; label: string; icon: typeof Monitor }[]

export function AppearanceRows() {
  const { preference, setPreference } = useTheme()
  return <section className="flex flex-col gap-4 border-t border-border pt-5" aria-label="主题">
    <div className="flex flex-col gap-1"><h3 className="text-compact font-medium">界面主题</h3><p className="text-meta text-muted-foreground">仅应用于当前设备，选择后立即生效。</p></div>
    <div className="flex flex-wrap gap-2" role="group" aria-label="主题模式">
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => <Button key={value} variant={preference === value ? "default" : "outline"} size="lg" aria-pressed={preference === value} onClick={() => setPreference(value)}><Icon aria-hidden />{label}</Button>)}
    </div>
  </section>
}
