# Recebimentos (Email Reader) — Instalação do agendamento em outra máquina

Guia para instalar a leitura automática de e-mails (pipeline de **recebimentos**)
em uma máquina nova. A tarefa roda `scheduler\run_reader.ps1` no Windows Task
Scheduler, que por sua vez executa `read_emails.py` lendo o `.env` da raiz.

> A tarefa é **independente** do Flask e dos apps Node — só precisa de Python +
> `.env`. Tudo (credenciais, keywords) é lido do `.env` a cada execução; nunca é
> preciso editar os scripts `.ps1` para trocar credenciais.

---

## Pré-requisitos

| Item | Detalhe |
|---|---|
| **Windows** | 10/11 ou Server |
| **Python 3.12** (estável) | Em python.org. Evite o build *free-threaded* `3.14t` — incompatível com `pdfplumber` |
| **PowerShell** | `pwsh.exe` (7+) **ou** `powershell.exe` (5.1, já vem no Windows) — o setup detecta automaticamente |
| **Git** | Para clonar o repositório (opcional — pode copiar a pasta) |
| **Conta de Administrador** | Necessária só para registrar a tarefa (`setup-task.ps1`) |

---

## Passo 1 — Obter o projeto na máquina nova

Clone (ou copie) o repositório para qualquer pasta. O caminho **não** precisa ser
o mesmo da máquina de origem — os scripts usam caminhos relativos a si mesmos.

```powershell
git clone https://github.com/SHE-ADM/Pagamentos.git "C:\Sheild\Projetos\Claude\Contas a pagar\Pagamentos"
```

> Se copiar a pasta manualmente, **não** copie `node_modules\`, `.venv\` nem
> `logs\` — são recriados/ignorados.

---

## Passo 2 — Instalar Python e as dependências do pipeline

Na raiz do projeto:

```powershell
# Confirme a versão (deve ser 3.12.x estável)
py -3.12 --version

# Instale as dependências Python (fonte de verdade: server/requirements.txt)
py -3.12 -m pip install -r server\requirements.txt
```

Valide que o `pdfplumber` importa (o `run_reader.ps1` recusa Python sem ele):

```powershell
py -3.12 -c "import pdfplumber; print('pdfplumber OK')"
```

---

## Passo 3 — Criar o `.env` na raiz

A tarefa **falha** sem o `.env`. Copie o `.env` da máquina de origem **ou** crie
um novo na raiz do projeto com, no mínimo, estas variáveis de recebimentos:

```env
# === IMAP (Locaweb) ===
IMAP_HOST=email-ssl.com.br
IMAP_PORT=993
IMAP_USER=financeiro@otimotex.com.br
IMAP_PASS=********
IMAP_MAILBOX=INBOX

# === Supabase (service_role — só no servidor, nunca no frontend) ===
SUPABASE_URL=https://XXXX.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

# === Filtro de assunto (opcional — sobrescreve a lista padrão do código) ===
EMAIL_KEYWORDS=boleto,nota fiscal,nf-e,darf,das,...
```

> Nunca commite o `.env`. Ele lê **somente a INBOX** (`IMAP_MAILBOX=INBOX`) —
> não aponte para a pasta de Spam/Lixo.

---

## Passo 4 — Teste manual (antes de agendar)

Rode uma vez à mão para confirmar Python + `.env` + acesso ao IMAP/Supabase:

```powershell
# Simulação (não grava nada — só lista o que faria)
py -3.12 skills\email-reader\scripts\read_emails.py --dry-run

# Ou execute o próprio wrapper do agendador (grava log em logs\scheduler\)
pwsh -ExecutionPolicy Bypass -File scheduler\run_reader.ps1
```

Se o `--dry-run` conecta e lista e-mails, está tudo pronto para agendar.

---

## Passo 5 — Registrar a tarefa (como Administrador)

Abra o PowerShell **como Administrador** e rode:

```powershell
cd "C:\caminho\para\Pagamentos"
.\scheduler\setup-task.ps1
```

O script registra a tarefa **`\Sheild\Pagamentos - Email Reader`**, que:
- dispara a cada **5 minutos** (parâmetro `$INTERVAL_MIN` no topo do `setup-task.ps1`);
- tem timeout de 15 min por execução e ignora disparos sobrepostos;
- só roda com rede disponível e recupera disparos perdidos;
- usa `pwsh.exe` se existir, senão `powershell.exe`.

> Para mudar o intervalo (ex.: 1 hora), edite `$INTERVAL_MIN` no `setup-task.ps1`
> **antes** de rodá-lo (use `60` para 1 hora) e registre novamente (`-Force`
> sobrescreve a tarefa existente).

---

## Verificar e operar

```powershell
# Executar agora (sem esperar o próximo disparo)
Start-ScheduledTask -TaskPath "\Sheild\" -TaskName "Pagamentos - Email Reader"

# Ver último resultado (LastRunTime / LastTaskResult = 0 é sucesso)
Get-ScheduledTaskInfo -TaskPath "\Sheild\" -TaskName "Pagamentos - Email Reader"

# Remover a tarefa
Unregister-ScheduledTask -TaskPath "\Sheild\" -TaskName "Pagamentos - Email Reader" -Confirm:$false
```

**Logs:** `logs\scheduler\reader_YYYYMMDD.log` (retidos 30 dias). Crashes do Python
vão para `logs\scheduler\crash_*.log` e para o Event Log do Windows (fonte
`Pagamentos-EmailReader`).

---

## Troubleshooting

| Sintoma | Causa provável | Correção |
|---|---|---|
| `Python compatível não encontrado` | Sem Python 3.12 estável ou sem `pdfplumber` | Instale o 3.12 e rode o `pip install -r server\requirements.txt` |
| Tarefa registra mas toda execução falha | `.env` ausente ou credenciais erradas | Crie/corrija o `.env` (Passo 3); teste com `--dry-run` |
| `LastTaskResult` diferente de 0 | Erro na execução | Veja `logs\scheduler\reader_*.log` e `crash_*.log` |
| Tarefa não dispara | PowerShell não encontrado / política de execução | O setup já usa `-ExecutionPolicy Bypass`; confirme que `pwsh.exe` ou `powershell.exe` existe |
| "Acesso negado" ao registrar | PowerShell sem elevação | Rode o `setup-task.ps1` em janela **Administrador** |

---

## Relacionado

- Agendamento da **cobrança de vencidos** (envios): `skills\cobranca-vencidos\references\task_scheduler_setup.md`
- Pipeline de leitura: `skills\email-reader\scripts\read_emails.py`
