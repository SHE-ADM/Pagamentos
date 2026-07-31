"""Corpo COMPLETO do e-mail (Onda 2 / migration 105).

Ate esta onda o reader gravava so `body_preview` cortado em 500 chars, e a perda era ATIVA:
medido em 2026-07-31, 440 de 823 corpos (53%) estavam exatamente no teto, ou seja, truncados. O
texto perdido so existe no IMAP.

O que estes testes travam:
  - `body_full` recebe o corpo INTEIRO, sem o corte de 500;
  - `body_preview` CONTINUA truncado (e o preview da tela — nao regredir para "tudo completo");
  - corpo ausente vira None (NULL), nao string vazia: NULL significa "ainda nao temos o corpo";
  - o teto de sanidade corta e DECLARA o corte — corte silencioso e o defeito que a onda corrige.
"""

import json
import re
import sys
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"))

import read_emails as R  # noqa: E402


class BodyFullForStorageTest(unittest.TestCase):
    def test_corpo_curto_vai_inteiro(self):
        texto = "Prezados, segue o boleto da fatura 12345 com vencimento em 10/08."
        self.assertEqual(R._body_full_for_storage(texto), texto)

    def test_corpo_longo_nao_e_cortado_em_500(self):
        """O ponto da onda: 500 chars era o teto antigo e nao pode mais valer."""
        texto = "x" * 5000
        guardado = R._body_full_for_storage(texto)
        self.assertEqual(len(guardado), 5000)
        self.assertNotIn("TRUNCADO", guardado)

    def test_vazio_e_none_viram_none(self):
        """NULL diz 'ainda nao temos o corpo'; string vazia diria 'o corpo e vazio'."""
        self.assertIsNone(R._body_full_for_storage(""))
        self.assertIsNone(R._body_full_for_storage(None))

    def test_acima_do_teto_corta_e_DECLARA_o_corte(self):
        texto = "y" * (R.BODY_FULL_MAX_CHARS + 5000)
        guardado = R._body_full_for_storage(texto)

        self.assertIn("CORPO TRUNCADO", guardado)
        self.assertIn(str(R.BODY_FULL_MAX_CHARS), guardado)
        # o conteudo preservado e exatamente o teto (o resto e a marca)
        self.assertTrue(guardado.startswith("y" * R.BODY_FULL_MAX_CHARS))

    def test_teto_e_alto_o_bastante_para_email_real(self):
        """O maior corpo ja gravado tem ~11 KB. Um teto que cortasse e-mail real reintroduziria o
        problema que esta onda resolve."""
        self.assertGreaterEqual(R.BODY_FULL_MAX_CHARS, 50_000)

    def test_teto_cabe_no_limite_do_tsvector(self):
        """`body_search` e uma coluna GERADA por to_tsvector, e tsvector estoura em 1 MB —
        estourar nao devolve resultado ruim, QUEBRA o INSERT.

        Medido no banco no pior caso (lexemas todos unicos): 100 KB de texto -> tsvector de ~128 KB,
        12% do limite. Este teste trava o teto abaixo de 200 KB para que um aumento futuro nao
        chegue perto da borda sem alguem reparar.
        """
        self.assertLessEqual(R.BODY_FULL_MAX_CHARS, 200_000)

    def test_teto_do_python_nao_excede_o_teto_do_SQL(self):
        """GUARDA CROSS-LAYER — o teto vive em DUAS camadas e nada mais garante que sejam coerentes.

        - Python (`BODY_FULL_MAX_CHARS`): quanto do corpo GUARDAR.
        - SQL (`left(..., N)` na expressao gerada de `body_search`): quanto INDEXAR.

        Se o teto do Python ficar MAIOR que o do SQL, o excedente e gravado mas **nao entra no
        indice** — e a busca passa a responder "nao encontrado" para um termo que esta no banco,
        sem erro e sem sinal. O contrario e inofensivo (guarda-se menos do que se indexaria).

        O teste anterior checava so `<= 200_000`, um numero magico que nao observa o SQL: subir o
        teto do Python para 150 KB o manteria verde enquanto 50 KB deixariam de ser pesquisaveis.

        Localiza a migration pelo CONTEUDO (a que cria `body_search`), nao pelo nome, para
        sobreviver a um rename do arquivo.
        """
        migracoes = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
        alvos = [p for p in migracoes.glob("*.sql")
                 if "GENERATED ALWAYS AS" in p.read_text(encoding="utf-8")
                 and "body_search" in p.read_text(encoding="utf-8")]
        self.assertEqual(len(alvos), 1, "esperava exatamente 1 migration definindo body_search")

        sql = alvos[0].read_text(encoding="utf-8")
        achados = re.findall(r"left\(COALESCE\(subject.*?,\s*(\d+)\s*\)", sql, re.DOTALL)
        # Sanidade do parser: sem isto, um regex que parasse de casar deixaria o teste vazio e
        # sempre verde — exatamente o modo de falha que esta bateria existe para evitar.
        self.assertTrue(achados, "nao achei o teto do left(...) na expressao gerada")

        teto_sql = int(achados[0])
        self.assertLessEqual(
            R.BODY_FULL_MAX_CHARS, teto_sql,
            f"o reader guarda ate {R.BODY_FULL_MAX_CHARS} chars, mas o indice so cobre {teto_sql} — "
            "o excedente ficaria gravado e invisivel para a busca",
        )


class RegisterPayloadTest(unittest.TestCase):
    """`SupabaseControl.register` monta o payload enviado ao PostgREST."""

    def _payload(self, rec):
        """Captura o payload REAL enviado ao PostgREST, sem tocar a rede.

        Intercepta em `urlopen` (e nao num metodo interno) de proposito: e o ponto onde o corpo
        ja foi serializado, entao o teste valida o JSON que de fato sairia — nao uma
        representacao intermediaria que poderia divergir do que e enviado.
        """
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl._available = True
        ctrl.base = "https://fake.supabase.co"
        ctrl.headers = {"apikey": "x"}
        capturado = {}

        def _fake_urlopen(req, *_args, **_kwargs):
            capturado["payload"] = json.loads(req.data.decode())
            return unittest.mock.MagicMock()

        with unittest.mock.patch.object(R.urllib.request, "urlopen", _fake_urlopen):
            ctrl.register(rec)
        return capturado.get("payload")

    def test_preview_truncado_e_full_inteiro_convivem(self):
        corpo = "z" * 3000
        payload = self._payload({
            "message_id": "<a@b>", "subject": "Boleto", "body_preview": corpo, "body_full": corpo,
        })
        self.assertIsNotNone(payload)
        # o preview e cortado; o full nao.
        self.assertEqual(len(payload["body_preview"]), 500)
        self.assertEqual(len(payload["body_full"]), 3000)

    def test_body_full_ausente_vira_none(self):
        """E-mail 'ignorado' por falta de keyword nao tem o corpo baixado — a coluna fica NULL,
        e NULL e o que a busca textual precisa distinguir de 'corpo vazio'."""
        payload = self._payload({"message_id": "<a@b>", "subject": "Newsletter"})
        self.assertIsNone(payload["body_full"])


class ReprocessSaveBodyFullTest(unittest.TestCase):
    """`scripts/reprocess_body_emails.py` — o SEGUNDO caminho que grava o corpo.

    Ele rebusca o corpo inteiro do IMAP para reprocessar e-mails em 'falha' e, ate a Onda 2,
    DESCARTAVA esse texto (gravava so os 500 chars do preview). Era a mesma perda que a onda
    corrigiu no reader, sobrevivendo por outro caminho.
    """

    @staticmethod
    def _modulo():
        """Importa o script com nome de modulo UNICO.

        `import reprocess_body_emails` via sys.path colidiria em sys.modules com outros scripts de
        mesmo nome-base — foi o que ja poluiu a suite quando varias skills tinham `run.py`.
        """
        import importlib.util
        caminho = Path(__file__).resolve().parents[1] / "scripts" / "reprocess_body_emails.py"
        spec = importlib.util.spec_from_file_location("reprocess_body_emails_mod", caminho)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def _ctrl(self):
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl._available = True
        ctrl.base = "https://fake.supabase.co"
        ctrl.headers = {"apikey": "x"}
        return ctrl

    def test_persiste_o_corpo_rebuscado_do_imap(self):
        mod = self._modulo()
        capturado = {}

        def _fake_urlopen(req, *_a, **_k):
            capturado["url"] = req.full_url
            capturado["metodo"] = req.get_method()
            capturado["payload"] = json.loads(req.data.decode())
            return unittest.mock.MagicMock()

        with unittest.mock.patch.object(mod.urllib.request, "urlopen", _fake_urlopen):
            mod.save_body_full(self._ctrl(), 42, "corpo inteiro rebuscado do IMAP")

        self.assertEqual(capturado["metodo"], "PATCH")
        self.assertIn("id=eq.42", capturado["url"])
        self.assertEqual(capturado["payload"], {"body_full": "corpo inteiro rebuscado do IMAP"})

    def test_corpo_vazio_nao_gera_requisicao(self):
        """Sem corpo nao ha o que gravar — e um PATCH com None sobrescreveria com NULL um corpo
        que outro caminho ja tivesse capturado."""
        mod = self._modulo()
        chamou = []

        with unittest.mock.patch.object(
            mod.urllib.request, "urlopen", lambda *_a, **_k: chamou.append(1)
        ):
            mod.save_body_full(self._ctrl(), 42, "")
            mod.save_body_full(self._ctrl(), 42, None)

        self.assertEqual(chamou, [])

    def test_falha_de_rede_nao_derruba_o_reprocessamento(self):
        """Best-effort: gravar o corpo e um bonus, nao o proposito do script. Se o PATCH falhar, o
        reprocessamento (que extrai a conta) tem de seguir."""
        mod = self._modulo()

        def _explode(*_a, **_k):
            raise OSError("conexao recusada")

        with unittest.mock.patch.object(mod.urllib.request, "urlopen", _explode), \
             unittest.mock.patch.object(mod.log, "exception") as log_exc:
            mod.save_body_full(self._ctrl(), 42, "corpo")   # nao pode levantar

        log_exc.assert_called_once()   # mas a falha fica RASTREAVEL, nunca silenciosa

    def test_grava_o_corpo_em_TODOS_os_desfechos(self):
        """O corpo interessa em TODOS os desfechos — inclusive quando o reprocessamento NAO gera
        conta (BODY_NONE, que mantem o e-mail em 'falha').

        Amarrar a gravacao a um ramo especifico deixaria justamente os e-mails problematicos sem
        corpo — e sao eles que mais precisam de analise. Este teste percorre os 4 desfechos.

        (O nome diz o que este teste de fato verifica. Ele NAO prova a ordem em relacao ao
        try_extract_from_body — isso e o teste seguinte, e por um motivo concreto.)
        """
        mod = self._modulo()
        ec = {"id": 99, "message_id": "<x@y>", "received_at": "2026-07-31T10:00:00Z",
              "sender_email": "a@b.com", "sender_name": "A", "subject": "Boleto"}

        for desfecho in (R.BODY_CREATED, R.BODY_DUPLICATE, R.BODY_IGNORED, R.BODY_NONE):
            with self.subTest(desfecho=desfecho):
                gravou = []
                with unittest.mock.patch.object(mod, "save_body_full",
                                                lambda _c, _i, b: gravou.append(b)), \
                     unittest.mock.patch.object(mod.R, "try_extract_from_body",
                                                lambda *_a, **_k: desfecho), \
                     unittest.mock.patch.object(mod, "set_email_status", lambda *_a, **_k: None), \
                     unittest.mock.patch.object(mod.R.SupabaseControl, "register_error",
                                                lambda *_a, **_k: True):
                    mod.process_one(self._ctrl(), ec, "corpo do e-mail")

                self.assertEqual(gravou, ["corpo do e-mail"],
                                 f"o corpo nao foi gravado no desfecho {desfecho}")

    def test_corpo_sobrevive_a_excecao_na_extracao(self):
        """Prova que a gravacao acontece ANTES do `try_extract_from_body` — pelo COMPORTAMENTO,
        nao inspecionando a ordem das chamadas.

        POR QUE A ORDEM IMPORTA (nao e preferencia estetica): se a gravacao ficasse depois, uma
        excecao na extracao levaria junto o corpo que ja tinha sido baixado do IMAP — e seria
        preciso rebusca-lo. Como o script roda sobre e-mails em 'falha', que sao os que mais
        quebram a extracao, esse e justamente o caso mais provavel.

        O teste falha se alguem mover a chamada para depois da extracao.
        """
        mod = self._modulo()
        ec = {"id": 99, "message_id": "<x@y>", "received_at": "2026-07-31T10:00:00Z",
              "sender_email": "a@b.com", "sender_name": "A", "subject": "Boleto"}
        gravou = []

        def _explode_na_extracao(*_a, **_k):
            raise RuntimeError("extracao quebrou no meio")

        with unittest.mock.patch.object(mod, "save_body_full",
                                        lambda _c, _i, b: gravou.append(b)), \
             unittest.mock.patch.object(mod.R, "try_extract_from_body", _explode_na_extracao):
            with self.assertRaises(RuntimeError):
                mod.process_one(self._ctrl(), ec, "corpo que nao pode se perder")

        self.assertEqual(gravou, ["corpo que nao pode se perder"],
                         "o corpo foi perdido — a gravacao deve preceder a extracao")

    def test_aplica_o_MESMO_teto_do_reader(self):
        """Reusa `_body_full_for_storage` em vez de duplicar a regra: dois tetos divergiriam."""
        mod = self._modulo()
        capturado = {}

        def _fake_urlopen(req, *_a, **_k):
            capturado["payload"] = json.loads(req.data.decode())
            return unittest.mock.MagicMock()

        gigante = "z" * (R.BODY_FULL_MAX_CHARS + 1000)
        with unittest.mock.patch.object(mod.urllib.request, "urlopen", _fake_urlopen):
            mod.save_body_full(self._ctrl(), 7, gigante)

        self.assertIn("CORPO TRUNCADO", capturado["payload"]["body_full"])


if __name__ == "__main__":
    unittest.main()
