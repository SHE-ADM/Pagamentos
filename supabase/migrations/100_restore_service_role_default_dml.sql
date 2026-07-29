-- 100_restore_service_role_default_dml.sql
-- Restaura o DML do papel `service_role` no DEFAULT de tabelas novas, sem devolver nada a
-- `anon`/`authenticated`. Aplicada via Supabase MCP em 2026-07-29. Idempotente.
--
-- POR QUE ESTA MIGRATION EXISTE
-- Em 2026-07-29 o toggle **Data API → Settings → "Automatically expose new tables"** foi
-- DESLIGADO, para que tabela nova deixasse de nascer acessível aos papéis do PostgREST. O efeito
-- pretendido aconteceu, mas o Supabase trata **`service_role` como um "Data API role"** e o removeu
-- junto: o ACL default de TABLES no schema `public` para o papel criador `postgres` passou de
--
--     {postgres=arwdDxtm, anon=r, authenticated=r, service_role=arwdDxtm}
--   para
--     {postgres=arwdDxtm, service_role=Dxtm}
--
-- `Dxtm` = TRUNCATE, REFERENCES, TRIGGER, MAINTAIN — ou seja, **sem INSERT, SELECT, UPDATE e
-- DELETE**. E `service_role` é justamente o papel com que o pipeline Python e a Next API escrevem.
--
-- O RISCO ERA DE ARMADILHA, NÃO DE QUEBRA IMEDIATA: default privileges só valem para objetos
-- CRIADOS DEPOIS, então as 19 tabelas existentes seguiram intactas (verificado: 19/19 com
-- SELECT+INSERT+UPDATE para `service_role`). O problema apareceria na PRÓXIMA migration que
-- criasse uma tabela — o pipeline levaria `permission denied` ao gravar nela, com o sintoma
-- surgindo longe da causa (no meio de uma leitura de e-mails, dias depois).
--
-- POR QUE DEVOLVER SÓ AO `service_role` É SEGURO
-- A chave `service_role` é **server-side por definição**: vive no `.env` do pipeline e nas env vars
-- da Vercel, e nunca vai ao browser. Quem não pode ter privilégio por default é `anon`
-- (chave pública, no bundle JS) e `authenticated` — e esses continuam de fora, que era o ganho
-- pretendido ao desligar o toggle. O resultado é melhor que o estado anterior à mudança: antes,
-- `anon` e `authenticated` nasciam com SELECT.
--
-- O QUE ESTA MIGRATION **NÃO** RESOLVE (e não tem como resolver)
-- O ACL default do papel **`supabase_admin`** no `public` continua concedendo `arwdDxtm` — escrita
-- TOTAL — a `anon` e `authenticated`. É esse papel que cria tabela pelo **Table Editor do
-- dashboard**, e desligar o toggle NÃO o alterou. Não é corrigível por migration: verificado que o
-- papel usado por MCP/psql (`postgres`) **não é superuser nem membro de `supabase_admin`**, então
-- `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` é negado.
--   → Mitigação é de PROCESSO: **criar tabela sempre por migration, nunca pelo Table Editor.**
--     Se algum dia uma tabela for criada pela UI, ela precisa de REVOKE explícito no mesmo dia.
--
-- O schema `analytics` recebe o mesmo tratamento por simetria: a `098` já o deixou sem escrita para
-- anon/authenticated, mas nada havia sido dito sobre `service_role` — e o gateway do chat de IA
-- grava em `analytics.ai_chat_log` justamente com ele.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA analytics
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (executada após aplicar — em prosa, mesma convenção da 073/098/099)
-- ---------------------------------------------------------------------------
--
-- Criada uma tabela-sonda dentro de uma transação com ROLLBACK (sem deixar resíduo). Uma tabela
-- NOVA no schema `public` nasce com:
--
--     service_role  -> SELECT ✔  INSERT ✔  UPDATE ✔  DELETE ✔
--     anon          -> SELECT ✘  INSERT ✘
--     authenticated -> INSERT ✘
--
-- É o estado desejado: o backend escreve, e nenhum papel exposto pelo PostgREST recebe nada por
-- default. Repetir esse teste (CREATE TABLE + has_table_privilege + ROLLBACK) é a forma barata de
-- conferir o comportamento se o toggle do dashboard for mexido de novo.
