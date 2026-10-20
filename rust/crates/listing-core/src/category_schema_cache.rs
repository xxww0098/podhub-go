//! Conversions between listing schema material and the Cloud category schema
//! cache wire.
//!
//! The cache carries field material only. `schema_revision` is always
//! recomputed from that material, so a cached payload can never forge a Schema
//! Revision.

use crate::WorkflowLanguage;

use super::records::ListingFieldOption;
use super::schema::{ListingFieldConstraints, ListingFieldDefinition, ListingFieldEditor};
use crate::catalog_schema::{
    CatalogSchemaEditor, CatalogSchemaField, CatalogSchemaLanguage, CatalogSchemaOption,
};

impl From<WorkflowLanguage> for CatalogSchemaLanguage {
    fn from(language: WorkflowLanguage) -> Self {
        match language {
            WorkflowLanguage::Default => Self::Default,
            WorkflowLanguage::Ru => Self::Ru,
            WorkflowLanguage::En => Self::En,
            WorkflowLanguage::Tr => Self::Tr,
            WorkflowLanguage::ZhHans => Self::ZhHans,
        }
    }
}

impl From<ListingFieldEditor> for CatalogSchemaEditor {
    fn from(editor: ListingFieldEditor) -> Self {
        match editor {
            ListingFieldEditor::Text => Self::Text,
            ListingFieldEditor::Integer => Self::Integer,
            ListingFieldEditor::Decimal => Self::Decimal,
            ListingFieldEditor::Boolean => Self::Boolean,
            ListingFieldEditor::SingleSelect => Self::SingleSelect,
            ListingFieldEditor::MultiSelect => Self::MultiSelect,
            ListingFieldEditor::DictionarySearch => Self::DictionarySearch,
            ListingFieldEditor::Url => Self::Url,
            ListingFieldEditor::UrlList => Self::UrlList,
        }
    }
}

impl From<CatalogSchemaEditor> for ListingFieldEditor {
    fn from(editor: CatalogSchemaEditor) -> Self {
        match editor {
            CatalogSchemaEditor::Text => Self::Text,
            CatalogSchemaEditor::Integer => Self::Integer,
            CatalogSchemaEditor::Decimal => Self::Decimal,
            CatalogSchemaEditor::Boolean => Self::Boolean,
            CatalogSchemaEditor::SingleSelect => Self::SingleSelect,
            CatalogSchemaEditor::MultiSelect => Self::MultiSelect,
            CatalogSchemaEditor::DictionarySearch => Self::DictionarySearch,
            CatalogSchemaEditor::Url => Self::Url,
            CatalogSchemaEditor::UrlList => Self::UrlList,
        }
    }
}

impl From<&ListingFieldOption> for CatalogSchemaOption {
    fn from(option: &ListingFieldOption) -> Self {
        Self {
            id: option.id.clone(),
            value: option.value.clone(),
            info: option.info.clone(),
            picture: option.picture.clone(),
        }
    }
}

impl From<CatalogSchemaOption> for ListingFieldOption {
    fn from(option: CatalogSchemaOption) -> Self {
        Self {
            id: option.id,
            value: option.value,
            info: option.info,
            picture: option.picture,
        }
    }
}

impl From<&ListingFieldDefinition> for CatalogSchemaField {
    fn from(field: &ListingFieldDefinition) -> Self {
        Self {
            key: field.key.clone(),
            label: field.label.clone(),
            group: field.group.clone(),
            editor: field.editor.into(),
            required: field.required,
            collection: field.constraints.collection,
            max_value_count: field.constraints.max_value_count,
            dictionary_id: field.constraints.dictionary_id.clone(),
            attribute_id: field.attribute_id.clone(),
            complex_id: field.complex_id.clone(),
            description: field.description.clone(),
            raw_type: field.raw_type.clone(),
            read_only: field.read_only,
            complex_group_collection: field.complex_group_collection,
            options: field.options.iter().map(Into::into).collect(),
            options_truncated: field.options_truncated,
            aspect: field.aspect,
        }
    }
}

impl From<CatalogSchemaField> for ListingFieldDefinition {
    fn from(field: CatalogSchemaField) -> Self {
        Self {
            key: field.key,
            label: field.label,
            group: field.group,
            editor: field.editor.into(),
            required: field.required,
            constraints: ListingFieldConstraints {
                collection: field.collection,
                max_value_count: field.max_value_count,
                dictionary_id: field.dictionary_id,
            },
            attribute_id: field.attribute_id,
            complex_id: field.complex_id,
            description: field.description,
            raw_type: field.raw_type,
            read_only: field.read_only,
            complex_group_collection: field.complex_group_collection,
            options: field.options.into_iter().map(Into::into).collect(),
            options_truncated: field.options_truncated,
            aspect: field.aspect,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::categories::decorative_wall_art;
    use crate::schema::semantic_schema_revision;

    /// A cache round trip must not lose or invent field material: the Schema
    /// Revision recomputed from the returned fields has to equal the original.
    #[test]
    fn a_cache_round_trip_preserves_every_field_and_its_schema_revision() {
        let snapshot = decorative_wall_art::local_schema_snapshot();
        let cached = snapshot
            .fields
            .iter()
            .map(CatalogSchemaField::from)
            .collect::<Vec<_>>();
        let restored = cached
            .into_iter()
            .map(ListingFieldDefinition::from)
            .collect::<Vec<_>>();

        assert_eq!(restored, snapshot.fields);
        assert_eq!(
            semantic_revision(&restored),
            semantic_revision(&snapshot.fields)
        );
    }

    /// The completeness rule over the cache wire shape, which is what Cloud's
    /// cache refresh asks. The native shape goes through
    /// `variants::carries_aspect_metadata`; the assertion below is what keeps
    /// the two answers identical.
    fn cache_shape_carries_aspect(fields: &[CatalogSchemaField]) -> bool {
        crate::variants::material_declares_aspect(
            fields
                .iter()
                .map(|field| (field.attribute_id.is_some(), field.aspect)),
        )
    }

    /// The cache is the *only* place a live schema is written down between two
    /// serves, so losing `aspect` here would silently turn every cached
    /// category's variant dimensions into "unknown" — which is not "none", but
    /// still refuses every grouping judged against it until the cache TTL
    /// brings the metadata back.
    #[test]
    fn the_cache_round_trip_keeps_aspect_and_its_unknown_state() {
        let mut snapshot = decorative_wall_art::local_schema_snapshot();
        for field in &mut snapshot.fields {
            field.aspect = Some(false);
        }
        snapshot.fields[4].aspect = Some(true);
        snapshot.fields[5].aspect = None;
        assert!(snapshot.fields[4].attribute_id.is_some());

        let cached = snapshot
            .fields
            .iter()
            .map(CatalogSchemaField::from)
            .collect::<Vec<_>>();
        // One unresolved attribute field is enough to make the whole payload
        // old: it might have been the variant dimension.
        assert!(!cache_shape_carries_aspect(&cached));
        let restored = cached
            .iter()
            .cloned()
            .map(ListingFieldDefinition::from)
            .collect::<Vec<_>>();
        assert_eq!(restored[4].aspect, Some(true));
        assert_eq!(restored[5].aspect, None);
        assert_eq!(restored[6].aspect, Some(false));

        // The two shapes answer the completeness question identically.
        assert_eq!(
            cache_shape_carries_aspect(&cached),
            crate::variants::carries_aspect_metadata(&restored)
        );
        let resolved = cached
            .iter()
            .map(|field| CatalogSchemaField {
                aspect: field.attribute_id.as_ref().map(|_| false),
                ..field.clone()
            })
            .collect::<Vec<_>>();
        assert!(cache_shape_carries_aspect(&resolved));
        assert!(crate::variants::carries_aspect_metadata(
            &resolved
                .iter()
                .cloned()
                .map(ListingFieldDefinition::from)
                .collect::<Vec<_>>()
        ));
    }

    #[test]
    fn every_editor_survives_the_cache_vocabulary() {
        for editor in [
            ListingFieldEditor::Text,
            ListingFieldEditor::Integer,
            ListingFieldEditor::Decimal,
            ListingFieldEditor::Boolean,
            ListingFieldEditor::SingleSelect,
            ListingFieldEditor::MultiSelect,
            ListingFieldEditor::DictionarySearch,
            ListingFieldEditor::Url,
            ListingFieldEditor::UrlList,
        ] {
            let cached: CatalogSchemaEditor = editor.into();
            assert_eq!(ListingFieldEditor::from(cached), editor);
        }
    }

    #[test]
    fn workflow_languages_map_onto_the_cache_keys() {
        for (language, key) in [
            (WorkflowLanguage::Default, "default"),
            (WorkflowLanguage::Ru, "ru"),
            (WorkflowLanguage::En, "en"),
            (WorkflowLanguage::Tr, "tr"),
            (WorkflowLanguage::ZhHans, "zh_hans"),
        ] {
            assert_eq!(CatalogSchemaLanguage::from(language).key(), key);
        }
    }

    fn semantic_revision(fields: &[ListingFieldDefinition]) -> String {
        let identities = fields
            .iter()
            .map(|field| crate::schema::SemanticFieldIdentity {
                key: field.key.clone(),
                editor: field.editor,
                required: field.required,
                collection: field.constraints.collection,
                max_value_count: field.constraints.max_value_count,
                dictionary_id: field.constraints.dictionary_id.clone(),
                attribute_id: field.attribute_id.clone(),
                complex_id: field.complex_id.clone(),
                complex_group_collection: field.complex_group_collection,
                read_only: field.read_only,
                aspect: field.aspect,
                option_ids: field.options.iter().map(|o| o.id.clone()).collect(),
                options_truncated: field.options_truncated,
            })
            .collect::<Vec<_>>();
        semantic_schema_revision(17027906, 91976, 0, 0, 0, &identities, &[])
    }
}
