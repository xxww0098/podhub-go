/** Browser-mounted suite: the coordinate scenario runs this through the same
 * real React DOM harness as web/tests/*.browser.tsx. No emulated DOM dependency. */
import { Profiler, type ProfilerOnRenderCallback } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { ListingCoreClient } from "@/listing-core/client"
import type { WbIssue } from "@/listing-core/wb-types"
import { memoryRowRepo } from "../rows/row-repo"
import { openCardRows } from "../rows/card-rows"
import { wbPublishProblem } from "../platforms/wb/publish-problem"
import { resolvePublishRemediation } from "../model/publish-remediation"
import { PublishRemediation } from "./publish-remediation"
import { wbCoordinateConfigFixture, wbMaterialFixture } from "../../../../tests/publish-pipeline-fixtures"

export const wbRemediationComponentTestNames = [
  "mounted reloaded WB second-only issue identifies variant two and characteristic",
  "mounted WB equal characteristic failures distinguish both ordered variants",
  "mounted WB material default issue names shared material without a variant",
  "mounted WB catalog unavailable names material even without variants",
  "mounted WB whole-group issue never fabricates a variant",
  "mounted WB named-field issue identifies the second variant",
  "mounted WB correction clears stale details and preserves not_enabled",
] as const
export type WbRemediationComponentResult = { name: typeof wbRemediationComponentTestNames[number]; status: "passed"; issues: WbIssue[] }
const check = (value: unknown, message: string): void => { if (!value) throw new Error(message) }
const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

/** Actual native previews → the existing CardRows store → close/reopen →
 * canonical normalization → mounted production details and native summary clicks. */
export async function runWbRemediationComponentTests(
  core: Pick<ListingCoreClient, "loadWbMaterial" | "wbPreview" | "dropWbMaterial">,
  host: HTMLElement,
  onRender: ProfilerOnRenderCallback,
): Promise<WbRemediationComponentResult[]> {
  const root = createRoot(host), results: WbRemediationComponentResult[] = []
  const writer = async () => ({ writable: true, onChange: () => () => {}, release() {} })
  try {
    for (let index = 0; index < 6; index++) {
      const material = wbMaterialFixture()
      const sample = (["second-only", "both", "valid", "valid", "group", "variant"] as const)[index]!
      const config = wbCoordinateConfigFixture(sample)
      if (index === 2) material.defaults!.values["100"] = ["   "]
      if (index === 3) { material.catalog = null; material.defaults = null; config.variants = [] }
      const handle = await core.loadWbMaterial(material)
      const repo = memoryRowRepo(), scope = { workspaceUuid: "mounted-wb", cardId: `card-${index}` }
      const rows = await openCardRows(repo, scope, writer)
      let reopened: Awaited<ReturnType<typeof openCardRows>> | undefined
      try {
        rows.wb.create("mounted-group", config)
        const captured = rows.wb.get("mounted-group")!
        const preview = await core.wbPreview(handle, captured.config)
        check(preview.group === null && preview.uploadBytes === null && preview.issues.length > 0, "native refusal must retain its issues")
        check(rows.wb.settle(captured.id, captured.rev, preview), "current native preview must settle")
        await rows.flush(); await rows.close()
        reopened = await openCardRows(repo, scope, writer)
        const record = reopened.wb.get(captured.id)!
        check(JSON.stringify(record.preview) === JSON.stringify(preview), "reload must retain complete native coordinates")
        const problems = record.preview!.issues.map((issue) => wbPublishProblem(issue, { recordId: record.id, variantCount: record.config.variants.length }))
        flushSync(() => root.render(<Profiler id="wb-remediation-components" onRender={onRender}>
          <div key={index}>{problems.map((problem, issueIndex) => <PublishRemediation key={issueIndex}
            remediation={resolvePublishRemediation(problem)!} onRepairBrand={() => { throw new Error("WB cannot acquire a brand repair") }} />)}</div>
        </Profiler>))
        await paint()
        const details = [...host.querySelectorAll<HTMLDetailsElement>('[data-slot="publish-remediation"]')]
        check(details.length === preview.issues.length, "each native issue must have its own production detail")
        for (const [issueIndex, detail] of details.entries()) {
          check(!detail.open, "new details start collapsed")
          detail.querySelector<HTMLElement>("summary")!.click()
          check(detail.open, "the native summary gesture expands the real component")
          const scopeText = detail.querySelectorAll("dd")[1]!.textContent!
          const steps = detail.querySelector("ol")!.textContent!
          const issue = preview.issues[issueIndex]!
          check(scopeText.includes("商品组 mounted-group") && !scopeText.includes("仅此商品行"), "scope must name the persisted group")
          if (issue.scope === "variant") {
            check(issue.variantIndex !== null && scopeText.includes(`第 ${issue.variantIndex + 1} 个变体`), "native variant position must be visible")
            check(steps.includes(`第 ${issue.variantIndex! + 1} 个变体`), "steps must target the same variant")
          } else check(!/第 \d+ 个变体/.test(scopeText), "inapplicable indices must not become variant one")
          if (issue.characteristicId !== null) check(scopeText.includes(`characteristic ${issue.characteristicId}`), "native characteristic must be visible")
          check(!detail.querySelector("button"), "field guidance never grants a repair, release or send action")
        }
        if (index === 0) {
          check(preview.issues.length === 1 && preview.issues[0]!.variantIndex === 1, "only the second variant must fail")
          check(!details[0]!.textContent!.includes("第 1 个变体"), "the first variant must not be blamed")
        }
        if (index === 1) {
          check(preview.issues.length === 2 && preview.issues[0]!.variantIndex === 0 && preview.issues[1]!.variantIndex === 1, "both original indices survive")
          check(details[0]!.querySelectorAll("dd")[1]!.textContent !== details[1]!.querySelectorAll("dd")[1]!.textContent, "same characteristic failures remain distinguishable")
        }
        if (index === 2 || index === 3) check(details[0]!.querySelectorAll("dd")[1]!.textContent!.includes("所用 WB 类目材料"), "material affects shared material")
        if (index === 4) check(details[0]!.querySelectorAll("dd")[1]!.textContent!.includes("整组"), "group scope must stay whole-group")
        if (index === 5) check(details[0]!.querySelectorAll("dd")[1]!.textContent!.includes("货号 vendorCode"), "named fields retain the native variant")
        check(!host.querySelector('[role="alert"]'), "no transient raw error block")
        results.push({ name: wbRemediationComponentTestNames[index]!, status: "passed", issues: structuredClone(preview.issues) })
        if (index === 5) {
          const corrected = wbCoordinateConfigFixture("valid")
          check(reopened.wb.edit(record.id, record.rev, corrected), "correction must use the existing CAS editor")
          const edited = reopened.wb.get(record.id)!
          check(edited.preview === undefined, "editing clears the old preview")
          const recovered = await core.wbPreview(handle, edited.config)
          check(recovered.issues.length === 0 && recovered.group?.variants.length === 2 && !!recovered.uploadBytes?.length, "native correction must generate a real preview")
          check(reopened.wb.settle(edited.id, edited.rev, recovered), "corrected native preview must settle")
          await reopened.flush()
          const notEnabled = resolvePublishRemediation({ platform: "wb", stage: "submit", family: "control", code: "not_enabled" })!
          flushSync(() => root.render(<Profiler id="wb-remediation-components" onRender={onRender}>
            <PublishRemediation remediation={notEnabled} />
          </Profiler>))
          await paint()
          const disabledDetails = host.querySelector<HTMLDetailsElement>("details")!
          disabledDetails.querySelector<HTMLElement>("summary")!.click()
          check(disabledDetails.open && host.textContent!.includes("WB 真实发送尚未启用"), "the real disabled solution stays visible")
          check(!host.textContent!.includes("第 2 个变体") && !host.querySelector("button"), "correction removes stale targeting without enabling send")
          results.push({ name: wbRemediationComponentTestNames[6], status: "passed", issues: [] })
        }
      } finally { await reopened?.close(); await rows.close(); await core.dropWbMaterial(handle) }
    }
    return results
  } finally { flushSync(() => root.unmount()) }
}
