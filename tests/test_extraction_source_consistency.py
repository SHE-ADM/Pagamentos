"""Guarda cross-layer do dominio de `extraction_source` — Python x Zod x CHECK do banco.

Ate 2026-08-17 NAO existia guarda para este dominio (so para `document_type`, em
`test_doc_type_domain_consistency.py`), e as tres camadas eram listas paralelas mantidas por
disciplina. O modo de falha e o pior possivel: o Python grava um valor que o CHECK nao conhece e
**todo INSERT daquela conta e rejeitado em producao** — longe da alteracao que causou.

Molde: `test_doc_type_domain_consistency.py`. Como la, o parser tem sanidade propria: um regex
que para de casar transformaria a guarda em `0 == 0`, verde para sempre.
"""

import ast
import re
import sys
import unittest
from pathlib import Path

_RAIZ = Path(__file__).resolve().parents[1]
_SCRIPTS_DIR = _RAIZ / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import extract_pdf as E  # noqa: E402

_SCHEMA_ZOD = _RAIZ / "packages" / "shared" / "src" / "schemas" / "financial-account-control.schema.ts"
_MIGRATIONS = _RAIZ / "supabase" / "migrations"

#: `erro_api` e sentinela INTERNA do circuit breaker: o registro e descartado antes do INSERT,
#: entao ela nunca chega ao banco — e por isso NAO esta no CHECK nem no Zod.
_NUNCA_PERSISTIDA = {"erro_api"}


def _dominio_zod() -> list:
    texto = _SCHEMA_ZOD.read_text(encoding="utf-8")
    m = re.search(r"export const EXTRACTION_SOURCES = \[(.*?)\] as const;", texto, re.DOTALL)
    assert m, "nao achei EXTRACTION_SOURCES no schema Zod (parser quebrado)"
    valores = re.findall(r"'([^']+)'", m.group(1))
    assert valores, "EXTRACTION_SOURCES foi encontrado mas veio vazio (parser quebrado)"
    return valores


def _migration_do_check() -> Path:
    """A migration MAIS RECENTE que define o CHECK de extraction_source — a definicao VIGENTE.

    Segue a licao ja registrada no CLAUDE.md: localizar por CONTEUDO e ficar com a ultima, nunca
    exigir que so uma case (a 061 e a 131 casam, e a 131 e quem vale)."""
    alvos = sorted(p for p in _MIGRATIONS.glob("*.sql")
                   if "extraction_source_check" in p.read_text(encoding="utf-8"))
    assert alvos, "nenhuma migration define o CHECK de extraction_source (parser quebrado)"
    return alvos[-1]


def _dominio_check() -> set:
    texto = _migration_do_check().read_text(encoding="utf-8")
    # Fica com o ULTIMO bloco ADD CONSTRAINT do arquivo (o DROP anterior nao tem lista).
    blocos = re.findall(r"ADD CONSTRAINT financial_account_control_extraction_source_check\s+"
                        r"CHECK \((.*?)\);", texto, re.DOTALL)
    assert blocos, "nao achei o ADD CONSTRAINT do CHECK (parser quebrado)"
    valores = set(re.findall(r"'([a-z_]+)'::text", blocos[-1]))
    assert valores, "o CHECK foi encontrado mas nao tinha valores (parser quebrado)"
    return valores


_FONTES_PY = (_SCRIPTS_DIR / "extract_pdf.py",
              _RAIZ / "skills" / "email-reader" / "scripts" / "read_emails.py")


def _literais_de_codigo() -> set:
    """Todo literal string que aparece no CODIGO dos modulos do pipeline, via `ast`.

    🔴 `ast`, e nao regex sobre o texto: um nome de fonte citado num comentario ou numa
    docstring nao e codigo, e conta-lo transformaria prosa em contrato (a licao do `_sem_prosa`).
    `ast.walk` sobre `ast.Constant` ignora comentarios por construcao; docstrings sao filtradas
    abaixo, porque elas SAO `ast.Constant`.

    Escopo deliberado: nao tentamos inferir QUAL literal vira `extraction_source` — as fontes
    chegam la de tres formas (atribuicao, retorno de tupla, argumento de `build_records`), e um
    parser semantico para isso seria mais fragil que o contrato que ele guarda. O que este
    conjunto responde e a pergunta que importa para a orfandade: "este valor do dominio aparece
    em algum lugar do codigo?".
    """
    achados = set()
    for arquivo in _FONTES_PY:
        arvore = ast.parse(arquivo.read_text(encoding="utf-8"))
        docstrings = set()
        for no in ast.walk(arvore):
            if isinstance(no, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                corpo = getattr(no, "body", None)
                if (corpo and isinstance(corpo[0], ast.Expr)
                        and isinstance(corpo[0].value, ast.Constant)
                        and isinstance(corpo[0].value.value, str)):
                    docstrings.add(id(corpo[0].value))
        for no in ast.walk(arvore):
            if (isinstance(no, ast.Constant) and isinstance(no.value, str)
                    and id(no) not in docstrings):
                achados.add(no.value)
    assert "pdf_text" in achados, "o parser ast nao achou nem 'pdf_text' — parser quebrado"
    return achados


class DominioExtractionSourceTest(unittest.TestCase):
    def test_zod_e_check_do_banco_sao_ESPELHOS(self):
        self.assertEqual(set(_dominio_zod()), _dominio_check(),
                         "o enum EXTRACTION_SOURCES e o CHECK da migration divergiram — o "
                         "Python pode gravar valor que o banco recusa (INSERT rejeitado) ou a "
                         "API pode recusar valor que o banco aceita")

    def test_toda_fonte_de_VISAO_existe_no_dominio(self):
        # 🔴 A guarda que impede o INSERT rejeitado em producao pelo caminho mais provavel:
        # `VISION_SOURCES` e a lista que cresce quando um formato novo entra.
        dominio = set(_dominio_zod()) | _NUNCA_PERSISTIDA
        for fonte in E.VISION_SOURCES:
            self.assertIn(fonte, dominio,
                          f"extract_pdf emite extraction_source='{fonte}', fora do dominio")

    def test_o_dominio_nao_tem_fonte_orfa(self):
        # O inverso: valor que existe no dominio e que NENHUM codigo escreve e divida, nao
        # contrato — foi assim que `pix` sobreviveu no CHECK ate a migration 075.
        literais = _literais_de_codigo()
        for fonte in _dominio_zod():
            self.assertIn(fonte, literais,
                          f"'{fonte}' esta no dominio e nao aparece no codigo do pipeline")

    def test_as_fontes_docx_estao_nas_TRES_camadas(self):
        # Ancoragem explicita do que este trabalho acrescentou — se alguem remover de uma das
        # camadas, os testes acima ja pegam, mas este nomeia o caso.
        for fonte in ("docx_text", "docx_vision"):
            self.assertIn(fonte, _dominio_zod(), f"{fonte} fora do Zod")
            self.assertIn(fonte, _dominio_check(), f"{fonte} fora do CHECK")

    def test_confianca_da_migration_cobre_as_fontes_novas(self):
        # Espelha a G5 de test_onda6_campos_derivados para o caso .docx: sem mapeamento no CASE
        # da coluna gerada, a conta nasceria com confianca 'desconhecida' sem ninguem perceber.
        sql = _migration_do_check().read_text(encoding="utf-8")
        self.assertIn("extraction_confidence", sql,
                      "a migration que muda o dominio precisa reemitir a coluna gerada")
        for fonte in ("docx_text", "docx_vision"):
            self.assertRegex(sql, rf"extraction_source = '{fonte}'\s+THEN '(alta|media|baixa)'",
                             f"{fonte} nao foi mapeado no CASE de extraction_confidence")


if __name__ == "__main__":
    unittest.main()
