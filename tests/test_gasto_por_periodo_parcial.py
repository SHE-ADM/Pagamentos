# -*- coding: utf-8 -*-
"""Guardas do BALDE PARCIAL na serie temporal (migration 124).

O QUE ESTE ARQUIVO PROTEGE

`analytics.gasto_por_periodo` agrupa por dia/semana/mes/trimestre. Os baldes das bordas quase
sempre cobrem menos dias que os do meio — o primeiro e cortado pelo inicio do periodo pedido, o
ultimo pelo PRESENTE. Medido em 2026-08-13, serie semanal por emissao: a semana de 10/08 tem
4 dos 7 dias e 42 contas, ao lado de 84 da anterior. Sem a ressalva, "caiu 50 pct" — falso.

Tres coisas podem se perder aqui em silencio, e cada uma devolve o numero certo com a conclusao
errada:

  · a funcao deixar de DEVOLVER as colunas (`is_partial`, `days_covered`, `days_total`), e o
    modelo perder o que citar;
  · o "hoje" voltar a ser `CURRENT_DATE`. A sessao do banco roda em UTC: das 21h a meia-noite em
    Sao Paulo o UTC ja e o dia seguinte, e o balde da semana corrente passaria a ser considerado
    COMPLETO — errando exatamente na janela em que alguem confere o fechamento do dia, e some
    quando se vai conferir de manha. Mesma classe do `todayISO` do frontend;
  · o dominio dos parametros de despacho voltar a ter default silencioso (`ELSE 'month'` /
    `ELSE due_date`), fazendo granularidade invalida virar MES e campo invalido virar VENCIMENTO
    — o oposto do invariante da camada analytics.

MECANISMOS: as LENTES DE CODIGO (que descartam comentario e prosa) sao importadas da Onda 8 em vez
de copiadas — e indispensavel aqui pelo mesmo motivo de la: a 124 EXPLICA em comentario justamente
o que nao deve fazer ("era `ELSE 'month'`", "NUNCA `CURRENT_DATE`"), entao uma guarda de ausencia
que lesse o texto cru casaria a propria advertencia e ficaria verde no exato momento em que o
defeito fosse reintroduzido.

Toda guarda que faz parsing tem teste de SANIDADE DO PARSER.
"""

import re
import sys
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_onda8_gate_ia import _codigo_sql, _codigo_ts, _migration_que_contem  # noqa: E402

MIGRACOES = RAIZ / "supabase" / "migrations"
TOOLS_TS = RAIZ / "apps" / "api-backend" / "lib" / "ai-chat" / "tools.ts"
GATEWAY_TS = RAIZ / "apps" / "api-backend" / "lib" / "ai-chat" / "gateway.ts"

TOOL = "gasto_por_periodo"

# A definicao VIGENTE da funcao — a 098, depois a 124, depois a proxima correcao. Travar na 124
# deixaria toda redefinicao futura livre para regredir estas invariantes com a suite verde (licao
# da Onda 6, e o motivo de a Onda 9 ter passado a usar duas ancoras).
MIG_TOOL = _migration_que_contem(f"analytics.{TOOL}(", "RETURNS TABLE")

COLUNAS_NOVAS = ("bucket_end", "days_covered", "days_total", "is_partial")


def _corpo_da_funcao() -> str:
    """Do CREATE FUNCTION ate o fim do corpo `$$`, sem comentarios."""
    sql = _codigo_sql(MIG_TOOL)
    m = re.search(
        r"CREATE (?:OR REPLACE )?FUNCTION analytics\.%s\(.*?\n\$\$;" % TOOL, sql, re.DOTALL)
    assert m, "nao achei o corpo do CREATE FUNCTION na migration vigente (o formato mudou?)"
    return m.group(0)


def _returns_table() -> str:
    m = re.search(r"RETURNS TABLE \((.*?)\)\s*LANGUAGE", _corpo_da_funcao(), re.DOTALL)
    assert m, "nao achei o RETURNS TABLE (o formato mudou?)"
    return m.group(1)


def _colunas_do_returns() -> list[str]:
    """Os NOMES das colunas do RETURNS TABLE, na ordem em que sao declaradas.

    🔴 Extrai o nome em vez de procurar substring. `assertIn('is_partial', tabela)` casa dentro de
    `is_partial_MUT` — medido: renomear a coluna assim deixava a guarda VERDE, que e exatamente o
    defeito que ela existe para pegar. E a mesma armadilha de medir versao de React por substring.
    """
    return re.findall(r"^\s+(\w+)\s+\w", _returns_table(), re.MULTILINE)


class SanidadeDoParserTest(unittest.TestCase):
    """Sem isto, as guardas abaixo poderiam virar `[] == []` — verdes para sempre."""

    def test_o_localizador_acha_a_migration_vigente(self):
        self.assertRegex(MIG_TOOL.name, r"^\d{3}_")
        self.assertGreaterEqual(MIG_TOOL.name[:3], "124",
                                "a definicao vigente e anterior a 124 — a 124 nao foi criada?")

    def test_o_corpo_e_o_returns_table_foram_lidos(self):
        self.assertIn("date_trunc", _corpo_da_funcao())
        colunas = _colunas_do_returns()
        self.assertGreaterEqual(len(colunas), 7, f"esperava >= 7 colunas, li {colunas}")
        self.assertEqual(colunas[0], "bucket", f"a 1a coluna deveria ser `bucket`, li {colunas}")

    def test_a_lente_remove_a_advertencia_sobre_o_default_silencioso(self):
        cru = MIG_TOOL.read_text(encoding="utf-8")
        # A migration explica em prosa o que NAO deve voltar a fazer.
        self.assertIn("ELSE 'month'", cru, "a advertencia sumiu do cabecalho da 124")
        self.assertNotIn("ELSE 'month'", _codigo_sql(MIG_TOOL),
                         "a lente nao removeu o comentario — as guardas de ausencia casariam a "
                         "propria advertencia e ficariam verdes com o defeito de volta")


class G1ColunasDeCoberturaTest(unittest.TestCase):
    """A funcao DEVOLVE a ressalva. Sem as colunas, nao ha o que declarar."""

    def test_o_returns_table_traz_as_quatro_colunas(self):
        colunas = set(_colunas_do_returns())
        faltando = sorted(c for c in COLUNAS_NOVAS if c not in colunas)
        self.assertEqual(
            faltando, [],
            f"a tool deixou de devolver {faltando} — o modelo perde a ressalva e apresenta um "
            f"balde de 4 dias como se fosse de 7. Colunas lidas: {sorted(colunas)}",
        )

    def test_as_tres_colunas_originais_continuam_no_inicio(self):
        """Colunas novas vao no FIM (padrao da 103 na vw_payables): reordenar quebra consumidor
        posicional e torna o diff de qualquer correcao futura ilegivel."""
        colunas = _colunas_do_returns()
        self.assertEqual(colunas[:3], ["bucket", "account_count", "total_amount"],
                         f"as tres colunas originais sairam do inicio: {colunas}")
        for nova in COLUNAS_NOVAS:
            self.assertGreaterEqual(colunas.index(nova), 3,
                                    f"{nova} entrou ANTES das colunas originais")


class G2FusoHorarioTest(unittest.TestCase):
    """🔴 O "hoje" e America/Sao_Paulo. A sessao do banco roda em UTC (medido)."""

    def test_usa_o_fuso_de_sao_paulo(self):
        self.assertIn("America/Sao_Paulo", _corpo_da_funcao(),
                      "o corpo nao fixa o fuso — em UTC, das 21h a meia-noite o balde da semana "
                      "corrente seria considerado COMPLETO")

    def test_NAO_usa_current_date(self):
        """`CURRENT_DATE` na sessao UTC erra o dia justamente no fim do expediente."""
        self.assertNotIn("CURRENT_DATE", _corpo_da_funcao(),
                         "o corpo voltou a usar CURRENT_DATE em vez do fuso explicito")


class G3DominioFechadoTest(unittest.TestCase):
    """Valor fora do dominio devolve VAZIO, nunca um default silencioso."""

    def test_o_despacho_e_guardado_por_dominio_explicito(self):
        corpo = _corpo_da_funcao()
        self.assertRegex(corpo, r"p_granularity\s+IN\s*\(",
                         "a granularidade nao passa por dominio fechado")
        self.assertRegex(corpo, r"p_date_field\s+IN\s*\(",
                         "o campo de data nao passa por dominio fechado")

    def test_o_dominio_e_aplicado_no_filtro(self):
        """Declarar o dominio e nao aplica-lo deixaria a guarda decorativa."""
        self.assertRegex(_corpo_da_funcao(), r"WHERE\s+d\.gran_ok\s+AND\s+d\.campo_ok",
                         "o dominio e calculado mas nao filtra nada")

    def test_o_dominio_do_sql_bate_com_o_enum_do_typescript(self):
        """🔴 Cross-layer: o Zod e a funcao tem de aceitar exatamente os mesmos valores.

        Se o TS aceitar um valor que o SQL recusa, a tool devolve VAZIO e o modelo conclui "nao
        houve gasto no periodo" — numero errado com cara de resposta.
        """
        ts = _codigo_ts(TOOLS_TS)
        corpo = _corpo_da_funcao()
        for const, param in (("GRANULARITIES", "p_granularity"), ("DATE_FIELDS", "p_date_field")):
            m = re.search(rf"const {const} = \[(.*?)\] as const;", ts, re.DOTALL)
            assert m, f"nao achei {const} em tools.ts (sanidade)"
            do_ts = set(re.findall(r"'([a-z_]+)'", m.group(1)))
            self.assertGreaterEqual(len(do_ts), 3, f"{const} parseou {do_ts} — parser quebrado?")

            m_sql = re.search(rf"{param}\s+IN \((.*?)\)", corpo, re.DOTALL)
            assert m_sql, f"nao achei o dominio de {param} no SQL (sanidade)"
            do_sql = set(re.findall(r"'([a-z_]+)'", m_sql.group(1)))

            self.assertEqual(do_ts, do_sql,
                             f"{const} (TS) e {param} (SQL) divergem: so no TS {do_ts - do_sql}, "
                             f"so no SQL {do_sql - do_ts}")


class G4DeclaracaoNaCamadaTsTest(unittest.TestCase):
    """A coluna so serve se o modelo for MANDADO cita-la."""

    def test_a_descricao_da_tool_manda_declarar(self):
        ts = _codigo_ts(TOOLS_TS)
        m = re.search(r"name: '%s',\s*description:\s*(.*?)input_schema" % TOOL, ts, re.DOTALL)
        assert m, "nao achei a descricao da tool em tools.ts (o formato mudou?)"
        descricao = m.group(1)
        self.assertGreater(len(descricao), 200, "descricao curta demais — parser quebrado?")
        for coluna in ("is_partial", "days_covered", "days_total"):
            self.assertIn(coluna, descricao, f"a descricao nao cita {coluna}")

    def test_o_prompt_manda_declarar(self):
        prompt = _codigo_ts(GATEWAY_TS)
        self.assertIn("is_partial", prompt, "o SYSTEM_PROMPT nao fala do balde parcial")
        self.assertRegex(prompt, r"diga quantos dias",
                         "o prompt sabe do balde parcial mas nao manda DIZER quantos dias — saber "
                         "e nao declarar deixa o numero enganando do mesmo jeito")


class G5AutoVerificacaoTest(unittest.TestCase):
    """A 124 aborta sozinha se as invariantes nao valerem no banco."""

    def test_tem_bloco_de_sondas_que_aborta(self):
        self.assertIn("ABORTADO", _codigo_sql(MIG_TOOL))

    def test_tem_oraculo_dos_agregados(self):
        """A unica sonda que prova que a reescrita NAO mexeu no numero."""
        self.assertIn("a reescrita mexeu no agregado", _codigo_sql(MIG_TOOL))

    def test_tem_anti_vacuidade_da_flag(self):
        """Flag sempre falsa (ou sempre verdadeira) passaria em qualquer teste de formula."""
        self.assertIn("provar que is_partial discrimina", _codigo_sql(MIG_TOOL))

    def test_prova_o_comportamento_sob_o_papel_real(self):
        self.assertIn("SET LOCAL ROLE authenticated", _codigo_sql(MIG_TOOL))


class G6GrantsTest(unittest.TestCase):
    """🔴 O DROP apaga os grants; recriar sem reemitir abre a funcao para PUBLIC."""

    def test_tem_drop_e_create(self):
        sql = _codigo_sql(MIG_TOOL)
        self.assertRegex(sql, rf"DROP FUNCTION IF EXISTS analytics\.{TOOL}\(",
                         "sem DROP, o CREATE seria recusado com 42P13 (o tipo de retorno mudou)")

    def test_os_dois_sentidos_do_grant(self):
        sql = _codigo_sql(MIG_TOOL)
        self.assertRegex(sql, rf"GRANT\s+EXECUTE ON FUNCTION analytics\.{TOOL}\(",
                         f"{TOOL} sem GRANT para authenticated — o chat responderia 42501")
        self.assertRegex(sql, rf"REVOKE EXECUTE ON FUNCTION analytics\.{TOOL}\([^)]*\)\s*FROM PUBLIC, anon",
                         f"{TOOL} sem REVOKE de PUBLIC/anon — anon executaria com a anon key")


if __name__ == "__main__":
    unittest.main()
