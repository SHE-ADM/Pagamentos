"""Invariantes do domínio de `document_type` — guard contra DRIFT entre camadas.

Este teste consolida a revisão criteriosa do domínio: o `document_type` vive em
VÁRIAS fontes que precisam concordar, e um descompasso quebra em runtime (ex.: um
classificador que emite um valor fora do CHECK → INSERT falha com 23514; um tipo
novo no enum sem entrada na migration → o front oferece um valor que o banco recusa).

Fontes cruzadas aqui:
  1. Enum DOCUMENT_TYPES        — packages/shared/.../financial-account-control.schema.ts (fonte única)
  2. CHECK do banco             — a migration mais recente que (re)cria o constraint
  3. _DOC_TYPE_NORM             — extract_pdf.py (normalização da extração de PDF/imagem)
  4. _BODY_DOC_KEYWORDS         — read_emails.py (classificador do corpo)
  5. _UTILITY_DOC_KEYWORDS      — read_emails.py (concessionária)
  6. _SUBJECT_TAX_DOC_KEYWORDS  — read_emails.py (tributo por assunto)
  7. TAX_DOCUMENT_TYPES         — apps/frontend-vite/src/services/supabase.ts (donut "Tributos")

Invariantes (NÃO regredir):
  A. Enum ≡ CHECK da migration mais recente (1:1).
  B. Todo valor EMITIDO por qualquer classificador ∈ enum (senão INSERT quebra).
  C. _is_tax_document reconhece TODO tributo canônico (inclui 'dam / duam') e
     exclui deliberadamente 'gps'/'multa'.
  D. A lista de tributos do FRONT acompanha a do pipeline (+ 'gps'). Era a única das
     quatro cópias sem guarda: um tipo tributário novo entrava no enum, no CHECK e no
     pipeline e continuava caindo no balde "outros" do donut, sem erro nenhum.
"""

import re
import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import extract_pdf as E  # noqa: E402
import read_emails as R  # noqa: E402

_SCHEMA = _ROOT / "packages" / "shared" / "src" / "schemas" / "financial-account-control.schema.ts"
_MIGRATIONS = _ROOT / "supabase" / "migrations"
_CONSTRAINT = "financial_account_control_document_type_check"
_FRONT_SUPABASE = _ROOT / "apps" / "frontend-vite" / "src" / "services" / "supabase.ts"


def _parse_enum() -> set[str]:
    txt = _SCHEMA.read_text(encoding="utf-8")
    m = re.search(r"export const DOCUMENT_TYPES = \[(.*?)\] as const;", txt, re.DOTALL)
    assert m, "DOCUMENT_TYPES não encontrado no schema"
    body = re.sub(r"//[^\n]*", "", m.group(1))  # remove comentários
    return set(re.findall(r"'([^']+)'", body))


def _latest_check_migration() -> Path:
    """A migration de MAIOR número que (re)cria o CHECK de document_type — é a que
    define o domínio efetivo no banco (cada migration de tipo faz DROP+ADD)."""
    candidates = [p for p in _MIGRATIONS.glob("*.sql")
                  if _CONSTRAINT in p.read_text(encoding="utf-8")
                  and "ADD CONSTRAINT" in p.read_text(encoding="utf-8")]
    assert candidates, "nenhuma migration recria o CHECK de document_type"
    # nome começa com o número (ex.: 087_...): ordena pelo prefixo numérico.
    return max(candidates, key=lambda p: int(re.match(r"(\d+)", p.name).group(1)))


def _parse_check(path: Path) -> set[str]:
    txt = path.read_text(encoding="utf-8")
    m = re.search(r"ARRAY\[(.*?)\]::text\[\]", txt, re.DOTALL)
    assert m, f"ARRAY do CHECK não encontrado em {path.name}"
    body = re.sub(r"--[^\n]*", "", m.group(1))  # remove comentários SQL
    return set(re.findall(r"'([^']+)'", body))


def _parse_front_tax_set() -> set[str]:
    """A lista de tributos do FRONT (donut 'Tributos'), lida do .ts como texto — não há
    como importá-la aqui, e é justamente por isso que ela ficou anos sem guarda."""
    txt = _FRONT_SUPABASE.read_text(encoding="utf-8")
    m = re.search(r"const TAX_DOCUMENT_TYPES = new Set<string>\(\[(.*?)\]\)", txt, re.DOTALL)
    assert m, "TAX_DOCUMENT_TYPES não encontrado em apps/frontend-vite/src/services/supabase.ts"
    body = re.sub(r"//[^\n]*", "", m.group(1))
    return set(re.findall(r"'([^']+)'", body))


ENUM = _parse_enum()


class EnumMatchesCheckTest(unittest.TestCase):
    """Invariante A — o enum (fonte única) e o CHECK do banco são idênticos."""

    def test_enum_identico_ao_check_da_migration_mais_recente(self):
        check = _parse_check(_latest_check_migration())
        self.assertEqual(
            ENUM, check,
            f"\n  no enum, fora do CHECK: {sorted(ENUM - check)}"
            f"\n  no CHECK, fora do enum: {sorted(check - ENUM)}",
        )


class EmittedValuesAreValidTest(unittest.TestCase):
    """Invariante B — nenhum classificador emite valor fora do enum (evita 23514)."""

    def _emitted(self, values) -> set[str]:
        return {(v or "").lower() for v in values}

    def test_doc_type_norm_extract_pdf(self):
        emitted = self._emitted(E._DOC_TYPE_NORM.values()) | {"outro"}
        self.assertLessEqual(emitted, ENUM, sorted(emitted - ENUM))

    def test_body_doc_keywords(self):
        emitted = self._emitted(dt for dt, _ in R._BODY_DOC_KEYWORDS)
        self.assertLessEqual(emitted, ENUM, sorted(emitted - ENUM))

    def test_utility_doc_keywords(self):
        emitted = self._emitted(dt for dt, _ in R._UTILITY_DOC_KEYWORDS)
        self.assertLessEqual(emitted, ENUM, sorted(emitted - ENUM))

    def test_subject_tax_doc_keywords(self):
        emitted = self._emitted(dt for dt, _ in R._SUBJECT_TAX_DOC_KEYWORDS)
        self.assertLessEqual(emitted, ENUM, sorted(emitted - ENUM))

    def test_normalize_doc_type_sempre_retorna_valor_do_enum(self):
        # Qualquer entrada — inclusive lixo — cai num valor aceito pelo CHECK.
        for raw in ("DARF", "dam / duam", "cartorio", "cheque", "comprovante",
                    "fatura", "pix", "xyz", "", None):
            self.assertIn(E._normalize_doc_type(raw or ""), ENUM, repr(raw))


class TaxRecognitionTest(unittest.TestCase):
    """Invariante C — _is_tax_document reconhece todo tributo canônico."""

    TAX = ("dar / dare", "darf", "das", "gru", "dae", "gnre", "ipva", "iptu",
           "dam / duam", "iss", "itbi", "gare", "tributo")
    NON_TAX = ("gps", "multa", "cartório", "cheque", "comprovante",
               "boleto", "fatura", "recibo", "outro")

    def test_tributos_reconhecidos(self):
        for dt in self.TAX:
            self.assertIn(dt, ENUM, f"{dt} deveria ser um tipo válido")
            self.assertTrue(R._is_tax_document(dt), dt)

    def test_nao_tributos_excluidos(self):
        # 'gps'/'multa' ficam DELIBERADAMENTE fora (decisão de negócio documentada).
        for dt in self.NON_TAX:
            self.assertFalse(R._is_tax_document(dt), dt)


class FrontendTaxSetTest(unittest.TestCase):
    """Invariante D — a 4ª lista de tributos (donut 'Tributos' do dashboard) acompanha
    o pipeline. Era a ÚNICA das quatro sem guarda: um tipo tributário novo entrava no
    enum, no CHECK e no pipeline e continuava caindo no balde 'outros' do donut — erro
    PARA MENOS, que não gera exceção, não gera linha em /erros e não quebra teste."""

    def test_parser_sanity(self):
        # Sem esta sonda, uma renomeação do arquivo ou do const faria os testes abaixo
        # compararem dois conjuntos vazios e passarem para sempre (0 == 0).
        front = _parse_front_tax_set()
        self.assertGreater(len(front), 5, "parser quebrou — nada casou no supabase.ts")
        self.assertIn("darf", front, "parser casou algo, mas não a lista certa")

    def test_front_espelha_o_pipeline_mais_gps(self):
        front = _parse_front_tax_set()
        # 'gps' entra SÓ no front (é guia de arrecadação para o donut, mas fica fora de
        # _TAX_DOCUMENT_TYPES por decisão de negócio: o INSS pode ter credor próprio).
        # A interseção com ENUM descarta 'dam'/'duam', que são chaves de normalização
        # do matching, não valores do domínio.
        esperado = ({R._norm_term(t) for t in R._TAX_DOCUMENT_TYPES} & ENUM) | {"gps"}
        self.assertEqual(
            front, esperado,
            f"\n  no front, fora do esperado: {sorted(front - esperado)}"
            f"\n  esperado, fora do front:    {sorted(esperado - front)}",
        )

    def test_front_dentro_do_dominio(self):
        self.assertLessEqual(_parse_front_tax_set(), ENUM)


if __name__ == "__main__":
    unittest.main()
