import { ImagePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { MAX_SOURCE_BATCH } from "../source-batch"

/** The drop target an empty card shows: import entry points and the three-step guide. */
export function WorkbenchEmptyState({
  disabled,
  onImportImages,
}: {
  /** Card-wide work, the send queue or a running preparation step holds the card. */
  disabled: boolean
  onImportImages: () => void
}) {
  return (
    <Empty
      role="region"
      aria-label="拖拽导入图片区域"
      className="min-h-[420px] flex-1 justify-center border-dashed border-border/80 bg-card/50 p-8 md:p-12 transition-all duration-200 hover:border-brand/40 hover:bg-card/80"
    >
      <EmptyHeader className="max-w-lg">
        <EmptyMedia
          variant="icon"
          className="mb-3 flex size-14 items-center justify-center rounded-2xl bg-brand/10 text-brand ring-1 ring-brand/20 shadow-xs transition-transform duration-200 hover:scale-105"
        >
          <ImagePlus className="size-7" />
        </EmptyMedia>
        <EmptyTitle className="text-base font-semibold text-foreground tracking-tight">
          拖入图片，每张建一行
        </EmptyTitle>
        <EmptyDescription className="max-w-md text-xs leading-relaxed text-muted-foreground">
          一张卡最多 {MAX_SOURCE_BATCH} 行。导入只建行，准备才会识别、切片并上传。
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-2xl">
        <div className="flex flex-col items-center gap-3">
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            <Button
              type="button"
              variant="brand"
              size="default"
              className="px-5 font-medium shadow-xs"
              disabled={disabled}
              onClick={onImportImages}
            >
              <ImagePlus aria-hidden className="size-4" />
              导入图片
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1.5 text-meta text-muted-foreground">
            <span className="text-muted-foreground/80">支持格式：</span>
            <span className="rounded border border-border/80 bg-muted/40 px-1.5 py-0.5 font-mono text-meta text-foreground/80">
              JPG / PNG
            </span>
            <span className="text-muted-foreground/60">· 拖入文件夹可导入一层</span>
          </div>
        </div>

        <div className="mt-7 w-full border-t border-border/60 pt-5">
          <p className="mb-3 text-center text-meta font-medium text-muted-foreground">
            批量上架流程向导
          </p>
          <div className="grid grid-cols-1 gap-2.5 text-left sm:grid-cols-3">
            <div className="flex flex-col gap-1 rounded-xl border border-border/70 bg-muted/20 p-3 transition-colors hover:border-brand/30 hover:bg-muted/40">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-brand/15 font-mono text-meta font-bold text-brand">
                  1
                </span>
                <span>导入图片</span>
              </div>
              <p className="text-meta leading-4 text-muted-foreground">
                拖入或选择图片，快速建立商品草稿行
              </p>
            </div>
            <div className="flex flex-col gap-1 rounded-xl border border-border/70 bg-muted/20 p-3 transition-colors hover:border-brand/30 hover:bg-muted/40">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-muted-foreground/15 font-mono text-meta font-bold text-muted-foreground">
                  2
                </span>
                <span>一键准备</span>
              </div>
              <p className="text-meta leading-4 text-muted-foreground">
                类目与默认字段随上架方案自动带出，并行跑 AI 文案、切图与上传
              </p>
            </div>
            <div className="flex flex-col gap-1 rounded-xl border border-border/70 bg-muted/20 p-3 transition-colors hover:border-brand/30 hover:bg-muted/40">
              <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-muted-foreground/15 font-mono text-meta font-bold text-muted-foreground">
                  3
                </span>
                <span>发送上架</span>
              </div>
              <p className="text-meta leading-4 text-muted-foreground">
                一键推送至店铺，稍后可批量同步库存
              </p>
            </div>
          </div>
        </div>
      </EmptyContent>
    </Empty>
  )
}
