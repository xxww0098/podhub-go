import assert from "node:assert/strict"
import test from "node:test"
import { cn } from "../../lib/utils"
import { buttonVariants } from "./button"

test("cn preserves text-primary-foreground when combined with text-compact and text-meta", () => {
  assert.equal(
    cn("bg-primary text-primary-foreground text-compact"),
    "bg-primary text-primary-foreground text-compact"
  )
  assert.equal(
    cn("bg-primary text-primary-foreground text-meta"),
    "bg-primary text-primary-foreground text-meta"
  )
  assert.equal(
    cn("bg-primary text-primary-foreground text-md"),
    "bg-primary text-primary-foreground text-md"
  )
})

test("cn correctly overrides font sizes without stripping text colors", () => {
  assert.equal(
    cn("text-sm text-compact"),
    "text-compact"
  )
  assert.equal(
    cn("text-compact text-md"),
    "text-md"
  )
  assert.equal(
    cn("text-md text-meta"),
    "text-meta"
  )
})

test("buttonVariants preserves contrast foreground text colors for all variants at size sm (text-compact)", () => {
  const defaultSm = buttonVariants({ variant: "default", size: "sm" })
  assert.match(defaultSm, /\bbg-primary\b/)
  assert.match(defaultSm, /\btext-primary-foreground\b/)
  assert.match(defaultSm, /\btext-compact\b/)

  const brandSm = buttonVariants({ variant: "brand", size: "sm" })
  assert.match(brandSm, /\bbg-brand\b/)
  assert.match(brandSm, /\btext-brand-foreground\b/)
  assert.match(brandSm, /\btext-compact\b/)

  const secondarySm = buttonVariants({ variant: "secondary", size: "sm" })
  assert.match(secondarySm, /\bbg-secondary\b/)
  assert.match(secondarySm, /\btext-secondary-foreground\b/)
  assert.match(secondarySm, /\btext-compact\b/)

  const ghostSm = buttonVariants({ variant: "ghost", size: "sm" })
  assert.match(ghostSm, /\btext-muted-foreground\b/)
  assert.match(ghostSm, /\btext-compact\b/)

  const destructiveSm = buttonVariants({ variant: "destructive", size: "sm" })
  assert.match(destructiveSm, /\btext-st-bad-ink\b/)
  assert.match(destructiveSm, /\btext-compact\b/)
})

test("buttonVariants preserves contrast foreground text colors at size lg (text-md)", () => {
  const defaultLg = buttonVariants({ variant: "default", size: "lg" })
  assert.match(defaultLg, /\bbg-primary\b/)
  assert.match(defaultLg, /\btext-primary-foreground\b/)
  assert.match(defaultLg, /\btext-md\b/)
})
