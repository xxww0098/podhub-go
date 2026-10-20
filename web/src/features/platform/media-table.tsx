import { Activity, CloudUpload, Play, Plus, SquarePen, Trash2 } from "lucide-react"
import type { MediaAccountView } from "@/bindings/commands"
import { IdentityTile } from "@/components/identity-tile"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function MediaTable({
  rows,
  busy,
  testingId,
  testLatencies,
  icon = CloudUpload,
  emptyMessage = "还没有对象存储账号。",
  singleNoun = "商库素材存储",
  testUnavailableHint,
  onAdd,
  onActivate,
  onTest,
  onEdit,
  onRemove,
}: {
  rows: MediaAccountView[]
  busy: boolean
  testingId?: string
  testLatencies?: Record<string, number>
  icon?: typeof CloudUpload
  emptyMessage?: string
  /** 单桶模式（无 onActivate）下用于测试/删除文案的名词。 */
  singleNoun?: string
  /** onTest 缺席时已配置行的测试按钮说明（如该桶无在线测试路由）。 */
  testUnavailableHint?: string
  onAdd?: () => void
  onActivate?: (id: string) => void
  onTest?: (id: string) => void
  onEdit: (row: MediaAccountView) => void
  onRemove: (id: string) => void
}) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-center text-muted-foreground">
        <p className="text-sm">{emptyMessage}</p>
        {onAdd ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="cursor-pointer"
            onClick={onAdd}
          >
            <Plus data-icon="inline-start" />
            配置存储桶
          </Button>
        ) : null}
      </div>
    )
  }
  const isSingle = !onActivate
  const editLabel = isSingle ? "重新配置" : "配置 S3 账号"
  const deleteLabel = isSingle ? "移除存储桶" : "删除 S3 账号"

  return (
    <Table className="min-w-3xl">
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead>空间</TableHead>
          <TableHead className="w-40">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const isSingleActive = isSingle || row.active
          const activateTip = !row.configured
            ? "先配置密钥"
            : isSingle
              ? "当前存储"
              : row.active
                ? "当前账号"
                : "设为当前 S3"
          const activateAriaLabel = isSingle
            ? "当前存储"
            : row.active
              ? "当前 S3"
              : "设为当前 S3"
          const deleteTip = isSingle
            ? `移除${singleNoun}桶`
            : "删除 S3 账号"
          const testTip = testingId === row.id
            ? "正在测试"
            : !row.configured
              ? "先配置密钥"
              : onTest
                ? "测试连接"
                : (testUnavailableHint ?? "测试连接")
          const testAriaLabel = testingId === row.id
            ? isSingle
              ? `正在测试${singleNoun}`
              : "正在测试对象存储"
            : isSingle
              ? `测试${singleNoun}`
              : "测试对象存储"

          return (
            <TableRow key={row.id}>
              <TableCell>
                <span className="flex items-center gap-2 text-sm font-medium">
                  <IdentityTile icon={icon} tone={row.configured ? "good" : "idle"} />
                  {row.label}
                  {row.active || isSingle ? (
                    <StateChip status="present" label="当前" />
                  ) : row.configured ? (
                    <StateChip status="no" label="备用" />
                  ) : null}
                </span>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono text-sm">{row.bucket || "—"}</span>
                  {row.endpoint ? (
                    <span
                      className="truncate font-mono text-xs text-muted-foreground max-w-sm"
                      title={row.endpoint}
                    >
                      {row.endpoint}
                    </span>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-nowrap gap-1.5">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-sm"
                          variant={isSingleActive ? "secondary" : "brand"}
                          aria-label={activateAriaLabel}
                          disabled={busy || isSingleActive || !row.configured}
                          focusableWhenDisabled
                          onClick={() => onActivate?.(row.id)}
                        />
                      }
                    >
                      <Play aria-hidden />
                    </TooltipTrigger>
                    <TooltipContent>{activateTip}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="outline"
                          aria-label={testAriaLabel}
                          disabled={busy || !row.configured || !onTest}
                          onClick={() => onTest?.(row.id)}
                        />
                      }
                    >
                      {testingId === row.id ? <Spinner aria-hidden /> : <Activity aria-hidden />}
                    </TooltipTrigger>
                    <TooltipContent>
                      {testTip}
                      {testLatencies?.[row.id] !== undefined ? ` · ${testLatencies[row.id]} ms` : ""}
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="outline"
                          aria-label={editLabel}
                          disabled={busy}
                          onClick={() => onEdit(row)}
                        />
                      }
                    >
                      <SquarePen aria-hidden />
                    </TooltipTrigger>
                    <TooltipContent>{editLabel}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          aria-label={deleteLabel}
                          disabled={busy}
                          onClick={() => onRemove(row.id)}
                        />
                      }
                    >
                      <Trash2 aria-hidden />
                    </TooltipTrigger>
                    <TooltipContent>{deleteTip}</TooltipContent>
                  </Tooltip>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

