# Autenticação — detalhe operacional

> **Extraído do `CLAUDE.md` em 2026-08-18.** Aqui fica o *como* e o *porquê*; os invariantes
> (sem auto-registro, `app_metadata` server-controlled, troca obrigatória no 1º acesso) ficam
> no `CLAUDE.md`.

## As quatro telas

> **Alinhado com a régua do workspace em 2026-08-18** (`C:\Sheild\Projetos\Claude\CLAUDE.md`
> § AUTH STANDARD). Ela afirmava "exatamente estes **três** fluxos — nada mais" e ficou para trás:
> a 4ª tela é **consequência** do não-autorregistro, não uma extensão local do `pagamentos`.
> Quem cria usuário por fora define senha temporária, e senha que o admin conhece não pode
> sobreviver ao 1º login. O padrão do workspace passou a declarar as quatro.

`apps/frontend-vite/src/pages/auth/`:

| Rota | Componente | Chamada Supabase |
|---|---|---|
| `/auth/login` | `LoginPage` | `signInWithPassword` |
| `/auth/forgot-password` | `ForgotPasswordPage` | `resetPasswordForEmail` |
| `/auth/reset-password` | `ResetPasswordPage` | `updateUser` + `signOut` |
| `/auth/change-password` | `ChangePasswordPage` | `updateUser` (1º acesso — **não** desloga) |

A diferença entre as duas últimas: o `ResetPasswordForm` vem de link de e-mail e **desloga** ao
final; o `ChangePasswordForm` faz `updateUser({ password })`, depois
`POST /api/users/me/password-changed` (`requireAuth` → `userService.markPasswordChanged` via
Admin API) + `refreshSession()`, e segue para `/consulta` sem deslogar — o `TOKEN_REFRESHED`
atualiza o `AuthContext`.

## Criar usuário (admin only)

Supabase Dashboard → Authentication → Users → **Add user**, com **"Auto Confirm User"** marcado.
**NÃO** definir `password_changed` no metadata — a ausência da marca é justamente o que força a
troca no 1º acesso.

Usuários anteriores à correção foram marcados por backfill em `auth.users.raw_app_meta_data`
(`password_changed: true`). Quem ficou com a marca antiga em `raw_user_meta_data` é forçado a
trocar uma vez.

## 🔴 Alterar o e-mail de um usuário — Admin API, NUNCA `UPDATE` em `auth.users`

O e-mail vive em **dois lugares** (`auth.users.email` e `auth.identities.identity_data->>'email'`);
um `UPDATE` via SQL atualiza só o primeiro e deixa a identidade inconsistente.

```
PUT /auth/v1/admin/users/:id   { email, email_confirm: true }
```
(ou `auth.admin.updateUserById`). O `email_confirm` pula a confirmação por link, exigida de outra
forma pelo "Secure email change" (ON neste projeto).

**Preservado automaticamente:** o `id` (UUID) não muda, então senha,
`app_metadata.password_changed`, grupo (`user_profile.group_id`) e a autoria das contas
(`created_by`/`updated_by`/`status_changed_by`) sobrevivem intactos.

**O que EXIGE atenção** são as duas regras que casam por **TEXTO** do e-mail, não por UUID:

1. A RLS de `/emails` e `/erros` (migration 078) compara `lower(sender_email) = lower(auth.email())`
   — um usuário de grupo com `sees_only_own_accounts` (hoje só **Comercial**) **perde de vista**
   os e-mails enviados do endereço antigo.
2. `resolve_user_for_account(sender_email)` deixa de casar o endereço antigo; contas históricas
   seguem apontando para o dono já resolvido (o `created_by` é UUID), mas convém rodar a
   re-varredura se houver linhas com o endereço antigo.

Meça o impacto antes:

```sql
SELECT count(*) FROM email_control WHERE lower(sender_email) = '<e-mail antigo>';
-- idem email_processing_errors e financial_account_control
```

O usuário passa a logar com o e-mail novo, **mesma senha**; peça logout/login.

*Aplicado em 2026-07-17:* `lucas@otimotex.com.br` → `lucas@lebianco.com.br` (grupo Diretor, sem
`sees_only_own_accounts`, 0 linhas casando o endereço antigo → impacto nulo).

## Sessão

- **Estado:** `AuthContext`/`useAuth` (`src/contexts/AuthContext.tsx`), via `getSession()` +
  `onAuthStateChange`. Ao restaurar, aplica primeiro o early-out de inatividade (`isIdleExpired`);
  se não expirou, valida no servidor com `getUser()` — 401/403 desloga, falha de rede mantém
  otimisticamente.
- **Storage híbrido ("Lembrar-me"):** `supabaseClient.ts` usa `storage: hybridAuthStorage`
  (`src/lib/authStorage.ts`), roteado pela flag `pag:remember` no localStorage (`'1'`/`'0'`):
  marcado → `localStorage` (sobrevive ao fechar o navegador); desmarcado → `sessionStorage`.
  `LoginForm` chama `setRememberPreference(remember)` antes do `signIn`; o checkbox inicializa
  refletindo a última preferência salva. F5 na mesma aba mantém nos dois casos.
- **Logout por inatividade (teto de 30 min, vale nos dois modos):** `useIdleLogout`
  (`src/hooks/`), `VITE_SESSION_IDLE_MINUTES`. Marcador em `localStorage` (`pag:last-activity`,
  compartilhado entre abas); reiniciado no `SIGNED_IN`, limpo no `SIGNED_OUT`. O helper
  `isIdleExpired(timeoutMs)` é usado no `AuthContext.init()` para deslogar já na reabertura —
  assim "Lembrar-me" mantém a sessão por **no máximo 30 min** entre reaberturas, sem flash de
  conteúdo protegido.
- **Suspensão durante processamento:** `suspendIdleLogout()`/`resumeIdleLogout()` (contador no
  `useIdleLogout`) pausam o teto enquanto a leitura de e-mails roda (`Emails.handleRead` suspende
  no início e retoma no `finally`). Evita logout no meio de um processamento longo.
- **Rotas protegidas:** `ProtectedRoute.tsx` redireciona para `/auth/login` sem sessão.
- **RLS:** migration `015` trocou policies de leitura de `TO anon` para `TO authenticated` —
  `services/supabase.ts` envia `access_token` no header `Authorization` (além do `apikey`).
