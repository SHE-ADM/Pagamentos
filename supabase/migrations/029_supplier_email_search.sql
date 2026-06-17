-- =============================================================
-- 029_supplier_email_search.sql
-- Habilita a busca por e-mail do fornecedor (email, email2, email3, email4)
-- no search input de /consulta e cria os indices de pesquisa.
-- Projeto: pagamentos | Data: 2026-06-17
--
-- Contexto:
--   O search input de /consulta filtra financial_account_control por
--   supplier_name, supplier_cnpj, invoice_number, subject e sender_email.
--   Para tambem casar pelos e-mails CADASTRADOS do fornecedor (que vivem em
--   supplier.email/email2/email3/email4 — migrations 023/027/028), o frontend
--   pre-resolve os supplier_id cujos e-mails batem com o termo e injeta um
--   supplier_id IN (...) no OR da consulta de contas.
--
-- Mudancas:
--   1. RLS: supplier tinha RLS habilitado mas SEM policy de leitura — o
--      frontend (papel authenticated) nao conseguia consultar a tabela.
--      Adiciona o mesmo padrao "authenticated read" das demais tabelas
--      (migrations 012/015/018/019), liberando SELECT para usuarios logados.
--   2. Indices de pesquisa: GIN trigram (pg_trgm) em email/email2/email3/email4
--      para acelerar o ILIKE '%termo%' (busca por substring com wildcard a
--      esquerda — btree nao atende).
-- =============================================================

-- pg_trgm habilita os operadores de similaridade usados pelo indice trigram.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 1. Policy de leitura para o papel authenticated.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS authenticated_select_supplier ON supplier;

CREATE POLICY authenticated_select_supplier
  ON supplier
  FOR SELECT
  TO authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- 2. Indices de pesquisa — GIN trigram por coluna de e-mail.
--    Suportam o ILIKE '%termo%' usado na busca por substring.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_supplier_email_trgm
  ON supplier USING GIN (email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_supplier_email2_trgm
  ON supplier USING GIN (email2 gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_supplier_email3_trgm
  ON supplier USING GIN (email3 gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_supplier_email4_trgm
  ON supplier USING GIN (email4 gin_trgm_ops);
