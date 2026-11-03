import { useMemo } from "react"
import { Calendar, ScrollText } from "lucide-react"

import {
  bundledChangelogReleases,
  type ChangelogRelease,
  type ChangelogSpan,
} from "@/lib/changelog"
import { cn } from "@/lib/utils"

/** Settings pane body: the last published versions bundled at build time. */
export function ChangelogPane() {
  const releases = useMemo(bundledChangelogReleases, [])
  return <ChangelogNotes releases={releases} />
}

export function ChangelogNotes({ releases }: { releases: readonly ChangelogRelease[] }) {
  if (releases.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <ScrollText className="size-5" aria-hidden />
        </div>
        <p className="text-compact font-medium text-foreground">暂时没有可显示的更新记录</p>
        <p className="mt-1 text-meta text-muted-foreground">发布新版本后将在此处呈现更新详情</p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-5">
      {releases.map((release, index) => (
        <section
          key={release.version}
          aria-labelledby={`changelog-${release.version}`}
          className="rounded-xl border border-border bg-card p-4 sm:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3
                id={`changelog-${release.version}`}
                className="text-3xl leading-tight font-semibold tabular-nums text-foreground"
              >
                {release.version}
              </h3>
              {release.date ? <span className="inline-flex items-center gap-1.5 text-meta tabular-nums text-muted-foreground">
                <Calendar className="size-3" aria-hidden />
                <time dateTime={release.date}>{release.date}</time>
              </span> : null}
              {release.note ? <span className="text-meta text-muted-foreground">{release.note}</span> : null}
            </div>
            {index === 0 ? <span className="inline-flex h-9 items-center rounded-md bg-brand-soft px-3 text-lg font-medium text-brand-ink">最新版本</span> : null}
          </div>

          <div className="mt-4 space-y-5">
            {release.sections.map((section) => (
              <div key={section.title} className="grid gap-x-6 gap-y-2 sm:grid-cols-[4rem_minmax(0,1fr)]">
                <h4 className="pt-0.5">
                  <SectionBadge title={section.title} />
                </h4>
                <ul className="list-disc space-y-1.5 pl-5 text-lg leading-7 text-foreground/85 marker:text-muted-foreground">
                  {section.items.map((item, itemIndex) => (
                    <li key={itemIndex} className="wrap-anywhere">
                        <InlineSpans spans={item.spans} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function SectionBadge({ title }: { title: string }) {
  const kind = title.toLowerCase()
  const color = title === "新增" || kind === "feat"
    ? "bg-brand-soft text-brand-ink"
    : title === "优化" || kind === "perf" || kind === "refactor"
      ? "bg-st-good-soft text-st-good-ink"
      : title === "修复" || kind === "fix"
        ? "bg-st-bad-soft text-st-bad-ink"
        : "bg-secondary text-secondary-foreground"
  return (
    <span className={cn("inline-flex h-9 min-w-16 max-w-full items-center justify-center overflow-hidden rounded-md px-3 text-lg leading-none font-medium whitespace-nowrap", color)}>
      {title}
    </span>
  )
}

function InlineSpans({ spans }: { spans: readonly ChangelogSpan[] }) {
  return spans.map((span, index) =>
    span.kind === "code" ? (
      <code
        key={index}
        className="rounded border border-border/80 bg-muted px-1.5 py-0.5 font-mono text-meta font-medium text-foreground"
      >
        {span.text}
      </code>
    ) : (
      <span key={index}>{span.text}</span>
    ),
  )
}
