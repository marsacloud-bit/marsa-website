-- =====================================================================
-- 20261130000100_tx_container_count — «عدد الحاويات» of a transaction made / filled from a doc batch (2026-11-15)
--   A doc batch approval (public.approve_doc_batch, and public.create_draft_transaction through it: the draft from the
--   ocr.html matching report) inserts the batch's containers but left transactions.container_count at its default 0: the
--   transactions list / detail showed 0 containers for a draft that has them. The new-transaction form (admin.js) sets
--   container_count = the number of containers entered; legacy_import (20261125000100) raises it to the number inserted.
--   * app.tg_doc_batches_container_count() + trigger trg_container_count (AFTER UPDATE OF status ON public.doc_batches,
--     draft → approved with a transaction): the transaction's container_count is raised to the number of its containers
--     when lower (never lowered: a count entered by staff above the containers read stays). Ro-Ro transactions are skipped
--     (container_count stays 0, transactions_roro_chk). No copied body of approve_doc_batch.
--   * backfill: live (not cancelled) transactions with an approved doc batch whose container_count is below their
--     containers (the drafts made before this file); cancelled ones are frozen and keep their count.
--   Re-runnable (CREATE OR REPLACE / DROP TRIGGER IF EXISTS + CREATE; the backfill is a no-op the second time).
--   Down-path: DROP TRIGGER trg_container_count ON public.doc_batches; DROP FUNCTION app.tg_doc_batches_container_count();
--   (raised counts are kept).
--   No BEGIN/COMMIT (the SQL editor wraps the run).
-- =====================================================================

DO $pre$
BEGIN
  IF to_regclass('public.schema_versions') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_versions WHERE version = '20261128000100') THEN
    RAISE EXCEPTION 'TX CONTAINER COUNT preflight: apply return_extension first (schema_versions lacks 20261128000100)';
  END IF;
  IF to_regclass('public.doc_batches') IS NULL OR to_regprocedure('public.approve_doc_batch(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'TX CONTAINER COUNT preflight: doc batches (20261119000100) missing';
  END IF;
END $pre$;

INSERT INTO public.schema_versions (version, name) VALUES ('20261130000100', 'tx_container_count')
ON CONFLICT (version) DO NOTHING;

CREATE OR REPLACE FUNCTION app.tg_doc_batches_container_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.transactions t
     SET container_count = k.n
    FROM (SELECT count(*)::int n FROM public.containers c WHERE c.transaction_id = NEW.transaction_id) k
   WHERE t.id = NEW.transaction_id AND t.cargo_unit_type IS DISTINCT FROM 'roro' AND t.container_count < k.n;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_container_count ON public.doc_batches;
CREATE TRIGGER trg_container_count AFTER UPDATE OF status ON public.doc_batches
  FOR EACH ROW WHEN (OLD.status = 'draft' AND NEW.status = 'approved' AND NEW.transaction_id IS NOT NULL)
  EXECUTE FUNCTION app.tg_doc_batches_container_count();

REVOKE ALL ON FUNCTION app.tg_doc_batches_container_count() FROM PUBLIC, anon, authenticated;

-- the transactions made / filled from a doc batch before this file
UPDATE public.transactions t
   SET container_count = k.n
  FROM (SELECT c.transaction_id, count(*)::int n FROM public.containers c GROUP BY c.transaction_id) k
 WHERE k.transaction_id = t.id AND t.cargo_unit_type IS DISTINCT FROM 'roro' AND t.container_count < k.n
   AND t.cancelled_at IS NULL   -- a cancelled transaction is frozen (legacy_norm → MRS_BAD_TRANSITION): left as it is
   AND EXISTS (SELECT 1 FROM public.doc_batches b WHERE b.transaction_id = t.id AND b.status = 'approved');
