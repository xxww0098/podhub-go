import { useEffect, useMemo, useRef, useState } from "react"
import { FileText, FolderOpen, Layers, Pencil, RefreshCw } from "lucide-react"

import { loadCategoryTree } from "@/features/category-schema/category-tree-load"
import {
  supplierDbsHttp,
  type PatchSupplierPromptRequest,
  type SupplierPrompt,
} from "@/bindings/http-supplier-dbs"
import type { CategoryTreeNodeView, WorkflowPromptDirEntry } from "@/bindings/commands"
import { PlatformAdminEmpty, PlatformAdminSurface } from "@/components/platform-admin-surface"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { workflowActions } from "@/features/workflow/workflow-actions"
import {
  categoryPathLabel,
  isTypeLeaf,
  nodeName,
} from "@/features/category-schema/category-tree"
import { SupplierPromptAuthoring } from "@/features/supplier-dbs/supplier-prompt-authoring"
import { SupplierPromptEditDialog, type SupplierPromptDraft } from "@/features/platform/supplier-prompt-edit-dialog"
import { readCategoryTreeCache } from "@/features/category-schema/category-tree-cache"
import { SyncReportPanel, useCategoryPromptSync } from "@/features/platform/prompts-sync"
import { bannedTagRejection, refreshBannedTags } from "@/lib/banned-tags"
import { clearLive, notifyCommandError, notifyError, notifyLive, notifySuccess } from "@/lib/notify"
import { errorMessage } from "@/lib/error-message"
import { FIXED_TAGS_MAX, isValidFixedTag } from "@/lib/fixed-tags"
import { cn } from "@/lib/utils"

const PROMPT_FILE_ACCEPT = ".txt,.md,text/plain,text/markdown"
const PROMPTS_LIVE = "supplier-prompts-load"
const CATEGORY_TREE_LIVE = "supplier-prompts-tree-load"

export function categoryPathKey(l1: string, l2: string, type: string): string {
  return [l1, l2, type].map((name) => name.replace(/\s+/g, "")).join("\u0000")
}

export function categoryCoordinatesByPath(tree: CategoryTreeNodeView[]) {
  const coordinates = new Map<string, { descriptionCategoryId: number; typeId: number } | undefined>()
  for (const l1 of tree)
    for (const l2 of l1.children)
      for (const leaf of l2.children)
        if (isTypeLeaf(leaf)) {
          const key = categoryPathKey(nodeName(l1), nodeName(l2), nodeName(leaf))
          const next = { descriptionCategoryId: l2.description_category_id, typeId: leaf.type_id }
          const current = coordinates.get(key)
          if (!coordinates.has(key)) coordinates.set(key, next)
          else if (!current || current.descriptionCategoryId !== next.descriptionCategoryId || current.typeId !== next.typeId) {
            coordinates.set(key, undefined)
          }
        }
  return coordinates
}

function categoryKey(descriptionCategoryId: number, typeId: number): string {
  return `${descriptionCategoryId}:${typeId}`
}

export function parseFixedTags(value = ""): string[] {
  return value.split(/\s+/).map((tag) => tag.trim()).filter(Boolean)
}

export function formatFixedTags(tags: string[]): string {
  return tags.join("\n")
}

export function uniquePromptForImport(
  prompts: SupplierPrompt[],
  entry: WorkflowPromptDirEntry,
  coordinates?: { descriptionCategoryId: number; typeId: number },
): SupplierPrompt | undefined {
  if (!coordinates) return undefined
  const matches = prompts.filter((prompt) =>
    prompt.descriptionCategoryId === coordinates.descriptionCategoryId &&
    prompt.typeId === coordinates.typeId &&
    prompt.promptFileName === entry.file_name,
  )
  return matches.length === 1 ? matches[0] : undefined
}

function draftFromPrompt(prompt: SupplierPrompt): SupplierPromptDraft {
  return {
    promptName: prompt.promptName,
    promptFileName: prompt.promptFileName,
    promptContent: prompt.promptContent,
    fixedTags: formatFixedTags(prompt.fixedTags),
  }
}

function draftReady(draft: SupplierPromptDraft): boolean {
  const tags = parseFixedTags(draft.fixedTags).length
  return Boolean(draft.promptContent.trim() && tags >= 1 && tags <= FIXED_TAGS_MAX)
}

async function readPromptFile(file: File): Promise<{ fileName: string; content: string }> {
  if (!/\.(md|txt)$/i.test(file.name)) throw new Error("仅支持 .md 或 .txt 文件")
  return { fileName: file.name, content: await file.text() }
}

/**
 * 文件夹导入只换商品说明正文；固定标签由管理员在前端构建，沿用商品自己的
 * （ADR-0103）。正文格式由服务端 `validate_brief` 判定，前端不镜像。
 */
export function promptPatch(prompt: SupplierPrompt, entry: WorkflowPromptDirEntry): PatchSupplierPromptRequest {
  return {
    promptName: entry.name || prompt.promptName,
    promptFileName: entry.file_name,
    promptContent: entry.content,
    fixedTags: prompt.fixedTags,
    expectedRevision: prompt.revision,
  }
}

export function PlatformPromptsScreen() {
  return (
    <>
      <AdminPrompts />
    </>
  )
}

export function AdminPrompts() {
  const [prompts, setPrompts] = useState<SupplierPrompt[]>([])
  const [tree, setTree] = useState<CategoryTreeNodeView[]>(() => readCategoryTreeCache() ?? [])
  const [loading, setLoading] = useState(true)
  const [treeBusy, setTreeBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState("")
  const [selectedCategory, setSelectedCategory] = useState("")
  const [activeProductId, setActiveProductId] = useState("")
  const [editing, setEditing] = useState<SupplierPrompt>()
  const [draft, setDraft] = useState<SupplierPromptDraft>()
  const categorySync = useCategoryPromptSync(reload)
  const fileRef = useRef<HTMLInputElement>(null)

  async function reload() {
    setLoading(true)
    clearLive(PROMPTS_LIVE)
    try {
      const data = await supplierDbsHttp.supplierPromptsList()
      setPrompts(data.prompts)
    } catch (reason) {
      notifyLive({
        id: PROMPTS_LIVE,
        type: "error",
        reason,
        title: errorMessage(reason, "无法读取供应商提示词。"),
        action: { label: "重试", onClick: () => void reload() },
      })
    } finally {
      setLoading(false)
    }
  }

  async function refreshTree() {
    if (treeBusy) return
    setTreeBusy(true)
    clearLive(CATEGORY_TREE_LIVE)
    try {
      const next = await loadCategoryTree()
      setTree(next)
    } catch (reason) {
      notifyLive({
        id: CATEGORY_TREE_LIVE,
        type: "error",
        reason,
        title: errorMessage(reason, "无法刷新 Ozon 类目树。"),
        action: { label: "重试", onClick: () => void refreshTree() },
      })
    } finally {
      setTreeBusy(false)
    }
  }

  useEffect(() => {
    void reload()
    void refreshBannedTags().catch((reason) => {
      notifyCommandError(reason, "无法读取受限标签，保存时仍由服务器拦截。")
    })
    if (tree.length === 0) void refreshTree()
    return () => {
      clearLive(PROMPTS_LIVE)
      clearLive(CATEGORY_TREE_LIVE)
    }
  }, [])

  const categories = useMemo(() => {
    const grouped = new Map<string, {
      key: string
      descriptionCategoryId: number
      typeId: number
      label: string
      prompts: SupplierPrompt[]
    }>()
    for (const prompt of prompts) {
      const key = categoryKey(prompt.descriptionCategoryId, prompt.typeId)
      const group = grouped.get(key) ?? {
        key,
        descriptionCategoryId: prompt.descriptionCategoryId,
        typeId: prompt.typeId,
        label: categoryPathLabel(prompt.descriptionCategoryId, prompt.typeId, tree),
        prompts: [],
      }
      group.prompts.push(prompt)
      grouped.set(key, group)
    }
    return [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label, "zh"))
  }, [prompts, tree])

  const visibleCategories = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return categories
    return categories.filter((category) =>
      `${category.label} ${category.descriptionCategoryId} ${category.typeId}`
        .toLocaleLowerCase()
        .includes(needle),
    )
  }, [categories, query])

  useEffect(() => {
    if (!categories.some((category) => category.key === selectedCategory)) {
      setSelectedCategory(categories[0]?.key ?? "")
    }
  }, [categories, selectedCategory])

  const selected = categories.find((category) => category.key === selectedCategory)
  const sortedPrompts = useMemo(
    () => [...(selected?.prompts ?? [])].sort((a, b) =>
      (a.promptName || a.productTitle).localeCompare(b.promptName || b.productTitle, "zh"),
    ),
    [selected],
  )
  const active = sortedPrompts.find((prompt) => prompt.productId === activeProductId) ?? sortedPrompts[0]
  const draftTags = draft ? parseFixedTags(draft.fixedTags) : []
  const draftTagsInvalid = draftTags.some((tag) => !isValidFixedTag(tag))

  useEffect(() => {
    if (!active || active.productId === activeProductId) return
    setActiveProductId(active.productId)
  }, [active, activeProductId])

  function openEdit(prompt: SupplierPrompt) {
    setEditing(prompt)
    setDraft(draftFromPrompt(prompt))
  }

  async function saveEdit() {
    if (!editing || !draft || !draftReady(draft)) return
    // 服务端 normalize_supplier_prompt 会拒契约外 tag —— 先点名是哪条坏了。
    const badTag = parseFixedTags(draft.fixedTags).find((tag) => !isValidFixedTag(tag))
    if (badTag) {
      notifyError(`固定标签 ${badTag} 不符合契约`, {
        description: "每个标签须为 # 开头的俄语词，可含数字、用 _ 连词。",
      })
      return
    }
    const banned = parseFixedTags(draft.fixedTags).map(bannedTagRejection).find((message) => message)
    if (banned) {
      notifyError(banned)
      return
    }
    setBusy(true)
    try {
      const data = await supplierDbsHttp.supplierPromptPatch(editing.productId, {
        promptName: draft.promptName.trim(),
        promptFileName: draft.promptFileName.trim(),
        promptContent: draft.promptContent,
        fixedTags: parseFixedTags(draft.fixedTags),
        expectedRevision: editing.revision,
      })
      setPrompts((current) => current.map((prompt) =>
        prompt.productId === data.prompt.productId ? data.prompt : prompt,
      ))
      setEditing(undefined)
      setDraft(undefined)
      notifySuccess("已保存为草稿", { description: editing.productTitle })
    } catch (reason) {
      notifyCommandError(reason, "无法保存提示词；如商品已被修改，请刷新后重试。")
    } finally {
      setBusy(false)
    }
  }

  async function importDirectory() {
    if (tree.length === 0 || busy) {
      notifyError("请先抓取类目", { description: "请到“类目”设置抓取类目树，再批量更新提示词。" })
      return
    }
    setBusy(true)
    try {
      const scan = await workflowActions.workflowScanPromptDir()
      const leafByPath = categoryCoordinatesByPath(tree)

      let updated = 0
      let skipped = scan.skipped.length
      const failed: string[] = []
      let current = [...prompts]
      let lastError: unknown
      for (const entry of scan.entries) {
        const coordinates = leafByPath.get(categoryPathKey(entry.l1_name, entry.l2_name, entry.type_name))
        const prompt = uniquePromptForImport(current, entry, coordinates)
        if (!entry.content.trim() || !prompt) {
          skipped += 1
          continue
        }
        try {
          const data = await supplierDbsHttp.supplierPromptPatch(prompt.productId, promptPatch(prompt, entry))
          current = current.map((row) => row.productId === data.prompt.productId ? data.prompt : row)
          updated += 1
        } catch (reason) {
          failed.push(entry.file_name)
          lastError = reason
        }
      }
      setPrompts(current)
      // 切换期的失败按文件处理（旧整篇、商品现有标签不合规），所以列出文件名。
      const description = `更新 ${updated} 条；跳过 ${skipped} 条${failed.length ? `；失败 ${failed.length} 条：${failed.join("、")}` : ""}。只更新正文，固定标签保持不变。`
      if (failed.length) notifyCommandError(lastError, description)
      else if (updated) notifySuccess("已保存为草稿", { description })
      else notifyError("没有可更新的提示词", {
        description: "仅更新同类目中存在且文件名唯一匹配的供应商提示词。",
      })
    } catch (reason) {
      notifyCommandError(reason, "无法读取提示词文件夹，请稍后重试。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PlatformAdminSurface
        summary={
          <p>
            同步类目提示词或批量替换正文。每个类目至少保留一条；固定标签保持不变。
          </p>
        }
        toolbar={
          <div className="flex w-full flex-wrap items-center gap-2 sm:justify-end">
            <Button type="button" size="sm" variant="outline" disabled={busy || categorySync.syncing} onClick={() => void categorySync.run()}>
              {categorySync.syncing ? <Spinner data-icon="inline-start" /> : <Layers data-icon="inline-start" />}
              按类目提示词同步
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy || treeBusy || categorySync.syncing} onClick={() => void importDirectory()}>
              {busy ? <Spinner data-icon="inline-start" /> : <FolderOpen data-icon="inline-start" />}
              批量更新文件夹
            </Button>
            <Button type="button" size="icon-sm" variant="ghost" disabled={loading} aria-label="刷新供应商提示词" onClick={() => void reload()}>
              <RefreshCw className={cn(loading && "animate-spin")} aria-hidden />
            </Button>
          </div>
        }
      >
        {categorySync.report ? (
          <SyncReportPanel report={categorySync.report} onDismiss={categorySync.dismiss} />
        ) : null}
        <div className="grid min-h-96 min-w-0 xl:grid-cols-3">
          <aside className="flex min-h-0 min-w-0 flex-col gap-2 border-b border-border p-4 xl:border-r xl:border-b-0">
            <div className="relative">
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已提交类目" aria-label="搜索已提交提示词的类目" type="search" />
            </div>
            <div className="flex items-baseline justify-between px-0.5">
              <p className="text-meta font-medium text-muted-foreground">已提交类目</p>
              <span className="font-mono text-meta text-faint-foreground tabular-nums">{categories.length}</span>
            </div>
            {loading ? (
              <p role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Spinner className="size-3.5" />正在读取供应商提示词…</p>
            ) : visibleCategories.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">{query ? "没有匹配的已提交类目。" : "平台货源还没有已提交的提示词。"}</p>
            ) : (
              <nav aria-label="已提交提示词的类目" className="min-h-0 flex-1 overflow-y-auto">
                {visibleCategories.map((category) => (
                  <button
                    key={category.key}
                    type="button"
                    aria-current={category.key === selectedCategory ? "true" : undefined}
                    onClick={() => setSelectedCategory(category.key)}
                    className={cn(
                      "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                      category.key === selectedCategory ? "bg-brand-soft text-brand-ink" : "text-foreground hover:bg-muted",
                    )}
                  >
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{category.label}</span>
                      <span className="shrink-0 font-mono text-meta tabular-nums text-faint-foreground">{category.prompts.length}</span>
                    </span>
                    <span className="font-mono text-meta text-faint-foreground">{category.descriptionCategoryId} / {category.typeId}</span>
                  </button>
                ))}
              </nav>
            )}
          </aside>

          <section className="min-w-0 p-4 xl:col-span-2">
            {!selected ? (
              <PlatformAdminEmpty icon={FileText} className="min-h-80" title="选择已提交类目" description="这里只显示平台货源中已有提示词的类目。" />
            ) : (
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex items-center justify-between gap-3 border-b border-border pb-2.5">
                  <p className="truncate text-sm font-medium">{selected.label}</p>
                  <Badge variant="code">{sortedPrompts.length} 条</Badge>
                </div>
                <div className="grid min-h-72 overflow-hidden rounded-lg border border-border 2xl:grid-cols-3">
                  <nav aria-label="此类目的供应商提示词" className="max-h-80 overflow-y-auto border-b border-border p-1 2xl:max-h-96 2xl:border-r 2xl:border-b-0">
                    {sortedPrompts.map((prompt) => (
                      <button
                        key={prompt.productId}
                        type="button"
                        aria-current={prompt.productId === active?.productId ? "true" : undefined}
                        onClick={() => setActiveProductId(prompt.productId)}
                        className={cn(
                          "flex w-full flex-col gap-1 rounded-md px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                          prompt.productId === active?.productId ? "bg-brand-soft text-brand-ink" : "text-foreground hover:bg-muted",
                        )}
                      >
                        <span className="truncate text-sm font-medium">{prompt.promptName || prompt.productTitle}</span>
                        <span className="truncate text-xs text-muted-foreground">{prompt.productTitle}</span>
                        <span className="truncate font-mono text-meta text-faint-foreground">{prompt.promptFileName || prompt.productId}</span>
                      </button>
                    ))}
                  </nav>
                  {active ? (
                    <article className="flex min-h-0 min-w-0 flex-col 2xl:col-span-2">
                      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
                        <div className="min-w-0">
                          <h2 className="truncate text-sm font-medium">{active.promptName || active.productTitle}</h2>
                          <p className="mt-1 truncate text-xs text-muted-foreground">供应商商品：{active.productTitle}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <SupplierPromptAuthoring
                            sourceId={active.sourceId}
                            productId={active.productId}
                            brief={active.promptContent}
                            fixedTags={active.fixedTags}
                            draftRevision={active.draftPromptRevision}
                            publishedRevision={active.publishedPromptRevision}
                            dirty={false}
                            onPublished={(published) => {
                              setPrompts((current) => current.map((prompt) =>
                                prompt.productId === published.productId
                                  ? {
                                    ...prompt,
                                    publishedPromptRevision: published.publishedRevision,
                                    revision: published.productRevision,
                                  }
                                  : prompt,
                              ))
                            }}
                          />
                          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => openEdit(active)}><Pencil data-icon="inline-start" />编辑</Button>
                        </div>
                      </header>
                      <pre className="min-h-72 max-h-96 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-6 text-foreground">{active.promptContent}</pre>
                    </article>
                  ) : null}
                </div>
              </div>
            )}
          </section>
        </div>
      </PlatformAdminSurface>

      <SupplierPromptEditDialog
        editing={editing}
        draft={draft}
        tree={tree}
        busy={busy}
        fileRef={fileRef}
        accept={PROMPT_FILE_ACCEPT}
        tagsInvalid={draftTagsInvalid}
        tagCount={draftTags.length}
        ready={Boolean(draft && draftReady(draft))}
        onOpenChange={(open) => { if (!open) { setEditing(undefined); setDraft(undefined) } }}
        onDraftChange={setDraft}
        onSave={() => void saveEdit()}
        onReadFile={readPromptFile}
      />
    </>
  )
}
