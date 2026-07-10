"""
Testes para a extração do valor a pagar a partir do corpo do e-mail
(_extract_body_amount em read_emails.py).

Regra de negócio coberta:
  - valor rotulado 'Total'/'Valor Total' tem PRECEDÊNCIA (resultado da soma);
  - sem rótulo de total e com várias parcelas → soma;
  - valor único → ele mesmo;
  - tolera o separador 'R$:' (dois-pontos) usado em e-mails internos;
  - sem valor → None.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# Corpo real do caso "Pagamento de Almoço e Zona Azul" (parcelas + total).
ALMOCO_BODY = (
    "Bom dia, segue para pagamento:\r\n"
    "Valor :    R$:  297,08 + R$: 6,96\r\n"
    "Total :  R$:  304,04\r\n"
    "Pix p/ Nadim\r\n"
)


class ExtractBodyAmountTest(unittest.TestCase):
    def test_total_rotulado_tem_precedencia_sobre_parcelas(self):
        # Não pode somar (608,08) nem pegar a 1ª parcela (297,08): é o Total.
        self.assertEqual(read_emails._extract_body_amount(ALMOCO_BODY), 304.04)

    def test_valor_total_com_separador_de_milhar(self):
        self.assertEqual(
            read_emails._extract_body_amount("Valor Total: R$ 1.250,00"), 1250.00)

    def test_sem_total_soma_as_parcelas(self):
        self.assertEqual(
            read_emails._extract_body_amount("Pague R$ 100,00 e R$ 50,00"), 150.00)

    def test_valor_unico(self):
        self.assertEqual(read_emails._extract_body_amount("Total R$ 80,00"), 80.00)

    def test_valor_unico_sem_rotulo(self):
        self.assertEqual(read_emails._extract_body_amount("R$ 297,08"), 297.08)

    def test_tolera_dois_pontos_apos_rs(self):
        self.assertEqual(read_emails._extract_body_amount("R$:6,96"), 6.96)

    def test_sem_valor_retorna_none(self):
        self.assertIsNone(read_emails._extract_body_amount("sem valor algum aqui"))

    def test_valor_rotulado_sem_rs_tres_casas_decimais(self):
        # Bug id 186 (PAGAMENTO SORTEIO/NIKE): "VALOR: 1.799,960" (3 casas, zero a
        # mais digitado, sem R$) caía como 'sem valor'. Deve normalizar p/ 1799,96.
        self.assertEqual(
            read_emails._extract_body_amount("FORNECEDOR: NIKE\r\nVALOR: 1.799,960\r\n"),
            1799.96)

    def test_brl_to_decimal_tolera_terceira_casa(self):
        self.assertEqual(read_emails._brl_to_decimal("1.799,960"), 1799.96)
        self.assertEqual(read_emails._brl_to_decimal("50,00"), 50.00)  # 2 casas intacto


# Nota interna de pagamento (id 186): corpo estruturado FORNECEDOR/CNPJ/VALOR/DATA/PIX.
# Antes falhava por "sem valor" (3 casas) e o vencimento saía por acaso (data do e-mail).
NIKE_BODY = (
    "FORNECEDOR: NIKE\r\n\r\nCNPJ: 59.546.515/0071-47\r\n\r\n"
    "VALOR: 1.799,960\r\n\r\nDATA PARA PAGAMENTO: 22/06/26\r\n\r\nPAGAMENTO: PIX\r\n"
)


class BodyInternalPaymentNoteTest(unittest.TestCase):
    def test_extrai_valor_fornecedor_vencimento_e_pix(self):
        payload = read_emails.extract_from_email_body(
            NIKE_BODY, "2026-06-30T10:00:00+00:00", "<nike186>",
            sender_email="barbara@otimotex.com.br",
            subject="PAGAMENTO SORTEIO BLUSAS DO BRASIL - SAMUEL")
        self.assertIsNotNone(payload)
        self.assertEqual(payload["amount"], 1799.96)
        self.assertEqual(payload["supplier_cnpj"], "59546515007147")
        self.assertEqual(payload["payment_method"], "pix")
        # Vencimento vem do rótulo "DATA PARA PAGAMENTO", não da data do e-mail (30/06).
        self.assertEqual(payload["due_date"], "2026-06-22")


# Corpo real da fatura consolidada Rodonaves (id 318): o mesmo valor aparece em
# "Valor da fatura" e "Valor liquido" (Decrescimo R$ 0,00) — a soma DUPLICAVA.
RODONAVES_BODY = (
    "Ola TEXTIL E CONFECCOES OTIMOTEX LTDA , aqui esta sua fatura \r\n"
    "Fatura: 13735141-26 \r\n"
    "Valor da fatura \r\n R$ 12.985,52 \r\n"
    "Decrescimo \r\n R$ 0,00 \r\n"
    "Valor liquido \r\n R$ 12.985,52 \r\n"
    "Vencimento \r\n 15/07/2026 \r\n"
)


class BodyAmountRepeatedValueTest(unittest.TestCase):
    """Fatura que repete o mesmo montante em varios rotulos NAO pode ser somada."""

    def test_rodonaves_valor_repetido_nao_duplica(self):
        # Bug id 318: 'Valor da fatura' == 'Valor liquido' == R$ 12.985,52; a soma
        # gerava 25.971,04. O correto e o valor unico (nao dobrado).
        self.assertEqual(read_emails._extract_body_amount(RODONAVES_BODY), 12985.52)

    def test_valores_identicos_sem_rotulo_de_total_nao_somam(self):
        # Defesa em profundidade: mesmo montante repetido sob rotulos nao mapeados.
        self.assertEqual(
            read_emails._extract_body_amount("Subtotal R$ 100,00\r\nParcial R$ 100,00"),
            100.00)

    def test_valor_liquido_tem_precedencia_com_desconto_real(self):
        # Com desconto real (3 valores distintos), o LIQUIDO e a fonte de verdade —
        # nao a soma (25.999,99) nem o bruto (13.000,00).
        body = ("Valor da fatura R$ 13.000,00\r\n"
                "Decrescimo R$ 14,48\r\n"
                "Valor liquido R$ 12.985,52\r\n")
        self.assertEqual(read_emails._extract_body_amount(body), 12985.52)

    def test_valor_a_pagar_tem_precedencia(self):
        # "Valor a pagar" (final) vence o bruto "Valor do documento".
        body = "Valor do documento R$ 500,00\r\nJuros R$ 20,00\r\nValor a pagar R$ 520,00"
        self.assertEqual(read_emails._extract_body_amount(body), 520.00)

    def test_decrescimo_zero_nao_afeta_valor_unico(self):
        # R$ 0,00 e ignorado — resta um unico valor.
        self.assertEqual(
            read_emails._extract_body_amount("Pague R$ 80,00\r\nDesconto R$ 0,00"),
            80.00)


class LabeledAmountWithoutRSTest(unittest.TestCase):
    """Fallback: valor ROTULADO sem 'R$' (ex.: 'Valor 50,00')."""

    def test_valor_sem_rs(self):
        self.assertEqual(read_emails._extract_body_amount("Nome X\r\nValor 50,00"), 50.00)

    def test_valor_com_dois_pontos_sem_rs(self):
        self.assertEqual(read_emails._extract_body_amount("Valor: 50,00"), 50.00)

    def test_valor_com_milhar_sem_rs(self):
        self.assertEqual(read_emails._extract_body_amount("Valor 1.250,00"), 1250.00)

    def test_total_sem_rs(self):
        self.assertEqual(read_emails._extract_body_amount("Total 304,04"), 304.04)

    def test_total_tem_precedencia_sobre_valor_sem_rs(self):
        # Sem R$: o "Total" é o valor a pagar, não a 1ª parcela "Valor".
        self.assertEqual(
            read_emails._extract_body_amount("Valor 100,00\nValor 50,00\nTotal 150,00"), 150.00)

    def test_rs_tem_precedencia_sobre_rotulado_sem_rs(self):
        # Havendo "R$", ele vence (o fallback sem R$ nem é alcançado).
        self.assertEqual(read_emails._extract_body_amount("Valor 50,00\nPague R$ 80,00"), 80.00)

    def test_valor_de_n_com_conectivo(self):
        # Caso real (reembolso de postagem): "o valor de 172,39 ref .a despesa".
        # O conectivo "de" entre o rótulo e o número não pode impedir a captura.
        self.assertEqual(
            read_emails._extract_body_amount(
                "deposita o valor de 172,39 ref .a despesa de postagem"), 172.39)

    def test_conectivo_colado_ao_numero(self):
        # O conectivo tolerado fica IMEDIATAMENTE antes do número ("total de 1.250,00").
        self.assertEqual(read_emails._extract_body_amount("Total de 1.250,00"), 1250.00)

    def test_substantivo_entre_rotulo_e_numero_nao_captura(self):
        # Conservador: um substantivo entre o rótulo e o número ("Total da nota
        # 1.250,00", sem R$) NÃO é capturado — evita falso positivo. O caminho
        # primário com "R$" cobre o caso comum ("valor da nota R$ 1.250,00").
        self.assertIsNone(read_emails._extract_body_amount("Total da nota 1.250,00"))

    # --- Guardas (não pode capturar número solto / sem centavos / sem rótulo) ---
    def test_sem_centavos_nao_captura(self):
        self.assertIsNone(read_emails._extract_body_amount("Valor 50"))

    def test_valor_seguido_de_palavra_nao_captura(self):
        # "valor desconto" não pode casar o conectivo "de" dentro de "desconto"
        # (o número não segue o conectivo) — sem centavos rotulados, é None.
        self.assertIsNone(read_emails._extract_body_amount("valor desconto aplicado"))

    def test_numero_sem_rotulo_nao_captura(self):
        self.assertIsNone(read_emails._extract_body_amount("foram 50,00 reais no caixa"))

    def test_nf_com_rotulo_diferente_nao_vira_valor(self):
        # "NF 1087" não é valor (sem rótulo valor/total e sem centavos).
        self.assertIsNone(read_emails._extract_body_amount("NF 1087 referente ao mês"))


class ExtractFromEmailBodyAmountTest(unittest.TestCase):
    def test_corpo_do_almoco_extrai_total(self):
        payload = read_emails.extract_from_email_body(
            ALMOCO_BODY, received_at="2026-06-15T16:27:12+00:00",
            message_id="<almoco-test>", sender_email="nadim@otimotex.com.br")
        self.assertIsNotNone(payload)
        self.assertEqual(payload["amount"], 304.04)

    def test_corpo_zona_azul_sem_rs_extrai_nome_valor_pix(self):
        # Caso real (id 224): "Nome MATEUS... / Valor 50,00 / chave pix ...".
        body = "Nome MATEUS JAE WON AHN \r\n\r\nValor 50,00 \r\n\r\nchave pix 123456789"
        payload = read_emails.extract_from_email_body(
            body, received_at="2026-06-17T00:00:00+00:00",
            message_id="<zona-sem-rs>", sender_email="financeiro@otimotex.com.br")
        self.assertIsNotNone(payload)
        self.assertEqual(payload["supplier_name"], "MATEUS JAE WON AHN")
        self.assertEqual(payload["amount"], 50.00)
        self.assertEqual(payload["payment_method"], "pix")


if __name__ == "__main__":
    unittest.main()
