<#
.SYNOPSIS
    Wrapper do agendador — executa run.py (backup do Supabase) e grava log diário.
    Chamado pelo Windows Task Scheduler 1x por dia às 02:00 (setup-backup-task.ps1).

.NOTES
    Não altere este arquivo para trocar credenciais.
    Tudo é lido do .env na raiz do projeto a cada execução
    (SUPABASE_DB_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY, PG_DUMP_PATH, etc.).

.PARAMETER DryRun
    Se informado, passa --dry-run para o script Python (valida config e
    conectividade sem gerar arquivos). Exemplo: .\run_backup.ps1 -DryRun
#>

param(
    [switch]$DryRun
)

# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------
$PROJECT_ROOT = Split-Path -Parent $PSScriptRoot
$SCRIPT       = Join-Path $PROJECT_ROOT "skills\backup-supabase\scripts\run.py"
$LOG_DIR      = Join-Path $PROJECT_ROOT "logs\backup"
$LOG_RETENTION_DAYS = 30   # logs mais antigos que isso são removidos

# ---------------------------------------------------------------------------
# Logging — criado ANTES da detecção do Python para garantir registro de erros
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null

$LOG_FILE   = Join-Path $LOG_DIR "backup_$(Get-Date -Format 'yyyyMMdd').log"
$STDOUT_TMP = Join-Path $LOG_DIR "_stdout.tmp"
$STDERR_TMP = Join-Path $LOG_DIR "_stderr.tmp"

function Write-Log {
    param([string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
    Write-Host $line
}

# ---------------------------------------------------------------------------
# Localiza Python (mesmo padrão de run_cobranca.ps1 / run_reader.ps1)
# ---------------------------------------------------------------------------
$PYTHON = $null

function Test-PythonUsable {
    param([string]$Exe, [string[]]$ExeArgs)
    try {
        $ver = & $Exe @ExeArgs -c "import sys; print(sys.version)" 2>$null
        if ($ver -match "experimental free-threading") { return $false }
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

# 1. Python Launcher for Windows (py.exe)
$pyCmd = Get-Command py -ErrorAction SilentlyContinue
if ($pyCmd) {
    foreach ($v in @("-3.12", "-3.13", "-3.11", "-3.10", "-3")) {
        try {
            $resolved = & py $v -c "import sys; print(sys.executable)" 2>$null
            if ($resolved -and (Test-Path $resolved) -and (Test-PythonUsable "py" @($v))) {
                $PYTHON = $pyCmd.Source
                $PYTHON_ARGS = @($v)
                break
            }
        } catch {}
    }
}

# 2. python no PATH
if (-not $PYTHON) {
    $pyCmd2 = Get-Command python -ErrorAction SilentlyContinue
    if ($pyCmd2 -and (Test-PythonUsable $pyCmd2.Source @())) {
        $PYTHON = $pyCmd2.Source; $PYTHON_ARGS = @()
    }
}

# 3. Localização padrão do instalador Windows
if (-not $PYTHON) {
    $candidates = @(
        "C:\Python312\python.exe",
        "C:\Python313\python.exe",
        "C:\Python311\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"
    )
    foreach ($c in $candidates) {
        if ((Test-Path $c) -and (Test-PythonUsable $c @())) {
            $PYTHON = $c; $PYTHON_ARGS = @(); break
        }
    }
}

if (-not $PYTHON) {
    Write-Log "ERRO: Python compatível não encontrado. Instale Python 3.12 em python.org."
    exit 1
}

# ---------------------------------------------------------------------------
# Retenção de logs (as pastas de backup são limpas pelo próprio run.py)
# ---------------------------------------------------------------------------
Get-ChildItem -Path $LOG_DIR -Filter "backup_*.log" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$LOG_RETENTION_DAYS) } |
    Remove-Item -Force

Get-ChildItem -Path $LOG_DIR -Filter "crash_*.log" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) -and $_.Length -lt 200 } |
    Remove-Item -Force

# ---------------------------------------------------------------------------
# Ambiente Python
# ---------------------------------------------------------------------------
$env:PYTHONIOENCODING   = "utf-8"
$env:PYTHONFAULTHANDLER = "1"
$env:PYTHONNOUSERSITE   = "1"

# ---------------------------------------------------------------------------
# Execução
# ---------------------------------------------------------------------------
$SCRIPT_ARGS = @($SCRIPT)
if ($DryRun) { $SCRIPT_ARGS += "--dry-run" }

Write-Log "===== Inicio da execucao ====="
Write-Log "Python : $PYTHON"
Write-Log "Script : $SCRIPT"
if ($DryRun) { Write-Log "Modo   : DRY-RUN (sem gravar arquivos)" }

foreach ($f in @($STDOUT_TMP, $STDERR_TMP)) {
    if (Test-Path $f) { Remove-Item $f -Force }
}

$proc = Start-Process `
    -FilePath         $PYTHON `
    -ArgumentList     ($PYTHON_ARGS + $SCRIPT_ARGS) `
    -WorkingDirectory $PROJECT_ROOT `
    -RedirectStandardOutput $STDOUT_TMP `
    -RedirectStandardError  $STDERR_TMP `
    -NoNewWindow -Wait -PassThru

$EXIT = $proc.ExitCode

# Grava stdout no log diário
if (Test-Path $STDOUT_TMP) {
    Get-Content $STDOUT_TMP -Encoding UTF8 | ForEach-Object {
        Add-Content -Path $LOG_FILE -Value $_ -Encoding UTF8
        Write-Host $_
    }
    Remove-Item $STDOUT_TMP -Force
}

# Grava stderr no log diário com marcação clara
if ((Test-Path $STDERR_TMP) -and (Get-Item $STDERR_TMP).Length -gt 0) {
    Write-Log "--- STDERR / FAULTHANDLER ---"
    Get-Content $STDERR_TMP -Encoding UTF8 | ForEach-Object {
        Add-Content -Path $LOG_FILE -Value "[STDERR] $_" -Encoding UTF8
        Write-Host "[STDERR] $_"
    }
    Write-Log "--- FIM STDERR ---"
    Remove-Item $STDERR_TMP -Force
}

# ---------------------------------------------------------------------------
# Resultado
# ---------------------------------------------------------------------------
if ($EXIT -eq 0) {
    Write-Log "===== Fim OK (exit: $EXIT) ====="
} else {
    Write-Log "===== CRASH / ERRO (exit: $EXIT) ====="

    try {
        $src = "Pagamentos-Backup"
        if (-not [System.Diagnostics.EventLog]::SourceExists($src)) {
            [System.Diagnostics.EventLog]::CreateEventSource($src, "Application")
        }
        Write-EventLog -LogName Application -Source $src -EventId 1003 `
            -EntryType Error `
            -Message "run.py (backup) terminou com exit code $EXIT em $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'). Verifique $LOG_DIR"
    } catch {
        Write-Log "Aviso: nao foi possivel gravar no Event Log do Windows: $_"
    }
}

exit $EXIT
