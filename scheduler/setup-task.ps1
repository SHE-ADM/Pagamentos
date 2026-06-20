<#
.SYNOPSIS
    Registra a tarefa de leitura de e-mails no Windows Task Scheduler.

.DESCRIPTION
    Execute este script UMA VEZ como Administrador para criar a tarefa.
    Após o registro, a tarefa roda automaticamente no intervalo configurado
    (padrão: a cada 5 minutos), independente do Flask ou de qualquer outro
    processo da aplicação.

    Portável: detecta o executor PowerShell (pwsh.exe ou powershell.exe) e usa
    caminhos relativos ao próprio script — basta clonar o repo, criar o .env e
    rodar este script como Administrador. Ver scheduler\INSTALL.md.

    Para trocar o e-mail: edite apenas o .env na raiz do projeto.
    A tarefa lerá as novas credenciais automaticamente na próxima execução.

.EXAMPLE
    # Registrar (requer janela PowerShell elevada):
    .\setup-task.ps1

    # Executar agora para testar:
    Start-ScheduledTask -TaskPath "\Sheild\" -TaskName "Pagamentos - Email Reader"

    # Ver último resultado:
    Get-ScheduledTaskInfo -TaskPath "\Sheild\" -TaskName "Pagamentos - Email Reader"

    # Remover a tarefa:
    Unregister-ScheduledTask -TaskPath "\Sheild\" -TaskName "Pagamentos - Email Reader" -Confirm:$false
#>

#Requires -RunAsAdministrator

# ---------------------------------------------------------------------------
# Configuração da tarefa
# ---------------------------------------------------------------------------
$TASK_NAME    = "Pagamentos - Email Reader"
$TASK_PATH    = "\Sheild\"                   # pasta no Agendador de Tarefas
$INTERVAL_MIN = 5                            # intervalo em minutos
$TIMEOUT_MIN  = 15                           # tempo máximo de execução por disparo
$DAYS_BACK    = 1                            # janela IMAP (--days) por disparo; 1 basta pois a task roda a cada $INTERVAL_MIN min (dedup evita reprocessar)

$PROJECT_ROOT = Split-Path -Parent $PSScriptRoot
$RUNNER       = Join-Path $PROJECT_ROOT "scheduler\run_reader.ps1"

# ---------------------------------------------------------------------------
# Validações
# ---------------------------------------------------------------------------
if (-not (Test-Path $RUNNER)) {
    Write-Error "run_reader.ps1 não encontrado em: $RUNNER"
    exit 1
}

# Sem .env não há credenciais IMAP/Supabase — a tarefa registra, mas toda
# execução falha. Avisa de forma explícita (não bloqueia: o .env pode ser
# criado depois, antes do primeiro disparo).
$ENV_FILE = Join-Path $PROJECT_ROOT ".env"
if (-not (Test-Path $ENV_FILE)) {
    Write-Warning "Arquivo .env NÃO encontrado em: $ENV_FILE"
    Write-Warning "A tarefa será registrada, mas FALHARÁ até você criar o .env com as credenciais IMAP/Supabase (ver scheduler\INSTALL.md)."
}

# ---------------------------------------------------------------------------
# Executor PowerShell — portabilidade entre máquinas
# Prefere PowerShell 7 (pwsh.exe); cai para o Windows PowerShell
# (powershell.exe, sempre presente no Windows) quando o pwsh não está instalado.
# ---------------------------------------------------------------------------
$psExe = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $psExe) {
    $psExe = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
}
if (-not $psExe) {
    Write-Error "Nenhum executor PowerShell encontrado (pwsh.exe nem powershell.exe)."
    exit 1
}

# ---------------------------------------------------------------------------
# Ação: PowerShell executa run_reader.ps1
# ---------------------------------------------------------------------------
$action = New-ScheduledTaskAction `
    -Execute         $psExe `
    -Argument        "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RUNNER`" -Days $DAYS_BACK" `
    -WorkingDirectory $PROJECT_ROOT

# ---------------------------------------------------------------------------
# Gatilho: inicia na próxima hora cheia, repete a cada $INTERVAL_H hora(s)
# ---------------------------------------------------------------------------
$startAt = (Get-Date -Minute 0 -Second 0 -Millisecond 0).AddHours(1)

$trigger = New-ScheduledTaskTrigger `
    -Once               `
    -At                 $startAt `
    -RepetitionInterval (New-TimeSpan -Minutes $INTERVAL_MIN) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

# ---------------------------------------------------------------------------
# Configurações: segurança e comportamento em caso de sobreposição
# ---------------------------------------------------------------------------
$settings = New-ScheduledTaskSettingsSet `
    -RunOnlyIfNetworkAvailable `
    -StartWhenAvailable        `
    -ExecutionTimeLimit (New-TimeSpan -Minutes $TIMEOUT_MIN) `
    -MultipleInstances  IgnoreNew

# ---------------------------------------------------------------------------
# Registro
# ---------------------------------------------------------------------------
Register-ScheduledTask `
    -TaskName    $TASK_NAME `
    -TaskPath    $TASK_PATH `
    -Action      $action `
    -Trigger     $trigger `
    -Settings    $settings `
    -Description "Lê e-mails financeiros a cada $INTERVAL_MIN minuto(s) (janela --days $DAYS_BACK) e grava no Supabase. Credenciais: .env na raiz do projeto." `
    -RunLevel    Highest `
    -Force | Out-Null

# ---------------------------------------------------------------------------
# Confirmação
# ---------------------------------------------------------------------------
$task = Get-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME -ErrorAction SilentlyContinue

if ($task) {
    Write-Host ""
    Write-Host "Tarefa registrada com sucesso!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Caminho  : $TASK_PATH$TASK_NAME"
    Write-Host "  Executor : $psExe"
    Write-Host "  Runner   : $RUNNER"
    Write-Host "  Inicio   : $startAt"
    Write-Host "  Intervalo: a cada $INTERVAL_MIN minuto(s)"
    Write-Host "  Janela   : --days $DAYS_BACK"
    Write-Host "  Timeout  : $TIMEOUT_MIN minutos por execucao"
    Write-Host ""
    Write-Host "Para testar agora (sem esperar a proxima hora):" -ForegroundColor Cyan
    Write-Host "  Start-ScheduledTask -TaskPath '$TASK_PATH' -TaskName '$TASK_NAME'"
    Write-Host ""
    Write-Host "Logs em: $(Join-Path $PROJECT_ROOT 'logs\scheduler\')"
} else {
    Write-Error "Falha ao registrar a tarefa. Verifique se o PowerShell foi executado como Administrador."
    exit 1
}
