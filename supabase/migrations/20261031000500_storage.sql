-- =====================================================================
-- Marsa — STAGING / PROTOTYPE. 0500 — private Storage bucket "documents".
--
-- Object name convention (enforced by public.documents.documents_path_chk):
--   {org_id}/{transaction_id}/{document_id}/{file name}
--   {org_id}/r_{request_id}/{document_id}/{file name}       (before conversion)
--
-- Upload flow: 1) INSERT public.documents (id generated client-side, sha256
-- computed in the browser) → 2) upload the bytes to exactly storage_path.
-- Reads: a signed-in user can read an object only if they can SELECT the
-- matching public.documents row (the documents RLS policy decides).
-- No UPDATE / DELETE policies: originals are immutable (new version = new row).
-- =====================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('documents', 'documents', false, 26214400,
        ARRAY['application/pdf','image/jpeg','image/png','image/webp','image/heic',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS marsa_documents_read ON storage.objects;
DROP POLICY IF EXISTS marsa_documents_insert ON storage.objects;
DROP POLICY IF EXISTS marsa_documents_no_update ON storage.objects;
DROP POLICY IF EXISTS marsa_documents_no_delete ON storage.objects;

-- read: evaluated as the caller, so public.documents RLS applies inside the EXISTS
CREATE POLICY marsa_documents_read ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'documents'
  AND EXISTS (SELECT 1 FROM public.documents d
              WHERE d.storage_bucket = 'documents' AND d.storage_path = storage.objects.name)
);

-- insert: only into the path of a document row the caller registered (within 24h)
CREATE POLICY marsa_documents_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'documents'
  AND array_length(storage.foldername(name), 1) = 3
  AND EXISTS (SELECT 1 FROM public.documents d
              WHERE d.storage_bucket = 'documents'
                AND d.storage_path = storage.objects.name
                AND d.uploaded_by = auth.uid()
                AND d.voided_at IS NULL
                AND d.uploaded_at > now() - interval '24 hours')
);
-- (deliberately no UPDATE / DELETE policy → upsert/overwrite/delete are refused)
