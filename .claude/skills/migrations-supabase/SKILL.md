---
name: migrations-supabase
description: >-
  Criar, aplicar e verificar migration SQL no Supabase do projeto `pagamentos`. Cobre as regras
  de DDL que já quebraram este banco antes: GRANT/REVOKE explícito em objeto novo, `DROP
  FUNCTION` que apaga os grants, coluna GERADA que exige DROP+ADD para recalcular, RLS
  habilitada sem policy devolvendo zero linhas, volatilidade de função em coluna gerada, sonda
  `DO $$` que aborta a própria migration, e como aplicar por psql quando o MCP não está
  disponível. Acione SEMPRE que o usuário disser "criar migration", "aplicar migration", "nova
  coluna", "mexer na RLS", "policy", "GRANT/REVOKE", "trigger", "função em analytics", ou quando
  uma alteração exigir DDL no Supabase — mesmo sem dizer "skill".
---

# Migrations no Supabase — `pagamentos`

**Changelog do que cada migration já aplicada fez:** [docs/db/historico-migrations.md](../../../docs/db/historico-migrations.md).
**Caveats operacionais** (ordem, migrations não re-executáveis, bootstrap): `supabase/migrations/README.md`.

## Antes de escrever qualquer coisa

```bash
ls supabase/migrations | tail -1     # a última aplicada — o próximo número é este + 1
```

🔴 **NUNCA reserve número com antecedência.** O roadmap reservou 109/110/111 para a Onda 5 e os
três foram consumidos por outro trabalho antes de ela começar. A tabela de um plano escrito há
meses não é fonte de verdade para isso.

🔴 **A base é COMPARTILHADA dev+prod.** Migration aplicada vale para os dois ambientes — não há
passo separado de banco no deploy. Isso torna toda migration uma operação de produção.

🔴 **Migration já aplicada é IMUTÁVEL.** Corrigir = criar migration nova. (O arquivo antigo pode
ser editado apenas quando a correção é textual e não altera o efeito — ex.: o `WHERE` que a 077
ganhou depois de aplicada.)

## Como aplicar

| Via | Quando | Cuidado |
|---|---|---|
| **Supabase MCP** (`apply_migration`) | preferido quando disponível | pode embrulhar **cada chamada** numa transação própria — `SET LOCAL ROLE` da 1ª some na 2ª |
| **psql** | MCP indisponível | usar `SUPABASE_DB_URL` **+ anexar `:5432/postgres`** (a URL omite porta e dbname) |
| SQL Editor do dashboard | manual | roda como `postgres`, que **ignora RLS** — não serve para verificar visibilidade |

🔴 **`psql` roda em AUTOCOMMIT.** Migration com mais de um passo abre transação **explícita**
(`BEGIN`/`COMMIT`) — sem isso, um erro no meio deixa o banco em estado **parcial** (foi o que
aconteceu na 131: CHECK novo aplicado, coluna gerada ainda antiga). E `CREATE TEMP TABLE …
ON COMMIT DROP` fora de transação é destruída no commit implícito do próprio CREATE.

## As sete armadilhas deste banco

### 1. 🔴 GRANT sozinho não basta — sem POLICY, o papel lê ZERO linhas

O Supabase **habilita RLS automaticamente** em toda tabela nova do `public`, e RLS ligada com
zero policies é **deny por default**. A 1ª versão da 111 concedeu `SELECT` a `authenticated` sem
policy: **0 dias visíveis** em `dim_date` e `dias_uteis()` devolvendo **0** — sem erro, sem
exceção. Escapou da verificação porque `psql` conecta como `postgres`, que ignora RLS.

```sql
BEGIN; SET LOCAL ROLE authenticated; SELECT count(*) FROM <tabela>; ROLLBACK;
```

**Privilégio concedido e linha visível são duas perguntas diferentes.**

### 2. 🔴 `DROP FUNCTION` APAGA OS GRANTS

Acrescentar coluna ao `RETURNS TABLE` muda o tipo de retorno ⇒ `CREATE OR REPLACE` é recusado
(**42P13**) ⇒ o par DROP+CREATE é obrigatório. Recriar sem reemitir `GRANT`/`REVOKE` deixa a
função **executável por `PUBLIC`** (default do PostgreSQL) e **inexecutável por `authenticated`**:
aberta para quem não deve, quebrada para quem deve. Lição da 116; já reincidiu na 118, 124 e 125.

**Toda função nova ou recriada leva os DOIS, explícitos:**

```sql
REVOKE EXECUTE ON FUNCTION analytics.f(...) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION analytics.f(...) TO authenticated;
```

Medido na Onda 1: as 4 funções recriadas pela 104 nasceram **executáveis por `anon`** (chamáveis
com a anon key pública, sem login). **Não confiar no default privilege.**

⚠️ Se a assinatura mudar de aridade, são **DOIS `DROP FUNCTION`** (a antiga e a nova) — com só um,
a **reexecução** falha com *"function already exists with same argument types"*. Lição da 119.

### 3. 🔴 Coluna GERADA — corrigir a regra exige DROP+ADD

`CREATE OR REPLACE` da função **não recalcula** os valores `STORED`: a coluna fica com o
resultado da regra antiga, em silêncio. E **nunca** force recálculo com `UPDATE ... SET x = x` —
dispara `trg_fe_status_vencimento` em todas as linhas e pode reescrever situações.

🔴 **A função usada precisa ser IMMUTABLE — confira no catálogo, não deduza da assinatura.**
`to_date(text,text)` tem `provolatile = 's'` (STABLE) e o PostgreSQL **recusa** a coluna gerada;
quem serve é `make_date` (`'i'`). O roadmap prescrevia `to_date` afirmando o contrário.

```sql
SELECT proname, provolatile FROM pg_proc WHERE proname IN ('to_date','make_date');
```

🔴 **Função usada em coluna gerada precisa de `GRANT EXECUTE` a `authenticated`** — a expressão é
avaliada com o privilégio de **quem escreve a linha**, e `authenticated` escreve aqui (grants por
coluna de `has_invoice`/`has_bank_slip`/`status_id`). Sem o grant, marcar "Tem NF" em `/consulta`
devolveria **42501**, num lugar sem relação com a coluna nova.

🔴 **Coluna gerada nova entra no `.omit()` do `financialAccountControlInputSchema`** — o
PostgreSQL recusa com **428C9** qualquer INSERT/UPDATE que a cite. Guarda G1 em
`tests/test_onda6_campos_derivados.py`.

### 4. 🔴 Objeto novo nasce gravável — o `REVOKE` faz parte da migration

O Supabase concede `INSERT/UPDATE/DELETE` a `authenticated` em **toda tabela e VIEW nova** do
`public`. A RLS costuma bloquear, mas em **view `security_invoker = false` ela não salva** — foi
escalada de privilégio real na view `app_user`, que permitia a qualquer usuário logado trocar o
e-mail de outro em `auth.users` e tomar a conta pelo "esqueci minha senha" (fechado pela 081).

Conferência (o esperado é **lista vazia**):

```sql
SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
WHERE grantee IN ('anon','authenticated')
  AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
```

🔴 **NUNCA `REVOKE UPDATE` em `financial_account_control` nem `email_control`** — derruba os
**grants por COLUNA** (`has_invoice`/`has_bank_slip`/`status_id`; `reviewed_at`) que sustentam a
curadoria inline. A 081 revoga só `INSERT, DELETE` nessas duas.

⚠️ **Tabela criada pelo Table Editor do dashboard nasce gravável e truncável por `anon`** — o
default do papel `supabase_admin` não é alterável sem superuser. **Crie tabela sempre por
migration**, nunca pela UI.

### 5. 🔴 `SECURITY INVOKER` vs `DEFINER` — a escolha errada vaza ou quebra

| Caso | Escolha | Por quê |
|---|---|---|
| View/função de `analytics` lida pelo chat | **INVOKER** | é o que faz a RLS de `financial_account_control` valer; `DEFINER` seria escalada silenciosa |
| Função de **trigger** que roda sob `authenticated` | **DEFINER** | a 072 revogou EXECUTE e quebrou **todo UPDATE do frontend** (regressão classe 074) |
| Trigger de auditoria (`fn_audit_row`) | **DEFINER** | `authenticated` teve INSERT revogado em `audit_log`; INVOKER quebraria a curadoria |

`DEFINER` sempre com `search_path` fixo e chamada qualificada (`public.f(...)`).

### 6. 🔴 `LEAST`/`GREATEST` IGNORAM NULL

Ao contrário dos operadores aritméticos. Sem `CASE WHEN x IS NULL`, `LEAST(NULL, a, b)` devolve o
menor dos não-nulos e a coluna sai preenchida com um número plausível e sem sentido. Lição da 125.

### 7. 🔴 Consulta REST cujo resultado vira dado gravado PRECISA paginar

O PostgREST corta no **"Max rows" (1.000)** e devolve **HTTP 200** — sem erro, sem sinal. Já
produziu 68 de 172 documentos fiscais sem proveniência. Paginar com `order=id&limit&offset`
(sem `ORDER BY` o offset pula linhas). Módulo compartilhado: `scripts/supabase_rest.py`.

## Sonda `DO $$` — a migration verifica a si mesma

Toda migration não-trivial termina com um bloco que **aborta** se o efeito não for o esperado.

```sql
DO $$
DECLARE v_esperado int; v_obtido int;
BEGIN
  -- P0: sanidade — a sonda exercitou dado de verdade?
  SELECT count(*) INTO v_esperado FROM <baseline>;
  IF v_esperado = 0 THEN RAISE EXCEPTION 'sonda vazia: nao provaria nada'; END IF;
  -- P1: oraculo diferencial — a funcao nova bate com uma consulta de controle independente
  ...
  IF v_obtido <> v_esperado THEN RAISE EXCEPTION 'divergencia: % <> %', v_obtido, v_esperado; END IF;
END $$;
```

Regras aprendidas:

- 🔴 **Nada de número mágico.** Capture o baseline **antes** do DDL numa TEMP TABLE e compare
  contra ele. A sonda P4 da 131 escrevia "41 colunas" à mão — e o número estava errado (eram 40).
- 🔴 **Oráculo diferencial**, não asserção sobre um total absoluto: o dado deriva em 24 h.
- 🔴 **Anti-vacuidade:** a sonda precisa provar que exercitou dado; `0 = 0` é verde para sempre.
- 🔴 **Congele o conjunto por id** quando o `UPDATE` altera a própria coluna do predicado —
  senão reavaliá-lo depois devolve zero linhas e a sonda "passa" sem provar nada (lição da 130).
- 🔴 **Sonda que só roda o caminho DEFAULT não prova o parametrizado.** Nenhuma das 8 sondas da
  121 pegou o bug B1 porque todas usavam `p_min_contas` no default.
- **Ensaie em `BEGIN … ROLLBACK`** antes de aplicar de verdade — é o jeito barato de testar DDL
  numa base compartilhada.
- ⚠️ **Nunca `TRUNCATE` a tabela real para testar trigger de TRUNCATE**: ele toma ACCESS
  EXCLUSIVE até o fim da transação e bloquearia o pipeline a cada reexecução. Prove a lógica numa
  tabela TEMP e o *binding* pelo catálogo.

## Depois de aplicar

```sql
-- 1. o papel real enxerga o que deve?
BEGIN; SET LOCAL ROLE authenticated; SELECT ...; ROLLBACK;

-- 2. quadro de privilégios
SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name='<t>';
```

- Rodar `get_advisors` (MCP) — é barato e pega RLS/policy esquecida.
- Se criou função em `analytics`, confirmar pelo **PostgREST**: `42501` com a anon key prova que
  o cache de schema já a enxerga **e** que `anon` está barrado (`PGRST202` significaria que ela
  nem foi vista).
- Atualizar [docs/db/historico-migrations.md](../../../docs/db/historico-migrations.md) com o que
  a migration fez e a lição que ela cobrou.
- Se a migration muda o domínio de uma coluna espelhada em Zod, rodar
  `py -3 -m pytest tests/test_doc_type_domain_consistency.py`.
