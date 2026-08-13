# -*- coding: utf-8 -*-
"""Guardas da ONDA 9 — pontualidade de pagamento (migration 121).

O QUE ESTE ARQUIVO PROTEGE

A tool atravessa tres camadas que ninguem compila junto: a migration (assinatura da funcao SQL),
o `tools.ts` (schema Zod, cujas chaves viram os parametros `p_*`) e o SYSTEM_PROMPT do gateway.
Cada uma tem sua propria suite, e nenhuma percebe a outra mudando:

  · renomear um parametro SO na migration deixa o vitest inteiro verde — os mocks nao conhecem o
    schema do banco — e a produção passa a responder `PGRST202 function does not exist` no meio do
    loop, gastando iteracao e devolvendo tool_result de erro;
  · mover a data de corte para um segundo lugar cria a 2a fonte de verdade classica: os dois
    valores divergem no primeiro ajuste e a metrica passa a incluir o backfill, com atraso ZERO
    artificial diluindo tudo — sem erro nenhum;
  · chamar a metrica de DPO em qualquer camada repete o erro que a decisao do DRE evitou: numero
    com o nome de uma coisa que ele nao e.

MECANISMOS: as LENTES DE CODIGO (que descartam comentario e prosa) sao importadas da Onda 8 em vez
de copiadas — este arquivo precisa exatamente delas, e uma 3a copia divergiria no primeiro ajuste.
E indispensavel aqui pelo mesmo motivo de la: a 121 EXPLICA em comentario justamente o que nao deve
fazer ("POR QUE NAO SE CHAMA DPO"), entao uma guarda de ausencia que lesse o texto cru casaria a
propria advertencia e ficaria verde exatamente quando o defeito fosse introduzido.

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

TOOL = "pontualidade_pagamento"

# 🔴 DOIS ancoras, nao uma — e a distincao e a licao da Onda 6: guarda localizada por CONTEUDO
# segue a definicao VIGENTE, que e a ULTIMA. A migration 123 REDEFINIU o corpo da tool (correcao
# do achado B1 do review da Onda 9), entao "a migration da tool" deixou de ser a mesma coisa que
# "a migration da data de corte":
#
#   MIG_TOOL  — quem define o corpo da tool HOJE (121, depois 123, depois a proxima correcao).
#               Travar as invariantes dela na 121 deixaria toda redefinicao futura livre para
#               regredi-las com a suite verde — que e exatamente o que a Onda 6 aprendeu.
#   MIG_CORTE — quem define a data de corte. Ela NAO se move: e a fonte unica, e uma 2a definicao
#               noutro arquivo e justamente o que a guarda G2 existe para impedir.
MIG_TOOL = _migration_que_contem(f"analytics.{TOOL}(", "RETURNS TABLE")
MIG_CORTE = _migration_que_contem(
    "CREATE OR REPLACE FUNCTION analytics.payment_date_confiavel_desde()")


def _assinatura_sql() -> list[str]:
    """Os parametros declarados no CREATE FUNCTION da tool, na ordem."""
    sql = _codigo_sql(MIG_TOOL)
    m = re.search(r"CREATE (?:OR REPLACE )?FUNCTION analytics\.%s\(\s*(.*?)\s*\)\s*RETURNS TABLE"
                  % TOOL, sql, re.DOTALL)
    assert m, "nao achei o CREATE FUNCTION da tool na 121 (o formato mudou?)"
    return re.findall(r"(p_\w+)\s+\w", m.group(1))


def _chaves_do_schema_zod() -> list[str]:
    """As chaves do schema Zod da tool — elas viram `p_<chave>` em parseToolInput."""
    codigo = _codigo_ts(TOOLS_TS)
    m = re.search(r"%s:\s*z\.object\(\{(.*?)\}\),\s*\n\s*\}\s*as const;" % TOOL, codigo, re.DOTALL)
    if not m:                                    # a tool pode nao ser a ultima do objeto
        m = re.search(r"%s:\s*z\.object\(\{(.*?)\n  \}\)," % TOOL, codigo, re.DOTALL)
    assert m, "nao achei o schema Zod da tool em tools.ts (o formato mudou?)"
    return re.findall(r"^\s{4}(\w+):", m.group(1), re.MULTILINE)


class SanidadeDoParserTest(unittest.TestCase):
    """Sem isto, as guardas abaixo poderiam virar `[] == []` — verdes para sempre."""

    def test_os_localizadores_acham_as_migrations_certas(self):
        # A data de corte nasceu na 121 e nao pode ter migrado de arquivo — se migrou, a fonte
        # unica deixou de estar onde a G2 a procura e as guardas dela mediriam outro artefato.
        self.assertEqual(MIG_CORTE.name[:3], "121")
        # A tool e a definicao VIGENTE: a 121 ou qualquer correcao posterior, nunca anterior.
        self.assertGreaterEqual(
            MIG_TOOL.name, MIG_CORTE.name,
            f"a tool esta definida por {MIG_TOOL.name}, ANTERIOR ao corte ({MIG_CORTE.name})",
        )

    def test_a_assinatura_sql_foi_lida(self):
        params = _assinatura_sql()
        self.assertIn("p_group_by", params)
        self.assertGreaterEqual(len(params), 5, f"esperava >= 5 parametros, achei {params}")

    def test_o_schema_zod_foi_lido(self):
        chaves = _chaves_do_schema_zod()
        self.assertIn("group_by", chaves)
        self.assertGreaterEqual(len(chaves), 5, f"esperava >= 5 chaves, achei {chaves}")

    def test_a_lente_remove_a_advertencia_sobre_dpo(self):
        cru = MIG_CORTE.read_text(encoding="utf-8")
        self.assertIn("POR QUE NAO SE CHAMA", cru, "a advertencia sumiu do cabecalho da 121")
        self.assertNotIn("POR QUE NAO SE CHAMA", _codigo_sql(MIG_CORTE))


class G1AssinaturaCrossLayerTest(unittest.TestCase):
    """🔴 O que o TS ENVIA e o que o SQL ACEITA.

    Este e o unico teste do projeto que pega o mutante "renomear um parametro so na migration":
    typecheck e vitest ficam verdes (o schema Zod nao conhece o banco) e o defeito so aparece em
    producao, como erro de ferramenta dentro do loop do chat.
    """

    def test_toda_chave_do_zod_existe_como_parametro_na_funcao(self):
        sql_params = set(_assinatura_sql())
        ausentes = [f"p_{c}" for c in _chaves_do_schema_zod() if f"p_{c}" not in sql_params]
        self.assertEqual(
            ausentes, [],
            f"o tools.ts envia parametro(s) que a funcao da 121 nao aceita: {ausentes}",
        )

    def test_a_funcao_nao_exige_parametro_que_o_zod_nunca_manda(self):
        """Parametro SEM default e obrigatorio no SQL; se o Zod nao o envia, a chamada falha."""
        sql = _codigo_sql(MIG_TOOL)
        m = re.search(r"CREATE (?:OR REPLACE )?FUNCTION analytics\.%s\(\s*(.*?)\s*\)\s*RETURNS TABLE"
                      % TOOL, sql, re.DOTALL)
        assert m, "nao achei o CREATE FUNCTION (sanidade)"
        # Cada linha de parametro vai ate a virgula de topo; sem DEFAULT, e obrigatorio.
        sem_default = [
            linha.split()[0]
            for linha in re.split(r",\s*\n", m.group(1))
            if linha.strip().startswith("p_") and "DEFAULT" not in linha.upper()
        ]
        self.assertEqual(
            sem_default, [],
            f"parametro(s) obrigatorio(s) na funcao: {sem_default}. O parseToolInput so envia o "
            "que o modelo preencheu — parametro sem DEFAULT quebra toda chamada que o omitir.",
        )


class G2FonteUnicaDaDataDeCorteTest(unittest.TestCase):
    """A data de corte do backfill vive em UM lugar: a funcao payment_date_confiavel_desde().

    Uma 2a copia diverge no primeiro ajuste, e o efeito e mudo: com o corte errado para tras, as
    441 contas do backfill entram na populacao "confiavel" e o atraso medio despenca para perto de
    zero — que e exatamente o numero falso que motivou adiar este item por meses.
    """

    DATA = re.compile(r"DATE\s*'2026-07-29'")

    def test_a_funcao_de_corte_existe_e_e_immutable(self):
        sql = _codigo_sql(MIG_CORTE)
        self.assertIn("CREATE OR REPLACE FUNCTION analytics.payment_date_confiavel_desde()", sql)
        self.assertRegex(sql, r"payment_date_confiavel_desde\(\)[\s\S]{0,200}?IMMUTABLE")

    def test_a_data_literal_aparece_uma_unica_vez_no_codigo(self):
        ocorrencias = self.DATA.findall(_codigo_sql(MIG_CORTE))
        self.assertEqual(len(ocorrencias), 1,
                         f"a data de corte aparece {len(ocorrencias)}x no codigo de "
                         f"{MIG_CORTE.name} — ela tem de sair da funcao, nunca ser repetida")

    def test_nenhuma_outra_migration_repete_a_data_de_corte(self):
        for p in MIGRACOES.glob("*.sql"):
            if p == MIG_CORTE:
                continue
            self.assertNotRegex(
                _codigo_sql(p), self.DATA,
                f"{p.name} repete a data de corte — use analytics.payment_date_confiavel_desde()",
            )

    def test_o_typescript_nao_conhece_a_data(self):
        """A cobertura vem do BANCO, no proprio retorno da tool (`cobertura_desde`)."""
        for arquivo in (TOOLS_TS, GATEWAY_TS):
            self.assertNotIn("2026-07-29", _codigo_ts(arquivo),
                             f"{arquivo.name} fixou a data de corte — ela e do banco")

    def test_a_tool_devolve_a_cobertura(self):
        sql = _codigo_sql(MIG_TOOL)
        for coluna in ("cobertura_desde", "fora_da_cobertura", "excluidas_venc_alterado"):
            self.assertIn(coluna, sql, f"a tool deixou de devolver {coluna} — o modelo perde a "
                                       "ressalva e apresenta o numero como se fosse total")


class G3NaoEDpoTest(unittest.TestCase):
    """O nome. DPO e indicador contabil e exige o passivo da empresa; aqui a base e o e-mail."""

    def test_a_funcao_nao_se_chama_dpo(self):
        sql = _codigo_sql(MIG_TOOL)
        self.assertNotRegex(sql, r"CREATE (?:OR REPLACE )?FUNCTION analytics\.\w*dpo",
                            "funcao batizada de DPO — ver o cabecalho da 121")

    def test_nenhuma_coluna_do_retorno_se_chama_dpo(self):
        m = re.search(r"RETURNS TABLE \((.*?)\)\s*LANGUAGE", _codigo_sql(MIG_TOOL), re.DOTALL)
        assert m, "nao achei o RETURNS TABLE (sanidade)"
        self.assertNotIn("dpo", m.group(1).lower())

    def test_o_prompt_nega_o_nome_em_vez_de_ignora_lo(self):
        """Silencio nao basta: perguntado por DPO, o modelo apresentaria a pontualidade como tal."""
        prompt = _codigo_ts(GATEWAY_TS)
        self.assertRegex(prompt, r"N[ÃA]O é DPO")


class G4AutoVerificacaoTest(unittest.TestCase):
    """A 121 aborta sozinha se as invariantes dela nao valerem no banco."""

    def test_tem_bloco_de_sondas_que_aborta(self):
        self.assertIn("ABORTADO", _codigo_sql(MIG_TOOL))

    def test_tem_oraculo_diferencial(self):
        """Tool x query de controle: a unica sonda que prova que o numero esta CERTO."""
        sql = _codigo_sql(MIG_TOOL)
        self.assertIn("oraculo divergiu", sql.lower().replace("ORACULO", "oraculo"))

    def test_prova_o_comportamento_sob_o_papel_real(self):
        # Privilegio concedido e consulta que responde sao perguntas diferentes (licao da 111).
        self.assertIn("SET LOCAL ROLE authenticated", _codigo_sql(MIG_TOOL))

    def test_tem_anti_vacuidade(self):
        """Sem populacao confiavel, toda sonda passaria medindo o vazio."""
        self.assertRegex(_codigo_sql(MIG_TOOL), r"nenhuma conta paga com carimbo real")


class G4bPeriodoSemCoberturaTest(unittest.TestCase):
    """Periodo cujas contas pagas estao TODAS fora da cobertura devolve AVISO, nunca vazio.

    Achado da autorrevisao adversarial desta onda, reproduzido no banco antes da correcao:
    junho/2026 tem 113 contas pagas, todas anteriores ao corte, e a funcao devolvia ZERO linhas.
    Zero linha faz o modelo responder "nao houve pagamento no periodo" — falso, e invertendo a
    conclusao. "Nao existe" e "existe mas nao da para medir" sao respostas diferentes, e preservar
    essa diferenca e a razao de ser desta tool.
    """

    def test_a_tool_emite_a_linha_de_aviso(self):
        sql = _codigo_sql(MIG_TOOL)
        self.assertIn("nenhuma conta com data de pagamento confiavel no periodo", sql)

    def test_o_aviso_so_vale_para_eixo_VALIDO(self):
        """A correcao acima quase quebrou o dominio fechado — a sonda P3 pegou no ensaio.

        Com eixo invalido `agrupado` fica vazio e `pagas` nao: sem a guarda de dominio, o aviso
        apareceria e um parametro errado viraria resposta de aparencia legitima.
        """
        sql = _codigo_sql(MIG_TOOL)
        m = re.search(r"UNION ALL(.*?)\n    \)", sql, re.DOTALL)
        assert m, "nao achei o ramo do aviso (o formato mudou?)"
        self.assertIn("eixo", m.group(1),
                      "o ramo do aviso nao consulta o dominio do eixo — eixo invalido devolveria "
                      "a linha de aviso em vez de vazio")

    def test_o_dominio_do_eixo_e_fonte_unica(self):
        """A lista de eixos validos aparece UMA vez; repetida, um eixo novo entra so num lado."""
        sql = _codigo_sql(MIG_TOOL)
        self.assertEqual(
            len(re.findall(r"'geral',\s*'fornecedor',\s*'empresa',\s*'mes',\s*'faixa'", sql)), 1,
            "o dominio do eixo esta repetido no SQL — use a CTE `eixo`",
        )

    def test_a_sonda_do_periodo_sem_cobertura_existe(self):
        self.assertIn("periodo 100 pct fora da cobertura", _codigo_sql(MIG_TOOL))

    def test_o_aviso_olha_a_POPULACAO_e_nao_o_AGRUPAMENTO(self):
        """🔴 Achado B1 do review da Onda 9 (corrigido pela migration 123).

        O ramo do aviso testava `NOT EXISTS (SELECT 1 FROM agrupado)`, e `agrupado` ja passou pelo
        `HAVING count(*) >= p_min_contas`. Vazio ali significa DUAS coisas — "nao ha populacao
        confiavel" (o caso do aviso) e "ha populacao, mas nenhum grupo atingiu o piso" (em que o
        aviso vira mentira). Medido no banco com os parametros que a propria descricao da tool
        recomenda: 7 dias + min_contas=10 -> 118 contas confiaveis reais, e a tool respondia
        "(nenhuma conta com data de pagamento confiavel no periodo)".

        A condicao correta olha `confiaveis`, a populacao ANTES do agrupamento.
        """
        sql = _codigo_sql(MIG_TOOL)
        m = re.search(r"UNION ALL(.*?)\n    \)", sql, re.DOTALL)
        assert m, "nao achei o ramo do aviso (o formato mudou?)"
        ramo = m.group(1)

        self.assertIn(
            "NOT EXISTS (SELECT 1 FROM confiaveis)", ramo,
            "o ramo do aviso nao olha `confiaveis` — se ele voltar a olhar `agrupado`, um "
            "`min_contas` alto faz a tool AFIRMAR que nao ha dado confiavel onde ha",
        )
        self.assertNotIn(
            "NOT EXISTS (SELECT 1 FROM agrupado)", ramo,
            "o ramo do aviso voltou a olhar `agrupado` (o defeito B1)",
        )

    def test_a_sonda_do_piso_alto_existe_na_migration(self):
        """A prova no banco: piso acima do maior grupo NAO pode produzir a linha de aviso.

        As 8 sondas da 121 nao pegaram o B1 porque todas exercitam `p_min_contas` no default (1),
        valor em que o defeito e inalcancavel. A sonda tem de usar um piso DERIVADO do dado.
        """
        sql = _codigo_sql(MIG_TOOL)
        self.assertIn("ABORTADO (B1)", sql,
                      "a migration nao aborta quando o piso alto produz a linha de aviso")
        self.assertRegex(sql, r"p_min_contas\s*=>\s*v_piso",
                         "a sonda do piso nao chama a tool com o piso derivado do dado")


class G5GrantsTest(unittest.TestCase):
    """GRANT e REVOKE explicitos — o default do PostgreSQL concede EXECUTE a PUBLIC."""

    def test_as_duas_funcoes_tem_os_dois_sentidos(self):
        """Cada funcao e conferida na migration que a DEFINE hoje.

        Nao basta olhar um arquivo so: quem redefine a tool tem de reemitir os grants dela, e
        quem define o corte tem de emitir os do corte. Cobrar tudo de um lado unico deixaria a
        outra metade sem guarda no dia em que ela mudar de arquivo.
        """
        for fn, mig in ((TOOL, MIG_TOOL), ("payment_date_confiavel_desde", MIG_CORTE)):
            sql = _codigo_sql(mig)
            self.assertRegex(sql, rf"GRANT\s+EXECUTE ON FUNCTION analytics\.{fn}\(",
                             f"{fn} sem GRANT para authenticated em {mig.name}")
            self.assertRegex(sql, rf"REVOKE EXECUTE ON FUNCTION analytics\.{fn}\([^)]*\)\s*FROM PUBLIC, anon",
                             f"{fn} sem REVOKE de PUBLIC/anon em {mig.name} — anon executaria "
                             "com a anon key")


class G6CatalogoDaToolTest(unittest.TestCase):
    """A tool esta declarada no catalogo que vai ao modelo, com o mesmo nome da funcao SQL."""

    def test_a_tool_esta_no_tools_ts(self):
        self.assertIn(f"name: '{TOOL}'", _codigo_ts(TOOLS_TS))

    def test_o_prompt_cita_a_tool(self):
        self.assertIn(TOOL, _codigo_ts(GATEWAY_TS))


if __name__ == "__main__":
    unittest.main()
