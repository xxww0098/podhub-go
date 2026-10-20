//! `values_equal` golden case, and a plain (non-golden) proof of
//! `mint_item_id`'s formatting contract — exercised inline in every other
//! case module via `sequential_ids`, so it earns one direct assertion here
//! rather than a fixture of its own.

use serde_json::{Value, json};

use crate::WorkflowDraftValue;
use crate::content_policy::mint_item_id;
use crate::ops::values_equal;

use super::{assert_golden, sequential_ids};

#[test]
fn values_equal_treats_a_decimal_text_value_as_equal_regardless_of_trailing_zeros() {
    use crate::records::ListingFieldEditor as Editor;
    let left = WorkflowDraftValue::Text("99.90".to_owned());
    let right = WorkflowDraftValue::Text("99.9".to_owned());
    let equal = values_equal(Editor::Decimal, Some(&left), Some(&right));
    let cases = vec![
        json!({"editor": "decimal", "left": &left, "right": &right, "equal": equal}),
        {
            let left = WorkflowDraftValue::MultiSelect(vec![crate::WorkflowDraftSelection {
                dictionary_value_id: 2,
                value: "限量".to_owned(),
            }]);
            let right = WorkflowDraftValue::MultiSelect(vec![crate::WorkflowDraftSelection {
                dictionary_value_id: 3,
                value: "限量".to_owned(),
            }]);
            let equal = values_equal(Editor::MultiSelect, Some(&left), Some(&right));
            json!({"editor": "multi_select", "left": &left, "right": &right, "equal": equal})
        },
    ];
    assert_golden(
        "values_equal",
        "decimal-and-dictionary-cases",
        &Value::Null,
        &cases,
    );
}

#[test]
fn sequential_ids_mint_the_crates_stable_item_id_shape() {
    let mut ids = sequential_ids();
    let id = mint_item_id(ids());
    assert!(id.starts_with("ci_"));
    assert_eq!(id.len(), "ci_".len() + 32);
}
