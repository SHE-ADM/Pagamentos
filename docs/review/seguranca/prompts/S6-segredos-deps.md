# S6 — Segredos e dependências

> Gerado pela auditoria de segurança de 2026-07-08. Aplicar na branch `Features`.
> Origem: `docs/review/seguranca/RELATORIO-SEGURANCA.md` §6. Nenhum segredo versionado — só higiene de deps.

```xml
<objetivo>
  Resolver a vulnerabilidade moderada de postcss (build-time, via next) por atualização de dependência e
  registrar a higiene de deps Python. Nenhuma ação de rotação de segredo se aplica (nada versionado).
</objetivo>

<read_first>
  - package.json (raiz) + apps/api-backend/package.json + apps/portal-next/package.json (dep next)
  - package-lock.json (árvore: next → postcss)
  - server/requirements.txt
  - .gitignore (confirmado cobrindo .env/data/logs/backups) — não alterar
</read_first>

<achados>
  - [MÉDIO] S6-1 — postcss <8.5.10 (GHSA-qx2v-qp2m-jg93), 2 vulns moderadas, transitivo de next (api-backend,
    portal-next). Build-time, CSS estático do time → sem exposição de runtime. Não é bloqueador.
  - [BAIXO] S6-2 — VITE_IMAP_USER no bundle (Emails.tsx:318) — e-mail, não credencial (ver S5).
  - [INFO] pip list --outdated: updates menores sem CVE (cryptography 48→49, requests, urllib3, pillow, pypdf...).
</achados>

<correcao>
  1. S6-1: bump do next para a linha que traz postcss ≥8.5.10 (`npm update next` no(s) workspace(s) afetado(s),
     ou fixar a resolução de postcss ≥8.5.10 via override no package.json da raiz se o next ainda não subiu).
     Rodar `npm audit --omit=dev` até zerar as 2 moderadas. Validar que api-backend e portal-next continuam
     buildando (next 16 → conferir changelog se o bump for de minor).
  2. INFO (higiene Python, opcional, próxima janela): atualizar em server/requirements.txt (mantendo o pin ~=)
     os pacotes de superfície de rede/parsing — cryptography, urllib3, requests, pillow — e rodar pytest.
  3. S6-2: tratado no S5 (opcional). Sem ação obrigatória aqui.
</correcao>

<restricoes>
  - NÃO commitar .env nem transcrever segredo. .gitignore já cobre — não relaxar.
  - Não subir next em major sem validar o build dos dois apps Next (carve-out ESLint 9/10 documentado).
  - Manter os pins ~= do requirements.txt (dev/prod não devem divergir).
</restricoes>

<validacao>
  - npm audit --omit=dev  → 0 vulnerabilidade (ou só as aceitas e documentadas).
  - npm run build:api && npm run build:portal  (os dois apps Next buildam após o bump).
  - npm run lint && npm run typecheck && npm test
  - py -3 -m pytest tests/ -q  (se atualizar deps Python).
</validacao>

<criterio_de_aceite>
  `npm audit --omit=dev` sem vulnerabilidades moderadas de postcss (ou documentadas como build-time aceito).
  Builds dos apps Next verdes. Nenhum segredo versionado (mantido). Gate verde.
</criterio_de_aceite>
```
