# Skill: baixa-automatica

Duas regras de negócio **independentes** sobre `financial_account_control` — quarto
pipeline (infra) do projeto, paralelo a `email-reader` (entrada), `cobranca-vencidos`
(saída) e `backup-supabase`. Mesmo script (`run.py`), mesma tarefa agendada; as duas
regras não compartilham filtro, elegibilidade nem status alvo, e rodam **isoladas** uma
da outra (falha numa não impede a outra — ver "Isolamento das duas etapas" abaixo).

## Regra 1 — Baixa (pago)

Uma conta em `financial_account_control` é considerada **paga** (`status_id = 8`) quando,
**todas** as condições valem:

| Condição | Coluna |
|---|---|
| Nota fiscal confirmada na curadoria | `has_invoice = true` |
| Boleto confirmado na curadoria | `has_bank_slip = true` |
| Vencimento igual ou anterior a hoje | `due_date <= hoje` (data local) |
| Situação ainda EM ABERTO | `status_id IN (1, 2, 3)` (pendente / vencido / a vencer) |

Situações **fechadas** (cancelado 9, baixado 5, protestado 6, cartório 7, prorrogado 4,
já pago 8) são **preservadas** — a baixa nunca reabre nem sobrescreve um estado fechado.
A regra **não** reverte: desmarcar NF/BOL depois não desfaz o "pago".
Funções: `build_filter` / `count_eligible` / `apply_baixa`.

**Duas instâncias (mesma regra):**

1. **No ato da edição (`/consulta`, frontend)** — ao marcar a 2ª flag (NF ou BOL) de uma
   conta vencida e em aberto, o app grava `status_id = 8` na hora
   (`qualifiesForAutoPago` em `apps/frontend-vite/src/pages/Consulta.tsx`).
2. **Batch diário (esta skill)** — cobre as contas cujo `due_date` "passa" com o tempo
   sem nenhuma edição disparar a baixa.

## Regra 2 — Marcação de vencidos

Uma conta em `financial_account_control` **EM ABERTO** (`status_id` 1=pendente ou
3=a vencer) cujo vencimento já passou é considerada **vencida** (`status_id = 2`) quando:

| Condição | Coluna |
|---|---|
| Situação ainda EM ABERTO | `status_id IN (1, 3)` (pendente / a vencer — **não** inclui 2=vencido, já é o alvo) |
| Vencimento ANTERIOR a hoje | `due_date < hoje` (data local, **estritamente** menor) |

Situações **fechadas** (prorrogado 4, baixado 5, protestado 6, cartório 7, pago 8,
cancelado 9, falha 10) são **preservadas**. A regra **não** reverte.
**Por que `< hoje`, não `<= hoje`:** uma conta que vence HOJE ainda está "a vencer" — só
vira "vencido" a partir do dia seguinte. Mesma semântica da trigger de banco
`fn_set_status_from_due_date` (`due_date < ref_date → vencido`).
Funções: `build_filter_vencido` / `count_eligible_vencido` / `apply_vencido`.

## Por que as duas regras existem (motivo estrutural comum)

A trigger `fn_set_status_from_due_date` (Postgres) só recalcula `status_id` por
vencimento em **INSERT/UPDATE** da linha — sem nenhuma edição, uma conta que era "a
vencer"/"pendente" ontem **não** transiciona sozinha hoje (nem para pago, nem para
vencido), pois nenhum evento de escrita dispara a trigger. Este batch cobre essa lacuna
para as duas transições, rodando **1x/dia às 08:00** na máquina de produção (Windows
Task Scheduler → `scheduler/run_baixa.ps1`).

## Isolamento das duas etapas (não regredir)

`main()` roda as duas regras em sequência, cada uma dentro do seu próprio
try/except (`_run_baixa_step` / `_run_vencido_step`) — **uma falhar não impede a outra
de rodar**. O exit code final é `1` se **qualquer uma** falhar (o wrapper `.ps1` marca a
tarefa vermelha), mas a etapa que teve sucesso já gravou seu resultado — não há rollback
cruzado (são operações independentes, não uma transação).

## Uso

```powershell
py -3 skills\baixa-automatica\scripts\run.py --dry-run   # quantas contas/títulos SERIAM afetados (não grava)
py -3 skills\baixa-automatica\scripts\run.py             # aplica as duas regras (PATCH via service_role)
```

- Cada regra faz um único `PATCH /rest/v1/financial_account_control` filtrado, com seu
  próprio status alvo. Escrita com **`SUPABASE_SERVICE_KEY`** (service_role ignora RLS).
- `--dry-run` faz um `GET` com `Prefer: count=exact` por regra e reporta os totais, sem
  gravar.
- Sem dependência Python nova — usa `urllib` (stdlib) + `python-dotenv` (já instalado).
- Exit code `0` = as duas regras aplicadas com sucesso; `≠ 0` = falha operacional em
  pelo menos uma → o wrapper `.ps1` marca a tarefa vermelha + grava no Event Log.

## Configuração

Lê o `.env` da raiz do projeto. Variáveis: ver `references/env_reference.md`
(reusa `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`, já presentes para o `email-reader`).

## Testes

`py -3 -m pytest tests/test_baixa_automatica.py` — cobre os dois construtores de filtro
(condições de cada regra + a data de hoje), os ids/status alvo de cada uma, que as duas
regras são independentes entre si, e que a falha de uma etapa não impede a outra.
