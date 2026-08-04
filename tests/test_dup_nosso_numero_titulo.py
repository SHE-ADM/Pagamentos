"""
Guarda da impressao 1b da dedup (fornecedor + NOSSO NUMERO): o campo extraido como
"nosso numero" NEM SEMPRE identifica o TITULO.

Caso de origem (conta 316/847, T.R.T Monitoramento, 2026-08-04): em alguns layouts o LLM
copia o codigo AGENCIA/CONTA do cedente ("0001/0000515-6") — o MESMO em todos os boletos
daquele fornecedor. A impressao 1b entao fundia a mensalidade de AGOSTO com a de JULHO: a
conta nova nao era criada, o `update_financial` gravava na conta antiga o barcode do boleto
novo, e o e-mail ficava 'extraido' SEM conta — pagavel perdido em SILENCIO.

Discriminador: uma REEMISSAO e o MESMO titulo, entao carrega o MESMO numero de documento;
boletos DISTINTOS tem numeros distintos. Medido nos dados reais:
  - SIEG (ids 323/560, o caso que criou a 1b): invoice_number == nosso_numero nos dois.
  - TRT: nosso_numero identico (codigo do cedente) e invoice_number diferente
    (00561066674 x 00569007593).
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402

# Numeros reais dos dois boletos mensais do T.R.T.
TRT_JULHO = "001/00561066674-1"
TRT_AGOSTO = "001/00569007593-3"
# Numero real da fatura SIEG — la o nosso numero E o numero do documento.
SIEG = "000000091070-8"


class SameTitleTest(unittest.TestCase):
    """True = "pode deduplicar" (nao contradiz o nosso numero)."""

    def test_mesmo_titulo_reemitido_pode_deduplicar(self):
        # Caso SIEG: 2a via do MESMO titulo, com juros e vencimento novos.
        self.assertTrue(R._same_title(SIEG, SIEG))

    def test_titulos_DISTINTOS_nao_deduplicam(self):
        # 🔴 O caso de origem: mensalidades de meses diferentes.
        self.assertFalse(R._same_title(TRT_AGOSTO, TRT_JULHO))

    def test_mesmo_titulo_escrito_em_formatos_diferentes(self):
        # Carteira e DV variam conforme o campo do boleto; o titulo e o mesmo.
        self.assertTrue(R._same_title("001/00561066674-1", "00561066674"))
        self.assertTrue(R._same_title("00561066674", "001/00561066674-1"))

    def test_sem_numero_proprio_nao_contradiz(self):
        # Conservador: sem numero de um dos lados, o nosso numero decide sozinho —
        # exatamente o comportamento que existia antes desta guarda.
        self.assertTrue(R._same_title(TRT_AGOSTO, None))
        self.assertTrue(R._same_title(TRT_AGOSTO, ""))
        self.assertTrue(R._same_title(None, TRT_JULHO))

    def test_numero_SINTETICO_nao_contradiz(self):
        # `{tipo}_{ddmmaa}` e gerado por nos quando o documento nao traz numero —
        # nao e identidade de titulo e nao pode derrubar a dedup.
        self.assertTrue(R._same_title("boleto_150826", TRT_JULHO))
        self.assertTrue(R._same_title(TRT_AGOSTO, "boleto_150826"))

    def test_numeros_curtos_exigem_igualdade_exata(self):
        # Abaixo de 6 digitos a continencia nao significa nada ('123' dentro de '1234').
        self.assertFalse(R._same_title("123", "456"))
        self.assertFalse(R._same_title("123", "1234"))
        self.assertTrue(R._same_title("123", "123"))


class FindDuplicate1bTest(unittest.TestCase):
    """A impressao 1b ponta a ponta, com o REST mockado."""

    def _ctrl(self, candidato):
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl._available = True
        ctrl.base = "https://x"
        ctrl.headers = {}
        self.consultas = []

        def fake_find(clauses, select="id,due_date,barcode"):
            self.consultas.append(clauses)
            # so a consulta por nosso_numero devolve o candidato
            if any("nosso_numero" in c for c in clauses):
                return candidato
            return None

        ctrl._find_override = fake_find
        return ctrl

    def _dedup(self, payload, candidato):
        """Chama find_financial_duplicate com o _find interno trocado."""
        import unittest.mock as mock
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl._available = True
        ctrl.base = "https://x"
        ctrl.headers = {}
        chamadas = []

        real = R.SupabaseControl.find_financial_duplicate

        def fake_urlopen(req, timeout=None):
            url = req.full_url
            chamadas.append(url)
            import io, json as _json
            corpo = _json.dumps([candidato] if ("nosso_numero" in url and candidato) else [])
            r = io.BytesIO(corpo.encode())
            r.__enter__ = lambda s=r: s
            r.__exit__ = lambda s, *a: None
            return r

        with mock.patch.object(R.urllib.request, "urlopen", fake_urlopen):
            return real(ctrl, payload)

    def test_nosso_numero_igual_mas_TITULO_diferente_nao_deduplica(self):
        # 🔴 O bug: sem esta guarda, o boleto de agosto sumia.
        dup = self._dedup(
            {"sk_supplier": 95, "amount": 450.00, "due_date": "2026-08-15",
             "invoice_number": TRT_AGOSTO, "nosso_numero": "0001/0000515-6"},
            {"id": 316, "due_date": "2026-07-15", "barcode": None,
             "invoice_number": TRT_JULHO},
        )
        self.assertIsNone(dup)

    def test_reemissao_do_mesmo_titulo_ainda_deduplica(self):
        # NAO REGREDIR (ids 323/560): a 1b existe para este caso.
        dup = self._dedup(
            {"sk_supplier": 1124, "amount": 444.01, "due_date": "2026-07-16",
             "invoice_number": SIEG, "nosso_numero": SIEG},
            {"id": 323, "due_date": "2026-07-15", "barcode": None, "invoice_number": SIEG},
        )
        self.assertIsNotNone(dup)
        self.assertEqual(dup["id"], 323)

    def test_candidato_sem_numero_proprio_ainda_deduplica(self):
        dup = self._dedup(
            {"sk_supplier": 1, "amount": 10.0, "due_date": "2026-08-15",
             "invoice_number": TRT_AGOSTO, "nosso_numero": "12345678901"},
            {"id": 1, "due_date": "2026-08-10", "barcode": None, "invoice_number": None},
        )
        self.assertIsNotNone(dup)


if __name__ == "__main__":
    unittest.main()
