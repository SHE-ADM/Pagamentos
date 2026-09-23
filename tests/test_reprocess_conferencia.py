"""
Conferência pós-reprocessamento de `scripts/reprocess_message.py`.

🔴 O QUE ELA COBRE — o sufixo do `gmail_message_id` (#1, #2, ...) é POSICIONAL e
`register_financial` faz UPSERT por essa chave. Reprocessar um e-mail cuja leitura anterior
gravou MENOS contas que anexos desloca as posições: o mesmo id passa a descrever OUTRO
documento, e o que está preso ao ID — curadoria e anexo já vinculado — viaja junto. Medido em
22/09/2026 na recuperação das 6 parcelas da NF 1724: 5 contas com o anexo do documento anterior
(reconciliadas pela migration 144).

A conferência é read-only e só RELATA; o teste prova que ela relata de fato — um verificador
que nunca vê a divergência que existe para ver é decoração.
"""

import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import reprocess_message as RM  # noqa: E402

MID = "<abc_123$x@otimotex.com.br>"   # com '_' de propósito: é curinga no LIKE


class _Ctrl:
    base = "https://exemplo.supabase.co"
    headers = {}


def _conta(id_, inv, arquivo, anexos, mid=MID, sufixo=""):
    return {"id": id_, "invoice_number": inv, "source_file": arquivo,
            "gmail_message_id": mid + sufixo,
            "financial_account_attachment": [{"storage_key": k, "deleted_at": d}
                                             for k, d in anexos]}


def _resposta(contas):
    """Contexto que faz `urlopen` devolver estas contas (a função usa urllib direto)."""
    payload = json.dumps(contas).encode()

    class _Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    return patch.object(RM.urllib.request, "urlopen", lambda *a, **k: _Resp(payload))


class ConferenciaPosReprocessoTest(unittest.TestCase):

    def test_tudo_certo_nao_relata(self):
        contas = [_conta(1, "NF1-10", "b1.pdf", [("b1.pdf", None)]),
                  _conta(2, "NF2-10", "b2.pdf", [("b2.pdf", None)], sufixo="#1")]
        with _resposta(contas):
            self.assertEqual(RM._conferir_contas(_Ctrl(), MID), 0)

    def test_anexo_EXTRA_nao_e_divergencia(self):
        # 🔴 Anti-regressão medida: acumular anexo é comportamento CORRETO — a dedup entre
        # e-mails vincula a 2ª via à conta existente (invariante do CLAUDE.md) e o reprocesso
        # regrava o PDF com sufixo _N. Tratar o extra como divergência acusava 26 dos 867
        # e-mails do acervo (40 contas), todas falsas.
        contas = [_conta(1, "NF1-10", "b1.pdf", [("b1.pdf", None), ("b1_2.pdf", None)])]
        with _resposta(contas):
            self.assertEqual(RM._conferir_contas(_Ctrl(), MID), 0)

    def test_conta_sem_o_proprio_anexo_e_relatada(self):
        # O caso real do incidente da NF 1724: a conta ficou só com o anexo do documento que o
        # id descrevia ANTES do reprocessamento.
        contas = [_conta(1, "NF1-10", "b1.pdf", [("b6.pdf", None)])]
        with _resposta(contas):
            self.assertEqual(RM._conferir_contas(_Ctrl(), MID), 1)

    def test_conta_sem_source_file_nao_e_relatada(self):
        # Conta vinda do CORPO do e-mail: não há "próprio anexo" a conferir, e comparar contra
        # None fazia QUALQUER anexo vivo (upload manual, 2ª via por dedup) virar divergência.
        contas = [_conta(1, "NF1-10", None, [("manual/1/comprovante.pdf", None)])]
        with _resposta(contas):
            self.assertEqual(RM._conferir_contas(_Ctrl(), MID), 0)

    def test_anexo_removido_nao_conta_como_alheio(self):
        # Soft delete (padrão da 079): o vínculo apagado não é divergência.
        contas = [_conta(1, "NF1-10", "b1.pdf",
                         [("b6.pdf", "2026-09-22T20:00:00+00:00"), ("b1.pdf", None)])]
        with _resposta(contas):
            self.assertEqual(RM._conferir_contas(_Ctrl(), MID), 0)

    def test_conta_de_outro_email_nao_entra(self):
        # O '_' do Message-ID é curinga no LIKE e a consulta traz vizinhos: o corte exato é
        # feito no cliente. Sem ele, a conta abaixo (outro e-mail) viraria divergência falsa.
        contas = [_conta(1, "NF1-10", "b1.pdf", [("b1.pdf", None)]),
                  _conta(9, "XX-1", "outro.pdf", [("zzz.pdf", None)],
                         mid="<abcX123$x@otimotex.com.br>")]
        with _resposta(contas):
            self.assertEqual(RM._conferir_contas(_Ctrl(), MID), 0)

    def test_falha_de_consulta_nao_derruba(self):
        # Best-effort: o reprocessamento já terminou; a conferência não pode falhar por cima.
        def _boom(*a, **k):
            raise OSError("rede fora")

        with patch.object(RM.urllib.request, "urlopen", _boom):
            self.assertEqual(RM._conferir_contas(_Ctrl(), MID), 0)


if __name__ == "__main__":
    unittest.main()
