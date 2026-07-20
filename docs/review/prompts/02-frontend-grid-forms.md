# Prompt de correção — Frontend (grid, forms, requisições, React Compiler)

> Gerado pela revisão pré-produção de 2026-07-08. Aplicar na branch `Features`.
> Origem: `docs/review/RELATORIO-CODE-REVIEW.md` §3. Só achados BAIXO nesta área.

```xml
<objetivo>
  Corrigir um filtro de intervalo de datas latente/malformado no serviço de cobrança e uma chamada impura
  (new Date()) no corpo de render do Dashboard. Ambos BAIXO; nenhuma regressão de comportamento visível.
</objetivo>

<read_first>
  - apps/frontend-vite/src/services/cobrancaService.ts (fetchErrosLog :93-94 e fetchEnviosLog :74-79)
  - apps/frontend-vite/src/pages/cobranca/CobrancaErros.tsx (:65-70 — o que a página realmente envia)
  - apps/frontend-vite/src/pages/Dashboard.tsx (:36)
  - apps/frontend-vite/src/pages/Consulta.tsx:164-219 (padrão de estado inicial lazy — modelo)
</read_first>

<achados>
  - [BAIXO] A2-1 — cobrancaService.ts:93-94: params['occurred_at'] = 'gte.${dateFrom},lte.${dateTo}...' — a
    vírgula quebra a sintaxe PostgREST (o valor de gte engole ',lte...'). Latente: CobrancaErros.tsx não
    envia dateFrom/dateTo hoje, mas o ramo quebra se um filtro de período for ligado.
  - [BAIXO] A2-2 — Dashboard.tsx:36: `const now = new Date()` no corpo de render (impuro), contra o padrão do
    projeto e o §5 (React Compiler / pureza de render).
</achados>

<mudancas_exigidas>
  1. A2-1: reescrever o filtro de intervalo usando o mesmo padrão de fetchEnviosLog — um parâmetro `and`:
     `params['and'] = '(occurred_at.gte.${dateFrom},occurred_at.lte.${dateTo}T23:59:59)'` (cada condição com
     o nome da coluna, dentro do grupo `and`). Manter o ramo de data única funcionando.
  2. A2-2: mover a leitura da data para inicialização lazy do estado, ex.:
     `const [month, setMonth] = useState(() => new Date().getMonth())` e o mesmo para o ano — removendo o
     `const now = new Date()` do corpo do componente.
</mudancas_exigidas>

<restricoes>
  - Não alterar o comportamento visível do Dashboard nem da tela de erros de cobrança.
  - Manter `void load()` nos effects de fetch-on-change (padrão aceito no §5) — não é alvo.
  - Não tocar na cascata centro→plano nem no DataGrid (fora de escopo; confirmados OK no relatório).
</restricoes>

<validacao>
  - npm run lint && npm run typecheck && npm test
  - Teste manual: abrir /dashboard_vencimentos (mês/ano corretos) e /cobranca/erros (lista carrega).
  - Se adicionar cobertura, incluir um teste de cobrancaService montando a query de período e asseverando o
    formato `and=(occurred_at.gte.…,occurred_at.lte.…)`.
</validacao>

<criterio_de_aceite>
  Gate verde. Query de período do serviço de cobrança em sintaxe PostgREST válida. Dashboard sem chamada
  impura no render (estado inicial via inicializador lazy). Sem mudança visível de UX.
</criterio_de_aceite>
```
