//! `FieldIssue`: the persisted/wire shape of one field-level finding, and the
//! typed constructor every validate-stage rule uses.
//!
//! `code` stays an open string on the wire. Rows and Drafts persist their
//! issues (`RowPayload::validation_issues`, `LeanRow::validation_issues`),
//! and a stored code this build does not declare must still decode, keep its
//! row, and keep its text — a strict enum there would drop the whole row on
//! read. Producers are the closed side: [`issue`] only accepts an
//! [`OzonValidateCode`], and `ops::freeze_listing` only an
//! [`crate::issue_keys::OzonFreezeCode`]. Readers classify with
//! [`FieldIssue::known_key`] and treat `None` as unclassified.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::issue_keys::{IssuePlatform, IssueStage, KnownIssueKey, OzonValidateCode};
use crate::records::FieldAddress;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldIssue {
    pub field_key: String,
    pub code: String,
    pub parameters: BTreeMap<String, IssueParameter>,
    pub severity: IssueSeverity,
    pub address: FieldAddress,
    pub message: String,
    pub remediation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum IssueParameter {
    Text(String),
    Integer(i64),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueSeverity {
    Blocking,
    Warning,
}

impl FieldIssue {
    /// The known key of this issue *as produced by `stage`*. The stage is the
    /// caller's fact (which operation produced the issue), never guessed from
    /// the code. `None`: the stored code is unclassified for that stage — keep
    /// it for diagnostics, offer no automatic action.
    pub fn known_key(&self, stage: IssueStage) -> Option<KnownIssueKey> {
        KnownIssueKey::classify(IssuePlatform::Ozon, stage, &self.code)
    }
}

/// A blocking validate-stage issue at a plain address. The only way a
/// validate rule mints a `FieldIssue`.
pub(super) fn issue(
    field_key: impl Into<String>,
    code: OzonValidateCode,
    message: impl Into<String>,
    remediation: Option<String>,
) -> FieldIssue {
    let field_key = field_key.into();
    FieldIssue {
        field_key: field_key.clone(),
        code: code.as_str().to_owned(),
        parameters: BTreeMap::new(),
        severity: IssueSeverity::Blocking,
        address: FieldAddress::Plain { field_key },
        message: message.into(),
        remediation,
    }
}
