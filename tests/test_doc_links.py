"""Guardas do CLAUDE.md: PONTEIROS, TETO de linhas e CONTADORES moveis.

O `CLAUDE.md` deixou de carregar tudo e passou a apontar para `docs/`, para as skills de
`.claude/skills/` e para o `progress.md` (enxugamentos de 2026-08-04 e 2026-08-18).

Tres coisas quebram em silencio quando isso acontece, e cada uma tem sua guarda aqui:

1. PONTEIRO QUEBRADO e pior que texto ausente: quem le o `CLAUDE.md` acredita que a regra esta
   documentada, segue o link e nao encontra nada — e a regra some sem ninguem perceber. Renomear
   ou mover um arquivo em `docs/` NAO produz erro em lugar nenhum (nenhum codigo le .md).
2. RECRESCIMENTO: o arquivo ja foi enxugado uma vez (6.976 -> ~3.990) e voltou a 5.773 em 13 dias.
   So documentacao nao segurou; o teto abaixo e a barreira mecanica.
3. CONTADOR MOVEL: numero que um comando responde melhor (proxima migration, total da suite,
   entradas do manifesto) envelhece em dias e passa a informar errado. Ja aconteceu: o manifesto
   aparecia como "28 para 31" em dois lugares e "31 para 32" num terceiro, com o valor real 32.
"""

import re
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
CLAUDE_MD = RAIZ / "CLAUDE.md"

# Documentos que participam da rede de ponteiros. Cada um e verificado nos dois sentidos:
# os links que ele emite existem, e (para os extraidos) ele e alcancavel a partir do CLAUDE.md.
#
# As SKILLS entram por glob, e nao a mao: o enxugamento de 2026-08-18 moveu 149 regras marcadas 🔴
# para `.claude/skills/`, entao elas viraram superficie normativa de primeira classe e um ponteiro
# cego ali some do mesmo jeito. O glob e o que faz uma skill NOVA nascer coberta — uma lista fixa
# so cobriria as de hoje, e a proxima entraria sem guarda.
_SKILLS_MD = sorted((RAIZ / ".claude" / "skills").glob("*/*.md"))

FONTES = [
    CLAUDE_MD,
    RAIZ / "progress.md",
    RAIZ / "docs" / "knowledge" / "pipeline-extracao.md",
    RAIZ / "docs" / "knowledge" / "api-crud.md",
    RAIZ / "docs" / "knowledge" / "dashboards.md",
    RAIZ / "docs" / "knowledge" / "auth.md",
    RAIZ / "docs" / "db" / "historico-migrations.md",
    RAIZ / "docs" / "deploy" / "historico-deploys.md",
    *_SKILLS_MD,
]

# Arquivos que NASCERAM do enxugamento do CLAUDE.md: se um deles ficar orfao, o conteudo
# extraido some da pratica (docs/ nao entra no contexto automatico da sessao).
EXTRAIDOS = [
    "progress.md",
    "docs/knowledge/pipeline-extracao.md",
    "docs/knowledge/api-crud.md",
    "docs/knowledge/dashboards.md",
    "docs/knowledge/auth.md",
    "docs/db/historico-migrations.md",
    "docs/deploy/historico-deploys.md",
]

# --- Teto de linhas -------------------------------------------------------------------------
# Ancorado na medicao REAL do enxugamento de 2026-08-18 (1.100 linhas), com folga para o arquivo
# respirar sem virar depositorio de novo. Estourar o teto nao significa "apague conteudo":
# significa "escolha o destino certo" — skill (procedimento), docs/ (o porque) ou progress.md
# (o que expira).
TETO_GLOBAL = 1400
TETO_POR_SECAO = 320

# --- Contadores moveis ----------------------------------------------------------------------
# Padroes que descrevem ESTADO em vez de REGRA. O CLAUDE.md deve carregar o comando que os
# deriva, nunca o valor.
CONTADORES_PROIBIDOS = [
    (
        r"[Pp]r[óo]xima migration\s*=",
        "numero da proxima migration — derive com `ls supabase/migrations | tail -1`",
    ),
    (
        r"\b\d\.\d{3}\s+testes\b",
        "total da suite — derive com `npm test` / `pytest`",
    ),
    (
        r"manifest[^\n]{0,40}(?:foi|passou) de\s*\*{0,2}\s*\d+\s*(?:para|a)\s*\d+",
        "contagem do manifesto de deploy — derive de scheduler/deploy-manifest.json",
    ),
]

# Link markdown cujo alvo e um caminho relativo terminando em .md (ignora http(s):// e ancoras).
_LINK_MD = re.compile(r"\[[^\]]+\]\((?!https?://|#)([^)\s]+\.md)(?:#[^)\s]*)?\)")

# Cabecalho de secao de 2o nivel.
_H2 = re.compile(r"^## .+$", re.MULTILINE)


def _links(texto: str) -> list[str]:
    return _LINK_MD.findall(texto)


def _secoes(texto: str) -> list[tuple[str, int]]:
    """Devolve [(titulo, n_linhas)] por secao H2."""
    linhas = texto.splitlines()
    marcos = [i for i, linha in enumerate(linhas) if linha.startswith("## ")]
    if not marcos:
        return []
    fronteiras = marcos + [len(linhas)]
    return [
        (linhas[inicio], fim - inicio)
        for inicio, fim in zip(marcos, fronteiras[1:])
    ]


class PonteirosEntreDocsTest(unittest.TestCase):
    def test_sanidade_do_parser(self):
        """Sem isto, um regex que para de casar transforma a guarda em `0 == 0`, verde p/ sempre."""
        achados = _links(
            "ver [x](docs/a.md) e [y](docs/b.md#secao) mas nao [z](https://ex.com/c.md) nem [w](#ancora)"
        )
        self.assertEqual(achados, ["docs/a.md", "docs/b.md"])

        # E o parser tem de achar links de verdade no CLAUDE.md — se um dia ele deixar de casar,
        # o teste abaixo passaria com uma lista vazia.
        reais = _links(CLAUDE_MD.read_text(encoding="utf-8"))
        self.assertGreaterEqual(
            len(reais), 5, "o parser deixou de casar os links do CLAUDE.md (formato mudou?)"
        )

    def test_sanidade_as_skills_entram_na_rede(self):
        """Sem isto, um glob que para de casar tira as skills de FONTES em SILENCIO.

        O teste seguinte continuaria verde varrendo so os docs — a cobertura sumiria sem nenhum
        vermelho, que e a forma mais cara de perder uma guarda.
        """
        self.assertGreaterEqual(
            len(_SKILLS_MD), 1, "o glob de `.claude/skills/*/*.md` nao casou nada (pasta mudou?)"
        )
        emitidos = sum(len(_links(p.read_text(encoding="utf-8"))) for p in _SKILLS_MD)
        self.assertGreaterEqual(
            emitidos, 1, "nenhuma skill emite link .md — a inclusao em FONTES seria decoracao"
        )

    def test_todo_link_para_md_existe(self):
        quebrados = []
        for fonte in FONTES:
            self.assertTrue(fonte.exists(), f"documento-fonte sumiu: {fonte.relative_to(RAIZ)}")
            for alvo in _links(fonte.read_text(encoding="utf-8")):
                # Duas resolucoes, porque as duas convencoes convivem: os docs de `docs/` escrevem
                # o caminho a partir da RAIZ, e as skills escrevem relativo a si mesmas
                # (`../../../docs/...`). Exigir so a primeira reprovaria os 7 links das skills
                # sendo eles CORRETOS — verificacao que acusa defeito onde nao ha custa mais que
                # verificacao nenhuma.
                if not ((fonte.parent / alvo).exists() or (RAIZ / alvo).exists()):
                    quebrados.append(f"{fonte.relative_to(RAIZ)} -> {alvo}")
        self.assertEqual(
            quebrados, [], "ponteiro quebrado (o alvo nao existe):\n  " + "\n  ".join(quebrados)
        )

    def test_skills_citadas_no_CLAUDE_md_existem(self):
        """O CLAUDE.md delega procedimentos a skills; skill renomeada deixa o ponteiro cego.

        Nenhum codigo carrega .claude/skills/, entao apagar ou renomear a pasta nao produz erro
        em lugar nenhum — o texto continua mandando "use a skill X" e ela nao existe mais.
        """
        claude = CLAUDE_MD.read_text(encoding="utf-8")
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

        `docs/` e `progress.md` nao sao carregados automaticamente na sessao; um arquivo orfao
        ali equivale a conteudo perdido.
        """
        claude = _links(CLAUDE_MD.read_text(encoding="utf-8"))
        for extraido in EXTRAIDOS:
            self.assertIn(
                extraido, claude,
                f"{extraido} ficou orfao: o CLAUDE.md nao aponta mais para ele",
            )


class TetoDeLinhasTest(unittest.TestCase):
    """O CLAUDE.md entra no contexto de TODA sessao — cada linha e paga em todo turno.

    Estourar o teto nao quer dizer "apague conteudo": quer dizer que o conteudo novo tem outro
    dono. Skill para procedimento, docs/ para o porque, progress.md para o que expira.
    """

    def test_sanidade_do_parser_de_secoes(self):
        exemplo = "intro\n## A\nx\ny\n## B\nz\n"
        titulos = [t for t, _ in _secoes(exemplo)]
        self.assertEqual(titulos, ["## A", "## B"])
        self.assertEqual([n for _, n in _secoes(exemplo)], [3, 2])

        # E precisa achar secoes de verdade no arquivo real.
        reais = _secoes(CLAUDE_MD.read_text(encoding="utf-8"))
        self.assertGreaterEqual(
            len(reais), 5, "o parser deixou de casar as secoes do CLAUDE.md (formato mudou?)"
        )

    def test_CLAUDE_md_dentro_do_teto_global(self):
        total = len(CLAUDE_MD.read_text(encoding="utf-8").splitlines())
        self.assertLessEqual(
            total,
            TETO_GLOBAL,
            f"CLAUDE.md com {total} linhas, teto {TETO_GLOBAL}. O conteudo novo tem outro dono: "
            "skill (procedimento), docs/ (o porque) ou progress.md (o que expira).",
        )

    def test_nenhuma_secao_estoura_o_teto(self):
        estouradas = [
            f"{titulo.strip()} ({n} linhas)"
            for titulo, n in _secoes(CLAUDE_MD.read_text(encoding="utf-8"))
            if n > TETO_POR_SECAO
        ]
        self.assertEqual(
            estouradas,
            [],
            f"secao(oes) acima de {TETO_POR_SECAO} linhas — extraia para skill/docs:\n  "
            + "\n  ".join(estouradas),
        )


class ContadorMovelTest(unittest.TestCase):
    """Numero que um comando responde melhor nao se escreve no CLAUDE.md.

    Contador escrito envelhece em dias e passa a informar ERRADO — o pior desfecho, porque quem
    le acredita. O arquivo carrega a REGRA DE LEITURA do estado, nunca o estado.
    """

    def test_sanidade_dos_padroes(self):
        """Cada padrao tem de casar um exemplo real do formato que ele proibe.

        `strict=True` NAO e detalhe: sem ele o `zip` TRUNCA em silencio, e um padrao novo
        acrescentado sem o exemplo correspondente nunca seria exercido aqui. Com um typo no regex
        ele passaria a casar nada, e `test_contador_movel_nao_vive_no_CLAUDE_md` viraria `[] == []`
        para aquele padrao — verde para sempre, que e a armadilha que este arquivo existe para
        combater. Validado por mutante: 4 padroes / 3 exemplos ficam VERMELHOS com o `strict`.
        """
        exemplos = [
            "**Próxima migration = `132`** (verificar antes de criar nova).",
            "a suite Python esta em **1.486 testes** hoje",
            "o `deploy-manifest.json` foi de **28 para 31** entradas",
        ]
        for (padrao, _), exemplo in zip(CONTADORES_PROIBIDOS, exemplos, strict=True):
            self.assertRegex(
                exemplo,
                padrao,
                f"o padrao {padrao!r} deixou de casar o formato que deveria proibir",
            )

    def test_contador_movel_nao_vive_no_CLAUDE_md(self):
        texto = CLAUDE_MD.read_text(encoding="utf-8")
        achados = []
        for padrao, motivo in CONTADORES_PROIBIDOS:
            for m in re.finditer(padrao, texto):
                linha = texto.count("\n", 0, m.start()) + 1
                achados.append(f"CLAUDE.md:{linha}: {m.group(0)!r} — {motivo}")
        self.assertEqual(
            achados,
            [],
            "contador movel no CLAUDE.md (escreva o comando que o deriva, nao o valor):\n  "
            + "\n  ".join(achados),
        )


if __name__ == "__main__":
    unittest.main()
