# S1 — AuthN/Z (troca de senha, sessão, matcher)

> Gerado pela auditoria de segurança de 2026-07-08. Aplicar na branch `Features`.
> Origem: `docs/review/seguranca/RELATORIO-SEGURANCA.md` §1.

```xml
<objetivo>
  Tornar a "troca obrigatória de senha" imposta pelo servidor (hoje só client-side, via user_metadata
  gravável pelo cliente), ancorar o matcher do middleware e reduzir o risco do token de longa duração.
</objetivo>

<read_first>
  - apps/frontend-vite/src/components/organisms/ChangePasswordForm.tsx:38-41
  - packages/shared/src/schemas/auth.schema.ts:52-55 (mustChangePassword / PASSWORD_CHANGED_META_KEY)
  - apps/frontend-vite/src/components/ProtectedRoute.tsx:20
  - apps/api-backend/lib/auth.ts (requireAuth/requireAdmin), lib/users.ts (auth.admin.updateUserById)
  - apps/api-backend/middleware.ts:19
  - apps/frontend-vite/src/hooks/useIdleLogout.ts:18-26, contexts/AuthContext.tsx:57,86-93
  - apps/frontend-vite/src/lib/supabaseClient.ts:21-27, lib/authStorage.ts:33-48
</read_first>

<achados>
  - [MÉDIO] S1-1 — troca de senha só imposta em ProtectedRoute (React), lendo user_metadata.password_changed
    (client-writable); nenhuma rota da Next API verifica. Burlável marcando a flag sem trocar a senha, ou
    usando o access_token direto contra a API.
  - [MÉDIO] S1-2 — access_token em localStorage quando "Lembrar-me" (exposto a XSS futuro). Contido hoje (S5
    confirma sem XSS), mas eleva o impacto de qualquer XSS a takeover.
  - [BAIXO] S1-3 — middleware.ts:19 matcher '/api/((?!health|auth/login).*)' sem âncora de segmento.
  - [BAIXO] S1-4 — teto de inatividade (10 min) só client-side; apagar pag:last-activity "esquece" o teto.
</achados>

<correcao>
  1. S1-1: mover a marca de "senha trocada" para app_metadata (server-controlled). Fluxo mínimo: após o
     updateUser de senha no ChangePasswordForm, chamar um endpoint novo (ex.: POST /api/users/me/password-changed,
     requireAuth) que usa auth.admin.updateUserById para setar app_metadata.password_changed=true; o gate
     (ProtectedRoute + qualquer checagem futura no backend) passa a ler app_metadata. Manter o fluxo de UX.
     Nunca confiar em user_metadata para autorização. (Se o custo for alto, no mínimo documentar explicitamente
     que a troca é "higiene de 1º acesso" e NÃO uma barreira de segurança, alinhando o CLAUDE.md ao real.)
  2. S1-3: ancorar o matcher — '/api/(?!health$|auth/login$).*' (mesma mudança do code review A1-5; fazer uma vez).
  3. S1-4 + S1-2: encurtar a expiração do JWT do Supabase (config do projeto) e/ou revogar refresh token no
     signOut; documentar que o cap de 10 min é UX. Complementa a CSP do S5.
</correcao>

<restricoes>
  - Não introduzir auto-registro (signUp) — cadastro segue admin-only.
  - Não quebrar o fluxo "Lembrar-me" nem o logout por inatividade existentes.
  - Não trocar a arquitetura de sessão para cookie HttpOnly sem decisão explícita (fora deste escopo).
</restricoes>

<validacao>
  - npm run lint && npm run typecheck && npm test
  - Teste de vetor (NÃO contra produção): com um usuário de teste, marcar user_metadata.password_changed via
    updateUser SEM trocar a senha → confirmar que, após a correção, o gate ainda força a troca (a fonte é
    app_metadata). Chamar /api/* com o access_token de um usuário que não trocou a senha → comportamento esperado.
  - Verificar que /api/health e /api/auth/login seguem públicos após ancorar o matcher.
</validacao>

<criterio_de_aceite>
  A obrigatoriedade da troca de senha não depende de campo client-writable (ou a doc deixa claro que é só UX).
  Matcher casa rota exata. Documentação do teto de inatividade coerente com a implementação. Gate verde.
</criterio_de_aceite>
```
