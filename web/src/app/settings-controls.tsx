import type { CSSProperties, ReactNode } from "react"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useTheme, type ThemePreference } from "@/lib/theme"

export function PaneLoading({ label }: { label: string }) {
  return <div className="flex min-h-24 items-center justify-center gap-2 text-compact text-muted-foreground" role="status"><Spinner aria-hidden />正在加载{label}</div>
}

/** Rows that belong together share one bordered surface, divided by hairlines. */
export function SettingGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("divide-y divide-border overflow-hidden rounded-xl border border-border bg-card", className)}>{children}</section>
}

/** The previews stay fixed when the current application theme changes. */
const THEME_PREVIEW = {
  light: { ground: "#f5f7fa", header: "#eaf0f7", sheet: "#ffffff", line: "#edf2f8", ink: "#dce4f1", muted: "#b2c1d9", accent: "#1460ff", accentSoft: "#e5efff" },
  dark: { ground: "#22314b", header: "#0b1e38", sheet: "#172235", line: "#283851", ink: "#374867", muted: "#546b8c", accent: "#1460ff", accentSoft: "#24395b" },
} as const

const THEME_OPTIONS = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
] as const satisfies readonly { value: ThemePreference; label: string }[]

function ThemeSketch({ palette }: { palette: (typeof THEME_PREVIEW)[keyof typeof THEME_PREVIEW] }) {
  const colors = {
    "--preview-ground": palette.ground,
    "--preview-header": palette.header,
    "--preview-sheet": palette.sheet,
    "--preview-line": palette.line,
    "--preview-ink": palette.ink,
    "--preview-muted": palette.muted,
    "--preview-accent": palette.accent,
    "--preview-accent-soft": palette.accentSoft,
  } as CSSProperties
  return <span aria-hidden className="flex size-full flex-col bg-[var(--preview-ground)]" style={colors}>
    <span className="flex h-[15%] shrink-0 items-center gap-1 bg-[var(--preview-header)] px-2">
      <span className="size-2 rounded-full bg-[#ff4851]" />
      <span className="size-2 rounded-full bg-[#ffc52b]" />
      <span className="size-2 rounded-full bg-[#18c568]" />
    </span>
    <span className="flex min-h-0 flex-1">
      <span className="flex w-[27%] flex-col gap-[5px] px-1.5 py-2">
        {[0, 1, 2, 3, 4, 5, 6].map((row) => <span key={row} className={cn("flex h-2.5 items-center gap-1 rounded-sm px-0.5", row === 2 && "bg-[var(--preview-accent-soft)]")}>
          <span className={cn("size-1.5 shrink-0 rounded-[1px] border", row === 2 ? "border-[var(--preview-accent)] bg-[var(--preview-accent)]" : "border-[var(--preview-muted)]")} />
          <span className={cn("h-1 w-3/5 rounded-sm", row === 2 ? "bg-[var(--preview-accent)] opacity-50" : "bg-[var(--preview-ink)]")} />
        </span>)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2 bg-[var(--preview-sheet)] p-2">
        <span className="h-2.5 w-1/3 shrink-0 rounded-sm bg-[var(--preview-ink)]" />
        {[0, 1, 2].map((row) => <span key={row} className="flex min-h-0 items-center gap-1.5 border-t border-[var(--preview-line)] pt-1.5">
          <span className="h-5 w-3.5 shrink-0 rounded-sm bg-[var(--preview-ink)]" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="h-1.5 w-4/5 rounded-sm bg-[var(--preview-line)]" />
            <span className="h-1.5 w-1/2 rounded-sm bg-[var(--preview-ink)]" />
          </span>
        </span>)}
      </span>
    </span>
  </span>
}

function ThemeTileArt({ value }: { value: ThemePreference }) {
  if (value !== "system") return <ThemeSketch palette={THEME_PREVIEW[value]} />
  return <span aria-hidden className="relative block size-full">
    <span className="absolute inset-0"><ThemeSketch palette={THEME_PREVIEW.light} /></span>
    <span className="absolute inset-0 [clip-path:inset(0_0_0_50%)]"><ThemeSketch palette={THEME_PREVIEW.dark} /></span>
  </span>
}

export function AppearanceRows() {
  const { preference, setPreference } = useTheme()
  return <section aria-label="主题">
    <h3 className="sr-only">本机主题</h3>
    <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="主题模式">
      {THEME_OPTIONS.map(({ value, label }) => {
        const selected = preference === value
        return <label
          key={value}
          className={cn(
            "flex min-w-0 cursor-pointer flex-col gap-4 rounded-lg border bg-card p-5 pt-7 text-left transition-[border-color,box-shadow] duration-150 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
            selected ? "border-brand shadow-[0_0_0_1px_var(--brand)]" : "border-border hover:border-border-strong",
          )}
        >
          <span className="block aspect-[4/3] overflow-hidden rounded-lg border border-border"><ThemeTileArt value={value} /></span>
          <span className="flex items-center gap-3 px-1 pb-0.5 text-[16px] font-medium text-foreground">
            <input type="radio" name="appearance-theme" value={value} checked={selected} onChange={() => setPreference(value)} className="size-[22px] shrink-0 accent-brand" />
            {label}
          </span>
        </label>
      })}
    </fieldset>
  </section>
}
