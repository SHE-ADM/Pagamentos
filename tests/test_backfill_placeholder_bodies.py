"""Guardas do backfill de corpo-placeholder (scripts/backfill_placeholder_bodies.py).

O script mexe na caixa postal e regrava colunas de `email_control`. As garantias que ele
promete no cabecalho sao verificadas AQUI — inclusive as negativas ("nunca grava conta",
"nunca marca \\Seen"), que sao lidas sobre o CODIGO com `_sem_prosa`: o proprio arquivo
explica em prosa o que nao deve fazer, entao uma busca textual crua casaria a advertencia
e ficaria verde para sempre (licao de 2026-08-03, ja registrada no CLAUDE.md).
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ / "scripts"))
sys.path.insert(0, str(RAIZ / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_fiscal_document_consistency import _sem_prosa  # noqa: E402

import backfill_placeholder_bodies as B  # noqa: E402

FONTE = (RAIZ / "scripts" / "backfill_placeholder_bodies.py").read_text(encoding="utf-8")
CODIGO = _sem_prosa(FONTE)


class SanidadeDaLenteTest(unittest.TestCase):
    """Se `_sem_prosa` devolvesse vazio, todas as guardas abaixo passariam sem ver nada."""

    def test_a_lente_preserva_o_codigo(self):
        # Ancoras ESTAVEIS e independentes dos invariantes testados abaixo: se a sanidade
        # dependesse deles, quebraria junto e deixaria de distinguir "parser quebrou" de
        # "regra violada" — que e exatamente o que ela existe para separar.
        self.assertIn("def gravar", CODIGO)
        self.assertIn("def main", CODIGO)
        self.assertIn("rest_write", CODIGO)
        self.assertGreater(len(CODIGO), 1500)


class InvariantesEstruturaisTest(unittest.TestCase):
    def test_nunca_toca_em_conta(self):
        # O script so pode escrever em email_control. A tabela de contas nao aparece no
        # codigo — so na prosa que explica a regra.
        self.assertNotIn("financial_account_control", CODIGO)
        self.assertIn("email_control", CODIGO)

    def test_abre_a_caixa_em_modo_leitura(self):
        # EXAMINE: no modo readonly o servidor NAO PODE gravar flag permanente. E a
        # garantia estrutural de que o backfill nao marca e-mail como lido.
        self.assertIn("readonly=True", CODIGO)

    def test_todo_fetch_usa_peek(self):
        # BODY[] sem PEEK marca \\Seen no servidor. Nao pode haver nenhum.
        self.assertNotIn("BODY[", CODIGO.replace("BODY.PEEK[", ""))
        self.assertIn("BODY.PEEK[", CODIGO)

    def test_nao_reimplementa_a_deteccao(self):
        # A regra vive no reader; duplicar aqui criaria 2a fonte de verdade.
        self.assertIn("_plain_body_is_placeholder", CODIGO)
        self.assertIn("_html_to_text", CODIGO)
        self.assertIn("_body_full_for_storage", CODIGO)


class PatchCondicionalTest(unittest.TestCase):
    """O filtro do placeholder vai NA URL — atomico no servidor, imune a corrida com o
    reader agendado (que roda a cada 5 min e pode corrigir a linha nesse meio tempo)."""

    def test_url_do_patch_carrega_o_filtro_e_o_id(self):
        capturado = {}

        def falso_rest_write(base, headers, path, payload, method="POST", prefer=""):
            capturado.update(path=path, payload=payload, method=method)
            return True, ""

        with mock.patch.object(B, "rest_write", falso_rest_write):
            B.gravar("https://x", {}, 1196, "corpo real da fatura")

        self.assertEqual(capturado["method"], "PATCH")
        self.assertIn("id=eq.1196", capturado["path"])
        self.assertIn("body_full=ilike.", capturado["path"],
                      "sem o filtro na URL o PATCH sobrescreveria corpo ja corrigido")
        # Escreve as duas colunas do corpo, e SO elas.
        self.assertEqual(set(capturado["payload"]), {"body_full", "body_preview"})

    def test_preview_continua_truncado(self):
        # body_preview e o que a tela /emails mostra; body_full e o conteudo. Papeis
        # distintos — nao unificar.
        capturado = {}

        def falso_rest_write(base, headers, path, payload, method="POST", prefer=""):
            capturado.update(payload=payload)
            return True, ""

        with mock.patch.object(B, "rest_write", falso_rest_write):
            B.gravar("https://x", {}, 1, "L" * 5000)

        self.assertEqual(len(capturado["payload"]["body_preview"]), B.PREVIEW_MAX)
        self.assertGreater(len(capturado["payload"]["body_full"]), B.PREVIEW_MAX)


class SelecaoDeCandidatosTest(unittest.TestCase):
    def test_so_entra_quem_tem_corpo_placeholder_e_message_id(self):
        linhas = [
            {"id": 1, "message_id": "<a>", "body_full": "O conteudo deste e-mail esta somente disponivel em HTML"},
            {"id": 2, "message_id": "<b>", "body_full": "FORNECEDOR X\n\nVALOR R$ 10,00"},   # corpo real
            {"id": 3, "message_id": None,  "body_full": "esta disponivel em HTML"},          # sem message_id
            {"id": 4, "message_id": "<d>", "body_full": None},                               # sem corpo
        ]
        with mock.patch.object(B, "rest_get", lambda *a, **k: linhas):
            achados = B.candidatos("https://x", {})
        self.assertEqual([r["id"] for r in achados], [1])


PLACEHOLDER = "O conteudo deste e-mail esta somente disponivel em HTML"
HTML_UTIL = "<p>Fatura 0079399 realizados por Pantanal Log E Transportes Ltda</p>"


def _mensagem(html: str) -> bytes:
    """multipart/alternative como o da plataforma: aviso em texto + conteudo em HTML."""
    from email.message import EmailMessage

    msg = EmailMessage()
    msg["Subject"] = "Sua fatura esta disponivel."
    msg["From"] = "no-reply@sswsistemas.com.br"
    msg["Message-ID"] = "<a>"
    msg.set_content(PLACEHOLDER)
    if html:
        msg.add_alternative(html, subtype="html")
    return msg.as_bytes()


class FakeIMAP:
    """IMAP minimo que responde ao que o script realmente pede.

    Registra os comandos recebidos para que os testes possam AFIRMAR que a caixa foi
    aberta em modo leitura e que todo fetch usou PEEK — comportamento, nao so texto.
    """

    def __init__(self, bruto: bytes):
        self.bruto = bruto
        self.readonly = None
        self.fetches: list = []
        self.deslogou = False

    def login(self, user, senha):
        return "OK", [b"logged in"]

    def select(self, caixa, readonly=False):
        self.readonly = readonly
        return "OK", [b"1"]

    def search(self, charset, criterio):
        return "OK", [b"1"]

    def fetch(self, alvo, spec):
        self.fetches.append(spec)
        if "HEADER.FIELDS" in spec:
            return "OK", [(b"1 (BODY[HEADER.FIELDS (MESSAGE-ID)] {20}", b"Message-ID: <a>\r\n\r\n")]
        return "OK", [(b"1 (BODY[] {100}", self.bruto)]

    def logout(self):
        self.deslogou = True


class MainTest(unittest.TestCase):
    """Exercita o orquestrador de ponta a ponta com IMAP e REST falsos."""

    def _rodar(self, argv, linhas, html=HTML_UTIL, escrita_ok=True):
        gravacoes: list = []
        imap = FakeIMAP(_mensagem(html))

        def falso_rest_write(base, headers, path, payload, method="POST", prefer=""):
            gravacoes.append((path, payload))
            return escrita_ok, "" if escrita_ok else "erro simulado"

        env = {"SUPABASE_URL": "https://x", "SUPABASE_SERVICE_KEY": "k",
               "IMAP_HOST": "h", "IMAP_USER": "u", "IMAP_PASS": "p"}
        with mock.patch.object(sys, "argv", ["prog", *argv]), \
             mock.patch.dict("os.environ", env, clear=False), \
             mock.patch.object(B, "load_dotenv", lambda *a, **k: None), \
             mock.patch.object(B, "rest_get", lambda *a, **k: linhas), \
             mock.patch.object(B, "rest_write", falso_rest_write), \
             mock.patch.object(B, "_abrir_inbox", lambda: imap):
            codigo = B.main()
        return codigo, gravacoes, imap

    def _linha(self, id_=1, mid="<a>"):
        return {"id": id_, "message_id": mid, "body_full": PLACEHOLDER}

    def test_regrava_o_corpo_do_html(self):
        codigo, gravacoes, imap = self._rodar([], [self._linha()])
        self.assertEqual(codigo, 0)
        self.assertEqual(len(gravacoes), 1)
        path, payload = gravacoes[0]
        self.assertIn("id=eq.1", path)
        self.assertIn("Pantanal", payload["body_full"])
        self.assertTrue(imap.deslogou, "a conexao IMAP precisa ser encerrada")

    def test_dry_run_nao_grava(self):
        codigo, gravacoes, _ = self._rodar(["--dry-run"], [self._linha()])
        self.assertEqual(codigo, 0)
        self.assertEqual(gravacoes, [])

    def test_so_usa_peek(self):
        # RFC822/BODY[] sem PEEK marcaria \\Seen no servidor.
        _codigo, _g, imap = self._rodar([], [self._linha()])
        self.assertTrue(imap.fetches, "nenhum fetch foi feito")
        for spec in imap.fetches:
            self.assertIn("BODY.PEEK[", spec)
            self.assertNotIn("RFC822]", spec)


    def test_html_vazio_preserva_o_registro(self):
        # Sobrescrever aqui deixaria o registro PIOR — sem nem o aviso.
        codigo, gravacoes, _ = self._rodar([], [self._linha()], html="")
        self.assertEqual(codigo, 0)
        self.assertEqual(gravacoes, [])

    def test_e_mail_fora_da_caixa_e_ignorado(self):
        # Irrecuperavel: esta no banco, mas nao existe mais na INBOX.
        codigo, gravacoes, _ = self._rodar([], [self._linha(id_=9, mid="<sumiu>")])
        self.assertEqual(codigo, 0)
        self.assertEqual(gravacoes, [])

    def test_limit_corta_o_lote(self):
        linhas = [self._linha(id_=1), self._linha(id_=2)]
        _codigo, gravacoes, _ = self._rodar(["--limit", "1"], linhas)
        self.assertEqual(len(gravacoes), 1)

    def test_falha_de_escrita_devolve_exit_1(self):
        codigo, _g, _i = self._rodar([], [self._linha()], escrita_ok=False)
        self.assertEqual(codigo, 1, "falha ao gravar precisa reprovar a execucao")

    def test_sem_candidatos_encerra_sem_abrir_a_caixa(self):
        with mock.patch.object(sys, "argv", ["prog"]), \
             mock.patch.dict("os.environ", {"SUPABASE_URL": "https://x",
                                            "SUPABASE_SERVICE_KEY": "k"}, clear=False), \
             mock.patch.object(B, "load_dotenv", lambda *a, **k: None), \
             mock.patch.object(B, "rest_get", lambda *a, **k: []), \
             mock.patch.object(B, "_abrir_inbox", mock.Mock(side_effect=AssertionError("nao abrir"))):
            self.assertEqual(B.main(), 0)

    def test_falha_no_supabase_aborta_sem_tocar_na_caixa(self):
        with mock.patch.object(sys, "argv", ["prog"]), \
             mock.patch.dict("os.environ", {"SUPABASE_URL": "https://x",
                                            "SUPABASE_SERVICE_KEY": "k"}, clear=False), \
             mock.patch.object(B, "load_dotenv", lambda *a, **k: None), \
             mock.patch.object(B, "rest_get", mock.Mock(side_effect=B.RestError("500"))), \
             mock.patch.object(B, "_abrir_inbox", mock.Mock(side_effect=AssertionError("nao abrir"))):
            self.assertEqual(B.main(), 1)


class AbrirInboxTest(unittest.TestCase):
    """`_abrir_inbox` e exercitado de verdade — o teste de main() mocka essa funcao, entao
    sem este caso o `readonly=True` nao seria verificado por nenhum teste de comportamento."""

    def _com_imap(self, fake):
        env = {"IMAP_HOST": "h", "IMAP_USER": "u", "IMAP_PASS": "p"}
        return (mock.patch.dict("os.environ", env, clear=False),
                mock.patch.object(B.imaplib, "IMAP4_SSL", lambda *a, **k: fake))

    def test_abre_a_caixa_em_modo_leitura(self):
        fake = FakeIMAP(b"")
        ctx_env, ctx_imap = self._com_imap(fake)
        with ctx_env, ctx_imap:
            B._abrir_inbox()
        self.assertIs(fake.readonly, True, "a caixa tem de ser aberta em EXAMINE")

    def test_recusa_abrir_quando_o_servidor_nega(self):
        fake = FakeIMAP(b"")
        fake.select = lambda caixa, readonly=False: ("NO", [b"denied"])
        ctx_env, ctx_imap = self._com_imap(fake)
        with ctx_env, ctx_imap, self.assertRaises(RuntimeError):
            B._abrir_inbox()


if __name__ == "__main__":
    unittest.main()
