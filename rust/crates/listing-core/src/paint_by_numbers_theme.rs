//! Default theme for paint-by-numbers (数字油画) cards.
//!
//! Dictionary 726 is ordered by option id, so an empty 主题 (attribute 7109)
//! surfaces as the first option, 31208「汽车和摩托车」. A card of Ozon type
//! 94897 with no theme of its own gets 31229「抽象化」 — the same fallback the
//! paint-by-numbers prompt uses when the picture's subject is unclear
//! («Абстрактный сюжет»). An explicit selection, including a sole
//! 「汽车和摩托车」, is left alone. A cleared key stays cleared.

use crate::THEME_ATTRIBUTE_ID;
use crate::projections::draft_value_is_blank;
use crate::workflow_dto::types::{
    WorkflowCategoryDraft, WorkflowDraftSelection, WorkflowDraftValue,
};

/// Ozon type id of the 数字油画 leaf (also the option id of attribute 8229).
pub(crate) const PAINT_BY_NUMBERS_TYPE_ID: i64 = 94_897;

/// Dictionary 726 option「抽象化」. 31208「汽车和摩托车」 is the first
/// option and must not be written as this default.
const PAINTING_THEME_ID: i64 = 31_229;
const PAINTING_THEME_LABEL: &str = "抽象化";

/// Fill attribute 7109 when `type_id` is 数字油画 and the theme is blank.
///
/// Returns whether a value was inserted.
pub fn fill_paint_by_numbers_card_theme(type_id: i64, draft: &mut WorkflowCategoryDraft) -> bool {
    if type_id != PAINT_BY_NUMBERS_TYPE_ID {
        return false;
    }
    let key = format!("attribute_{THEME_ATTRIBUTE_ID}");
    if draft.cleared.contains(&key) || !draft_value_is_blank(draft.values.get(&key)) {
        return false;
    }
    draft.values.insert(
        key,
        WorkflowDraftValue::MultiSelect(vec![WorkflowDraftSelection {
            dictionary_value_id: PAINTING_THEME_ID,
            value: PAINTING_THEME_LABEL.to_owned(),
        }]),
    );
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme(draft: &WorkflowCategoryDraft) -> Option<&WorkflowDraftValue> {
        draft.values.get(&format!("attribute_{THEME_ATTRIBUTE_ID}"))
    }

    fn painting() -> WorkflowDraftValue {
        WorkflowDraftValue::MultiSelect(vec![WorkflowDraftSelection {
            dictionary_value_id: PAINTING_THEME_ID,
            value: PAINTING_THEME_LABEL.to_owned(),
        }])
    }

    #[test]
    fn a_blank_paint_by_numbers_card_gets_the_abstract_theme() {
        let mut draft = WorkflowCategoryDraft::default();
        assert!(fill_paint_by_numbers_card_theme(
            PAINT_BY_NUMBERS_TYPE_ID,
            &mut draft
        ));
        assert_eq!(theme(&draft), Some(&painting()));
        assert_ne!(
            painting(),
            WorkflowDraftValue::MultiSelect(vec![WorkflowDraftSelection {
                dictionary_value_id: 31_208,
                value: "汽车和摩托车".to_owned(),
            }])
        );
    }

    #[test]
    fn an_empty_multi_select_is_blank_and_gets_filled() {
        let key = format!("attribute_{THEME_ATTRIBUTE_ID}");
        let mut draft = WorkflowCategoryDraft::default();
        draft
            .values
            .insert(key, WorkflowDraftValue::MultiSelect(Vec::new()));
        assert!(fill_paint_by_numbers_card_theme(
            PAINT_BY_NUMBERS_TYPE_ID,
            &mut draft
        ));
        assert_eq!(theme(&draft), Some(&painting()));
    }

    #[test]
    fn an_explicit_theme_including_vehicles_stays() {
        let key = format!("attribute_{THEME_ATTRIBUTE_ID}");
        let flowers = WorkflowDraftValue::MultiSelect(vec![WorkflowDraftSelection {
            dictionary_value_id: 970_742_650,
            value: "花卉和植物".to_owned(),
        }]);
        let vehicles = WorkflowDraftValue::MultiSelect(vec![WorkflowDraftSelection {
            dictionary_value_id: 31_208,
            value: "汽车和摩托车".to_owned(),
        }]);
        for value in [flowers, vehicles] {
            let mut draft = WorkflowCategoryDraft::default();
            draft.values.insert(key.clone(), value.clone());
            assert!(!fill_paint_by_numbers_card_theme(
                PAINT_BY_NUMBERS_TYPE_ID,
                &mut draft
            ));
            assert_eq!(theme(&draft), Some(&value));
        }
    }

    #[test]
    fn a_cleared_theme_stays_cleared() {
        let key = format!("attribute_{THEME_ATTRIBUTE_ID}");
        let mut draft = WorkflowCategoryDraft::default();
        draft.cleared.insert(key);
        assert!(!fill_paint_by_numbers_card_theme(
            PAINT_BY_NUMBERS_TYPE_ID,
            &mut draft
        ));
        assert!(theme(&draft).is_none());
    }

    #[test]
    fn another_type_with_a_blank_theme_is_left_blank() {
        let mut draft = WorkflowCategoryDraft::default();
        assert!(!fill_paint_by_numbers_card_theme(91_976, &mut draft));
        assert!(theme(&draft).is_none());
    }
}
