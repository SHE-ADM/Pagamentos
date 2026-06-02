# email-financeiro

Automação de recebimento de contas por e-mail e geração de pagamentos.

## Formato de entrada

Arquivo JSON com uma lista de e-mails:

```json
[
  {
    "assunto": "Conta de energia",
    "corpo": "Fornecedor: Enel\nValor: R$ 123,45\nVencimento: 2030-05-20\nCodigo de Barras: 12345678901234567890123456789012345678901234"
  }
]
```

## Execução

```bash
python automacao_contas.py emails.json pagamentos.json
```

O arquivo de saída contém contas únicas por código de barras e o status do pagamento (`agendado` ou `pago`).
