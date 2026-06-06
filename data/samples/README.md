# data/samples — Amostras de validação da extração

Pasta para armazenar documentos reais (boletos, NF-e, faturas) usados para
**validar** a extração de `skills/pdf-contas-pagar/scripts/extract_pdf.py`.

> **Dados sensíveis.** Os PDFs aqui contêm CNPJ, valores e linha digitável reais.
> O `.gitignore` bloqueia o commit de qualquer conteúdo desta pasta — apenas a
> estrutura (`.gitkeep`) e este README são versionados. **Nunca** force o commit
> de um PDF de amostra.

## Estrutura

```
data/samples/
├── boleto/      # boletos bancários (caso principal)
├── nfe/         # notas fiscais eletrônicas (NÃO geram conta a pagar)
├── nfse/        # notas fiscais de serviço (NÃO geram conta a pagar)
├── fatura/      # faturas / contas de consumo
├── outros/      # recibos, contratos, demais tipos
└── _expected/   # gabaritos opcionais (CSV/JSON com os valores corretos)
```

Subpastas por tipo porque o extrator lê uma pasta por vez (`glob("*.pdf")` —
não recursivo). Assim cada tipo gera um CSV de validação isolado.

## Como validar (a partir da raiz do projeto)

```powershell
# Extrai todos os boletos da subpasta -> CSV em data/csv_output/
python skills\pdf-contas-pagar\scripts\extract_pdf.py `
  --input data\samples\boleto\ --output data\csv_output\ --batch

# Repita por tipo trocando a subpasta (nfe, fatura, ...).
```

A saída vai para `data/csv_output/` (também ignorada pelo git).

## Gabaritos (`_expected/`)

Opcional, mas recomendado: para cada PDF de amostra, registre os valores
corretos esperados (beneficiário, CNPJ, vencimento, valor, linha digitável) num
arquivo de mesmo nome. Permite comparar a extração contra a verdade, não só
contra "parece plausível". Formato livre (CSV ou JSON).
