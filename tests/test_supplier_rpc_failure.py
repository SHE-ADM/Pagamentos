"""FALHA da RPC de fornecedor nunca cai no fallback do PAGADOR.

Caso real (contas 895 e 1396, boleto do SINDMESTRES; dados corrigidos na migration 139): a
extração lia CORRETAMENTE o beneficiário — nome de ~140 caracteres + CNPJ. O CNPJ não estava
cadastrado, a RPC `resolve_supplier_id` tentava o auto-insert e estourava o VARCHAR(60) de
`supplier.legal_name` (22001). `SupabaseControl.resolve_supplier` engolia o erro e devolvia
None — o mesmo valor de "não há identificador" —, e `_finalize_supplier` seguia para o
fallback do pagador: o boleto do sindicato foi lançado sob a OTIMOTEX, com o plano dela (Vale
Alimentação), sem erro e sem linha em /erros. A migration 138 corta o nome no banco; este
arquivo trava o lado Python, para que a PRÓXIMA falha da RPC (qualquer que seja) vá a /erros.

Propriedades travadas:

🔴 1. `resolve_supplier` tem TRÊS desfechos: id · None só para a recusa "nenhum identificador
      valido" (e Supabase indisponível) · `SupplierResolutionError` para qualquer falha.
🔴 2. Erro DEFINITIVO do banco (4xx) não re-tenta; rede, timeout e 5xx re-tentam e, esgotados,
      levantam — nunca devolvem None.
🔴 3. `_finalize_supplier` EXECUTADO com a RPC falhando devolve False, não consulta o pagador e
      guarda o motivo na chave efêmera.
🔴 4. Call site EXECUTADO (`extract_and_store_accounts`): registra `db_erro` com o motivo e NÃO
      grava conta.
🔴 5. A sondagem do pagador NÃO leva o e-mail do remetente — a RPC o anexaria ao cadastro da
      pagadora (origem dos e-mails de terceiros no sk 1, limpos na migration 139).
🔴 6. O marcador Python é espelho do RAISE da migration mais recente que define
      `resolve_supplier_id` (com sanidade do parser).
"""

import http.client
import io
import json
import re
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import read_emails as R

MIGRATIONS_DIR = _ROOT / "supabase" / "migrations"

SK_SINDMESTRES = 1264
SK_OTIMOTEX = 1
CNPJ_OTIMOTEX = "47273917000123"
CNPJ_SINDMESTRES = "60938487000180"
NOME_SINDMESTRES = ("SINDICATO DOS TRABALHADORES MESTRES E CONTRAMESTRES, LIDERES, "
                    "SUPERVISORES, PESSOAL DE ESCRITÓRIO E CARGOS DE CHEFIA NA INDUSTRIA DO EST DE SP")
PAGADORA = "TEXTIL E CONFECCOES OTIMOTEX LTDA"
REMETENTE = "eunice@otimotex.com.br"
ASSUNTO = "pagamento sindicato"
ERRO_22001 = {"code": "22001", "details": None, "hint": None,
              "message": "value too long for type character varying(60)"}
ERRO_SEM_IDENTIFICADOR = {"code": "P0001", "details": None, "hint": None,
                          "message": "resolve_supplier_id: nenhum identificador valido (cnpj, cpf, "
                                     "nome ausentes; e-mail ausente, de dominio interno ou de plataforma)"}


def _http_error(code, body):
    raw = json.dumps(body).encode() if isinstance(body, dict) else body
    return urllib.error.HTTPError("https://x/rest/v1/rpc/resolve_supplier_for_account",
                                  code, "erro", {}, io.BytesIO(raw))


def _ok(value):
    resposta = mock.MagicMock()
    resposta.read.return_value = json.dumps(value).encode()
    cm = mock.MagicMock()
    cm.__enter__.return_value = resposta
    return cm


def _control():
    ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
    ctrl.base, ctrl.key, ctrl.headers, ctrl._available = "https://x", "k", {}, True
    return ctrl


PAYLOAD_RPC = {"supplier_name": NOME_SINDMESTRES, "supplier_cnpj": CNPJ_SINDMESTRES,
               "sender_email": REMETENTE}


# ---------------------------------------------------------------------------
# 1/2 — contrato de SupabaseControl.resolve_supplier
# ---------------------------------------------------------------------------
class ResolveSupplierContratoTest(unittest.TestCase):

    def setUp(self):
        sleep = patch.object(R.time, "sleep")
        self.sleep = sleep.start()
        self.addCleanup(sleep.stop)

    def _chamar(self, side_effect):
        with patch.object(R.urllib.request, "urlopen", side_effect=side_effect) as m:
            try:
                return m, R.SupabaseControl.resolve_supplier(_control(), dict(PAYLOAD_RPC)), None
            except R.SupplierResolutionError as e:
                return m, None, e

    def test_id_resolvido(self):
        m, sk, err = self._chamar([_ok(SK_SINDMESTRES)])
        self.assertEqual(sk, SK_SINDMESTRES)
        self.assertIsNone(err)
        self.assertEqual(m.call_count, 1)

    def test_recusa_por_falta_de_identificador_devolve_none_sem_retentar(self):
        m, sk, err = self._chamar([_http_error(400, ERRO_SEM_IDENTIFICADOR)])
        self.assertIsNone(err, "a recusa de NEGOCIO nao e falha — o pagador precisa seguir alcancavel")
        self.assertIsNone(sk)
        self.assertEqual(m.call_count, 1)

    def test_nome_longo_22001_levanta_com_motivo_e_nao_retenta(self):
        # O defeito das contas 895/1396: antes, isto devolvia None.
        m, sk, err = self._chamar([_http_error(400, ERRO_22001)])
        self.assertIsInstance(err, R.SupplierResolutionError)
        self.assertIsNone(sk)
        self.assertIn("value too long", str(err))
        self.assertEqual(m.call_count, 1, "erro definitivo do banco nao se resolve repetindo")
        self.sleep.assert_not_called()

    def test_rede_transitoria_retenta_e_recupera(self):
        m, sk, err = self._chamar([urllib.error.URLError("reset"), TimeoutError("lento"),
                                   _ok(SK_SINDMESTRES)])
        self.assertIsNone(err)
        self.assertEqual(sk, SK_SINDMESTRES)
        self.assertEqual(m.call_count, 3)
        self.assertEqual(self.sleep.call_count, 2)

    def test_corpo_cortado_retenta_e_esgotado_levanta(self):
        # IncompleteRead NAO herda de OSError: sem tratamento explicito escaparia do contrato e
        # derrubaria o e-mail inteiro no except generico de process_message.
        self.assertFalse(issubclass(http.client.IncompleteRead, OSError), "sanidade da premissa")

        def cortado():
            cm = mock.MagicMock()
            cm.__enter__.return_value.read.side_effect = http.client.IncompleteRead(b"12")
            return cm

        m, sk, err = self._chamar([cortado(), _ok(SK_SINDMESTRES)])
        self.assertIsNone(err)
        self.assertEqual(sk, SK_SINDMESTRES)
        self.assertEqual(m.call_count, 2)

        m, sk, err = self._chamar([cortado() for _ in range(R.SUPPLIER_RPC_ATTEMPTS)])
        self.assertIsNone(sk)
        self.assertIsInstance(err, R.SupplierResolutionError)
        self.assertIn("IncompleteRead", str(err))

    def test_parametros_fora_da_faixa_nao_pulam_a_rpc_nem_dormem_negativo(self):
        # ATTEMPTS=0 no .env nao pode pular a RPC (toda conta iria a /erros sem chamada nenhuma).
        with patch.object(R, "SUPPLIER_RPC_ATTEMPTS", 0), patch.object(R, "SUPPLIER_RPC_BACKOFF", 1.5):
            m, sk, err = self._chamar([_ok(SK_SINDMESTRES)])
        self.assertIsNone(err)
        self.assertEqual(sk, SK_SINDMESTRES)
        self.assertEqual(m.call_count, 1)

        # BACKOFF negativo: o time.sleep real levantaria ValueError fora do contrato. O sleep aqui
        # e mock, entao a garantia e observada no ARGUMENTO recebido.
        with patch.object(R, "SUPPLIER_RPC_ATTEMPTS", 2), patch.object(R, "SUPPLIER_RPC_BACKOFF", -1.5):
            m, sk, err = self._chamar([urllib.error.URLError("reset"), _ok(SK_SINDMESTRES)])
        self.assertEqual(sk, SK_SINDMESTRES)
        self.assertTrue(self.sleep.call_args_list, "sanidade: o backoff precisa ter sido exercitado")
        for chamada in self.sleep.call_args_list:
            self.assertGreaterEqual(chamada.args[0], 0, "time.sleep negativo levanta ValueError")

    def test_5xx_retenta(self):
        m, sk, err = self._chamar([_http_error(503, b"<html>gateway</html>"), _ok(SK_SINDMESTRES)])
        self.assertIsNone(err)
        self.assertEqual(sk, SK_SINDMESTRES)
        self.assertEqual(m.call_count, 2)

    def test_rede_esgotada_levanta_nunca_none(self):
        falhas = [urllib.error.URLError("fora") for _ in range(R.SUPPLIER_RPC_ATTEMPTS)]
        m, sk, err = self._chamar(falhas)
        self.assertIsNone(sk)
        self.assertIsInstance(err, R.SupplierResolutionError)
        self.assertEqual(m.call_count, R.SUPPLIER_RPC_ATTEMPTS)
        # Sanidade: o teste de retry so prova algo se houver mais de uma tentativa.
        self.assertGreater(R.SUPPLIER_RPC_ATTEMPTS, 1)

    def test_resposta_ilegivel_levanta(self):
        cm = mock.MagicMock()
        cm.__enter__.return_value.read.return_value = b"<html>proxy</html>"
        m, sk, err = self._chamar([cm])
        self.assertIsNone(sk)
        self.assertIsInstance(err, R.SupplierResolutionError)
        self.assertEqual(m.call_count, 1, "resposta ilegivel nao se resolve repetindo")

    def test_supabase_indisponivel_devolve_none(self):
        ctrl = _control()
        ctrl._available = False
        with patch.object(R.urllib.request, "urlopen") as m:
            self.assertIsNone(ctrl.resolve_supplier(dict(PAYLOAD_RPC)))
        m.assert_not_called()


# ---------------------------------------------------------------------------
# 3/5 — _finalize_supplier EXECUTADO
# ---------------------------------------------------------------------------
class _FinalizeCtrl:
    """Ctrl mínimo: `rpc` decide a resposta por payload; registra tudo o que chegou à RPC."""

    def __init__(self, rpc):
        self.rpc = rpc
        self.payloads = []

    def company_cnpj(self):
        return CNPJ_OTIMOTEX

    def company_legal_names(self):
        return frozenset({R._normalize_company_name(PAGADORA)})

    def find_supplier_by_email(self, email):
        return None

    def resolve_supplier(self, payload):
        self.payloads.append(dict(payload))
        return self.rpc(payload)

    def supplier_defaults(self, sk_supplier):
        return (8, 478) if sk_supplier == SK_OTIMOTEX else (0, 0)


def _payload_boleto():
    return {"supplier_name": NOME_SINDMESTRES, "supplier_cnpj": CNPJ_SINDMESTRES,
            "supplier_cpf": None, "payer_name": PAGADORA, "payer_cnpj": CNPJ_OTIMOTEX,
            "sender_email": REMETENTE, "subject": ASSUNTO, "document_type": "boleto"}


class FinalizeSupplierFalhaTest(unittest.TestCase):

    def test_falha_da_rpc_nao_cai_no_pagador(self):
        def rpc(payload):
            if payload.get("supplier_cnpj") == CNPJ_SINDMESTRES:
                raise R.SupplierResolutionError("RPC de fornecedor falhou: HTTP 400: value too long")
            return SK_OTIMOTEX  # o pagador RESOLVERIA — é o que não pode acontecer

        ctrl = _FinalizeCtrl(rpc)
        payload = _payload_boleto()

        with self.assertLogs(R.log, level="ERROR"):
            self.assertFalse(R._finalize_supplier(ctrl, payload, ""))

        self.assertNotIn("sk_supplier", payload)
        self.assertNotIn("chart_account_id", payload, "nao pode herdar o plano do pagador")
        self.assertEqual(len(ctrl.payloads), 1, "a sondagem do pagador nao pode ter rodado")
        self.assertIn("value too long", payload[R.SUPPLIER_ERROR_KEY])
        for col in ("supplier_name", "supplier_cnpj", "supplier_cpf"):
            self.assertNotIn(col, payload)

    def test_recusa_legitima_segue_para_o_pagador_sem_o_email_do_remetente(self):
        # Anti-vacuidade do teste acima: o fallback do pagador continua ALCANÇÁVEL para o
        # None legítimo — o teste anterior não pode estar verde porque o pagador morreu.
        def rpc(payload):
            if R._normalize_company_name(payload.get("supplier_name")) == \
                    R._normalize_company_name(PAGADORA):
                return SK_OTIMOTEX
            return None

        ctrl = _FinalizeCtrl(rpc)
        payload = {"supplier_name": None, "supplier_cnpj": None, "supplier_cpf": None,
                   "payer_name": PAGADORA, "payer_cnpj": CNPJ_OTIMOTEX,
                   "sender_email": "financeiro@acarolacbrand.com.br",
                   "subject": "Re: 12345", "document_type": "boleto"}

        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))

        self.assertEqual(payload["sk_supplier"], SK_OTIMOTEX)
        self.assertNotIn(R.SUPPLIER_ERROR_KEY, payload)
        self.assertEqual(len(ctrl.payloads), 2, ctrl.payloads)
        self.assertEqual(ctrl.payloads[0]["sender_email"], "financeiro@acarolacbrand.com.br",
                         "a chamada principal continua levando o e-mail (passo 4 da RPC)")
        self.assertIsNone(ctrl.payloads[1]["sender_email"],
                          "a sondagem do pagador anexaria o e-mail ao cadastro da OTIMOTEX")

    def test_falha_na_propria_sondagem_do_pagador_tambem_vai_a_erros(self):
        def rpc(payload):
            # A chamada principal (sem identificador) volta vazia; a sondagem do pagador falha.
            if payload.get("supplier_cnpj") == CNPJ_OTIMOTEX:
                raise R.SupplierResolutionError("RPC de fornecedor falhou: rede: timeout")

        ctrl = _FinalizeCtrl(rpc)
        payload = {"supplier_name": None, "supplier_cnpj": None, "supplier_cpf": None,
                   "payer_name": "", "payer_cnpj": CNPJ_OTIMOTEX, "sender_email": "",
                   "subject": "12345", "document_type": "boleto"}

        with self.assertLogs(R.log, level="ERROR"):
            self.assertFalse(R._finalize_supplier(ctrl, payload, ""))
        self.assertEqual(len(ctrl.payloads), 2, "a sondagem do pagador precisa ter sido exercitada")
        self.assertIn("timeout", payload[R.SUPPLIER_ERROR_KEY])


# ---------------------------------------------------------------------------
# 4 — call site EXECUTADO: extract_and_store_accounts
# ---------------------------------------------------------------------------
class _PipelineCtrl:
    """Stub de SupabaseControl no molde de test_sk_company_le_blanc, com a RPC falhando."""

    def __init__(self):
        self.financial_calls = []
        self.error_calls = []

    def upload_attachment(self, pdf_path):
        return True

    def company_cnpj(self):
        return CNPJ_OTIMOTEX

    def register_financial(self, payload):
        self.financial_calls.append(dict(payload))
        return len(self.financial_calls)

    def register_attachment(self, account_id, file_name, size_bytes=0, uploaded_by=None):
        return True

    def resolve_user(self, sender_email):
        return None

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.error_calls.append((error_type, error_message))
        return True

    def unique_invoice_number(self, base):
        return base

    def find_financial_duplicate(self, payload):
        return None

    def resolve_supplier(self, payload):
        if payload.get("supplier_cnpj") == CNPJ_SINDMESTRES:
            raise R.SupplierResolutionError(
                "RPC de fornecedor falhou: HTTP 400: value too long for type character varying(60)")
        return SK_OTIMOTEX

    def supplier_defaults(self, sk_supplier):
        return (8, 478) if sk_supplier == SK_OTIMOTEX else (0, 0)

    def update_supplier_contact(self, *args, **kwargs):
        return True


class CallSiteAnexoTest(unittest.TestCase):

    def _run(self):
        ctrl = _PipelineCtrl()
        row = {"source_file": "eunice_pagamento_sindicato_20260908_ASSISTENCIAL.pdf",
               "document_type": "boleto", "extraction_source": "pdf_text",
               "supplier_name": NOME_SINDMESTRES, "supplier_cnpj": CNPJ_SINDMESTRES,
               "payer_name": PAGADORA, "payer_cnpj": CNPJ_OTIMOTEX,
               "invoice_number": "00000000000", "amount": "98.77", "due_date": "2026-09-08",
               "issue_date": "2026-09-01", "barcode": ""}

        def fake_run_extraction(pdf_path, pdf_passwords=None):
            return (pdf_path.name, None)

        with patch.object(R, "run_extraction", fake_run_extraction), \
             patch.object(R, "read_extracted_rows", return_value=[row]), \
             patch.object(R, "_attachment_text", return_value=""), \
             self.assertLogs(R.log, level="ERROR"):
            R.extract_and_store_accounts(
                [Path(row["source_file"])], "<MID-1396>", ctrl,
                email_rec={"received_at": "2026-09-08T14:33:27+00:00",
                           "subject": ASSUNTO, "sender_email": REMETENTE},
                body_text="")
        return ctrl

    def test_conta_nao_e_gravada_e_erro_leva_o_motivo(self):
        ctrl = self._run()
        self.assertEqual(ctrl.financial_calls, [],
                         "a conta foi gravada — no defeito original, sob a OTIMOTEX")
        erros = [msg for tipo, msg in ctrl.error_calls if tipo == "db_erro"]
        self.assertEqual(len(erros), 1, ctrl.error_calls)
        self.assertIn("Falha ao resolver fornecedor", erros[0])
        self.assertIn("value too long", erros[0], "o operador precisa ver o MOTIVO em /erros")


# ---------------------------------------------------------------------------
# 6 — paridade do marcador com a migration
# ---------------------------------------------------------------------------
_DEF_RE = re.compile(r"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.resolve_supplier_id\s*\(",
                     re.IGNORECASE)
_RAISE_RE = re.compile(r"RAISE\s+EXCEPTION\s+'([^']*)'", re.IGNORECASE)


def _latest_definition() -> Path:
    candidatos = sorted(p for p in MIGRATIONS_DIR.glob("*.sql")
                        if _DEF_RE.search(p.read_text(encoding="utf-8")))
    return candidatos[-1]


class MarcadorMigrationTest(unittest.TestCase):

    def test_marcador_e_espelho_do_raise_da_definicao_mais_recente(self):
        migration = _latest_definition()
        texto = migration.read_text(encoding="utf-8")
        corpo = texto[_DEF_RE.search(texto).start():]
        corpo = corpo[:corpo.index("$function$;")]
        raises = _RAISE_RE.findall(corpo)
        # Sanidade do parser: sem RAISE nenhum casado, a asserção abaixo nunca poderia falhar.
        self.assertTrue(raises, f"nenhum RAISE EXCEPTION reconhecido em {migration.name}")
        self.assertTrue(any(R.SUPPLIER_RPC_NO_IDENTIFIER_MARKER in r for r in raises),
                        f"{migration.name} nao contem o marcador "
                        f"{R.SUPPLIER_RPC_NO_IDENTIFIER_MARKER!r} em nenhum RAISE: {raises}")

    def test_definicao_mais_recente_e_a_que_corta_o_nome(self):
        # Sanidade do glob: a 138 precisa ser encontrada como definição vigente.
        migration = _latest_definition()
        self.assertGreaterEqual(int(migration.name.split("_", 1)[0]), 138, migration.name)
        self.assertIn("c_name_max", migration.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
