# -*- coding: utf-8 -*-
"""Guardas da ONDA 8 — gate de uso do chat de IA por grupo (migration 120).

O QUE ESTE ARQUIVO PROTEGE

O gate atravessa QUATRO camadas que ninguem compila junto: a migration (coluna e default), o
`gate.ts` (leitura e comparacao), o `AuthContext.tsx` (estado inicial) e o `Layout.tsx` (montagem
do widget). Cada uma tem sua propria suite, e nenhuma delas percebe a outra mudando:

  · renomear a coluna SO na migration deixa o vitest inteiro verde e o typecheck limpo — em
    producao o gate falha ao ler e, sendo FAIL-CLOSED, derruba o chat para todos os usuarios;
  · trocar `=== true` por `!== false` numa das pontas inverte o default de DENY para ALLOW sem
    quebrar nenhum teste de comportamento daquela camada;
  · ler o grupo do JWT em vez da tabela autoriza e nega as pessoas erradas em SILENCIO — medido
    em 2026-08-12: `raw_app_meta_data->>'group_id'` existe em 2 dos 13 usuarios e nos DOIS diz
    `0`, enquanto o `user_profile` diz `1` e `7`.

Por isso as guardas aqui sao CROSS-LAYER: leem um arquivo e comparam com o outro, em vez de
repetir uma constante e afirmar coerencia por conta propria.

MECANISMOS HERDADOS de tests/test_onda7_auditoria.py (mesma familia):
  · `_migration_que_contem` localiza por CONTEUDO e devolve a definicao VIGENTE (a ultima);
  · a LENTE DE CODIGO descarta comentarios — aqui ela e indispensavel, porque a 120 e o
    `gate.ts` EXPLICAM em comentario justamente o que nao devem fazer ("a tentacao e criar um
    auth_group_ai_chat_enabled()", "raw_app_meta_data esta defasado"). Uma guarda de ausencia que
    lesse o texto cru casaria a propria advertencia e ficaria verde exatamente quando o defeito
    fosse introduzido;
  · toda guarda que faz parsing tem teste de SANIDADE DO PARSER;
  · validadas por MUTANTE isolado.
"""

import re
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
MIGRACOES = RAIZ / "supabase" / "migrations"
API = RAIZ / "apps" / "api-backend"
FRONT = RAIZ / "apps" / "frontend-vite" / "src"

GATE_TS = API / "lib" / "ai-chat" / "gate.ts"
ROUTE_TS = API / "app" / "api" / "ai-chat" / "route.ts"
# A sequencia dos dois porteiros mora aqui desde que a rota SSE entrou — ver G8OrdemDosPorteirosTest.
SESSION_TS = API / "lib" / "ai-chat" / "session.ts"
AUTH_TS = API / "lib" / "auth.ts"
AUTH_CONTEXT_TSX = FRONT / "contexts" / "AuthContext.tsx"
LAYOUT_TSX = FRONT / "components" / "Layout.tsx"


def _sem_comentarios_sql(sql: str) -> str:
    """Remove os comentarios `--` do SQL, preservando o que esta DENTRO de string literal."""
    fora, i, n = [], 0, len(sql)
    while i < n:
        c = sql[i]
        if c == "'":                      # string literal: copia ate fechar
            j = i + 1
            while j < n and sql[j] != "'":
                j += 1
            fora.append(sql[i:j + 1])
            i = j + 1
        elif sql.startswith("--", i):     # comentario de linha: descarta
            j = sql.find("\n", i)
            i = n if j == -1 else j
        else:
            fora.append(c)
            i += 1
    return "".join(fora)


def _sem_comentarios_ts(fonte: str) -> str:
    """Remove comentarios `//` e `/* */` de TS/TSX, preservando strings e templates.

    Mesma necessidade do lado SQL: `gate.ts` cita `raw_app_meta_data` no cabecalho para explicar
    por que NAO se le o grupo do JWT, e a 120 cita `auth_group_ai_chat_enabled` para explicar por
    que a funcao helper NAO existe. Sem a lente, as guardas de ausencia casariam a explicacao.
    """
    fora, i, n = [], 0, len(fonte)
    aspas = ("'", '"', "`")
    while i < n:
        c = fonte[i]
        if c in aspas:                    # string/template: copia ate fechar (respeita escape)
            j = i + 1
            while j < n:
                if fonte[j] == "\\":
                    j += 2
                    continue
                if fonte[j] == c:
                    break
                j += 1
            fora.append(fonte[i:min(j + 1, n)])
            i = j + 1
        elif fonte.startswith("//", i):
            j = fonte.find("\n", i)
            i = n if j == -1 else j
        elif fonte.startswith("/*", i):
            j = fonte.find("*/", i + 2)
            i = n if j == -1 else j + 2
        else:
            fora.append(c)
            i += 1
    return "".join(fora)


def _codigo_sql(p: Path) -> str:
    return _sem_comentarios_sql(p.read_text(encoding="utf-8"))


def _codigo_ts(p: Path) -> str:
    return _sem_comentarios_ts(p.read_text(encoding="utf-8"))


def _admin_group_id(p: Path) -> int:
    """O `ADMIN_GROUP_ID` declarado num arquivo TS/TSX (lido do CODIGO, nunca do comentario)."""
    m = re.search(r"const ADMIN_GROUP_ID = (\d+);", _codigo_ts(p))
    assert m, f"nao achei ADMIN_GROUP_ID em {p.name} (o formato mudou?)"
    return int(m.group(1))


def _migration_que_contem(*trechos: str) -> Path:
    """A migration MAIS RECENTE cujo CODIGO contem TODOS os trechos (regra das Ondas 6 e 7)."""
    alvos = sorted(p for p in MIGRACOES.glob("*.sql") if all(t in _codigo_sql(p) for t in trechos))
    assert alvos, f"nenhuma migration contem {trechos}"
    assert all(re.match(r"^\d{3}_", p.name) for p in alvos), (
        f"migration fora do padrao 'NNN_' quebra a ordenacao por nome: {[p.name for p in alvos]}"
    )
    return alvos[-1]


# A 120 e localizada pela COLUNA que ela cria — nunca pelo nome do arquivo.
MIG_120 = _migration_que_contem("ai_chat_enabled")


class SanidadeDoParserTest(unittest.TestCase):
    """As lentes precisam REMOVER de fato — senao as guardas de ausencia viram decoracao."""

    def test_a_lente_sql_remove_o_comentario_que_cita_o_helper(self):
        cru = MIG_120.read_text(encoding="utf-8")
        # A migration explica em prosa por que NAO cria a funcao helper.
        self.assertIn("auth_group_ai_chat", cru, "a advertencia sumiu do cabecalho da 120")
        self.assertNotIn("auth_group_ai_chat", _codigo_sql(MIG_120))

    def test_a_lente_ts_remove_o_comentario_que_cita_o_claim(self):
        cru = GATE_TS.read_text(encoding="utf-8")
        # O gate explica em prosa por que NAO le o grupo do JWT.
        self.assertIn("raw_app_meta_data", cru, "a advertencia sumiu do cabecalho do gate.ts")
        self.assertNotIn("raw_app_meta_data", _codigo_ts(GATE_TS))

    def test_a_lente_ts_preserva_o_codigo(self):
        codigo = _codigo_ts(GATE_TS)
        self.assertIn("assertAiChatAllowed", codigo)
        self.assertIn("user_profile", codigo)

    def test_o_localizador_acha_a_migration_da_onda(self):
        self.assertEqual(MIG_120.name[:3], "120")


class G2ColunasCrossLayerTest(unittest.TestCase):
    """As colunas que o gate.ts LE existem na migration.

    🔴 Este e o unico teste do projeto que pega o mutante "renomear a coluna so na migration":
    typecheck e vitest ficam verdes (os mocks nao conhecem o schema) e o defeito so aparece em
    producao — como chat fora do ar para todos, porque o gate e fail-closed.
    """

    def _colunas_lidas(self) -> list[str]:
        codigo = _codigo_ts(GATE_TS)
        m = re.search(r"user_group\(([^)]+)\)", codigo)
        assert m, "nao achei o embed `user_group(...)` no select do gate.ts (o formato mudou?)"
        return [c.strip() for c in m.group(1).split(",") if c.strip()]

    def test_sanidade_do_parser(self):
        colunas = self._colunas_lidas()
        self.assertIn("ai_chat_enabled", colunas)
        self.assertGreaterEqual(len(colunas), 3, f"esperava >= 3 colunas no embed, achei {colunas}")

    def test_toda_coluna_lida_existe_na_migration(self):
        sql = _codigo_sql(MIG_120)
        ausentes = [c for c in self._colunas_lidas() if c not in sql]
        self.assertEqual(ausentes, [], f"o gate.ts le coluna(s) que a 120 nao cria: {ausentes}")

    def test_a_tabela_do_vinculo_e_user_profile_nao_o_claim(self):
        codigo = _codigo_ts(GATE_TS)
        self.assertIn("'user_profile'", codigo)
        # G5: o claim do JWT esta defasado e nao pode virar fonte de autorizacao.
        self.assertNotIn("app_metadata", codigo)


class G3DenyPorDefaultTest(unittest.TestCase):
    """DENY e o default nas QUATRO camadas. Comparar arquivos, nunca repetir constante."""

    def test_a_coluna_nasce_false_no_banco(self):
        sql = _codigo_sql(MIG_120)
        self.assertRegex(sql, r"ai_chat_enabled\s+boolean\s+NOT NULL\s+DEFAULT\s+false")

    def test_o_gate_compara_por_identidade_com_true(self):
        # `!== true` nega tudo o que nao for exatamente `true` (string, null, numero, ausencia).
        # Truthiness liberaria com a string "false", que e o que um cache de schema velho devolve.
        self.assertIn("!== true", _codigo_ts(GATE_TS))

    def test_o_estado_inicial_do_frontend_e_desconhecido(self):
        codigo = _codigo_ts(AUTH_CONTEXT_TSX)
        self.assertRegex(codigo, r"aiChatEnabled:\s*null")
        self.assertIn("=== true", codigo)

    def test_o_widget_so_monta_com_permissao_conhecida(self):
        codigo = _codigo_ts(LAYOUT_TSX)
        self.assertIn("aiChatEnabled === true", codigo)
        # `!== false` montaria o widget durante o "ainda nao sei", piscando para o usuario negado.
        self.assertNotIn("aiChatEnabled !== false", codigo)


class G4SementeTest(unittest.TestCase):
    """A semente e aditiva e cobre o grupo Administrador."""

    def _grupos_da_semente(self) -> list[int]:
        sql = _codigo_sql(MIG_120)
        m = re.search(r"SET ai_chat_enabled = true\s+WHERE group_id IN \(([^)]+)\)", sql)
        assert m, "nao achei a semente da 120 (o formato mudou?)"
        return [int(x) for x in re.findall(r"\d+", m.group(1))]

    def test_sanidade_do_parser(self):
        self.assertGreaterEqual(len(self._grupos_da_semente()), 1)

    def test_a_semente_inclui_o_grupo_administrador(self):
        # O id vem do backend, nao de um literal repetido aqui: se o ADMIN_GROUP_ID mudar, esta
        # guarda acompanha em vez de ficar apontando para um numero morto.
        self.assertIn(_admin_group_id(AUTH_TS), self._grupos_da_semente())

    def test_o_admin_group_id_do_front_espelha_o_do_back(self):
        """Lacuna PRE-EXISTENTE, fechada aqui porque a guarda acima passou a depender dela.

        `ADMIN_GROUP_ID` e declarado DUAS vezes por valor — `lib/auth.ts` (a trava real) e
        `AuthContext.tsx` (o gate de UI) —, em pacotes diferentes e sem import cruzado. Divergir
        nao quebra build nem teste: o botao de excluir some (ou aparece) para o grupo errado, e a
        API responde 403 sem que a tela explique. Como o teste acima passou a LER esse id do
        backend, uma divergencia tambem faria esta suite validar a semente contra um numero que a
        UI nao usa.
        """
        self.assertEqual(_admin_group_id(AUTH_TS), _admin_group_id(AUTH_CONTEXT_TSX))

    def test_a_semente_e_aditiva(self):
        """A forma `SET ... = (group_id IN (...))` REVOGARIA em silencio quem foi liberado a mao."""
        sql = _codigo_sql(MIG_120)
        self.assertNotRegex(sql, r"SET ai_chat_enabled\s*=\s*\(\s*group_id IN")


class G5AusenciasTest(unittest.TestCase):
    """O que NAO pode existir. Lendo codigo, nunca prosa (as duas coisas sao explicadas em prosa)."""

    def test_a_120_nao_cria_funcao_helper_de_rls(self):
        # RLS responde "quais linhas"; o gate responde "pode chamar o endpoint". Um SECURITY
        # DEFINER lendo auth.uid() seria inalcancavel pelo unico chamador (service_role).
        self.assertNotIn("auth_group_ai_chat", _codigo_sql(MIG_120))

    def test_nenhuma_migration_reintroduz_o_helper(self):
        for p in MIGRACOES.glob("*.sql"):
            self.assertNotIn("auth_group_ai_chat", _codigo_sql(p), f"{p.name} criou o helper")


class G6AutoVerificacaoTest(unittest.TestCase):
    """A 120 aborta sozinha se as invariantes dela nao valerem."""

    def test_tem_bloco_de_sondas_que_aborta(self):
        sql = _codigo_sql(MIG_120)
        self.assertIn("ABORTADO", sql)
        self.assertIn("ROLLBACK_SONDA", sql)

    def test_prova_o_comportamento_sob_o_papel_real(self):
        # Privilegio concedido e linha visivel sao perguntas diferentes: so `SET LOCAL ROLE`
        # responde a segunda (licao da 117 — `psql` conecta como postgres, que ignora RLS).
        self.assertIn("SET LOCAL ROLE authenticated", _codigo_sql(MIG_120))

    def test_a_sonda_de_escrita_aceita_zero_linhas_como_negacao(self):
        """Sem o ramo de ROW_COUNT, a RLS filtrando em silencio pareceria 'nao escreve'."""
        self.assertIn("GET DIAGNOSTICS", _codigo_sql(MIG_120))


class G7MensagemUnicaTest(unittest.TestCase):
    """A mensagem da negacao vive num lugar so — o frontend a recebe pelo envelope da API."""

    def _mensagem(self) -> str:
        m = re.search(
            r"MENSAGEM_SEM_ACESSO\s*=\s*\n?\s*'([^']+)'", GATE_TS.read_text(encoding="utf-8")
        )
        assert m, "nao achei a MENSAGEM_SEM_ACESSO no gate.ts (o formato mudou?)"
        return m.group(1)

    def test_sanidade_do_parser(self):
        self.assertIn("assistente", self._mensagem().lower())

    def test_o_frontend_nao_duplica_a_mensagem(self):
        trecho = self._mensagem()[:30]
        duplicatas = [
            p.name for p in FRONT.rglob("*.ts*") if trecho in p.read_text(encoding="utf-8")
        ]
        self.assertEqual(duplicatas, [], f"a mensagem foi copiada para o frontend: {duplicatas}")


class G8OrdemDosPorteirosTest(unittest.TestCase):
    """O gate roda ANTES do rate limit, e TODA rota de chat passa pelos dois.

    🔴 ESCOPO DESTA GUARDA (licao da Regra 2, item 6 do CLAUDE.md): ela prova que a chamada
    EXISTE e em que POSICAO do arquivo — nunca que ela roda. Escopo, ordem de atribuicao, excecao
    e tipo passam despercebidos por leitura textual. Quem prova a execucao sao os casos
    "o gate roda ANTES do rate limit" de `app/api/ai-chat/route.test.ts` e do `stream/route.test.ts`,
    que executam a rota e comparam a ordem real. As duas se completam: esta impede que alguem
    REMOVA a ligacao, aquelas impedem que ela deixe de funcionar.

    ⚠️ O ALVO MUDOU quando o streaming entrou (2026-08-14). Os dois porteiros moravam dentro de
    `app/api/ai-chat/route.ts`; com a rota SSE irma, copiar a sequencia para o segundo arquivo seria
    a duplicacao classica — e o modo de falha nao e codigo feio, e a rota nova nascer SEM o gate sem
    que nada acuse. A sequencia passou a viver em `lib/ai-chat/session.ts` (`assertChatAllowed`), e
    esta guarda foi atras dela; o teste novo abaixo cobre o que a mudanca criou de risco.
    """

    def test_a_sequencia_dos_porteiros_chama_os_dois(self):
        codigo = _codigo_ts(SESSION_TS)
        self.assertIn("assertAiChatAllowed(userId)", codigo)
        self.assertIn("assertWithinRateLimit(userId", codigo)

    def test_o_gate_vem_primeiro(self):
        codigo = _codigo_ts(SESSION_TS)
        pos_gate = codigo.index("assertAiChatAllowed(userId)")
        pos_limite = codigo.index("assertWithinRateLimit(userId")
        self.assertLess(pos_gate, pos_limite)

    def test_a_cota_do_grupo_e_repassada_ao_rate_limit(self):
        """Chamar o gate e IGNORAR o retorno compila (o parametro e opcional) e deixa a cota inerte."""
        self.assertIn("assertWithinRateLimit(userId, gate)", _codigo_ts(SESSION_TS))

    def test_TODA_rota_de_chat_passa_pelos_porteiros(self):
        """🔴 O risco que a extracao criou: uma rota de chat nova sem autorizacao.

        Concentrar a sequencia num modulo torna impossivel ESQUECER a ordem — mas nao torna
        impossivel esquecer de CHAMAR o modulo. Uma rota que pule `assertChatAllowed` responde
        perfeitamente bem, sem erro e sem teste vermelho, enquanto entrega o assistente pago a um
        grupo que nao tem acesso. Por isso a guarda varre o diretorio inteiro em vez de listar os
        arquivos conhecidos: rota nova entra no escopo sozinha.
        """
        rotas = sorted((API / "app" / "api" / "ai-chat").rglob("route.ts"))
        self.assertGreaterEqual(len(rotas), 2, f"esperava ao menos 2 rotas de chat, achei {rotas}")

        sem_gate = [r.name for r in rotas if "assertChatAllowed(" not in _codigo_ts(r)]
        self.assertEqual(
            sem_gate, [],
            "rota(s) de chat sem `assertChatAllowed`: "
            f"{[str(r.relative_to(API)) for r in rotas if r.name in sem_gate]} — o assistente e pago "
            "e o acesso e opt-in por grupo (migration 120)",
        )


class G9ContratoDoErroTest(unittest.TestCase):
    """O contrato do `failFromError` e o mesmo no CODIGO e em TODO doc vivo que o enuncia.

    POR QUE ESTA GUARDA EXISTE (e por que ela nasceu tarde)

    A Onda 8 acrescentou `ApiServiceError.clientSafe` — a excecao opt-in ao corte em 500, criada
    porque o corte descartava em silencio as tres mensagens 503 curadas do chat. Mas o contrato
    estava enunciado em TRES lugares, e o commit da onda corrigiu so o codigo. Resultado: a Regra 3
    do CLAUDE.md e o `docs/knowledge/api-crud.md` seguiram afirmando o oposto do comportamento — e
    o segundo sobreviveu a mais um PR, porque a correcao do primeiro nao foi reauditada.

    Regra mais afiada que "nao pode divergir": QUEM ENUNCIA O CORTE TEM DE ENUNCIAR A EXCECAO.
    Um doc que diz "ecoa se status < 500" sem citar `clientSafe` esta descrevendo um comportamento
    que o codigo nao tem mais — e o modo de falha e o pior possivel numa regra de SEGURANCA: quem
    ler acredita, ve o 503 do chat chegando ao usuario e reporta um vazamento inexistente.
    """

    # Documentos vivos. `docs/review/**` fica FORA de proposito: sao relatorios DATADOS, retratos
    # de um momento — reescrever um relatorio de 2026-08-10 para refletir uma mudanca de 08-12
    # falsificaria o registro. O mesmo vale para o plano de um review ja executado.
    def _docs_vivos(self) -> list[Path]:
        return [
            p for p in [RAIZ / "CLAUDE.md", *sorted((RAIZ / "docs").rglob("*.md"))]
            if "review" not in p.relative_to(RAIZ).parts
        ]

    def test_sanidade_o_corte_e_a_excecao_existem_no_codigo(self):
        codigo = _codigo_ts(RAIZ / "apps" / "api-backend" / "lib" / "response.ts")
        self.assertIn("e.status < 500", codigo, "o corte sumiu de failFromError (o contrato mudou?)")
        self.assertIn("e.clientSafe", codigo, "a excecao sumiu de failFromError (o contrato mudou?)")

    def test_sanidade_ha_docs_que_enunciam_o_corte(self):
        """Sem nenhum doc citando o corte, o teste abaixo seria `[] == []` — verde para sempre."""
        citam = [p.name for p in self._docs_vivos() if "status < 500" in p.read_text(encoding="utf-8")]
        self.assertGreaterEqual(len(citam), 2, f"esperava >= 2 docs enunciando o corte, achei {citam}")

    def test_todo_doc_que_enuncia_o_corte_enuncia_a_excecao(self):
        omissos = []
        for p in self._docs_vivos():
            texto = p.read_text(encoding="utf-8")
            if "failFromError" in texto and "status < 500" in texto and "clientSafe" not in texto:
                omissos.append(str(p.relative_to(RAIZ)))

        self.assertEqual(
            omissos, [],
            "doc(s) enunciando o corte em 500 sem citar a excecao `clientSafe` — descrevem um "
            f"comportamento que o codigo nao tem mais: {omissos}",
        )


if __name__ == "__main__":
    unittest.main()
