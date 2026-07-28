-- 097_revoke_default_write_grants.sql
-- Higiene de privilégios: remove os grants de ESCRITA que o Supabase concede por DEFAULT aos
-- papéis `anon` e `authenticated` em todo objeto novo do schema `public`, e corrige o DEFAULT
-- para que o problema não se repita a cada tabela criada.
--
-- MOTIVAÇÃO. O projeto já vinha revogando esses grants caso a caso (056, 057, 079, 081), mas a
-- receita de verificação documentada conferia apenas o papel `authenticated` — e por isso dois
-- resíduos passaram despercebidos. Medido no banco em 2026-07-28:
--
--   (a) `anon` mantinha INSERT/UPDATE/DELETE de TABELA INTEIRA em 16 tabelas do `public`,
--       incluindo `financial_account_control` (todas as colunas), `email_control`, `user_profile`,
--       `user_group`, `company` e `status`. Só `supplier`, `financial_type_group` e a view
--       `app_user` estavam limpas — exatamente as que as migrations 057 e 081 trataram.
--
--       NÃO era explorável: a RLS está ligada em todas elas e NÃO existe policy alguma para
--       `anon`, então todo DML dele já era negado por default-deny. O problema é de defesa em
--       profundidade — deixava a RLS como barreira ÚNICA entre a anon key (que é pública, vai no
--       bundle do browser) e a escrita na tabela de contas. Uma policy permissiva criada por
--       descuido, ou um ENABLE ROW LEVEL SECURITY esquecido num objeto novo, viraria escrita
--       total sem nenhuma segunda linha de defesa.
--
--   (b) TRUNCATE estava concedido a `anon` E a `authenticated` em praticamente todo o `public`.
--       TRUNCATE **não é filtrado por RLS** — nenhuma policy protege contra ele. Também
--       inalcançável hoje (o PostgREST não expõe TRUNCATE, e nem `anon` nem `authenticated`
--       podem abrir conexão: `rolcanlogin = false` nos dois; quem loga é o `authenticator`).
--       O risco é de FUTURO: qualquer caminho que execute SQL arbitrário sob esses papéis — o
--       `generate_sql` do chat de IA, se um dia for implementado com conexão direta — transforma
--       isso em apagar a tabela inteira, sem que a RLS interfira. Ver
--       docs/arquitetura-chat-ia-pagamentos.md §8.
--
-- CAUSA RAIZ (passo 3). `ALTER DEFAULT PRIVILEGES` do papel `postgres` no schema `public` concede
-- `arwdDxtm` (INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) a anon,
-- authenticated e service_role em TODA tabela nova. É por isso que "toda migration que cria objeto
-- novo deve terminar com o REVOKE" virou doutrina no CLAUDE.md: sem corrigir o DEFAULT, o passo 1
-- desta migration seria desfeito pelo próximo CREATE TABLE.
--
-- ============================================================================================
-- A ASSIMETRIA ENTRE OS PASSOS 1/2 (objetos EXISTENTES) E O PASSO 3 (objetos FUTUROS) É
-- DELIBERADA E LOAD-BEARING — NÃO "UNIFICAR":
--
--   * Passo 2 (existentes, `authenticated`) revoga SOMENTE TRUNCATE/REFERENCES/TRIGGER/MAINTAIN.
--     Revogar UPDATE aqui seria um BUG GRAVE: `authenticated` não tem UPDATE de tabela, tem
--     GRANTs POR COLUNA (migrations 030/033/068) — `has_invoice`, `has_bank_slip` e `status_id`
--     em `financial_account_control`, e `reviewed_at` em `email_control`. Um `REVOKE UPDATE ON
--     <tabela>` derruba também os privilégios por coluna do mesmo tipo (comportamento do
--     PostgreSQL), quebrando a curadoria inline de /consulta (marcar NF/Boleto, trocar situação)
--     e o "revisado" de /emails. Foi exatamente por isso que a migration 081 revogou apenas
--     INSERT e DELETE nessas duas tabelas.
--
--   * Passo 3 (futuros) revoga também INSERT/UPDATE/DELETE de `authenticated`, e isso é seguro
--     PORQUE default privileges valem só para objetos criados DEPOIS — não tocam em nenhum grant
--     por coluna já existente. Tabela nova nasce sem escrita; quando precisar, a migration que a
--     cria concede explicitamente o que for necessário (de preferência por coluna).
-- ============================================================================================
--
-- O QUE ESTA MIGRATION **NÃO** FAZ, DE PROPÓSITO:
--   * NÃO revoga SELECT de `anon`. Hoje isso é inócuo (nenhuma policy contempla `anon`, então ele
--     lê 0 linhas de qualquer forma), mas revogar mudaria a resposta de "conjunto vazio" para
--     "permission denied" — diferença observável, sem ganho de segurança real. Fica como decisão
--     à parte.
--   * NÃO mexe em SEQUENCES nem em FUNCTIONS. Os defaults também concedem `rwU` em sequences a
--     anon/authenticated; sem INSERT nas tabelas isso não é alcançável, e `setval` não é
--     exposto pelo PostgREST. Escopo mantido em tabelas para a mudança ser revisável.
--   * NÃO altera os default privileges do papel `supabase_admin` (que existem e concedem o mesmo
--     `arwdDxtm`) — exigiria superuser, que o papel `postgres` não é. Na prática as tabelas deste
--     projeto são criadas por `postgres` (SQL Editor / MCP / psql), então o passo 3 cobre o caso
--     real. Se algum dia uma tabela nascer criada por `supabase_admin`, o REVOKE explícito volta
--     a ser necessário para ela.
--   * NÃO toca em `service_role` (que deve mesmo ter tudo) nem nas policies de RLS.
--
-- REVERSÃO: é tudo GRANT/REVOKE, reversível. Para desfazer, conceder de volta o que foi revogado
-- (ver o bloco de verificação no fim).
--
-- REQUER PostgreSQL 17+ por causa do privilégio MAINTAIN (introduzido na 17). O banco é 17.6.
--
-- Idempotente: REVOKE é naturalmente idempotente (revogar o que já não existe é no-op).

-- ---------------------------------------------------------------------------
-- 1. Objetos EXISTENTES — `anon` perde toda a escrita (mantém SELECT)
-- ---------------------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
    ON ALL TABLES IN SCHEMA public
  FROM anon;

-- ---------------------------------------------------------------------------
-- 2. Objetos EXISTENTES — `authenticated` perde só o que nunca deveria ter tido
--    ATENÇÃO: sem UPDATE/INSERT/DELETE nesta lista. Ver a nota da assimetria acima.
-- ---------------------------------------------------------------------------

REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
    ON ALL TABLES IN SCHEMA public
  FROM authenticated;

-- ---------------------------------------------------------------------------
-- 3. Objetos FUTUROS — corrige o DEFAULT para o resíduo não voltar
-- ---------------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
    ON TABLES FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
    ON TABLES FROM authenticated;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (rodar depois; as duas primeiras devem voltar VAZIAS)
-- ---------------------------------------------------------------------------
--
-- 1) Nenhuma escrita de tabela sobrando para anon/authenticated:
--
--    SELECT table_name, grantee, privilege_type
--      FROM information_schema.role_table_grants
--     WHERE table_schema = 'public'
--       AND grantee IN ('anon','authenticated')
--       AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
--
-- 2) Nenhum default de escrita sobrando para o papel postgres:
--
--    SELECT defaclacl::text FROM pg_default_acl d
--      JOIN pg_namespace n ON n.oid = d.defaclnamespace
--     WHERE n.nspname = 'public' AND d.defaclobjtype = 'r'
--       AND pg_get_userbyid(d.defaclrole) = 'postgres'
--       AND defaclacl::text ~ '(anon|authenticated)=[^/]*[awd]';
--
-- 3) OS GRANTS POR COLUNA DA CURADORIA PRECISAM CONTINUAR LÁ — esperado 4 linhas:
--    has_invoice / has_bank_slip / status_id (financial_account_control) e
--    reviewed_at (email_control), todas UPDATE para authenticated.
--
--    SELECT table_name, column_name, privilege_type
--      FROM information_schema.column_privileges
--     WHERE table_schema = 'public' AND grantee = 'authenticated'
--       AND privilege_type = 'UPDATE'
--     ORDER BY table_name, column_name;
