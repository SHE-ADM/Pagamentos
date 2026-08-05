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


class ProcessMessageCaminhoComAnexoTest(unittest.TestCase):
    """EXECUTA `process_message` no caminho COM ANEXO — a cobertura que faltava.

    Origem (2026-08-04): `email_sem_conteudo_extraivel(has_att, pdf_links, body_text)` foi
    ligada em `process_message` lendo `pdf_links`, que só era atribuído dentro de
    `if not saved_pdfs:`. Com anexo, o ramo não roda e o nome fica sem valor →
    **UnboundLocalError** DEPOIS de a conta já estar gravada: 13 e-mails de um único dia
    (boletos de R$ 43k, R$ 49,5k, R$ 101k) tiveram conta criada mas `email_control` gravado
    como 'falha', com linha em /erros.

    `WiringDasGuardasTest` não pegava — e não é defeito dela: ela lê o TEXTO de
    `process_message` e prova que a chamada EXISTE. Só executar prova que ela FUNCIONA.
    É a §2 item 5 do CLAUDE.md ("a função pura não cobre o call site") no seu grau
    seguinte: nem o call site conferido por texto cobre o call site EXECUTADO.
    """

    class _Ctrl:
        """Stub de SupabaseControl — registra o que recebeu, sem rede."""

        def __init__(self):
            self.registrados = []
            self.erros = []

        def register(self, rec):
            self.registrados.append(dict(rec))
            return True

        def register_error(self, rec, tipo, msg, raw_payload=None):
            self.erros.append((tipo, msg))
            return True

    @staticmethod
    def _mensagem(com_anexo: bool, corpo: str) -> bytes:
        from email.message import EmailMessage

        m = EmailMessage()
        m["Subject"] = "PAGAMENTO BOLETO MODART 10083-1"
        m["From"] = "ester@otimotex.com.br"
        m["Message-ID"] = "<guarda-com-anexo@local>"
        m.set_content(corpo)
        if com_anexo:
            m.add_attachment(b"%PDF-1.4 fake", maintype="application",
                             subtype="pdf", filename="boleto.pdf")
        return m.as_bytes()

    class _Mail:
        def __init__(self, raw: bytes):
            self._raw = raw

        def uid(self, cmd, uid, spec=None):
            meta = b'1 (INTERNALDATE "04-Aug-2026 10:00:00 +0000" RFC822 {1}'
            return "OK", [(meta, self._raw)]

    def _roda(self, com_anexo: bool, extract_ret, corpo: str = "Segue o boleto."):
        from unittest.mock import patch

        ctrl = self._Ctrl()
        mail = self._Mail(self._mensagem(com_anexo, corpo))
        anexos = [Path("boleto.pdf")] if com_anexo else []
        with patch.object(R, "save_attachments", lambda *a, **k: list(anexos)), \
             patch.object(R, "save_inline_images", lambda *a, **k: []), \
             patch.object(R, "extract_and_store_accounts", lambda *a, **k: extract_ret), \
             patch.object(R, "try_extract_from_body", lambda *a, **k: R.BODY_NONE), \
             patch.object(R, "append_log_csv", lambda rec: None):
            rec = R.process_message(mail, b"1", ["boleto"], False, False, ctrl)
        return rec, ctrl

    def test_com_anexo_e_conta_gravada_o_email_fica_extraido(self):
        # O caminho principal do pipeline: anexo → CSV → conta. Antes do fix, este
        # caso saía 'falha' com notes="Erro: cannot access local variable 'pdf_links'".
        rec, ctrl = self._roda(True, (["boleto.csv"], 1, False, True))

        self.assertEqual(rec["status"], "extraído", f"notes={rec.get('notes')!r}")
        self.assertNotIn("pdf_links", str(rec.get("notes") or ""))
        self.assertEqual(ctrl.erros, [], "e-mail com conta gravada não pode gerar linha em /erros")
        self.assertTrue(ctrl.registrados and ctrl.registrados[-1]["status"] == "extraído")

    def test_com_anexo_sem_conta_ainda_percorre_a_guarda_sem_estourar(self):
        # Anexo salvo que não gerou conta ⇒ 'pendente'. O ponto é que a guarda
        # `email_sem_conteudo_extraivel` é avaliada com pdf_links=[] sem levantar.
        rec, _ = self._roda(True, ([], 0, False, False))

        self.assertEqual(rec["status"], "pendente", f"notes={rec.get('notes')!r}")
        self.assertNotIn("pdf_links", str(rec.get("notes") or ""))

    def test_sem_anexo_continua_valendo_a_regra_do_nao_pagavel(self):
        # Não-regressão do caminho que a feature original endereçou: sem anexo, sem
        # link e sem corpo útil ⇒ 'ignorado', não 'falha'. Corpo VAZIO de propósito —
        # com texto útil o e-mail é falha legítima, e o caso deixaria de testar a guarda.
        rec, ctrl = self._roda(False, ([], 0, False, False), corpo="")

        self.assertEqual(rec["status"], "ignorado", f"notes={rec.get('notes')!r}")
        self.assertEqual(ctrl.erros, [])
