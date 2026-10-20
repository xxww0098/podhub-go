import { useEffect, useState, type ReactNode } from "react"
import { FileImage, RefreshCw, RotateCw, Upload, X } from "lucide-react"
import type {
  CategoryTreeNodeView,
  OzonStoreView,
  WorkflowCategoryPrompt,
} from "@/bindings/commands"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { notifyError } from "@/lib/notify"
import { useFileDropTarget } from "@/hooks/use-file-drop-target"
import { CategoryTripleSelect } from "@/features/category-schema/category-triple-select"
import type { CategoryTreeSelection } from "@/features/category-schema/category-tree"
import { StoreMultiSelect } from "./store-multi-select"
import { composeSellerCredentialIssue } from "./store-availability"
import { parseStoreIds, formatStoreIds } from "./store-quota"

function typeReady(selection: CategoryTreeSelection): boolean {
  return selection.descriptionCategoryId > 0 && selection.typeId > 0
}

export type BindFormIssue = {
  fieldId: string
  label: string
  message: string
}

/**
 * 上架基础信息 is what a Card needs to exist: a name, a 商品类型 leaf and the
 * category's prompt. 店铺 and PSD are bindings the operator completes before
 * 准备 / 发送 (the workbench refuses those verbs until they are set).
 */
export function bindFormIssues(input: {
  idPrefix: string
  name: string
  descriptionCategoryId: number
  typeId: number
  promptId: string
}): BindFormIssue[] {
  const issues: BindFormIssue[] = []
  if (!input.name.trim()) {
    issues.push({
      fieldId: `${input.idPrefix}-name`,
      label: "名称",
      message: "填写上架方案名称。",
    })
  }
  if (!(input.descriptionCategoryId > 0 && input.typeId > 0)) {
    issues.push({
      fieldId: `${input.idPrefix}-category-search`,
      label: "类目",
      message: "搜索并选择一个商品类型。",
    })
  }
  if (!input.promptId.trim()) {
    issues.push({
      fieldId: `${input.idPrefix}-prompt`,
      label: "提示词",
      message: "选择该类目的提示词。",
    })
  }
  return issues
}

export function CardBindForm({
  idPrefix,
  name,
  tree,
  selection,
  stores,
  storeId,
  storeLocked = false,
  psdFileName,
  prompts,
  promptId,
  treeBusy,
  disabled = false,
  promptRefreshBusy = false,
  onNameChange,
  onStoreChange,
  onSelectL1,
  onSelectL2,
  onSelectType,
  onRefreshTree,
  onPickPsd,
  onClearPsd,
  onPromptChange,
  onRefreshPrompts,
  onSubmitSave,
  onOpenStores,
  extraFields,
}: {
  idPrefix: string
  name: string
  tree: CategoryTreeNodeView[]
  selection: CategoryTreeSelection
  stores: OzonStoreView[]
  storeId: string
  storeLocked?: boolean
  psdFileName: string
  prompts: WorkflowCategoryPrompt[]
  promptId: string
  treeBusy?: boolean
  disabled?: boolean
  promptRefreshBusy?: boolean
  onNameChange: (value: string) => void
  onStoreChange: (value: string) => void
  onSelectL1: (l1Id: number) => void
  onSelectL2: (l2Id: number) => void
  onSelectType: (descriptionCategoryId: number, typeId: number) => void
  onRefreshTree: () => void
  onPickPsd: () => void
  /** Present when this Surface may hand the template back to the supplier. */
  onClearPsd?: () => void
  onPromptChange: (promptId: string) => void
  onRefreshPrompts?: () => void
  onSubmitSave?: () => void
  onOpenStores?: () => void
  extraFields?: ReactNode
}) {
  const hasPsd = Boolean(psdFileName.trim())
  const ready = typeReady(selection)
  const promptPlaceholder = !ready
    ? "先选择类目"
    : prompts.length
      ? "选择本类目提示词"
      : "该类目暂无提示词"
  const credentialIssue = composeSellerCredentialIssue(storeId, stores)
  const [submitIssues, setSubmitIssues] = useState<BindFormIssue[]>([])

  useEffect(() => {
    if (ready && !promptId && prompts.length === 1) {
      onPromptChange(prompts[0].prompt_id)
    }
  }, [ready, promptId, prompts, onPromptChange])

  const fieldInvalid = (fieldId: string) =>
    submitIssues.some((item) => item.fieldId === fieldId)

  const psdDrop = useFileDropTarget<HTMLButtonElement>({
    disabled,
    onEmptyDrop: onPickPsd,
  })

  const selectedStoreIds = parseStoreIds(storeId)

  return (
    <form
      id={`${idPrefix}-form`}
      className="grid gap-0"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        const issues = bindFormIssues({
          idPrefix,
          name,
          descriptionCategoryId: selection.descriptionCategoryId,
          typeId: selection.typeId,
          promptId,
        })
        setSubmitIssues(issues)
        if (issues.length) {
          notifyError("无法保存，请补全下列项：", {
            description: issues
              .map((issue) => `${issue.label}：${issue.message}`)
              .join("；"),
          })
          document.getElementById(issues[0].fieldId)?.focus()
          return
        }
        onSubmitSave?.()
      }}
    >
      <FieldGroup className="gap-3.5">
        <Field data-invalid={fieldInvalid(`${idPrefix}-name`) || undefined}>
          <FieldLabel htmlFor={`${idPrefix}-name`}>名称</FieldLabel>
          <Input
            id={`${idPrefix}-name`}
            value={name}
            maxLength={160}
            disabled={disabled}
            placeholder="例如：夏季 T 恤"
            aria-invalid={fieldInvalid(`${idPrefix}-name`) || undefined}
            onChange={(event) => onNameChange(event.target.value)}
          />
        </Field>

        <Field data-invalid={fieldInvalid(`${idPrefix}-category-search`) || undefined}>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel htmlFor={`${idPrefix}-category-search`}>类目</FieldLabel>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              disabled={disabled || treeBusy || Boolean(credentialIssue)}
              aria-label="重新拉取类目"
              onClick={onRefreshTree}
            >
              <RefreshCw aria-hidden className={cn(treeBusy && "animate-spin")} />
              重新拉取
            </Button>
          </div>
          {credentialIssue ? (
            <Alert variant="destructive" role="status">
              <AlertTitle>{credentialIssue.title}</AlertTitle>
              <AlertDescription>{credentialIssue.description}</AlertDescription>
              {onOpenStores ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="mt-2 w-fit"
                  onClick={onOpenStores}
                >
                  {credentialIssue.actionLabel}
                </Button>
              ) : null}
            </Alert>
          ) : !treeBusy && tree.length === 0 ? (
            <p className="text-xs text-muted-foreground">类目尚未就绪；可点上方「重新拉取」。</p>
          ) : null}
          <CategoryTripleSelect
            id={`${idPrefix}-category`}
            tree={tree}
            selection={selection}
            disabled={disabled || (Boolean(credentialIssue) && tree.length === 0)}
            loading={Boolean(treeBusy) && tree.length === 0}
            invalid={fieldInvalid(`${idPrefix}-category-search`)}
            onSelectL1={onSelectL1}
            onSelectL2={onSelectL2}
            onSelectType={onSelectType}
          />
        </Field>

        <Field data-invalid={fieldInvalid(`${idPrefix}-prompt`) || undefined}>
          <div className="flex items-center gap-1.5">
            <FieldLabel htmlFor={`${idPrefix}-prompt`}>提示词</FieldLabel>
            {onRefreshPrompts ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground"
                      disabled={disabled || !ready || promptRefreshBusy}
                      onClick={onRefreshPrompts}
                      aria-label="刷新提示词"
                    />
                  }
                >
                  <RotateCw
                    aria-hidden
                    className={cn(promptRefreshBusy && "animate-spin")}
                  />
                </TooltipTrigger>
                <TooltipContent>刷新</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <Select
            value={ready && promptId ? promptId : null}
            disabled={disabled || !ready}
            onValueChange={(next) => {
              if (next) onPromptChange(next)
            }}
          >
            <SelectTrigger
              id={`${idPrefix}-prompt`}
              aria-invalid={fieldInvalid(`${idPrefix}-prompt`) || undefined}
              className={cn("w-full transition-colors", ready && "border-border-strong")}
            >
              <SelectValue placeholder={promptPlaceholder}>
                {() => {
                  if (!ready) return promptPlaceholder
                  const hit = prompts.find((prompt) => prompt.prompt_id === promptId)
                  return hit?.name ?? promptPlaceholder
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {prompts.length === 0 ? (
                <SelectItem value="__empty" disabled>
                  {ready ? "该类目暂无提示词" : "先选择类目"}
                </SelectItem>
              ) : (
                prompts.map((prompt) => (
                  <SelectItem key={prompt.prompt_id} value={prompt.prompt_id}>
                    {prompt.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor={`${idPrefix}-store`}>
            店铺
            <span className="ml-1 font-normal text-muted-foreground">可选 · 发送前绑定</span>
          </FieldLabel>
          <div id={`${idPrefix}-store`}>
            <StoreMultiSelect
              stores={stores}
              selectedStoreIds={selectedStoreIds}
              disabled={disabled || storeLocked}
              onChange={(nextIds) => onStoreChange(formatStoreIds(nextIds))}
            />
          </div>
        </Field>

        <Field>
          <FieldLabel htmlFor={`${idPrefix}-psd`}>
            PSD
            <span className="ml-1 font-normal text-muted-foreground">
              可选 · 切片前绑定
            </span>
          </FieldLabel>
          <div className="flex items-center gap-2">
          <button
            ref={psdDrop.ref}
            id={`${idPrefix}-psd`}
            type="button"
            disabled={disabled}
            {...psdDrop.dropProps}
            onClick={onPickPsd}
            className={cn(
              "flex min-h-11 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg border px-3 py-2 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              psdDrop.dragging
                ? "border-dashed border-brand bg-brand-soft ring-2 ring-brand/25"
                : hasPsd
                  ? "border-border bg-card hover:border-border-strong"
                  : "border-dashed border-border-strong bg-card hover:border-brand/50",
              disabled && "pointer-events-none opacity-60",
            )}
          >
            <span
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-md border",
                psdDrop.dragging
                  ? "border-transparent bg-brand text-brand-foreground"
                  : "border-border/80 bg-muted text-muted-foreground",
              )}
            >
              {hasPsd && !psdDrop.dragging ? (
                <FileImage className="size-3.5" />
              ) : (
                <Upload className="size-3.5" />
              )}
            </span>
            <span className="min-w-0 flex-1 overflow-hidden">
              <span
                className={cn(
                  "block truncate text-compact font-medium",
                  psdDrop.dragging ? "text-brand-ink" : "text-foreground",
                )}
                title={hasPsd && !psdDrop.dragging ? psdFileName : undefined}
              >
                {psdDrop.dragging ? "松开放入" : hasPsd ? psdFileName : "拖入或选择 PSD"}
              </span>
            </span>
          </button>
          {hasPsd && onClearPsd ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="清除 PSD 绑定"
              disabled={disabled}
              onClick={onClearPsd}
            >
              <X aria-hidden />
            </Button>
          ) : null}
          </div>
        </Field>
        {extraFields}
      </FieldGroup>
    </form>
  )
}

export function canSaveBind(input: {
  name: string
  descriptionCategoryId: number
  typeId: number
  promptId: string
}): boolean {
  return bindFormIssues({ idPrefix: "save", ...input }).length === 0
}
