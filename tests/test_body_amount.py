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
