/** Static panel bodies: read-only table, selectors, category recovery, price and property forms.
 * Portal interaction stays in the existing browser fixtures.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SupplierDbDetailView } from "./supplier-db-table"
import { AdjustPricePanel, CategoryPickerPanel, MultiSelectOptionsPanel, SelectOptionsPanel } from "./supplier-prop-editors"
import { PropEditorForm, propDraftFrom } from "./supplier-prop-dialog"
import { createSupplierDbsStore } from "./supplier-dbs-store"
import { TREE, db, row, propDef, clientWithDetail } from "./supplier-editing-fixtures"

test("商品表是只读摘要：无行内编辑器，行菜单与筛选触发器在", () => {
  const html = renderToStaticMarkup(
    <SupplierDbDetailView
      store={createSupplierDbsStore(
        clientWithDetail({
          db: db({ rowCount: 1 }),
          propDefs: [
            propDef({
              propId: "prop-sel",
              name: "材质",
              type: "select",
              options: [{ value: "cotton", label: "棉" }],
            }),
          ],
          rows: [
            row("p1", {
              title: "圣诞帽",
              platformCode: "P001",
              costCents: 800,
              suggestedRetailCents: 25000,
              props: { "prop-sel": "cotton" },
            }),
          ],
        }).client,
      )}
      detail={{
        db: db({ rowCount: 1 }),
        propDefs: [
          propDef({
            propId: "prop-sel",
            name: "材质",
            type: "select",
            options: [{ value: "cotton", label: "棉" }],
          }),
        ],
        rows: [
          row("p1", {
            title: "圣诞帽",
            platformCode: "P001",
            costCents: 800,
            suggestedRetailCents: 25000,
            props: { "prop-sel": "cotton" },
          }),
        ],
      }}
      onExit={() => {}}
      onEditDb={() => {}}
      onOpenAccounts={() => {}}
      loadCategoryTree={async () => TREE}
    />,
  )
  // 行内编辑整体移除——表格只剩只读摘要，编辑全在行面板。
  assert.doesNotMatch(html, /data-cell-display/)
  assert.doesNotMatch(html, /data-cell-editor/)
  assert.doesNotMatch(html, /data-column-menu/)
  assert.doesNotMatch(html, /data-sort-trigger/)
  // 行「更多」菜单触发器与打开缝仍在（菜单体是 portal，SSR 不出）。
  assert.match(html, /aria-label="行操作 圣诞帽"/)
  assert.match(html, /data-supplier-db-open="p1"/)
  // 搜索框带 `/` 快捷键提示；勾选后才显示批量操作条。
  assert.match(html, /aria-label="搜索商品"/)
  assert.doesNotMatch(html, /data-bulk-bar=/)
  assert.doesNotMatch(html, /role="alert"/)
})


test("SelectOptionsPanel 内联体：选项列表 + 搜索 + 清除 + 新建入口", () => {
  const html = renderToStaticMarkup(
    <SelectOptionsPanel
      options={[
        { value: "cotton", label: "棉" },
        { value: "poly", label: "涤纶" },
      ]}
      value="cotton"
      onPick={() => {}}
      onCreateOption={async () => null}
    />,
  )
  assert.match(html, /role="listbox"/)
  assert.match(html, /data-option-value="cotton"/)
  assert.match(html, /aria-selected="true"/)
  assert.match(html, /清除选项/)
  assert.match(html, /新建选项/)
  assert.doesNotMatch(html, /role="alert"/)
})


test("MultiSelectOptionsPanel 内联体：chip 组 + 多选标记 + 清除全部", () => {
  const html = renderToStaticMarkup(
    <MultiSelectOptionsPanel
      options={[
        { value: "a", label: "甲" },
        { value: "b", label: "乙" },
      ]}
      values={["a"]}
      onToggle={() => {}}
      onClear={() => {}}
      onCreateOption={async () => null}
    />,
  )
  assert.match(html, /aria-multiselectable/)
  assert.match(html, /移除 甲/)
  assert.match(html, /清除全部/)
  assert.match(html, />乙</)
})


test("CategoryPickerPanel 内联体：三列级联 + 搜索；选中类型打勾", () => {
  const html = renderToStaticMarkup(
    <CategoryPickerPanel
      tree={TREE}
      value={{ descriptionCategoryId: 11, typeId: 101 }}
      onPick={() => {}}
      onClear={() => {}}
    />,
  )
  assert.match(html, /data-category-picker=""/)
  assert.match(html, /aria-label="搜索类目"/)
  assert.match(html, /aria-label="一级类目"/)
  assert.match(html, /aria-label="二级类目"/)
  assert.match(html, /aria-label="类型"/)
  assert.match(html, /data-cat-leaf="11:101"/)
  assert.match(html, /清除类目/)
})


test("CategoryPickerPanel 空树：接通 onEnsure 给内联重读钮，不接不留死钮", () => {
  const wired = renderToStaticMarkup(
    <CategoryPickerPanel
      tree={[]}
      value={{ descriptionCategoryId: null, typeId: null }}
      onPick={() => {}}
      onEnsure={async () => true}
    />,
  )
  assert.match(wired, /data-category-tree-retry/)
  assert.match(wired, /重新读取类目树/)
  const bare = renderToStaticMarkup(
    <CategoryPickerPanel
      tree={[]}
      value={{ descriptionCategoryId: null, typeId: null }}
      onPick={() => {}}
    />,
  )
  assert.doesNotMatch(bare, /data-category-tree-retry/)
  // 有树时同样不出现 —— 重读钮只属于空树态。
  const loaded = renderToStaticMarkup(
    <CategoryPickerPanel
      tree={TREE}
      value={{ descriptionCategoryId: null, typeId: null }}
      onPick={() => {}}
      onEnsure={async () => true}
    />,
  )
  assert.doesNotMatch(loaded, /data-category-tree-retry/)
  // 树非空但解不出当前坐标 = 本地缓存陈旧残缺，同样给重读钮。
  const stale = renderToStaticMarkup(
    <CategoryPickerPanel
      tree={TREE}
      value={{ descriptionCategoryId: 999, typeId: 9999 }}
      onPick={() => {}}
      onEnsure={async () => true}
    />,
  )
  assert.match(stale, /data-category-tree-retry/)
})


test("AdjustPricePanel 内联体：新价 + 备注 + 写入，无内联错误块", () => {
  const html = renderToStaticMarkup(
    <AdjustPricePanel currentCents={1600} onAdjust={async () => true} />,
  )
  assert.match(html, /aria-label="新平台价（元）"/)
  assert.match(html, /aria-label="调价备注"/)
  assert.match(html, /¥16\.00/)
  assert.match(html, />写入</)
  assert.doesNotMatch(html, /role="alert"/)
})


test("PropEditorForm 内联体：名称 + 六类型网格 + select 选项表", () => {
  const createDraft = propDraftFrom({ mode: "create" })
  const html = renderToStaticMarkup(
    <PropEditorForm
      draft={{ ...createDraft, type: "select" }}
      onChange={() => {}}
    />,
  )
  assert.match(html, /id="supplier-prop-name"/)
  for (const type of ["text", "long_text", "number", "select", "multi_select", "checkbox"]) {
    assert.match(html, new RegExp(`data-prop-type="${type}"`), `missing type ${type}`)
  }
  assert.match(html, /aria-checked="true"[^>]*data-prop-type="select"|data-prop-type="select"[^>]*aria-checked="true"/)
  assert.match(html, /data-prop-options-editor=""/)
  assert.match(html, /对卖家可见/)
  // 纯文本类型不出选项表。
  const plain = renderToStaticMarkup(
    <PropEditorForm draft={createDraft} onChange={() => {}} />,
  )
  assert.doesNotMatch(plain, /data-prop-options-editor/)
  // 编辑态预填名称。
  const edit = propDraftFrom({
    mode: "edit",
    def: propDef({ name: "材质", type: "text" }),
  })
  assert.equal(edit.name, "材质")
})
