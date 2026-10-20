/**
 * 「同款规格」预览/详情的身体：旧型号 → 目标型号、真实规格值、缩略图，以及两侧
 * 的完整成员——留在原组的未选成员、已在目标组的成员。绝不只列勾选的那几件，
 * 也绝不只列件数：组里还有谁，操作员必须看得见。
 *
 * 这里是纯展示：没有任何写入入口（写入在 products-variant-dialog.tsx），
 * 平台观察面复用它也不会因此获得写入能力。
 */
import { ImageOff, TriangleAlert } from "lucide-react"

import type {
  VariantAttributeValue,
  VariantMemberFacts,
  VariantPreviewData,
  VariantProblem,
} from "@/bindings/http-product-variants"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import { ProductThumb } from "./product-thumb"
import { variantProblemCopy } from "./products-variant-model"
import type { VariantPreviewState } from "./products-variant-preview"

/** 真实规格值（尺寸 / 颜色…）。没有读到就是未知，不写「无」。 */
export function VariantSpecList({ values }: { values?: VariantAttributeValue[] | null }) {
  if (!values || values.length === 0) {
    return (
      <span className="text-muted-foreground" title="镜像还没读到这件商品的规格属性">
        —
      </span>
    )
  }
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {values.map((value) => (
        <span key={`${value.attributeId}:${value.dictionaryValueId ?? value.value}`}>
          {value.label ? <span className="text-muted-foreground">{value.label} </span> : null}
          {value.value}
        </span>
      ))}
    </span>
  )
}

/** 某一侧的成员一件：缩略图、货号、名称、型号、规格值。 */
export function VariantMemberCell({ member }: { member: VariantMemberFacts }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {member.thumbnailUrl ? (
        <ProductThumb src={member.thumbnailUrl} name={member.name} />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border/60 bg-muted/60 text-muted-foreground">
          <ImageOff className="size-4" aria-hidden />
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-xs" title={member.offerId}>
          {member.offerId}
        </span>
        <span className="truncate text-xs text-muted-foreground" title={member.name ?? undefined}>
          {member.name ?? "未命名商品"}
        </span>
      </span>
    </span>
  )
}

/** 旧型号 → 目标型号。拆出时每件各得一个新号，所以这一列按行算。 */
export function VariantModelCell({
  member,
  revealTarget,
}: {
  member: VariantMemberFacts
  revealTarget: boolean
}) {
  const current = member.currentModelId ?? null
  const target = member.targetModelId ?? null
  if (!revealTarget) {
    return (
      <span className="font-mono text-xs" title="Ozon 当前型号">
        {current ?? "—"}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 font-mono text-xs">
      <span className="text-muted-foreground">{current ?? "—"}</span>
      <span aria-hidden className="text-muted-foreground">
        →
      </span>
      <span title="本次操作后的型号">{target ?? "—"}</span>
    </span>
  )
}

/**
 * 一侧成员表。空也要画出来并说明「为什么空」：目标组是新建的、还是原组
 * 里没有未选成员，是两件事。
 */
export function VariantMemberTable({
  title,
  note,
  members,
  revealTarget = false,
  emptyText,
}: {
  title: string
  note?: string
  members: readonly VariantMemberFacts[]
  revealTarget?: boolean
  emptyText: string
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h3 className="text-compact font-medium">{title}</h3>
        {note ? <span className="text-meta text-muted-foreground">{note}</span> : null}
      </div>
      {members.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="rounded-lg border border-border">
          <Table containerClassName="max-h-64 overflow-y-auto">
            <TableHeader className="sticky top-0 z-10 bg-popover">
              <TableRow>
                <TableHead>商品</TableHead>
                <TableHead className="w-40">{revealTarget ? "型号 旧 → 新" : "型号"}</TableHead>
                <TableHead className="w-40">规格</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={`${member.productId}:${member.offerId}`}>
                  <TableCell>
                    <VariantMemberCell member={member} />
                  </TableCell>
                  <TableCell>
                    <VariantModelCell member={member} revealTarget={revealTarget} />
                  </TableCell>
                  <TableCell>
                    <VariantSpecList values={member.variantValues} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

/** 预览拒绝：稳定码换成中文，未知码回退到通用文案——码本身不进页面。 */
export function VariantProblems({ problems }: { problems: readonly VariantProblem[] }) {
  if (problems.length === 0) return null
  return (
    <ul className="flex flex-col gap-1 rounded-lg border border-st-bad/40 bg-st-bad-soft p-2 text-xs text-st-bad-ink">
      {problems.map((problem, index) => (
        <li
          key={`${problem.code}:${problem.productId ?? ""}:${problem.attributeId ?? ""}:${index}`}
          className="flex items-start gap-1.5"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{variantProblemCopy(problem)}</span>
        </li>
      ))}
    </ul>
  )
}

/** 目标同款的头：型号名、型号 ID、已在组内的件数。 */
export function VariantTargetSummary({ data }: { data: VariantPreviewData }) {
  const existing = Number.isFinite(data.target.existingMembers) ? data.target.existingMembers : null
  return (
    <dl className="flex flex-col gap-0.5 text-compact">
      <div className="flex gap-2">
        <dt className="text-muted-foreground">目标同款</dt>
        <dd className="font-medium">{data.target.modelValue || "未命名型号"}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-muted-foreground">目标型号 ID</dt>
        <dd className="font-mono text-xs">{data.target.modelId || "—"}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-muted-foreground">目标组现有成员</dt>
        {/* 0 是服务端说的事实（目标组还没成员），不是读不到；读不到写「未知」。 */}
        <dd>{existing === null ? "未知" : existing === 0 ? "暂无成员" : `${existing} 件`}</dd>
      </div>
    </dl>
  )
}

function countNote(members: readonly VariantMemberFacts[]): string | undefined {
  return members.length > 0 ? `${members.length} 件` : undefined
}

/** 预览 + 两侧成员的完整身体。 */
export function VariantPreviewBody({ data }: { data: VariantPreviewData }) {
  return (
    <div className="flex flex-col gap-3">
      <VariantTargetSummary data={data} />
      <VariantProblems problems={data.problems} />
      {/* 件数只在真有成员时写：空表旁边挂一个「0 件」既冗余，又像在读数字。 */}
      <VariantMemberTable
        title="本次要改的商品"
        note={countNote(data.products)}
        members={data.products}
        revealTarget
        emptyText="这次没有要改的商品。"
      />
      <VariantMemberTable
        title="留在原同款的成员"
        note={countNote(data.sourceRemaining)}
        members={data.sourceRemaining}
        emptyText="原同款里没有被选中的其他成员。"
      />
      <VariantMemberTable
        title="目标同款现有成员"
        note={countNote(data.targetExisting)}
        members={data.targetExisting}
        emptyText="目标同款是新建的，暂时没有既有成员。"
      />
    </div>
  )
}

/** 读取中的骨架与失败后的重试入口（页面不写错误原文）。 */
export function VariantPreviewPane({
  state,
  onRetry,
}: {
  state: VariantPreviewState
  onRetry: () => void
}) {
  if (state.phase === "ready") return <VariantPreviewBody data={state.data} />
  if (state.phase === "failed") {
    return (
      <div className="flex flex-col items-center gap-2 py-6">
        <TriangleAlert className="size-5 text-muted-foreground" aria-hidden />
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          重新预览
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 py-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" aria-label="正在读取同款规格" />
        正在读取同款规格与成员…
      </div>
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-8" />
      ))}
    </div>
  )
}
