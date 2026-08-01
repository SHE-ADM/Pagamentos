"""Guardas CROSS-LAYER da Onda 3 — o que nao pode divergir entre arquivos.

Sao duas invariantes que, se quebradas, falham LONGE do lugar da mudanca:

  A. Dominio de modelo: `FISCAL_MODELS` (fiscal_key.py) tem de ser IGUAL ao CHECK da
     migration 107. Divergir aqui nao da erro no dev: da 23514 em producao, no meio da
     leitura de e-mails, quando um modelo novo aparecer.

  B. A purga tem de consultar `fiscal_document`. Esta e a guarda mais importante da onda:
     `purge_orphan_attachments.py` considera orfao todo objeto sem linha em anexo/conta —
     e CT-e sem boleto, por regra de negocio, NUNCA tem nenhuma das duas. Sem a terceira
     fonte a purga apaga exatamente os PDFs que a onda registrou, de forma IRREVERSIVEL e
     reportando "orfaos removidos" com naturalidade. Nao ha erro para observar depois; a
     unica defesa possivel e esta, antes.

Ambas fazem parsing, entao ambas carregam SANIDADE DO PARSER: um regex que para de casar
transformaria a guarda em `0 == 0`, verde para sempre (licao O9-O11 da Onda 2).
"""

import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(_ROOT / "scripts"))

import fiscal_key as F  # noqa: E402
import supabase_rest as SR  # noqa: E402

_MIGRATION = _ROOT / "supabase" / "migrations" / "107_fiscal_document.sql"
_PURGE = _ROOT / "scripts" / "purge_orphan_attachments.py"
_BACKFILL = _ROOT / "scripts" / "backfill_fiscal_documents.py"
_SHARED = _ROOT / "scripts" / "supabase_rest.py"


class ModelDomainTest(unittest.TestCase):
    def _check_models(self) -> set[int]:
        txt = _MIGRATION.read_text(encoding="utf-8")
        m = re.search(r"CHECK \(model IN \(([^)]*)\)\)", txt)
        self.assertIsNotNone(m, "CHECK de model nao encontrado na migration 107 — parser cego")
        return {int(d) for d in re.findall(r"\d+", m.group(1))}

    def test_sanidade_do_parser(self):
        """Se o regex parar de casar, os testes abaixo viram tautologia."""
        self.assertTrue(_MIGRATION.exists(), "migration 107 sumiu ou foi renumerada")
        self.assertGreaterEqual(len(self._check_models()), 4)

    def test_dominio_do_python_e_igual_ao_check_do_banco(self):
        self.assertEqual(set(F.FISCAL_MODELS), self._check_models())

    def test_modelos_esperados(self):
        """Trava o conteudo, nao so a igualdade: NFS-e nao entra (e municipal, sem chave)."""
        self.assertEqual(set(F.FISCAL_MODELS), {55, 57, 59, 65})

    def test_a_migration_aponta_para_ESTE_arquivo(self):
        """O ponteiro que a 107 da para o teste-guarda tem de ser NAVEGAVEL.

        A migration diz "ha teste cross-layer (<caminho>)" — e o caminho estava ERRADO: apontava
        para `test_fiscal_key_domain_consistency.py`, que nunca existiu (o arquivo foi renomeado
        ao ganhar a 2a guarda e o comentario ficou para tras). Um ponteiro quebrado e pior que
        nenhum: quem for verificar a invariante conclui que a guarda nao existe.

        Usa `__file__` de proposito, nao o nome literal — assim um rename futuro deste arquivo
        derruba o teste em vez de silenciosamente reintroduzir o mesmo defeito.
        """
        eu = Path(__file__).name
        self.assertIn(eu, _MIGRATION.read_text(encoding="utf-8"),
                      f"a migration 107 nao cita {eu} — ponteiro quebrado de novo?")


class PurgaPreservaDocumentoFiscalTest(unittest.TestCase):
    def setUp(self):
        self.src = _PURGE.read_text(encoding="utf-8")

    def test_sanidade_do_parser(self):
        """As duas fontes ANTIGAS ainda estao la — prova de que o arquivo lido e o certo."""
        self.assertIn("financial_account_attachment?select=storage_key", self.src)
        self.assertIn("financial_account_control?select=source_file", self.src)

    def test_purga_consulta_fiscal_document(self):
        self.assertIn("fiscal_document?select=storage_key", self.src)

    def test_chaves_fiscais_entram_no_conjunto_de_referenciados(self):
        """Nao basta CONSULTAR: o resultado tem de entrar na conta de 'referenciado'.

        Consultar e nao usar seria pior que nao consultar — pareceria resolvido.
        """
        m = re.search(r"referenciados\s*=\s*([^\n]+)", self.src)
        self.assertIsNotNone(m, "variavel 'referenciados' nao encontrada — parser cego")
        self.assertIn("fiscais", m.group(1))
        self.assertIn("anexos", m.group(1))
        self.assertIn("sources", m.group(1))

    def test_orfao_e_calculado_a_partir_dos_referenciados(self):
        self.assertRegex(self.src, r"orfaos\s*=\s*\[n for n in objetos if n not in referenciados\]")


class PaginacaoCompartilhadaTest(unittest.TestCase):
    """A paginacao vive em UM lugar (`scripts/supabase_rest.py`) — e nenhum script pode copia-la.

    CONSULTAR nao basta: o conjunto tem de vir COMPLETO. O PostgREST corta a resposta no "Max
    rows" do projeto (1000) e devolve HTTP 200 — sem erro e sem sinal. Truncado, `fiscais` perde
    chaves e a purga apaga o PDF fiscal correspondente; truncados, `anexos`/`sources` transformam
    objeto referenciado em falso orfao. Medido em 2026-08-01: `email_control` ja devolvia 1000
    de 1158.

    A guarda mudou de forma junto com o codigo: antes exigia paginacao DENTRO de cada script;
    hoje exige que o modulo pagine e que nenhum script tenha reintroduzido um `urlopen` proprio.
    Trava a GARANTIA, nao o endereco dela.
    """

    def setUp(self):
        self.shared = _SHARED.read_text(encoding="utf-8")

    def test_sanidade_do_parser(self):
        """Se os nomes sumirem, os testes abaixo viram tautologia."""
        self.assertTrue(_SHARED.exists(), "scripts/supabase_rest.py sumiu ou foi renomeado")
        for fn in ("def rest_get(", "def storage_list(", "def rest_write("):
            self.assertIn(fn, self.shared, f"{fn} nao encontrada — parser cego")

    def test_o_modulo_pagina(self):
        # `offset|Range`: as duas formas de paginar o PostgREST sao corretas. Travar so `offset`
        # reprovaria um fix legitimo por header `Range`.
        for fn in ("rest_get", "storage_list"):
            corpo = re.search(rf"def {fn}\(.*?(?=\ndef |\Z)", self.shared, re.S)
            with self.subTest(fn=fn):
                self.assertRegex(corpo.group(0), r"offset|Range",
                                 f"{fn} voltou a ser um GET unico (sem paginar)")

    def test_o_modulo_tem_teto_de_paginas(self):
        """Sem teto, servidor que ignora o `offset` gera laco infinito — travar e pior que errar."""
        self.assertIn("MAX_PAGES", self.shared)

    def test_o_modulo_trata_falha_de_REDE_e_nao_so_HTTP(self):
        """`except HTTPError` sozinho deixa timeout/DNS propagarem e derrubarem o laco.

        `HTTPError` e subclasse de `URLError`, mas o inverso NAO vale — foi assim que um blip de
        rede podia abortar 515 downloads no meio.
        """
        self.assertRegex(self.shared, r"NETWORK_ERRORS\s*=\s*\(.*URLError", "sem captura de rede")
        self.assertIn("except NETWORK_ERRORS", self.shared)

    def test_nenhum_script_reintroduziu_a_copia(self):
        """O defeito original foi CORRIGIDO DUAS VEZES por existir em duas copias."""
        for arquivo in (_PURGE, _BACKFILL):
            src = arquivo.read_text(encoding="utf-8")
            with self.subTest(arquivo=arquivo.name):
                self.assertIn("from supabase_rest import", src, "parou de usar a fonte unica")
                corpo = re.search(r"def _rest\(.*?(?=\ndef )", src, re.S)
                self.assertIsNotNone(corpo, "funcao _rest nao encontrada — parser cego")
                # Sem a docstring: as duas funcoes EXPLICAM, em prosa, por que nao deve haver
                # `urlopen` local — e a guarda casaria a propria advertencia. Observar codigo
                # exige remover a prosa primeiro.
                codigo = re.sub(r'"""[\s\S]*?"""', "", corpo.group(0))
                self.assertNotIn("urlopen", codigo,
                                 "_rest voltou a ter urlopen proprio (copia do defeito)")


class RestGetFuncionalTest(unittest.TestCase):
    """Prova a paginacao pelo COMPORTAMENTO — a guarda textual acima nao basta.

    Validado por mutante: trocar `offset={pagina * PAGE_SIZE}` por `offset=0` quebra a paginacao
    de verdade e **passa** numa guarda que so procura a palavra `offset`. Contar linhas com um
    servidor falso e o unico jeito de observar a garantia em si.
    """

    def _fake_urlopen(self, total: int, registro: list):
        """Servidor falso: `total` linhas, respeitando `limit`/`offset` da query."""
        import json as _json
        from contextlib import contextmanager
        from urllib.parse import parse_qs, urlparse

        @contextmanager
        def fake(req, timeout=None):
            q = parse_qs(urlparse(req.full_url).query)
            offset = int(q.get("offset", ["0"])[0])
            limit = int(q.get("limit", ["1000"])[0])
            registro.append(offset)
            fatia = [{"id": i} for i in range(offset, min(offset + limit, total))]

            class _R:
                @staticmethod
                def read():
                    return _json.dumps(fatia).encode()
            yield _R()
        return fake

    def test_devolve_TODAS_as_linhas_alem_do_teto_de_1000(self):
        offsets: list = []
        with patch.object(SR.urllib.request, "urlopen", self._fake_urlopen(2350, offsets)):
            linhas = SR.rest_get("http://fake", {}, "tabela?select=id")
        self.assertEqual(len(linhas), 2350, "parou no teto — a paginacao nao avanca")
        self.assertEqual(offsets, [0, 1000, 2000], "offset nao avancou como esperado")

    def test_uma_pagina_incompleta_encerra_sem_chamada_extra(self):
        offsets: list = []
        with patch.object(SR.urllib.request, "urlopen", self._fake_urlopen(42, offsets)):
            linhas = SR.rest_get("http://fake", {}, "tabela?select=id")
        self.assertEqual(len(linhas), 42)
        self.assertEqual(offsets, [0], "pediu pagina a mais depois de resposta incompleta")

    def test_servidor_que_ignora_offset_levanta_em_vez_de_travar(self):
        """O caso que o MAX_PAGES existe para cobrir: laco infinito seria pior que erro."""
        import json as _json
        from contextlib import contextmanager

        @contextmanager
        def sempre_cheia(req, timeout=None):
            class _R:
                @staticmethod
                def read():
                    return _json.dumps([{"id": 1}] * SR.PAGE_SIZE).encode()
            yield _R()

        with patch.object(SR.urllib.request, "urlopen", sempre_cheia):
            with self.assertRaises(SR.RestError):
                SR.rest_get("http://fake", {}, "tabela?select=id")

    def test_falha_de_rede_vira_RestError_e_nao_escapa_crua(self):
        import urllib.error

        def cai(req, timeout=None):
            raise urllib.error.URLError("timed out")

        with patch.object(SR.urllib.request, "urlopen", cai):
            with self.assertRaises(SR.RestError):
                SR.rest_get("http://fake", {}, "tabela?select=id")

    def test_rest_write_devolve_falso_em_vez_de_levantar(self):
        """Escrita item-a-item dentro de laco: uma falha nao pode derrubar os itens seguintes."""
        import urllib.error

        def cai(req, timeout=None):
            raise urllib.error.URLError("timed out")

        with patch.object(SR.urllib.request, "urlopen", cai):
            ok, motivo = SR.rest_write("http://fake", {}, "t", {"a": 1})
        self.assertFalse(ok)
        self.assertIn("rede", motivo)


class BackfillPaginaTest(unittest.TestCase):
    """O backfill le `email_control` para montar a proveniencia — e ela decide DADO GRAVADO.

    Sem paginar, os documentos cujo PDF veio de e-mail fora das primeiras 1000 linhas nascem com
    `sender_email`/`gmail_message_id`/`received_at` NULL, e a tool `documentos_fiscais` (que
    filtra por `received_at`) deixa de enxerga-los em qualquer pergunta com data. Aconteceu: 68
    das 172 linhas do primeiro backfill. E NAO se auto-corrige — `ignore-duplicates` ignora em
    vez de atualizar, entao reexecutar nao conserta.
    """

    def setUp(self):
        self.src = _BACKFILL.read_text(encoding="utf-8")

    def test_sanidade_do_parser(self):
        """A consulta que motiva a guarda ainda esta la — se sumir, o teste abaixo nao prova nada."""
        self.assertIn("email_control?select=", self.src)

    def test_o_oraculo_de_plausibilidade_e_usado_no_casamento(self):
        """A checagem AAMM x received_at existia so no console de quem rodou o reparo.

        `_match_email` sem `doc` volta a ser "o primeiro prefixo que casar" — e 82 dos 1015
        prefixos colidem, 22 deles com assunto de fornecedor DIFERENTE.
        """
        self.assertIn("def _emissao_plausivel(", self.src)
        self.assertRegex(self.src, r"_match_email\([^)]*,\s*idx,\s*(doc|row)\)",
                         "algum call site de _match_email deixou de passar o documento")
        self.assertIn("issue_yearmonth", self.src, "o select perdeu o campo do oraculo")


class FixProvenanceEConservadorTest(unittest.TestCase):
    """`--fix-provenance` corrige um erro de dado — e por isso precisa ser TIMIDO.

    Ele existe porque `ignore-duplicates` ignora em vez de atualizar, entao a linha gravada com
    proveniencia nula nunca se conserta sozinha. Mas UPDATE numa tabela append-only e a operacao
    mais perigosa deste script: as duas invariantes abaixo sao o que impedem que ele deixe de ser
    um reparo e vire uma reescrita.
    """

    def setUp(self):
        self.src = _BACKFILL.read_text(encoding="utf-8")
        corpo = re.search(r"def _patch_provenance\(.*?(?=\ndef )", self.src, re.S)
        self.assertIsNotNone(corpo, "funcao _patch_provenance nao encontrada — parser cego")
        self.patch_body = corpo.group(0)

    def test_so_alcanca_linha_sem_proveniencia(self):
        """Sem o filtro, uma reexecucao reescreveria proveniencia BOA por um casamento novo."""
        self.assertIn("sender_email=is.null", self.src)

    def test_o_patch_nao_toca_a_identidade_do_documento(self):
        """`access_key`/`model`/`emitter_cnpj`/`storage_key` sao o documento — nao sao reparaveis.

        Se entrassem no payload, um prefixo casado por engano nao corrigiria a linha: trocaria
        de documento, silenciosamente, numa tabela cuja premissa e ser imutavel.
        """
        for campo in ("access_key", "model", "emitter_cnpj", "storage_key", "doc_number"):
            with self.subTest(campo=campo):
                self.assertNotIn(f'"{campo}"', self.patch_body)

    def test_o_patch_preenche_os_quatro_campos_de_proveniencia(self):
        for campo in ("gmail_message_id", "sender_email", "subject", "received_at"):
            with self.subTest(campo=campo):
                self.assertIn(f'"{campo}"', self.patch_body)


if __name__ == "__main__":
    unittest.main()
