import { ImagePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { MAX_SOURCE_BATCH } from "../source-batch"

/** The empty card keeps its import action and input limits close together. */
export function WorkbenchEmptyState({
  disabled,
  onImportImages,
}: {
  /** Card-wide work, the send queue or a running preparation step holds the card. */
  disabled: boolean
  onImportImages: () => void
}) {
  return (
    <section
      role="region"
      aria-label="拖拽导入图片区域"
      className="flex min-h-40 min-w-0 flex-1 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border bg-card/40 p-3 text-center md:p-4"
    >
      <EmptyHeader className="max-w-lg">
        <EmptyMedia variant="icon">
          <ImagePlus aria-hidden />
        </EmptyMedia>
        <EmptyTitle>
          拖入图片，每张建一行
        </EmptyTitle>
        <EmptyDescription className="max-w-md">
          一张卡最多 {MAX_SOURCE_BATCH} 行。导入只建行，准备才会识别、切片并上传。
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-2xl">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="brand"
            size="sm"
            disabled={disabled}
            onClick={onImportImages}
          >
            <ImagePlus aria-hidden className="size-4" />
            导入图片
          </Button>
          <div className="flex flex-wrap items-center justify-center gap-1.5 text-meta text-muted-foreground">
            <span className="text-muted-foreground/80">支持格式：</span>
            <span className="rounded border border-border/80 bg-muted/40 px-1.5 py-0.5 font-mono text-meta text-foreground/80">
              JPG / PNG
            </span>
            <span className="text-muted-foreground/60">· 拖入文件夹可导入一层</span>
          </div>
        </div>
      </EmptyContent>
    </section>
  )
}
