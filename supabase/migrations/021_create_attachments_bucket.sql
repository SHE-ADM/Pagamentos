-- =============================================================
-- 021_create_attachments_bucket.sql
-- Bucket de Storage para os PDFs anexados (contas a pagar).
-- Projeto: pagamentos | Data: 2026-06-11
--
-- Contexto: os PDFs deixam de ser servidos do disco local (rota Flask /api/pdf)
-- e passam a viver no Supabase Storage. Assim qualquer computador autenticado
-- (ex.: quem efetua o pagamento) visualiza o anexo, independentemente de qual
-- maquina rodou o leitor de e-mail. O pipeline (read_emails.py, service_role)
-- faz o upload; o frontend gera uma URL assinada para exibir.
-- =============================================================

-- Bucket privado (sem acesso publico — leitura via URL assinada).
INSERT INTO storage.buckets (id, name, public)
VALUES ('attachments', 'attachments', false)
ON CONFLICT (id) DO NOTHING;

-- Leitura para usuarios autenticados — necessario para createSignedUrl no
-- frontend. Mesmo padrao do financial_account_control (app interno, usuarios
-- criados pelo admin). O service_role (upload no pipeline) ignora RLS.
DROP POLICY IF EXISTS "authenticated_read_attachments" ON storage.objects;
CREATE POLICY "authenticated_read_attachments"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'attachments');
