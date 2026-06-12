# clear_local_data.ps1
# Apaga arquivos temporários locais gerados pelo pipeline de e-mails.
# Uso: .\scripts\clear_local_data.ps1
# Flags:
#   -WhatIf   → mostra o que seria removido, sem apagar
#   -Force    → pula a confirmação interativa

[CmdletBinding(SupportsShouldProcess)]
param(
  [switch]$Force
)

$targets = @(
  @{ Path = 'data\pdfs_inbox'; Desc = 'PDFs baixados' },
  @{ Path = 'data\csv_output'; Desc = 'CSVs gerados' }
)

foreach ($t in $targets) {
  $full = Join-Path $PSScriptRoot '..' $t.Path
  $full = [System.IO.Path]::GetFullPath($full)

  if (-not (Test-Path $full)) {
    Write-Host "  [skip] $($t.Desc) — pasta não encontrada: $full"
    continue
  }

  $files = Get-ChildItem -Path $full -Recurse -File
  $count = $files.Count

  if ($count -eq 0) {
    Write-Host "  [ok]   $($t.Desc) — pasta já vazia"
    continue
  }

  if (-not $Force -and -not $WhatIfPreference) {
    $resp = Read-Host "  Remover $count arquivo(s) em '$($t.Path)'? [s/N]"
    if ($resp -notmatch '^[sS]$') {
      Write-Host "  [skip] $($t.Desc) — cancelado pelo usuário"
      continue
    }
  }

  if ($PSCmdlet.ShouldProcess("$($t.Path) ($count arquivo(s))", 'Remover')) {
    Remove-Item -Path "$full\*" -Recurse -Force
    Write-Host "  [done] $($t.Desc) — $count arquivo(s) removido(s)"
  }
}
