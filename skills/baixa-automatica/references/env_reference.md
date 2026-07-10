# env_reference — skill `baixa-automatica`

A skill lê o `.env` da **raiz do projeto** (o mesmo usado pelo `email-reader` e pela
`cobranca-vencidos`). Nenhuma variável nova é necessária — reusa as duas do Supabase.

| Variável | Uso | Origem |
|---|---|---|
| `SUPABASE_URL` | Base da API REST (`{URL}/rest/v1/...`) | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Chave `service_role` — escrita direta na tabela, ignora RLS | Supabase → Settings → API → `service_role` |

> `SUPABASE_SERVICE_KEY` tem acesso total ao banco. Nunca expor no frontend, nunca commitar.
> Em produção, essas duas variáveis já existem no `.env` (o `email-reader` depende delas),
> então não há passo extra de configuração de credenciais.

## Verificação rápida (produção)

Esperado: `imports OK` no primeiro comando; o `--dry-run` reporta a contagem sem gravar.

```powershell
cd C:\Sheild\API\Pagamentos
py -3 -c "import sys; sys.path.insert(0,'skills/baixa-automatica/scripts'); import run; print('imports OK')"
py -3 skills\baixa-automatica\scripts\run.py --dry-run
```
