# -*- coding: utf-8 -*-
"""Guardas do medidor mensal dos gatilhos da Onda 9 (skills/roadmap-gatilhos + migration 122).

O QUE ESTE ARQUIVO PROTEGE

  · 🔴 O DOMINIO DAS CHAVES atravessa duas camadas que ninguem compila junto: o dicionario
    `MEDIDORES` (Python) e o CHECK `chk_roadmap_trigger_key` (SQL). Acrescentar um gatilho so no
    script faz a gravacao falhar EM PRODUCAO, na tarefa agendada, um mes depois — e o unico sinal
    seria um exit code 1 num log que ninguem le. Guarda cross-layer resolve isso na hora.
  · Os LIMIARES sao decisao de produto. Um teste por gatilho fixa o comportamento nas duas
    bordas (logo abaixo e logo acima), para que mudar um numero seja deliberado.
  · O ISOLAMENTO entre medidores: um gatilho indisponivel nao pode custar a serie inteira, mas
    tambem nao pode ser engolido — tem de aparecer no exit code.
  · A CONTAGEM vem do header, nunca do corpo (a armadilha do "Max rows" da Onda 3).
  · (Onda 10) A COMPARACAO DE ESTADO entre medicoes e diagnostica: falha nela nunca vira exit
    code, mas tambem nunca e engolida em silencio (WARNING); e uma mudanca real de `fired` tem
    de se destacar (ERROR) sem nunca alterar o contrato 0/1 do exit code da tarefa agendada.

MECANISMO: o modulo e carregado por `importlib` com nome UNICO — varias skills tem `run.py`, e
importar pelo nome curto colidiria em `sys.modules` (foi o que ja poluiu a suite quando o teste da
baixa-automatica usou `import run`).
"""

import contextlib
import importlib.util
import io
import json
import re
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

RAIZ = Path(__file__).resolve().parents[1]
SCRIPT = RAIZ / "skills" / "roadmap-gatilhos" / "scripts" / "run.py"
MIGRACOES = RAIZ / "supabase" / "migrations"


def _carrega_modulo():
    spec = importlib.util.spec_from_file_location("roadmap_gatilhos_run", SCRIPT)
    assert spec and spec.loader, f"nao consegui carregar {SCRIPT}"
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


R = _carrega_modulo()


def _migration_do_snapshot() -> Path:
    """A migration localizada pelo CONTEUDO (o nome do CHECK), nunca pelo nome do arquivo."""
    alvos = sorted(p for p in MIGRACOES.glob("*.sql")
                   if "chk_roadmap_trigger_key" in p.read_text(encoding="utf-8"))
    assert alvos, "nenhuma migration define chk_roadmap_trigger_key"
    return alvos[-1]


class G1DominioCrossLayerTest(unittest.TestCase):
    """🔴 As chaves que o script GRAVA sao exatamente as que o banco ACEITA."""

    def _chaves_do_check(self) -> set[str]:
        sql = _migration_do_snapshot().read_text(encoding="utf-8")
        m = re.search(r"CHECK \(trigger_key IN \((.*?)\)\)", sql, re.DOTALL)
        assert m, "nao achei o CHECK do dominio (o formato mudou?)"
        return set(re.findall(r"'([a-z_]+)'", m.group(1)))

    def test_sanidade_do_parser(self):
        chaves = self._chaves_do_check()
        self.assertGreaterEqual(len(chaves), 5, f"esperava >= 5 chaves no CHECK, achei {chaves}")
        self.assertIn("nfse", chaves)

    def test_o_script_so_grava_chave_que_o_banco_aceita(self):
        do_script = set(R.MEDIDORES)
        fora = sorted(do_script - self._chaves_do_check())
        self.assertEqual(
            fora, [],
            f"o script mede gatilho(s) que o CHECK da migration recusa: {fora}. A gravacao "
            "falharia so na tarefa agendada, em producao.",
        )

    def test_o_banco_nao_espera_gatilho_que_o_script_nao_mede(self):
        """Serie que nunca recebe ponto e pior que ausencia: parece medida e esta parada."""
        faltando = sorted(self._chaves_do_check() - set(R.MEDIDORES))
        self.assertEqual(faltando, [], f"o CHECK preve gatilho(s) sem medidor: {faltando}")

    def test_sao_os_sete_da_onda(self):
        self.assertEqual(len(R.MEDIDORES), 7, "a Onda 9 tem 7 gatilhos condicionais")


class G2ContagemPeloHeaderTest(unittest.TestCase):
    """A contagem sai do `Content-Range`, nunca do corpo — a armadilha do 'Max rows'."""

    def test_usa_o_total_do_header_e_ignora_o_corpo(self):
        # O corpo traz UMA linha (o Range 0-0 pede so a primeira); o total real e 1.303. Contar o
        # corpo devolveria 1 — numero menor, com cara de certo, sem erro nenhum.
        with mock.patch.object(R, "_request",
                               return_value=(206, {"Content-Range": "0-0/1303"}, b'[{"id":1}]')):
            self.assertEqual(R._contar("http://x", "k", "email_control"), 1303)

    def test_pede_count_exact_e_nao_traz_linhas(self):
        capturado = {}

        def falso(url, key, **kw):
            capturado["url"] = url
            capturado["extra"] = kw.get("extra") or {}
            return (206, {"Content-Range": "0-0/7"}, b"[]")

        with mock.patch.object(R, "_request", side_effect=falso):
            R._contar("http://x", "k", "tabela", "status_id=eq.8")

        self.assertEqual(capturado["extra"].get("Prefer"), "count=exact")
        self.assertEqual(capturado["extra"].get("Range"), "0-0")
        self.assertIn("status_id=eq.8", capturado["url"])

    def test_total_ilegivel_vira_falha_explicita(self):
        """Header ausente/estranho nao pode virar zero silencioso — zero e um veredito."""
        with mock.patch.object(R, "_request", return_value=(200, {}, b"[]")):
            with self.assertRaises(R.MedicaoError):
                R._contar("http://x", "k", "tabela")


class G2bRetryHttpTest(unittest.TestCase):
    """🔴 429/5xx sao TRANSITORIOS e tem de ser repetidos; 4xx e definitivo e volta na hora.

    A serie e MENSAL: um 503 momentaneo tratado como definitivo deixa aquele gatilho sem ponto
    por 30 dias — buraco silencioso justamente no produto da rotina. Do outro lado, repetir um
    400 nao muda o resultado e so atrasa a tarefa (e adia o diagnostico do erro real).
    """

    class _Resp:
        """Resposta de sucesso: o `_request` usa `urlopen` como context manager."""

        def __init__(self, status=200, headers=None, corpo=b"[]"):
            self.status, self._h, self._c = status, headers or {}, corpo

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        @property
        def headers(self):
            return self._h

        def read(self):
            return self._c

    @staticmethod
    def _erro(codigo: int, corpo: bytes = b"erro"):
        return urllib.error.HTTPError("http://x", codigo, "erro", {}, io.BytesIO(corpo))

    def _chama(self, respostas):
        """Roda `_request` com a sequencia dada, sem dormir de verdade."""
        it = iter(respostas)

        def falso(req, timeout=None):
            item = next(it)
            if isinstance(item, Exception):
                raise item
            return item

        with mock.patch.object(R.urllib.request, "urlopen", side_effect=falso) as urlopen, \
             mock.patch.object(R.time, "sleep") as dormiu:
            resultado = R._request("http://x", "k")
        return resultado, urlopen, dormiu

    def test_503_e_repetido_e_a_2a_tentativa_vale(self):
        (status, _, corpo), urlopen, dormiu = self._chama(
            [self._erro(503), self._Resp(200, {}, b'[{"id":1}]')])
        self.assertEqual(status, 200)
        self.assertEqual(corpo, b'[{"id":1}]')
        self.assertEqual(urlopen.call_count, 2, "o 503 tinha de ser repetido")
        dormiu.assert_called_once()

    def test_429_tambem_e_repetido(self):
        (status, _, _), urlopen, _ = self._chama([self._erro(429), self._Resp(200)])
        self.assertEqual(status, 200)
        self.assertEqual(urlopen.call_count, 2)

    def test_400_NAO_e_repetido(self):
        """Definitivo: repetir so atrasa a tarefa e esconde o erro real."""
        (status, _, corpo), urlopen, dormiu = self._chama([self._erro(400, b"payload invalido")])
        self.assertEqual(status, 400)
        self.assertEqual(corpo, b"payload invalido")
        self.assertEqual(urlopen.call_count, 1)
        dormiu.assert_not_called()

    def test_503_persistente_devolve_o_status_em_vez_de_girar(self):
        """Esgotadas as tentativas, o codigo volta ao chamador — que o transforma em MedicaoError.

        Devolver (e nao levantar aqui) mantem a mensagem util: quem chama monta
        `<tabela>: HTTP 503 — <corpo>`, apontando QUAL medidor caiu e por que.
        """
        (status, _, _), urlopen, dormiu = self._chama(
            [self._erro(503) for _ in range(R.HTTP_MAX_ATTEMPTS)])
        self.assertEqual(status, 503)
        self.assertEqual(urlopen.call_count, R.HTTP_MAX_ATTEMPTS)
        self.assertEqual(dormiu.call_count, R.HTTP_MAX_ATTEMPTS - 1,
                         "nao se dorme depois da ULTIMA tentativa")

    def test_dominio_do_transitorio(self):
        """Sanidade do predicado — sem isto, as guardas acima poderiam medir outra coisa."""
        for codigo in (429, 500, 502, 503, 504, 599):
            self.assertTrue(R._http_transitorio(codigo), f"HTTP {codigo} deveria ser transitorio")
        for codigo in (200, 201, 206, 400, 401, 403, 404, 409, 422):
            self.assertFalse(R._http_transitorio(codigo), f"HTTP {codigo} nao e transitorio")


class G3LimiaresTest(unittest.TestCase):
    """Cada limiar fixado nas DUAS bordas: mudar um numero passa a ser deliberado."""

    def _com_contagens(self, valores: list[int], rpc=None):
        """Encadeia as contagens na ordem em que o medidor as pede."""
        it = iter(valores)
        return (mock.patch.object(R, "_contar", side_effect=lambda *a, **k: next(it)),
                mock.patch.object(R, "_rpc", return_value=rpc))

    def test_nfse_nao_dispara_logo_abaixo_do_limiar(self):
        c, _ = self._com_contagens([R.NFSE_MIN_CONTAS - 1, 5])
        with c:
            disparou, metricas, criterio = R.medir_nfse("u", "k")
        self.assertFalse(disparou)
        self.assertEqual(metricas["limiar"], R.NFSE_MIN_CONTAS)
        self.assertTrue(criterio.strip())

    def test_nfse_dispara_no_limiar(self):
        c, _ = self._com_contagens([R.NFSE_MIN_CONTAS, 5])
        with c:
            disparou, _, _ = R.medir_nfse("u", "k")
        self.assertTrue(disparou)

    def test_cfe_dispara_com_um_unico_documento(self):
        """O custo de entrada e baixo (o parser da Onda 3 ja aceita 59/65): o limiar e 1."""
        c, _ = self._com_contagens([0, 302])
        with c:
            self.assertFalse(R.medir_cfe_nfce("u", "k")[0])
        c, _ = self._com_contagens([1, 303])
        with c:
            self.assertTrue(R.medir_cfe_nfce("u", "k")[0])

    def test_text_to_sql_exige_AMOSTRA_antes_do_percentual(self):
        """Com amostra minuscula, 100 pct de erro ainda nao decide nada."""
        c, _ = self._com_contagens([5, 5, 0])          # 5 interacoes, todas com erro
        with c:
            disparou, metricas, _ = R.medir_text_to_sql("u", "k")
        self.assertFalse(disparou, "amostra insuficiente nao pode disparar")
        self.assertFalse(metricas["amostra_suficiente"])

    def test_text_to_sql_dispara_com_amostra_e_percentual(self):
        n = R.TEXT_TO_SQL_MIN_AMOSTRA
        c, _ = self._com_contagens([n, n // 5, 0])     # 20 pct com erro
        with c:
            disparou, metricas, _ = R.medir_text_to_sql("u", "k")
        self.assertTrue(disparou)
        self.assertGreaterEqual(metricas["pct_descoberto"], R.TEXT_TO_SQL_PCT_DESCOBERTO)

    def test_text_to_sql_declara_o_ponto_cego_no_criterio(self):
        """Pergunta que o modelo declarou nao cobrir fica com error nulo e conta como sucesso.

        Se o criterio nao disser isso, um `fired = false` sera lido como "as tools cobrem tudo".
        """
        c, _ = self._com_contagens([8, 0, 0])
        with c:
            _, _, criterio = R.medir_text_to_sql("u", "k")
        self.assertIn("ponto cego", criterio.lower())
        self.assertIn("revise", criterio.lower())

    def test_agregados_declara_que_mede_um_PROXY(self):
        """O gatilho real e latencia; medir volume e dizer que e latencia seria mentira."""
        c, _ = self._com_contagens([833, 302])
        with c:
            disparou, metricas, criterio = R.medir_tabelas_agregadas("u", "k")
        self.assertFalse(disparou)
        self.assertFalse(metricas["latencia_medida"])
        self.assertIn("proxy", criterio.lower())

    def test_gatilhos_decisorios_nunca_disparam_sozinhos(self):
        for medidor, contagens in ((R.medir_receitas_dre, [833, 0]),
                                   (R.medir_conciliacao, [662])):
            c, _ = self._com_contagens(contagens)
            with c:
                disparou, _, criterio = medidor("u", "k")
            self.assertFalse(disparou, f"{medidor.__name__} nao e mensuravel: nao pode disparar")
            self.assertTrue(criterio.strip())

    def test_pontualidade_le_a_data_de_corte_da_FONTE_UNICA(self):
        """Hardcodar a data aqui criaria a 2a fonte de verdade que a migration 121 impede."""
        c, rpc = self._com_contagens([662, 221], rpc="2026-07-29")
        with c, rpc as espiao:
            disparou, metricas, _ = R.medir_dpo_pontualidade("u", "k")
        self.assertTrue(disparou)
        self.assertEqual(metricas["corte"], "2026-07-29")
        espiao.assert_called_once()
        self.assertEqual(espiao.call_args[0][2], "payment_date_confiavel_desde")

    def test_pontualidade_recusa_data_de_corte_invalida(self):
        """Corte ilegivel para a medicao — nunca cai num default silencioso."""
        c, rpc = self._com_contagens([662, 221], rpc=None)
        with c, rpc:
            with self.assertRaises(R.MedicaoError):
                R.medir_dpo_pontualidade("u", "k")

    def test_TODO_medidor_devolve_criterio_util_e_metricas(self):
        """O criterio vai para o banco junto do veredito: vazio torna a serie inauditavel.

        🔴 Este teste ja foi decoracao: ele se chamava "nenhum medidor devolve criterio vazio" e
        asseverava `len(MEDIDORES) == 7` — nao olhava criterio nenhum. Passaria com todos os sete
        devolvendo string vazia. Agora EXECUTA os sete e observa o que eles devolvem, que e o que
        o nome sempre prometeu (Regra 2 do CLAUDE.md).
        """
        for chave, medidor in R.MEDIDORES.items():
            with mock.patch.object(R, "_contar", return_value=0), \
                 mock.patch.object(R, "_rpc", return_value="2026-07-29"):
                disparou, metricas, criterio = medidor("u", "k")

            self.assertIsInstance(disparou, bool, f"{chave}: veredito tem de ser booleano")
            self.assertIsInstance(metricas, dict, f"{chave}: metricas tem de ser dict (vai a jsonb)")
            self.assertGreaterEqual(len(criterio.strip()), 40,
                                    f"{chave}: criterio curto demais para ser auditavel depois")
            # As metricas viram jsonb: um valor nao-serializavel derrubaria a gravacao inteira,
            # levando junto os outros seis gatilhos daquela execucao.
            json.dumps(metricas)


class G4IsolamentoEExitCodeTest(unittest.TestCase):
    """Falha de um gatilho nao derruba os outros — mas tambem nao passa despercebida."""

    def _roda(self, argv, medidores, esgotado=None):
        """`gravar` devolve a lista de recusadas — o mock precisa devolver lista, nao Mock.

        `_buscar_estado_anterior` tambem e mockada (Onda 10): sem isso, `main()` faria uma
        requisicao HTTP REAL por gatilho medido com sucesso (a checagem roda a cada gatilho que a
        medicao NAO derrubou). None e o suficiente para os testes que nao exercitam a comparacao
        de estado — eles ficam com `mudou_desde_ultima_medicao = None`, que e o comportamento
        correto de "sem estado anterior conhecido".
        """
        esgotar = (mock.patch.object(R, "_tempo_esgotado", side_effect=esgotado)
                   if esgotado is not None else contextlib.nullcontext())
        with mock.patch.object(R, "_carrega_env", return_value=("http://x", "k")), \
             mock.patch.dict(R.MEDIDORES, medidores, clear=True), \
             mock.patch.object(R, "gravar", return_value=[]) as gravou, \
             mock.patch.object(R, "_buscar_estado_anterior", return_value=None), \
             esgotar:
            codigo = R.main(argv)
        return codigo, gravou

    def test_um_gatilho_quebrado_nao_impede_os_demais(self):
        medidores = {
            "nfse": lambda u, k: (False, {"n": 1}, "criterio"),
            "cfe_nfce": mock.Mock(side_effect=R.MedicaoError("indisponivel")),
            "text_to_sql": lambda u, k: (True, {"n": 2}, "criterio"),
        }
        codigo, gravou = self._roda([], medidores)

        self.assertEqual(codigo, 1, "falha tem de aparecer no exit code da tarefa agendada")
        gravadas = {l["trigger_key"] for l in gravou.call_args[0][2]}
        self.assertEqual(gravadas, {"nfse", "text_to_sql"},
                         "os gatilhos saudaveis tem de ser gravados assim mesmo")

    def test_erro_inesperado_tambem_e_isolado_e_contado(self):
        """Bug aqui nao pode se disfarcar de 'gatilho indisponivel' — vai com traceback."""
        medidores = {
            "nfse": lambda u, k: (False, {}, "criterio"),
            "cfe_nfce": mock.Mock(side_effect=TypeError("contrato mudou")),
        }
        with self.assertLogs(R.log, level="ERROR"):
            codigo, gravou = self._roda([], medidores)
        self.assertEqual(codigo, 1)
        self.assertEqual(len(gravou.call_args[0][2]), 1)

    def test_tudo_ok_sai_zero(self):
        codigo, gravou = self._roda([], {"nfse": lambda u, k: (False, {}, "c")})
        self.assertEqual(codigo, 0)
        gravou.assert_called_once()

    def test_dry_run_NAO_grava(self):
        codigo, gravou = self._roda(["--dry-run"], {"nfse": lambda u, k: (False, {}, "c")})
        self.assertEqual(codigo, 0)
        gravou.assert_not_called()

    def test_falha_de_gravacao_reprova_a_execucao(self):
        """Medir e nao gravar e pior que nao medir: a serie fica com buraco silencioso."""
        with mock.patch.object(R, "_carrega_env", return_value=("http://x", "k")), \
             mock.patch.dict(R.MEDIDORES, {"nfse": lambda u, k: (False, {}, "c")}, clear=True), \
             mock.patch.object(R, "gravar", side_effect=R.MedicaoError("403")), \
             mock.patch.object(R, "_buscar_estado_anterior", return_value=None):
            self.assertEqual(R.main([]), 1)

    def test_linha_recusada_na_gravacao_reprova_a_execucao(self):
        """Gravar 6 de 7 nao e sucesso: a serie ficou com um gatilho parado, e isso tem de doer."""
        with mock.patch.object(R, "_carrega_env", return_value=("http://x", "k")), \
             mock.patch.dict(R.MEDIDORES, {"nfse": lambda u, k: (False, {}, "c"),
                                           "cfe_nfce": lambda u, k: (False, {}, "c")},
                             clear=True), \
             mock.patch.object(R, "gravar", return_value=["cfe_nfce"]), \
             mock.patch.object(R, "_buscar_estado_anterior", return_value=None):
            with self.assertLogs(R.log, level="ERROR") as capturado:
                codigo = R.main([])
        self.assertEqual(codigo, 1)
        self.assertTrue(any("cfe_nfce" in m for m in capturado.output))

    def test_NENHUM_gatilho_medido_nao_diz_que_a_serie_foi_atualizada(self):
        """🔴 O log dizia "serie atualizada: 0 linha(s)" — que e mentira: nada foi gravado.

        O exit code ja seria 1, mas quem le o log de uma tarefa mensal tem de entender o que
        aconteceu sem cruzar com outra linha.
        """
        medidores = {"nfse": mock.Mock(side_effect=R.MedicaoError("indisponivel"))}
        with self.assertLogs(R.log, level="ERROR") as capturado:
            codigo, gravou = self._roda([], medidores)

        self.assertEqual(codigo, 1)
        gravou.assert_not_called()
        texto = "\n".join(capturado.output)
        self.assertIn("NADA gravado", texto)
        self.assertNotIn("serie atualizada", texto)

    def test_orcamento_de_tempo_para_a_medicao_e_conta_os_restantes(self):
        """🔴 Estourado o orcamento, o script para SOZINHO — nao espera o Agendador mata-lo.

        Morto pelo Agendador, o processo nao grava o que ja mediu, nao emite resumo e nao tem
        exit code proprio: a medicao do mes inteiro se perde por causa dos ultimos gatilhos.
        """
        medidores = {
            "nfse": lambda u, k: (False, {"n": 1}, "criterio"),
            "cfe_nfce": lambda u, k: (False, {"n": 2}, "criterio"),
            "text_to_sql": lambda u, k: (True, {"n": 3}, "criterio"),
        }
        # Cada gatilho MEDIDO com sucesso consulta o orcamento DUAS vezes (Onda 10): no topo do
        # laco (antes de medir) e antes da checagem diagnostica de estado anterior (depois de
        # medir). False, False, False, False -> mede nfse e cfe_nfce por inteiro (2 checks cada);
        # True -> para no topo do laco de text_to_sql, antes mesmo de medi-lo.
        with self.assertLogs(R.log, level="ERROR") as capturado:
            codigo, gravou = self._roda(
                [], medidores, esgotado=[False, False, False, False, True])

        self.assertEqual(codigo, 1, "gatilho nao medido tem de aparecer no exit code")
        gravadas = {l["trigger_key"] for l in gravou.call_args[0][2]}
        self.assertEqual(gravadas, {"nfse", "cfe_nfce"},
                         "o que JA foi medido tem de ser gravado assim mesmo")
        self.assertTrue(any("orcamento" in m and "text_to_sql" in m for m in capturado.output),
                        "o log tem de nomear os gatilhos que ficaram sem medicao")

    def test_sem_deadline_o_orcamento_nunca_esgota(self):
        """Sanidade: importar o modulo (teste, REPL) nao pode fazer a medicao parar sozinha."""
        deadline_original = R._deadline
        try:
            R._deadline = None
            self.assertFalse(R._tempo_esgotado())
        finally:
            R._deadline = deadline_original

    # -------------------------------------------------------------------
    # Onda 10 — comparacao de estado entre medicoes consecutivas
    # -------------------------------------------------------------------
    def test_gatilho_mudou_de_estado_loga_error_e_grava_no_metrics(self):
        """🔴 A mudanca de estado tem de se destacar no log E ficar gravada na propria linha."""
        with mock.patch.object(R, "_carrega_env", return_value=("http://x", "k")), \
             mock.patch.dict(R.MEDIDORES, {"cfe_nfce": lambda u, k: (True, {}, "c")},
                             clear=True), \
             mock.patch.object(R, "gravar", return_value=[]) as gravou, \
             mock.patch.object(R, "_buscar_estado_anterior", return_value=False):
            with self.assertLogs(R.log, level="ERROR") as capturado:
                codigo = R.main([])

        self.assertEqual(codigo, 0, "mudanca de estado NAO e falha — o exit code fica intocado")
        self.assertTrue(any("MUDANCA DE ESTADO" in m and "cfe_nfce" in m
                            for m in capturado.output))
        linha = gravou.call_args[0][2][0]
        self.assertIs(linha["metrics"]["mudou_desde_ultima_medicao"], True)

    def test_gatilho_que_nao_mudou_nao_gera_o_log_de_mudanca(self):
        with mock.patch.object(R, "_carrega_env", return_value=("http://x", "k")), \
             mock.patch.dict(R.MEDIDORES, {"cfe_nfce": lambda u, k: (True, {}, "c")},
                             clear=True), \
             mock.patch.object(R, "gravar", return_value=[]) as gravou, \
             mock.patch.object(R, "_buscar_estado_anterior", return_value=True):
            with self.assertLogs(R.log, level="INFO") as capturado:
                R.main([])

        self.assertFalse(any("MUDANCA DE ESTADO" in m for m in capturado.output))
        linha = gravou.call_args[0][2][0]
        self.assertIs(linha["metrics"]["mudou_desde_ultima_medicao"], False)

    def test_primeira_medicao_sem_estado_anterior_fica_None_e_nao_loga_mudanca(self):
        """`_roda` ja mocka `_buscar_estado_anterior` para None — o caso "1a medicao"."""
        with self.assertLogs(R.log, level="INFO") as capturado:
            codigo, gravou = self._roda([], {"cfe_nfce": lambda u, k: (True, {}, "c")})

        self.assertEqual(codigo, 0)
        self.assertFalse(any("MUDANCA DE ESTADO" in m for m in capturado.output))
        linha = gravou.call_args[0][2][0]
        self.assertIsNone(linha["metrics"]["mudou_desde_ultima_medicao"])

    def test_bug_interno_ao_buscar_estado_anterior_nao_derruba_o_gatilho(self):
        """Bug NOVO (Onda 10) nao pode se disfarcar de 'gatilho com falha' — so WARNING."""
        with mock.patch.object(R, "_carrega_env", return_value=("http://x", "k")), \
             mock.patch.dict(R.MEDIDORES, {"nfse": lambda u, k: (False, {}, "c")}, clear=True), \
             mock.patch.object(R, "gravar", return_value=[]) as gravou, \
             mock.patch.object(R, "_buscar_estado_anterior",
                               side_effect=RuntimeError("bug na checagem")):
            with self.assertLogs(R.log, level="WARNING") as capturado:
                codigo = R.main([])

        self.assertEqual(codigo, 0, "bug na checagem diagnostica nao pode reprovar a execucao")
        gravadas = {l["trigger_key"] for l in gravou.call_args[0][2]}
        self.assertEqual(gravadas, {"nfse"}, "o gatilho tem de ser gravado assim mesmo")
        self.assertTrue(any("falha inesperada" in m and "nfse" in m for m in capturado.output))

    def test_checagem_de_estado_e_pulada_com_orcamento_esgotado(self):
        """Esgotado o orcamento, a checagem diagnostica cede lugar — a medicao ja e o que importa.

        `esgotado=[False, True]`: o 1o check (topo do laco) libera a medicao; o 2o (antes da
        checagem diagnostica, apos medir) ja acusa esgotado — pula a checagem, `_buscar_estado_
        anterior` NUNCA e chamada.
        """
        with mock.patch.object(R, "_carrega_env", return_value=("http://x", "k")), \
             mock.patch.dict(R.MEDIDORES, {"nfse": lambda u, k: (False, {}, "c")}, clear=True), \
             mock.patch.object(R, "gravar", return_value=[]) as gravou, \
             mock.patch.object(R, "_buscar_estado_anterior") as busca, \
             mock.patch.object(R, "_tempo_esgotado", side_effect=[False, True]):
            codigo = R.main([])

        self.assertEqual(codigo, 0)
        busca.assert_not_called()
        linha = gravou.call_args[0][2][0]
        self.assertIsNone(linha["metrics"]["mudou_desde_ultima_medicao"])

    def test_resumo_final_lista_os_gatilhos_que_mudaram(self):
        # nfse: medidor devolve False, estado anterior era False -> nao mudou.
        # cfe_nfce: medidor devolve True, estado anterior era False -> mudou.
        anteriores = {"nfse": False, "cfe_nfce": False}
        with mock.patch.object(R, "_carrega_env", return_value=("http://x", "k")), \
             mock.patch.dict(R.MEDIDORES, {"nfse": lambda u, k: (False, {}, "c"),
                                           "cfe_nfce": lambda u, k: (True, {}, "c")},
                             clear=True), \
             mock.patch.object(R, "gravar", return_value=[]), \
             mock.patch.object(R, "_buscar_estado_anterior",
                               side_effect=lambda u, k, chave: anteriores[chave]):
            with self.assertLogs(R.log, level="INFO") as capturado:
                R.main([])

        resumo = next(m for m in capturado.output if "resumo:" in m)
        self.assertIn("mudou de estado: cfe_nfce", resumo)
        self.assertNotIn("nfse", resumo.rsplit("mudou de estado:", 1)[1])


class G5GravacaoTest(unittest.TestCase):
    """O UPSERT por dia e o que sustenta a serie."""

    def test_grava_com_merge_duplicates_e_on_conflict(self):
        capturado = {}

        def falso(url, key, **kw):
            capturado["url"] = url
            capturado["extra"] = kw.get("extra") or {}
            capturado["corpo"] = json.loads(kw["corpo"])
            return (204, {}, b"")

        with mock.patch.object(R, "_request", side_effect=falso):
            R.gravar("http://x", "k", [{"trigger_key": "nfse", "fired": False,
                                        "metrics": {}, "criterion": "c"}])

        self.assertIn("on_conflict=trigger_key,measured_on", capturado["url"])
        self.assertIn("resolution=merge-duplicates", capturado["extra"]["Prefer"])
        # Content-Profile (e nao Accept-Profile) e o header que seleciona o schema em POST.
        self.assertEqual(capturado["extra"]["Content-Profile"], "analytics")

    def test_lista_vazia_nao_faz_requisicao(self):
        with mock.patch.object(R, "_request") as req:
            R.gravar("http://x", "k", [])
        req.assert_not_called()

    def test_status_inesperado_vira_falha(self):
        with mock.patch.object(R, "_request", return_value=(403, {}, b"permission denied")):
            with self.assertRaises(R.MedicaoError):
                R.gravar("http://x", "k", [{"trigger_key": "nfse", "fired": False,
                                            "metrics": {}, "criterion": "c"}])

    def _linhas(self, *chaves):
        return [{"trigger_key": c, "fired": False, "metrics": {}, "criterion": "c"}
                for c in chaves]

    def test_lote_recusado_desmembra_e_isola_so_a_linha_CULPADA(self):
        """🔴 ISOLAMENTO ATE O ULTIMO PASSO.

        O laco de medicao ja isola um gatilho quebrado dos demais, mas a gravacao era um lote
        unico: UMA linha recusada (chave fora do dominio, metrica que o jsonb rejeita) levaria as
        outras seis junto e a serie perderia o mes inteiro por causa de um gatilho.
        """
        chamadas = []

        def falso(url, key, **kw):
            corpo = json.loads(kw["corpo"])
            chamadas.append([l["trigger_key"] for l in corpo])
            if len(corpo) > 1:                       # o lote inteiro
                return (400, {}, b"violates check constraint")
            if corpo[0]["trigger_key"] == "gatilho_ruim":
                return (400, {}, b"violates check constraint")
            return (201, {}, b"")

        with mock.patch.object(R, "_request", side_effect=falso):
            recusadas = R.gravar("http://x", "k",
                                 self._linhas("nfse", "gatilho_ruim", "cfe_nfce"))

        self.assertEqual(recusadas, ["gatilho_ruim"])
        self.assertEqual(chamadas[0], ["nfse", "gatilho_ruim", "cfe_nfce"], "1o tenta o lote")
        self.assertEqual(chamadas[1:], [["nfse"], ["gatilho_ruim"], ["cfe_nfce"]],
                         "depois tenta uma a uma, para que so a culpada fique de fora")

    def test_lote_OK_nao_desmembra(self):
        """O caminho normal continua sendo UMA requisicao — o desmembramento e excecao."""
        with mock.patch.object(R, "_request", return_value=(201, {}, b"")) as req:
            self.assertEqual(R.gravar("http://x", "k", self._linhas("nfse", "cfe_nfce")), [])
        req.assert_called_once()

    def test_falha_de_TRANSPORTE_no_desmembramento_nao_insiste(self):
        """Rede fora nao se resolve tentando 7 vezes — so gastaria o orcamento de tempo.

        O `_request` ja repetiu com backoff antes de levantar; o desmembramento existe para
        recusa do SERVIDOR (4xx), nao para indisponibilidade.
        """
        estado = {"n": 0}

        def falso(url, key, **kw):
            estado["n"] += 1
            if estado["n"] == 1:
                return (400, {}, b"lote recusado")      # o lote
            if estado["n"] == 2:
                return (201, {}, b"")                   # a 1a linha entra
            raise R.MedicaoError("rede indisponivel")   # a rede cai na 2a

        with mock.patch.object(R, "_request", side_effect=falso):
            recusadas = R.gravar("http://x", "k", self._linhas("a", "b", "c"))

        self.assertEqual(recusadas, ["b", "c"],
                         "a linha que caiu e as NAO TENTADAS contam como recusadas")
        self.assertEqual(estado["n"], 3, "para na 1a falha de transporte, nao tenta o resto")

    def test_nada_entrou_e_falha_TOTAL_e_levanta(self):
        """Zero linha gravada nao pode ser reportado como sucesso parcial — a serie perdeu o mes."""
        with mock.patch.object(R, "_request", return_value=(400, {}, b"recusado")):
            with self.assertRaises(R.MedicaoError):
                R.gravar("http://x", "k", self._linhas("a", "b"))


class G6RequestLeveTest(unittest.TestCase):
    """`_request_leve` (Onda 10) — UMA tentativa, sem retry/backoff, so para diagnostico.

    Contraste deliberado com `_request` (G2bRetryHttpTest): aqui uma falha transitoria NAO e
    repetida — a checagem de estado anterior nunca pode gastar o orcamento de tempo da medicao.
    """

    class _Resp:
        """Resposta de sucesso: `_request_leve` usa `urlopen` como context manager."""

        def __init__(self, status=200, corpo=b"[]"):
            self.status, self._c = status, corpo

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return self._c

    @staticmethod
    def _erro(codigo: int, corpo: bytes = b"erro"):
        return urllib.error.HTTPError("http://x", codigo, "erro", {}, io.BytesIO(corpo))

    def test_sucesso_devolve_status_e_corpo(self):
        with mock.patch.object(R.urllib.request, "urlopen",
                               return_value=self._Resp(200, b'[{"fired":true}]')):
            resultado = R._request_leve("http://x", "k")
        self.assertEqual(resultado, (200, b'[{"fired":true}]'))

    def test_uma_unica_tentativa_em_erro_transitorio(self):
        """Ao contrario de `_request`, um 503 aqui NAO e repetido."""
        with mock.patch.object(R.urllib.request, "urlopen",
                               side_effect=self._erro(503)) as urlopen, \
             mock.patch.object(R.time, "sleep") as dormiu:
            resultado = R._request_leve("http://x", "k")
        self.assertIsNone(resultado)
        self.assertEqual(urlopen.call_count, 1, "diagnostico nao insiste")
        dormiu.assert_not_called()

    def test_timeout_curto_e_dedicado(self):
        """Usa `HTTP_DIAG_TIMEOUT_SECONDS`, NUNCA o `HTTP_TIMEOUT_SECONDS` da medicao."""
        capturado = {}

        def falso(req, timeout=None):
            capturado["timeout"] = timeout
            return self._Resp(200, b"[]")

        with mock.patch.object(R.urllib.request, "urlopen", side_effect=falso):
            R._request_leve("http://x", "k")

        self.assertEqual(capturado["timeout"], R.HTTP_DIAG_TIMEOUT_SECONDS)
        self.assertNotEqual(R.HTTP_DIAG_TIMEOUT_SECONDS, R.HTTP_TIMEOUT_SECONDS,
                            "sanidade: os dois timeouts tem de ser numeros DIFERENTES")

    def test_falha_de_rede_devolve_None_sem_levantar(self):
        with mock.patch.object(R.urllib.request, "urlopen",
                               side_effect=urllib.error.URLError("indisponivel")):
            resultado = R._request_leve("http://x", "k")
        self.assertIsNone(resultado)

    def test_status_fora_de_200_206_devolve_None(self):
        """Blindagem: mesmo sem `HTTPError`, um status inesperado nao pode virar sucesso."""
        with mock.patch.object(R.urllib.request, "urlopen", return_value=self._Resp(204, b"")):
            resultado = R._request_leve("http://x", "k")
        self.assertIsNone(resultado)

    def test_envia_accept_profile_analytics(self):
        """A tabela vive em `analytics` — sem o header, o PostgREST procura em `public`."""
        capturado = {}

        def falso(req, timeout=None):
            capturado["req"] = req
            return self._Resp(200, b"[]")

        with mock.patch.object(R.urllib.request, "urlopen", side_effect=falso):
            R._request_leve("http://x", "k")

        # `Request.headers` normaliza a capitalizacao (Accept-profile).
        self.assertEqual(capturado["req"].headers.get("Accept-profile"), R.ANALYTICS)


class G7EstadoAnteriorTest(unittest.TestCase):
    """`_buscar_estado_anterior` (Onda 10) — mesma abordagem de G2ContagemPeloHeaderTest: mocka
    `_request_leve`, nao `urlopen`, para testar no nivel de abstracao certo.
    """

    def test_sem_registro_anterior_devolve_None(self):
        """1a medicao deste gatilho — NORMAL, nao e falha."""
        with mock.patch.object(R, "_request_leve", return_value=(200, b"[]")):
            self.assertIsNone(R._buscar_estado_anterior("http://x", "k", "nfse"))

    def test_registro_anterior_encontrado_devolve_o_fired(self):
        with mock.patch.object(R, "_request_leve", return_value=(200, b'[{"fired": true}]')):
            self.assertIs(R._buscar_estado_anterior("http://x", "k", "nfse"), True)
        with mock.patch.object(R, "_request_leve", return_value=(200, b'[{"fired": false}]')):
            self.assertIs(R._buscar_estado_anterior("http://x", "k", "nfse"), False)

    def test_falha_de_rede_devolve_None_e_loga_warning(self):
        with mock.patch.object(R, "_request_leve", return_value=None):
            with self.assertLogs(R.log, level="WARNING") as capturado:
                resultado = R._buscar_estado_anterior("http://x", "k", "cfe_nfce")
        self.assertIsNone(resultado)
        self.assertTrue(any("cfe_nfce" in m for m in capturado.output))

    def test_json_ilegivel_devolve_None_e_loga_warning(self):
        with mock.patch.object(R, "_request_leve", return_value=(200, b"nao e json")):
            with self.assertLogs(R.log, level="WARNING") as capturado:
                resultado = R._buscar_estado_anterior("http://x", "k", "nfse")
        self.assertIsNone(resultado)
        self.assertTrue(capturado.output)

    def test_campo_fired_ausente_ou_nao_booleano_devolve_None_e_loga_warning(self):
        for corpo in (b'[{"outro":1}]', b'[{"fired":"sim"}]'):
            with mock.patch.object(R, "_request_leve", return_value=(200, corpo)):
                with self.assertLogs(R.log, level="WARNING"):
                    resultado = R._buscar_estado_anterior("http://x", "k", "nfse")
            self.assertIsNone(resultado, f"corpo {corpo!r} tinha de degradar para None")

    def test_monta_url_com_trigger_key_order_desc_limit_1_e_schema_analytics(self):
        capturado = {}

        def falso(alvo, key):
            capturado["alvo"] = alvo
            return (200, b"[]")

        with mock.patch.object(R, "_request_leve", side_effect=falso):
            R._buscar_estado_anterior("http://x", "k", "text_to_sql")

        alvo = capturado["alvo"]
        self.assertIn("trigger_key=eq.text_to_sql", alvo)
        self.assertIn("order=measured_on.desc", alvo)
        self.assertIn("limit=1", alvo)
        self.assertIn(R.SNAPSHOT_TABLE, alvo)
        self.assertIn("measured_on=lt.", alvo)

    def test_exclui_o_registro_do_proprio_dia_da_comparacao(self):
        """🔴 Reexecucao no MESMO dia nao pode comparar consigo mesma (code review 2026-08-14).

        Sem o filtro `measured_on=lt.<hoje>`, a 2a execucao do dia leria a linha que a 1a
        acabou de gravar (UNIQUE por dia + `order desc limit 1`), calcularia `mudou=false` e o
        UPSERT com merge-duplicates APAGARIA o `mudou=true` da serie — a consulta-painel do
        SKILL.md perderia a transicao, e o resumo negaria o alarme que motivou a reexecucao.
        O filtro e `lt` (estritamente antes de hoje), nunca `lte`.
        """
        capturado = {}

        def falso(alvo, key):
            capturado["alvo"] = alvo
            return (200, b"[]")

        with mock.patch.object(R, "_request_leve", side_effect=falso):
            R._buscar_estado_anterior("http://x", "k", "nfse")

        hoje = R._hoje_serie()
        self.assertRegex(hoje, r"^\d{4}-\d{2}-\d{2}$",
                         "sanidade: a data da serie tem de ser ISO (como o DEFAULT da 122)")
        self.assertIn(f"measured_on=lt.{hoje}", capturado["alvo"],
                      "o registro do dia corrente tem de ficar FORA da busca")
        self.assertNotIn("measured_on=lte.", capturado["alvo"])


if __name__ == "__main__":
    unittest.main()
