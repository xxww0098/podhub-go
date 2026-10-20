/** Host-side polling: Playwright's deferred waitForFunction uses page eval,
 * which the fixture's strict CSP rejects. Predicates remain read-only functions. */
import type { Page } from "playwright-core"
import type { PageFunction } from "playwright-core/types/structs"

export async function waitForPage<Arg>(
  page: Pick<Page, "evaluate">,
  predicate: Exclude<PageFunction<Arg, unknown>, string>,
  arg: Arg,
  // Match run-publish-pipeline-browser's page.setDefaultTimeout(15_000).
  { timeout = 15_000 }: { timeout?: number } = {},
): Promise<void> {
  if (typeof predicate !== "function") throw new TypeError("Browser evidence wait requires a function predicate")
  if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError("Browser evidence wait requires a finite positive timeout")
  const deadline = performance.now() + timeout
  await new Promise<void>((resolve, reject) => {
    let finished = false, pollTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (settle: () => void) => {
      if (finished) return
      finished = true
      clearTimeout(deadlineTimer)
      clearTimeout(pollTimer)
      settle()
    }
    const expire = () => finish(() => reject(new Error(`Browser evidence wait timed out after ${timeout}ms`)))
    const deadlineTimer = setTimeout(expire, timeout)
    const poll = async () => {
      if (finished) return
      if (performance.now() >= deadline) { expire(); return }
      try {
        const ready = await page.evaluate(predicate, arg)
        if (finished) return
        if (performance.now() >= deadline) { expire(); return }
        if (ready) finish(resolve)
        // Sequential reads, approximately the old default animation-frame cadence.
        else pollTimer = setTimeout(() => void poll(), 16)
      } catch (error) { finish(() => reject(error)) }
    }
    void poll()
  })
}
