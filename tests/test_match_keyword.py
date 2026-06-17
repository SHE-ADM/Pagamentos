"""
Testes para match_keyword e subject_is_pure_nfe (read_emails.py).

Cobre:
  - Acronimos de tributo/cambio (WORD_KEYWORDS) casam por PALAVRA INTEIRA, sem
    falsos positivos dentro de palavras ('das' em 'cadastro'/'executadas', 'iss'
    em 'emissao', 'gru' em 'grupo', 'cambio' em 'intercambio').
  - Comparacao sem acento: a chave 'câmbio' casa 'cambio'/'câmbio'/'CÂMBIO' e
    retorna a forma gramatical correta 'câmbio'.
  - Frases longas seguem como substring ('conhecimento de transporte').
  - subject_is_pure_nfe: NF-e "pura" vs NF-e acompanhada de pagavel (boleto/fatura).
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# Acronimos de tributo + cambio (forma gravada). 'darf'/'gps'/etc. ja existiam.
KW = ["boleto", "darf", "das", "dae", "dam", "duam", "gru", "gnre", "gare",
      "ipva", "iptu", "iss", "itbi", "câmbio", "conhecimento de transporte",
      "nota fiscal"]


class MatchKeywordTest(unittest.TestCase):
    def test_acronimo_casa_palavra_inteira(self):
        self.assertEqual(read_emails.match_keyword("DAS disponivel Vence em 12/06", KW), "das")
        self.assertEqual(read_emails.match_keyword("IPVA 2026 cota unica", KW), "ipva")
        self.assertEqual(read_emails.match_keyword("Guia GARE ICMS", KW), "gare")

    def test_acronimo_nao_casa_dentro_de_palavra(self):
        # Falsos positivos que a versao substring gerava.
        for assunto in ["Cadastro pendente - Protocolo X", "Coletas executadas",
                        "emissao de relatorio", "Grupo de estudos"]:
            self.assertIsNone(read_emails.match_keyword(assunto, KW), assunto)

    def test_cambio_le_com_e_sem_acento_grava_forma_correta(self):
        # Le 'cambio' ou 'câmbio', mas a keyword retornada e sempre 'câmbio'.
        self.assertEqual(read_emails.match_keyword("Operacao de cambio fechada", KW), "câmbio")
        self.assertEqual(read_emails.match_keyword("Contrato de câmbio 123", KW), "câmbio")

    def test_cambio_nao_casa_intercambio(self):
        self.assertIsNone(read_emails.match_keyword("Intercâmbio cultural 2026", KW))

    def test_frase_longa_continua_substring(self):
        self.assertEqual(
            read_emails.match_keyword("Seu conhecimento de transporte chegou", KW),
            "conhecimento de transporte",
        )


class SubjectIsPureNfeTest(unittest.TestCase):
    def test_nfe_pura_e_true(self):
        for assunto in ["Nota Fiscal Eletronica Nº 57331",
                        "ENC: Nota fiscal eletronica 3156690",
                        "Envio Nf-e Nº:18824",
                        "NFS-e disponivel para download"]:
            self.assertTrue(read_emails.subject_is_pure_nfe(assunto), assunto)

    def test_nfe_com_pagavel_e_false(self):
        # Tem boleto/fatura no assunto → pode ser conta a pagar, nao 'ignorado'.
        for assunto in ["Boleto e NFS-e Nº 37535",
                        "NFSe 2372 E FATURA OTIMOTEX",
                        "Envio de NFe e Boleto Nº 21026"]:
            self.assertFalse(read_emails.subject_is_pure_nfe(assunto), assunto)

    def test_assunto_sem_nfe_e_false(self):
        self.assertFalse(read_emails.subject_is_pure_nfe("DAS disponivel Vence em 12/06"))

    def test_nfe_casa_por_palavra_inteira_nao_dentro_de_palavra(self):
        # 'nfe' dentro de 'CONFECCOES' (confecções) NAO deve marcar NF-e pura.
        self.assertFalse(read_emails.subject_is_pure_nfe(
            "Re: Informativo de Pendência NF: 245417 - CTRC: SAO - TEXTIL E CONFECCOES OTIMOTEX LTDA"))


class IgnorableNotificationTest(unittest.TestCase):
    def test_notificacoes_sao_true(self):
        for assunto in ["Aviso de vencimento",
                        "Aviso de Vencimento: Boleto de cobranca emitido por X",
                        "Pagamento processado com sucesso.",
                        "Confirmado o pagamento da cobrança 1015879745",
                        "Informativo de Pendência NF: 245417 - CTRC OTIMOTEX",
                        "Fatura com Vencimento Hoje - SIEG",
                        "NF-e Nº 21876 - Visualizar",
                        "Título à Vencer - SUPPER",
                        "PAGAMENTO - TEKA - Lembrete de Vencimento - Cliente: 465281",
                        "Aviso: Titulos próximos do vencimento - LUNA - SAO",
                        "Comprovante de Pix Recebido .",
                        "ALERTA: Título protestado - Sua reputação no SPC/Serasa",
                        "Intimação de protesto - Tabelionato",
                        "Comunicado do Cartório de Protesto",
                        "Comunicado Importante: Operações de entrega - Arlete"]:
            self.assertTrue(read_emails.subject_is_ignorable_notification(assunto), assunto)

    def test_pagaveis_reais_sao_false(self):
        # Sem termo de notificacao — boleto/CT-e de verdade ficam em 'falha' p/ revisao.
        for assunto in ["Recebimento: Boleto e NFS-e Nº 37535",
                        "Boletos emitidos por: COMPANHIA INDUSTRIAL CATAGUASES",
                        "Arquivos de Conhecimento de Transporte Eletronico (1)",
                        "RES: boleto e nf em anexo favor confirmar"]:
            self.assertFalse(read_emails.subject_is_ignorable_notification(assunto), assunto)


if __name__ == "__main__":
    unittest.main()
