# -*- coding: utf-8 -*-
"""Guardas da ONDA 7 — trilha de auditoria (migrations 117 e 118).

O QUE ESTE ARQUIVO PROTEGE

A Onda 7 tem uma assimetria perigosa: quase tudo o que ela pode quebrar quebra **em silencio**.
Uma trilha que deixa de gravar nao levanta erro — o CRUD segue funcionando e so meses depois,
numa auditoria, alguem descobre que nao ha registro. Uma trilha que grava DEMAIS (a policy
publica que a 117 removeu) tambem nao levanta erro — apenas expoe dado financeiro a quem tiver a
anon key. Nenhum dos dois aparece em teste de comportamento do app.

Por isso as guardas aqui sao CROSS-LAYER: leem a migration e comparam com a outra camada
(schema Zod, catalogo de campos), em vez de afirmar coerencia por conta propria.

MECANISMOS HERDADOS DE tests/test_onda6_campos_derivados.py (mesma familia de guarda):
  · `_migration_que_contem` localiza por CONTEUDO e devolve a definicao VIGENTE (a ultima);
  · `_sem_comentarios` usa a lente de CODIGO — comentario que cita o proprio termo procurado
    faria a guarda casar a advertencia em vez do codigo (licao do `_sem_prosa`);
  · toda guarda que faz parsing tem teste de SANIDADE DO PARSER: um regex que para de casar
    transforma a guarda em `0 === 0`, verde para sempre;
  · validadas por MUTANTE isolado — teste que nao fica vermelho com o defeito presente nao e
    teste, e decoracao.
"""

import re
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
MIGRACOES = RAIZ / "supabase" / "migrations"
SCHEMA_ZOD = RAIZ / "packages" / "shared" / "src" / "schemas" / "financial-account-control.schema.ts"
TOOLS_TS = RAIZ / "apps" / "api-backend" / "lib" / "ai-chat" / "tools.ts"
AUDIT_ACTOR_TS = RAIZ / "apps" / "api-backend" / "lib" / "audit-actor.ts"

# Campos sensiveis que pertencem a `supplier`, nao a tabela fato — ficam fora da comparacao com o
# schema Zod da fato (que nao os tem, e nao deve ter).
CAMPOS_DE_SUPPLIER = {"pix_key1", "pix_key2", "cnpj", "cpf"}


def _sem_comentarios(sql: str) -> str:
    """Remove os comentarios `--`, preservando o que esta DENTRO de string literal.

    Necessario aqui de forma aguda: a 117 e a 118 EXPLICAM em comentario justamente o que nao
    devem fazer ("OLD.updated_by NAO e fonte de ator", "AFTER, NUNCA BEFORE"). Uma guarda que
    procurasse esses termos no texto cru casaria a propria advertencia — o pior desfecho, porque
    ela ficaria verde exatamente quando o defeito fosse introduzido.
    """
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


def _codigo(p: Path) -> str:
    return _sem_comentarios(p.read_text(encoding="utf-8"))


def _migration_que_contem(*trechos: str) -> Path:
    """A migration MAIS RECENTE cujo CODIGO contem TODOS os trechos (mesma regra da Onda 6)."""
    alvos = sorted(p for p in MIGRACOES.glob("*.sql") if all(t in _codigo(p) for t in trechos))
    assert alvos, f"nenhuma migration contem {trechos}"
    assert all(re.match(r"^\d{3}_", p.name) for p in alvos), (
        f"migration fora do padrao 'NNN_' quebra a ordenacao por nome: {[p.name for p in alvos]}"
    )
    return alvos[-1]


def _array_da_funcao(sql: str, nome: str) -> list[str]:
    """Itens do `ARRAY[...]` devolvido por uma funcao de vocabulario (audit_*_fields)."""
    m = re.search(
        rf"CREATE OR REPLACE FUNCTION public\.{nome}\(\).*?SELECT ARRAY\[(.*?)\]::text\[\]",
        sql, re.DOTALL,
    )
    assert m, f"nao achei o ARRAY de {nome} (o formato mudou?)"
    return re.findall(r"'([^']+)'", m.group(1))


def _bloco_schema_leitura() -> str:
    """Corpo do `financialAccountControlSchema = z.object({...})` — so o schema de LEITURA.

    Escopo importa: procurar no arquivo inteiro casaria tambem as entradas do `.omit()`.
    """
    zod = SCHEMA_ZOD.read_text(encoding="utf-8")
    m = re.search(
        r"export const financialAccountControlSchema = z\.object\(\{(.*?)\n\}\);", zod, re.DOTALL
    )
    assert m, "nao achei o bloco do schema de leitura (o formato mudou?)"
    return m.group(1)


class SanidadeDoParserTest(unittest.TestCase):
    """Sem isto, qualquer guarda abaixo poderia estar medindo lista vazia e passando sempre."""

    def test_a_lente_de_codigo_descarta_comentario_mas_preserva_string(self):
        sql = "SELECT 'nao--e-comentario' AS x;  -- isto e comentario\nSELECT 2;"
        limpo = _sem_comentarios(sql)
        self.assertIn("nao--e-comentario", limpo)
        self.assertNotIn("isto e comentario", limpo)

    def test_a_lente_de_codigo_muda_o_resultado_de_fato(self):
        # A 117 cita 'OLD.updated_by' num comentario explicando por que NAO o usa. Se a lente
        # parar de funcionar, a guarda de acusacao falsa passaria a casar a advertencia.
        bruto = _migration_que_contem("fn_audit_row").read_text(encoding="utf-8")
        self.assertIn("OLD.updated_by", bruto, "a advertencia sumiu do arquivo?")

    def test_os_arquivos_das_outras_camadas_existem(self):
        for p in (SCHEMA_ZOD, TOOLS_TS, AUDIT_ACTOR_TS):
            self.assertTrue(p.exists(), f"arquivo de outra camada sumiu ou foi movido: {p}")

    def test_o_localizador_acha_as_duas_migrations_da_onda(self):
        self.assertEqual(_migration_que_contem("fn_audit_row").name[:3], "117")
        self.assertEqual(_migration_que_contem("auditoria_eventos").name[:3], "118")

    def test_o_extrator_de_vocabulario_devolve_lista_nao_vazia(self):
        sql = _codigo(_migration_que_contem("CREATE OR REPLACE FUNCTION public.audit_sensitive_fields"))
        self.assertGreater(len(_array_da_funcao(sql, "audit_sensitive_fields")), 5)
        self.assertGreater(len(_array_da_funcao(sql, "audit_ignored_fields")), 5)


class G1VocabularioSensivelTest(unittest.TestCase):
    """O vocabulario de campos sensiveis tem de casar colunas REAIS.

    Um typo aqui nao quebra nada: a funcao continua devolvendo o array, a tool continua rodando, e
    o campo simplesmente NUNCA e marcado como sensivel. `p_apenas_sensiveis=true` passaria a omitir
    silenciosamente alteracoes de valor — o oposto do que a Onda 7 existe para entregar.
    """

    def setUp(self):
        self.sql = _codigo(_migration_que_contem("CREATE OR REPLACE FUNCTION public.audit_sensitive_fields"))
        self.sensiveis = _array_da_funcao(self.sql, "audit_sensitive_fields")
        self.ignorados = _array_da_funcao(self.sql, "audit_ignored_fields")

    def test_todo_campo_sensivel_da_fato_existe_no_schema_de_leitura(self):
        bloco = _bloco_schema_leitura()
        for campo in self.sensiveis:
            if campo in CAMPOS_DE_SUPPLIER:
                continue
            self.assertRegex(
                bloco, rf"\n\s+{re.escape(campo)}\s*:",
                f"'{campo}' esta em audit_sensitive_fields() mas nao existe no schema de leitura "
                f"da fato — typo faria o campo nunca ser marcado como sensivel, em silencio",
            )

    def test_os_campos_de_supplier_estao_declarados_e_sao_os_esperados(self):
        # Guarda contra remocao acidental: a chave PIX e o vetor de fraude que justificou
        # estender a auditoria a `supplier` (decisao registrada no CLAUDE.md).
        for campo in ("pix_key1", "pix_key2"):
            self.assertIn(campo, self.sensiveis, f"'{campo}' saiu do vocabulario sensivel")

    def test_sensivel_e_ignorado_sao_conjuntos_DISJUNTOS(self):
        # Um campo nos dois seria contraditorio: nunca entraria no delta, entao jamais poderia
        # ser marcado sensivel — a intencao declarada e o comportamento divergiriam sem erro.
        comuns = set(self.sensiveis) & set(self.ignorados)
        self.assertEqual(comuns, set(), f"campos em AMBOS os vocabularios: {sorted(comuns)}")


class G2ColunasIgnoradasTest(unittest.TestCase):
    """O delta nao pode carregar escrituracao nem coluna GERADA."""

    def setUp(self):
        self.ignorados = set(
            _array_da_funcao(_codigo(_migration_que_contem("CREATE OR REPLACE FUNCTION public.audit_ignored_fields")),
                             "audit_ignored_fields")
        )

    def test_ignora_a_escrituracao_da_trigger_de_autoria(self):
        # `fn_set_updated_at` bumpa `updated_at` em TODO update. Sem ignora-lo, o delta nunca
        # ficaria vazio e a regra "UPDATE sem mudanca real nao gera linha" viraria letra morta —
        # a trilha encheria de eventos que nao sao eventos.
        for coluna in ("updated_at", "updated_by", "status_changed_at", "status_changed_by"):
            self.assertIn(coluna, self.ignorados, f"'{coluna}' precisa ficar fora do delta")

    def test_ignora_TODAS_as_colunas_geradas_da_onda_6(self):
        # Coluna GERADA e consequencia, nao acao: ninguem "alterou" days_late. Se uma nova coluna
        # gerada nascer sem entrar aqui, todo delta que tocar sua origem passara a listar as duas.
        geradas = re.findall(
            r"ADD COLUMN IF NOT EXISTS\s+(\w+)[^;]*?GENERATED ALWAYS AS",
            _codigo(_migration_que_contem("ADD COLUMN IF NOT EXISTS competence_month")),
            re.DOTALL,
        )
        self.assertGreaterEqual(len(geradas), 3, "o parser de colunas GERADAS parou de casar")
        for coluna in geradas:
            self.assertIn(coluna, self.ignorados,
                          f"coluna GERADA '{coluna}' nao esta em audit_ignored_fields()")


class G3TriggerTest(unittest.TestCase):
    """As tres propriedades da trigger que, se mudarem, quebram tudo em silencio."""

    def setUp(self):
        self.sql = _codigo(_migration_que_contem("fn_audit_row"))

    def test_a_trigger_de_linha_e_AFTER_nunca_BEFORE(self):
        # As 5 triggers atuais da fato sao BEFORE e ALTERAM NEW (updated_at, status_id recalculado,
        # payment_date, sk_company). Auditar antes delas gravaria o valor que ainda sera
        # sobrescrito — registro plausivel e FALSO, o pior desfecho possivel numa trilha.
        for trigger in ("trg_audit_fac", "trg_audit_supplier"):
            m = re.search(rf"CREATE TRIGGER {trigger}\s+(\w+)", self.sql)
            self.assertIsNotNone(m, f"nao achei o CREATE TRIGGER de {trigger}")
            self.assertEqual(m.group(1), "AFTER", f"{trigger} precisa ser AFTER")

    def test_a_funcao_da_trigger_e_SECURITY_DEFINER(self):
        # `authenticated` teve INSERT revogado em audit_log (056) e a RLS nao tem policy de
        # escrita. Sem SECURITY DEFINER, marcar "Tem NF" em /consulta quebraria com 42501 — a
        # regressao classe 074, que ja aconteceu neste projeto uma vez.
        m = re.search(
            r"CREATE OR REPLACE FUNCTION public\.fn_audit_row\(\)(.*?)AS \$\$", self.sql, re.DOTALL
        )
        self.assertIsNotNone(m, "nao achei o cabecalho de fn_audit_row")
        self.assertIn("SECURITY DEFINER", m.group(1))

    def test_OLD_updated_by_NAO_e_fonte_de_ator(self):
        # Ele e o editor ANTERIOR. Usa-lo numa alteracao de batch atribuiria a um humano uma
        # mudanca que ele nao fez — ACUSACAO FALSA, pior que ausencia de dado. O honesto sem
        # sinal e NULL + 'servico'.
        corpo = re.search(
            r"CREATE OR REPLACE FUNCTION public\.fn_audit_row\(\).*?AS \$\$(.*?)\$\$;",
            self.sql, re.DOTALL,
        )
        self.assertIsNotNone(corpo, "nao achei o corpo de fn_audit_row")
        self.assertNotIn("v_antes ->> 'updated_by'", corpo.group(1),
                         "o corpo passou a derivar o ator do editor ANTERIOR")

    def test_o_jwt_tem_precedencia_sobre_o_header(self):
        # INVARIANTE DE SEGURANCA, nao preferencia: se o header fosse consultado antes de
        # auth.uid(), um usuario logado poderia forjar `x-audit-actor` e assinar a alteracao no
        # nome de outra pessoa. O JWT e inforjavel; o header so vale quando nao ha JWT.
        corpo = re.search(
            r"CREATE OR REPLACE FUNCTION public\.fn_audit_row\(\).*?AS \$\$(.*?)\$\$;",
            self.sql, re.DOTALL,
        ).group(1)
        pos_jwt = corpo.find("IF auth.uid() IS NOT NULL THEN")
        pos_header = corpo.find("ELSIF v_header IS NOT NULL THEN")
        self.assertGreater(pos_jwt, 0, "o ramo do JWT sumiu da resolucao do ator")
        self.assertGreater(pos_header, pos_jwt,
                           "o header passou a ser consultado ANTES do JWT — permite forjar autor")

    def test_o_ator_vindo_de_fora_e_VALIDADO_antes_do_cast(self):
        # 🔴 Achado da autorrevisao adversarial, reproduzido no banco: sem esta validacao o
        # `::uuid` levanta 22P02 com um valor nao-uuid e, sendo a trigger fail-closed, DERRUBA a
        # gravacao da conta inteira — um header ruim impediria de registrar um pagamento.
        #
        # A distincao: fail-closed vale para o REGISTRO da auditoria (nao conseguiu auditar =>
        # nao escreve), NAO para INTERPRETAR uma dica de atribuicao nao-confiavel. Ator ilegivel
        # degrada para NULL + 'servico', que e o mesmo estado honesto de "nao sei quem foi".
        corpo = re.search(
            r"CREATE OR REPLACE FUNCTION public\.fn_audit_row\(\).*?AS \$\$(.*?)\$\$;",
            self.sql, re.DOTALL,
        ).group(1)
        self.assertIn("_UUID_RE", corpo, "a validacao do formato do ator sumiu")
        for canal in ("v_header", "v_guc"):
            self.assertRegex(
                corpo, rf"IF {canal}\s+IS NOT NULL AND {canal}\s+!~\* _UUID_RE THEN {canal}\s+:= NULL",
                f"o canal {canal} deixou de ser validado antes do cast para uuid",
            )

    def test_o_TRUNCATE_e_auditado_e_e_BEFORE(self):
        # Trigger de LINHA nao dispara em TRUNCATE: sem esta, a maior perda possivel (o
        # TRUNCATE ... CASCADE da rotina de limpeza) nao deixaria rastro nenhum. BEFORE porque em
        # AFTER a tabela ja esta vazia e o numero de linhas destruidas seria inalcancavel.
        for trigger in ("trg_audit_fac_truncate", "trg_audit_supplier_truncate"):
            m = re.search(rf"CREATE TRIGGER {trigger}\s+(\w+) TRUNCATE", self.sql)
            self.assertIsNotNone(m, f"nao achei o CREATE TRIGGER de {trigger}")
            self.assertEqual(m.group(1), "BEFORE", f"{trigger} precisa ser BEFORE")


class G4VazamentoFechadoTest(unittest.TestCase):
    """A 117 tinha de FECHAR o furo antes de popular — e o furo nao pode voltar."""

    def setUp(self):
        self.sql = _codigo(_migration_que_contem("fn_audit_row"))

    def test_remove_a_policy_publica_e_revoga_o_SELECT_de_anon(self):
        # A audit_log foi criada pelo dashboard e nasceu com policy TO public + GRANT a anon.
        # A anon key e PUBLICA (vai no bundle): popular a trilha sem revogar publicaria valores,
        # fornecedores e autores da base inteira, sem login.
        self.assertIn('DROP POLICY IF EXISTS "Enable read access for all users"', self.sql)
        self.assertRegex(self.sql, r"REVOKE SELECT ON public\.audit_log FROM anon")

    def test_a_policy_nova_espelha_o_recorte_por_dono_da_076(self):
        # `USING (true)` ignoraria a RLS 076 e o grupo Comercial veria o delta de contas alheias —
        # vazamento lateral pela tabela de auditoria.
        m = re.search(
            r"CREATE POLICY authenticated_select_audit_log.*?USING \((.*?)\);", self.sql, re.DOTALL
        )
        self.assertIsNotNone(m, "nao achei a policy de leitura da audit_log")
        predicado = m.group(1)
        self.assertIn("auth_group_sees_only_own()", predicado,
                      "a policy deixou de reusar o helper da 076 (2a fonte de verdade)")
        self.assertIn("registro_dono = auth.uid()", predicado)

    def test_registro_id_deixou_de_ser_uuid(self):
        # A PK da fato e BIGINT; com registro_id uuid nao havia onde gravar o id da conta.
        self.assertIn("ALTER COLUMN registro_id TYPE bigint", self.sql)


class G5ToolsTest(unittest.TestCase):
    """As tools precisam herdar os invariantes das ondas anteriores."""

    def setUp(self):
        self.sql = _codigo(_migration_que_contem("auditoria_eventos"))

    def test_as_duas_tools_sao_SECURITY_INVOKER(self):
        # E isso, e so isso, que faz a policy da 117 valer no chat. SECURITY DEFINER aqui seria
        # escalada de privilegio silenciosa.
        for fn in ("auditoria_eventos", "auditoria_resumo"):
            m = re.search(rf"FUNCTION analytics\.{fn}\((.*?)AS \$\$", self.sql, re.DOTALL)
            self.assertIsNotNone(m, f"nao achei o cabecalho de {fn}")
            self.assertIn("SECURITY INVOKER", m.group(1), f"{fn} precisa ser SECURITY INVOKER")
            self.assertIn("SET search_path = ''", m.group(1))

    def test_as_duas_declaram_o_total_antes_do_LIMIT(self):
        # 4a ocorrencia da armadilha da truncagem silenciosa no projeto. Tem de ser JANELA
        # (avaliada antes do LIMIT), nunca subconsulta — que herdaria o corte e devolveria o
        # total truncado: o mesmo bug com cara de correcao.
        self.assertEqual(self.sql.count("(count(*) OVER ())::integer"), 2)
        for fn in ("auditoria_eventos", "auditoria_resumo"):
            # re.search com flags — assertRegex trata o 3o argumento como MENSAGEM, nao como
            # flags, e sem DOTALL o `.` nao cruza a quebra de linha do RETURNS TABLE.
            self.assertIsNotNone(
                re.search(rf"FUNCTION analytics\.{fn}\(.*?total_encontrado\s+integer",
                          self.sql, re.DOTALL),
                f"{fn} nao declara total_encontrado no RETURNS TABLE",
            )

    def test_as_duas_clampam_o_LIMIT_negativo(self):
        # LIMIT negativo levanta 2201W em runtime, e p_limit vem de parametro gerado pelo modelo.
        self.assertEqual(self.sql.count("LIMIT GREATEST(COALESCE(p_limit"), 2)

    def test_anon_perde_o_EXECUTE_das_duas(self):
        # O PostgreSQL concede EXECUTE a PUBLIC por default, e o ALTER DEFAULT PRIVILEGES da 098
        # nao persiste (medido na Onda 1: 4 funcoes nasceram chamaveis com a anon key publica).
        for fn in ("auditoria_eventos", "auditoria_resumo"):
            self.assertIsNotNone(re.search(rf"REVOKE EXECUTE ON FUNCTION analytics\.{fn}\(.*?FROM PUBLIC, anon", self.sql, re.DOTALL), f"{fn} nao revoga de anon")
            self.assertIsNotNone(re.search(rf"GRANT\s+EXECUTE ON FUNCTION analytics\.{fn}\(.*?TO authenticated", self.sql, re.DOTALL), f"{fn} nao concede a authenticated")

    def test_a_ordenacao_tem_desempate_unico(self):
        # Sem ordem TOTAL o recorte do LIMIT varia com o plano: a mesma pergunta devolve eventos
        # diferentes entre execucoes, sem erro. Licao de lib/stableOrder.ts, do lado do banco.
        self.assertIn("ORDER BY a.criado_em DESC, a.id DESC", self.sql)
        self.assertIn("ORDER BY count(*) DESC, e.grupo", self.sql)

    def test_nao_devolve_a_linha_crua_ao_modelo(self):
        # A linha da fato em jsonb chega a 13 KB e o gateway corta o resultado de tool em 60 KB
        # POR REGISTRO — despejar `dados_antes` cru truncaria a resposta.
        m = re.search(r"FUNCTION analytics\.auditoria_eventos\(.*?\$\$(.*?)\$\$;", self.sql, re.DOTALL)
        corpo = m.group(1)
        self.assertNotIn("a.dados_depois,", corpo, "a tool passou a devolver dados_depois cru")
        self.assertIn("jsonb_object_agg", corpo, "o resumo compacto sumiu")


class G8AtribuicaoNaoConflaciadaTest(unittest.TestCase):
    """🔴 Usuario REMOVIDO nao pode ser contado como automacao.

    Achado medido: um evento com `ator_via='jwt'` — ACAO HUMANA — cujo usuario foi apagado do
    `auth.users` caia num `COALESCE(u.email, '(automacao...)')` e era agrupado com os eventos do
    batch. A trilha nao PERDIA o evento: ela o REATRIBUIA a uma categoria que inocenta todo mundo,
    que e o pior erro possivel numa auditoria — e é indetectavel, porque o numero continua batendo.

    Nao e hipotetico: este projeto ja apagou um usuario (`teste@otimotex.com.br`, 2026-08-07).
    """

    def setUp(self):
        self.sql = _codigo(_migration_que_contem("audit_actor_label"))

    def test_o_rotulo_distingue_os_TRES_estados(self):
        corpo = re.search(
            r"FUNCTION analytics\.audit_actor_label\(.*?AS \$\$(.*?)\$\$;", self.sql, re.DOTALL
        )
        self.assertIsNotNone(corpo, "o helper de rotulo do ator sumiu")
        corpo = corpo.group(1)
        self.assertIn("WHEN p_usuario_id IS NULL", corpo, "nao trata o caso 'sem ator'")
        self.assertIn("usuario removido", corpo, "nao distingue o usuario REMOVIDO")
        self.assertIn("public.app_user", corpo, "nao resolve o e-mail da pessoa")

    def test_as_DUAS_tools_usam_o_helper_e_nao_uma_copia_local(self):
        # Duas copias da regra divergiriam em silencio: uma tool passaria a rotular certo e a
        # outra nao, e o modelo receberia respostas incoerentes sobre o mesmo evento.
        self.assertNotIn("COALESCE(u.email", self.sql,
                         "voltou um COALESCE local que conflaciona removido com automacao")
        self.assertGreaterEqual(
            self.sql.count("analytics.audit_actor_label("), 3,
            "o helper nao esta sendo usado nas duas tools (display + filtro)",
        )

    def test_o_filtro_por_campo_inclui_a_EXCLUSAO_do_registro(self):
        # Medido: filtrando `campo='amount'`, um DELETE que destruiu uma conta de R$ 50.000 NAO
        # aparecia, porque `campos_alterados` e NULL em DELETE. "Quem mexeu no valor este mes?"
        # via as alteracoes pequenas e nao via a destruicao da conta inteira — omissao material.
        self.assertRegex(
            self.sql,
            r"a\.operacao = 'DELETE' AND a\.dados_antes \? p_campo",
            "o filtro por campo voltou a ignorar a exclusao que destruiu aquele campo",
        )


class G6WiringDoAtorTest(unittest.TestCase):
    """O header precisa estar LIGADO nos caminhos de escrita, nao so existir.

    ⚠️ Esta guarda e TEXTUAL e sabe da propria limitacao (licao 6 da Regra 2 do CLAUDE.md): ela
    prova que a ligacao EXISTE, nao que ela FUNCIONA — nao ve escopo, ordem nem excecao. Quem
    prova o funcionamento sao os testes de comportamento em `apps/api-backend/lib/contas.test.ts`
    (validados por mutante) e a sonda end-to-end que rodou contra o PostgREST real. O papel desta
    aqui e impedir que alguem REMOVA a ligacao.
    """

    def test_o_nome_do_header_e_o_mesmo_nos_dois_lados(self):
        # Divergencia aqui nao quebra nada visivelmente: a escrita funciona e a trilha passa a
        # registrar 'servico' para toda edicao humana da Next API. Silencioso e permanente.
        ts = AUDIT_ACTOR_TS.read_text(encoding="utf-8")
        m = re.search(r"AUDIT_ACTOR_HEADER = '([^']+)'", ts)
        self.assertIsNotNone(m, "nao achei a constante do header no lib/audit-actor.ts")
        header_ts = m.group(1)

        sql = _codigo(_migration_que_contem("fn_audit_row"))
        self.assertIn(f"->> '{header_ts}'", sql,
                      f"a trigger nao le o header '{header_ts}' que o TS envia")

    def test_os_caminhos_de_escrita_auditados_propagam_o_ator(self):
        contas = (RAIZ / "apps" / "api-backend" / "lib" / "contas.ts").read_text(encoding="utf-8")
        suppliers = (RAIZ / "apps" / "api-backend" / "lib" / "suppliers.ts").read_text(encoding="utf-8")
        self.assertIn("withAuditActor", contas, "contas.ts deixou de propagar o ator")
        self.assertIn("withAuditActor", suppliers, "suppliers.ts deixou de propagar o ator")
        # O hard delete e o evento em que perder o autor custa mais caro.
        self.assertRegex(contas, r"hardDelete\(id: number, actorId\?: string\)")


class G7ToolsExpostasAoModeloTest(unittest.TestCase):
    """Regra transversal do roadmap: dado sem tool nao amplia a gama de perguntas em nada."""

    def setUp(self):
        self.ts = TOOLS_TS.read_text(encoding="utf-8")

    def test_as_duas_tools_estao_declaradas(self):
        for tool in ("auditoria_eventos", "auditoria_resumo"):
            self.assertIn(f"name: '{tool}'", self.ts, f"{tool} nao chegou ao modelo")

    def test_a_descricao_declara_a_data_de_inicio_da_trilha(self):
        # Sem essa ressalva o modelo leria "nenhum evento" como "nada mudou", quando o correto e
        # "nao havia registro". A trilha comeca na aplicacao da 117.
        self.assertIn("11/08/2026", self.ts,
                      "a descricao da tool deixou de declarar quando a trilha comeca")

    def test_a_descricao_explica_o_ator_via_servico(self):
        # 'servico' significa automacao ou edicao nao atribuivel — NUNCA "ninguem alterou".
        self.assertRegex(self.ts, r'ator_via="servico"[^\n]*')
        self.assertIn('NUNCA leia como "ninguém alterou"', self.ts)

    def test_o_dominio_de_tabelas_cobre_exatamente_o_que_e_auditado(self):
        # Tabela fora do dominio devolveria VAZIO no banco e o modelo concluiria "nao houve
        # alteracao" em vez de "essa tabela nao e auditada".
        m = re.search(r"AUDIT_TABLES = \[(.*?)\] as const", self.ts, re.DOTALL)
        self.assertIsNotNone(m, "nao achei AUDIT_TABLES")
        declaradas = set(re.findall(r"'([^']+)'", m.group(1)))
        sql = _codigo(_migration_que_contem("fn_audit_row"))
        auditadas = set(re.findall(r"CREATE TRIGGER trg_audit\w*\s+AFTER[^;]*?ON public\.(\w+)", sql))
        self.assertEqual(declaradas, auditadas,
                         "o dominio de tabelas do modelo divergiu das triggers realmente criadas")


if __name__ == "__main__":
    unittest.main()
