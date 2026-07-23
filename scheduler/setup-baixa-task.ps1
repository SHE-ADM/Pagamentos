<#
.SYNOPSIS
    Registra a tarefa de baixa automática de contas pagas + marcação de títulos vencidos
    no Windows Task Scheduler.

.DESCRIPTION
    Execute este script UMA VEZ como Administrador para criar a tarefa.
    Após o registro, a tarefa roda automaticamente 1x por dia às 08:00, chamando run.py
    (skill baixa-automatica), que aplica DUAS regras independentes: (1) marca como "pago"
    as contas com NF + Boleto confirmados, vencimento <= hoje e ainda em aberto; (2) marca
    como "vencido" as contas pendente/a vencer com vencimento < hoje.

    Portável: detecta o executor PowerShell (pwsh.exe ou powershell.exe) e usa caminhos
    relativos ao próprio script. Para trocar credenciais: edite apenas o .env na raiz.

.EXAMPLE
    # Registrar (requer janela PowerShell elevada):
    .\setup-baixa-task.ps1

    # Executar agora para testar (sem aguardar as 08:00):
    Start-ScheduledTask -TaskPath "\Sheild\" -TaskName "Pagamentos - Baixa Automática"

    # Ver último resultado:
    Get-ScheduledTaskInfo -TaskPath "\Sheild\" -TaskName "Pagamentos - Baixa Automática"

    # Simular sem gravar (dry-run manual):
    & "$PSScriptRoot\run_baixa.ps1" -DryRun

    # Remover a tarefa:
    Unregister-ScheduledTask -TaskPath "\Sheild\" -TaskName "Pagamentos - Baixa Automática" -Confirm:$false
#>

#Requires -RunAsAdministrator

# ---------------------------------------------------------------------------
# Configuração da tarefa
# ---------------------------------------------------------------------------
$TASK_NAME   = "Pagamentos - Baixa Automática"
$TASK_PATH   = "\Sheild\"      # pasta no Agendador (mesma das demais tarefas do Pagamentos)
$TRIGGER_H   = 8               # hora do disparo diário (8 = 08:00)
$TRIGGER_M   = 0
$TIMEOUT_MIN = 10              # tempo máximo de execução por disparo

$PROJECT_ROOT = Split-Path -Parent $PSScriptRoot
$RUNNER       = Join-Path $PROJECT_ROOT "scheduler\run_baixa.ps1"

# ---------------------------------------------------------------------------
# Validações
# ---------------------------------------------------------------------------
if (-not (Test-Path $RUNNER)) {
    Write-Error "run_baixa.ps1 não encontrado em: $RUNNER"
    exit 1
}

$ENV_FILE = Join-Path $PROJECT_ROOT ".env"
if (-not (Test-Path $ENV_FILE)) {
    Write-Warning "Arquivo .env NÃO encontrado em: $ENV_FILE"
    Write-Warning "A tarefa será registrada, mas FALHARÁ até você criar o .env com SUPABASE_URL/SUPABASE_SERVICE_KEY."
}

# ---------------------------------------------------------------------------
# Executor PowerShell — portabilidade entre máquinas
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
# Ação: PowerShell executa run_baixa.ps1
# ---------------------------------------------------------------------------
$action = New-ScheduledTaskAction `
    -Execute          $psExe `
    -Argument         "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RUNNER`"" `
    -WorkingDirectory $PROJECT_ROOT

# ---------------------------------------------------------------------------
# Gatilho: diário às 08:00 (TRIGGER_H/TRIGGER_M)
# ---------------------------------------------------------------------------
$startAt = (Get-Date -Hour $TRIGGER_H -Minute $TRIGGER_M -Second 0 -Millisecond 0)
# Se o horário de hoje já passou, agenda para amanhã
if ($startAt -lt (Get-Date)) {
    $startAt = $startAt.AddDays(1)
}

$trigger = New-ScheduledTaskTrigger `
    -Daily `
    -At $startAt

# ---------------------------------------------------------------------------
# Configurações: comportamento em caso de sobreposição
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
    -Description "Marca como pago as contas com NF + Boleto e vencimento <= hoje (em aberto); e marca como vencido as contas pendente/a vencer com vencimento < hoje. 1x por dia às 08:00. Credenciais: .env na raiz do projeto." `
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
    Write-Host "  Caminho   : $TASK_PATH$TASK_NAME"
    Write-Host "  Executor  : $psExe"
    Write-Host "  Runner    : $RUNNER"
    Write-Host "  Proximo   : $startAt"
    Write-Host "  Frequencia: 1x por dia as 08:00"
    Write-Host "  Timeout   : $TIMEOUT_MIN minutos por execucao"
    Write-Host ""
    Write-Host "Para testar agora (sem aguardar as 08:00):" -ForegroundColor Cyan
    Write-Host "  Start-ScheduledTask -TaskPath '$TASK_PATH' -TaskName '$TASK_NAME'"
    Write-Host ""
    Write-Host "Para simular sem gravar (dry-run manual):" -ForegroundColor Cyan
    Write-Host "  & '$RUNNER' -DryRun"
    Write-Host ""
    Write-Host "Logs em: $(Join-Path $PROJECT_ROOT 'logs\baixa\')"
} else {
    Write-Error "Falha ao registrar a tarefa. Verifique se o PowerShell foi executado como Administrador."
    exit 1
}
