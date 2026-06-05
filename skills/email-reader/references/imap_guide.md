# imap_guide.md — Referência IMAP / Locaweb

## Configuração Locaweb (SSL)

| Parâmetro | Valor |
|---|---|
| Host | `email-ssl.com.br` |
| Porta | `993` |
| Segurança | SSL/TLS |
| Autenticação | LOGIN (usuário e senha normais) |

## Pastas padrão Locaweb

| Pasta IMAP | Descrição |
|---|---|
| `INBOX` | Caixa de entrada |
| `Sent` | Enviados |
| `Drafts` | Rascunhos |
| `Trash` | Lixeira |
| `Spam` | Spam |

## Critérios de busca IMAP suportados

| Critério | Descrição |
|---|---|
| `UNSEEN` | Não lidos |
| `SEEN` | Já lidos |
| `SINCE "01-Jan-2025"` | A partir de data (formato `DD-Mon-YYYY`) |
| `FROM "fornecedor@"` | Por remetente |
| `SUBJECT "boleto"` | Por assunto (servidor-side, básico) |
| `ALL` | Todos os e-mails |

**Nota:** A busca por palavras-chave no assunto é feita localmente no script
(mais confiável que IMAP SUBJECT, que é case-sensitive e varia por servidor).

## Adicionar palavras-chave personalizadas

No arquivo `.env`, adicione a variável:
```env
EMAIL_KEYWORDS=boleto,nota fiscal,fatura,nf-e,vencimento,minha_palavra
```
Se não definida, o script usa a lista padrão de 12 palavras.

## Listar pastas disponíveis na conta

```python
import imaplib, os
from dotenv import load_dotenv
load_dotenv(r'C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos\.env')

mail = imaplib.IMAP4_SSL(os.getenv('IMAP_HOST'), 993)
mail.login(os.getenv('IMAP_USER'), os.getenv('IMAP_PASS'))
_, folders = mail.list()
for f in folders:
    print(f.decode())
mail.logout()
```

## Problemas comuns

| Problema | Causa | Solução |
|---|---|---|
| `[AUTHENTICATIONFAILED]` | Senha errada ou 2FA ativo | Verificar senha no painel Locaweb |
| `[UNAVAILABLE]` | Servidor fora do ar | Aguardar e tentar novamente |
| Encoding estranho no assunto | Header MIME mal formado | O script trata com `decode_header()` |
| PDF não detectado | Content-Type diferente | Verificar extensão `.pdf` no nome do arquivo |
| E-mail processado duas vezes | Message-ID ausente | Será tratado por timestamp + remetente |
