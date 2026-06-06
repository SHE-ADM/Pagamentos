<#
.SYNOPSIS
    Registra a tarefa de leitura de e-mails no Windows Task Scheduler.

.DESCRIPTION
    Execute este script UMA VEZ como Administrador para criar a tarefa.
    Após o registro, a tarefa roda automaticamente a cada hora, independente
    do Flask ou de qualquer outro processo da aplicação.

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
$INTERVAL_H   = 1                            # intervalo em horas
$TIMEOUT_MIN  = 15                           # tempo máximo de execução por disparo

$PROJECT_ROOT = Split-Path -Parent $PSScriptRoot
$RUNNER       = Join-Path $PROJECT_ROOT "scheduler\run_reader.ps1"

# ---------------------------------------------------------------------------
# Validações
# ---------------------------------------------------------------------------
if (-not (Test-Path $RUNNER)) {
    Write-Error "run_reader.ps1 não encontrado em: $RUNNER"
    exit 1
}

# ---------------------------------------------------------------------------
# Ação: PowerShell executa run_reader.ps1
# ---------------------------------------------------------------------------
$action = New-ScheduledTaskAction `
    -Execute         "pwsh.exe" `
    -Argument        "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RUNNER`"" `
    -WorkingDirectory $PROJECT_ROOT

# ---------------------------------------------------------------------------
# Gatilho: inicia na próxima hora cheia, repete a cada $INTERVAL_H hora(s)
# ---------------------------------------------------------------------------
$startAt = (Get-Date -Minute 0 -Second 0 -Millisecond 0).AddHours(1)

$trigger = New-ScheduledTaskTrigger `
    -Once               `
    -At                 $startAt `
    -RepetitionInterval (New-TimeSpan -Hours $INTERVAL_H) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

# ---------------------------------------------------------------------------
# Configurações: segurança e comportamento em caso de sobreposição
# ---------------------------------------------------------------------------
$settings = New-ScheduledTaskSettingsSet `
    -RunOnlyIfNetworkAvailable              `
    -StartWhenAvailable                     `
    -ExecutionTimeLimit  (New-TimeSpan -Minutes $TIMEOUT_MIN) `
    -MultipleInstances   IgnoreNew          `
    -DisallowDemandStart $false

# ---------------------------------------------------------------------------
# Registro
# ---------------------------------------------------------------------------
Register-ScheduledTask `
    -TaskName    $TASK_NAME `
    -TaskPath    $TASK_PATH `
    -Action      $action `
    -Trigger     $trigger `
    -Settings    $settings `
    -Description "Lê e-mails financeiros a cada $INTERVAL_H hora(s) e grava no Supabase. Credenciais: .env na raiz do projeto." `
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
    Write-Host "  Runner   : $RUNNER"
    Write-Host "  Inicio   : $startAt"
    Write-Host "  Intervalo: a cada $INTERVAL_H hora(s)"
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
