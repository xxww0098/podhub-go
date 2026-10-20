/** Six-line drafts save explicitly: incomplete lines cannot pass the server contract. */
import { useEffect, useId, useMemo, useState } from "react"
import { MoreHorizontal } from "lucide-react"

import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { notifyError, notifySuccess } from "@/lib/notify"

import { BRIEF_FRAGMENTS, skeletonBriefValues } from "./brief-fragments"
import {
  BRIEF_LINES,
  assembleBrief,
  briefAdvisories,
  emptyBriefValues,
  parseBriefLines,
  type BriefLineKey,
  type BriefValues,
} from "./brief-lines"
import { FieldNote } from "./supplier-row-media"
import type { PatchFn } from "./supplier-row-fields"

type BriefDraft = {
  saved: string
  mode: "structured" | "raw"
  fields: BriefValues
  raw: string
}

function draftFrom(content: string): BriefDraft {
  const parsed = parseBriefLines(content)
  return {
    saved: content,
    mode: parsed || !content.trim() ? "structured" : "raw",
    fields: parsed ?? emptyBriefValues(),
    raw: content,
  }
}

function canonical(content: string): string {
  const parsed = parseBriefLines(content)
  return parsed ? assembleBrief(parsed) : content.trim()
}

const draftText = (draft: BriefDraft) =>
  draft.mode === "structured" ? assembleBrief(draft.fields) : draft.raw

const sourceLabel = (row: SupplierDbRow) =>
  [row.title.trim() || "未命名", row.size.trim()].filter(Boolean).join(" · ")

export function SupplierBriefBuilder({ row, rows, onPatch, onDirtyChange }: {
  row: SupplierDbRow
  rows: readonly SupplierDbRow[]
  onPatch: PatchFn
  onDirtyChange?: (dirty: boolean) => void
}) {
  const id = useId()
  const [draft, setDraft] = useState(() => draftFrom(row.promptContent))
  const [saving, setSaving] = useState(false)
  const [sourceNote, setSourceNote] = useState<string | null>(null)
  const content = draftText(draft)
  const changed = canonical(content) !== canonical(draft.saved)
  const bytes = new TextEncoder().encode(content.trim()).length
  const hasCategory = row.descriptionCategoryId != null && row.typeId != null
  const advisories = useMemo(() => briefAdvisories(draft.fields), [draft.fields])

  // Compare against the previous saved value, not the incoming one: clean editors
  // follow imports/refetches, while unsaved edits survive a server refresh.
  useEffect(() => {
    setDraft((current) => {
      if (current.saved === row.promptContent) return current
      return canonical(draftText(current)) === canonical(current.saved)
        ? draftFrom(row.promptContent)
        : { ...current, saved: row.promptContent }
    })
  }, [row.promptContent])

  useEffect(() => { onDirtyChange?.(changed) }, [changed, onDirtyChange])

  const siblings = rows.filter((item) =>
    !item.archived && item.productId !== row.productId &&
    !!row.variantGroup?.trim() && item.variantGroup === row.variantGroup &&
    parseBriefLines(item.promptContent),
  )
  const peers = rows.filter((item) =>
    !item.archived && item.productId !== row.productId && hasCategory &&
    item.descriptionCategoryId === row.descriptionCategoryId && item.typeId === row.typeId &&
    !siblings.some((sibling) => sibling.productId === item.productId) &&
    parseBriefLines(item.promptContent),
  )

  const applySource = (source: SupplierDbRow) => {
    setDraft((current) => ({ ...draftFrom(source.promptContent), saved: current.saved }))
    setSourceNote(`已从「${sourceLabel(source)}」载入草稿，请按当前规格核对后保存。`)
  }

  const switchMode = () => {
    if (draft.mode === "structured") {
      setDraft((current) => ({ ...current, raw: assembleBrief(current.fields), mode: "raw" }))
      return
    }
    const parsed = parseBriefLines(draft.raw)
    if (draft.raw.trim() && !parsed && canonical(draft.raw) !== canonical(assembleBrief(draft.fields))) {
      notifyError("请先将正文整理为六行俄文说明，再切换到分行编辑")
      return
    }
    setDraft((current) => ({ ...current, fields: parsed ?? current.fields, mode: "structured" }))
  }

  const save = async () => {
    if (!changed || saving || !hasCategory) return
    if (bytes > 4096) {
      notifyError("提示词正文不能超过 4 KB")
      return
    }
    if (draft.mode === "structured" && advisories.length) {
      notifyError(advisories.map((item) => item.message).join("；"))
      return
    }
    setSaving(true)
    try {
      if (await onPatch({ promptContent: content.trim() })) {
        setDraft((current) => ({ ...current, saved: content.trim() }))
        setSourceNote(null)
        notifySuccess("已存为草稿")
      }
    } finally {
      setSaving(false)
    }
  }

  const insertFragment = (key: BriefLineKey, ru: string) => {
    setDraft((current) => ({ ...current, fields: {
      ...current.fields,
      [key]: [current.fields[key].trim(), ru].filter(Boolean).join(" "),
    } }))
  }

  return (
    <div className="flex flex-col gap-4" data-brief-builder="" aria-busy={saving || undefined}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-meta text-muted-foreground">六行俄文说明 · 正文 ≤ 4 KB；始终绑定当前商品规格。</p>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={saving} />}>
            <MoreHorizontal aria-hidden />更多
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={switchMode}>
              {draft.mode === "structured" ? "自由文本" : "分六行构建"}
            </DropdownMenuItem>
            {draft.mode === "structured" ? <>
              <DropdownMenuItem onClick={() => setDraft((current) => ({ ...current, fields: skeletonBriefValues(current.fields) }))}>
                插入骨架句（仅补空白）
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <SourceMenu label="从同款规格复制" sources={siblings} onPick={applySource} />
              <SourceMenu label="从同类目商品复制" sources={peers} onPick={applySource} />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>插入俄文片段</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {BRIEF_LINES.filter((def) => BRIEF_FRAGMENTS[def.key].length > 0).map((def) => (
                    <DropdownMenuSub key={def.key}>
                      <DropdownMenuSubTrigger>{def.zh}</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-w-80">
                        {BRIEF_FRAGMENTS[def.key].map((fragment) => (
                          <DropdownMenuItem key={fragment.ru} onClick={() => insertFragment(def.key, fragment.ru)}>
                            {fragment.zh}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {sourceNote && changed ? <p className="text-meta text-muted-foreground" data-brief-source-note="">{sourceNote}</p> : null}
      {draft.mode === "raw" ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-raw`} className="text-compact">提示词正文</label>
          {!parseBriefLines(draft.raw) && draft.raw.trim() ? (
            <p className="text-meta text-muted-foreground">旧版正文已保留，可在此整理为六行说明后保存。</p>
          ) : null}
          <Textarea id={`${id}-raw`} aria-label="提示词正文" value={draft.raw} rows={10}
            className="max-h-96" disabled={saving} spellCheck={false}
            onChange={(event) => setDraft((current) => ({ ...current, raw: event.target.value }))} />
        </div>
      ) : BRIEF_LINES.map((def) => (
        <div key={def.key} className="flex flex-col gap-1.5" data-brief-line={def.key}>
          <div className="flex flex-wrap items-baseline gap-1.5">
            <label htmlFor={`${id}-${def.key}`} className="text-compact">{LINE_NAMES[def.key]}</label>
            <span className="font-mono text-meta text-muted-foreground">{def.label}</span>
            <FieldNote text={`${def.purpose}${def.hint}`} />
          </div>
          <Textarea id={`${id}-${def.key}`} aria-label={`说明行 ${def.zh}（${def.label}）`}
            value={draft.fields[def.key]} rows={def.key === "theme" || def.key === "description" ? 3 : 2}
            className="max-h-72" disabled={saving} spellCheck={false}
            aria-invalid={advisories.some((item) => item.key === def.key) || undefined}
            onChange={(event) => setDraft((current) => ({ ...current, fields: { ...current.fields, [def.key]: event.target.value } }))} />
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="brand" size="sm" disabled={!changed || saving || !hasCategory}
          data-brief-save="" onClick={() => void save()}>
          {saving ? <Spinner data-icon="inline-start" /> : null}保存提示词
        </Button>
        {!hasCategory ? <span className="text-meta text-muted-foreground">选择 Ozon 类目后可保存</span> : null}
        <span className="ml-auto font-mono text-meta text-muted-foreground tabular-nums" data-brief-bytes="">{bytes} / 4096 B</span>
      </div>
    </div>
  )
}

const LINE_NAMES: Record<BriefLineKey, string> = {
  goods: "商品事实", theme: "图像主题", title: "标题规则", forbidden: "禁用表述", description: "描述规则", invented: "禁止编造",
}

function SourceMenu({ label, sources, onPick }: {
  label: string
  sources: readonly SupplierDbRow[]
  onPick: (source: SupplierDbRow) => void
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={sources.length === 0}>{label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72">
        {sources.map((source) => (
          <DropdownMenuItem key={source.productId} onClick={() => onPick(source)}>{sourceLabel(source)}</DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
