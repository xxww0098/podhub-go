import type { ComponentType } from "react"
import {
  Ban,
  CircleArrowUp,
  CircleUserRound,
  ContactRound,
  Cloud,
  CreditCard,
  FolderTree,
  Globe,
  HardDrive,
  History,
  KeyRound,
  MonitorCog,
  Network,
  Receipt,
  ScrollText,
  Share2,
  Ticket,
  Users,
  UsersRound,
} from "lucide-react"

import type { SettingsSection } from "@/lib/settings-sections"

export type SettingsSectionIcon = ComponentType<{
  className?: string
  /** Matches the ARIA attribute's full domain (`Booleanish`). */
  "aria-hidden"?: boolean | "true" | "false"
}>

/**
 * One glyph per settings section, keyed by the section table's ids. The sheet's
 * rail and the `/admin` sidebar band both draw from here, so a section cannot
 * pick up two different marks; the record type fails to compile the moment a
 * section is added without one.
 */
export const SETTINGS_SECTION_ICONS: Record<
  SettingsSection,
  SettingsSectionIcon
> = {
  account: CircleUserRound,
  appearance: MonitorCog,
  storage: HardDrive,
  "workspace-storage": Cloud,
  changelog: History,
  mcp: Network,
  workspace: UsersRound,
  plans: CircleArrowUp,
  users: Users,
  "supplier-accounts": ContactRound,
  "ai-accounts": KeyRound,
  "system-storage": Cloud,
  payment: CreditCard,
  proxy: Globe,
  "banned-tags": Ban,
  categories: FolderTree,
  "redeem-codes": Ticket,
  agents: Share2,
  "admin-logs": ScrollText,
  "plan-orders": Receipt,
}
