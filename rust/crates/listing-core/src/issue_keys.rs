//! The one declaration of every known publish issue key:
//! `(platform, stage, code)`.
//!
//! Everything a consumer needs to be exhaustive derives from the single
//! `declare_known_issue_keys!` invocation below, so the three views cannot
//! drift apart:
//!
//! 1. **Typed producers.** One closed enum per stage
//!    ([`OzonValidateCode`], [`OzonFreezeCode`], [`OzonPreDispatchCode`],
//!    [`OzonSubmitCode`]). Rule code that mints an issue names a variant, never
//!    a string, so a typo or an undeclared code does not compile.
//! 2. **Closed OpenAPI union.** `KnownIssueKey` (see `issue_keys/schema.rs`,
//!    behind the `openapi` feature) is a `oneOf` with one object per
//!    `(platform, stage)` whose `code` enumerates that stage's codes, so the
//!    browser's table can be nested `platform → stage → code` and checked for
//!    exhaustiveness at compile time.
//! 3. **Runtime manifest.** [`KnownIssueKey::ALL`] / [`known_issue_manifest`]
//!    serialize the same keys in declaration order (also answered by the WASM
//!    ABI, `listing-core-wasm` op 13).
//!
//! The stage is a fact of the operation that produced the issue, never
//! inferred from the code string alone:
//!
//! - `validate` — `validate::normalize_and_validate_with` (19 codes). `build`
//!   produces no `FieldIssue` of its own; its output is only ever judged here.
//! - `freeze` — `ops::freeze_listing`'s own refusals (6 codes). A freeze that
//!   was refused *because validation failed* carries validate-stage issues
//!   unchanged ([`crate::ops::FreezeRefusal::issue_stage`]).
//! - `pre_dispatch` / `submit` — Cloud's submission `ListingIssue`, whose
//!   stage follows its dispatch evidence (`not_dispatched` → `pre_dispatch`,
//!   otherwise `submit`). The same code may legitimately appear in both
//!   (`OZON_RATE_LIMITED`, `OZON_ACCESS_UNCLASSIFIED`).
//!
//! Wire fields that carry a code stay open strings (`FieldIssue::code`,
//! `ListingIssue::{phase, code}`): persisted rows and Intents may hold codes a
//! newer or older server wrote, and those must survive a read intact rather
//! than fail a strict decode and take the whole row or issue list with them.
//! [`KnownIssueKey::classify`] is the only bridge from such a string back to a
//! key; `None` means *unclassified* — keep the raw code for diagnostics and
//! grant no automatic action. There is deliberately no catch-all variant and
//! no default.

use serde::de::Error as _;
use serde::ser::SerializeStruct as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Marketplace a known key belongs to. Only platforms whose rules actually
/// produce issues are listed; a platform is added together with its codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssuePlatform {
    Ozon,
    Wb,
}

impl IssuePlatform {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ozon => "ozon",
            Self::Wb => "wb",
        }
    }

    /// Exact wire match; anything else is not a known platform.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ozon" => Some(Self::Ozon),
            "wb" => Some(Self::Wb),
            _ => None,
        }
    }
}

/// The operation that produced an issue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueStage {
    Validate,
    Freeze,
    PreDispatch,
    Submit,
    Metadata,
    Preview,
}

impl IssueStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Validate => "validate",
            Self::Freeze => "freeze",
            Self::PreDispatch => "pre_dispatch",
            Self::Submit => "submit",
            Self::Metadata => "metadata",
            Self::Preview => "preview",
        }
    }

    /// Exact wire match; anything else is not a known stage.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "validate" => Some(Self::Validate),
            "freeze" => Some(Self::Freeze),
            "pre_dispatch" => Some(Self::PreDispatch),
            "submit" => Some(Self::Submit),
            "metadata" => Some(Self::Metadata),
            "preview" => Some(Self::Preview),
            _ => None,
        }
    }
}

macro_rules! declare_known_issue_keys {
    ($(
        $(#[$stage_doc:meta])*
        $variant:ident: $platform:ident / $stage:ident => $codes:ident {
            $( $(#[$code_doc:meta])* $code:ident = $wire:literal, )+
        }
    )+) => {
        $(
            $(#[$stage_doc])*
            #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
            pub enum $codes {
                $( $(#[$code_doc])* $code, )+
            }

            impl $codes {
                /// Every code of this stage, in declaration order.
                pub const ALL: &'static [Self] = &[ $( Self::$code, )+ ];

                /// The stable wire string — the exact JSON literal producers
                /// always wrote.
                pub const fn as_str(self) -> &'static str {
                    match self { $( Self::$code => $wire, )+ }
                }

                /// This code as a fully qualified key.
                pub const fn key(self) -> KnownIssueKey {
                    KnownIssueKey::$variant(self)
                }

                /// Exact wire match within this stage only.
                pub fn parse(code: &str) -> Option<Self> {
                    match code {
                        $( $wire => Some(Self::$code), )+
                        _ => None,
                    }
                }
            }
        )+

        /// One known `(platform, stage, code)` triple.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum KnownIssueKey {
            $( $variant($codes), )+
        }

        impl KnownIssueKey {
            /// The runtime manifest: every key, stages in declaration order,
            /// codes in declaration order within a stage.
            pub const ALL: &'static [Self] = &[
                $( $( Self::$variant($codes::$code), )+ )+
            ];

            pub const fn platform(self) -> IssuePlatform {
                match self {
                    $( Self::$variant(_) => IssuePlatform::$platform, )+
                }
            }

            pub const fn stage(self) -> IssueStage {
                match self {
                    $( Self::$variant(_) => IssueStage::$stage, )+
                }
            }

            pub const fn code(self) -> &'static str {
                match self {
                    $( Self::$variant(code) => code.as_str(), )+
                }
            }

            /// Classify an open wire triple. `None` is *unclassified*: an
            /// unknown platform, stage, or a code that stage never produces
            /// (including a known code reported under the wrong stage).
            pub fn classify(
                platform: IssuePlatform,
                stage: IssueStage,
                code: &str,
            ) -> Option<Self> {
                $(
                    if platform == IssuePlatform::$platform && stage == IssueStage::$stage {
                        if let Some(code) = $codes::parse(code) {
                            return Some(Self::$variant(code));
                        }
                    }
                )+
                None
            }
        }
    };
}

declare_known_issue_keys! {
    /// `validate::normalize_and_validate_with`: field-level Draft rules.
    OzonValidate: Ozon / Validate => OzonValidateCode {
        Required = "required",
        MaxValueCount = "max_value_count",
        ComplexSingleItem = "complex_single_item",
        NameContainsHan = "name_contains_han",
        NameTooLong = "name_too_long",
        OfferIdTooLong = "offer_id_too_long",
        OfferIdCharset = "offer_id_charset",
        InvalidBarcode = "invalid_barcode",
        InvalidPrice = "invalid_price",
        InvalidPositiveInteger = "invalid_positive_integer",
        InvalidInteger = "invalid_integer",
        InvalidDecimal = "invalid_decimal",
        InvalidBoolean = "invalid_boolean",
        InvalidUrl = "invalid_url",
        InvalidChoice = "invalid_choice",
        InvalidChoiceCardinality = "invalid_choice_cardinality",
        InvalidDictionaryId = "invalid_dictionary_id",
        UnknownDictionaryId = "unknown_dictionary_id",
        DictionaryMaterialRequired = "dictionary_material_required",
    }
    /// `ops::freeze_listing`'s own refusals (not the validate issues a
    /// `validation_failed` refusal forwards).
    OzonFreeze: Ozon / Freeze => OzonFreezeCode {
        RowIdInvalid = "row_id_invalid",
        SchemaStale = "schema_stale",
        CoordinateMismatch = "coordinate_mismatch",
        LanguageMismatch = "language_mismatch",
        AiCandidateUnresolved = "ai_candidate_unresolved",
        FreezeFailed = "freeze_failed",
    }
    /// Cloud submission issues decided before the import left the process
    /// (`dispatchEvidence: not_dispatched`).
    OzonPreDispatch: Ozon / PreDispatch => OzonPreDispatchCode {
        StorePaused = "OZON_STORE_PAUSED",
        RateLimited = "OZON_RATE_LIMITED",
        EgressUnavailable = "OZON_EGRESS_UNAVAILABLE",
        EgressUnreachable = "OZON_EGRESS_UNREACHABLE",
        WritesDisabled = "OZON_WRITES_DISABLED",
        AccessUnclassified = "OZON_ACCESS_UNCLASSIFIED",
        ShippingNotReady = "SHIPPING_NOT_READY",
    }
    /// Cloud submission issues observed after dispatch
    /// (`dispatchEvidence: rejected | unknown`).
    OzonSubmit: Ozon / Submit => OzonSubmitCode {
        RowRejected = "OZON_ROW_REJECTED",
        CredentialInvalid = "OZON_CREDENTIAL_INVALID",
        PermissionDenied = "OZON_PERMISSION_DENIED",
        AccessUnclassified = "OZON_ACCESS_UNCLASSIFIED",
        RateLimited = "OZON_RATE_LIMITED",
        DispatchInterrupted = "OZON_DISPATCH_INTERRUPTED",
    }
    /// Ozon variant grouping, produced by `variants::validate_group` and
    /// `variants::resolve_variant_rule`.
    ///
    /// Stage `preview`: every one of these is decided from material the
    /// caller already holds, before anything is sent — no task id, no
    /// dispatch evidence, no Seller write. Both entries (the listing workflow
    /// and store product management) reach the same codes through the same
    /// pure rules, so a grouping the browser refuses is a grouping Cloud
    /// refuses.
    OzonVariants: Ozon / Preview => OzonVariantsCode {
        /// Some attribute field never carried `is_aspect`: refresh material.
        /// Never read as "this category has no variant dimensions".
        MetadataUnknown = "variant_metadata_unknown",
        /// The category lists no `9048` attribute at all.
        ModelFieldAbsent = "variant_model_field_absent",
        /// `9048` exists only inside a complex group this version cannot use.
        ModelFieldComplex = "variant_model_field_complex",
        /// An `is_aspect` dimension is a complex group member, which this
        /// version cannot normalise. Never silently ignored.
        DimensionComplex = "variant_dimension_complex",
        /// Members of one logical group disagree on category or type.
        CategoryMismatch = "variant_category_mismatch",
        /// Members of one logical group disagree on brand.
        BrandMismatch = "variant_brand_mismatch",
        /// The group offers no dimension its members differ in.
        NoDistinguishingDimension = "variant_no_distinguishing_dimension",
        /// Two members of the group carry the same complete combination.
        CombinationDuplicate = "variant_combination_duplicate",
        /// A write names a member that is not in the complete logical group.
        WriteMemberUnknown = "variant_write_member_unknown",
    }
    /// WB material admission, produced by `wb::metadata_issues`.
    WbMetadata: Wb / Metadata => WbMetadataCode {
        CatalogUnavailable = "catalog_unavailable",
        CatalogStale = "catalog_stale",
        DefaultsStale = "defaults_stale",
        CatalogInvalid = "catalog_invalid",
    }
    /// WB native characteristic and group rules.
    WbValidate: Wb / Validate => WbValidateCode {
        UnknownCharacteristic = "unknown_characteristic",
        BlankText = "blank_text",
        MaxCount = "max_count",
        NonfiniteNumber = "nonfinite_number",
        ValueType = "value_type",
        Required = "required",
        CoordinateMismatch = "coordinate_mismatch",
        InvalidDimensions = "invalid_dimensions",
        VariantCount = "variant_count",
        VendorCodeRequired = "vendor_code_required",
        VendorCodeTooLong = "vendor_code_too_long",
        TitleTooLong = "title_too_long",
    }
    /// Exact WB upload preview encoding refusals.
    WbPreview: Wb / Preview => WbPreviewCode {
        UploadTooLarge = "upload_too_large",
        EncodingFailed = "encoding_failed",
    }
}

/// A Cloud submission (`ListingIssue`) key. The stage is part of the type:
/// a producer picks it from its dispatch evidence and cannot pair a
/// pre-dispatch code with post-dispatch evidence or the reverse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ListingIssueKey {
    PreDispatch(OzonPreDispatchCode),
    Submit(OzonSubmitCode),
}

impl ListingIssueKey {
    pub const fn key(self) -> KnownIssueKey {
        match self {
            Self::PreDispatch(code) => code.key(),
            Self::Submit(code) => code.key(),
        }
    }

    /// `ListingIssue::phase`.
    pub const fn stage(self) -> IssueStage {
        self.key().stage()
    }

    /// `ListingIssue::code`.
    pub const fn code(self) -> &'static str {
        self.key().code()
    }
}

/// The runtime manifest in declaration order. Same content as
/// [`KnownIssueKey::ALL`]; a named function so callers outside Rust (the
/// WASM ABI, golden tests) have one entry point.
pub fn known_issue_manifest() -> &'static [KnownIssueKey] {
    KnownIssueKey::ALL
}

/// Wire shape: `{"platform":"ozon","stage":"validate","code":"required"}`.
impl Serialize for KnownIssueKey {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("KnownIssueKey", 3)?;
        state.serialize_field("platform", self.platform().as_str())?;
        state.serialize_field("stage", self.stage().as_str())?;
        state.serialize_field("code", self.code())?;
        state.end()
    }
}

/// Strict: a closed key refuses anything the declaration does not name. Open
/// wire strings go through [`KnownIssueKey::classify`] instead.
impl<'de> Deserialize<'de> for KnownIssueKey {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            platform: String,
            stage: String,
            code: String,
        }
        fn unknown<E: serde::de::Error>(what: &str, value: &str) -> E {
            E::custom(format!("unknown issue {what} {value:?}"))
        }
        let wire = Wire::deserialize(deserializer)?;
        let platform = IssuePlatform::parse(&wire.platform)
            .ok_or_else(|| unknown::<D::Error>("platform", &wire.platform))?;
        let stage = IssueStage::parse(&wire.stage)
            .ok_or_else(|| unknown::<D::Error>("stage", &wire.stage))?;
        match Self::classify(platform, stage, &wire.code) {
            Some(key) => Ok(key),
            None => Err(D::Error::custom(format!(
                "{:?} is not a known {} {} issue code",
                wire.code,
                platform.as_str(),
                stage.as_str()
            ))),
        }
    }
}

#[cfg(feature = "openapi")]
mod schema;

#[cfg(test)]
mod tests;
