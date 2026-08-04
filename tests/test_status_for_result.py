"""
Testes para status_for_result (read_emails.py) — derivacao de email_control.status.

Cobre o bug em que um e-mail COM anexo cuja conta foi criada pelo corpo
(body_created=True, csv_generated=False) era marcado 'pendente', divergindo do
/consulta (onde a conta aparecia). O esperado e 'recebido'.
"""

import sys
import unittest
from pathlib import Path

# O modulo vive em skills/email-reader/scripts/ (diretorio com hifen — nao
# importavel como pacote). Adiciona o caminho ao sys.path, como server/app.py faz.
_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


class StatusForResultTest(unittest.TestCase):
    def test_csv_do_pdf_resulta_extraido(self):
        # PDF extraido com CSV — independe do corpo/anexo.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=False),
            "extraído",
        )

    def test_conta_do_corpo_com_anexo_resulta_recebido(self):
        # Regressao: anexo presente, PDF nao gerou CSV, conta veio do corpo.
        # Antes virava 'pendente'; agora deve ser 'recebido'.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=False,
                                          body_created=True),
            "recebido",
        )

    def test_conta_do_corpo_sem_anexo_resulta_recebido(self):
        self.assertEqual(
            read_emails.status_for_result(has_attachment=False, csv_generated=False,
                                          body_created=True),
            "recebido",
        )

    def test_anexo_sem_conta_resulta_pendente(self):
        # PDF salvo, mas nem PDF nem corpo geraram conta — aguarda reprocessamento.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=False,
                                          body_created=False),
            "pendente",
        )

    def test_sem_anexo_e_sem_conta_resulta_falha(self):
        self.assertEqual(
            read_emails.status_for_result(has_attachment=False, csv_generated=False,
                                          body_created=False),
            "falha",
        )

    def test_csv_tem_precedencia_sobre_corpo(self):
        # Se o PDF gerou CSV, 'extraído' prevalece mesmo com body_created.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=True),
            "extraído",
        )

    def test_nonpayable_cte_sem_boleto_resulta_ignorado(self):
        # CT-e/transporte sem boleto: PDF gera CSV mas nenhuma conta. `nonpayable`
        # tem precedencia sobre csv_generated (senao viraria 'extraído', errado).
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=False, accounts_saved=0,
                                          nonpayable=True),
            "ignorado",
        )

    def test_conta_salva_vence_nonpayable(self):
        # E-mail misto (CT-e fiscal pulado + boleto gravado): 'extraído' prevalece.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=False, accounts_saved=1,
                                          nonpayable=True),
            "extraído",
        )

    def test_nfe_pura_sem_conta_resulta_ignorado(self):
        # Assunto NF-e puro, PDF gerou CSV (NF-e e SKIP_ACCOUNT_TYPES → sem conta):
        # nao e conta a pagar, vira 'ignorado' em vez do antigo 'extraído'.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=False, pure_nfe=True,
                                          accounts_saved=0),
            "ignorado",
        )

    def test_nfe_pura_sem_anexo_resulta_ignorado(self):
        # Notificacao de NF-e sem anexo/sem conta — nao polui /erros como 'falha'.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=False, csv_generated=False,
                                          body_created=False, pure_nfe=True),
            "ignorado",
        )

    def test_notificacao_sem_anexo_resulta_ignorado(self):
        # Sem anexo, sem CSV, sem conta no corpo, mas assunto de notificacao
        # (aviso/confirmacao/informe/SIEG): 'ignorado' em vez de 'falha'.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=False, csv_generated=False,
                                          body_created=False, notification=True),
            "ignorado",
        )

    def test_notificacao_com_anexo_continua_pendente(self):
        # Notificacao mas COM anexo (PDF salvo) -> revisar (pendente), nao ignorar.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=False,
                                          body_created=False, notification=True),
            "pendente",
        )

    def test_duplicata_do_corpo_resulta_duplicidade(self):
        # Pagável do corpo duplica conta já registrada por outro e-mail:
        # status próprio 'duplicidade' (não 'falha' nem 'recebido').
        self.assertEqual(
            read_emails.status_for_result(has_attachment=False, csv_generated=False,
                                          body_created=False, duplicate=True),
            "duplicidade",
        )

    def test_duplicata_tem_precedencia_sobre_anexo_e_notificacao(self):
        # Mesmo com anexo/notificação, "já registrada" descreve melhor → duplicidade.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=False,
                                          body_created=False, notification=True,
                                          duplicate=True),
            "duplicidade",
        )

    def test_conta_nova_do_corpo_tem_precedencia_sobre_duplicata(self):
        # body_created (conta nova gravada) vem antes de duplicate.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=False, csv_generated=False,
                                          body_created=True, duplicate=True),
            "recebido",
        )

    def test_nfe_com_conta_resulta_extraido(self):
        # NF-e + boleto: conta foi gravada (accounts_saved>0) → 'extraído' prevalece
        # sobre pure_nfe, para nao esconder a conta a pagar.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=False, pure_nfe=True,
                                          accounts_saved=1),
            "extraído",
        )


if __name__ == "__main__":
    unittest.main()


class StatusDuplicidadeDoPdfTest(unittest.TestCase):
    """PDF lido cujas linhas foram TODAS deduplicadas → 'duplicidade', não 'extraído'.

    Antes disso, 'extraído' era emitido tanto para "gravou conta" quanto para "descartou
    tudo na dedup" — e foi assim que a perda do boleto T.R.T (conta 847) ficou invisível:
    e-mail verde, sem conta e sem erro em /erros. Ver a guarda `_same_title`.
    """

    def test_csv_sem_conta_com_dedup_vira_duplicidade(self):
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=False, accounts_saved=0,
                                          duplicate=True),
            "duplicidade",
        )

    def test_csv_COM_conta_continua_extraido(self):
        # Conta nova gravada: o e-mail produziu pagável, mesmo tendo deduplicado outra linha.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=False, accounts_saved=1,
                                          duplicate=True),
            "extraído",
        )

    def test_csv_sem_conta_e_sem_dedup_continua_extraido(self):
        # Sem dedup, o descarte tem outra causa (sem_valor/erro) e já aparece em /erros.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=False, accounts_saved=0),
            "extraído",
        )

    def test_corpo_com_conta_nova_tem_precedencia(self):
        # NÃO REGREDIR: conta nova do corpo vence a duplicata do PDF.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=True, accounts_saved=0,
                                          duplicate=True),
            "extraído",
        )


class WiringDuplicidadeDoPdfTest(unittest.TestCase):
    """GUARDA DE WIRING — a função pura não prova que o call site a usa.

    Lição registrada no CLAUDE.md §2 item 5 e reincidente aqui: os testes de
    `status_for_result` passam `duplicate=True` na mão, então continuam VERDES mesmo que
    `process_message` deixe de informar a dedup do PDF. Medido: o mutante que troca a
    chamada por `or False` passava nos 1079 testes. Esta guarda lê o CÓDIGO.
    """

    def _fonte_process_message(self) -> str:
        import inspect
        return inspect.getsource(read_emails.process_message)

    def test_helper_decide_pelo_anexo_sem_conta_nova(self):
        # conta nova gravada → não é duplicata
        self.assertFalse(read_emails._pdf_only_deduplicated(True, 1))
        # anexo respondeu por pagável existente, sem conta nova → duplicata
        self.assertTrue(read_emails._pdf_only_deduplicated(True, 0))
        # anexo não respondeu por pagável nenhum → não é duplicata (é falha/pendente)
        self.assertFalse(read_emails._pdf_only_deduplicated(False, 0))

    def test_process_message_INFORMA_a_dedup_do_pdf_ao_status(self):
        fonte = self._fonte_process_message()
        # sanidade do parser: se `status_for_result` sumir daqui, a guarda vira 0===0
        self.assertIn("status_for_result(", fonte,
                      "parser quebrado: process_message não chama mais status_for_result")
        self.assertIn("_pdf_only_deduplicated(", fonte,
                      "REGRESSÃO: process_message não informa mais a dedup do anexo ao "
                      "status — o PDF deduplicado volta a virar 'extraído' e a perda de "
                      "pagável fica invisível de novo")

    def test_a_dedup_do_pdf_alimenta_o_parametro_duplicate(self):
        # Não basta a função ser chamada em algum lugar: tem de ser no argumento certo.
        fonte = self._fonte_process_message()
        trecho = fonte[fonte.index("status_for_result("):]
        dup = trecho[trecho.index("duplicate="):]
        dup = dup[:dup.index("\n", dup.index(")"))] if ")" in dup else dup
        self.assertIn("_pdf_only_deduplicated", dup,
                      "a dedup do anexo não está ligada ao parâmetro `duplicate`")
