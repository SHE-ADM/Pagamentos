"""
Testes dos RESOLVEDORES DE CAMPO do corpo (read_emails.py).

Cada campo do corpo e uma CADEIA DE PRECEDENCIA (rotulado -> tabela -> padrao). Elas
viviam inline em extract_from_email_body, que chegou a complexidade cognitiva 64 — cada
regra nova era mais um ramo na mesma funcao. Extraidas como funcoes PURAS, a precedencia
passa a ser testavel isoladamente, que e o ponto do refactor.

Estes testes travam a ORDEM de cada cadeia: e a ordem, nao os regex, que carrega a regra
de negocio (ex.: a linha da tabela vem ANTES do fallback pela data do e-mail, senao o
vencimento sai errado — conta 693).
"""

import sys
import types
import unittest
from datetime import datetime
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402

TABLE_ROW = {
    "doc": "454663_01",
    "issue_date": "2026-07-22",
    "due_date": "2026-08-01",
    "amount": 181.90,
    "barcode": None,
}


class TestResolveSupplierIdentity(unittest.TestCase):
    def test_rotulo_na_mesma_linha_vence_o_bloco_do_emissor(self):
        body = "Fornecedor: ACME LTDA\nDados do emissor\nOUTRA EMPRESA SA\n"
        nome, _, _ = R._resolve_body_supplier_identity(body)
        self.assertEqual(nome, "ACME LTDA")

    def test_bloco_do_emissor_e_o_fallback(self):
        nome, _, _ = R._resolve_body_supplier_identity("Dados do emissor\nACME LTDA\n")
        self.assertEqual(nome, "ACME LTDA")

    def test_cnpj_e_cpf_so_com_a_quantidade_exata_de_digitos(self):
        _, cnpj, cpf = R._resolve_body_supplier_identity(
            "CNPJ: 48.720.377/0001-41\nCPF: 373.807.368-09\n")
        self.assertEqual(cnpj, "48720377000141")
        self.assertEqual(cpf, "37380736809")

    def test_sem_rotulo_devolve_tudo_vazio(self):
        self.assertEqual(R._resolve_body_supplier_identity("Bom dia, segue."),
                         (None, None, None))


class TestResolveBarcode(unittest.TestCase):
    LD = "23793.39100.90000.004375.07000.842000.3.15250000018190"
    BC = "23793152500000181903391090000004370700084200"

    def test_rotulo_adjacente(self):
        self.assertEqual(R._resolve_body_barcode(f"Linha digitável: {self.LD}"), self.BC)

    def test_sem_rotulo_cai_na_forma_febraban(self):
        self.assertEqual(R._resolve_body_barcode(f"qualquer texto\n {self.LD}\n"), self.BC)

    def test_rotulo_com_valor_invalido_ainda_cai_no_fallback(self):
        # O rótulo casa mas o valor não normaliza (comprimento inválido) — o fallback
        # pela FORMA ainda deve encontrar a linha digitável real mais adiante.
        body = f"Codigo de barras: 1234 5678 9012 3456 7890 1234 5678 9012 3456\n {self.LD}\n"
        self.assertEqual(R._resolve_body_barcode(body), self.BC)

    def test_corpo_sem_boleto(self):
        self.assertIsNone(R._resolve_body_barcode("Valor R$ 10,00 — pagar por PIX"))


class TestResolveInvoiceNumber(unittest.TestCase):
    def test_ordem_de_precedencia_nf_vence_cobranca(self):
        body = "NF 1087\nCobrança\n Nº 1040983896\n"
        self.assertEqual(R._resolve_body_invoice_number(body, None), "1087")

    def test_cobranca_quando_nao_ha_nf(self):
        self.assertEqual(
            R._resolve_body_invoice_number("Cobrança\n Nº 1040983896\n", None),
            "1040983896")

    def test_sieg_recebe_prefixo(self):
        body = "acesse https://app.sieg.com/faturas?bill=4321 para pagar"
        self.assertEqual(R._resolve_body_invoice_number(body, None), "sieg_4321")

    def test_tabela_e_o_ultimo_recurso(self):
        self.assertEqual(R._resolve_body_invoice_number("sem numero aqui", TABLE_ROW),
                         "454663_01")

    def test_rotulo_vence_a_tabela(self):
        self.assertEqual(R._resolve_body_invoice_number("NF 1087", TABLE_ROW), "1087")

    def test_sem_fonte_nenhuma(self):
        self.assertIsNone(R._resolve_body_invoice_number("bom dia", None))


class TestResolveDates(unittest.TestCase):
    RECEBIDO = "2026-07-25T10:00:00+00:00"

    def test_rotulo_vence_tabela_e_data_do_email(self):
        body = "Emissão 10/09/2026\nVencimento: 15/09/2026\n"
        self.assertEqual(R._resolve_body_dates(body, TABLE_ROW, self.RECEBIDO),
                         ("2026-09-10", "2026-09-15"))

    def test_tabela_vence_a_data_do_email(self):
        # Regressão da conta 693: sem a tabela, o vencimento virava a data do e-mail.
        issue, due = R._resolve_body_dates("sem rótulos", TABLE_ROW, self.RECEBIDO)
        self.assertEqual((issue, due), ("2026-07-22", "2026-08-01"))
        self.assertNotEqual(due, self.RECEBIDO[:10])

    def test_data_para_pagamento_e_fallback_do_vencimento(self):
        _, due = R._resolve_body_dates("DATA PARA PAGAMENTO: 22/06/26", None, self.RECEBIDO)
        self.assertEqual(due, "2026-06-22")

    def test_sem_nada_usa_a_data_do_email_nos_dois(self):
        self.assertEqual(R._resolve_body_dates("bom dia", None, self.RECEBIDO),
                         ("2026-07-25", "2026-07-25"))

    def test_sem_data_alguma_usa_hoje(self):
        # A janela {antes, depois} evita flake na virada do dia: o resolver lê o relógio
        # dentro da chamada e o teste o lê depois — comparar com um único now() falharia
        # se a meia-noite caísse entre os dois.
        antes = datetime.now().strftime("%Y-%m-%d")
        issue, due = R._resolve_body_dates("bom dia", None, "")
        depois = datetime.now().strftime("%Y-%m-%d")
        self.assertIsNone(issue)
        self.assertIn(due, {antes, depois})


class TestResolveDocAndPayment(unittest.TestCase):
    BC = "23793152500000181903391090000004370700084200"

    def test_boleto_valido_vence_pix(self):
        doc, pay = R._resolve_body_doc_and_payment(
            "pague via pix ou boleto", None, None, self.BC, has_pix=True)
        self.assertEqual(pay, "boleto")
        self.assertEqual(doc, "boleto")

    def test_concessionaria_tem_precedencia_maxima(self):
        doc, _ = R._resolve_body_doc_and_payment(
            "segue a conta de luz do mês", "Conta de luz", None, None, has_pix=False)
        self.assertEqual(doc, "conta de luz")

    def test_forma_declarada_preenche_o_outro(self):
        doc, pay = R._resolve_body_doc_and_payment(
            "PAGAMENTO EM DINHEIRO", None, None, None, has_pix=False)
        self.assertEqual(pay, "dinheiro")
        self.assertEqual(doc, "outro")

    def test_pix_sem_boleto(self):
        _, pay = R._resolve_body_doc_and_payment(
            "pagar por pix", None, None, None, has_pix=True)
        self.assertEqual(pay, "pix")


class TestBodyBarcodeGuards(unittest.TestCase):
    """As guardas contra código INVENTADO por captura frouxa vivem na função CANÔNICA
    (`extract_pdf.normalize_barcode` / `normalize_barcode_allow_misread`); aqui se verifica que
    o caminho do CORPO as herda — antes havia uma cópia da regra em read_emails."""

    def test_48_digitos_colados_sao_descartados(self):
        # `\\s` do _BODY_BARCODE_RE inclui QUEBRA DE LINHA: um número curto rotulado cola
        # com as linhas seguintes e forma 48 dígitos, comprimento que o normalizador
        # aceitava como arrecadação sem validar mais nada.
        self.assertIsNone(R._normalize_body_barcode("1" * 48))

    def test_arrecadacao_real_e_preservada(self):
        real = "8" + "1" * 47          # invariante FEBRABAN: produto '8' (35/35 reais)
        self.assertEqual(R._normalize_body_barcode(real), real)

    def test_o_padrao_valida_o_dv(self):
        # O nome mais curto é o comportamento SEGURO: quem escrever uma captura frouxa
        # nova e chamar por hábito recebe a validação, não o buraco.
        bom = "23793152500000181903391090000004370700084200"     # DV confere
        ruim = bom[:4] + ("0" if bom[4] != "0" else "1") + bom[5:]  # DV adulterado
        self.assertEqual(R._normalize_body_barcode(bom), bom)
        self.assertIsNone(R._normalize_body_barcode(ruim))

    def test_allow_misread_preserva_leitura_corrompida(self):
        # Caminho ESTRUTURADO: DV que não fecha é OCR lendo errado um código REAL —
        # descartá-lo perderia a única chave de dedup do título. A concessão está no
        # NOME da função, não num parâmetro que se escolhe por omissão.
        bom = "23793152500000181903391090000004370700084200"
        ruim = bom[:4] + ("0" if bom[4] != "0" else "1") + bom[5:]
        self.assertEqual(R._normalize_body_barcode_allow_misread(ruim), ruim)


class TestFallbackDefensivoAlinhado(unittest.TestCase):
    """Os helpers do corpo importam a função canônica do `extract_pdf` de forma LAZY e
    têm um fallback defensivo para o caso de o import falhar. Esse fallback precisa
    espelhar a regra REAL: uma cópia que diverge é pior que não existir — ela mente em
    silêncio justamente quando a fonte única está indisponível.

    A indisponibilidade é forçada zerando o cache `_FEBRABAN` e injetando um módulo
    `febraban` sem atributos."""

    def setUp(self):
        self._salvo_mod = sys.modules.get("febraban")
        self._salvo_cache = R._FEBRABAN
        sys.modules["febraban"] = types.ModuleType("febraban")  # sem atributos
        R._FEBRABAN = None                                      # força re-resolução

    def tearDown(self):
        if self._salvo_mod is None:
            sys.modules.pop("febraban", None)
        else:
            sys.modules["febraban"] = self._salvo_mod
        R._FEBRABAN = self._salvo_cache

    def test_nomes_canonicos_existem_de_fato(self):
        # `_body_barcode` despacha por NOME (getattr) e degrada sem erro: renomear a
        # função canônica derrubaria a validação EM SILÊNCIO, com resultado plausível.
        # Este guarda transforma o rename em falha de CI. Roda com o módulo REAL.
        real = self._salvo_mod or __import__("febraban")
        for nome in ("normalize_barcode", "normalize_barcode_allow_misread",
                     "extract_linha_digitavel", "is_boleto_barcode",
                     "authoritative_barcode_due_date"):
            self.assertTrue(callable(getattr(real, nome, None)),
                            f"read_emails depende de febraban.{nome}")

    def test_degradacao_e_avisada_no_log(self):
        # Degradar em silêncio esconderia o deploy PARCIAL (read_emails.py sem
        # febraban.py), em que o barcode passa a ser aceito sem validação.
        with self.assertLogs("email-reader", level="WARNING") as cm:
            R._normalize_body_barcode("1" * 44)
        self.assertTrue(any("BARCODE" in linha for linha in cm.output))

    def test_fallback_de_is_boleto_barcode_aplica_o_invariante_do_48(self):
        self.assertTrue(R._is_boleto_barcode("8" + "1" * 47))
        self.assertFalse(R._is_boleto_barcode("1" * 48))          # colado — não é boleto
        self.assertTrue(R._is_boleto_barcode("2379315250000018190"
                                             "3391090000004370700084200"))
        self.assertFalse(R._is_boleto_barcode("3" * 44))          # chave NF-e/CT-e

    def test_fallback_de_normalize_degrada_para_leniente(self):
        # Sem a função canônica não há como validar DV: rejeitar por não-saber perderia
        # barcode legítimo. Na dúvida, preservar — mas o invariante do '8' (que não
        # depende da canônica) continua valendo.
        bom = "23793152500000181903391090000004370700084200"
        self.assertEqual(R._normalize_body_barcode(bom), bom)
        self.assertIsNone(R._normalize_body_barcode("1" * 48))


class TestNsKeepLen(unittest.TestCase):
    """A normalizacao usada para cortar o rodape PRECISA preservar o comprimento — e o
    que torna valido usar, no texto ORIGINAL, a posicao achada no normalizado."""

    def test_preserva_comprimento_e_remove_acento(self):
        for s in ["Esta cobrança foi gerada pela Efí", "AÇÃO ÀÉÍÕÜ ção", "",
                  "sem acento", "Ñoño ÜBER"]:
            with self.subTest(s=s):
                out = R._ns_keep_len(s)
                self.assertEqual(len(out), len(s))
                self.assertEqual(out, out.lower())

    def test_marcadores_do_rodape_estao_normalizados(self):
        # Se um marcador tiver acento/maiuscula, nunca casaria o texto normalizado.
        for m in R._PLATFORM_FOOTER_MARKERS:
            self.assertEqual(R._ns_keep_len(m), m, f"marcador fora da forma normalizada: {m}")


if __name__ == "__main__":
    unittest.main()
