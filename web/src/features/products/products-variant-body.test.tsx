/**
 * 预览/详情身体的渲染契约：旧型号 → 目标型号、真实规格值、缩略图，以及**两侧
 * 的整组成员**（留在原组的未选成员 + 目标组现有成员）。只列勾选的那几件就是
 * 这个测试要挡住的回归。同时钉住：拒绝码换中文、码不进页面、这里没有写入入口。
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"

import type { VariantPreviewData } from "@/bindings/http-product-variants"

import {
  VariantMemberTable,
  VariantPreviewBody,
  VariantPreviewPane,
  VariantSpecList,
} from "./products-variant-body"

const THUMB = "https://cdn.example.test/thumb-1.jpg"

function preview(over: Partial<VariantPreviewData> = {}): VariantPreviewData {
  return {
    digest: "digest-1",
    action: "merge",
    storeId: "store-1",
    target: { modelId: "900", modelValue: "杯垫同款", existingMembers: 1 },
    products: [
      {
        productId: "101",
        offerId: "A-1",
        name: "杯垫 蓝",
        thumbnailUrl: THUMB,
        currentModelId: "11",
        targetModelId: "900",
        variantValues: [{ attributeId: "10096", label: "尺寸", value: "M" }],
      },
      {
        productId: "102",
        offerId: "A-2",
        name: "杯垫 红",
        currentModelId: "12",
        targetModelId: "900",
        variantValues: [
          { attributeId: "10096", label: "尺寸", value: "L" },
          { attributeId: "10097", label: "颜色", value: "蓝", dictionaryValueId: "7" },
        ],
      },
    ],
    sourceRemaining: [
      { productId: "109", offerId: "A-9", name: "杯垫 灰", currentModelId: "11" },
    ],
    targetExisting: [
      { productId: "107", offerId: "A-7", name: "杯垫 白", currentModelId: "900" },
    ],
    problems: [],
    ...over,
  }
}

test("预览列出旧/新型号、真实规格值、缩略图，以及两侧的整组成员", () => {
  const markup = renderToStaticMarkup(<VariantPreviewBody data={preview()} />)
  // 目标同款与它在 Ozon 的型号身份。
  assert.match(markup, /杯垫同款/)
  assert.match(markup, /900/)
  assert.match(markup, /目标组现有成员/)
  assert.match(markup, /1 件/)
  // 旧型号 → 目标型号，逐行写清楚。
  for (const model of ["11", "12", "900"]) assert.match(markup, new RegExp(model))
  // 真实规格值：尺寸 / 颜色。
  assert.match(markup, /尺寸/)
  assert.match(markup, />M</)
  assert.match(markup, /尺寸/)
  assert.match(markup, /颜色/)
  assert.match(markup, /蓝/)
  // 缩略图真的渲染出来（不是只写文件名）。
  assert.match(markup, new RegExp(THUMB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(markup, /<img/)
  // 未选中的源组成员必须出现——弹窗展示的是整组，不是勾选的那几件。
  assert.match(markup, /A-9/)
  assert.match(markup, /留在原同款的成员/)
  assert.match(markup, /目标同款现有成员/)
  assert.match(markup, /A-7/)
  // 勾选的那几件也在。
  for (const offer of ["A-1", "A-2"]) assert.match(markup, new RegExp(offer))
})

test("空的一侧要说明为什么空，而不是看起来像没读到", () => {
  const fresh = renderToStaticMarkup(
    <VariantPreviewBody
      data={preview({ targetExisting: [], sourceRemaining: [], target: { modelId: "901", modelValue: "新同款", existingMembers: 0 } })}
    />,
  )
  assert.match(fresh, /目标同款是新建的，暂时没有既有成员/)
  assert.match(fresh, /原同款里没有被选中的其他成员/)
  assert.doesNotMatch(fresh, /0 件/)
})

test("读取中显示骨架与进度，失败只给重试入口，不写错误原文", () => {
  const loading = renderToStaticMarkup(
    <VariantPreviewPane state={{ phase: "loading" }} onRetry={() => {}} />,
  )
  assert.match(loading, /正在读取同款规格与成员/)
  assert.match(loading, /aria-label="正在读取同款规格"/)
  assert.doesNotMatch(loading, /role="alert"/)

  const failed = renderToStaticMarkup(
    <VariantPreviewPane state={{ phase: "failed" }} onRetry={() => {}} />,
  )
  assert.match(failed, /重新预览/)
  assert.doesNotMatch(failed, /role="alert"/)
})

test("规格值缺席读「—」，不补一个假的规格", () => {
  const missing = renderToStaticMarkup(<VariantSpecList values={null} />)
  assert.match(missing, /—/)
  const empty = renderToStaticMarkup(<VariantSpecList values={[]} />)
  assert.match(empty, /—/)
  const present = renderToStaticMarkup(
    <VariantSpecList values={[{ attributeId: "1", label: "尺寸", value: "XL" }]} />,
  )
  assert.match(present, /尺寸/)
  assert.match(present, /XL/)
})

test("拒绝码只以中文出现，原始码不进 DOM", () => {
  const markup = renderToStaticMarkup(
    <VariantPreviewBody data={preview({ problems: [{ code: "verify_first" }] })} />,
  )
  assert.match(markup, /镜像里没有这件商品/)
  assert.doesNotMatch(markup, /verify_first/)
  const unknown = renderToStaticMarkup(
    <VariantPreviewBody data={preview({ problems: [{ code: "internal_code_9" }] })} />,
  )
  assert.doesNotMatch(unknown, /internal_code_9/)
  assert.match(unknown, /服务端拒绝了这次预览/)
})

test("空成员表也能单独渲染并说明原因", () => {
  const markup = renderToStaticMarkup(
    <VariantMemberTable title="留在原同款的成员" members={[]} emptyText="没有其他成员" />,
  )
  assert.match(markup, /留在原同款的成员/)
  assert.match(markup, /没有其他成员/)
  assert.doesNotMatch(markup, /<table/)
})

test("身体模块没有任何写入入口", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./products-variant-body.tsx", import.meta.url)),
    "utf8",
  )
  assert.doesNotMatch(source, /productVariantsHttp/)
  assert.doesNotMatch(source, /operate\(/)
  assert.doesNotMatch(source, /useOperationIds/)
  assert.doesNotMatch(source, /ConfirmDialog/)
})
