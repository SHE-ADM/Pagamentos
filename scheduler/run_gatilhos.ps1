<#
.SYNOPSIS
    Wrapper do agendador — executa o medidor dos 7 gatilhos condicionais da Onda 9 e grava log.
    Chamado pelo Windows Task Scheduler 1x por MÊS (setup-gatilhos-task.ps1).

.DESCRIPTION
    A Onda 9 do roadmap é condicional: cada item só entra quando o gatilho dele ocorre. Este
    medidor apura os sete e grava a série em analytics.roadmap_trigger_snapshot (migration 122),
    para que a decisão de implementar seja tomada sobre TENDÊNCIA, não sobre uma medição isolada.

    Somente leitura sobre o negócio — a única escrita é a própria série. Credenciais vêm do .env
    na raiz do projeto a cada execução; não altere este arquivo para trocá-las.

.PARAMETER DryRun
    Mede e imprime sem gravar a série. Exemplo: .\run_gatilhos.ps1 -DryRun
#>

param(
    [switch]$DryRun
)

# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------
$PROJECT_ROOT = Split-Path -Parent $PSScriptRoot
$SCRIPT       = Join-Path $PROJECT_ROOT "skills\roadmap-gatilhos\scripts\run.py"
$LOG_DIR      = Join-Path $PROJECT_ROOT "logs\gatilhos"

# 🔴 RETENÇÃO DE 400 DIAS, NÃO 30. As outras tarefas rodam de 5 em 5 minutos ou 1x por dia, e
# 30 dias guardam dezenas de execuções. Aqui a execução é MENSAL: com os mesmos 30 dias, o log da
# medição anterior seria apagado ANTES da próxima rodar, e nunca haveria dois logs para comparar —
# exatamente a comparação que justifica a tarefa existir. 400 dias cobrem 13 medições, o que ainda
# permite confrontar com o mesmo mês do ano anterior.
$LOG_RETENTION_DAYS = 400

# ---------------------------------------------------------------------------
# Logging — criado ANTES da detecção do Python para garantir registro de erros
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $LOG_DIR | Out-Null

# ---------------------------------------------------------------------------
# Localiza Python (mesma ordem das demais tarefas do projeto)
# ---------------------------------------------------------------------------
$PYTHON = $null
$PYTHON_ARGS = @()

# Rejeita o build free-threaded (3.14t) por paridade com as demais tarefas.
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
        "C:\Python314\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe"
    )
    foreach ($c in $candidates) {
        if ((Test-Path $c) -and (Test-PythonUsable $c @())) {
            $PYTHON = $c; $PYTHON_ARGS = @(); break
        }
    }
}

# 🔴 Log com ANO-MÊS, não ano-mês-dia: a tarefa é mensal, então um arquivo por mês agrupa a
# execução regular e as eventuais reexecuções manuais do mesmo mês no MESMO lugar — que é como
# alguém vai querer lê-las depois.
$LOG_FILE   = Join-Path $LOG_DIR "gatilhos_$(Get-Date -Format 'yyyyMM').log"

# 🔴 TEMPORÁRIOS POR PROCESSO ($PID), não com nome fixo. Com `_stdout.tmp` fixo, uma execução
# manual coincidindo com a agendada faz as duas apontarem `-RedirectStandardOutput` para o MESMO
# arquivo: no Windows o segundo `Start-Process` falha ao abri-lo, e a execução morre por um motivo
# que não tem nada a ver com a medição. O `MultipleInstancesPolicy=IgnoreNew` da tarefa protege
# apenas o Agendador contra si mesmo — não contra alguém rodando o runner à mão no mesmo minuto.
$STDOUT_TMP = Join-Path $LOG_DIR "_stdout_$PID.tmp"
$STDERR_TMP = Join-Path $LOG_DIR "_stderr_$PID.tmp"

function Write-Log {
    param([string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
    Write-Host $line
}

if (-not $PYTHON) {
    Write-Log "ERRO: Python compativel nao encontrado. Instale Python 3.12 em python.org."
    exit 1
}

# Remove logs mais antigos que LOG_RETENTION_DAYS
Get-ChildItem -Path $LOG_DIR -Filter "gatilhos_*.log" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$LOG_RETENTION_DAYS) } |
    Remove-Item -Force

# Órfãos de execuções mortas (Agendador matou por timeout, máquina reiniciou): sem esta limpeza,
# os `_stdout_<pid>.tmp` se acumulariam para sempre na pasta de log. 1 dia é folga larga — a
# medição inteira leva segundos, e o teto do script é de 10 minutos.
Get-ChildItem -Path $LOG_DIR -Filter "_std*_*.tmp" -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } |
    Remove-Item -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# Ambiente Python
# ---------------------------------------------------------------------------
$env:PYTHONIOENCODING   = "utf-8"
$env:PYTHONFAULTHANDLER = "1"
$env:PYTHONNOUSERSITE   = "1"
[System.Environment]::SetEnvironmentVariable("WER_FAULT_REPORTING_POLICY", "4", "Process")

# ---------------------------------------------------------------------------
# Execução
# ---------------------------------------------------------------------------
$SCRIPT_ARGS = @($SCRIPT)
if ($DryRun) { $SCRIPT_ARGS += "--dry-run" }

Write-Log "===== Inicio da medicao mensal dos gatilhos ====="
Write-Log "Python : $PYTHON"
Write-Log "Script : $SCRIPT"
if ($DryRun) { Write-Log "Modo   : DRY-RUN (nao grava a serie)" }

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

# Grava stdout no log mensal
if (Test-Path $STDOUT_TMP) {
    Get-Content $STDOUT_TMP -Encoding UTF8 | ForEach-Object {
        Add-Content -Path $LOG_FILE -Value $_ -Encoding UTF8
        Write-Host $_
    }
    Remove-Item $STDOUT_TMP -Force
}

# O logging INFO do Python sai por stderr — aparece MESMO EM SUCESSO (é onde ficam as medições
# de cada gatilho). O sinal de erro é o exit != 0, nunca a presença de stderr.
if ((Test-Path $STDERR_TMP) -and (Get-Item $STDERR_TMP).Length -gt 0) {
    Write-Log "--- STDERR / FAULTHANDLER ---"
    Get-Content $STDERR_TMP -Encoding UTF8 | ForEach-Object {
        Add-Content -Path $LOG_FILE -Value "[STDERR] $_" -Encoding UTF8
        Write-Host "[STDERR] $_"
    }
    Write-Log "--- FIM STDERR ---"
}

# Limpeza incondicional: o bloco acima só removia o stderr quando ele tinha conteúdo, então uma
# execução silenciosa deixava um `_stderr_<pid>.tmp` vazio para trás — com nome por processo, isso
# se acumula. Aqui os dois somem sempre, inclusive quando o Python falhou antes de escrever.
foreach ($f in @($STDOUT_TMP, $STDERR_TMP)) {
    if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------------------
# Resultado
# ---------------------------------------------------------------------------
if ($EXIT -eq 0) {
    Write-Log "===== Fim OK (exit: $EXIT) ====="
} else {
    Write-Log "===== CRASH / ERRO (exit: $EXIT) ====="

    try {
        $src = "Pagamentos-Gatilhos"
        if (-not [System.Diagnostics.EventLog]::SourceExists($src)) {
            [System.Diagnostics.EventLog]::CreateEventSource($src, "Application")
        }
        Write-EventLog -LogName Application -Source $src -EventId 1005 `
            -EntryType Error `
            -Message "run.py (medicao de gatilhos da Onda 9) terminou com exit code $EXIT em $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'). Verifique $LOG_DIR"
    } catch {
        Write-Log "Aviso: nao foi possivel gravar no Event Log do Windows: $_"
    }
}

exit $EXIT
