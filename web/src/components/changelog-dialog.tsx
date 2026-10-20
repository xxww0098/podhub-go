import { useState } from "react"
import { Calendar, ScrollText, Sparkles } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  browserStorage,
  bundledChangelogReleases,
  changelogHasUnread,
  readSeenChangelogVersion,
  writeSeenChangelogVersion,
  type ChangelogRelease,
  type ChangelogSpan,
} from "@/lib/changelog"
import { productVersion, productVersionLabel } from "@/lib/product-version"
import { cn } from "@/lib/utils"

/**
 * Header control for the last three published versions.
 *
 * Dismissal (Escape, backdrop, close buttons) and focus entry/return
 * belong to the dialog primitive. Opening records the current product version
 * in localStorage; a mismatch paints the unread dot.
 */
export function ChangelogButton({
  releases,
  version,
  className,
}: {
  releases?: readonly ChangelogRelease[]
  version?: string
  className?: string
}) {
  const notes = releases ?? bundledChangelogReleases()
  const current = productVersion(version)
  const label = productVersionLabel(version)
  const title = label ? `${label} 更新内容` : "更新内容"
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(() => readSeenChangelogVersion(browserStorage()))
  const unread = changelogHasUnread(current, seen)

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next || current === "") return
    writeSeenChangelogVersion(current, browserStorage())
    setSeen(current)
  }

  const buttonLabel = unread ? "更新日志（有新版本）" : "更新日志"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={buttonLabel}
                  className={cn("relative", className)}
                />
              }
            />
          }
        >
          <Sparkles className="size-4" aria-hidden />
          <span className="sr-only">更新日志</span>
          {unread ? <span className="sr-only">，有新版本</span> : null}
          {unread ? (
            <span
              aria-hidden
              data-changelog-unread=""
              className="pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full bg-destructive ring-2 ring-background"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8} hidden={open}>
          {buttonLabel}
        </TooltipContent>
      </Tooltip>
      <DialogContent layout="panel" className="sm:max-w-xl max-h-[85vh]">
        <ChangelogDialogPanel title={title} releases={notes} />
      </DialogContent>
    </Dialog>
  )
}

export function ChangelogDialogPanel({
  title,
  releases,
}: {
  title: string
  releases: readonly ChangelogRelease[]
}) {
  return (
    <>
      <DialogHeader variant="panel">
        <div className="flex items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-brand/25 bg-brand-soft text-brand-ink">
            <Sparkles className="size-4" aria-hidden />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="text-compact text-muted-foreground">
              最近 3 个已发布版本的更新说明
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <DialogBody className="min-h-0" tabIndex={0} aria-label="版本更新列表">
        <ChangelogNotes releases={releases} />
      </DialogBody>
      <DialogFooter variant="panel" className="flex-row items-center justify-between border-t border-border">
        <div className="flex items-center gap-1.5 text-meta text-muted-foreground">
          <span className="size-1.5 rounded-full bg-st-good" aria-hidden />
          <span>只展示最近 3 个版本发布记录</span>
        </div>
        <DialogClose render={<Button type="button" variant="outline" size="sm" />}>
          关闭
        </DialogClose>
      </DialogFooter>
    </>
  )
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
    <div className="flex flex-col gap-6">
      {releases.map((release, index) => (
        <div key={release.version} className="flex flex-col gap-3.5">
          {index > 0 ? (
            <div className="py-2">
              <Separator />
            </div>
          ) : null}
          <section aria-labelledby={`changelog-${release.version}`} className="flex flex-col gap-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h3
                  id={`changelog-${release.version}`}
                  className="font-mono text-base font-bold tabular-nums tracking-tight text-foreground"
                >
                  v{release.version}
                </h3>
                {index === 0 ? (
                  <Badge variant="brand" className="h-5 px-1.5 text-meta font-medium">
                    最新版本
                  </Badge>
                ) : null}
                {release.note ? (
                  <span className="rounded border border-border/80 bg-muted/60 px-1.5 py-0.5 font-mono text-meta text-muted-foreground">
                    {release.note}
                  </span>
                ) : null}
              </div>
              {release.date ? (
                <div className="flex items-center gap-1.5 text-meta text-muted-foreground tabular-nums">
                  <Calendar className="size-3 text-muted-foreground/70" aria-hidden />
                  <time dateTime={release.date}>{release.date}</time>
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-4">
              {release.sections.map((section) => (
                <div key={section.title} className="flex flex-col gap-2">
                  <h4 className="flex items-center gap-1.5 text-compact font-semibold text-foreground">
                    <SectionBadge title={section.title} />
                  </h4>
                  <ul className="flex flex-col gap-2 pl-0.5">
                    {section.items.map((item, itemIndex) => (
                      <li
                        key={itemIndex}
                        className="relative flex items-start gap-2.5 text-compact leading-relaxed text-foreground/90"
                      >
                        <span
                          className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/45"
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1 wrap-anywhere">
                          <InlineSpans spans={item.spans} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </div>
      ))}
    </div>
  )
}

function SectionBadge({ title }: { title: string }) {
  if (title === "新增" || title.toLowerCase() === "feat") {
    return (
      <Badge variant="good" className="h-5 px-2 text-meta font-semibold">
        <span className="size-1.5 rounded-full bg-st-good-ink" aria-hidden />
        {title}
      </Badge>
    )
  }
  if (
    title === "优化" ||
    title.toLowerCase() === "perf" ||
    title.toLowerCase() === "refactor"
  ) {
    return (
      <Badge variant="brand" className="h-5 px-2 text-meta font-semibold">
        <span className="size-1.5 rounded-full bg-brand-ink" aria-hidden />
        {title}
      </Badge>
    )
  }
  if (title === "修复" || title.toLowerCase() === "fix") {
    return (
      <Badge variant="destructive" className="h-5 px-2 text-meta font-semibold">
        <span className="size-1.5 rounded-full bg-st-bad-ink" aria-hidden />
        {title}
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className="h-5 px-2 text-meta font-semibold">
      {title}
    </Badge>
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
