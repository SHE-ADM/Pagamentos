import unittest
from datetime import date, timedelta

from automacao_contas import automatizar_recebimento_e_pagamentos, extrair_conta_de_email


class AutomacaoContasTest(unittest.TestCase):
    def test_extrai_dados_do_email(self):
        email = {
            "assunto": "Conta de energia",
            "corpo": "Fornecedor: Enel\nValor: R$ 123,45\nVencimento: 2030-05-20\nCodigo de Barras: 12345678901234567890123456789012345678901234",
        }

        conta = extrair_conta_de_email(email)

        self.assertEqual(conta.fornecedor, "Enel")
        self.assertEqual(str(conta.valor), "123.45")
        self.assertEqual(conta.vencimento, "2030-05-20")

    def test_ignora_contas_duplicadas_e_agenda_pagamento(self):
        futuro = (date.today() + timedelta(days=5)).isoformat()
        emails = [
            {
                "assunto": "Conta de internet",
                "corpo": f"Fornecedor: ISP\nValor: R$ 90,00\nVencimento: {futuro}\nCodigo de Barras: 99999999999999999999999999999999999999999999",
            },
            {
                "assunto": "Conta de internet - duplicada",
                "corpo": f"Fornecedor: ISP\nValor: R$ 90,00\nVencimento: {futuro}\nCodigo de Barras: 99999999999999999999999999999999999999999999",
            },
        ]

        resultado = automatizar_recebimento_e_pagamentos(emails)

        self.assertEqual(resultado["quantidade_contas"], 1)
        self.assertEqual(resultado["pagamentos"][0]["status"], "agendado")

    def test_conta_com_vencimento_hoje_fica_como_pago(self):
        hoje = date.today().isoformat()
        emails = [
            {
                "assunto": "Conta vencendo hoje",
                "corpo": f"Fornecedor: Banco\nValor: R$ 10,00\nVencimento: {hoje}\nCodigo de Barras: 11111111111111111111111111111111111111111111",
            }
        ]

        resultado = automatizar_recebimento_e_pagamentos(emails)

        self.assertEqual(resultado["pagamentos"][0]["status"], "pago")

    def test_erro_quando_email_nao_tem_campos_obrigatorios(self):
        email_invalido = {
            "assunto": "Sem código de barras",
            "corpo": "Fornecedor: Empresa\nValor: R$ 50,00\nVencimento: 2030-01-01",
        }

        with self.assertRaises(ValueError):
            extrair_conta_de_email(email_invalido)


if __name__ == "__main__":
    unittest.main()
