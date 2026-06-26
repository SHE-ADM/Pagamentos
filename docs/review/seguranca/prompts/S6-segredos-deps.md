# S6 — Segredos e dependências

> Base: `docs/review/seguranca/RELATORIO-SEGURANCA.md` §6. Segredos OK; deps com bumps a acompanhar.

```xml
<objetivo>
  Manter a higiene de segredos (já OK) e tratar as dependências com aviso de segurança/desatualização,
  sem aplicar upgrade breaking (next@9) e mantendo o pin `~=` do Python.
</objetivo>

<read_first>
  - .gitignore
  - package.json (raiz) + apps/*/package.json (next, postcss)
  - server/requirements.txt
</read_first>

<achados>
  - INFO (npm audit --omit=dev): 2 moderate — postcss <8.5.10 (XSS no CSS stringify) BUNDLADO pelo next, e next dependendo dele.
    Vetor de build de CSS, não runtime do app. `npm audit fix --force` instala next@9 (breaking) — NÃO aplicar.
  - INFO (pip outdated): cryptography 48→49, urllib3 2.6.3→2.7.0, requests 2.32.5→2.34.2, certifi, anthropic, pdfplumber, pypdfium2.
  - OK: nenhum .env versionado/no histórico; .gitignore cobre .env/data/logs; só a anon key (pública) no bundle.
</achados>

<correcao>
  1. npm: NÃO rodar `audit fix --force`. Registrar o aviso e acompanhar uma release do `next` que atualize o postcss
     bundlado; reavaliar `npm audit --omit=dev` após o próximo bump do Next. Como é vetor de build (não runtime do app),
     não bloqueia — documentar a decisão de aceitar temporariamente.
  2. Python: na próxima janela, subir os pins de `urllib3`, `requests` e `cryptography` em server/requirements.txt
     (relevantes ao download-por-link e TLS), mantendo o operador `~=` e rodando a suíte:
     - editar `~=` para a nova minor (ex.: `urllib3~=2.7`), `pip install -r server/requirements.txt`, `py -3 -m pytest tests/ -q`.
     - NÃO subir tudo de uma vez sem testar; um pacote por commit se houver risco.
  3. Confirmar que `.gitignore` segue cobrindo `.env`, `apps/*/.env*`, `data/pdfs_inbox`, `data/csv_output`, `data/samples/**`, `logs/`.
     Não versionar nenhum PDF/CSV real (conteúdo sensível) — só os `.gitkeep`/README de samples.
</correcao>

<restricoes>
  - NÃO aplicar upgrade breaking (next@9). NÃO remover o pin `~=` do Python. NÃO commitar segredo nem dado real de data/.
  - Se encontrar segredo no histórico (não encontrado nesta auditoria), a ação é ROTACIONAR + remover do histórico — nunca transcrever o valor.
</restricoes>

<validacao>
  - npm audit --omit=dev (registrar a saída antes/depois)
  - py -3 -m pip list --outdated
  - Após bumps Python: py -3 -m pytest tests/ -q + py -3 skills\cobranca-vencidos\scripts\run.py --dry-run
  - npm run lint && npm run typecheck && npm test (deps JS não mudam — confirmar verde)
</validacao>

<criterio_de_aceite>
  - Decisão sobre o aviso do next/postcss registrada (aceito temporariamente, vetor de build).
  - urllib3/requests/cryptography atualizados (ou plano datado), suíte verde. .gitignore confirmado.
</criterio_de_aceite>
```
