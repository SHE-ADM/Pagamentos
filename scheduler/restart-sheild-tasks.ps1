<#
.SYNOPSIS
  Status e reinício seguro APENAS das tarefas agendadas do Pagamentos (produção).

.DESCRIPTION
  Em produção (C:\Sheild\API\Pagamentos) não há servidor web — os "serviços" são
  tarefas do Windows Task Scheduler. Este script age SOMENTE nas tarefas do
  Pagamentos (allowlist $MANAGED_TASKS). Outras tarefas na pasta \Sheild\
  (ex.: API B2B, Boletos, Estoque, Relatórios) são processamentos INDEPENDENTES —
  bancos/tabelas diferentes — e este script NUNCA as reinicia. Elas só aparecem na
  listagem de status (leitura), para contexto.

    - SEM parâmetro: LISTA o estado das tarefas \Sheild\ (coluna "Gerenciada"
      marca quais este script controla). Seguro, é o uso comum.

    - COM -Restart: reinicia (Stop -> Start) APENAS as tarefas DO PAGAMENTOS que
      estiverem TRAVADAS em execução. Como ambas são batch com efeito externo
      (enviam e-mail / gravam dados), exige confirmação interativa antes de
      disparar — startá-las fora de hora ENVIARIA e-mails reais.

  Não precisa rodar isto após reboot/queda de energia: o serviço "Agendador de
  Tarefas" sobe com o Windows e re-dispara as tarefas de horário sozinho (desde
  que a BIOS religue a máquina e as tarefas estejam como "executar logado ou não"
  + "executar se a execução agendada for perdida").

.PARAMETER Restart
  Reinicia as tarefas do Pagamentos travadas em execução (com confirmação).

.EXAMPLE
  .\restart-sheild-tasks.ps1
  # Só mostra o estado (marca quais são gerenciadas)

.EXAMPLE
  .\restart-sheild-tasks.ps1 -Restart
  # Reinicia apenas tarefas do Pagamentos travadas; nunca toca API B2B/outras
#>

[CmdletBinding()]
param(
  [switch]$Restart
)

# Pasta das tarefas no Agendador.
$TASK_PATH = '\Sheild\'

# ALLOWLIST — únicas tarefas que ESTE script pode reiniciar. Tudo que não estiver
# aqui (API B2B, Boletos, Estoque, Relatórios...) é processamento independente e
# JAMAIS é tocado. Ajuste os nomes se renomear as tarefas no Agendador.
$MANAGED_TASKS = @(
  'Pagamentos - Cobrança Vencidos',
  'Pagamentos - Email Reader'
)

# Códigos de resultado mais comuns -> texto leigo (LastTaskResult vem em inteiro).
function Format-Result([int]$code) {
  switch ($code) {
    0          { 'OK (0)' }
    1          { 'Concluído com erros (0x1)' }
    267009     { 'Em execução (0x41301)' }
    267011     { 'Nunca executou (0x41303)' }
    2147942402 { 'Arquivo não encontrado (0x2)' }
    default    { ('0x{0:X}' -f $code) }
  }
}

$tasks = Get-ScheduledTask -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
if (-not $tasks) {
  Write-Warning "Nenhuma tarefa encontrada em $TASK_PATH. Esta máquina é a de produção?"
  return
}

Write-Output "== Tarefas em $TASK_PATH (gerenciadas = controladas por este script) =="
$rows = foreach ($t in $tasks) {
  $info = $t | Get-ScheduledTaskInfo
  [pscustomobject]@{
    Gerenciada      = if ($MANAGED_TASKS -contains $t.TaskName) { 'Sim' } else { 'Não' }
    Tarefa          = $t.TaskName
    Estado          = $t.State
    UltimoResultado = Format-Result ([int]$info.LastTaskResult)
    UltimaExecucao  = $info.LastRunTime
    ProximaExecucao = $info.NextRunTime
  }
}
$rows | Sort-Object Gerenciada -Descending | Format-Table -AutoSize

if (-not $Restart) {
  Write-Output ""
  Write-Output "(somente leitura) Use -Restart para reiniciar tarefas do Pagamentos travadas."
  Write-Output "Tarefas NÃO gerenciadas (API B2B, etc.) nunca são tocadas por este script."
  return
}

# ── Reinício: SÓ tarefas gerenciadas (Pagamentos) que estão REALMENTE travadas ──
$managedRunning = $tasks | Where-Object {
  ($MANAGED_TASKS -contains $_.TaskName) -and ($_.State -eq 'Running')
}
if (-not $managedRunning) {
  Write-Output ""
  Write-Output "Nenhuma tarefa do Pagamentos travada em execução. Nada a reiniciar."
  Write-Output "(Para rodar uma batch sob demanda use: Start-ScheduledTask -TaskName '<nome>' -TaskPath '$TASK_PATH')"
  return
}

foreach ($t in $managedRunning) {
  # Ambas as gerenciadas são batch com efeito externo — confirma antes.
  $ans = Read-Host "Reiniciar '$($t.TaskName)'? Isso PODE ENVIAR E-MAILS REAIS / reprocessar. (s/N)"
  if ($ans -ne 's') { Write-Output "  -> cancelado."; continue }
  Write-Output "Reiniciando '$($t.TaskName)'..."
  Stop-ScheduledTask  -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Start-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath
}
Write-Output "Concluído."
