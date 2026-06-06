<#
.SYNOPSIS
    Wrapper do agendador — executa read_emails.py e grava log diário.
    Chamado pelo Windows Task Scheduler a cada 1 hora.

.NOTES
    Não altere este arquivo para trocar credenciais ou keywords.
    Tudo é lido do .env na raiz do projeto a cada execução.
#>

# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------
$PROJECT_ROOT = Split-Path -Parent $PSScriptRoot
$SCRIPT       = Join-Path $PROJECT_ROOT "skills\email-reader\scripts\read_emails.py"
$LOG_DIR      = Join-Path $PROJECT_ROOT "logs\scheduler"
$LOG_RETENTION_DAYS = 30   # logs mais antigos que isso são removidos
$DAYS_BACK    = 1          # janela de busca no IMAP; dedup impede reprocessamento

# ---------------------------------------------------------------------------
# Localiza Python
# ---------------------------------------------------------------------------
$PYTHON = $null

# 1. Python Launcher for Windows (py.exe) — mais confiável no Task Scheduler
$pyLauncher = (Get-Command py -ErrorAction SilentlyContinue)?.Source
if ($pyLauncher) { $PYTHON = $pyLauncher; $PYTHON_ARGS = @("-3") }

# 2. python no PATH
if (-not $PYTHON) {
    $pythonInPath = (Get-Command python -ErrorAction SilentlyContinue)?.Source
    if ($pythonInPath) { $PYTHON = $pythonInPath; $PYTHON_ARGS = @() }
}

# 3. Localização padrão do instalador Windows (ajuste se necessário)
if (-not $PYTHON) {
    $candidates = @(
        "C:\Python314\python.exe",
        "C:\Python313\python.exe",
        "C:\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { $PYTHON = $c; $PYTHON_ARGS = @(); break }
    }
}

if (-not $PYTHON) {
    Write-Error "Python não encontrado. Ajuste a variável `$candidates` em run_reader.ps1."
    exit 1
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null

$LOG_FILE = Join-Path $LOG_DIR "reader_$(Get-Date -Format 'yyyyMMdd').log"

function Write-Log {
    param([string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Add-Content -Path $LOG_FILE -Value $line
    Write-Host $line
}

# Remove logs mais antigos que LOG_RETENTION_DAYS
Get-ChildItem -Path $LOG_DIR -Filter "reader_*.log" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$LOG_RETENTION_DAYS) } |
    Remove-Item -Force

# ---------------------------------------------------------------------------
# Execução
# ---------------------------------------------------------------------------
Write-Log "===== Inicio da execucao ====="
Write-Log "Python : $PYTHON"
Write-Log "Script : $SCRIPT"
Write-Log "Janela : --days $DAYS_BACK"

$env:PYTHONIOENCODING = "utf-8"

& $PYTHON @PYTHON_ARGS $SCRIPT --days $DAYS_BACK 2>&1 |
    ForEach-Object { Add-Content -Path $LOG_FILE -Value $_; Write-Host $_ }

$EXIT = $LASTEXITCODE
Write-Log "===== Fim (exit: $EXIT) ====="

exit $EXIT
