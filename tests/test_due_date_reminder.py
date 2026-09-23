"""Lembrete de vencimento corrige o vencimento PRESUMIDO de uma conta existente.

Caso real (Leadster, contas 1020 e 1474): o e-mail da fatura não traz data ("Confira a data do
vencimento clicando no link") e a conta nascia com vencimento = emissão. A data só chega nos
lembretes ("Sua fatura vence em 10 dias na data de 27/08/2026", "vence hoje"). Decisão do
usuário (2026-09-14): o lembrete ATUALIZA o vencimento da conta já existente do fornecedor.

Propriedades travadas:

🔴 1. Só conta com a MARCA de vencimento presumido é elegível — vencimento lido do documento
      nunca é sobrescrito por aviso. A marca nasce em `extract_from_email_body` e sai quando o
      código de barras define a data.
🔴 2. Candidato ÚNICO: dois elegíveis ⇒ nada é atualizado. Lembrete repetido da mesma fatura
      (data já gravada) ⇒ nada a fazer.
🔴 3. O fornecedor sai de `find_supplier_by_email` (consulta pura) — o hook NUNCA chama
      `resolve_supplier`, cuja RPC cria cadastro.
🔴 4. Não-fatal: exceção é logada com traceback e o e-mail segue.
🔴 5. O CALL SITE em `process_message` é EXECUTADO: o lembrete aplicado tira o e-mail de /erros.
🔴 6. A marca gravada pela migration 136 na conta 1474 é o MESMO texto da constante.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import read_emails as R  # noqa: E402

PRESUMIDO = R.DUE_DATE_PRESUMED_NOTE
REMETENTE = "financeiro@leadster.com.br"

# Corpo REAL do e-mail 1541 (lembrete de 17/08/2026).
CORPO_10_DIAS = (
    "Notificação Leadster \r\n"
    " Sua fatura está próxima do vencimento 😉 \r\n"
    " Olá Nelson, que tudo esteja bem! \r\n"
    " Sua fatura vence em 10 dias na data de 27/08/2026 \r\n"
    " Acesse aqui sua fatura \r\n"
    " Acesse aqui sua nota fiscal \r\n"
    " Caso tenha alguma dúvida ou divergência responda esse e-mail.\r\n"
    " E-mail: financeiro@leadster.com.br \r\n"
)
CORPO_HOJE = "Notificação Leadster\r\n Sua fatura vence hoje \r\n Acesse aqui sua fatura"
CORPO_AMANHA = "Notificação Leadster\r\n Sua fatura vence amanhã \r\n Acesse aqui sua fatura"
# Corpo REAL do e-mail 1115 — confirmação de pagamento, nunca lembrete.
CORPO_PAGO = ("Leadster Recebemos o seu pagamento 🙂 Empresa: Têxtil E Confecções Otimotex Ltda "
              "Recebemos o pagamento da fatura referente: • Valor: R$ 362,62 "
              "• Forma de pagamento: Boleto Bancário")
# Corpo REAL do e-mail 2156 (fatura sem data — conta 1474).
CORPO_FATURA_SEM_DATA = (
    "Leadster \r\n Geramos sua Fatura 🙂\r\n"
    " Empresa: Têxtil E Confecções Otimotex Ltda\n"
    " Geramos sua fatura referente ao período de 30/08/2026 a 29/09/2026\n"
    " Plano: Growth 3k - Mensal \r\n Valor: R$ 362,62 \r\n"
    " Confira a data do vencimento de sua fatura clicando no link abaixo!\r\n"
)


def _conta(id_, issue, due, notes=PRESUMIDO, amount=362.62):
    return {"id": id_, "issue_date": issue, "due_date": due, "amount": amount,
            "amount_charged": amount, "processing_notes": notes}


class ParseLembreteTest(unittest.TestCase):

    def test_data_explicita_do_lembrete_real(self):
        self.assertEqual(R.parse_due_date_reminder("Leadster - Sua fatura vence em 10 dias",
                                                   CORPO_10_DIAS, "2026-08-17T18:00:29+00:00"),
                         "2026-08-27")

    def test_hoje_e_amanha_usam_o_dia_de_chegada(self):
        self.assertEqual(R.parse_due_date_reminder("Leadster - Sua fatura vence hoje",
                                                   CORPO_HOJE, "2026-08-27T18:00:07+00:00"),
                         "2026-08-27")
        self.assertEqual(R.parse_due_date_reminder("Leadster - Sua fatura vence  amanhã",
                                                   CORPO_AMANHA, "2026-08-26T18:01:30+00:00"),
                         "2026-08-27")

    def test_hoje_e_o_dia_de_brasilia_nao_o_de_utc(self):
        # 01h30 UTC de 27/08 = 22h30 de 26/08 em Brasília: "vence hoje" fala de 26/08.
        self.assertEqual(R.parse_due_date_reminder("", CORPO_HOJE, "2026-08-27T01:30:00+00:00"),
                         "2026-08-26")

    def test_nao_e_lembrete(self):
        casos = {
            "confirmação de pagamento": ("Leadster | Recebemos o seu pagamento", CORPO_PAGO),
            "título vencido": ("Cobrança", "O título venceu no dia 08/07/2026 e consta em aberto"),
            "fatura sem data": ("Leadster | Aqui está sua fatura", CORPO_FATURA_SEM_DATA),
            "vazio": ("", ""),
        }
        for nome, (assunto, corpo) in casos.items():
            with self.subTest(nome):
                self.assertIsNone(R.parse_due_date_reminder(assunto, corpo,
                                                            "2026-08-17T18:00:29+00:00"))

    def test_data_fora_da_janela_plausivel_e_recusada(self):
        recebido = "2026-08-17T18:00:29+00:00"
        passado = "Sua fatura vence em 10 dias na data de 01/08/2026"
        distante = "Sua fatura vence em 90 dias na data de 20/11/2026"
        self.assertIsNone(R.parse_due_date_reminder("", passado, recebido))
        self.assertIsNone(R.parse_due_date_reminder("", distante, recebido))

    def test_received_at_invalido_nao_levanta(self):
        self.assertIsNone(R.parse_due_date_reminder("", CORPO_HOJE, "não é data"))


class SelecaoDoAlvoTest(unittest.TestCase):

    def test_conta_unica_com_marca_e_atualizada(self):
        acao, alvo = R.select_reminder_target([_conta(1474, "2026-09-14", "2026-09-14")],
                                              "2026-09-27")
        self.assertEqual((acao, alvo["id"]), (R.REMINDER_UPDATE, 1474))

    def test_conta_sem_marca_nunca_e_tocada(self):
        # Vencimento lido do documento (sem marca) — um aviso não o sobrescreve.
        acao, _ = R.select_reminder_target(
            [_conta(1020, "2026-08-14", "2026-08-14", notes=None)], "2026-08-27")
        self.assertEqual(acao, R.REMINDER_NO_MATCH)

    def test_lembrete_repetido_da_mesma_fatura_nao_faz_nada(self):
        confirmada = R._notes_with_reminder_marker(PRESUMIDO, "2026-08-27")
        acao, alvo = R.select_reminder_target(
            [_conta(1020, "2026-08-14", "2026-08-27", notes=confirmada)], "2026-08-27")
        self.assertEqual((acao, alvo["id"]), (R.REMINDER_ALREADY, 1020))

    def test_conta_ja_confirmada_nao_e_movida_por_lembrete_de_outra_fatura(self):
        # Agosto confirmada para 27/08 e ainda em aberto; setembro ainda não virou conta. O
        # lembrete de setembro NÃO pode mover o vencimento de agosto.
        confirmada = R._notes_with_reminder_marker(PRESUMIDO, "2026-08-27")
        conta = _conta(1020, "2026-08-14", "2026-08-27", notes=confirmada)
        # Anti-vacuidade: a conta está DENTRO da janela da emissão — a recusa vem da regra da
        # confirmação, não do filtro de janela.
        self.assertLessEqual(R._iso_to_date("2026-09-27"),
                             R._iso_to_date("2026-08-14")
                             + R.timedelta(days=R.REMINDER_MAX_DAYS_AFTER_ISSUE))
        acao, alvo = R.select_reminder_target([conta], "2026-09-27")
        self.assertEqual((acao, alvo), (R.REMINDER_NO_MATCH, None))

    def test_presumida_e_corrigida_mesmo_com_uma_confirmada_na_janela(self):
        confirmada = R._notes_with_reminder_marker(PRESUMIDO, "2026-08-27")
        acao, alvo = R.select_reminder_target(
            [_conta(1020, "2026-08-14", "2026-08-27", notes=confirmada),
             _conta(1474, "2026-09-14", "2026-09-14")], "2026-09-27")
        self.assertEqual((acao, alvo["id"]), (R.REMINDER_UPDATE, 1474))

    def test_conta_com_data_lida_na_mesma_data_impede_mover_a_presumida(self):
        # Boleto com vencimento LIDO do documento (sem marca) já vence em 27/09: o lembrete fala
        # dele. A conta presumida do mesmo fornecedor NÃO pode receber essa data.
        lida = _conta(900, "2026-09-10", "2026-09-27", notes=None)
        presumida = _conta(1474, "2026-09-14", "2026-09-14")
        acao, alvo = R.select_reminder_target([lida, presumida], "2026-09-27")
        self.assertEqual((acao, alvo["id"]), (R.REMINDER_ALREADY, 900))

    def test_dois_candidatos_nao_adivinha(self):
        acao, alvo = R.select_reminder_target(
            [_conta(1, "2026-09-01", "2026-09-01"), _conta(2, "2026-09-10", "2026-09-10")],
            "2026-09-27")
        self.assertEqual((acao, alvo), (R.REMINDER_AMBIGUOUS, None))

    def test_emissao_fora_da_janela_nao_e_candidata(self):
        depois = _conta(1, "2026-09-30", "2026-09-30")    # emitida DEPOIS do vencimento anunciado
        antiga = _conta(2, "2026-06-01", "2026-06-01")    # emitida muito antes
        acao, _ = R.select_reminder_target([depois, antiga], "2026-09-27")
        self.assertEqual(acao, R.REMINDER_NO_MATCH)

    def test_valor_filtra_quando_o_lembrete_o_informa(self):
        contas = [_conta(1, "2026-09-10", "2026-09-10", amount=100.00),
                  _conta(2, "2026-09-12", "2026-09-12", amount=362.62)]
        acao, alvo = R.select_reminder_target(contas, "2026-09-27", amount=362.62)
        self.assertEqual((acao, alvo["id"]), (R.REMINDER_UPDATE, 2))
        acao, _ = R.select_reminder_target(contas, "2026-09-27", amount=999.99)
        self.assertEqual(acao, R.REMINDER_NO_MATCH)

    def test_linha_malformada_nao_levanta(self):
        acao, _ = R.select_reminder_target([None, {"id": 9}, _conta(3, "x", "y")], "2026-09-27")
        self.assertEqual(acao, R.REMINDER_NO_MATCH)


class MarcaDeVencimentoTest(unittest.TestCase):

    def test_fatura_sem_data_nasce_com_a_marca_e_com_data_declarada_nao(self):
        sem_data = R.extract_from_email_body(CORPO_FATURA_SEM_DATA, "2026-09-14T10:57:10+00:00",
                                             "<a@local>", REMETENTE, subject="Aqui está sua fatura")
        self.assertEqual(sem_data["processing_notes"], PRESUMIDO)
        self.assertEqual(sem_data["due_date"], "2026-09-14")  # o fallback que a marca sinaliza

        com_data = R.extract_from_email_body(CORPO_FATURA_SEM_DATA + " Vencimento: 27/09/2026",
                                             "2026-09-14T10:57:10+00:00", "<b@local>",
                                             REMETENTE, subject="Aqui está sua fatura")
        self.assertEqual(com_data["due_date"], "2026-09-27")
        self.assertIsNone(com_data["processing_notes"])

    def test_troca_de_marca_preserva_as_demais_notas(self):
        notas = f"Nota anterior | {PRESUMIDO} | Outra nota"
        self.assertEqual(R._notes_with_reminder_marker(notas, "2026-09-27"),
                         "Nota anterior | Outra nota | "
                         f"{R.DUE_DATE_REMINDER_NOTE}: 27/09/2026")
        self.assertIsNone(R._without_due_date_markers(PRESUMIDO))

    def test_codigo_de_barras_tira_a_marca_mesmo_quando_confirma_a_data(self):
        def payload(due):
            return {"barcode": "123", "amount": 362.62, "issue_date": "2026-09-14",
                    "due_date": due, "processing_notes": PRESUMIDO}

        # 🔴 O mock substitui SO a derivacao do fator; a POLITICA (barcode_due_date_supersedes)
        # e as NOTAS vem das canonicas de verdade. Um `return_value` unico para todo nome
        # devolvia "2026-09-27" ate como texto da nota, e o teste deixava de enxergar a regra
        # que diz quem vence.
        def so_o_fator(nome):
            if nome == "authoritative_barcode_due_date":
                return lambda *a, **k: "2026-09-27"
            return getattr(R._febraban(), nome)

        with mock.patch.object(R, "_febraban_fn", side_effect=so_o_fator):
            corrigido = payload("2026-09-14")
            R._apply_barcode_due_date(corrigido)
            confirmado = payload("2026-09-27")
            R._apply_barcode_due_date(confirmado)
        self.assertEqual(corrigido["due_date"], "2026-09-27")
        self.assertFalse(R._has_presumed_due_marker(corrigido["processing_notes"]))
        self.assertIn("código de barras", corrigido["processing_notes"])
        self.assertIsNone(confirmado["processing_notes"])

        # Sem fator derivavel (barcode que nao decodifica): a marca de presumido PERMANECE.
        with mock.patch.object(R, "_febraban_fn", return_value=lambda *a, **k: None):
            sem_fator = payload("2026-09-14")
            R._apply_barcode_due_date(sem_fator)
        self.assertEqual(sem_fator["processing_notes"], PRESUMIDO)

    def test_vencimento_PRESUMIDO_nunca_vence_o_fator(self):
        """🔴 Presumido NÃO é data impressa — o fator manda sempre.

        A conta do CORPO nasce com `due_date` = data do e-mail e a marca de presumido.
        Submetê-la à política de prorrogação fazia o código ler um PALPITE como "o papel diz":
        a data do e-mail é quase sempre posterior ao fator, então saía "prorrogação", a conta
        ficava com vencimento FUTURO (fora do aging e da cobrança) e — pior — a marca era
        removida logo em seguida, de modo que nenhum lembrete poderia corrigi-la depois.
        """
        BC = "00198157600025092000000003580329000000432917"   # fator 2026-09-21, valor 25092,00
        payload = {"barcode": BC, "amount": 25092.00, "issue_date": None,
                   "due_date": "2026-10-01",            # presumida (data do e-mail)
                   "processing_notes": PRESUMIDO}
        R._apply_barcode_due_date(payload)
        self.assertEqual(payload["due_date"], "2026-09-21")          # o fator venceu
        self.assertFalse(R._has_presumed_due_marker(payload["processing_notes"]))
        self.assertIn("Vencimento corrigido", payload["processing_notes"])

    def test_data_LIDA_de_documento_segue_vencendo_o_fator(self):
        # Contraprova (anti-vacuidade): sem a marca de presumido, a mesma data é tratada como
        # lida do documento e prevalece — é a correção do boleto prorrogado.
        BC = "00198157600025092000000003580329000000432917"
        payload = {"barcode": BC, "amount": 25092.00, "issue_date": "2026-09-17",
                   "due_date": "2026-10-01", "processing_notes": None}
        R._apply_barcode_due_date(payload)
        self.assertEqual(payload["due_date"], "2026-10-01")

    def test_migration_136_grava_na_1474_exatamente_a_marca_do_codigo(self):
        sql = (_ROOT / "supabase" / "migrations" / "136_fornecedor_pagadora_e_leadster.sql"
               ).read_text(encoding="utf-8")
        # Divergência de UMA letra tornaria a 1474 inelegível para o lembrete, sem erro nenhum.
        self.assertIn(f"'{PRESUMIDO}'", sql)
        self.assertIn(f"LIKE '{PRESUMIDO}%'", sql)


class _CtrlLembrete:
    """SupabaseControl mínimo para o hook. `resolve_supplier` FALHA o teste se for chamado."""

    def __init__(self, sk=1369, contas=None, update_ok=True, erro=None):
        self.sk, self.contas, self.update_ok, self.erro = sk, contas, update_ok, erro
        self.lookups, self.updates = [], []

    def find_supplier_by_email(self, email):
        self.lookups.append(email)
        if self.erro:
            raise self.erro
        return self.sk

    def resolve_supplier(self, payload):
        raise AssertionError("o lembrete nunca pode chamar resolve_supplier (cria cadastro)")

    def open_accounts_for_reminder(self, sk_supplier):
        return self.contas

    def update_due_date_from_reminder(self, account_id, expected_due, new_due, notes):
        self.updates.append((account_id, expected_due, new_due, notes))
        return self.update_ok


class ApplyLembreteTest(unittest.TestCase):
    RECEBIDO = "2026-09-17T18:00:29+00:00"
    CORPO = "Sua fatura vence em 10 dias na data de 27/09/2026"

    def _aplica(self, ctrl, rec=None):
        rec = {} if rec is None else rec
        return R.apply_due_date_reminder(ctrl, rec, "Leadster - Sua fatura vence em 10 dias",
                                         self.CORPO, REMETENTE, self.RECEBIDO), rec

    def test_atualiza_a_conta_presumida_e_anota_o_email(self):
        ctrl = _CtrlLembrete(contas=[_conta(1474, "2026-09-14", "2026-09-14")])
        resultado, rec = self._aplica(ctrl)
        self.assertEqual(resultado, 1474)
        self.assertEqual(ctrl.lookups, [REMETENTE])
        self.assertEqual(ctrl.updates, [(1474, "2026-09-14", "2026-09-27",
                                         f"{R.DUE_DATE_REMINDER_NOTE}: 27/09/2026")])
        self.assertIn("1474", rec["notes"])

    def test_lembrete_que_repete_a_data_presumida_a_confirma(self):
        # Conta 1474 (migration 136): 27/09 INFERIDO, com a marca de presumido e outra nota. O
        # lembrete que anuncia a MESMA data não muda o vencimento, mas o torna CONFIRMADO.
        notas_136 = f"{PRESUMIDO} | 27/09/2026 inferido do ciclo das faturas anteriores"
        ctrl = _CtrlLembrete(contas=[_conta(1474, "2026-09-14", "2026-09-27", notes=notas_136)])
        resultado, rec = self._aplica(ctrl)
        self.assertEqual(resultado, 1474)
        self.assertEqual(len(ctrl.updates), 1)
        conta_id, esperado, novo, notas = ctrl.updates[0]
        self.assertEqual((conta_id, esperado, novo), (1474, "2026-09-27", "2026-09-27"))
        self.assertFalse(R._has_presumed_due_marker(notas))
        self.assertIn(f"{R.DUE_DATE_REMINDER_NOTE}: 27/09/2026", notas)
        self.assertIn("1474", rec["notes"])
        # A garantia que a confirmação entrega: o lembrete de OUTRA fatura (27/10, ainda dentro
        # da janela da emissão) não move mais a 1474. Anti-vacuidade: com a marca de presumido
        # que ela tinha, moveria.
        outubro = "2026-10-27"
        self.assertEqual(R.select_reminder_target(
            [_conta(1474, "2026-09-14", "2026-09-27", notes=notas_136)], outubro)[0],
            R.REMINDER_UPDATE)
        self.assertEqual(R.select_reminder_target(
            [_conta(1474, "2026-09-14", "2026-09-27", notes=notas)], outubro)[0],
            R.REMINDER_NO_MATCH)

    def test_lembrete_repetido_de_data_ja_confirmada_nao_escreve(self):
        confirmada = R._notes_with_reminder_marker(PRESUMIDO, "2026-09-27")
        ctrl = _CtrlLembrete(contas=[_conta(1474, "2026-09-14", "2026-09-27", notes=confirmada)])
        self.assertIsNone(self._aplica(ctrl)[0])
        self.assertEqual(ctrl.updates, [])

    def test_remetente_sem_cadastro_nao_atualiza(self):
        ctrl = _CtrlLembrete(sk=None, contas=[_conta(1474, "2026-09-14", "2026-09-14")])
        self.assertIsNone(self._aplica(ctrl)[0])
        self.assertEqual(ctrl.updates, [])

    def test_ambiguo_avisa_e_nao_atualiza(self):
        ctrl = _CtrlLembrete(contas=[_conta(1, "2026-09-10", "2026-09-10"),
                                     _conta(2, "2026-09-12", "2026-09-12")])
        with self.assertLogs(R.log, level="WARNING"):
            self.assertIsNone(self._aplica(ctrl)[0])
        self.assertEqual(ctrl.updates, [])

    def test_escrita_recusada_nao_anota_o_email(self):
        ctrl = _CtrlLembrete(contas=[_conta(1474, "2026-09-14", "2026-09-14")], update_ok=False)
        resultado, rec = self._aplica(ctrl, {"notes": "original"})
        self.assertIsNone(resultado)
        self.assertEqual(rec["notes"], "original")

    def test_lista_indisponivel_nao_atualiza(self):
        ctrl = _CtrlLembrete(contas=None)
        self.assertIsNone(self._aplica(ctrl)[0])
        self.assertEqual(ctrl.updates, [])

    def test_excecao_e_logada_e_nao_propaga(self):
        ctrl = _CtrlLembrete(erro=RuntimeError("rede fora"))
        with self.assertLogs(R.log, level="ERROR"):
            self.assertIsNone(self._aplica(ctrl)[0])


class SupabaseControlLembreteTest(unittest.TestCase):

    def _ctrl(self, corpo):
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl.base, ctrl.key, ctrl.headers, ctrl._available = "https://x", "k", {}, True
        resposta = mock.MagicMock()
        resposta.read.return_value = json.dumps(corpo).encode()
        cm = mock.MagicMock()
        cm.__enter__.return_value = resposta
        return ctrl, mock.patch.object(R.urllib.request, "urlopen", return_value=cm)

    def test_lista_no_teto_e_recusada(self):
        linhas = [_conta(i, "2026-09-01", "2026-09-01") for i in range(R.REMINDER_CANDIDATES_LIMIT + 1)]
        ctrl, alvo = self._ctrl(linhas)
        with alvo as m, self.assertLogs(R.log, level="WARNING"):
            self.assertIsNone(ctrl.open_accounts_for_reminder(1369))
        url = m.call_args.args[0].full_url
        self.assertIn(f"limit={R.REMINDER_CANDIDATES_LIMIT + 1}", url)
        self.assertIn("status_id=in.(1,2,3)", url)

    def test_patch_que_nao_casa_linha_nao_e_sucesso(self):
        ctrl, alvo = self._ctrl([])
        with alvo as m:
            self.assertFalse(ctrl.update_due_date_from_reminder(1474, "2026-09-14",
                                                                "2026-09-27", "nota"))
        req = m.call_args.args[0]
        self.assertEqual(req.get_method(), "PATCH")
        self.assertIn("due_date=eq.2026-09-14", req.full_url)
        self.assertEqual(req.headers.get("Prefer"), "return=representation")

    def test_patch_de_uma_linha_e_sucesso(self):
        ctrl, alvo = self._ctrl([{"id": 1474}])
        with alvo:
            self.assertTrue(ctrl.update_due_date_from_reminder(1474, "2026-09-14",
                                                               "2026-09-27", "nota"))

    def test_sem_vencimento_esperado_nao_escreve(self):
        ctrl, alvo = self._ctrl([{"id": 1474}])
        with alvo as m:
            self.assertFalse(ctrl.update_due_date_from_reminder(1474, None, "2026-09-27", "n"))
        self.assertEqual(m.call_count, 0)


class ProcessMessageLembreteTest(unittest.TestCase):
    """EXECUTA `process_message` — o call site, não a função (CLAUDE.md §2)."""

    class _Ctrl(_CtrlLembrete):
        def __init__(self, **kw):
            super().__init__(**kw)
            self.registrados, self.erros = [], []

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
            meta = b'1 (INTERNALDATE "17-Aug-2026 18:00:29 +0000" RFC822 {1}'
            return "OK", [(meta, self._raw)]

    @staticmethod
    def _mensagem() -> bytes:
        from email.message import EmailMessage

        m = EmailMessage()
        m["Subject"] = "Leadster - Sua fatura vence em 10 dias"
        m["From"] = REMETENTE
        m["Message-ID"] = "<lembrete-leadster@local>"
        m.set_content(CORPO_10_DIAS)
        return m.as_bytes()

    def _roda(self, ctrl):
        with mock.patch.object(R, "save_attachments", lambda *a, **k: []), \
             mock.patch.object(R, "extract_pdf_links", lambda *a, **k: []), \
             mock.patch.object(R, "save_inline_images", lambda *a, **k: []), \
             mock.patch.object(R, "extract_and_store_accounts",
                               lambda *a, **k: ([], 0, False, False)), \
             mock.patch.object(R, "try_extract_from_body", lambda *a, **k: R.BODY_NONE), \
             mock.patch.object(R, "append_log_csv", lambda rec: None):
            return R.process_message(self._Mail(self._mensagem()), b"1", ["fatura"],
                                     False, False, ctrl)

    def test_lembrete_aplicado_atualiza_a_conta_e_nao_vai_para_erros(self):
        ctrl = self._Ctrl(contas=[_conta(1020, "2026-08-14", "2026-08-14")])
        rec = self._roda(ctrl)
        self.assertEqual(ctrl.updates[0][:3], (1020, "2026-08-14", "2026-08-27"))
        self.assertEqual(rec["status"], "ignorado", f"notes={rec.get('notes')!r}")
        self.assertEqual(ctrl.erros, [])

    def test_controle_sem_conta_elegivel_o_email_segue_o_fluxo_antigo(self):
        # Anti-vacuidade: o MESMO e-mail sem conta a corrigir não é 'ignorado' — prova que o
        # status do teste acima vem do lembrete aplicado, e não do assunto.
        ctrl = self._Ctrl(contas=[])
        rec = self._roda(ctrl)
        self.assertEqual(ctrl.updates, [])
        self.assertNotEqual(rec["status"], "ignorado")


if __name__ == "__main__":
    unittest.main()
