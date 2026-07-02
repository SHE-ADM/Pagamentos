# Design — Permissões por grupo de usuário

> Status: **desenho aprovado; implementação NÃO iniciada.** Só a fundação `user_group`
> (migration 063) está aplicada. Este documento é o blueprint das *referências* para as
> próximas migrations + enforcement.

## Contexto e decisões

A autorização atual do projeto é um *claim* em `app_metadata` (`role`), sem tabela — lido
idêntico no back ([lib/auth.ts](../../apps/api-backend/lib/auth.ts) `isAdmin`) e no front
([AuthContext.tsx](../../apps/frontend-vite/src/contexts/AuthContext.tsx) `deriveIsAdmin`).
Evoluímos para um **RBAC relacional + escopo de linha por grupo**, no schema `public` (o `auth`
não é exposto à Data API e a Supabase desaconselha mexer nele).

Decisões travadas com o usuário:

1. **Vínculo usuário → grupo por FK real** (tabela `user_profile`), não pelo claim solto.
2. O grupo controla **três níveis**: acesso por **tela/menu**, **ações CRUD** e **visibilidade
   por linha**.
3. Visibilidade por linha filtra por **empresa + centro de custo + plano de contas** (3 dimensões).
4. **Configuração só via Supabase por enquanto** (SQL Editor/Dashboard) — sem tela de admin.
   Implementar apenas tabelas/referências + enforcement (guardas na Next API + RLS + menu).
5. **Semântica de escopo:** dimensão sem linhas = **vê tudo** naquela dimensão (restrição
   *opt-in*); dimensões combinam com **E (AND)**; `service_role` e `app_metadata.role='admin'`
   veem tudo (bypass).

## Modelo de referências (6 tabelas novas em `public`)

```
auth.users ─1:1─ user_profile ─N:1─ user_group ─1:N─ group_permission ─N:1─ permission
                (user_id,group_id)   (group_id)      (group_id,permission_id) (resource,action)
                                          │
                                          ├─1:N─ group_company        ─N:1─ company
                                          ├─1:N─ group_cost_center    ─N:1─ financial_cost_center
                                          └─1:N─ group_chart_account  ─N:1─ financial_chart_of_account
```

| Tabela | Colunas-chave | FKs | Papel |
|---|---|---|---|
| `user_profile` | `user_id` PK, `group_id` NOT NULL DEFAULT 0 | `user_id → auth.users(id)` ON DELETE CASCADE · `group_id → user_group(group_id)` | vínculo usuário → grupo (fonte de verdade) |
| `permission` | `permission_id` PK (IDENTITY), `resource`, `action` | `UNIQUE(resource, action)` | catálogo `(recurso, ação)` |
| `group_permission` | `(group_id, permission_id)` PK | `group_id → user_group` CASCADE · `permission_id → permission` CASCADE | grupo → permissões (tela + CRUD) |
| `group_company` | `(group_id, company_id)` PK | `group_id → user_group` CASCADE · `company_id → company` | escopo de linha por empresa |
| `group_cost_center` | `(group_id, cost_center_id)` PK | `group_id → user_group` CASCADE · `cost_center_id → financial_cost_center` | escopo por centro de custo |
| `group_chart_account` | `(group_id, chart_account_id)` PK | `group_id → user_group` CASCADE · `chart_account_id → financial_chart_of_account` | escopo por plano de contas |

Padrão de cada tabela (consistente com o projeto): `created_at`/`updated_at` + trigger
`fn_set_updated_at`; RLS `ENABLE` com `SELECT TO authenticated` + `ALL TO service_role`.
Índice nas colunas de FK (btree). Sem `deleted_at` (exclusão bloqueada por FK/CASCADE conforme
o caso). O `user_profile` ganha trigger `AFTER INSERT ON auth.users` (padrão canônico
"handle_new_user", `SECURITY DEFINER`) criando o perfil com `group_id=0`.

## Catálogo de recursos e ações (linhas de `permission`, semeadas via Supabase)

Recursos (da sidebar) × ações `view` / `create` / `edit` / `delete`. `view` = libera o item de
menu e a rota.

| Grupo (sidebar) | `resource` |
|---|---|
| Recebimentos | `emails`, `erros` |
| Envios | `cobranca_envios`, `cobranca_erros` |
| Contas | `consulta` (gestão), `contas` (cadastro), `fornecedores` |
| Tabelas | `centros_custo`, `bancos`, `contas_bancarias`, `plano_contas`, `grupos_plano`, `subgrupos_plano` |
| Análise | `dashboard` |

## Enforcement por camada

| Nível | Fonte | Onde trava | Motivo |
|---|---|---|---|
| Tela/menu | `group_permission` `resource:view` | frontend (esconde item + guarda rota) + guarda na Next API | UX + defesa |
| Ação CRUD | `group_permission` `resource:{create,edit,delete}` | **Next API** (`requirePermission(resource, action)`) | escrita usa `service_role` → RLS não pega; trava tem de ser no handler |
| Visibilidade de linha | `group_company`/`group_cost_center`/`group_chart_account` | **RLS** em `financial_account_control` | leitura do frontend é `authenticated` → RLS filtra as linhas |

### RLS do escopo de linha (semântica aprovada)

Sobre `financial_account_control` (leitura). Para cada dimensão, uma função `STABLE`
(ex.: `auth_group_sees_cost_center(cc)`) que retorna:

```
(sem linhas do grupo do usuário nessa dimensão)  OR  (o valor da linha está no conjunto liberado)
```

Policy de SELECT combinando as três com **AND**, mais bypass de admin:

```sql
USING (
  auth_is_admin()                       -- app_metadata.role='admin' → vê tudo
  OR (
        auth_group_sees_company(company_id)
    AND auth_group_sees_cost_center(cost_center_id)
    AND auth_group_sees_chart_account(chart_account_id)
  )
)
```

O grupo do usuário vem de `user_profile WHERE user_id = auth.uid()`. (Se o custo do subquery por
linha pesar, otimização futura: espelhar `group_id` no claim `app_metadata.group_id` e ler via
`auth.jwt()` — hoje fica pelo `user_profile` para manter a FK como fonte única.)

## Roadmap de implementação (quando liberar)

1. **Migration 064** — `user_profile` (+ trigger handle_new_user + backfill dos usuários atuais
   com group_id=0).
2. **Migration 065** — `permission` + `group_permission` + seed do catálogo de recursos×ações.
3. **Migration 066** — `group_company` + `group_cost_center` + `group_chart_account`.
4. **Migration 067** — funções `STABLE` de escopo + policy RLS de SELECT em
   `financial_account_control` (substitui a policy `authenticated_select` atual por uma com escopo).
5. **Backend** — helpers `belongsToGroup` / `requirePermission` em
   [lib/auth.ts](../../apps/api-backend/lib/auth.ts); aplicar `requirePermission` nas rotas de CRUD.
6. **Frontend** — carregar as permissões do usuário no `AuthContext`; esconder itens de menu
   ([Layout.tsx](../../apps/frontend-vite/src/components/Layout.tsx)) e guardar rotas por `resource:view`.
7. **Zod** — schemas dos novos cadastros em `@sheild/shared` (só leitura por ora; escrita fica no
   Supabase).

Cada passo é uma unidade testável; a config (linhas de `group_*`) é feita no Supabase.

## Estado atual

- **Aplicado:** migration 063 — `user_group` (catálogo) + `app_metadata.group_id=0` nos 3 usuários.
- **Pendente:** tudo acima (migrations 064–067 + enforcement). Nada iniciado.
