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

    def test_csv_sem_conta_com_conta_do_corpo_resulta_recebido(self):
        # MUDANCA DELIBERADA (2026-08-17): antes era 'extraído' (csv_generated tinha
        # precedencia sobre body_created). Neste estado o PDF gerou CSV mas ZERO contas
        # — o gate `if not attachment_account` de process_message so deixa o corpo rodar
        # quando o anexo nao respondeu por pagavel algum, e accounts_saved==0 aqui. Logo
        # 'extraído' ("o PDF gerou conta") era factualmente falso; a conta veio do corpo.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=True),
            "recebido",
        )

    def test_conta_do_PDF_vence_a_do_corpo(self):
        # A precedencia "o boleto sempre vence o corpo" continua intacta — ela mora em
        # accounts_saved, nao em csv_generated. Estado defensivo: na pratica o gate de
        # process_message nem deixa os dois serem verdade ao mesmo tempo.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=True, accounts_saved=1),
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
        # NÃO REGREDIR: conta nova do corpo vence a duplicata do PDF. O status passou de
        # 'extraído' para 'recebido' em 2026-08-17 (body_created subiu para o 2o lugar) —
        # o que este caso trava continua sendo o mesmo: NAO pode virar 'duplicidade',
        # porque uma conta NOVA foi gravada.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=True, accounts_saved=0,
                                          duplicate=True),
            "recebido",
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


# ---------------------------------------------------------------------------
# Invariante: conta gravada ⇒ status que DECLARA conta
# ---------------------------------------------------------------------------

#: Os únicos status que afirmam "este e-mail produziu conta a pagar".
#: 'extraído' = conta veio do PDF · 'recebido' = conta veio do corpo.
STATUS_COM_CONTA = {"extraído", "recebido"}


class InvarianteContaGravadaTest(unittest.TestCase):
    """🔴 Se o e-mail gerou conta, o status TEM de declarar conta — exaustivo.

    Origem (2026-08-17, e-mail 1517 `<000601dd2e4a$...@lebianco.com.br>`): o anexo era
    uma NF pura (pulada por SKIP_ACCOUNT_TYPES → `nonpayable_only=True`) e o CORPO gravou
    a conta 1059 de R$ 8.250,00. Como `nonpayable` era avaliado ANTES de `body_created`,
    o e-mail virou 'ignorado' — o card de /emails que significa "não-financeiro, nada a
    fazer". Medido no banco: **13 e-mails** no mesmo estado, ~R$ 80 mil escondidos.

    Por que EXAUSTIVO e não um caso por ramo: o defeito não era do ramo `nonpayable`, era
    da ORDEM. `pure_nfe` reproduzia o mesmo bug pela outra porta, e um caso pontual por
    ramo continuaria verde se alguém reintroduzisse a inversão em qualquer sinal futuro.
    O produto cartesiano trava a PROPRIEDADE, não as instâncias — é o que sobrevive a
    parâmetro novo (que nasce coberto).

    Validado por mutante: mover `if body_created` de volta para depois de `nonpayable`
    deixa este teste VERMELHO em 32 combinações.
    """

    #: Cada chave é um parâmetro booleano de status_for_result. `accounts_saved` é
    #: numérico, mas só o "há/não há" importa para o invariante.
    _CAMPOS = ("has_attachment", "csv_generated", "body_created", "pure_nfe",
               "accounts_saved", "notification", "duplicate", "nonpayable")

    def _combinacoes(self):
        import itertools
        for valores in itertools.product((False, True), repeat=len(self._CAMPOS)):
            kwargs = dict(zip(self._CAMPOS, valores))
            kwargs["accounts_saved"] = 1 if kwargs["accounts_saved"] else 0
            yield kwargs

    def test_toda_combinacao_com_conta_produz_status_de_conta(self):
        combos = list(self._combinacoes())
        # Sanidade do gerador: sem isto, um produto quebrado tornaria o teste 0 === 0.
        self.assertEqual(len(combos), 2 ** len(self._CAMPOS),
                         "produto cartesiano incompleto — a guarda estaria vazia")

        com_conta = [k for k in combos if k["accounts_saved"] > 0 or k["body_created"]]
        self.assertGreater(len(com_conta), 0, "nenhum estado com conta foi exercitado")

        observados = set()
        for kwargs in com_conta:
            status = read_emails.status_for_result(**kwargs)
            observados.add(status)
            self.assertIn(
                status, STATUS_COM_CONTA,
                f"conta gravada escondida atrás de {status!r} — entrada: {kwargs}",
            )

        # Anti-vacuidade 2: os DOIS status têm de aparecer. Sem isto, uma função que
        # devolvesse sempre 'extraído' passaria — e a conta do corpo ficaria rotulada
        # como conta do PDF, que é outro modo de mentir sobre a origem.
        self.assertEqual(observados, STATUS_COM_CONTA)

    def test_origem_1517_anexo_nao_pagavel_com_conta_no_corpo(self):
        # O caso real, com os sinais exatos que `process_message` produziu: NF pulada
        # (nonpayable) + CSV gerado pelo PDF + conta criada pelo corpo.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=True,
                                          body_created=True, accounts_saved=0,
                                          nonpayable=True),
            "recebido",
        )

    def test_assunto_de_nfe_nao_esconde_conta_do_corpo(self):
        # Mesmo bug pela outra porta: assunto NF-e puro + pagável no corpo. Estava
        # latente — `pure_nfe` também era avaliado antes de `body_created`.
        self.assertEqual(
            read_emails.status_for_result(has_attachment=True, csv_generated=False,
                                          body_created=True, pure_nfe=True),
            "recebido",
        )


class ProcessMessageAnexoNaoPagavelComCorpoTest(unittest.TestCase):
    """EXECUTA `process_message` no cenário do e-mail 1517 — o call site, não a função.

    CLAUDE.md §2 itens 5 e 6: a função pura não cobre o call site, e a guarda de wiring
    por TEXTO não cobre o call site EXECUTADO. `InvarianteContaGravadaTest` prova a
    ordem; só este prova que `process_message` de fato entrega `body_created=True` junto
    de `nonpayable_only=True` e grava o status resultante em `email_control`.

    Validado por mutante: com a ordem antiga, `rec["status"]` volta a ser 'ignorado'.
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

    class _Mail:
        def __init__(self, raw: bytes):
            self._raw = raw

        def uid(self, cmd, uid, spec=None):
            meta = b'1 (INTERNALDATE "17-Aug-2026 10:17:50 +0000" RFC822 {1}'
            return "OK", [(meta, self._raw)]

    @staticmethod
    def _mensagem() -> bytes:
        from email.message import EmailMessage

        m = EmailMessage()
        m["Subject"] = "LE BIANCO - PAGAMENTO FORNECEDOR (FB COMÉRCIO DE TECIDOS)"
        m["From"] = "estela@lebianco.com.br"
        m["Message-ID"] = "<guarda-anexo-nao-pagavel@local>"
        m.set_content("Por gentileza fazer o pagamento abaixo:\n"
                      "FORNECEDOR: FB COMÉRCIO DE TECIDOS\n"
                      "VALOR: R$ 8.250,00\nVENCIMENTO: 17/08/2026")
        m.add_attachment(b"%PDF-1.4 fake", maintype="application",
                         subtype="pdf", filename="NF_22020.pdf")
        return m.as_bytes()

    def _roda(self, body_outcome):
        from pathlib import Path
        from unittest.mock import patch

        ctrl = self._Ctrl()
        mail = self._Mail(self._mensagem())
        # O anexo é uma NF pura: gera CSV, nenhuma conta, nada de pagável no anexo.
        #   (csvs_ok, accounts_saved, nonpayable_only, attachment_account)
        extract_ret = (["nf.csv"], 0, True, False)
        with patch.object(read_emails, "save_attachments",
                          lambda *a, **k: [Path("NF_22020.pdf")]), \
             patch.object(read_emails, "save_inline_images", lambda *a, **k: []), \
             patch.object(read_emails, "extract_and_store_accounts",
                          lambda *a, **k: extract_ret), \
             patch.object(read_emails, "try_extract_from_body",
                          lambda *a, **k: body_outcome), \
             patch.object(read_emails, "append_log_csv", lambda rec: None):
            rec = read_emails.process_message(mail, b"1", ["pagamento"], False, False, ctrl)
        return rec, ctrl

    def test_conta_do_corpo_com_anexo_nao_pagavel_fica_recebido(self):
        rec, ctrl = self._roda(read_emails.BODY_CREATED)

        self.assertEqual(rec["status"], "recebido", f"notes={rec.get('notes')!r}")
        self.assertEqual(ctrl.registrados[-1]["status"], "recebido",
                         "o status gravado em email_control divergiu do calculado")
        self.assertEqual(ctrl.erros, [], "e-mail com conta gravada não vai para /erros")

    def test_sem_conta_no_corpo_o_anexo_nao_pagavel_segue_ignorado(self):
        # NÃO REGREDIR: sem conta nenhuma, a regra do não-pagável (CT-e/NF-e sem boleto)
        # continua produzindo 'ignorado' em vez de 'falha'.
        rec, ctrl = self._roda(read_emails.BODY_IGNORED)

        self.assertEqual(rec["status"], "ignorado", f"notes={rec.get('notes')!r}")
        self.assertEqual(ctrl.erros, [])
