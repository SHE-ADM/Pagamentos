"""`scripts/reprocess_body_emails.py` — o DRY-RUN prevê o mesmo desfecho do modo real quando o
fornecedor não resolve.

Caso (review 2026-09-15, R2): `inspect_one` ignorava o retorno de `_finalize_supplier`. Com a
FALHA da RPC deixando de cair no pagador (`SupplierResolutionError` → `False`), o dry-run seguia
para a dedup sem `sk_supplier` e informava "gravaria R$ X", enquanto o modo real
(`try_extract_from_body`) devolve `BODY_NONE` e não grava nada. Um dry-run que prevê o oposto do
run real é pior que nenhum: é nele que o operador decide rodar o modo destrutivo.

Propriedades travadas:

🔴 1. Fornecedor não resolvido ⇒ `sem_conta` (a MESMA chave do tally do modo real) e a dedup NÃO
      é consultada — executando o `_finalize_supplier` real, não um dublê dele.
🔴 2. Anti-vacuidade: com a RPC resolvendo, o mesmo e-mail chega à dedup COM `sk_supplier` e
      devolve `resolvido`.
"""

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import read_emails as R  # noqa: E402

SK_SINDMESTRES = 1264
CNPJ_SINDMESTRES = "60938487000180"
CNPJ_OTIMOTEX = "47273917000123"
EC = {"id": 77, "message_id": "<MID-77>", "received_at": "2026-09-08T14:33:27+00:00",
      "sender_email": "eunice@otimotex.com.br", "subject": "mensalidade sindical setembro"}


def _modulo():
    """Importa o script com nome de módulo ÚNICO (mesmo motivo de tests/test_body_full.py)."""
    caminho = _ROOT / "scripts" / "reprocess_body_emails.py"
    spec = importlib.util.spec_from_file_location("reprocess_body_emails_dry_run_mod", caminho)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _payload_extraido(*_args, **_kwargs):
    return {"document_type": "boleto", "amount": "98.77", "due_date": "2026-09-08",
            "supplier_name": "SINDICATO DOS TRABALHADORES MESTRES E CONTRAMESTRES",
            "supplier_cnpj": CNPJ_SINDMESTRES, "supplier_cpf": None,
            "payer_name": "TEXTIL E CONFECCOES OTIMOTEX LTDA", "payer_cnpj": CNPJ_OTIMOTEX,
            "subject": EC["subject"]}


class _Ctrl:
    """Ctrl mínimo para o `_finalize_supplier` REAL; `rpc` decide a resposta da RPC."""

    def __init__(self, rpc):
        self.rpc = rpc
        self.dedup_payloads = []

    def company_cnpj(self):
        return CNPJ_OTIMOTEX

    def company_legal_names(self):
        return frozenset({R._normalize_company_name("TEXTIL E CONFECCOES OTIMOTEX LTDA")})

    def find_supplier_by_email(self, email):
        return None

    def resolve_supplier(self, payload):
        return self.rpc(payload)

    def supplier_defaults(self, sk_supplier):
        return (0, 0)

    def find_financial_duplicate(self, payload):
        self.dedup_payloads.append(dict(payload))
        return None


class InspectOneFornecedorTest(unittest.TestCase):

    def setUp(self):
        self.mod = _modulo()
        extracao = patch.object(self.mod.R, "extract_from_email_body", _payload_extraido)
        extracao.start()
        self.addCleanup(extracao.stop)

    def test_falha_da_rpc_preve_sem_conta_e_nao_consulta_a_dedup(self):
        def rpc(_payload):
            raise R.SupplierResolutionError("RPC de fornecedor falhou: HTTP 400: value too long")

        ctrl = _Ctrl(rpc)
        with self.assertLogs(R.log, level="ERROR"):
            chave = self.mod.inspect_one(ctrl, EC, "corpo com o boleto")

        self.assertEqual(chave, "sem_conta", "o modo real devolve BODY_NONE → 'sem_conta'")
        self.assertEqual(ctrl.dedup_payloads, [], "sem fornecedor a dedup nao tem o que casar")

    def test_rpc_resolvendo_segue_para_a_dedup_com_sk_supplier(self):
        ctrl = _Ctrl(lambda _payload: SK_SINDMESTRES)

        chave = self.mod.inspect_one(ctrl, EC, "corpo com o boleto")

        self.assertEqual(chave, "resolvido")
        self.assertEqual(len(ctrl.dedup_payloads), 1)
        self.assertEqual(ctrl.dedup_payloads[0]["sk_supplier"], SK_SINDMESTRES)

    def test_sem_conta_e_chave_do_tally_do_modo_real(self):
        # Guarda de wiring: a chave devolvida precisa existir no tally, senão main() levanta
        # KeyError no meio do reprocessamento.
        texto = (_ROOT / "scripts" / "reprocess_body_emails.py").read_text(encoding="utf-8")
        tally = texto[texto.index("tally = {"):]
        tally = tally[:tally.index("}")]
        self.assertIn('"resolvido"', tally, "sanidade do parser: o tally precisa ser encontrado")
        self.assertIn('"sem_conta"', tally)


if __name__ == "__main__":
    unittest.main()
