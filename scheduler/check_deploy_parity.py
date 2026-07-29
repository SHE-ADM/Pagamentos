#!/usr/bin/env python3
"""Verifica se a máquina de PRODUÇÃO está com os mesmos arquivos do repositório.

POR QUE ESTE SCRIPT EXISTE
--------------------------
O deploy do pipeline Python é cópia manual de arquivo (não há `git pull` em produção — ver
"Deploy manual do Email Reader" no CLAUDE.md). Isso funciona, mas **não havia como responder
"produção está atualizada?"** senão relendo avisos espalhados pela documentação. O resultado
previsível: em 2026-07-29 havia **13 avisos de "PENDENTE de cópia p/ prod"** acumulados, o mais
antigo de 19 dias — correções mescladas em `main` que continuavam não valendo em produção, sem
que nada apontasse isso. Um arquivo esquecido não dá erro: o pipeline simplesmente segue rodando
a versão velha e os bugs "corrigidos" continuam acontecendo.

Este script troca a memória por medição. Rode-o EM PRODUÇÃO depois de qualquer cópia:

    py -3 scheduler\\check_deploy_parity.py

Saída: um veredito por arquivo (OK / DIVERGENTE / FALTANDO / EXTRA) e um exit code utilizável —
`0` quando tudo confere, `1` quando há divergência. Isso o torna agendável: uma tarefa semanal
no Agendador acusa deriva sem ninguém precisar lembrar.

COMO FUNCIONA
-------------
`deploy-manifest.json` (ao lado deste arquivo) guarda o SHA-256 de cada arquivo que compõe o
deploy. Ele é gerado NO REPOSITÓRIO com `--update` e versionado junto com o código, de modo que o
manifesto e os arquivos evoluem no mesmo commit — não há lista para manter à mão.

    # no repositório, após alterar qualquer script de deploy:
    py -3 scheduler\\check_deploy_parity.py --update

O hash é calculado sobre os BYTES do arquivo, com uma normalização deliberada de fim de linha
(ver `_read_normalized`): o repositório é LF por `.gitattributes`, mas uma cópia feita por
ferramenta que reescreva em modo texto no Windows vira CRLF. Sem normalizar, todo arquivo copiado
apareceria como DIVERGENTE — ruído que faria o script ser ignorado, que é o modo de falha real de
uma verificação como esta.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

# Raiz do checkout/deploy: este arquivo vive em <raiz>/scheduler/.
ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = Path(__file__).resolve().parent / "deploy-manifest.json"

# Tudo que compõe o deploy em C:\Sheild\API\Pagamentos. Um arquivo NOVO que passe a ser
# necessário em produção (como `febraban.py`, extraído em 2026-07-28) precisa entrar aqui —
# senão ele é justamente o que ninguém percebe que faltou copiar.
DEPLOY_GLOBS: tuple[str, ...] = (
    "skills/email-reader/scripts/*.py",
    "skills/pdf-contas-pagar/scripts/*.py",
    "skills/cobranca-vencidos/scripts/*.py",
    "skills/backup-supabase/scripts/*.py",
    "skills/baixa-automatica/scripts/*.py",
    "scheduler/*.ps1",
)

# Ferramentas que rodam NO DEV (ou que o operador deliberadamente não instala) e portanto não
# pertencem a produção. Sem esta exclusão elas apareceriam como FALTANDO para sempre — e um
# alerta que sempre grita é um alerta que se aprende a ignorar, que é como esta verificação
# falharia na prática.
DEPLOY_EXCLUDE: frozenset[str] = frozenset(
    {
        # Copia o bundle do dev PARA produção; nunca executa lá. O operador também prefere a
        # cópia manual (ver "Deploy manual do Email Reader" no CLAUDE.md).
        "scheduler/deploy-prod.ps1",
        # Este próprio verificador: útil em produção, mas sua ausência não é uma falha de deploy
        # do pipeline — e um manifesto que se auto-inclui muda de hash a cada edição do script.
        "scheduler/check_deploy_parity.py",
    }
)

# As mensagens têm acentos, e o console do Windows pode estar numa code page legada (cp1252 /
# cp437) que não os representa. Sem isto, um `print` com "Produção" levanta UnicodeEncodeError e
# DERRUBA a verificação — falha muito pior que um acento errado na tela, porque a tarefa agendada
# passaria a reportar erro sem relação com o deploy. `errors="replace"` garante que o pior caso
# seja um caractere trocado, nunca um crash.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(errors="replace")  # type: ignore[union-attr]


def _ansi_supported() -> bool:
    """True só quando a saída realmente RENDERIZA sequências ANSI.

    `sys.stdout.isatty()` sozinho não basta no Windows: o console é um terminal, mas descarta
    ANSI a menos que o processo habilite ENABLE_VIRTUAL_TERMINAL_PROCESSING. Confiar apenas no
    isatty imprime os códigos crus no meio do texto (`[32mOK ... [0m`) — observado no PowerShell
    da máquina de produção, e é pior que não ter cor: polui exatamente o relatório que precisa ser
    lido rápido. Aqui a cor só é ligada depois de o modo ser habilitado com sucesso.
    """
    if not sys.stdout.isatty():
        return False  # redirecionado (log de tarefa agendada) — nunca colorir
    if os.name != "nt":
        return True

    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_ulong()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
        return bool(kernel32.SetConsoleMode(handle, mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING))
    except (ImportError, AttributeError, OSError):
        # Console sem suporte (ou ctypes indisponível): degrada para texto puro, nunca para lixo
        # na tela. Exceções são específicas de propósito — um erro inesperado aqui deve subir.
        return False


_TTY = _ansi_supported()
_GREEN, _RED, _YELLOW, _DIM, _RESET = (
    ("\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m") if _TTY else ("", "", "", "", "")
)


def _read_normalized(path: Path) -> bytes:
    """Bytes do arquivo com CRLF/CR normalizados para LF.

    O repositório é LF (`.gitattributes`), mas copiar por ferramenta que grave em modo texto no
    Windows converte para CRLF — mudança que não altera o comportamento do código e não deve ser
    reportada como divergência. Ver "FIM DE LINHA" no CLAUDE.md, onde o mesmo fenômeno já inflou
    um diff de 716 para 12.578 linhas.
    """
    return path.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def _digest(path: Path) -> str:
    return hashlib.sha256(_read_normalized(path)).hexdigest()


def _collect(root: Path) -> dict[str, str]:
    """Mapeia caminho relativo (POSIX) -> sha256, para todos os arquivos de deploy presentes."""
    found: dict[str, str] = {}
    for pattern in DEPLOY_GLOBS:
        for path in sorted(root.glob(pattern)):
            if not path.is_file():
                continue
            if path.name.startswith("__") or "__pycache__" in path.parts:
                continue
            rel = path.relative_to(root).as_posix()
            if rel in DEPLOY_EXCLUDE:
                continue
            found[rel] = _digest(path)
    return found


def _load_manifest() -> dict[str, str]:
    if not MANIFEST_PATH.exists():
        raise SystemExit(
            f"{_RED}manifesto ausente:{_RESET} {MANIFEST_PATH}\n"
            "Gere-o no repositório com: py -3 scheduler/check_deploy_parity.py --update"
        )
    data = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    files = data.get("files")
    if not isinstance(files, dict) or not files:
        raise SystemExit(f"{_RED}manifesto inválido ou vazio:{_RESET} {MANIFEST_PATH}")
    return files


def update() -> int:
    """Regrava o manifesto a partir do estado atual do repositório."""
    files = _collect(ROOT)
    if not files:
        print(f"{_RED}nenhum arquivo de deploy encontrado em {ROOT}{_RESET}")
        return 1
    payload = {
        "_comment": (
            "SHA-256 dos arquivos copiados para a máquina de produção "
            "(C:\\Sheild\\API\\Pagamentos). Gerado por scheduler/check_deploy_parity.py --update; "
            "não editar à mão. Hash calculado com fim de linha normalizado para LF."
        ),
        "files": files,
    }
    # newline="\n": gravar em modo texto no Windows converteria para CRLF e sujaria o diff.
    MANIFEST_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"{_GREEN}manifesto atualizado{_RESET}: {len(files)} arquivos -> {MANIFEST_PATH.name}")
    return 0


def check() -> int:
    """Compara o diretório atual (produção) com o manifesto. Exit 1 se houver divergência."""
    expected = _load_manifest()
    actual = _collect(ROOT)

    faltando = [f for f in expected if f not in actual]
    divergentes = [f for f, h in expected.items() if f in actual and actual[f] != h]
    # EXTRA não é erro: produção legitimamente não tem `apps/`, `supabase/` etc., mas um .py a
    # mais dentro de uma pasta de deploy costuma ser resto de teste manual — vale reportar.
    extras = [f for f in actual if f not in expected]
    ok = [f for f in expected if f in actual and actual[f] == expected[f]]

    print(f"raiz verificada: {ROOT}")
    print(f"manifesto      : {MANIFEST_PATH}\n")

    for f in sorted(faltando):
        print(f"  {_RED}FALTANDO  {_RESET} {f}")
    for f in sorted(divergentes):
        print(f"  {_YELLOW}DIVERGENTE{_RESET} {f}")
    for f in sorted(extras):
        print(f"  {_DIM}EXTRA     {_RESET} {f}")
    if _TTY:
        for f in sorted(ok):
            print(f"  {_GREEN}OK        {_RESET} {f}")

    total = len(expected)
    print(
        f"\n{len(ok)}/{total} conferem"
        f" | faltando: {len(faltando)} | divergentes: {len(divergentes)} | extras: {len(extras)}"
    )

    if faltando or divergentes:
        print(
            f"\n{_RED}PRODUÇÃO DESATUALIZADA.{_RESET} Copie do repositório os arquivos acima "
            "(FALTANDO/DIVERGENTE) e rode este script de novo."
        )
        return 1

    print(f"\n{_GREEN}Produção em paridade com o repositório.{_RESET}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verifica a paridade dos arquivos de deploy entre repositório e produção.",
    )
    parser.add_argument(
        "--update",
        action="store_true",
        help="Regrava o manifesto a partir do repositório (rodar no DEV, após alterar scripts).",
    )
    args = parser.parse_args()
    return update() if args.update else check()


if __name__ == "__main__":
    sys.exit(main())
