"""Funcoes PURAS do backfill de documento fiscal — testadas por COMPORTAMENTO.

POR QUE ESTE ARQUIVO EXISTE
    As guardas de `test_fiscal_document_consistency.py` leem o SOURCE com regex: pegam regressao
    estrutural ("alguem reintroduziu o urlopen local"), mas nao executam nada — entao nao provam
    que a logica esta certa, so que a forma dela nao mudou. Estas quatro funcoes decidem a QUE
    E-MAIL um documento fiscal e atribuido, e isso vira dado gravado. Merecem teste de verdade.

O QUE ELAS RESOLVEM (achados A2/A3 do code review de 2026-08-01)
    `_provenance_index` guardava so o PRIMEIRO e-mail de cada prefixo, com o comentario dizendo
    que prefixo repetido eram "reenvios da mesma thread". Medido: falso em 22 de 82 colisoes —
    `safe_filename(subject, 30)` trunca o assunto e colapsa fornecedores distintos. E a
    verificacao de plausibilidade que validou o reparo das 68 linhas existia so no console de
    quem rodou.
"""

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "scripts"))

import supabase_rest as SR  # noqa: E402


def _carrega(nome: str, caminho: Path):
    """Importa o script por caminho, com nome UNICO em sys.modules.

    Nome unico de proposito: varios scripts do projeto se chamam `run.py`/`main`, e importar
    pelo nome curto colide entre suites (ja aconteceu com as skills).
    """
    spec = importlib.util.spec_from_file_location(nome, caminho)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[nome] = mod
    spec.loader.exec_module(mod)
    return mod


BF = _carrega("backfill_fiscal_mod", _ROOT / "scripts" / "backfill_fiscal_documents.py")
PG = _carrega("purge_orphan_mod", _ROOT / "scripts" / "purge_orphan_attachments.py")


def _email(sender: str, subject: str, quando: str, mid: str = "<m>") -> dict:
    return {"message_id": mid, "sender_email": sender, "subject": subject,
            "received_at": quando}


class ProvenanceIndexTest(unittest.TestCase):
    def test_agrupa_por_prefixo_e_guarda_TODOS(self):
        """A colisao tem de ficar VISIVEL — guardar so o primeiro a escondia."""
        idx = BF._provenance_index([
            _email("adm@x.com.br", "LE BIANCO - PAGAMENTO FORNECEDOR", "2026-07-10T09:00:00+00", "<a>"),
            _email("adm@x.com.br", "LE BIANCO - PAGAMENTO FORNECEDOR (NYBC)", "2026-07-10T14:00:00+00", "<b>"),
        ])
        self.assertEqual(len(idx), 1, "os dois assuntos deveriam colidir no mesmo prefixo")
        self.assertEqual(len(next(iter(idx.values()))), 2, "guardou so um — a colisao sumiu")

    def test_assuntos_distintos_ate_30_chars_NAO_colidem(self):
        idx = BF._provenance_index([
            _email("adm@x.com.br", "BOLETO ALFA", "2026-07-10T09:00:00+00"),
            _email("adm@x.com.br", "BOLETO BETA", "2026-07-10T09:00:00+00"),
        ])
        self.assertEqual(len(idx), 2)

    def test_email_sem_received_at_e_ignorado(self):
        """Sem data nao da para montar o prefixo — entrar com data vazia casaria errado."""
        self.assertEqual(BF._provenance_index([_email("a@b.c", "X", None)]), {})

    def test_o_prefixo_carrega_a_DATA(self):
        """E por isso que a colisao nunca erra o DIA: o filtro temporal da tool fica salvo."""
        idx = BF._provenance_index([_email("adm@x.com.br", "BOLETO", "2026-07-10T09:00:00+00")])
        self.assertIn("20260710_", next(iter(idx)))


class EmissaoPlausivelTest(unittest.TestCase):
    def test_email_no_mes_da_emissao_e_plausivel(self):
        self.assertTrue(BF._emissao_plausivel(
            _email("a@b.c", "X", "2026-07-20T09:00:00+00"), {"issue_yearmonth": "2607"}))

    def test_email_ate_seis_meses_depois_e_plausivel(self):
        self.assertTrue(BF._emissao_plausivel(
            _email("a@b.c", "X", "2026-12-01T09:00:00+00"), {"issue_yearmonth": "2607"}))

    def test_email_ANTES_da_emissao_nao_e_plausivel(self):
        """Documento nao chega por e-mail antes de ser emitido."""
        self.assertFalse(BF._emissao_plausivel(
            _email("a@b.c", "X", "2026-05-01T09:00:00+00"), {"issue_yearmonth": "2607"}))

    def test_email_muito_depois_nao_e_plausivel(self):
        self.assertFalse(BF._emissao_plausivel(
            _email("a@b.c", "X", "2027-06-01T09:00:00+00"), {"issue_yearmonth": "2607"}))

    def test_sem_base_para_julgar_NAO_inventa_rejeicao(self):
        """Ausencia de dado nao e evidencia de erro — rejeitar aqui perderia proveniencia boa."""
        casos = [
            (_email("a@b.c", "X", "2026-07-20T09:00:00+00"), {}),
            (_email("a@b.c", "X", None), {"issue_yearmonth": "2607"}),
            (_email("a@b.c", "X", "2026-07-20T09:00:00+00"), {"issue_yearmonth": "xx"}),
            (_email("a@b.c", "X", "2026-07-20T09:00:00+00"), {"issue_yearmonth": "2699"}),  # mes 99
        ]
        for email, doc in casos:
            with self.subTest(doc=doc):
                self.assertTrue(BF._emissao_plausivel(email, doc))


class MatchEmailTest(unittest.TestCase):
    def setUp(self):
        self.antigo = _email("adm@x.com.br", "CT-e AUTORIZADO", "2026-07-10T09:00:00+00", "<antigo>")
        self.novo = _email("adm@x.com.br", "CT-e AUTORIZADO (OUTRO)", "2026-07-10T14:00:00+00", "<novo>")
        self.idx = BF._provenance_index([self.antigo, self.novo])
        self.prefixo = next(iter(self.idx))

    def test_sem_doc_mantem_o_comportamento_historico(self):
        achado = BF._match_email(self.prefixo + "arq.pdf", self.idx)
        self.assertEqual(achado["message_id"], "<antigo>")

    def test_candidatos_que_COLIDEM_tem_sempre_a_MESMA_data(self):
        """A propriedade que limita o oraculo — e por isso ele REJEITA em vez de desempatar.

        O prefixo termina em `YYYYMMDD`, entao e-mails de dias diferentes NUNCA colidem. Como
        `_emissao_plausivel` julga por MES, todos os candidatos de uma colisao sao plausiveis
        juntos ou implausiveis juntos. Se esta propriedade cair (alguem tirar a data do prefixo),
        o comentario de `_match_email` passa a mentir — e este teste avisa.
        """
        idx = BF._provenance_index([
            _email("adm@x.com.br", "CT-e AUTORIZADO", "2026-01-10T09:00:00+00", "<jan>"),
            _email("adm@x.com.br", "CT-e AUTORIZADO (OUTRO)", "2026-07-10T14:00:00+00", "<jul>"),
        ])
        self.assertEqual(len(idx), 2, "e-mails de dias diferentes NAO deveriam colidir")
        for candidatos in idx.values():
            datas = {e["received_at"][:10] for e in candidatos}
            self.assertEqual(len(datas), 1)

    def test_com_doc_plausivel_entre_candidatos_do_mesmo_dia_fica_o_mais_antigo(self):
        achado = BF._match_email(self.prefixo + "arq.pdf", self.idx, {"issue_yearmonth": "2607"})
        self.assertEqual(achado["message_id"], "<antigo>")

    def test_nenhum_candidato_plausivel_devolve_VAZIO(self):
        """Proveniencia errada e pior que ausente — parece correta."""
        achado = BF._match_email(self.prefixo + "arq.pdf", self.idx,
                                 {"issue_yearmonth": "2001"})   # jan/2020, longe demais
        self.assertEqual(achado, {})

    def test_nome_que_nao_casa_prefixo_nenhum_devolve_vazio(self):
        self.assertEqual(BF._match_email("outro_arquivo.pdf", self.idx, None), {})

    def test_prefixo_sem_colisao_com_doc_plausivel(self):
        idx = BF._provenance_index([self.antigo])
        achado = BF._match_email(next(iter(idx)) + "a.pdf", idx, {"issue_yearmonth": "2607"})
        self.assertEqual(achado["message_id"], "<antigo>")


class ErroSourceFilesTest(unittest.TestCase):
    """A purga preserva o objeto citado em `email_processing_errors` — pela CHAVE, nao substring."""

    def test_extrai_source_file_dos_payloads(self):
        nomes = PG._erro_source_files([
            {"raw_payload": {"source_file": "a.pdf", "subject": "x"}},
            {"raw_payload": {"source_file": "b.pdf"}},
        ])
        self.assertEqual(nomes, {"a.pdf", "b.pdf"})

    def test_ignora_payload_sem_source_file_ou_malformado(self):
        nomes = PG._erro_source_files([
            {"raw_payload": {"subject": "sem arquivo"}},
            {"raw_payload": None},
            {"raw_payload": "texto solto"},
            {},
            {"raw_payload": {"source_file": ""}},
        ])
        self.assertEqual(nomes, set())

    def test_nao_casa_nome_por_substring(self):
        """O `nome in erros_txt` antigo preservaria 'a.pdf' por causa de 'outro_a.pdf'."""
        nomes = PG._erro_source_files([{"raw_payload": {"source_file": "outro_a.pdf"}}])
        self.assertNotIn("a.pdf", nomes)


class ProtectedPrefixesTest(unittest.TestCase):
    """Objeto de e-mail em pendente/falha nunca e apagado — a regra vive neste prefixo."""

    def test_so_pendente_e_falha_entram(self):
        emails = [
            {"status": "pendente", "sender_email": "a@x.com", "subject": "S", "received_at": "2026-07-10T00:00:00+00"},
            {"status": "falha", "sender_email": "b@x.com", "subject": "S", "received_at": "2026-07-10T00:00:00+00"},
            {"status": "extraído", "sender_email": "c@x.com", "subject": "S", "received_at": "2026-07-10T00:00:00+00"},
        ]
        pref = PG._protected_prefixes(emails)
        self.assertEqual(len(pref), 2)
        self.assertTrue(all("_20260710_" in p for p in pref))

    def test_sem_received_at_nao_gera_prefixo(self):
        self.assertEqual(PG._protected_prefixes(
            [{"status": "falha", "sender_email": "a@x.com", "subject": "S"}]), [])


class FixProvenanceFluxoTest(unittest.TestCase):
    """O reparo em si — a operacao mais perigosa do script (UPDATE em tabela append-only).

    Com os acessos de rede substituidos por fakes, o que sobra e exatamente a decisao: QUAIS
    linhas sao tocadas, com QUE dados, e o que acontece quando o casamento nao fecha.
    """

    ORFA = {"id": 7, "access_key": "3" * 44, "storage_key": "adm_BOLETO_20260710_x.pdf",
            "issue_yearmonth": "2607"}
    EMAIL = {"message_id": "<m1>", "sender_email": "adm@x.com.br", "subject": "BOLETO",
             "received_at": "2026-07-10T09:00:00+00"}

    def _com_fakes(self, orfas, emails, patches=None):
        """Substitui as duas portas de rede: leitura (`_rest`) e escrita (`_patch_provenance`)."""
        registro = [] if patches is None else patches

        def fake_rest(path, order="id"):
            return emails if path.startswith("email_control") else orfas

        def fake_patch(row_id, email):
            registro.append((row_id, email))
            return True

        return patch.object(BF, "_rest", fake_rest), patch.object(BF, "_patch_provenance", fake_patch), registro

    def test_dry_run_NAO_grava(self):
        r1, r2, registro = self._com_fakes([self.ORFA], [self.EMAIL])
        with r1, r2:
            self.assertEqual(BF.fix_provenance(dry_run=True), 0)
        self.assertEqual(registro, [], "dry-run gravou")

    def test_aplica_e_leva_os_quatro_campos(self):
        r1, r2, registro = self._com_fakes([self.ORFA], [self.EMAIL])
        with r1, r2:
            self.assertEqual(BF.fix_provenance(dry_run=False), 0)
        self.assertEqual(len(registro), 1)
        row_id, email = registro[0]
        self.assertEqual(row_id, 7)
        self.assertEqual(email["message_id"], "<m1>")

    def test_sem_casamento_NAO_grava_nada(self):
        """Objeto cujo prefixo nao casa e-mail nenhum fica como esta — e e relatado."""
        orfa = {**self.ORFA, "storage_key": "desconhecido_9999.pdf"}
        r1, r2, registro = self._com_fakes([orfa], [self.EMAIL])
        with r1, r2:
            BF.fix_provenance(dry_run=False)
        self.assertEqual(registro, [], "gravou proveniencia inventada")

    def test_documento_de_outro_mes_e_RECUSADO(self):
        """O oraculo em acao: o prefixo casa, mas a emissao nao fecha com a data do e-mail."""
        orfa = {**self.ORFA, "issue_yearmonth": "2001"}      # jan/2020
        r1, r2, registro = self._com_fakes([orfa], [self.EMAIL])
        with r1, r2:
            BF.fix_provenance(dry_run=False)
        self.assertEqual(registro, [], "aceitou casamento implausivel")

    def test_nada_a_fazer_quando_nao_ha_orfas(self):
        r1, r2, registro = self._com_fakes([], [self.EMAIL])
        with r1, r2:
            self.assertEqual(BF.fix_provenance(dry_run=False), 0)
        self.assertEqual(registro, [])

    def test_falha_de_gravacao_faz_o_run_terminar_em_ERRO(self):
        """Exit code != 0 e o que faz a falha aparecer — silenciar seria pior que nao rodar."""
        def fake_rest(path, order="id"):
            return [self.EMAIL] if path.startswith("email_control") else [self.ORFA]

        with patch.object(BF, "_rest", fake_rest), \
             patch.object(BF, "_patch_provenance", lambda *_: False):
            self.assertEqual(BF.fix_provenance(dry_run=False), 1)


class MainDoBackfillTest(unittest.TestCase):
    """O laco central do backfill — varre o bucket, acha chave, grava.

    Ate agora so tinha sido exercitado a mao contra o bucket real. Com as portas de rede
    substituidas, o teste cobre as decisoes: o que e pulado, o que e gravado, e a idempotencia.
    """

    # Chave real de CT-e (dado publico de nota fiscal), a mesma de tests/test_fiscal_key.py.
    CTE = "35260792528538000434570000018980031498026869"
    EMAIL = {"message_id": "<m>", "sender_email": "sistemas@transp.com.br",
             "subject": "CT-e 1898003", "received_at": "2026-07-10T09:00:00+00"}

    def _roda(self, objetos, textos, ja_registradas=(), argv=("prog",)):
        gravados = []

        def fake_rest(path, order="id"):
            if path.startswith("email_control"):
                return [self.EMAIL]
            return [{"access_key": k} for k in ja_registradas]

        def fake_insert(doc, storage_key, email):
            gravados.append((doc["access_key"], storage_key, email.get("message_id")))
            return True

        with patch.object(BF, "_storage_list", lambda: objetos), \
             patch.object(BF, "_storage_get", lambda n: b"%PDF"), \
             patch.object(BF, "_pdf_text", lambda _d: textos.pop(0) if textos else ""), \
             patch.object(BF, "_rest", fake_rest), \
             patch.object(BF, "_insert", fake_insert), \
             patch.object(sys, "argv", list(argv)):
            rc = BF.main()
        return rc, gravados

    def test_grava_a_chave_encontrada_com_a_proveniencia(self):
        nome = "sistemas_CT-e_1898003_20260710_dacte.pdf"
        rc, gravados = self._roda([nome], [f"DACTE {self.CTE}"])
        self.assertEqual(rc, 0)
        self.assertEqual(len(gravados), 1)
        chave, storage_key, mid = gravados[0]
        self.assertEqual(chave, self.CTE)
        self.assertEqual(storage_key, nome)
        self.assertEqual(mid, "<m>")

    def test_chave_JA_registrada_nao_regrava(self):
        """Idempotencia: reexecutar o backfill nao duplica nem reporta gravacao falsa."""
        rc, gravados = self._roda(["sistemas_CT-e_1898003_20260710_a.pdf"],
                                  [f"DACTE {self.CTE}"], ja_registradas=[self.CTE])
        self.assertEqual(rc, 0)
        self.assertEqual(gravados, [])

    def test_pdf_sem_texto_e_sem_chave_sao_pulados(self):
        rc, gravados = self._roda(["a.pdf", "b.pdf"], ["", "Boleto 23793391009000000437507000842000"])
        self.assertEqual(rc, 0)
        self.assertEqual(gravados, [], "gravou algo que nao e chave de acesso")

    def test_dry_run_nao_grava(self):
        rc, gravados = self._roda(["sistemas_CT-e_1898003_20260710_a.pdf"],
                                  [f"DACTE {self.CTE}"], argv=("prog", "--dry-run"))
        self.assertEqual(rc, 0)
        self.assertEqual(gravados, [])

    def test_limit_reduz_o_conjunto_varrido(self):
        rc, gravados = self._roda(["a.pdf", "sistemas_CT-e_1898003_20260710_b.pdf"],
                                  ["", f"DACTE {self.CTE}"], argv=("prog", "--limit", "1"))
        self.assertEqual(rc, 0)
        self.assertEqual(gravados, [], "processou alem do --limit")

    def test_download_que_falha_nao_derruba_o_backfill(self):
        """Um objeto ilegivel nao pode custar os outros 500."""
        def cai(nome):
            raise OSError("bucket fora do ar")

        with patch.object(BF, "_storage_list", lambda: ["a.pdf"]), \
             patch.object(BF, "_storage_get", cai), \
             patch.object(BF, "_rest", lambda p, order="id": []), \
             patch.object(sys, "argv", ["prog"]):
            self.assertEqual(BF.main(), 0)


class SupabaseRestPortasTest(unittest.TestCase):
    """`storage_list` e `rest_write` — as portas que faltavam cobrir no modulo compartilhado."""

    def _fake(self, paginas):
        from contextlib import contextmanager
        import json as _json
        chamadas = []

        @contextmanager
        def fake(req, **_):
            chamadas.append(req)
            corpo = paginas[min(len(chamadas) - 1, len(paginas) - 1)]

            class _R:
                @staticmethod
                def read():
                    return _json.dumps(corpo).encode()
            yield _R()
        return fake, chamadas

    def test_storage_list_pula_placeholder_de_pasta(self):
        """`id` nulo e PASTA, nao objeto — foi o que colocou `manual/` na lista de APAGAR."""
        fake, _ = self._fake([[{"name": "a.pdf", "id": "1"}, {"name": "manual", "id": None}]])
        with patch.object(SR.urllib.request, "urlopen", fake):
            nomes = SR.storage_list("http://fake", {}, "attachments")
        self.assertEqual(nomes, ["a.pdf"])

    def test_storage_list_pagina(self):
        cheia = [{"name": f"f{i}.pdf", "id": str(i)} for i in range(SR.PAGE_SIZE)]
        fake, chamadas = self._fake([cheia, [{"name": "ultimo.pdf", "id": "x"}]])
        with patch.object(SR.urllib.request, "urlopen", fake):
            nomes = SR.storage_list("http://fake", {}, "attachments")
        self.assertEqual(len(nomes), SR.PAGE_SIZE + 1)
        self.assertEqual(len(chamadas), 2)

    def test_storage_list_pagina_vazia_encerra(self):
        fake, _ = self._fake([[]])
        with patch.object(SR.urllib.request, "urlopen", fake):
            self.assertEqual(SR.storage_list("http://fake", {}, "attachments"), [])

    def test_rest_write_devolve_o_corpo_quando_ha(self):
        fake, _ = self._fake([[{"id": 1}]])
        with patch.object(SR.urllib.request, "urlopen", fake):
            ok, corpo = SR.rest_write("http://fake", {}, "t", {"a": 1},
                                      prefer="return=representation")
        self.assertTrue(ok)
        self.assertEqual(corpo, [{"id": 1}])

    def test_rest_write_traduz_erro_HTTP_sem_levantar(self):
        import io as _io
        import urllib.error

        def cai(req, **_):
            raise urllib.error.HTTPError("u", 409, "Conflict", {}, _io.BytesIO(b"duplicada"))

        with patch.object(SR.urllib.request, "urlopen", cai):
            ok, motivo = SR.rest_write("http://fake", {}, "t", {"a": 1})
        self.assertFalse(ok)
        self.assertIn("409", motivo)

    def test_rest_get_respeita_order_ja_presente_no_path(self):
        """Dois `order=` deixariam o desempate a cargo do servidor."""
        fake, chamadas = self._fake([[]])
        with patch.object(SR.urllib.request, "urlopen", fake):
            SR.rest_get("http://fake", {}, "t?select=id&order=nome")
        self.assertEqual(chamadas[0].full_url.count("order="), 1)


if __name__ == "__main__":
    unittest.main()
