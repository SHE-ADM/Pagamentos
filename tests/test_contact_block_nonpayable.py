"""
test_contact_block_nonpayable.py — assinatura/rodapé de e-mail lida como "documento".

A image001.png que o Outlook cola no corpo é a ASSINATURA do remetente. Quando não há
anexo nem link, o reader a manda ao Vision, que a descreve pelo CONTEÚDO ("Rua do Horto,
940 | CEP: 35681-779 | (37) 3249-4200 | www.peripan.com.br") em vez de chamá-la de
"assinatura de e-mail" — o único termo que `_SIGNATURE_DESC_RE` reconhecia. Resultado:
a assinatura virava `sem_valor`, culpando o documento por um valor que ele nunca teve
(5 das 13 linhas `sem_valor` medidas em 07/08/2026).

Descrições REAIS dos casos que originaram a regra (Rose/Otimotex id 294, Peripan id 269).

O detector é CONSERVADOR de propósito: qualquer termo financeiro na descrição desqualifica
o descarte — uma linha a revisar em /erros é melhor que um recibo perdido em silêncio.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))
import read_emails as R  # noqa: E402

ASSINATURA_ROSE = ("Rua Visconde de Parnaiba, 2639, Brás, São Paulo/SP Brasil. "
                   "Contato: +55 11 2291-1699 | 11 97104-7508. Site: otimotex.com.br. "
                   "Rose Rocha - Comercial.")
RODAPE_PERIPAN = ("Rua do Horto, 940 | Dist. Industrial | CEP: 35681-779 | "
                  "Itaúna - MG | (37) 3249-4200 | www.peripan.com.br")


def _linha(description, amount="0.0", barcode=""):
    return {"description": description, "amount": amount, "barcode": barcode}


class ContactBlockTest(unittest.TestCase):

    def test_assinatura_rose_e_bloco_de_contato(self):
        self.assertTrue(R._is_contact_block(ASSINATURA_ROSE))

    def test_rodape_peripan_e_bloco_de_contato(self):
        self.assertTrue(R._is_contact_block(RODAPE_PERIPAN))

    def test_descricao_vazia_nao_e_contato(self):
        """Sem descrição não há sinal — a linha segue visível em /erros, de propósito."""
        self.assertFalse(R._is_contact_block(""))
        self.assertFalse(R._is_contact_block(None))

    def test_um_sinal_isolado_nao_basta(self):
        self.assertFalse(R._is_contact_block("Rua das Flores"))

    def test_endereco_do_BENEFICIARIO_num_boleto_nao_e_contato(self):
        """O endereço do cedente aparece em todo boleto; é o termo financeiro ao lado
        que impede o descarte de um documento real."""
        self.assertFalse(R._is_contact_block(
            "Beneficiario: ACME LTDA - Rua do Horto, 940 - CEP 35681-779 - (37) 3249-4200. "
            "Valor do documento R$ 1.250,00, vencimento 10/08/2026."))

    def test_recibo_com_valor_nao_e_contato(self):
        self.assertFalse(R._is_contact_block(
            "Recibo de postagem. Rua X, 100. CEP 01310-100. (11) 3000-4000. "
            "Valor do porte: R$ 172,39"))


class NonpayableVisualTest(unittest.TestCase):
    """Integração com a guarda que decide pular a linha (sem logar 'sem_valor')."""

    def test_assinatura_sem_valor_e_nao_pagavel(self):
        self.assertTrue(R._is_nonpayable_visual(_linha(ASSINATURA_ROSE)))

    def test_rodape_sem_valor_e_nao_pagavel(self):
        self.assertTrue(R._is_nonpayable_visual(_linha(RODAPE_PERIPAN)))

    def test_bloco_de_contato_COM_valor_continua_pagavel(self):
        """A guarda de amount>0 é anterior: um recibo com valor nunca é descartado,
        mesmo que a descrição pareça um rodapé."""
        self.assertFalse(R._is_nonpayable_visual(_linha(RODAPE_PERIPAN, amount="172.39")))

    def test_bloco_de_contato_COM_barcode_continua_pagavel(self):
        self.assertFalse(R._is_nonpayable_visual(
            _linha(RODAPE_PERIPAN, barcode="34191790010104351004791020150008291070026000")))

    def test_assinatura_declarada_continua_detectada(self):
        """Não regride o detector original (por termo explícito)."""
        self.assertTrue(R._is_nonpayable_visual(
            _linha("Assinatura de e-mail comercial com logotipo da empresa")))


if __name__ == "__main__":
    unittest.main()
