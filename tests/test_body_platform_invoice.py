"""
Testes do corpo de NOTIFICACAO DE COBRANCA de plataforma (Efi/Gerencianet e afins).

Caso de origem — conta 694 ("Boleto referente a assinatura ... de Manutencao"),
com TRES defeitos no mesmo e-mail:

  1. payment_method='crédito'  — a unica mencao a credito estava no RODAPE
     INSTITUCIONAL da plataforma ("...e possivel emitir e enviar boletos, carnes,
     cobrancas via CARTAO DE CREDITO e links de pagamento"), uma lista dos PRODUTOS
     DELA. O e-mail chama o titulo de BOLETO no assunto e na 1a linha do corpo.
     A ordem de _BODY_PAYMENT_METHOD_KEYWORDS codifica ESPECIFICIDADE (debito
     automatico antes de debito), nao confianca — e desempatava a favor do credito.
  2. invoice_number sintetico — o numero real ("Cobranca N 1040983896") nao tinha
     rotulo coberto.
  3. fornecedor LIXO — o nome saiu do assunto ("referente a assinatura 1040983896
     de Manutencao - ot"), criando um cadastro-lixo em supplier, enquanto o real
     ("AGENCIA K1 DIGITAL WEBSITES E MARKETING") estava sob "Dados do emissor",
     na LINHA SEGUINTE do rotulo (layout achatado).
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

SUBJECT = "Boleto referente à assinatura 1040983896 de Manutenção - ot..."

# Corpo real da conta 694 (uma linha por campo, como o webmail achata o HTML).
BODY = (
    "Olá!\n"
    " Você está recebendo o boleto para pagamento da sua assinatura. Veja abaixo as"
    " informações da assinatura e download do boleto.\n"
    " Assinatura Nº 1062969\n"
    " Esta Parcela\n"
    " Vencimento \n"
    " 05/08/2026 \n"
    " Cobrança\n"
    " Nº 1040983896\n"
    " Acessar \n"
    " Informações do Plano Assinado\n"
    " Manutenção a cada 2 meses\n"
    " Serviços / Produtos\n"
    " Manutenção - otimotex.com.br\n"
    " 1\n"
    " R$ 500,00\n"
    " R$ 500,00\n"
    " Valor da assinatura (Bimestral)\n"
    " R$ 500,00\n"
    " Dados do emissor\n"
    " AGENCIA K1 DIGITAL WEBSITES E MARKETING\n"
    " (87) 98862-0378 \n"
    " Cancelar Assinatura\n"
    " Esta cobrança foi gerada pela Efí. Pela plataforma é possível emitir e enviar \n"
    " boletos\n"
    " , \n"
    " carnês\n"
    " , cobranças via \n"
    " cartão de crédito\n"
    " e \n"
    " links de pagamento\n"
    " para os seus clientes.\n"
    " Abra sua conta digital grátis."
)


class TestStripPlatformBoilerplate(unittest.TestCase):
    def test_corta_no_marcador_e_preserva_o_que_vem_antes(self):
        out = read_emails._strip_platform_boilerplate(BODY)
        self.assertIn("AGENCIA K1 DIGITAL", out)          # conteúdo útil preservado
        self.assertIn("boleto para pagamento", out)
        self.assertNotIn("cartão de crédito", out)        # propaganda descartada
        self.assertNotIn("Abra sua conta digital", out)

    def test_texto_sem_rodape_fica_intacto(self):
        txt = "Segue o boleto.\n Valor R$ 10,00"
        self.assertEqual(read_emails._strip_platform_boilerplate(txt), txt)

    def test_vazio_e_none(self):
        self.assertEqual(read_emails._strip_platform_boilerplate(None), "")
        self.assertEqual(read_emails._strip_platform_boilerplate(""), "")


class TestClassifyBodyPaymentMethod(unittest.TestCase):
    def test_rodape_da_plataforma_nao_declara_credito(self):
        self.assertEqual(read_emails._classify_body_payment_method(BODY, SUBJECT), "boleto")

    def test_declaracao_real_de_credito_nao_regride(self):
        # Sem rodapé de plataforma, "cartão de crédito" continua sendo uma declaração.
        self.assertEqual(
            read_emails._classify_body_payment_method("Pago no cartão de crédito final 1234"),
            "crédito")

    def test_demais_formas_declaradas_nao_regridem(self):
        for texto, esperado in (("PAGAMENTO EM DINHEIRO", "dinheiro"),
                                ("Tipo de pagamento: Débito Automático", "débito automático"),
                                ("TED AGÊNCIA 0001", "ted")):
            with self.subTest(texto=texto):
                self.assertEqual(read_emails._classify_body_payment_method(texto), esperado)


class TestChargeNumber(unittest.TestCase):
    def test_captura_cobranca_com_quebra_de_linha(self):
        m = read_emails._BODY_CHARGE_NUM_RE.search(" Cobrança\n Nº 1040983896\n")
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), "1040983896")

    def test_nao_captura_numero_da_assinatura(self):
        # O nº da ASSINATURA repete em toda cobrança do contrato: usá-lo faria a
        # cobrança do mês seguinte deduplicar contra a anterior e sumir.
        m = read_emails._BODY_CHARGE_NUM_RE.search(" Assinatura Nº 1062969\n")
        self.assertIsNone(m)

    def test_nao_captura_cobranca_sem_numero(self):
        self.assertIsNone(read_emails._BODY_CHARGE_NUM_RE.search(
            "cobranças via cartão de crédito e links de pagamento"))


class TestIssuerBlock(unittest.TestCase):
    def test_nome_na_linha_seguinte_ao_rotulo(self):
        m = read_emails._BODY_ISSUER_RE.search(BODY)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1).strip(), "AGENCIA K1 DIGITAL WEBSITES E MARKETING")

    def test_nome_na_mesma_linha_tambem_vale(self):
        m = read_emails._BODY_ISSUER_RE.search("Dados do beneficiário: ACME COMERCIO LTDA\n")
        self.assertEqual(m.group(1).strip(), "ACME COMERCIO LTDA")

    def test_plataforma_do_rodape_nao_vira_fornecedor(self):
        # "emitido por" NÃO é rótulo de bloco — no rodapé ele nomeia a PLATAFORMA.
        self.assertIsNone(read_emails._BODY_ISSUER_RE.search(
            "Este boleto foi emitido por www.sejaefi.com.br\n"))


class TestSupplierNameFromSubject(unittest.TestCase):
    def test_conectivo_nao_vira_nome_de_fornecedor(self):
        self.assertEqual(read_emails._supplier_name_from_subject(SUBJECT), "")

    def test_nomes_legitimos_nao_regridem(self):
        casos = {
            "PAGAMENTO BOLETO HYOSUNG 181063-3": "HYOSUNG",
            "ENC: FATURAMENTO -- MOVVI LOGISTICA LTDA 03/07/2026": "MOVVI LOGISTICA LTDA",
        }
        for subject, esperado in casos.items():
            with self.subTest(subject=subject):
                self.assertEqual(read_emails._supplier_name_from_subject(subject), esperado)

    def test_de_da_do_continuam_podendo_iniciar_razao_social(self):
        # A guarda cobre só conectivos que nunca iniciam nome; "DE NADAI" é empresa real.
        self.assertEqual(
            read_emails._supplier_name_from_subject("PAGAMENTO DE NADAI ALIMENTACAO"),
            "DE NADAI ALIMENTACAO")


class TestExtractFromEmailBody694(unittest.TestCase):
    """Ponta a ponta: o payload que a conta 694 deveria ter recebido."""

    def _payload(self):
        return read_emails.extract_from_email_body(
            BODY, "2026-07-26T04:42:00+00:00", "<msg-694>",
            sender_email="naoresponda@notificacao.sejaefimail.com.br",
            subject=SUBJECT)

    def test_fornecedor_e_o_emissor_do_corpo(self):
        self.assertEqual(self._payload()["supplier_name"],
                         "AGENCIA K1 DIGITAL WEBSITES E MARKETING")

    def test_numero_do_documento_e_o_da_cobranca(self):
        payload = self._payload()
        self.assertEqual(payload["invoice_number"], "1040983896")
        self.assertFalse(read_emails._is_synthetic_invoice_number(payload["invoice_number"]))

    def test_forma_de_pagamento_e_boleto(self):
        self.assertEqual(self._payload()["payment_method"], "boleto")

    def test_valor_e_vencimento_preservados(self):
        payload = self._payload()
        self.assertEqual(payload["amount"], 500.00)
        self.assertEqual(payload["due_date"], "2026-08-05")


if __name__ == "__main__":
    unittest.main()
