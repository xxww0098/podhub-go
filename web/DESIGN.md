# DESIGN — public-site（Studio Canon）

Scope: `src/features/site/public-site.{tsx,css}` — the anonymous marketing pages
(product / catalog / pricing / help / privacy / terms). The signed-in workbench
keeps the LEDGER world from `src/index.css`; the two worlds do not share tokens.

## World

The high-end B2B SaaS canon, played straight (Linear / Stripe / Vercel class —
the user-pinned direction, standing preference recorded in PRODUCT.md). White
ground, cool slate neutrals, hairline borders, soft ambient depth, one brand
blue lifted from the mark (`#033fa7` → screen `#0b57d9`). Ink carries every
primary action; blue carries links, focus, selection and verified ticks only.
Corners round (8–18px); nothing is dashed, stamped, or perforated.

## Tokens (scoped under `.public-site`)

- `--paper/--card/--sheet #ffffff` grounds · `--muted #f4f5f7` recessed band
- `--ink #0b0e14` text and primary fills · `--muted-foreground #59616e` · `--faint #767f8d` small mono labels
- `--line #e7e9ee` hairlines · `--line-strong #d6dae1` rails and input borders
- `--accent #0b57d9` links/focus/ticks · `--accent-ink #0a4ab5` accent text · `--accent-soft/-line` tinted fills
- `--ok #14804a` + `--ok-soft` the single success pill (`.receipt-status`)
- `--shadow-card` hairline-level lift · `--shadow-pop` the hero receipt only
- `--mono` for codes, spec keys, counters, tabular numbers — never for prose

## Grammar

- **Receipt**: `.receipt` = the hero artifact — the product's own listing
  receipt (mono ID, route FROM→TO, verified items, four-station lifecycle rail
  with the last station `.on`). One authored motion: the three ticks pop in
  sequence, then the status pill lands (expo ease-out, reduced-motion safe).
- **Hairline sheets**: proof strip, plan cards, tiles, catalog cards are white
  sheets on `--line` borders with `--shadow-card`; dividers are 1px hairlines.
  The capabilities section breathes on a full-bleed `--muted` band
  (`box-shadow 0 0 0 100vmax` + clip-path).
- **One dark panel per page**: `.cta` (ink + accent radial glow, white button),
  one `.featured` plan card, one dark `.tile`, one dark `.routes` card — never
  more than one dark element per band.
- **Ticks**: drawn accent circle + `✓` for verified items (hero notes, receipt
  items, plan features, Cloud manifest).
- **Chips**: pill radii for facet filters, the legal date, plan price notes —
  pressed state = ink fill.

## Constraints

- Light only; no `prefers-color-scheme: dark` (pinned by test).
- Display type stays the project's Inter Variable at 740–800 for Latin +
  PingFang SC for CJK (established project font — documented exception to the
  overused-font detector warning); mono earns its place on codes and data only.
- `.public-site a { color: inherit }` outranks the buttonVariants text utility
  (0,1,1 > 0,1,0): ink-filled actions must declare `color` explicitly.
- Copy, page routing, and the login gate are product truth — redesign touched
  presentation only.
