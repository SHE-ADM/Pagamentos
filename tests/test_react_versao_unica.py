# -*- coding: utf-8 -*-
"""Guarda: o monorepo declara UMA versao maior de React.

POR QUE ESTA GUARDA EXISTE

Ate a Fase 2 do upgrade o monorepo tinha React 18 (frontend-vite, hoisted na raiz) e 19 (apps
Next, aninhado). A consequencia era um erro dificil de ler — "Objects are not valid as a React
child", que nao menciona versao em lugar nenhum — e ela custou um contorno permanente: o portal
testa por `renderToStaticMarkup` em vez de jsdom + Testing Library.

O conflito acabou, mas a DOCUMENTACAO dele sobreviveu por meses em tres lugares (napkin,
`portal-next/vitest.config.ts` e `app/page.test.tsx`), prescrevendo um follow-up ja feito e
justificando uma escolha por um motivo que deixou de valer. Foi so ao conferir contra o `npm ls`
que a divergencia apareceu.

Esta guarda fecha o outro lado: se alguem reintroduzir um React de major diferente, os
`resolve.dedupe` escolhem UMA copia em silencio e o sintoma reaparece longe da causa.

⚠️ A guarda le as DECLARACOES (package.json dos workspaces), nao o `node_modules`: o objetivo e
falhar no momento em que a divergencia entra no repositorio, sem depender de instalacao. A
verificacao complementar — copias fisicas em disco — e manual e esta registrada no napkin.

🔴 NAO medir versao de react com substring: `lucide-react@1.21.0` e `@testing-library/react@16.3.2`
casam `react@<versao>` e produzem uma resposta confiantemente errada (aconteceu ao levantar este
achado). Aqui a leitura e por CHAVE do dicionario de dependencias, que nao tem esse problema.
"""

import json
import re
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]

# Os workspaces declarados na raiz. Lidos do proprio package.json para nao manter uma lista
# paralela que envelhece quando um app novo entra.
def _workspaces() -> list[Path]:
    raiz_pkg = json.loads((RAIZ / "package.json").read_text(encoding="utf-8"))
    padroes = raiz_pkg.get("workspaces", [])
    assert padroes, "package.json da raiz sem `workspaces` (o formato mudou?)"
    alvos: list[Path] = []
    for padrao in padroes:
        for p in sorted(RAIZ.glob(padrao)):
            if (p / "package.json").is_file():
                alvos.append(p)
    return alvos


def _react_declarado(pkg: Path) -> str | None:
    """A faixa de versao de `react` declarada — por CHAVE, nunca por substring."""
    dados = json.loads((pkg / "package.json").read_text(encoding="utf-8"))
    for secao in ("dependencies", "devDependencies", "peerDependencies"):
        faixa = dados.get(secao, {}).get("react")
        if faixa:
            return faixa
    return None


def _major(faixa: str) -> str:
    m = re.search(r"(\d+)", faixa)
    assert m, f"nao consegui extrair o major de {faixa!r}"
    return m.group(1)


class ReactVersaoUnicaTest(unittest.TestCase):
    def test_sanidade_do_localizador(self):
        """Sem workspaces, ou sem nenhum declarando react, o teste abaixo seria `0 == 0`."""
        ws = _workspaces()
        self.assertGreaterEqual(len(ws), 3, f"esperava >= 3 workspaces, achei {[p.name for p in ws]}")
        declaram = [p.name for p in ws if _react_declarado(p)]
        self.assertGreaterEqual(
            len(declaram), 2, f"esperava >= 2 workspaces declarando react, achei {declaram}"
        )

    def test_todos_os_workspaces_declaram_o_mesmo_major(self):
        majors = {}
        for p in _workspaces():
            faixa = _react_declarado(p)
            if faixa:
                majors.setdefault(_major(faixa), []).append(f"{p.name} ({faixa})")

        self.assertEqual(
            len(majors), 1,
            "o monorepo voltou a ter mais de uma versao maior de React — os `resolve.dedupe` vao "
            f"escolher UMA em silencio e o sintoma reaparece longe da causa: {majors}",
        )

    def test_o_major_e_o_19_documentado(self):
        """Ancora no numero que o CLAUDE.md e o napkin afirmam — subir de major e decisao, nao acidente."""
        majors = {_major(f) for p in _workspaces() if (f := _react_declarado(p))}
        self.assertEqual(
            majors, {"19"},
            "a documentacao (CLAUDE.md, .claude/napkin.md) afirma React 19 unificado; atualize os "
            f"dois lados juntos se a versao mudar de proposito: {majors}",
        )


if __name__ == "__main__":
    unittest.main()
