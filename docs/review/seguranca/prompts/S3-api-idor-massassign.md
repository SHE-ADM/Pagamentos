# S3 — Next API: vazamento de erro no 500 (information disclosure)

> Base: `docs/review/seguranca/RELATORIO-SEGURANCA.md` §3. Mass assignment e IDOR já estão OK — foco no 500.

```xml
<objetivo>
  Parar de ecoar a mensagem crua de Postgres/PostgREST nas respostas 500 de todas as rotas, sem
  alterar os 4xx curados (422/409/404/400) nem o contrato {success,...}. Logar o detalhe server-side.
</objetivo>

<read_first>
  - apps/api-backend/lib/response.ts (fail)
  - apps/api-backend/lib/{contas,suppliers,cost-centers,banks,financial-accounts,chart-accounts,chart-account-groups,chart-account-subgroups,lookups,users}.ts
  - apps/api-backend/app/api/**/route.ts (os catch que fazem fail(e.message, 500))
</read_first>

<achados>
  - MÉDIO M-2: error.message cru de Postgres ecoado em TODOS os 500. Ex.: lib/contas.ts:153, lib/suppliers.ts:154/227,
    lib/lookups.ts:65/94, lib/cost-centers.ts:141/207, ecoado nos handlers via fail(e.message, 500). Vaza nomes de
    tabela/coluna/constraint (information disclosure). Os 4xx usam mensagens pt-BR curadas (seguros).
  - BAIXO B-2: financial-accounts hard-delete sem guarda (intencional) — reconfirmar no go-live, não alterar.
</achados>

<correcao>
  1. Padronizar o 500 para uma mensagem genérica:
     - Nos services, ao tratar erro de banco que vira 500, lançar o *ServiceError com mensagem fixa
       (ex.: 'Erro interno ao processar a solicitação') e fazer `console.error('[<recurso>]', error.message)` (server-side, não ao cliente).
     - Nos handlers, no fallback `return fail(e instanceof Error ? e.message : 'Erro inesperado', 500)`, trocar para uma
       mensagem genérica fixa em 500 — nunca `e.message`. Os caminhos que mapeiam *ServiceError com status 4xx (mensagem curada) seguem ecoando a mensagem (são seguros e testados).
     - Opcional: helper em lib/response.ts (`serverError(logDetail: string)`) que loga e devolve fail genérico — reutilizado pelos handlers.
  2. Manter EXATAMENTE os 4xx atuais (422 Zod, 409 23505/FK, 404, 400 id) e suas mensagens — não regredir os testes co-locados.
  3. Testes: para 1–2 recursos, adicionar caso que força erro de banco genérico (mock retornando error com code != 23505) e
     assertar que o corpo do 500 NÃO contém a string crua do banco (ex.: não vaza 'column'/'relation').
  4. B-2: apenas registrar no PR a reconfirmação de que nenhuma FK referencia financial_account (não alterar o hard-delete).
</correcao>

<restricoes>
  - NÃO alterar mass assignment (já mitigado: Zod strip + só parsed.data ao DB) nem a validação de id.
  - NÃO mudar os status codes nem as mensagens 4xx curadas. NÃO logar segredo.
</restricoes>

<validacao>
  - npm run lint && npm run typecheck && npm test
  - npm run prune
  - Vetor: provocar 500 (mock) e confirmar corpo genérico (teste novo).
</validacao>
<criterio_de_aceite>
  - Nenhum 500 ecoa mensagem crua de Postgres/PostgREST; detalhe vai só para o log server-side.
  - 4xx inalterados; gate verde.
</criterio_de_aceite>
```
