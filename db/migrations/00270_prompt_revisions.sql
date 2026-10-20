-- +goose Up
-- declaration 270 PromptRevisions m20261007_000050_prompt_revisions
-- source: migration/src/prompt_revisions.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.prompt_revisions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id text NOT NULL
        REFERENCES public.sc_products (product_id) ON DELETE CASCADE,
    revision integer NOT NULL,
    brief text NOT NULL,
    fixed_tags jsonb NOT NULL,
    ai_output jsonb NOT NULL,
    note text,
    author_id text NOT NULL,
    created_at_ms bigint NOT NULL,
    CONSTRAINT prompt_revisions_revision_positive CHECK (revision > 0),
    CONSTRAINT prompt_revisions_fixed_tags_array CHECK (jsonb_typeof(fixed_tags) = 'array'),
    CONSTRAINT prompt_revisions_ai_output_object CHECK (jsonb_typeof(ai_output) = 'object'),
    CONSTRAINT prompt_revisions_product_revision_unique UNIQUE (product_id, revision)
);

CREATE OR REPLACE FUNCTION public.prompt_revisions_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Product deletion cascades into this table. current_query() is the client
    -- statement, which names sc_products and not this table. A direct rewrite
    -- names prompt_revisions and is refused, including for the table owner.
    IF TG_OP = 'DELETE' AND position('prompt_revisions' in current_query()) = 0 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'prompt revisions are append-only';
END;
$$;

DROP TRIGGER IF EXISTS prompt_revisions_no_rewrite ON public.prompt_revisions;
CREATE TRIGGER prompt_revisions_no_rewrite
    BEFORE UPDATE OR DELETE ON public.prompt_revisions
    FOR EACH ROW EXECUTE FUNCTION public.prompt_revisions_append_only();

ALTER TABLE public.supplier_ozon_configs
    ADD COLUMN IF NOT EXISTS published_revision integer;

ALTER TABLE public.supplier_ozon_configs
    DROP CONSTRAINT IF EXISTS supplier_ozon_configs_published_revision_positive;
ALTER TABLE public.supplier_ozon_configs
    ADD CONSTRAINT supplier_ozon_configs_published_revision_positive
        CHECK (published_revision IS NULL OR published_revision > 0);

ALTER TABLE public.supplier_ozon_configs
    DROP CONSTRAINT IF EXISTS supplier_ozon_configs_published_revision_fk;
ALTER TABLE public.supplier_ozon_configs
    ADD CONSTRAINT supplier_ozon_configs_published_revision_fk
        FOREIGN KEY (product_id, published_revision)
        REFERENCES public.prompt_revisions (product_id, revision)
        ON DELETE CASCADE;

INSERT INTO public.prompt_revisions (
    product_id, revision, brief, fixed_tags, ai_output, note, author_id, created_at_ms
)
SELECT c.product_id, 1, c.prompt_text, c.fixed_tags, c.ai_output, NULL,
       c.updated_by_account_uuid, c.updated_at_ms
FROM public.supplier_ozon_configs c
WHERE btrim(c.prompt_text) <> ''
  AND NOT EXISTS (
      SELECT 1 FROM public.prompt_revisions r WHERE r.product_id = c.product_id
  );

UPDATE public.supplier_ozon_configs c
SET published_revision = 1
WHERE btrim(c.prompt_text) <> ''
  AND c.published_revision IS NULL
  AND EXISTS (
      SELECT 1 FROM public.prompt_revisions r
      WHERE r.product_id = c.product_id AND r.revision = 1
  );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
