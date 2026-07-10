# Skill: baixa-automatica

Baixa automática de contas a pagar já quitadas — quarto pipeline (infra) do projeto,
paralelo a `email-reader` (entrada), `cobranca-vencidos` (saída) e `backup-supabase`.

## Regra de negócio

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

## Duas instâncias (mesma regra)

1. **No ato da edição (`/consulta`, frontend)** — ao marcar a 2ª flag (NF ou BOL) de uma
   conta vencida e em aberto, o app grava `status_id = 8` na hora
   (`qualifiesForAutoPago` em `apps/frontend-vite/src/pages/Consulta.tsx`).
2. **Batch diário (esta skill)** — cobre as contas cujo `due_date` "passa" com o tempo
   sem nenhuma edição disparar a baixa. Roda 1x/dia às **06:00** na máquina de produção
   (Windows Task Scheduler → `scheduler/run_baixa.ps1`).

## Uso

```powershell
py -3 skills\baixa-automatica\scripts\run.py --dry-run   # quantas contas SERIAM baixadas (não grava)
py -3 skills\baixa-automatica\scripts\run.py             # aplica a baixa (PATCH via service_role)
```

- Um único `PATCH /rest/v1/financial_account_control` filtrado (as 4 condições) define
  `status_id = 8`. Escrita com **`SUPABASE_SERVICE_KEY`** (service_role ignora RLS).
- `--dry-run` faz um `GET` com `Prefer: count=exact` e reporta o total, sem gravar.
- Sem dependência Python nova — usa `urllib` (stdlib) + `python-dotenv` (já instalado).
- Exit code `0` = sucesso; `≠ 0` = falha operacional → o wrapper `.ps1` marca a tarefa
  vermelha + grava no Event Log.

## Configuração

Lê o `.env` da raiz do projeto. Variáveis: ver `references/env_reference.md`
(reusa `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`, já presentes para o `email-reader`).

## Testes

`py -3 -m pytest tests/test_baixa_automatica.py` — cobre o construtor do filtro
(as 4 condições + a data de hoje) e os ids das situações em aberto.
