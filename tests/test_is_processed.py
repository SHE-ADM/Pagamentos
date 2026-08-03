"""A7-5 — dedup por `message_id`: `SupabaseControl.is_processed` e o fallback que a usa.

Pendencia aberta desde o code review de 2026-07-08.

POR QUE ESTA FUNCAO MERECE TESTE PROPRIO
    Ela e a ultima barreira contra REPROCESSAR um e-mail ja registrado — e reprocessar, no
    caminho do corpo, significa criar uma conta a pagar DUPLICADA. O detalhe traicoeiro esta no
    call site (`read_emails.py:5560`):

        is_dup = (msg_id in known_ids) if known_ids else (msg_id and ctrl.is_processed(msg_id))

    O `if known_ids` e um teste de VERACIDADE, nao de existencia: com o set VAZIO — Supabase fora
    do ar **ou tabela vazia** — o fluxo cai no `is_processed`, uma consulta por mensagem. Isso e
    deliberado (degradar para consulta individual e melhor que perder a dedup), mas so funciona
    se `is_processed` for confiavel nos dois extremos.

    E ela FALHA ABERTO por decisao: qualquer excecao devolve `False` = "nao processado" = segue
    o fluxo. E a escolha certa (perder um e-mail e pior que arriscar uma duplicata, que a dedup
    de conteudo ainda pega), mas precisa estar travada — invertê-la faria toda a caixa ser
    pulada em silencio durante uma instabilidade de rede.
"""

import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import read_emails as R  # noqa: E402


def _ctrl(disponivel: bool = True):
    """SupabaseControl sem tocar a rede (mesmo padrao de `test_body_full.py`)."""
    ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
    ctrl._available = disponivel
    ctrl.base = "http://fake"
    ctrl.headers = {"apikey": "k", "Authorization": "Bearer k"}
    return ctrl


class _Resposta:
    def __init__(self, corpo):
        self._corpo = corpo

    def read(self):
        return self._corpo

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class IsProcessedTest(unittest.TestCase):
    def _com(self, corpo=b"[]", erro=None):
        chamadas = []

        def falso(req, timeout=None):
            chamadas.append(req.full_url)
            if erro:
                raise erro
            return _Resposta(corpo)

        return mock.patch.object(R.urllib.request, "urlopen", falso), chamadas

    def test_message_id_ja_registrado_e_duplicata(self):
        remendo, _ = self._com(json.dumps([{"id": 7}]).encode())
        with remendo:
            self.assertTrue(_ctrl().is_processed("<a@b>"))

    def test_message_id_novo_nao_e_duplicata(self):
        remendo, _ = self._com(b"[]")
        with remendo:
            self.assertFalse(_ctrl().is_processed("<novo@b>"))

    def test_consulta_filtra_pelo_message_id_ESCAPADO(self):
        """Message-ID tem `<`, `>` e `@` — sem `quote(safe="")` a query sai malformada e o
        PostgREST responderia outra coisa (ou erro), quebrando a dedup em silencio."""
        remendo, chamadas = self._com(b"[]")
        with remendo:
            _ctrl().is_processed("<CAF=1+2@mail.example.com>")
        url = chamadas[0]
        self.assertIn("message_id=eq.", url)
        self.assertNotIn("<", url)
        self.assertNotIn("@mail.example.com>", url)   # o `@` e o `>` foram percent-encoded
        self.assertIn("limit=1", url)                 # 1 linha basta para decidir

    def test_supabase_indisponivel_nao_consulta_e_devolve_False(self):
        remendo, chamadas = self._com(b"[]")
        with remendo:
            self.assertFalse(_ctrl(disponivel=False).is_processed("<a@b>"))
        self.assertEqual(chamadas, [])

    def test_falha_de_rede_FALHA_ABERTO(self):
        """Devolver True aqui pularia a caixa INTEIRA durante uma instabilidade — e o operador
        veria "0 novos e-mails", que e indistinguivel de uma caixa realmente vazia."""
        remendo, _ = self._com(erro=urllib.error.URLError("timed out"))
        with remendo:
            self.assertFalse(_ctrl().is_processed("<a@b>"))

    def test_resposta_ilegivel_FALHA_ABERTO(self):
        remendo, _ = self._com(b"nao e json")
        with remendo:
            self.assertFalse(_ctrl().is_processed("<a@b>"))


class FallbackDaDedupTest(unittest.TestCase):
    """O `if known_ids` do call site: set VAZIO cai na consulta individual.

    Guarda cross-layer — lê o call site real em vez de reafirmar a regra aqui. Se alguém trocar
    por `if known_ids is not None`, o fallback morre: com a tabela vazia (ou o Supabase fora) a
    dedup individual deixaria de rodar, e o teste fica vermelho.
    """

    def test_o_call_site_usa_teste_de_VERACIDADE_e_chama_is_processed(self):
        fonte = (_ROOT / "skills" / "email-reader" / "scripts" / "read_emails.py").read_text(
            encoding="utf-8")
        linha = next((ln for ln in fonte.splitlines() if "is_dup = " in ln), None)
        self.assertIsNotNone(linha, "linha `is_dup = ` nao encontrada — parser cego")
        self.assertIn("if known_ids", linha)
        self.assertNotIn("is not None", linha)
        self.assertIn("ctrl.is_processed(msg_id)", linha)


if __name__ == "__main__":
    unittest.main()
