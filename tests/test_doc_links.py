"""Guarda dos PONTEIROS entre os .md do projeto.

O `CLAUDE.md` deixou de carregar tudo e passou a apontar para `docs/` (enxugamento de
2026-08-04). Ponteiro quebrado é pior que texto ausente: quem lê o `CLAUDE.md` acredita que a
regra está documentada, segue o link e não encontra nada — e a regra some sem ninguem perceber.

Renomear ou mover um arquivo em `docs/` NAO produz erro em lugar nenhum (nenhum codigo le .md).
Este teste e a unica coisa que acusa.
"""

import re
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]

# Documentos que participam da rede de ponteiros. Cada um e verificado nos dois sentidos:
# os links que ele emite existem, e (para os de docs/) ele e alcancavel a partir do CLAUDE.md.
FONTES = [
    RAIZ / "CLAUDE.md",
    RAIZ / "docs" / "knowledge" / "pipeline-extracao.md",
    RAIZ / "docs" / "knowledge" / "api-crud.md",
    RAIZ / "docs" / "deploy" / "historico-deploys.md",
]

# Arquivos que NASCERAM do enxugamento do CLAUDE.md: se um deles ficar orfao, o conteudo
# extraido some da pratica (docs/ nao entra no contexto automatico da sessao).
EXTRAIDOS = [
    "docs/knowledge/pipeline-extracao.md",
    "docs/knowledge/api-crud.md",
    "docs/deploy/historico-deploys.md",
]

# Link markdown cujo alvo e um caminho relativo terminando em .md (ignora http(s):// e ancoras).
_LINK_MD = re.compile(r"\[[^\]]+\]\((?!https?://|#)([^)\s]+\.md)(?:#[^)\s]*)?\)")


def _links(texto: str) -> list[str]:
    return _LINK_MD.findall(texto)


class PonteirosEntreDocsTest(unittest.TestCase):
    def test_sanidade_do_parser(self):
        """Sem isto, um regex que para de casar transforma a guarda em `0 == 0`, verde p/ sempre."""
        achados = _links(
            "ver [x](docs/a.md) e [y](docs/b.md#secao) mas nao [z](https://ex.com/c.md) nem [w](#ancora)"
        )
        self.assertEqual(achados, ["docs/a.md", "docs/b.md"])

        # E o parser tem de achar links de verdade no CLAUDE.md — se um dia ele deixar de casar,
        # o teste abaixo passaria com uma lista vazia.
        reais = _links((RAIZ / "CLAUDE.md").read_text(encoding="utf-8"))
        self.assertGreaterEqual(
            len(reais), 5, "o parser deixou de casar os links do CLAUDE.md (formato mudou?)"
        )

    def test_todo_link_para_md_existe(self):
        quebrados = []
        for fonte in FONTES:
            self.assertTrue(fonte.exists(), f"documento-fonte sumiu: {fonte.relative_to(RAIZ)}")
            for alvo in _links(fonte.read_text(encoding="utf-8")):
                if not (RAIZ / alvo).exists():
                    quebrados.append(f"{fonte.relative_to(RAIZ)} -> {alvo}")
        self.assertEqual(
            quebrados, [], "ponteiro quebrado (o alvo nao existe):\n  " + "\n  ".join(quebrados)
        )

    def test_skills_citadas_no_CLAUDE_md_existem(self):
        """O CLAUDE.md delega procedimentos a skills; skill renomeada deixa o ponteiro cego.

        Nenhum codigo carrega .claude/skills/, entao apagar ou renomear a pasta nao produz erro
        em lugar nenhum — o texto continua mandando "use a skill X" e ela nao existe mais.
        """
        claude = (RAIZ / "CLAUDE.md").read_text(encoding="utf-8")
        citadas = set(re.findall(r"\.claude/skills/([a-z0-9-]+)", claude))
        self.assertGreaterEqual(
            len(citadas), 1, "o parser deixou de casar as skills citadas (formato mudou?)"
        )
        for nome in sorted(citadas):
            skill = RAIZ / ".claude" / "skills" / nome / "SKILL.md"
            self.assertTrue(
                skill.exists(),
                f"o CLAUDE.md manda usar a skill '{nome}', mas {skill.relative_to(RAIZ)} nao existe",
            )

    def test_os_docs_extraidos_sao_alcancaveis_pelo_CLAUDE_md(self):
        """O conteudo movido so continua encontravel se o CLAUDE.md apontar para ele.

        `docs/` nao e carregado automaticamente na sessao; um arquivo orfao ali equivale a
        conteudo perdido.
        """
        claude = _links((RAIZ / "CLAUDE.md").read_text(encoding="utf-8"))
        for extraido in EXTRAIDOS:
            self.assertIn(
                extraido, claude,
                f"{extraido} ficou orfao: o CLAUDE.md nao aponta mais para ele",
            )


if __name__ == "__main__":
    unittest.main()
