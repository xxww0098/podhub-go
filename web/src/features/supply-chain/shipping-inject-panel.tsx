/**
 * Seller 一键注入 panel (SHIP-04). Lives on 平台货盘 product → Target Store.
 * Cloud decides readiness; this panel only paints seller-safe copy.
 */
import { Button } from "@/components/ui/button"
import { StateChip } from "@/components/state-chip"
import { KeyValue, KeyValueGrid, Section } from "@/components/section"
import type { SellerShippingReadiness } from "@/bindings/http-supply-chain"

import {
  PLATFORM_LOGISTICS_TITLE,
  presentSellerInject,
} from "./shipping-inject-copy"

export type ShippingInjectPanelProps = {
  readiness: SellerShippingReadiness
  shopName: string
  busy?: boolean
  onEnsure?: () => void
}

export function ShippingInjectPanel({
  readiness,
  shopName,
  busy = false,
  onEnsure,
}: ShippingInjectPanelProps) {
  const view = presentSellerInject(readiness)
  const presetName = readiness.preset_display_name?.trim()

  return (
    <Section title={PLATFORM_LOGISTICS_TITLE} framed>
      <div
        data-shipping-inject=""
        data-shipping-inject-kind={view.kind}
        data-shipping-inject-action={view.action ?? ""}
        className="flex flex-col gap-3 p-4"
      >
        <KeyValueGrid>
          {presetName ? <KeyValue label="物流预设" value={presetName} /> : null}
          <KeyValue label="店铺" value={shopName} />
        </KeyValueGrid>
        <div className="flex flex-wrap items-center gap-2">
          <StateChip status={view.kind} label={view.statusText} tone={view.tone} />
          {view.action && view.actionLabel ? (
            <Button
              type="button"
              size="sm"
              className="cursor-pointer"
              disabled={busy}
              onClick={onEnsure}
            >
              {view.actionLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </Section>
  )
}
