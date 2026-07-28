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
                        "Comunicado Importante: Operações de entrega - Arlete",
                        # CT-e/transporte SEM boleto — documento fiscal, notificacao
                        # de disponibilizacao/ocorrencia; nao e conta a pagar.
                        "Arquivos de Conhecimento de Transporte Eletronico (1)",
                        "OCORRENCIA CTE 699089 P 207 NF 241733 ENTREGA COM FALTA"]:
            self.assertTrue(read_emails.subject_is_ignorable_notification(assunto), assunto)

    def test_pagaveis_reais_sao_false(self):
        # Sem termo de notificacao — boleto de verdade fica em 'falha' p/ revisao.
        for assunto in ["Recebimento: Boleto e NFS-e Nº 37535",
                        "Boletos emitidos por: COMPANHIA INDUSTRIAL CATAGUASES",
                        "RES: boleto e nf em anexo favor confirmar"]:
            self.assertFalse(read_emails.subject_is_ignorable_notification(assunto), assunto)


class IsIgnoredSenderTest(unittest.TestCase):
    """postmaster@ (NDR/bounce/aviso de servidor) e ignorado em qualquer dominio,
    case-insensitive — mesmo que o assunto case keyword."""

    def test_postmaster_em_qualquer_dominio_e_ignorado(self):
        for addr in ["postmaster@otimotex.com.br", "postmaster@locaweb.com.br",
                     "Postmaster@Gmail.com", "POSTMASTER@x.com"]:
            self.assertTrue(read_emails.is_ignored_sender(addr), addr)

    def test_remetente_normal_nao_e_ignorado(self):
        for addr in ["financeiro@fornecedor.com", "boleto@banco.com.br",
                     "postmaster.financeiro@x.com",  # local-part != 'postmaster'
                     "naopostmaster@x.com", "", None]:
            self.assertFalse(read_emails.is_ignored_sender(addr), addr)


class PaymentConfirmationTest(unittest.TestCase):
    """Confirmacao/comprovante de pagamento (pagamento ja realizado) e ignorado sempre —
    mesmo com keyword financeira no assunto (nao e conta a pagar)."""

    def test_confirmacao_de_pagamento_e_ignorada(self):
        for assunto in [
            "Confirmação de Pagamento da fatura 18292",   # caso real (id 6)
            "confirmacao do pagamento",
            "Pagamento confirmado - boleto 123",          # com keyword 'boleto'
            "Seu pagamento foi processado",
            "Pagamento efetuado com sucesso",
            "Comprovante de pagamento",
            "Comprovante de PIX",
        ]:
            self.assertTrue(read_emails.subject_is_payment_confirmation(assunto), assunto)

    def test_cobranca_normal_nao_e_confirmacao(self):
        # Assuntos de conta a pagar NAO podem casar (evita ignorar boleto real).
        for assunto in [
            "Boleto a vencer 10/07", "Fatura 18293 em aberto",
            "Pagamento do boleto - vencimento amanhã",   # infinitivo, nao 'confirmado/efetuado'
            "Realizar pagamento da guia", "GNRE para pagamento",
            "", "Nota fiscal",
        ]:
            self.assertFalse(read_emails.subject_is_payment_confirmation(assunto), assunto)

    def test_recebemos_o_pagamento_e_ignorado(self):
        # O credor AVISA que recebeu — e recibo, nao cobranca. Caso real: conta 716
        # ("Leadster | Recebemos o seu pagamento"), que virou conta falsa de R$ 362,62.
        for assunto in [
            "Leadster | Recebemos o seu pagamento",
            "Recebemos o seu pagamento",
            "Recebemos pagamento",
            "Recebemos seu pagamento",
            "Recebemos o pagamento da fatura 123",
        ]:
            self.assertTrue(read_emails.subject_is_payment_confirmation(assunto), assunto)

    def test_forma_negada_e_cobranca_nao_pode_ser_ignorada(self):
        # "(ainda) NAO recebemos o seu pagamento" INVERTE o sentido: o titulo esta em
        # aberto. Ignorar aqui perderia um pagavel em silencio.
        for assunto in [
            "Ainda não recebemos o seu pagamento",
            "Não recebemos o pagamento da fatura 998",
            "Não identificamos o pagamento do boleto",
        ]:
            self.assertFalse(read_emails.subject_is_payment_confirmation(assunto), assunto)

    def test_recebemos_outra_coisa_nao_casa(self):
        self.assertFalse(read_emails.subject_is_payment_confirmation("Recebemos sua nota fiscal"))


class ReminderSubjectTest(unittest.TestCase):
    """Assunto com a palavra 'lembrete' e ignorado SEMPRE (antes de baixar/extrair), mesmo com
    keyword/anexo — e so um lembrete/aviso, nao a conta a pagar (decisao do usuario). O foco e
    'lembrete'; 'vencimento' sozinho pode ser um boleto real, entao NAO basta."""

    def test_assunto_com_lembrete_e_ignorado(self):
        for assunto in [
            "Lembrete de vencimento",
            "Lembrete de Pagamento: vencimento  10/06/2026",  # caso real (boleto@smartwebservices)
            "LEMBRETE - Boleto 123",                          # com keyword 'boleto'
            "ENC: lembrete da fatura 555",
            "Lembretes pendentes",                            # plural
        ]:
            self.assertTrue(read_emails.subject_is_reminder(assunto), assunto)

    def test_sem_lembrete_nao_casa(self):
        # 'vencimento'/boleto sozinhos NAO casam (evita ignorar boleto real).
        for assunto in [
            "Boleto vencimento 10/07", "Aviso de vencimento",
            "Título a vencer", "Fatura 18293 em aberto",
            "", "Nota fiscal",
        ]:
            self.assertFalse(read_emails.subject_is_reminder(assunto), assunto)


if __name__ == "__main__":
    unittest.main()
