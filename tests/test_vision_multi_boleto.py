"""
test_vision_multi_boleto.py — leitura Vision de CARNÊ ESCANEADO e falhas de extração.

CAUSA RAIZ COBERTA (medida em 07/08/2026, 3 e-mails "BOLETOS SAMUEL - SHADOW"):
boletos escaneados chegam como UM PDF de 6 a 8 páginas, sem texto. O split por página
(`_payable_pages`) depende de TEXTO e devolve 0 nesses arquivos, então o PDF inteiro ia
numa única leitura Vision. O modelo LIA os boletos corretamente e respondia um ARRAY —
que era cortado no teto de 1200 tokens (`stop_reason='max_tokens'`). O JSON truncado não
parseava, virava um registro VAZIO, e o e-mail era logado como `sem_valor`: a falha do
extrator disfarçada de "documento sem valor", com o e-mail marcado `extraído` e 0 contas.

Três garantias travadas aqui:
  1. resposta truncada NUNCA vira registro de dado — vira falha explícita;
  2. ARRAY do modelo vira N registros (um por boleto), inclusive no call site real;
  3. falha de extração produz `extraction_source='falha'` — que é o que mantém o e-mail
     fora do CSV (logo, fora do status 'extraído') e o devolve para reprocesso.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))
import extract_pdf as E  # noqa: E402


def _bloco(texto, tipo="text"):
    return mock.MagicMock(type=tipo, text=texto)


def _resp(texto, stop_reason="end_turn"):
    r = mock.MagicMock()
    r.stop_reason = stop_reason
    r.content = [_bloco(texto)]
    return r


# Dois boletos como o modelo os devolve num carnê escaneado (dados do caso real,
# valores/CNPJ alterados). O 2º tem valor e vencimento DISTINTOS do 1º — é o que
# prova que os dois viraram registros próprios, e não um só repetido.
DOIS_BOLETOS = json.dumps([
    {"document_type": "boleto", "supplier_name": "NO BRAND DENIM CONFECCAO LTDA",
     "supplier_cnpj": "28216854000129", "due_date": "2026-08-11", "amount": 16616.00,
     "invoice_number": "155292173059327243"},
    {"document_type": "boleto", "supplier_name": "LUCIN COMERCIO DE PRODUTOS TEXTEIS LTDA",
     "supplier_cnpj": "04986320000108", "due_date": "2026-08-20", "amount": 2431.55,
     "invoice_number": "155292173059327244"},
])


class RespostaTruncadaTest(unittest.TestCase):
    """stop_reason='max_tokens' é o sinal que faltava — sem ele o corte é invisível."""

    def test_stop_reason_max_tokens_levanta_truncated(self):
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch("anthropic.Anthropic") as Anthropic, \
                mock.patch.object(Path, "read_bytes", return_value=b"%PDF-1.4"):
            Anthropic.return_value.messages.create.return_value = _resp(
                '[{"amount": 16616.00, "supplier_na', stop_reason="max_tokens")
            with self.assertRaises(E.VisionTruncatedError):
                E.extract_with_vision(Path("carne.pdf"))

    def test_truncada_NAO_e_confundida_com_api_indisponivel(self):
        """Se fosse, dispararia o circuit breaker e abortaria o LOTE inteiro por causa
        de um único documento grande.

        O nome do ARQUIVO viaja na mensagem da exceção e `_API_ERROR_HINTS` casa por
        SUBSTRING — logo asserir sobre uma mensagem literal ("carne.pdf") não prova nada
        sobre a classe. Os nomes hostis abaixo contêm `quota`/`permission`/`billing` e
        eram classificados como API fora do ar antes da guarda por `isinstance`.
        """
        for nome in ("carne.pdf", "Quota_Condominial.pdf",
                     "Permissionaria_ABC.pdf", "Billing_2026.pdf"):
            with self.subTest(arquivo=nome):
                erro = E.VisionTruncatedError(
                    f"resposta de Vision ({nome}) cortada no teto de "
                    f"{E.VISION_MAX_TOKENS} tokens — documento com pagaveis demais")
                self.assertFalse(E._is_api_unavailable(erro))

    def test_truncada_vira_falha_explicita_e_nao_registro_vazio(self):
        """O call site: `_extract_records` transforma o truncamento em registro de FALHA.

        `extraction_source='falha'` é o que mantém a linha fora do CSV — e é por não
        entrar no CSV que o e-mail deixa de ser marcado 'extraído' com 0 contas.
        """
        with mock.patch.object(E, "is_scanned_pdf", return_value=True), \
                mock.patch.object(E, "extract_with_vision",
                                  side_effect=E.VisionTruncatedError("cortada no teto")):
            recs = E._extract_records(Path("carne.pdf"))
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["extraction_source"], "falha")
        self.assertNotEqual(recs[0]["extraction_source"], "pdf_vision")

    def test_teto_de_tokens_comporta_um_carne(self):
        """Guarda de não-regressão do valor. Medido: ~330 tokens por boleto; o teto
        antigo (1200) cortava antes do 3º fechar. Abaixo de 4000 o defeito volta."""
        self.assertGreaterEqual(E.VISION_MAX_TOKENS, 4000)


class ArrayDeBoletosTest(unittest.TestCase):
    """O modelo responde ARRAY quando o arquivo tem N pagáveis."""

    def test_array_vira_um_registro_por_boleto(self):
        recs = E.build_records(Path("carne.pdf"), DOIS_BOLETOS, "pdf_vision")
        self.assertEqual(len(recs), 2)
        self.assertEqual([r["amount"] for r in recs], [16616.00, 2431.55])
        self.assertEqual([r["due_date"] for r in recs], ["2026-08-11", "2026-08-20"])
        self.assertEqual(recs[0]["supplier_cnpj"], "28216854000129")
        self.assertEqual(recs[1]["supplier_cnpj"], "04986320000108")

    def test_objeto_unico_continua_um_registro(self):
        """Não regride o caso normal (1 documento = 1 conta)."""
        recs = E.build_records(
            Path("boleto.pdf"),
            '{"document_type": "boleto", "amount": 100.50, "due_date": "2026-09-01"}',
            "pdf_vision")
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["amount"], 100.50)

    def test_process_pdf_grava_os_N_boletos_com_o_nome_do_ORIGINAL(self):
        """WIRING (não só a função pura): um PDF escaneado sem texto — `_payable_pages`
        devolve 0 — precisa produzir N registros de ponta a ponta, todos apontando para
        o arquivo original. Testar só `build_records` deixaria `process_pdf` livre para
        continuar devolvendo um registro só."""
        with mock.patch.object(E, "_is_image_file", return_value=False), \
                mock.patch.object(E, "_pdf_is_encrypted", return_value=False), \
                mock.patch.object(E, "_payable_pages", return_value=[]), \
                mock.patch.object(E, "is_scanned_pdf", return_value=True), \
                mock.patch.object(E, "extract_with_vision",
                                  return_value=(DOIS_BOLETOS, "pdf_vision")):
            recs = E.process_pdf(Path("boletos_samuel_shadow.pdf"))
        self.assertEqual(len(recs), 2)
        self.assertEqual([r["amount"] for r in recs], [16616.00, 2431.55])
        self.assertTrue(all(r["source_file"] == "boletos_samuel_shadow.pdf" for r in recs))


class ParseJsonPayloadTest(unittest.TestCase):
    """O parser tolera o que o modelo às vezes acrescenta em volta do JSON."""

    def test_objeto_puro(self):
        self.assertEqual(E._parse_json_payload('{"a": 1}'), {"a": 1})

    def test_array_puro(self):
        self.assertEqual(E._parse_json_payload('[{"a": 1}, {"a": 2}]'), [{"a": 1}, {"a": 2}])

    def test_cercas_markdown(self):
        self.assertEqual(E._parse_json_payload('```json\n{"a": 1}\n```'), {"a": 1})

    def test_prosa_antes_e_depois(self):
        """Antes, prosa antes do JSON quebrava o parse de uma resposta VÁLIDA e o
        documento — lido corretamente — era logado como 'sem_valor'."""
        self.assertEqual(
            E._parse_json_payload('Segue o JSON extraído:\n{"a": 1}\nEspero ter ajudado.'),
            {"a": 1})

    def test_json_truncado_levanta(self):
        with self.assertRaises(json.JSONDecodeError):
            E._parse_json_payload('[{"amount": 16616.00, "supplier_na')

    def test_texto_sem_json_levanta(self):
        with self.assertRaises(json.JSONDecodeError):
            E._parse_json_payload("Não consegui ler este documento.")


class RespostaNaoJsonTest(unittest.TestCase):
    """Resposta não-JSON é falha de EXTRAÇÃO, não documento sem valor."""

    def test_nao_json_vira_registro_de_falha(self):
        recs = E.build_records(Path("x.pdf"), "desculpe, não consegui", "pdf_vision")
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["extraction_source"], "falha")
        self.assertIn("não-JSON", recs[0]["processing_notes"])

    def test_array_vazio_vira_registro_de_falha(self):
        """`[]` parseia, mas não há documento nenhum — devolver registro vazio o
        transformaria numa linha 'sem_valor' culpando o documento."""
        recs = E.build_records(Path("x.pdf"), "[]", "pdf_vision")
        self.assertEqual(recs[0]["extraction_source"], "falha")


class CaminhoTextoTest(unittest.TestCase):
    """O `EXTRACTION_PROMPT` é COMPARTILHADO: pedir ARRAY vale também para o `pdf_text`.

    O caminho de texto não consegue gravar N contas — `extract_linha_digitavel(raw)` e os
    `apply_*` são do documento INTEIRO e dariam a todos o barcode do PRIMEIRO, fazendo os
    demais colidirem na dedup e sumirem. Então N pagáveis viram FALHA EXPLÍCITA. O que não
    pode acontecer é o desfecho anterior: `AttributeError` → fallback regex → UMA conta de
    qualidade regex marcada como `pdf_text` (= sucesso), com os outros perdidos calados.
    """

    def _com_resposta(self, texto, stop_reason="end_turn"):
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch("anthropic.Anthropic") as Anthropic, \
                mock.patch.object(E, "_try_barcode_vision", return_value=None):
            Anthropic.return_value.messages.create.return_value = _resp(texto, stop_reason)
            return E.build_records(Path("carne_texto.pdf"),
                                   "BOLETO 1 ... BOLETO 2 ...", "pdf_text")

    def test_array_no_texto_vira_falha_e_NAO_conta_de_regex(self):
        recs = self._com_resposta(DOIS_BOLETOS)
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["extraction_source"], "falha")
        self.assertNotEqual(recs[0]["extraction_source"], "pdf_text")
        self.assertIn("2 pagáveis", recs[0]["processing_notes"])

    def test_truncagem_no_texto_vira_falha_e_NAO_conta_de_regex(self):
        recs = self._com_resposta('{"amount": 16616.00, "supplier_na',
                                  stop_reason="max_tokens")
        self.assertEqual(recs[0]["extraction_source"], "falha")
        self.assertIn("truncada", recs[0]["processing_notes"])

    def test_objeto_unico_no_texto_continua_extraindo(self):
        """Não regride o caso normal: 1 pagável no texto segue virando conta."""
        recs = self._com_resposta(
            '{"document_type": "boleto", "supplier_name": "ACME LTDA",'
            ' "amount": 100.50, "due_date": "2026-09-01"}')
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["extraction_source"], "pdf_text")
        self.assertEqual(recs[0]["amount"], 100.50)

    def test_array_de_UM_item_no_texto_e_tratado_como_objeto(self):
        recs = self._com_resposta(
            '[{"document_type": "boleto", "supplier_name": "ACME LTDA",'
            ' "amount": 100.50, "due_date": "2026-09-01"}]')
        self.assertEqual(recs[0]["extraction_source"], "pdf_text")
        self.assertEqual(recs[0]["amount"], 100.50)

    def test_multi_pagavel_no_texto_e_RECUPERADO_pelo_tier2_vision(self):
        """Ponta a ponta: a falha do texto deixa o registro sem `amount`, o que faz
        `_extract_records` cair no fallback tier-2 — e o Vision ACEITA array. O carnê
        de texto que o split não separou acaba virando as N contas, cada uma com o
        barcode do SEU item. Sem este caso, um refactor do tier-2 devolveria o sistema
        a "1 conta de regex" sem nada ficar vermelho.

        ⚠️ O fixture precisa ter **≥80 chars**: abaixo disso `_extract_records` desvia
        para o fallback "texto curto", que já vai ao Vision ANTES do caminho `pdf_text`
        — o teste passaria sem nunca tocar o tier-2 (medido: com 25 chars, o mutante
        `return vrecs[:1]` sobrevivia). A asserção de sanidade abaixo trava isso.
        """
        texto = ("BANCO ITAU S.A. 341-7 Carnê de pagamento com dois boletos distintos. "
                 "Parcela 1 vencimento 11/08/2026. Parcela 2 vencimento 11/09/2026. "
                 "Beneficiário ACME LTDA.")
        self.assertGreaterEqual(len(texto), 80, "fixture curto demais — desviaria do pdf_text")

        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch("anthropic.Anthropic") as Anthropic, \
                mock.patch.object(E, "is_scanned_pdf", return_value=False), \
                mock.patch.object(E, "extract_with_pdfplumber",
                                  return_value=(texto, "pdf_text")), \
                mock.patch.object(E, "extract_with_vision",
                                  return_value=(DOIS_BOLETOS, "pdf_vision")) as vision, \
                mock.patch.object(E, "_try_barcode_vision", return_value=None):
            Anthropic.return_value.messages.create.return_value = _resp(DOIS_BOLETOS)
            recs = E._extract_records(Path("carne_texto.pdf"))
        # 1 chamada só: a do tier-2 (a do "texto curto" não pode ter acontecido).
        self.assertEqual(vision.call_count, 1)
        self.assertEqual(len(recs), 2)
        self.assertEqual([r["extraction_source"] for r in recs], ["pdf_vision"] * 2)
        self.assertEqual([r["amount"] for r in recs], [16616.00, 2431.55])

    def test_resposta_ilegivel_no_texto_MANTEM_o_fallback_regex(self):
        """Não regredir: falha de DOCUMENTO continua caindo no regex, como antes."""
        recs = self._com_resposta("desculpe, não consegui ler")
        self.assertEqual(recs[0]["extraction_source"], "pdf_text")
        self.assertIn("regex", recs[0]["processing_notes"])


class RespostaSemBlocoDeTextoTest(unittest.TestCase):
    """`resp.content[0].text` presumia ao menos um bloco, e que ele era texto."""

    def test_content_vazio_devolve_string_vazia(self):
        r = mock.MagicMock()
        r.stop_reason = "end_turn"
        r.content = []
        self.assertEqual(E._response_text(r, "teste"), "")

    def test_bloco_nao_textual_e_ignorado(self):
        r = mock.MagicMock()
        r.stop_reason = "end_turn"
        r.content = [_bloco("raciocínio interno", tipo="thinking"), _bloco('{"a": 1}')]
        self.assertEqual(E._response_text(r, "teste"), '{"a": 1}')


if __name__ == "__main__":
    unittest.main()
