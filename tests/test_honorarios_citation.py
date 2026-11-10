"""E-mail que SEMPRE gera conta: cita honorarios ou vem do Dr. Ricardo (decisoes do usuario, 2026-11-05).

Caso real: e-mail 1720, "PAGAMENTO Honorarios 26/08/2026", R$ 450,00. A forma "p/ fornecedor
Wesley" nao identificava o credor, a conta nao foi gravada e o e-mail ficou 'ignorado', sem linha
em /erros. Os testes executam process_message e run_reader: a regra atravessa os filtros de assunto,
as guardas do corpo e a resolucao de fornecedor.
"""

import sys
import unittest
from email.message import EmailMessage
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(_ROOT / "scripts"))

import read_emails as R  # noqa: E402

SK_WESLEY = 1188
EMAIL_RICARDO = "ricardo.advogado@yahoo.com.br"
CHAIN_RICARDO = (f"De: JOSE RICARDO PRUDENTE <{EMAIL_RICARDO}>\r\n"
                 "Para: Bárbara <barbara@otimotex.com.br>\r\nAssunto: processo 4003656\r\n\r\n")
ROSE = "rose@otimotex.com.br"
CORPO_1720 = (
    "Boa tarde\r\n\r\nPfv pode fazer o pix  p/ fornecedor Wesley\r\n\r\n"
    "Ref .ao pagamento .dos  honorários dos serviços prestados  no dia   (26/08/2026 )  "
    "no valor de     (R$ 450 ,00   )\r\n\r\nsegue  a chave do pix    'wesley.paixao'\r\n\r\nObg!\r\n"
)
CORPO_SEM_CREDOR = "Favor pagar os honorários do processo. Valor: R$ 450,00\r\n"
# Corpos reais das contas 161, 166 e 182: sao honorarios confirmados, mas nao citam a palavra.
CORPOS_SEM_CITACAO = (
    "A   nota 244459  esta baixada  ref .a dev    nf .1737  , segue anexo  o comprovante da baixa",
    "Oi   barbara \r\n\r\nEsta dupl  foi baixada   pfv verificar",
    "Bom dia\r\n\r\nConforme informado  ontem este titulo  esta baixado \r\n\r\nPfv verificar",
)


class _Ctrl:
    def __init__(self, cadastro=None, grava=True, duplicata=None):
        self.contas, self.erros, self.registrados, self.anexos = [], [], [], []
        self.cadastro = {"Wesley": SK_WESLEY} if cadastro is None else cadastro
        self.grava, self.duplicata = grava, duplicata
        self.resolve_calls = []

    def register(self, rec):
        self.registrados.append(dict(rec))
        return True

    def delete_errors(self, *a):
        pass

    def register_error(self, rec, tipo, msg, raw_payload=None):
        self.erros.append((tipo, msg))
        return True

    def upload_attachment(self, path):
        return True

    def company_cnpj(self):
        return "47273917000123"

    def resolve_supplier(self, payload):
        # A RPC real recusa: remetente interno e nenhum outro identificador.
        self.resolve_calls.append(payload.get("supplier_name"))
        return None

    def find_supplier_by_email(self, email):
        return None

    def find_honorarios_supplier_by_name(self, name):
        return self.cadastro.get(name)

    def supplier_defaults(self, sk):
        return (1, 86) if sk == SK_WESLEY else (3, 11)

    def classification_for_account_code(self, code):
        return (0, 0)

    def update_supplier_classification(self, *a):
        pass

    def find_financial_duplicate(self, payload, skip_settled=False):
        return self.duplicata

    def update_financial(self, *a, **k):
        return True

    def unique_invoice_number(self, base):
        return base

    def register_financial(self, payload):
        if not self.grava:
            return None
        self.contas.append(R.strip_transient_fields(payload))
        return 9000 + len(self.contas)

    def register_attachment(self, account_id, file_name, size_bytes=0, uploaded_by=None):
        self.anexos.append((account_id, file_name))
        return True

    def resolve_user(self, email):
        return None


class _Mail:
    def __init__(self, raw):
        self._raw = raw

    def uid(self, cmd, uid, spec=None, flags=None):
        return "OK", [(b'1 (INTERNALDATE "26-Aug-2026 21:39:03 +0000" RFC822 {1}', self._raw)]


def _raw(subject, sender, corpo):
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["Message-ID"] = subject, sender, "<mid-hon@local>"
    msg.set_content(corpo)
    return msg.as_bytes()


def _processa(subject, sender, corpo, ctrl=None, anexos=(), linhas=()):
    ctrl = ctrl or _Ctrl()
    with mock.patch.object(R, "save_attachments", lambda *a, **k: list(anexos)), \
         mock.patch.object(R, "save_inline_images", lambda *a, **k: []), \
         mock.patch.object(R, "extract_pdf_links", lambda *a, **k: []), \
         mock.patch.object(R, "_attachment_text", lambda p: ""), \
         mock.patch.object(R, "_register_fiscal_documents", mock.MagicMock()), \
         mock.patch.object(R, "run_extraction", lambda p, pw=None: (str(p), None)), \
         mock.patch.object(R, "read_extracted_rows", lambda c: list(linhas)), \
         mock.patch.object(R, "append_log_csv", lambda rec: None):
        rec = R.process_message(_Mail(_raw(subject, sender, corpo)), b"1", ["pagamento"],
                                False, False, ctrl)
    return rec, ctrl


class FornecedorTest(unittest.TestCase):
    def test_1720_vira_conta_no_cadastro_nomeado_sem_auto_insert(self):
        rec, ctrl = _processa("PAGAMENTO   Honorários 26/08/2026", ROSE, CORPO_1720)
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r} erros={ctrl.erros}")
        conta = ctrl.contas[0]
        self.assertEqual(conta["sk_supplier"], SK_WESLEY)
        self.assertEqual(float(conta["amount"]), 450.00)
        self.assertEqual((conta["cost_center_id"], conta["chart_account_id"]), (1, 86))
        self.assertNotIn("Wesley", ctrl.resolve_calls, "o nome solto criaria cadastro duplicado")
        self.assertEqual(rec["status"], "recebido")

    def test_sem_cadastro_unico_fica_na_otimotex_sem_o_default_dela_e_com_nota(self):
        rec, ctrl = _processa("Honorários do processo", ROSE, CORPO_1720, ctrl=_Ctrl(cadastro={}))
        conta = ctrl.contas[0]
        self.assertEqual(conta["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertIn(R.HONORARIOS_SUPPLIER_NOTE, conta["processing_notes"])
        self.assertNotIn("chart_account_id", conta, "o default da OTIMOTEX erraria o plano")
        self.assertEqual(rec["status"], "recebido")

    def test_falha_da_rpc_nao_cai_na_otimotex(self):
        ctrl = _Ctrl(cadastro={})
        with mock.patch.object(ctrl, "resolve_supplier",
                               side_effect=R.SupplierResolutionError("22001")):
            rec, ctrl = _processa("Honorários", ROSE, CORPO_1720, ctrl=ctrl)
        self.assertEqual(ctrl.contas, [])
        self.assertEqual(rec["status"], "falha")
        self.assertTrue(ctrl.erros)

    def test_e_mail_sem_citacao_nao_recebe_o_fallback(self):
        corpo = "Pfv pode fazer o pix p/ fornecedor Wesley\r\nValor: R$ 450,00\r\n"
        rec, ctrl = _processa("PAGAMENTO", ROSE, corpo)
        self.assertEqual(ctrl.contas, [], f"notes={rec.get('notes')!r}")

    def test_assunto_livre_nao_vira_fornecedor_pelo_auto_insert(self):
        # 🔴 Sem keyword, este e-mail nem chegava aqui antes da regra: o nome iria a RPC.
        for subject in ("Reunião de sexta", "Honorários de outubro"):
            rec, ctrl = _processa(subject, ROSE, CORPO_SEM_CREDOR, ctrl=_Ctrl(cadastro={}))
            self.assertEqual(ctrl.contas[0]["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER, subject)
            self.assertEqual(ctrl.resolve_calls[0], None, f"{subject} foi a RPC como fornecedor")

    def test_nome_extraido_que_casa_cadastro_nao_vai_a_rpc(self):
        corpo = "Honorários do mês.\r\nFavorecido: Wesley\r\nValor: R$ 450,00\r\n"
        rec, ctrl = _processa("Honorários", ROSE, corpo)
        self.assertEqual(ctrl.contas[0]["sk_supplier"], SK_WESLEY)
        self.assertEqual(ctrl.resolve_calls, [])

    def test_cnpj_lido_vence_a_dica(self):
        corpo = CORPO_1720 + "CNPJ: 79.315.198/0001-52\r\n"
        rec, ctrl = _processa("Honorários", ROSE, corpo)
        self.assertEqual(ctrl.contas[0]["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(len(ctrl.resolve_calls), 1, "o CNPJ precisa ir a RPC")

    def test_sem_credor_nao_deduplica_por_valor_e_vencimento(self):
        # 🔴 Sob a OTIMOTEX, dois servicos de R$ 450 no mesmo dia colidiriam e um sumiria.
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl._available, ctrl.base, ctrl.headers = True, "http://x", {}
        urls = []

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return R.json.dumps([{"id": 1}]).encode()

        def urlopen(req, timeout=None):
            urls.append(req.full_url)
            return Resp()

        base = {"sk_supplier": 1, "amount": 450.0, "due_date": "2026-08-26"}
        with mock.patch("urllib.request.urlopen", urlopen):
            self.assertIsNone(ctrl.find_financial_duplicate({**base, R.SUPPLIER_UNIDENTIFIED_KEY: True}))
            self.assertEqual(ctrl.find_financial_duplicate(base)["id"], 1, "anti-vacuidade")

    def test_dica_da_cadeia_encaminhada_nao_identifica(self):
        corpo = CORPO_SEM_CREDOR + "\r\nDe: X <x@y.com.br>\r\nAssunto: p\r\n\r\np/ fornecedor Wesley\r\n"
        self.assertIsNone(R._honorarios_supplier_from_hint(_Ctrl(), corpo))


class GuardasDoCorpoTest(unittest.TestCase):
    def test_cliente_citando_honorarios_na_conversa_da_cobranca_gera_conta(self):
        corpo = "Segue honorários. Favorecido: Wesley S. Paixao\r\nValor: R$ 855,40\r\n"
        ctrl = _Ctrl()
        with mock.patch.object(ctrl, "resolve_supplier", return_value=SK_WESLEY):
            rec, ctrl = _processa("Re: COBRANÇA OTIMOTEX TECIDO", "financeiro@cliente.com.br",
                                  corpo, ctrl=ctrl)
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r}")

    def test_comprovante_e_confirmacao_encaminhada_nao_barram(self):
        for corpo in ("Pagamento confirmado dos honorários. Valor: R$ 450,00\r\n",
                      CORPO_1720 + "\r\nDe: B <b@b.com.br>\r\nAssunto: Confirmação de pagamento\r\n"):
            rec, ctrl = _processa("Honorários", ROSE, corpo)
            self.assertEqual(len(ctrl.contas), 1, f"{corpo[:30]!r} notes={rec.get('notes')!r}")

    def test_contexto_de_transporte_nao_barra(self):
        rec, ctrl = _processa("Honorários transporte CT-e", ROSE, CORPO_1720)
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r}")


class DeadManSwitchTest(unittest.TestCase):
    def test_citacao_sem_valor_vira_falha_com_erro_e_nunca_ignorado(self):
        rec, ctrl = _processa("Honorários", ROSE, "Segue a relação dos honorários.\r\n")
        self.assertEqual(ctrl.contas, [])
        self.assertEqual(rec["status"], "falha")
        self.assertEqual(len(ctrl.erros), 1)
        self.assertIn("Honorários", rec["notes"])

    def test_gravacao_recusada_tambem_acusa(self):
        rec, ctrl = _processa("Honorários", ROSE, CORPO_1720, ctrl=_Ctrl(grava=False))
        self.assertEqual(rec["status"], "falha")
        self.assertEqual(len(ctrl.erros), 1)

    def test_duplicata_nao_e_falha(self):
        rec, ctrl = _processa("Honorários", ROSE, CORPO_1720, ctrl=_Ctrl(duplicata={"id": 1532}))
        self.assertEqual(rec["status"], "duplicidade")
        self.assertEqual(ctrl.erros, [])

    def test_pedido_com_anexo_que_nao_gera_conta_registra_um_erro_so(self):
        pedido = "Por gentileza fazer o pagamento dos honorários.\r\nValor: R$ 450,00\r\n"
        linha = {"source_file": "r.pdf", "document_type": "recibo", "amount": "450.00"}
        rec, ctrl = _processa("Honorários", ROSE, pedido, ctrl=_Ctrl(grava=False),
                              anexos=[Path("r.pdf")], linhas=[linha])
        self.assertEqual(rec["status"], "falha")
        self.assertEqual(len(ctrl.erros), 1)


class CharsetTest(unittest.TestCase):
    def _corpo(self, charset, conteudo):
        header = "Content-Type: text/plain" + (f"; charset={charset}" if charset else "")
        return R._effective_body_text(R.email.message_from_bytes(
            f"Subject: x\r\n{header}\r\n\r\n".encode() + conteudo))

    def test_latin1_sem_charset_ou_com_charset_errado_e_lido(self):
        for charset in (None, "utf-8", "charset-inexistente"):
            corpo = self._corpo(charset, "honorários".encode("latin-1"))
            self.assertEqual(corpo, "honorários", charset)
            self.assertTrue(R._cites_honorarios(corpo), charset)

    def test_utf8_e_latin1_declarados_nao_mudam(self):
        self.assertEqual(self._corpo("utf-8", "honorários".encode()), "honorários")
        self.assertEqual(self._corpo("iso-8859-1", "honorários".encode("latin-1")), "honorários")


class _CtrlRicardo(_Ctrl):
    def find_supplier_by_email(self, email):
        return 1262 if email == EMAIL_RICARDO else None

    def resolve_user(self, email):
        return None


class ReembolsoSempreGeraContaTest(unittest.TestCase):
    """Sem citar honorarios: o que obriga a conta e o Dr. Ricardo na cadeia ou como remetente."""

    LINHA = {"source_file": "r.pdf", "document_type": "recibo", "amount": "38.42",
             "supplier_name": "Tribunal"}

    def _roda(self, subject, linha=None, corpo=None, sender="barbara@otimotex.com.br"):
        corpo = CHAIN_RICARDO if corpo is None else corpo
        anexos, linhas = ([Path("r.pdf")], [linha]) if linha else ((), ())
        return _processa(subject, sender, corpo, ctrl=_CtrlRicardo(), anexos=anexos, linhas=linhas)

    def test_contexto_de_seguro_ou_transporte_nao_descarta_a_linha(self):
        for subject in ("Custas processo Porto Seguro", "Custas acao transporte"):
            rec, ctrl = self._roda(subject, linha=self.LINHA)
            self.assertEqual(len(ctrl.contas), 1, f"{subject} notes={rec.get('notes')!r}")
            self.assertEqual(ctrl.contas[0]["sk_supplier"], 1262)
            self.assertEqual(rec["status"], "extraído")

    def test_documento_fiscal_nao_descarta_a_linha(self):
        rec, ctrl = self._roda("boleto 123", linha={**self.LINHA, "document_type": "nfse"})
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r}")

    def test_assunto_da_conversa_da_cobranca_nao_descarta(self):
        rec, ctrl = self._roda("RES: COBRANÇA OTIMOTEX TECIDO", linha=self.LINHA)
        self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r}")

    def test_corpo_com_guarda_de_nao_pagavel_grava(self):
        for corpo in (CHAIN_RICARDO + "Pagamento confirmado. Valor: R$ 38,42\r\n",
                      "Valor: R$ 38,42\r\n" + CHAIN_RICARDO
                      + "\r\nDe: B <b@b.com.br>\r\nAssunto: Confirmação de pagamento\r\n"):
            rec, ctrl = self._roda("assunto qualquer", corpo=corpo)
            self.assertEqual(len(ctrl.contas), 1, f"notes={rec.get('notes')!r}")

    def test_remetente_imediato_conta_como_cadeia(self):
        rec, ctrl = self._roda("oi", corpo="Segue. Valor: R$ 38,42\r\n", sender=EMAIL_RICARDO)
        self.assertEqual(ctrl.contas[0]["sk_supplier"], 1262)
        self.assertEqual(rec["keyword_matched"], R.REEMBOLSO_KEYWORD)

    def test_sem_valor_vira_falha_e_nunca_ignorado(self):
        rec, ctrl = self._roda("Lembrete do processo")
        self.assertEqual(ctrl.contas, [])
        self.assertEqual(rec["status"], "falha")
        self.assertEqual(len(ctrl.erros), 1)

    def test_script_sem_a_marca_da_conversa_tambem_nao_descarta_pelo_assunto(self):
        # reprocess_link e retry entram direto, sem _OWN_THREAD_CLEARED_KEY.
        ctrl = _CtrlRicardo()
        with mock.patch.object(R, "_attachment_text", lambda p: ""), \
             mock.patch.object(R, "_register_fiscal_documents", mock.MagicMock()), \
             mock.patch.object(R, "run_extraction", lambda p, pw=None: (str(p), None)), \
             mock.patch.object(R, "read_extracted_rows", lambda c: [self.LINHA]):
            R.extract_and_store_accounts(
                [Path("r.pdf")], "<m>", ctrl, body_text=CHAIN_RICARDO,
                email_rec={"sender_email": "barbara@otimotex.com.br",
                           "subject": "RES: COBRANÇA OTIMOTEX TECIDO"})
        self.assertEqual(len(ctrl.contas), 1)

    def test_outro_remetente_sem_citacao_continua_descartado(self):
        # Anti-vacuidade: a linha so se salva pela regra.
        rec, ctrl = _processa("Custas processo Porto Seguro", "barbara@otimotex.com.br",
                              "Segue.\r\n", ctrl=_CtrlRicardo(),
                              anexos=[Path("r.pdf")], linhas=[self.LINHA])
        self.assertEqual(ctrl.contas, [], f"notes={rec.get('notes')!r}")


class SemCitacaoTest(unittest.TestCase):
    def test_e_mails_das_contas_161_166_182_nao_citam_e_seguem_ignorados(self):
        # 🔴 As contas ficam: sao honorarios confirmados. Um reprocesso nao as recriaria.
        for corpo in CORPOS_SEM_CITACAO:
            self.assertIsNotNone(R.own_collection_ignore_reason(
                "RES: Cobranças não enviadas — ação necessária (1 título)", ROSE, corpo))


def _header(uid, subject, sender):
    raw = (f"Subject: {subject}\r\nMessage-ID: <mid-{uid.decode()}>\r\nFrom: {sender}\r\n"
           "Date: Wed, 28 Oct 2026 19:28:00 -0300\r\n\r\n").encode("utf-8")
    return ("OK", [(uid + b' (INTERNALDATE "28-Oct-2026 19:28:00 -0300" BODY[HEADER])', raw)])


class RunReaderTest(unittest.TestCase):
    def _run(self, subject, sender, corpo="Sem nada.\r\n", corpo_falha=False):
        fetches = []
        corpo_bruto = _raw(subject, sender, corpo)

        class Mail:
            def uid(self, cmd, uid, spec=None, *a):
                fetches.append(spec)
                if spec == "(BODY.PEEK[])":
                    if corpo_falha:
                        raise OSError("conexao perdida")
                    return "OK", [(b"1 (BODY[] {1}", corpo_bruto)]
                return _header(uid, subject, sender)

            def logout(self):
                pass

        ctrl = mock.MagicMock()
        ctrl._available = True
        ctrl.load_known_ids.return_value = {"<ja>"}
        process = mock.MagicMock()
        with mock.patch.dict("os.environ", {"EMAIL_KEYWORDS": "pagamento"}), \
             mock.patch.object(R, "_connect_and_search", return_value=(Mail(), [b"1"])), \
             mock.patch.object(R, "SupabaseControl", return_value=ctrl), \
             mock.patch.object(R, "process_message", process):
            R.run_reader(days=1)
        return ctrl, process, fetches

    def test_sem_keyword_mas_corpo_cita_segue(self):
        _, process, fetches = self._run("Reuniao de sexta", ROSE, "Falta pagar os honorários.\r\n")
        process.assert_called_once()
        self.assertIn("(BODY.PEEK[])", fetches)

    def test_sem_keyword_sem_citacao_continua_ignorado(self):
        ctrl, process, _ = self._run("Reuniao de sexta", ROSE)
        process.assert_not_called()
        self.assertEqual(ctrl.register.call_args.args[0]["status"], "ignorado")

    def test_assunto_cita_nao_precisa_baixar_o_corpo(self):
        _, process, fetches = self._run("Honorários de outubro", ROSE)
        process.assert_called_once()
        self.assertNotIn("(BODY.PEEK[])", fetches)

    def test_lembrete_confirmacao_e_cliente_citando_seguem(self):
        for subject, sender in (("Lembrete de pagamento", ROSE),
                                ("Comprovante de pagamento", ROSE),
                                ("Re: COBRANCA OTIMOTEX TECIDO", "x@cliente.com.br")):
            _, process, _ = self._run(subject, sender, "Honorários em aberto.\r\n")
            process.assert_called_once()

    def test_dr_ricardo_sem_keyword_segue_sem_baixar_quando_e_o_remetente(self):
        _, process, fetches = self._run("Reuniao de sexta", EMAIL_RICARDO)
        process.assert_called_once()
        self.assertNotIn("(BODY.PEEK[])", fetches)

    def test_dr_ricardo_so_na_cadeia_precisa_do_corpo_e_segue(self):
        _, process, fetches = self._run("Reuniao de sexta", ROSE, CHAIN_RICARDO)
        process.assert_called_once()
        self.assertIn("(BODY.PEEK[])", fetches)

    def test_dr_ricardo_em_lembrete_e_confirmacao_segue(self):
        for subject in ("Lembrete de pagamento", "Comprovante de pagamento",
                        "Re: COBRANCA OTIMOTEX TECIDO"):
            _, process, _ = self._run(subject, EMAIL_RICARDO)
            process.assert_called_once()

    def test_remetente_de_sistema_continua_barrado(self):
        ctrl, process, _ = self._run("Honorários de outubro", "postmaster@x.com.br", CHAIN_RICARDO)
        process.assert_not_called()
        self.assertEqual(ctrl.register.call_args.args[0]["status"], "ignorado")

    def test_com_keyword_nao_baixa_o_corpo_duas_vezes(self):
        _, process, fetches = self._run("PAGAMENTO FORNECEDOR", ROSE)
        process.assert_called_once()
        self.assertNotIn("(BODY.PEEK[])", fetches)

    def test_falha_de_imap_nao_registra_ignorado(self):
        # 🔴 Registrar tiraria o e-mail da fila para sempre: ele precisa voltar no proximo run.
        ctrl, process, _ = self._run("Reuniao de sexta", ROSE, corpo_falha=True)
        process.assert_not_called()
        ctrl.register.assert_not_called()


class NomePorPrefixoTest(unittest.TestCase):
    def _busca(self, nome, candidatos=(), historico=(), erro=None):
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl._available, ctrl.base, ctrl.headers = True, "http://x", {}
        urls = []

        class Resp:
            def __init__(self, sks):
                self.sks = sks

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return R.json.dumps([{"sk_supplier": sk} for sk in self.sks]).encode()

        def urlopen(req, timeout=None):
            urls.append(req.full_url)
            self.assertEqual(timeout, 10)
            if erro:
                raise erro
            return Resp(candidatos if "/supplier?" in req.full_url else historico)

        with mock.patch("urllib.request.urlopen", urlopen):
            return ctrl.find_honorarios_supplier_by_name(nome), urls

    def test_unico_devolve_sem_consultar_historico(self):
        sk, urls = self._busca("Wesley", [SK_WESLEY])
        self.assertEqual(sk, SK_WESLEY)
        self.assertEqual(len(urls), 1)
        self.assertIn("deleted_at=is.null", urls[0])
        self.assertIn("legal_name.ilike.Wesley*", urls[0])

    def test_homonimos_decidem_pelo_historico_de_honorarios(self):
        # Caso real: consultor (sk 1188) e funcionario (sk 1352). Varias contas do mesmo: 1 so.
        sk, urls = self._busca("Wesley", [SK_WESLEY, 1352], [SK_WESLEY, SK_WESLEY])
        self.assertEqual(sk, SK_WESLEY)
        self.assertIn("document_type=eq.honor%C3%A1rios", urls[1])
        self.assertIn(f"sk_supplier=in.({SK_WESLEY},1352)", urls[1])

    def test_empate_ou_nenhum_historico_nao_atribuem(self):
        self.assertIsNone(self._busca("Silva", [1, 2], [1, 2])[0])
        self.assertIsNone(self._busca("Silva", [1, 2], [])[0])

    def test_acima_do_teto_nao_atribui_nem_consulta_historico(self):
        sk, urls = self._busca("Silva", list(range(1, R._HONORARIOS_MAX_CANDIDATES + 2)), [1])
        self.assertIsNone(sk)
        self.assertEqual(len(urls), 1)

    def test_falha_de_rede_nao_atribui(self):
        self.assertIsNone(self._busca("Wesley", erro=OSError("rede"))[0])

    def test_caractere_de_filtro_nao_chega_a_consulta(self):
        for nome in ("a,b.eq.1", "x)", "ab", None, "*"):
            sk, urls = self._busca(nome, [1])
            self.assertIsNone(sk, nome)
            self.assertEqual(urls, [], nome)


class ScriptsTest(unittest.TestCase):
    def test_reprocess_link_entrega_o_corpo_gravado(self):
        import reprocess_link_emails as S
        ec = {"id": 1, "message_id": "<m>", "received_at": "2026-11-03T13:00:00+00:00",
              "body_full": "De: X <x@y.com.br>\r\n"}
        with mock.patch.object(S.R, "extract_and_store_accounts",
                               return_value=([], 0, False, False)) as extrai:
            S._store_pdf("a.pdf", ec, mock.MagicMock())
        self.assertEqual(extrai.call_args.kwargs["body_text"], ec["body_full"])

    def test_retry_extraction_pede_e_entrega_o_corpo_gravado(self):
        fonte = (_ROOT / "scripts/retry_extraction.py").read_text(encoding="utf-8")
        self.assertEqual(fonte.count("body_text="), 2)
        self.assertEqual(fonte.count("attachment_names,body_full"), 1)
        self.assertEqual(fonte.count("attachment_names,subject,body_full"), 1)


if __name__ == "__main__":
    unittest.main()
