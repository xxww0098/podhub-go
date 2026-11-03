-- +goose Up
ALTER TABLE public.ozon_category_current ADD COLUMN schema_revision text;
ALTER TABLE public.ozon_category_current
    ADD CONSTRAINT ozon_category_current_revision_shape
    CHECK (schema_revision IS NULL OR (char_length(schema_revision) BETWEEN 1 AND 256));
DROP TABLE public.ozon_dictionary_current;

-- +goose Down
CREATE TABLE public.ozon_dictionary_current (
    description_category_id bigint NOT NULL,
    type_id bigint NOT NULL,
    language character varying(16) NOT NULL,
    attribute_id bigint NOT NULL,
    option_id bigint NOT NULL,
    value text NOT NULL,
    info text DEFAULT ''::text NOT NULL,
    picture text DEFAULT ''::text NOT NULL,
    CONSTRAINT ozon_dictionary_current_identity_positive CHECK (((attribute_id > 0) AND (option_id > 0)))
);
ALTER TABLE ONLY public.ozon_dictionary_current
    ADD CONSTRAINT ozon_dictionary_current_pkey PRIMARY KEY (description_category_id, type_id, language, attribute_id, option_id);
ALTER TABLE ONLY public.ozon_dictionary_current
    ADD CONSTRAINT ozon_dictionary_current_category_fkey FOREIGN KEY (description_category_id, type_id, language) REFERENCES public.ozon_category_current(description_category_id, type_id, language) ON DELETE CASCADE;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_dictionary_current TO podhub_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ozon_dictionary_current TO podhub_worker;
ALTER TABLE public.ozon_category_current DROP CONSTRAINT ozon_category_current_revision_shape;
ALTER TABLE public.ozon_category_current DROP COLUMN schema_revision;
