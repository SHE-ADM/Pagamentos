"""
Regra ALURA: o e-mail mensal (NF de produto + NF de servico) gera 2 contas ja pagas.

Caso de origem: e-mails 3791/3792 (o MESMO e-mail enviado 2x em 2 s por ricardo@sheild.com.br,
`ENC: Fatura Alura`), ambos 'ignorado'. Os textos abaixo sao trechos REAIS do DANFE 000.844.902 e da
NFS-e 00991049 (enderecos e e-mails de contato removidos).

Os testes de integracao executam `process_message` (o call site de topo) — nao so o helper puro —
porque o que decide o status do e-mail e a ORDEM entre o descarte das NFs puras, o fallback do corpo
e esta regra.
"""

import sys
import tempfile
import unittest
from datetime import date
from email.message import EmailMessage
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))

import alura_fiscal as A  # noqa: E402
import read_emails as R  # noqa: E402

DANFE_TEXT = (
    "RECEBEMOS DE AOVS SISTEMAS DE INFORMATICA S.A. OS PRODUTOS/SERVIÇOS CONSTANTES NA NOTA FISCAL "
    "INDICADA AO LADO EMISSÃO: 16/11/2026 NF-e\n"
    "Nº:000.844.902\n"
    "TEXTIL E CONFECCOES OTIMOTEX LTDA SÉRIE: 10\n"
    "AOVS SISTEMAS DE INFORMATICA S.A. DANFE\n"
    "CHAVE DE ACESSO\n"
    "3526 1105 5553 8200 0133 5501 0000 8449 0211 0051 6778\n"
    "CNPJ\n"
    "144873428117 05.555.382/0001-33\n"
    "NOME/RAZÃO SOCIAL CNPJ/CPF DATA DA EMISSÃO\n"
    "TEXTIL E CONFECCOES OTIMOTEX LTDA 47.273.917/0001-23 16/11/2026\n"
    "VALOR DO FRETE VALOR DO SEGURO DESCONTO OUTRAS DESPESAS ACESSÓRIAS VALOR DO IPI "
    "VALOR APROX. DOS TRIBUTOS VALOR TOTAL DA NOTA\n"
    "0,00 0,00 0,00 0,00 0,00 0,00 279,00\n"
)

NFSE_TEXT = (
    "Número da Nota\n"
    "PREFEITURA DO MUNICÍPIO DE SÃO PAULO\n"
    "00991049\n"
    "SECRETARIA MUNICIPAL DA FAZENDA Data e Hora de Emissão\n"
    "16/11/2026 14:19:36\n"
    "NOTA FISCAL ELETRÔNICA DE SERVIÇOS - NFS-e\n"
    "PRESTADOR DE SERVIÇOS\n"
    "CPF/CNPJ: 05.555.382/0001-33 Inscrição Municipal:3.212.975-0\n"
    "Nome/Razão Social: AOVS SISTEMAS DE INFORMATICA S.A.\n"
    "TOMADOR DE SERVIÇOS\n"
    "Nome/Razão Social: TEXTIL E CONFECCOES OTIMOTEX LTDA\n"
    "CPF/CNPJ: 47.273.917/0001-23 Inscrição Municipal:8.263.404-1\n"
    "DISCRIMINAÇÃO DE SERVIÇOS\n"
    "Acesso a Plataforma Alura. Cursos de Tecnologia e Inovação.\n"
    "VALOR TOTAL DO SERVIÇO = R$ 31,00\n"
)

NFSE_PAGE_URL = ("https://nfe.prefeitura.sp.gov.br/contribuinte/notaprint.aspx"
                 "?inscricao=32129750&nf=991049&verificacao=KLHGLXXS")
NFSE_PDF_URL = ("https://nfe.prefeitura.sp.gov.br/contribuinte/notaprintpdf.aspx"
                "?inscricao=32129750&nf=991049&verificacao=KLHGLXXS")
BODY = (
    "De: Não Responda (naoresponda@alura.com.br) <system@sent-via.netsuite.com> \r\n"
    "Enviada em: terça-feira, 17 de novembro de 2026 13:35\r\n"
    "Assunto: Fatura Alura\r\n\r\n"
    "A Fatura referente os cursos contratados na plataforma Alura está disponível.\r\n\r\n"
    f"NF de serviço: 991049 <{NFSE_PAGE_URL}> \r\n"
    "NF de produto: 844902 <https://5719548.extforms.netsuite.com/app/site/hosting/scriptlet.nl"
    "?script=353&type=nfe&action=pdf> \r\n"
)

SENDER = "ricardo@sheild.com.br"
SUBJECT = "ENC: Fatura Alura"
MESSAGE_ID = "<027701dd7b31$31c71ed0$95555c70$@sheild.com.br>"
SK_ALURA = 1491
REF = date(2026, 11, 23)


class ParseEmailTest(unittest.TestCase):
    def test_sanidade_do_parser_caso_real(self):
        # 🔴 Sem esta, um regex que para de casar tornaria todo negativo abaixo verde por vacuidade.
        info = A.parse_email(BODY)
        self.assertEqual(info["nfse_number"], "991049")
        self.assertEqual(info["nfe_number"], "844902")
        self.assertEqual(info["nfse_url"], NFSE_PAGE_URL)

    def test_exige_remetente_original_da_alura(self):
        self.assertIsNone(A.parse_email(BODY.replace("alura.com.br", "outro.com.br")))

    def test_exige_os_dois_rotulos(self):
        self.assertIsNone(A.parse_email(BODY.replace("NF de produto", "NF de coisa")))
        self.assertIsNone(A.parse_email(BODY.replace("NF de serviço", "NF de coisa")))

    def test_sem_link_da_nfse_devolve_url_none(self):
        info = A.parse_email(BODY.replace(f"<{NFSE_PAGE_URL}>", ""))
        self.assertIsNotNone(info)
        self.assertIsNone(info["nfse_url"])

    def test_vazio_e_none(self):
        self.assertIsNone(A.parse_email(""))
        self.assertIsNone(A.parse_email(None))


class SenderAuthorizedTest(unittest.TestCase):
    def test_cadastrado_e_dominio_da_alura(self):
        self.assertTrue(A.sender_is_authorized(SENDER, ["financeiro@alura.com.br", SENDER]))
        self.assertTrue(A.sender_is_authorized("x@alura.com.br", []))
        self.assertTrue(A.sender_is_authorized("RICARDO@Sheild.com.br ", [SENDER]))

    def test_negativos(self):
        self.assertFalse(A.sender_is_authorized("estranho@gmail.com", [SENDER]))
        self.assertFalse(A.sender_is_authorized("x@alura.com.br.evil.com", [SENDER]))
        self.assertFalse(A.sender_is_authorized(None, [SENDER]))
        self.assertFalse(A.sender_is_authorized("", [SENDER]))
        self.assertFalse(A.sender_is_authorized(SENDER, None))


class NfsePdfUrlTest(unittest.TestCase):
    def test_reconstroi_a_url_do_pdf(self):
        self.assertEqual(A.nfse_pdf_url(NFSE_PAGE_URL), NFSE_PDF_URL)

    def test_barra_destino_e_formato_inesperados(self):
        for bad in (
            NFSE_PAGE_URL.replace("https://", "http://"),
            NFSE_PAGE_URL.replace("nfe.prefeitura.sp.gov.br", "evil.com"),
            "https://nfe.prefeitura.sp.gov.br@evil.com/contribuinte/notaprint.aspx?inscricao=1&nf=2&verificacao=A",
            NFSE_PAGE_URL.replace("notaprint.aspx", "outra.aspx"),
            NFSE_PAGE_URL.replace("&verificacao=KLHGLXXS", ""),
            NFSE_PAGE_URL.replace("KLHGLXXS", "A%26x%3D1"),
            "", None,
        ):
            self.assertIsNone(A.nfse_pdf_url(bad), bad)


class ParseDanfeTest(unittest.TestCase):
    def test_caso_real(self):
        doc = A.parse_danfe(DANFE_TEXT, REF)
        self.assertEqual(doc["invoice_number"], "000.844.902")
        self.assertEqual(doc["amount"], "279.00")
        self.assertEqual(doc["issue_date"], "2026-11-16")
        self.assertEqual(doc["payer_cnpj"], "47273917000123")

    def test_chave_valida_de_outro_emitente_nao_e_da_alura(self):
        # Chave com DV CORRETO mas emitida por outro CNPJ: so a conferencia do emitente a barra.
        base = "3526110111111111000155010000084490211005167"      # 43 digitos, CNPJ 11.111.111/0001-55
        key = next(base + str(dv) for dv in range(10)
                   if A.fiscal_key.access_key_dv_ok(base + str(dv)))
        self.assertIsNotNone(A.fiscal_key.parse_access_key(key), "pre-condicao: a chave e valida")
        text = DANFE_TEXT.replace("3526 1105 5553 8200 0133 5501 0000 8449 0211 0051 6778", key)
        self.assertIsNone(A.parse_danfe(text, REF))

    def test_chave_corrompida_nao_passa(self):
        self.assertIsNone(A.parse_danfe(DANFE_TEXT.replace("0051 6778", "0051 6779"), REF))

    def test_sem_valor_total(self):
        self.assertIsNone(A.parse_danfe(DANFE_TEXT.replace("0,00 279,00", "0,00 0,00"), REF))

    def test_emissao_fora_do_mes_da_chave(self):
        self.assertIsNone(A.parse_danfe(DANFE_TEXT.replace("EMISSÃO: 16/11/2026", "EMISSÃO: 16/10/2026"), REF))

    def test_emissao_futura(self):
        self.assertIsNone(A.parse_danfe(DANFE_TEXT, date(2026, 11, 10)))

    def test_vazio(self):
        self.assertIsNone(A.parse_danfe("", REF))
        self.assertIsNone(A.parse_danfe(None, REF))


class ParseNfseTest(unittest.TestCase):
    def test_caso_real(self):
        doc = A.parse_nfse(NFSE_TEXT, "991049", REF)
        self.assertEqual(doc["invoice_number"], "00991049")
        self.assertEqual(doc["amount"], "31.00")
        self.assertEqual(doc["issue_date"], "2026-11-16")
        self.assertEqual(doc["payer_cnpj"], "47273917000123")
        self.assertEqual(doc["description"], "Acesso a Plataforma Alura. Cursos de Tecnologia e Inovação.")

    def test_numero_diferente_do_do_email(self):
        self.assertIsNone(A.parse_nfse(NFSE_TEXT, "991050", REF))

    def test_prestador_que_nao_e_a_alura(self):
        self.assertIsNone(A.parse_nfse(NFSE_TEXT.replace("05.555.382/0001-33", "11.111.111/0001-11"),
                                       "991049", REF))

    def test_sem_valor_ou_valor_zero(self):
        self.assertIsNone(A.parse_nfse(NFSE_TEXT.replace("R$ 31,00", "R$ 0,00"), "991049", REF))
        self.assertIsNone(A.parse_nfse(NFSE_TEXT.replace("VALOR TOTAL DO SERVIÇO", "OUTRO"), "991049", REF))

    def test_descricao_com_acento_corrompido_nao_e_gravada(self):
        doc = A.parse_nfse(NFSE_TEXT.replace("Inovação", "Inova��o"), "991049", REF)
        self.assertIsNone(doc["description"])


# ---------------------------------------------------------------------------
# Integracao — process_message
# ---------------------------------------------------------------------------
class _Ctrl:
    def __init__(self, existing=None, supplier=None, dup_fails=False, grava=True):
        self.supplier = ({"sk_supplier": SK_ALURA, "emails": ["financeiro@alura.com.br", SENDER]}
                         if supplier is None else (supplier or None))
        self.existing = existing or {}        # document_type -> {"id": n}
        self.dup_fails, self.grava = dup_fails, grava
        self.contas, self.anexos, self.erros, self.uploads, self.lookups = [], [], [], [], []
        self.registered = []

    def company_cnpj(self):
        return "47273917000123"

    def find_supplier_by_cnpj(self, cnpj):
        self.lookups.append(cnpj)
        return self.supplier

    def find_account_by_document(self, sk, document_type, numbers):
        if self.dup_fails:
            raise RuntimeError("consulta de duplicidade falhou")
        return self.existing.get(document_type)

    def supplier_defaults(self, sk):
        return (8, 496)

    def find_supplier_by_email(self, email):
        return None

    def find_financial_duplicate(self, payload, skip_settled=False):
        return None

    def register_financial(self, payload):
        if not self.grava:
            return None
        self.contas.append(R.strip_transient_fields(payload))
        return 5000 + len(self.contas)

    def upload_attachment(self, pdf_path):
        self.uploads.append(Path(pdf_path).name)
        return True

    def register_attachment(self, account_id, file_name, size_bytes=0, uploaded_by=None):
        self.anexos.append((account_id, file_name))
        return True

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.erros.append((error_type, error_message))
        return True

    def resolve_user(self, email):
        return None

    def register(self, rec):
        self.registered.append(dict(rec))
        return True

    def has_error(self, *a):
        return False

    def delete_errors(self, *a):
        pass

    def unique_invoice_number(self, base):
        return base

    def update_financial(self, *a, **k):
        return True


class _Mail:
    def __init__(self, raw):
        self._raw = raw

    def uid(self, cmd, uid, spec=None, flags=None):
        return "OK", [(b'1 (INTERNALDATE "23-Nov-2026 09:58:32 +0000" RFC822 {1}', self._raw)]


def _raw(subject=SUBJECT, sender=SENDER, corpo=BODY):
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["Message-ID"] = subject, sender, MESSAGE_ID
    msg["Date"] = "Mon, 23 Nov 2026 09:58:32 +0000"
    msg.set_content(corpo)
    return msg.as_bytes()


def _processa(ctrl=None, corpo=BODY, sender=SENDER, nfse_ok=True, danfe_ok=True, subject=SUBJECT):
    """process_message do e-mail real, com a REDE e os PDFs simulados.

    Os dois PDFs de link sao o MESMO DANFE (como no caso real: mesmo SHA-256); a linha extraida
    pelo pipeline e 'nfe', que o Passo 2 descarta — exatamente o estado que a regra encontra."""
    ctrl = ctrl or _Ctrl()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        danfe_pdf = tmp_dir / "ricardo_ENC_Fatura_Alura_20261123_link.pdf"
        danfe_pdf.write_bytes(b"%PDF-1.7 danfe")
        text_by_name = {danfe_pdf.name: DANFE_TEXT if danfe_ok else "sem texto fiscal"}

        def attachment_text(path):
            name = Path(path).name
            if name.startswith("alura_nfse_"):
                return NFSE_TEXT
            return text_by_name.get(name, "")

        fetched = []

        def fetch_url(url, timeout=30, opener=None):
            fetched.append(url)
            return (b"%PDF-1.7 nfse", "application/pdf", url) if nfse_ok else None

        row = {"source_file": danfe_pdf.name, "document_type": "nfe", "amount": "279.00",
               "invoice_number": "000.844.902", "supplier_name": "AOVS SISTEMAS DE INFORMATICA S.A.",
               "extraction_source": "pdf_text"}
        with mock.patch.object(R, "save_attachments", lambda *a, **k: [danfe_pdf]), \
             mock.patch.object(R, "save_inline_images", lambda *a, **k: []), \
             mock.patch.object(R, "_attachment_text", attachment_text), \
             mock.patch.object(R, "_register_fiscal_documents", mock.MagicMock()), \
             mock.patch.object(R, "run_extraction", lambda p, pw=None: (str(p), None)), \
             mock.patch.object(R, "read_extracted_rows", lambda c: [dict(row)]), \
             mock.patch.object(R, "append_log_csv", lambda rec: None), \
             mock.patch.object(R, "_fetch_url", fetch_url), \
             mock.patch.object(R, "PDF_INBOX", tmp_dir), \
             mock.patch.object(R.time, "sleep", lambda s: None):
            rec = R.process_message(_Mail(_raw(subject=subject, corpo=corpo, sender=sender)), b"1",
                                    ["fatura", "nf-e"],
                                    False, False, ctrl)
    return rec, ctrl, fetched


class DoisEmailsTest(unittest.TestCase):
    def test_gera_duas_contas_pagas_no_fornecedor_alura(self):
        rec, ctrl, fetched = _processa()
        self.assertEqual(len(ctrl.contas), 2, f"notes={rec.get('notes')!r} erros={ctrl.erros}")
        nfe, nfse = ctrl.contas
        for conta in ctrl.contas:
            self.assertEqual(conta["sk_supplier"], SK_ALURA)
            self.assertEqual((conta["cost_center_id"], conta["chart_account_id"]), (8, 496))
            self.assertEqual(conta["status"], "pago")
            self.assertEqual(conta["payment_date"], "2026-11-16")
            self.assertEqual(conta["due_date"], "2026-11-16")
            self.assertNotIn("supplier_name", conta)
            self.assertIn(A.RULE_NOTE, conta["processing_notes"])
        self.assertEqual((nfe["document_type"], nfe["invoice_number"], nfe["amount"]),
                         ("nfe", "000.844.902", 279.0))
        self.assertEqual((nfse["document_type"], nfse["invoice_number"], nfse["amount"]),
                         ("nfse", "00991049", 31.0))
        self.assertEqual(nfe["gmail_message_id"], MESSAGE_ID)
        self.assertEqual(nfse["gmail_message_id"], f"{MESSAGE_ID}#1")
        self.assertEqual(rec["status"], "extraído")
        self.assertEqual(fetched, [NFSE_PDF_URL])

    def test_anexos_vinculados_e_nfse_publicada_no_storage(self):
        _, ctrl, _ = _processa()
        self.assertEqual(ctrl.anexos, [(5001, "ricardo_ENC_Fatura_Alura_20261123_link.pdf"),
                                       (5002, "alura_nfse_991049.pdf")])
        self.assertEqual(ctrl.uploads, ["ricardo_ENC_Fatura_Alura_20261123_link.pdf", "alura_nfse_991049.pdf"])

    def test_email_repetido_nao_gera_contas_novas_e_vira_duplicidade(self):
        # O 2o envio (Message-ID diferente) acha as duas notas ja registradas.
        ctrl = _Ctrl(existing={"nfe": {"id": 7001}, "nfse": {"id": 7002}})
        rec, ctrl, _ = _processa(ctrl=ctrl)
        self.assertEqual(ctrl.contas, [])
        self.assertEqual(rec["status"], "duplicidade")
        self.assertEqual(ctrl.erros, [])

    def test_reenvio_com_assunto_de_nfe_pura_tambem_vira_duplicidade(self):
        # 🔴 `pure_nfe` (assunto NF-e sem indicio de pagavel) vem ANTES de `duplicate` em
        # status_for_result: sem o `and not alura_handled` o reenvio saia 'ignorado', escondendo
        # do card "Duplicidades" um e-mail que a regra TRATOU.
        subject = "ENC: NF-e Alura"
        self.assertTrue(R.subject_is_pure_nfe(subject), "premissa: o assunto aciona pure_nfe")
        ctrl = _Ctrl(existing={"nfe": {"id": 7001}, "nfse": {"id": 7002}})
        rec, ctrl, _ = _processa(ctrl=ctrl, subject=subject)
        self.assertEqual(ctrl.contas, [])
        self.assertEqual(rec["status"], "duplicidade")

    def test_so_a_nota_nova_e_gravada_quando_a_outra_ja_existe(self):
        _, ctrl, _ = _processa(ctrl=_Ctrl(existing={"nfe": {"id": 7001}}))
        self.assertEqual([c["document_type"] for c in ctrl.contas], ["nfse"])

    def test_nfse_indisponivel_grava_so_a_nf_e_registra_a_falta(self):
        rec, ctrl, _ = _processa(nfse_ok=False)
        self.assertEqual([c["document_type"] for c in ctrl.contas], ["nfe"])
        self.assertEqual(rec["status"], "extraído")        # tem conta: o status declara conta
        self.assertEqual(len(ctrl.erros), 1)
        self.assertIn("NF de serviço", ctrl.erros[0][1])
        self.assertIn("pendente", rec["notes"])

    def test_nenhuma_nota_legivel_vira_falha_visivel(self):
        rec, ctrl, _ = _processa(nfse_ok=False, danfe_ok=False)
        self.assertEqual(ctrl.contas, [])
        self.assertEqual(rec["status"], "falha")
        self.assertEqual(len(ctrl.erros), 1, "um unico registro em /erros — nada duplicado")

    def test_consulta_de_duplicidade_fora_do_ar_nao_grava_nada(self):
        # 🔴 Fail-closed: "nao sei se existe" nao pode virar "nao existe" (o e-mail chega 2x).
        rec, ctrl, _ = _processa(ctrl=_Ctrl(dup_fails=True))
        self.assertEqual(ctrl.contas, [])
        self.assertEqual(rec["status"], "falha")

    def test_falha_de_gravacao_de_uma_nota_nao_descarta_a_outra(self):
        ctrl = _Ctrl()
        original = ctrl.register_financial
        calls = []

        def flaky(payload):
            calls.append(payload["document_type"])
            return None if payload["document_type"] == "nfe" else original(payload)

        ctrl.register_financial = flaky
        rec, ctrl, _ = _processa(ctrl=ctrl)
        self.assertEqual([c["document_type"] for c in ctrl.contas], ["nfse"])
        self.assertEqual(rec["status"], "extraído")
        self.assertEqual(calls, ["nfe", "nfse"])


class NegativosTest(unittest.TestCase):
    def test_remetente_fora_do_cadastro_continua_ignorado(self):
        # O corpo e forjavel: quem encaminha precisa ser da Alura ou estar no cadastro.
        rec, ctrl, fetched = _processa(sender="estranho@gmail.com")
        self.assertEqual(ctrl.contas, [])
        self.assertEqual(fetched, [], "nem chegou a buscar a NFS-e")
        self.assertEqual(rec["status"], "ignorado")

    def test_email_que_nao_e_da_alura_nao_dispara(self):
        rec, ctrl, fetched = _processa(corpo=BODY.replace("alura.com.br", "outra.com.br"))
        self.assertEqual(ctrl.contas, [])
        self.assertEqual(ctrl.lookups, [], "sequer consulta o cadastro")
        self.assertEqual(fetched, [])
        self.assertEqual(rec["status"], "ignorado")

    def test_fornecedor_alura_ausente_do_cadastro_vira_falha_sem_criar_cadastro(self):
        rec, ctrl, _ = _processa(ctrl=_Ctrl(supplier=False))
        self.assertEqual(ctrl.contas, [])
        self.assertEqual(rec["status"], "falha")
        self.assertEqual(len(ctrl.erros), 1)

    def test_conta_que_o_pipeline_normal_gerou_nao_entra_no_fallback(self):
        # Fallback de verdade: se as regras normais ja responderam (boleto etc.), a regra nao roda.
        with mock.patch.object(R, "try_extract_alura_fiscal") as regra, \
             mock.patch.object(R, "extract_and_store_accounts",
                               return_value=(["c.csv"], 1, False, True)):
            rec, _, _ = _processa()
        regra.assert_not_called()
        self.assertEqual(rec["status"], "extraído")


class FindAccountByDocumentTest(unittest.TestCase):
    """Executa o metodo REAL de SupabaseControl (o `_Ctrl` falso o substitui nos demais testes).

    🔴 Trava o fail-closed: esgotadas as tentativas LEVANTA; devolver None gravaria a conta
    duplicada quando a rede falha (o e-mail chega 2x, com message_ids distintos)."""

    @staticmethod
    def _ctrl():
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl._available = True
        ctrl.base = "https://x.supabase.co"
        ctrl.headers = {}
        return ctrl

    @staticmethod
    def _resp(body: bytes):
        resp = mock.MagicMock()
        resp.__enter__.return_value.read.return_value = body
        return resp

    def test_falha_de_rede_levanta_apos_todas_as_tentativas(self):
        import urllib.error
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")) as op, \
             mock.patch.object(R.time, "sleep"):
            with self.assertRaises(RuntimeError):
                self._ctrl().find_account_by_document(1491, "nfe", ["000.844.902"])
        self.assertEqual(op.call_count, R.DUP_QUERY_ATTEMPTS)

    def test_resposta_vazia_e_none_e_a_consulta_leva_a_chave_propria(self):
        with mock.patch("urllib.request.urlopen", return_value=self._resp(b"[]")) as op:
            found = self._ctrl().find_account_by_document(1491, "nfse", ["00991049", "991049"])
        self.assertIsNone(found)
        url = op.call_args[0][0].full_url
        for part in ("sk_supplier=eq.1491", "document_type=eq.nfse", '"00991049"', '"991049"'):
            self.assertIn(part, url)

    def test_linha_encontrada_e_devolvida(self):
        body = b'[{"id": 2610, "status_id": 8, "invoice_number": "000.844.902"}]'
        with mock.patch("urllib.request.urlopen", return_value=self._resp(body)):
            found = self._ctrl().find_account_by_document(1491, "nfe", ["000.844.902"])
        self.assertEqual(found["id"], 2610)


if __name__ == "__main__":
    unittest.main()
