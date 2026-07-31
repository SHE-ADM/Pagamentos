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
        chegue perto da borda sem alguem reparar. A defesa real esta na propria expressao gerada
        (`left(..., 100000)` na migration 105), porque o reader nao e o unico caminho de escrita.
        """
        self.assertLessEqual(R.BODY_FULL_MAX_CHARS, 200_000)


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

        def _fake_urlopen(req, *args, **kwargs):
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


if __name__ == "__main__":
    unittest.main()
