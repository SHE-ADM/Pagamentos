"""
Três guardas que impedem e-mail NÃO-PAGÁVEL de virar 'falha' e poluir /erros.

Origem (2026-08-04): dos 21 e-mails em 'falha', **nenhum** era recuperável —
`reprocess_link_emails` e `reprocess_body_emails` devolveram 0 dos dois lados (16 já não
estavam na INBOX; os 5 restantes não tinham link nem dados no corpo). Não eram falhas do
pipeline: eram e-mails que nunca poderiam virar conta. Marcá-los 'falha' os punha em
/erros competindo por atenção com extração que REALMENTE quebrou.

  1. `email_sem_conteudo_extraivel` — sem anexo, sem link e sem corpo útil (11 casos)
  2. `is_disposable_sender`        — subdomínio descartável de phishing (3 casos)
  3. NOTIFICATION_PHRASE_TERMS     — avisos que casam keyword mas não são cobrança

As três alimentam `notification`, que só produz 'ignorado' quando NÃO houve anexo/CSV/conta
— então nenhuma delas pode esconder uma conta que o pipeline conseguiu extrair.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails as R  # noqa: E402


class EmailSemConteudoTest(unittest.TestCase):
    def test_sem_anexo_sem_link_e_sem_corpo(self):
        # Caso real: "RES: boleto e nf em anexo favor confirmar" (ids 99/100/102) — thread
        # de resposta cujo conteúdo ficou só no assunto.
        self.assertTrue(R.email_sem_conteudo_extraivel(False, [], ""))
        self.assertTrue(R.email_sem_conteudo_extraivel(False, [], None))
        self.assertTrue(R.email_sem_conteudo_extraivel(False, [], "  \r\n -- \r\n . "))

    def test_COM_LINK_continua_falha(self):
        # 🔴 NÃO REGREDIR: com link, o e-mail TINHA de onde extrair e o download fracassou.
        # Isso é falha de verdade (portal que mudou, SSRF, PDF removido) e precisa
        # continuar visível em /erros — é o caso que mais merece investigação.
        self.assertFalse(R.email_sem_conteudo_extraivel(False, ["http://x/boleto.pdf"], ""))

    def test_COM_ANEXO_continua_falha(self):
        # Anexo salvo que não gerou conta é falha de extração, não e-mail vazio.
        self.assertFalse(R.email_sem_conteudo_extraivel(True, [], ""))

    def test_corpo_CURTO_mas_util_nao_e_vazio(self):
        # 🔴 O critério é AUSÊNCIA de conteúdo, nunca tamanho: corpo curto é a NORMA aqui.
        self.assertFalse(R.email_sem_conteudo_extraivel(False, [], "FORNECEDOR X R$ 250,00 venc 10/08"))
        self.assertFalse(R.email_sem_conteudo_extraivel(False, [], "ok"))
        self.assertFalse(R.email_sem_conteudo_extraivel(False, [], "1"))


class DisposableSenderTest(unittest.TestCase):
    # Remetentes reais das 3 campanhas que caíram em 'falha' (ids 945/1083/1184).
    PHISHING = (
        "setorfinanceiro@servidor9n3xa9.powerallynigeria.com",
        "no_responder@servidorj2tzqm.dkaitech.com",
        "setorfinanceiro@servidortbvl0z.paidmediacourses.com",
    )
    LEGITIMOS = (
        "financeiro@romplas.com.br",
        "rose@otimotex.com.br",
        "no-reply@sswsistemas.com.br",
        "contato@servidor.com.br",      # domínio que POR ACASO se chama "servidor"
        "faturamento@meuservidor.com",  # "servidor" no meio, sem o hash
    )

    def test_pega_as_campanhas_reais(self):
        for e in self.PHISHING:
            self.assertTrue(R.is_disposable_sender(e), e)

    def test_nao_pega_remetente_legitimo(self):
        # O padrão é estreito de propósito: um filtro por "domínio desconhecido"
        # barraria fornecedor novo, que é justamente o que o pipeline precisa aceitar.
        for e in self.LEGITIMOS:
            self.assertFalse(R.is_disposable_sender(e), e)

    def test_vazio_e_none(self):
        self.assertFalse(R.is_disposable_sender(""))
        self.assertFalse(R.is_disposable_sender(None))


class NotificacaoNaoPagavelTest(unittest.TestCase):
    def test_assuntos_reais_que_caiam_em_falha(self):
        casos = [
            "Nova forma de pagamento registrada!",                    # Locaweb (1262/1263)
            "AGENDAMENTO DE COLETA: A BASE DE TUDO! - Carvalima",      # SSW (806)
            "Re: CONFIRMAÇÃO RECEBIMENTO TEKA - NF 636927 - TEXTIL",   # (429)
        ]
        for s in casos:
            self.assertTrue(R.subject_is_ignorable_notification(s), s)

    def test_nao_captura_cobranca_de_verdade(self):
        # Não regredir: assunto de cobrança real precisa seguir para a extração.
        for s in ("BOLETO 248 - TEXTIL E CONFECCOES OTIMOTEX LTDA",
                  "Segue boleto para pagamento",
                  "PAGAMENTO DARE - REF. T05S1",
                  "Sua fatura Nº604358 está disponível."):
            self.assertFalse(R.subject_is_ignorable_notification(s), s)


class WiringDasGuardasTest(unittest.TestCase):
    """GUARDA DE WIRING — a função pura não prova que `process_message` a usa.

    Mesma lição do CLAUDE.md §2 item 5, que já reincidiu duas vezes neste projeto.
    """

    def _fonte(self) -> str:
        import inspect
        return inspect.getsource(R.process_message)

    def test_as_tres_guardas_alimentam_o_parametro_notification(self):
        fonte = self._fonte()
        # sanidade do parser: sem isto, a guarda vira 0 === 0
        self.assertIn("status_for_result(", fonte,
                      "parser quebrado: process_message não chama status_for_result")
        trecho = fonte[fonte.index("status_for_result("):]
        bloco = trecho[trecho.index("notification="):trecho.index("duplicate=")]
        for fn in ("subject_is_ignorable_notification",
                   "is_disposable_sender",
                   "email_sem_conteudo_extraivel"):
            self.assertIn(fn, bloco,
                          f"REGRESSÃO: {fn} não alimenta mais `notification` — os e-mails "
                          "não-pagáveis voltam a virar 'falha' e a poluir /erros")

    def test_status_ignorado_quando_nao_ha_anexo_csv_nem_conta(self):
        # A ponta final: 'notification' só vira 'ignorado' sem anexo/CSV/conta.
        self.assertEqual(
            R.status_for_result(has_attachment=False, csv_generated=False,
                                body_created=False, notification=True),
            "ignorado",
        )
        # E NUNCA esconde conta que o pipeline conseguiu extrair.
        self.assertEqual(
            R.status_for_result(has_attachment=True, csv_generated=True,
                                body_created=False, accounts_saved=1, notification=True),
            "extraído",
        )


if __name__ == "__main__":
    unittest.main()
