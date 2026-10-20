import { useCallback, useMemo, useState } from "react"
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatShortDay } from "@/lib/format"
import { cn } from "@/lib/utils"

export type DateRangePreset =
  | "today"
  | "yesterday"
  | "last7"
  | "last30"
  | "thisMonth"
  | "lastMonth"
  | "custom"

export type DateRangeValue = {
  from: string
  to: string
  preset: DateRangePreset
}

export const PRESET_OPTIONS: { id: DateRangePreset; label: string }[] = [
  { id: "today", label: "今天" },
  { id: "yesterday", label: "昨天" },
  { id: "last7", label: "近 7 天" },
  { id: "last30", label: "近 30 天" },
  { id: "thisMonth", label: "本月" },
  { id: "lastMonth", label: "上月" },
  { id: "custom", label: "自定义" },
]

function toUtcDateString(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function formatShortDateRange(from: string, to: string): string {
  return `${formatShortDay(from)} - ${formatShortDay(to)}`
}

export function getPresetDateRange(
  preset: DateRangePreset,
  now = new Date(),
): { from: string; to: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

  switch (preset) {
    case "today": {
      const str = toUtcDateString(today)
      return { from: str, to: str }
    }
    case "yesterday": {
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000)
      const str = toUtcDateString(yesterday)
      return { from: str, to: str }
    }
    case "last7": {
      const from = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)
      return { from: toUtcDateString(from), to: toUtcDateString(today) }
    }
    case "last30": {
      const from = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000)
      return { from: toUtcDateString(from), to: toUtcDateString(today) }
    }
    case "thisMonth": {
      const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      return { from: toUtcDateString(from), to: toUtcDateString(today) }
    }
    case "lastMonth": {
      const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))
      const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))
      return { from: toUtcDateString(from), to: toUtcDateString(to) }
    }
    case "custom": {
      const str = toUtcDateString(today)
      return { from: str, to: str }
    }
  }
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"]

function MonthCalendar({
  year,
  month,
  from,
  to,
  todayStr,
  selectionStart,
  hoverDate,
  onDayClick,
  onDayMouseEnter,
  headerLeading,
  headerTrailing,
}: {
  year: number
  month: number // 1-12
  from: string
  to: string
  todayStr: string
  selectionStart: string | null
  hoverDate: string | null
  onDayClick: (dateStr: string) => void
  onDayMouseEnter: (dateStr: string) => void
  headerLeading?: React.ReactNode
  headerTrailing?: React.ReactNode
}) {
  const firstDayOfWeek = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

  const rangeStart = selectionStart
    ? hoverDate && hoverDate < selectionStart
      ? hoverDate
      : selectionStart
    : from
  const rangeEnd = selectionStart
    ? hoverDate && hoverDate > selectionStart
      ? hoverDate
      : selectionStart
    : to

  const days = useMemo(() => {
    const list: { day: number; dateStr: string }[] = []
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`
      list.push({ day: d, dateStr })
    }
    return list
  }, [daysInMonth, month, year])

  return (
    <div className="flex w-52 flex-col gap-2">
      <div className="flex items-center justify-between text-xs font-semibold">
        <div className="size-6 flex items-center justify-center">{headerLeading}</div>
        <span>{`${year}年${month}月`}</span>
        <div className="size-6 flex items-center justify-center">{headerTrailing}</div>
      </div>

      <div className="grid grid-cols-7 text-center text-meta font-medium text-muted-foreground">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-1 text-center text-xs">
        {Array.from({ length: firstDayOfWeek }).map((_, i) => (
          <div key={`empty-${i}`} className="size-7" />
        ))}
        {days.map(({ day, dateStr }) => {
          const isFuture = dateStr > todayStr
          const isToday = dateStr === todayStr
          const isSelectedStart = dateStr === rangeStart
          const isSelectedEnd = dateStr === rangeEnd
          const isInRange = dateStr >= rangeStart && dateStr <= rangeEnd

          return (
            <div
              key={dateStr}
              className={cn(
                "relative flex size-7 items-center justify-center text-xs transition-colors",
                isInRange && "bg-muted/60",
                isSelectedStart && "rounded-l-full bg-muted/60",
                isSelectedEnd && "rounded-r-full bg-muted/60",
                !isInRange && "rounded-full",
              )}
            >
              <button
                type="button"
                disabled={isFuture}
                onClick={() => onDayClick(dateStr)}
                onMouseEnter={() => onDayMouseEnter(dateStr)}
                /* 选完起点后靠悬停预览候选区间；Tab 过来的人也得看见同一段。 */
                onFocus={() => onDayMouseEnter(dateStr)}
                className={cn(
                  "relative flex size-7 items-center justify-center rounded-full text-xs font-medium transition-colors cursor-pointer select-none",
                  isFuture && "text-muted-foreground/30 cursor-not-allowed pointer-events-none",
                  (isSelectedStart || isSelectedEnd) &&
                    "bg-foreground text-background font-semibold hover:bg-foreground hover:text-background",
                  !isSelectedStart && !isSelectedEnd && !isFuture && "hover:bg-muted text-foreground",
                  isToday &&
                    !isSelectedStart &&
                    !isSelectedEnd &&
                    "after:absolute after:top-1 after:right-1 after:size-1 after:rounded-full after:bg-foreground",
                )}
              >
                {day}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function DateRangePicker({
  value,
  onChange,
  className,
}: {
  value: DateRangeValue
  onChange: (value: DateRangeValue) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const now = useMemo(() => new Date(), [])
  const todayStr = useMemo(() => toUtcDateString(now), [now])

  const initialMonthDate = useMemo(() => {
    const end = new Date(value.to + "T00:00:00Z")
    return Number.isNaN(end.getTime()) ? now : end
  }, [now, value.to])

  const [viewYear, setViewYear] = useState(() => initialMonthDate.getUTCFullYear())
  const [viewMonth, setViewMonth] = useState(() => initialMonthDate.getUTCMonth() + 1) // 1-12 (right month)

  const [selectionStart, setSelectionStart] = useState<string | null>(null)
  const [hoverDate, setHoverDate] = useState<string | null>(null)

  const leftMonth = viewMonth === 1 ? 12 : viewMonth - 1
  const leftYear = viewMonth === 1 ? viewYear - 1 : viewYear

  const rightMonth = viewMonth
  const rightYear = viewYear

  const isCurrentMonthRight =
    rightYear === now.getUTCFullYear() && rightMonth === now.getUTCMonth() + 1

  const prevMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m === 1) {
        setViewYear((y) => y - 1)
        return 12
      }
      return m - 1
    })
  }, [])

  const nextMonth = useCallback(() => {
    if (isCurrentMonthRight) return
    setViewMonth((m) => {
      if (m === 12) {
        setViewYear((y) => y + 1)
        return 1
      }
      return m + 1
    })
  }, [isCurrentMonthRight])

  const handlePresetSelect = useCallback(
    (preset: DateRangePreset) => {
      if (preset === "custom") {
        onChange({ ...value, preset: "custom" })
        return
      }
      const range = getPresetDateRange(preset, now)
      onChange({ from: range.from, to: range.to, preset })
      setSelectionStart(null)
      setHoverDate(null)
      setOpen(false)
    },
    [now, onChange, value],
  )

  const handleDayClick = useCallback(
    (dateStr: string) => {
      if (!selectionStart) {
        setSelectionStart(dateStr)
        setHoverDate(dateStr)
      } else {
        const from = selectionStart <= dateStr ? selectionStart : dateStr
        const to = selectionStart <= dateStr ? dateStr : selectionStart
        onChange({ from, to, preset: "custom" })
        setSelectionStart(null)
        setHoverDate(null)
        setOpen(false)
      }
    },
    [onChange, selectionStart],
  )

  const handleDayMouseEnter = useCallback(
    (dateStr: string) => {
      if (selectionStart) {
        setHoverDate(dateStr)
      }
    },
    [selectionStart],
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`时间维度 ${formatShortDateRange(value.from, value.to)}`}
            className={cn(
              "group inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-sidebar-accent/40 px-3 text-xs transition-colors hover:border-border-strong hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring cursor-pointer select-none",
              className,
            )}
          />
        }
      >
        <span className="text-meta font-semibold text-faint-foreground">时间维度</span>
        <span className="font-mono text-xs font-medium text-foreground tabular-nums">
          {formatShortDateRange(value.from, value.to)}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground transition-transform duration-200 group-hover:text-foreground",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-auto p-0 shadow-overlay rounded-2xl overflow-hidden"
      >
        <div className="flex divide-x divide-border">
          <div className="flex w-28 flex-col gap-1 p-2 bg-muted/20">
            {PRESET_OPTIONS.map((item) => {
              const active = value.preset === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handlePresetSelect(item.id)}
                  className={cn(
                    "flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors text-left cursor-pointer",
                    active
                      ? "bg-muted text-foreground font-semibold"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <span>{item.label}</span>
                  {item.id === "custom" && active ? <Check className="size-3.5 text-foreground" /> : null}
                </button>
              )
            })}
          </div>

          <div className="flex items-start gap-6 p-4">
            <MonthCalendar
              year={leftYear}
              month={leftMonth}
              from={value.from}
              to={value.to}
              todayStr={todayStr}
              selectionStart={selectionStart}
              hoverDate={hoverDate}
              onDayClick={handleDayClick}
              onDayMouseEnter={handleDayMouseEnter}
              headerLeading={
                <Button variant="ghost" size="icon-xs" onClick={prevMonth} aria-label="上一月">
                  <ChevronLeft className="size-3.5" />
                </Button>
              }
            />
            <MonthCalendar
              year={rightYear}
              month={rightMonth}
              from={value.from}
              to={value.to}
              todayStr={todayStr}
              selectionStart={selectionStart}
              hoverDate={hoverDate}
              onDayClick={handleDayClick}
              onDayMouseEnter={handleDayMouseEnter}
              headerTrailing={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={isCurrentMonthRight}
                  onClick={nextMonth}
                  aria-label="下一月"
                >
                  <ChevronRight className="size-3.5" />
                </Button>
              }
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
