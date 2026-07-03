<#
.SYNOPSIS
    Registra a tarefa de backup do Supabase no Windows Task Scheduler.

.DESCRIPTION
    Execute este script UMA VEZ como Administrador para criar a tarefa.
    Após o registro, a tarefa roda automaticamente 1x por dia às 02:00,
    chamando run.py que gera o pg_dump do banco e baixa o Storage (attachments).

    Portável: detecta o executor PowerShell (pwsh.exe ou powershell.exe) e usa
    caminhos relativos ao próprio script.

    Para trocar credenciais: edite apenas o .env na raiz do projeto
    (SUPABASE_DB_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY, PG_DUMP_PATH).

.EXAMPLE
    # Registrar (requer janela PowerShell elevada):
    .\setup-backup-task.ps1

    # Executar agora para testar (sem aguardar as 02:00):
    Start-ScheduledTask -TaskPath "\Sheild\" -TaskName "Pagamentos - Backup Supabase"

    # Ver último resultado:
    Get-ScheduledTaskInfo -TaskPath "\Sheild\" -TaskName "Pagamentos - Backup Supabase"

    # Validar config sem gravar (dry-run manual):
    & "$PSScriptRoot\run_backup.ps1" -DryRun

    # Remover a tarefa:
    Unregister-ScheduledTask -TaskPath "\Sheild\" -TaskName "Pagamentos - Backup Supabase" -Confirm:$false
#>

#Requires -RunAsAdministrator

# ---------------------------------------------------------------------------
# Configuração da tarefa
# ---------------------------------------------------------------------------
$TASK_NAME   = "Pagamentos - Backup Supabase"
$TASK_PATH   = "\Sheild\"      # mesma pasta do Email Reader e da Cobrança
$TRIGGER_H   = 2               # hora do disparo diário (2 = 02:00)
$TRIGGER_M   = 0
$TIMEOUT_MIN = 120             # tempo máximo por execução (banco + Storage)

$PROJECT_ROOT = Split-Path -Parent $PSScriptRoot
$RUNNER       = Join-Path $PROJECT_ROOT "scheduler\run_backup.ps1"

# ---------------------------------------------------------------------------
# Validações
# ---------------------------------------------------------------------------
if (-not (Test-Path $RUNNER)) {
    Write-Error "run_backup.ps1 não encontrado em: $RUNNER"
    exit 1
}

$ENV_FILE = Join-Path $PROJECT_ROOT ".env"
if (-not (Test-Path $ENV_FILE)) {
    Write-Warning "Arquivo .env NÃO encontrado em: $ENV_FILE"
    Write-Warning "A tarefa será registrada, mas FALHARÁ até você criar o .env com SUPABASE_DB_URL/SUPABASE_URL/SUPABASE_SERVICE_KEY."
} else {
    $envText = Get-Content $ENV_FILE -Raw
    if ($envText -notmatch "SUPABASE_DB_URL") {
        Write-Warning "SUPABASE_DB_URL não encontrado no .env — o backup do BANCO falhará até você adicioná-lo."
        Write-Warning "Use a MESMA connection string do pgAdmin (aba Session pooler do dashboard)."
    }
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
# Ação: PowerShell executa run_backup.ps1
# ---------------------------------------------------------------------------
$action = New-ScheduledTaskAction `
    -Execute          $psExe `
    -Argument         "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RUNNER`"" `
    -WorkingDirectory $PROJECT_ROOT

# ---------------------------------------------------------------------------
# Gatilho: diário às 02:00 (TRIGGER_H/TRIGGER_M)
# ---------------------------------------------------------------------------
$startAt = (Get-Date -Hour $TRIGGER_H -Minute $TRIGGER_M -Second 0 -Millisecond 0)
if ($startAt -lt (Get-Date)) {
    $startAt = $startAt.AddDays(1)
}

$trigger = New-ScheduledTaskTrigger -Daily -At $startAt

# ---------------------------------------------------------------------------
# Configurações
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
    -Description "Backup diário do Supabase (pg_dump do banco + Storage attachments) às 02:00. Credenciais: .env na raiz do projeto." `
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
    Write-Host "  Frequencia: 1x por dia as 02:00"
    Write-Host "  Timeout   : $TIMEOUT_MIN minutos por execucao"
    Write-Host ""
    Write-Host "Para testar agora (sem aguardar as 02:00):" -ForegroundColor Cyan
    Write-Host "  Start-ScheduledTask -TaskPath '$TASK_PATH' -TaskName '$TASK_NAME'"
    Write-Host ""
    Write-Host "Para validar a config sem gravar (dry-run manual):" -ForegroundColor Cyan
    Write-Host "  & '$RUNNER' -DryRun"
    Write-Host ""
    Write-Host "Backups em: $(Join-Path $PROJECT_ROOT 'backups\')"
    Write-Host "Logs em   : $(Join-Path $PROJECT_ROOT 'logs\backup\')"
} else {
    Write-Error "Falha ao registrar a tarefa. Verifique se o PowerShell foi executado como Administrador."
    exit 1
}
