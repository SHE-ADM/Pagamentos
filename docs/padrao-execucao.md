# Padrão de execução e robustez técnica

Ao criar, atualizar ou refatorar qualquer rotina, cumprir os critérios abaixo ANTES de
reportar a tarefa como concluída. Não afirmar "está tudo ok" sem ter executado esta
verificação de fato.

## Critérios obrigatórios de aceite

- Tratar nulos, vazios, valores default e edge cases de forma explícita.
- Controle transacional correto: commit/rollback explícito, sem transação órfã ou
  conexão/recurso não liberado.
- Tratamento de exceção com log e rastreabilidade — nunca silenciar erro (sem `except`/`catch`
  vazio engolindo falha). Em Python, preferir `logging.exception()` dentro de `except`
  (traceback preservado).
- Validar parâmetros de entrada e contratos (tipos, tamanho, faixa, obrigatoriedade). Em
  TypeScript, os schemas Zod são a fonte única de verdade dos contratos.
- Verificar regressão: garantir que o comportamento existente continua funcionando após a
  alteração (rodar `npm test` / `pytest` conforme a camada tocada).

## Padrões específicos da stack

- **Python (Flask + pipeline `skills/`/`server/`):** timeout explícito em toda I/O externa
  (IMAP, HTTP/download, Claude API) com retry/backoff; fechar conexões/cursores/sockets em
  `try/finally`; nunca `except` vazio nem genérico que esconda bug (separar falha de rede
  esperada de erro inesperado); manter a lógica em fonte única (`run_reader()`), sem duplicar
  no Flask.
- **TypeScript / React 19 / Next.js 16:** tipagem estrita (sem `any` fora de teste); contratos
  via **Zod 4** em `@sheild/shared` como fonte única; tratar estados de loading/erro/vazio
  explicitamente; envelope de resposta padronizado por camada (`{ ok }` Flask ·
  `{ success, data, error }` Next API); erro 5xx nunca vaza detalhe interno; respeitar Atomic
  Design + Tailwind e acessibilidade WCAG 2.1 AA.
- **PostgreSQL (Supabase):** migrations numeradas e idempotentes; RLS habilitado por padrão
  (leitura `TO authenticated`, escrita `service_role`), com REVOKE dos grants default em todo
  objeto novo; consultas sempre parametrizadas (via PostgREST/SDK, sem concatenar SQL); índices
  nas colunas de busca; controle transacional e triggers revisados quanto à ordem de execução.
- **Firebird 5 (driver `fdb`, via Python):** queries **parametrizadas** (sem concatenação de
  SQL — evitar injeção); validar tipos e charset da conexão; fechar datasets/cursores/conexões
  explicitamente; transação com commit/rollback explícito (sem transação órfã); revisar o plano
  de execução em queries críticas de performance.
- **Modelagem / DW / ETL:** manter padrões já definidos — `sk_` para surrogate keys, distinção
  entre chave natural e técnica, status como dimensão. ETL incremental deve ser **idempotente**
  e ter controle/log de carga e rastreabilidade.
- **PowerShell (Task Scheduler `scheduler/`):** exit code correto (0 = sucesso; ≠ 0 marca a
  tarefa vermelha + Event Log); log com retenção; caminhos relativos a `$PSScriptRoot`.
- **Nomenclatura técnica em inglês comercial** (DW, ETL, APIs, modelagem de dados, arquitetura).

## Autorrevisão adversarial (fechamento)

Antes de concluir, revisar o próprio código de forma adversarial, perguntando "o que quebra
isto?". Testar mentalmente os caminhos de falha e listar riscos residuais, se houver. Só então
reportar concluído.

## Escopo por risco

Aplicar verificação de fechamento reforçada em tarefas de alto risco: migrations
(PostgreSQL/Firebird), controle transacional, ETL incremental, concorrência, deploy/alterações
em produção (que aqui é **cópia manual de arquivos**, nunca `deploy-prod.ps1` sem pedido
explícito).
