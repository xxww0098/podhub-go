import type { AppScreen } from "@/lib/app-screens"

/**
 * Warm the data a screen paints, without pulling that screen into the shell
 * bundle. Schema reads stay out: a cold coordinate can ask Ozon to fill it.
 */
export function prefetchScreenData(screen: AppScreen): void {
  if (screen === "listing") {
    void import("@/features/category-schema/category-tree-load").then((mod) => {
      void mod.loadCategoryTree()
    })
    void import("@/features/workflow/listing-card-list-cache").then((mod) => {
      void mod.loadListingCardList()
    })
    return
  }
  if (screen === "catalog") {
    void import("@/features/category-schema/category-tree-load").then((mod) => {
      void mod.loadCategoryTree()
    })
  }
}
