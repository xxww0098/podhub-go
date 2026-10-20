import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { ProductThumb } from "@/features/products/product-thumb"
import { ThumbPreview } from "./thumb-preview"

test("product and file thumbs reserve their box", () => {
  const product = renderToStaticMarkup(
    <ProductThumb src="https://example.invalid/cup.jpg" name="杯子" />,
  )
  assert.match(product, /width="36"/)
  assert.match(product, /height="36"/)
  assert.match(product, /loading="lazy"/)
  assert.match(product, /decoding="async"/)

  const file = renderToStaticMarkup(
    <ThumbPreview src="https://example.invalid/tee.jpg" alt="tee.psd" />,
  )
  assert.match(file, /width="48"/)
  assert.match(file, /height="48"/)
  assert.match(file, /loading="lazy"/)

  const tray = readFileSync(
    new URL("../../supply-chain/gallery/listing-queue-tray.tsx", import.meta.url),
    "utf8",
  )
  assert.match(tray, /width=\{44\}/)
  assert.match(tray, /height=\{44\}/)
  assert.match(tray, /loading="lazy"/)
})

test("the runner stays off the listing library chunk", () => {
  const source = readFileSync(new URL("../workflow-screen.tsx", import.meta.url), "utf8")
  assert.match(source, /lazy\(\(\) =>\s*import\("\.\/card-runner"\)/)
  assert.doesNotMatch(source, /import \{ CardRunner \} from "\.\/card-runner"/)
})
