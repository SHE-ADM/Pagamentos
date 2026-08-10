"""Guardas cross-layer da ONDA 6 (campos derivados na tabela fato).

As cinco colunas da onda sao GENERATED ALWAYS ... STORED. Isso cria uma classe de defeito que NAO
produz erro em lugar nenhum:

  - uma coluna gerada pode existir no banco e nao existir no schema Zod: o resto do sistema nunca
    a enxerga, e nada fica vermelho (era a lacuna nº 10 do briefing desta onda);
  - uma coluna gerada FORA do .omit() do inputSchema faz o PostgreSQL recusar o INSERT com 428C9
    no primeiro write path que use aquele schema direto — meses depois, longe daqui;
  - uma expressao gerada que use funcao STABLE nem chega a ser criada, mas uma que use a coluna
    ERRADA (due_date no lugar de competence_date) e aceita e passa a mentir em silencio.

Molde: tests/test_body_full.py (localiza a migration por CONTEUDO, nao por nome, para sobreviver a
renumeracao) e tests/test_fiscal_document_consistency.py (sanidade do parser + a migration cita o
teste). TODA guarda aqui tem asserção de sanidade do parser: sem ela, um regex que pare de casar
transforma o teste em `0 == 0`, verde para sempre.

🔴 LICAO APLICADA (test_fiscal_document_consistency._sem_prosa): guarda que procura a AUSENCIA de
algo precisa ler CODIGO, nao prosa. Os comentarios destas migrations MENCIONAM `::date`, `to_date`
e `CURRENT_DATE` justamente para explicar por que nao devem ser usados — um `assert '::date' not in
sql` casaria a propria advertencia e ficaria vermelho para sempre. Por isso as guardas de expressao
extraem o corpo do GENERATED ALWAYS AS (...) e olham SO dentro dele.
"""

import re
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
MIGRACOES = RAIZ / "supabase" / "migrations"
SCHEMA_ZOD = RAIZ / "packages" / "shared" / "src" / "schemas" / "financial-account-control.schema.ts"

# As cinco colunas derivadas da onda, com a migration que as cria (localizada por CONTEUDO).
COLUNAS_DERIVADAS = (
    "competence_month",
    "days_late",
    "extraction_confidence",
    "installment_number",
    "installment_base",
)


def _sem_comentarios(sql: str) -> str:
    """Remove os comentarios `--` do SQL, preservando o que esta DENTRO de string literal.

    🔴 E a lente obrigatoria de toda guarda deste arquivo — inclusive das que so PROCURAM algo, nao
    so das que checam ausencia. Motivo medido na primeira execucao destes testes: a migration 105
    cita `competence_month` num comentario ("mesma familia da licao do competence_month, na Onda
    6"), e o localizador por conteudo devolveu DUAS migrations. Pior: `to_char` e
    `installment_total` aparecem nos comentarios das migrations da onda exatamente para explicar
    por que NAO devem ser usados — um `assert 'to_char' not in sql` casaria a propria advertencia e
    ficaria vermelho para sempre.

    Um `re.sub(r'--[^\\n]*', '', sql)` ingenuo nao serve: cortaria a partir de um `--` dentro de
    string literal (ex.: uma mensagem de RAISE que contenha dois hifens), engolindo codigo real.
    Daqui em diante, comparar sempre com o CODIGO.
    """
    saida: list[str] = []
    i, n = 0, len(sql)
    em_string = False
    while i < n:
        c = sql[i]
        if em_string:
            saida.append(c)
            if c == "'":
                # '' e aspa escapada dentro da string, nao o fim dela.
                if i + 1 < n and sql[i + 1] == "'":
                    saida.append(sql[i + 1])
                    i += 2
                    continue
                em_string = False
            i += 1
            continue
        if c == "'":
            em_string = True
            saida.append(c)
            i += 1
            continue
        if c == "-" and i + 1 < n and sql[i + 1] == "-":
            while i < n and sql[i] != "\n":
                i += 1
            continue
        saida.append(c)
        i += 1
    return "".join(saida)


def _codigo(p: Path) -> str:
    return _sem_comentarios(p.read_text(encoding="utf-8"))


def _bloco_schema_leitura() -> str:
    """Corpo do `financialAccountControlSchema = z.object({ ... })` — SO o schema de leitura.

    🔴 Procurar a coluna no arquivo INTEIRO nao serve, e o mutante provou: `installment_base:` tambem
    aparece como `installment_base: true` dentro do `.omit()`, entao apagar o campo do schema de
    leitura deixava a guarda VERDE — ela achava a entrada do omit. Escopo errado transforma a
    guarda em "existe a palavra em algum lugar do arquivo".
    """
    zod = SCHEMA_ZOD.read_text(encoding="utf-8")
    m = re.search(
        r"export const financialAccountControlSchema = z\.object\(\{(.*?)\n\}\);", zod, re.DOTALL
    )
    assert m, "nao achei o bloco do schema de leitura (o formato mudou?)"
    return m.group(1)


def _corpo_funcao(sql: str, nome: str) -> str:
    """Corpo `$$ ... $$` da funcao — para a guarda olhar a implementacao, nao o arquivo todo.

    🔴 Tambem veio de mutante sobrevivente: `fac_installment_number` e `fac_installment_base` usam o
    MESMO regexp_replace, entao remove-lo de uma delas deixava o texto presente na outra e a guarda
    passava. Escopo por funcao e o que torna a asserção especifica.
    """
    m = re.search(rf"CREATE OR REPLACE FUNCTION public\.{nome}\(.*?\$\$(.*?)\$\$;", sql, re.DOTALL)
    assert m, f"nao achei o corpo de {nome}"
    return m.group(1)


def _migration_que_contem(*trechos: str) -> Path:
    """A migration MAIS RECENTE cujo CODIGO contem TODOS os trechos. Por conteudo, nao por nome.

    🔴 Devolve a ULTIMA (maior numero), nao "a unica" — mudanca de 2026-08-10, ao criar a migration
    116. Numa cadeia de migrations um objeto pode ser REDEFINIDO por um arquivo posterior, e a
    definicao que vale (a que esta no banco) e a ultima. A versao anterior exigia
    `len(alvos) == 1` e passou a FALHAR assim que a 116 recriou `analytics.fornecedores_recorrentes`
    — as guardas G7 quebravam com "achei ['115...', '116...']", que e ambiguidade do localizador,
    nao defeito do codigo revisado.

    Seguir a ultima e o comportamento correto por outro motivo, mais forte: as invariantes de G7
    (SECURITY INVOKER, search_path fixo, bandas disjuntas, anon sem EXECUTE) precisam valer sobre a
    definicao VIGENTE. Travá-las na 115 deixaria a 116 livre para regredir qualquer uma delas com a
    suite verde.

    O `sorted` e por NOME, e a numeracao do projeto e zero-padded de largura fixa (001..116), entao
    ordem lexicografica == ordem cronologica. A assercao abaixo protege contra o dia em que alguem
    criar `9_foo.sql` sem padding.
    """
    alvos = sorted(p for p in MIGRACOES.glob("*.sql") if all(t in _codigo(p) for t in trechos))
    assert alvos, f"nenhuma migration contem {trechos}"
    assert all(re.match(r"^\d{3}_", p.name) for p in alvos), (
        f"migration fora do padrao 'NNN_' quebra a ordenacao por nome: {[p.name for p in alvos]}"
    )
    return alvos[-1]


def _expressao_gerada(sql: str, coluna: str) -> str:
    """Corpo do `GENERATED ALWAYS AS ( ... ) STORED` da coluna, so o CODIGO.

    Faz contagem de parenteses porque a expressao tem parenteses aninhados (CASE/WHEN, chamadas de
    funcao) — um regex nao-guloso pararia no primeiro `)`.
    """
    marca = re.search(
        rf"ADD COLUMN IF NOT EXISTS\s+{re.escape(coluna)}\b[^\n]*\n?\s*GENERATED ALWAYS AS\s*\(",
        sql,
    )
    assert marca, f"nao achei a expressao gerada de {coluna} (o formato do DDL mudou?)"

    i = marca.end()          # logo apos o '(' de abertura
    profundidade = 1
    inicio = i
    while i < len(sql) and profundidade > 0:
        if sql[i] == "(":
            profundidade += 1
        elif sql[i] == ")":
            profundidade -= 1
        i += 1
    assert profundidade == 0, f"parenteses desbalanceados na expressao de {coluna}"
    return sql[inicio : i - 1]


class SanidadeDoParserTest(unittest.TestCase):
    """Sem estes casos, um extrator quebrado deixaria as guardas vacuamente verdes."""

    def test_extrai_expressao_com_parenteses_aninhados(self):
        sql = (
            "ALTER TABLE x\n"
            "    ADD COLUMN IF NOT EXISTS foo date\n"
            "    GENERATED ALWAYS AS (\n"
            "        CASE WHEN a ~ 'x' THEN make_date(f(1), g(2), 1) ELSE NULL END\n"
            "    ) STORED;\n"
        )
        expr = _expressao_gerada(sql, "foo")
        self.assertIn("make_date", expr)
        self.assertIn("ELSE NULL END", expr)
        # Provou que nao parou no primeiro ')': o texto apos make_date(...) tem de estar presente.
        self.assertNotIn("STORED", expr)

    def test_localizador_de_migration_e_o_arquivo_do_schema_existem(self):
        self.assertTrue(SCHEMA_ZOD.exists(), "o schema Zod compartilhado sumiu ou foi movido")
        self.assertTrue(MIGRACOES.is_dir(), "supabase/migrations sumiu")

    def test_remove_comentario_mas_preserva_string_literal(self):
        sql = "SELECT 'a--b' AS x; -- isto some\nSELECT 2;"
        limpo = _sem_comentarios(sql)
        self.assertIn("'a--b'", limpo, "cortou dentro de string literal — engoliria codigo real")
        self.assertNotIn("isto some", limpo)
        self.assertIn("SELECT 2;", limpo)

    def test_a_lente_de_codigo_realmente_muda_o_resultado(self):
        # Sanidade da PROPRIA lente: as migrations da onda citam `installment_total` e `to_char`
        # nos comentarios, de proposito. Se _sem_comentarios parasse de funcionar, as guardas de
        # ausencia ficariam vermelhas para sempre — e alguem as "consertaria" afrouxando.
        bruto = _migration_que_contem(
            "CREATE OR REPLACE FUNCTION public.fac_installment_number"
        ).read_text(encoding="utf-8")
        self.assertIn("installment_total", bruto, "o comentario explicativo sumiu da migration?")
        self.assertNotIn("installment_total", _sem_comentarios(bruto))


class G1ColunasGeradasVisiveisNoSistemaTest(unittest.TestCase):
    """Toda coluna GERADA precisa existir nas TRES camadas — ou vira dado invisivel.

    Esta e a guarda que fecha a lacuna: antes da Onda 6 nao havia NADA comparando as colunas das
    migrations com o schema Zod. Uma coluna podia nascer no banco e o sistema inteiro ignora-la.
    """

    def _colunas_geradas_nas_migrations(self) -> set[str]:
        achadas: set[str] = set()
        for p in MIGRACOES.glob("*.sql"):
            # Ancorado na TABELA: sem isso, `body_search` (coluna gerada de email_control, migration
            # 105) entraria na lista e a guarda exigiria que ela estivesse no schema de contas.
            for m in re.finditer(
                r"ALTER TABLE\s+public\.financial_account_control\s+"
                r"ADD COLUMN IF NOT EXISTS\s+([a-z_]+)\s+[a-z]+[^\n]*\n?\s*GENERATED ALWAYS AS",
                _codigo(p),
            ):
                achadas.add(m.group(1))
        return achadas

    def test_sanidade_do_parser(self):
        achadas = self._colunas_geradas_nas_migrations()
        self.assertGreaterEqual(
            len(achadas), 5, f"o parser deixou de casar as colunas geradas (achou {achadas})"
        )

    def test_toda_coluna_gerada_esta_no_schema_de_leitura(self):
        # Escopado ao BLOCO do schema de leitura: no arquivo inteiro, a entrada do .omit()
        # (`coluna: true`) casaria o mesmo regex e a guarda passaria com o campo apagado.
        leitura = _bloco_schema_leitura()
        for coluna in sorted(self._colunas_geradas_nas_migrations()):
            self.assertRegex(
                leitura,
                re.compile(rf"^\s*{coluna}:\s*(?!true\b)", re.MULTILINE),
                f"a coluna gerada '{coluna}' existe no banco e NAO esta no schema Zod — ela e "
                "invisivel para a API, o frontend e qualquer consumidor de tipo",
            )

    def test_toda_coluna_gerada_esta_no_omit_do_input(self):
        zod = SCHEMA_ZOD.read_text(encoding="utf-8")
        m = re.search(
            r"financialAccountControlInputSchema\s*=\s*financialAccountControlSchema\.omit\(\{(.*?)\}\)",
            zod,
            re.DOTALL,
        )
        assert m, "nao achei o .omit() do inputSchema (o formato mudou?)"
        bloco = m.group(1)

        for coluna in sorted(self._colunas_geradas_nas_migrations()):
            self.assertIn(
                f"{coluna}: true",
                bloco,
                f"'{coluna}' e GENERATED e NAO esta no .omit() do inputSchema — um write path que "
                "use esse schema direto vai receber 428C9 do PostgreSQL e a gravacao quebra",
            )

    def test_as_cinco_da_onda_6_estao_expostas_na_view(self):
        view = _codigo(_migration_que_contem(
            "CREATE OR REPLACE VIEW analytics.vw_payables", "f.installment_base"
        ))
        for coluna in COLUNAS_DERIVADAS:
            self.assertIn(
                f"f.{coluna}",
                view,
                f"'{coluna}' nao foi exposta em vw_payables — o chat nao consegue enxerga-la",
            )


class G2CompetenceMonthTest(unittest.TestCase):
    """A conversao de competencia tem duas armadilhas, e as duas quebram a EXTRACAO, nao a leitura."""

    def setUp(self):
        sql = _codigo(_migration_que_contem("ADD COLUMN IF NOT EXISTS competence_month"))
        self.expr = _expressao_gerada(sql, "competence_month")

    def test_usa_make_date_e_nao_uma_funcao_STABLE(self):
        # to_date(text,text) e ::date sao STABLE — conferido em pg_proc desta base. O PostgreSQL
        # recusa expressao nao-IMMUTABLE em coluna gerada, entao usar qualquer um dos dois impede
        # ate a criacao da coluna. (O roadmap prescrevia to_date; estava errado.)
        self.assertIn("make_date", self.expr)
        self.assertNotIn("to_date", self.expr)
        self.assertNotIn("::date", self.expr)

    def test_nao_cai_para_due_date(self):
        # Competencia e declaracao contabil; vencimento e caixa. Preencher a lacuna dos ~87% com
        # date_trunc('month', due_date) daria um numero plausivel e errado.
        self.assertNotIn("due_date", self.expr)

    def test_o_regex_guarda_a_conversao(self):
        m = re.search(r"~\s*'(\^[^']+)'", self.expr)
        assert m, "nao achei o regex de guarda na expressao (sem ele, '2026-13' derruba o INSERT)"
        padrao = m.group(1)

        # Reimplementa a guarda EM PYTHON usando o padrao EXTRAIDO — nao uma copia escrita a mao.
        compilado = re.compile(padrao)
        self.assertTrue(compilado.match("2026-07"), "o regex extraido rejeita competencia valida")
        self.assertIsNone(compilado.match("2026-13"), "mes 13 passaria e o INSERT morreria com 22008")
        self.assertIsNone(compilado.match("2026-00"), "mes 00 passaria")
        self.assertIsNone(compilado.match("julho/26"), "texto livre passaria")


class G5ExtractionConfidenceTest(unittest.TestCase):
    """O CASE precisa cobrir TODO o dominio de extraction_source e ter ELSE."""

    def setUp(self):
        sql = _codigo(_migration_que_contem("ADD COLUMN IF NOT EXISTS extraction_confidence"))
        self.expr = _expressao_gerada(sql, "extraction_confidence")
        self.zod = SCHEMA_ZOD.read_text(encoding="utf-8")

    def _dominio_zod(self, const: str) -> list[str]:
        m = re.search(rf"export const {const} = \[(.*?)\] as const;", self.zod, re.DOTALL)
        assert m, f"nao achei {const} no schema Zod"
        valores = re.findall(r"'([^']+)'", m.group(1))
        assert valores, f"{const} foi encontrado mas veio vazio"
        return valores

    def test_todo_extraction_source_tem_mapeamento(self):
        for fonte in self._dominio_zod("EXTRACTION_SOURCES"):
            if fonte == "falha":
                continue  # cai no ELSE de proposito: extracao que falhou nao tem confianca
            self.assertIn(
                f"'{fonte}'",
                self.expr,
                f"a fonte '{fonte}' existe no dominio e nao aparece no CASE — cairia no ELSE e "
                "viraria 'desconhecida' sem ninguem perceber",
            )

    def test_o_ELSE_existe(self):
        # Sem ELSE, um valor novo viraria NULL silencioso e a coluna deixaria de ser total.
        self.assertRegex(self.expr, r"\bELSE\b")

    def test_valores_emitidos_estao_no_dominio_do_Zod(self):
        emitidos = set(re.findall(r"THEN\s+'([a-z]+)'", self.expr))
        emitidos |= set(re.findall(r"ELSE\s+'([a-z]+)'", self.expr))
        self.assertTrue(emitidos, "o parser nao achou nenhum valor emitido pelo CASE")
        self.assertLessEqual(
            emitidos,
            set(self._dominio_zod("EXTRACTION_CONFIDENCES")),
            "o CASE emite valor que nao existe em EXTRACTION_CONFIDENCES",
        )

    def test_trata_o_NULL_explicitamente(self):
        # extraction_source NULL = conta digitada no CRUD. Sem o ramo, cairia no ELSE e a criacao
        # manual (142 contas na medicao) apareceria como 'desconhecida'.
        self.assertIn("IS NULL", self.expr)

    def test_nao_e_numerico(self):
        self.assertNotRegex(
            self.expr,
            r"THEN\s+[0-9]",
            "confianca virou numero — o eixo e proveniencia, nao probabilidade calibrada",
        )


class G6DaysLateTest(unittest.TestCase):
    """days_late so pode olhar a propria linha — e o bug da migration 095 mora aqui."""

    def setUp(self):
        sql = _codigo(_migration_que_contem("ADD COLUMN IF NOT EXISTS days_late"))
        self.expr = _expressao_gerada(sql, "days_late")

    def test_e_exatamente_pagamento_menos_vencimento(self):
        self.assertEqual(self.expr.strip(), "payment_date - due_date")

    def test_nao_usa_a_data_de_hoje(self):
        # CURRENT_DATE/now() nem seriam aceitos (nao sao IMMUTABLE), mas o motivo de fundo importa:
        # seria uma coluna que MUDA com o tempo sem nenhum UPDATE — exatamente o defeito que a
        # migration 095 teve de consertar na trigger de situacao.
        for proibido in ("CURRENT_DATE", "now()", "CURRENT_TIMESTAMP"):
            self.assertNotIn(proibido.lower(), self.expr.lower())

    def test_nao_normaliza_o_negativo(self):
        # 13 contas antecipadas na medicao de 2026-08-10. GREATEST(...,0) as zeraria e faria
        # qualquer media de atraso mentir para cima.
        self.assertNotIn("GREATEST", self.expr.upper())


class G4ParcelaTest(unittest.TestCase):
    """A regra de plausibilidade da parcela, EXTRAIDA da migration e aplicada a amostra REAL.

    Os vetores sao dados de producao (2026-08-10). Os dois primeiros sao os falsos positivos que
    motivaram a regra: casam a regex ingenua `\\d+/\\d+$` e nao sao parcela nenhuma.
    """

    AMOSTRA = [
        ("09/00018287242", None),   # nosso-numero (11 digitos no sufixo)
        ("09/00018286636", None),
        ("109/09116041", None),     # idem, familia inteira na base
        ("112/250202614", None),
        ("2026/07", None),          # competencia escrita como documento
        ("09/12", None),            # prefixo curto = carteira/banco
        ("962148 / 03", 3),
        ("959924 / 3", 3),
        ("19019 / 1", 1),
        ("19019 / 2", 2),
        ("19019 / 3", 3),
        ("962148/002", 2),
        ("962148/002(2)", 2),       # sufixo (N) do unique_invoice_number
        ("17441/1", 1),
        ("sem barra nenhuma", None),
    ]

    def setUp(self):
        self.sql = _codigo(_migration_que_contem("CREATE OR REPLACE FUNCTION public.fac_installment_number"))

    def test_sanidade_do_parser(self):
        self.assertIn("fac_installment_base", self.sql)
        self.assertIn("regexp_match", self.sql)

    def test_descasca_o_sufixo_de_desambiguacao(self):
        # unique_invoice_number (read_emails.py) grava base(2), base(3)... Sem descascar, a parcela
        # sumiria justamente nas contas reemitidas.
        # Escopado ao CORPO da funcao: as duas funcoes usam o mesmo regexp_replace, entao procurar
        # no arquivo inteiro deixava a guarda verde com o descascamento removido de uma delas.
        corpo = _corpo_funcao(self.sql, "fac_installment_number")
        self.assertIn("regexp_replace", corpo, "o descascamento do sufixo (N) sumiu")
        self.assertIn(r"'\(\d+\)$'", corpo)

    def test_o_teto_do_sufixo_e_de_3_digitos(self):
        m = re.search(r"length\(sufixo\)\s*>\s*(\d+)", self.sql)
        assert m, "nao achei o teto de digitos do sufixo (P1)"
        self.assertEqual(
            int(m.group(1)), 3,
            "afrouxar o teto faz '09/00018287242' virar parcela 18.287.242",
        )

    def test_a_faixa_da_parcela_esta_declarada(self):
        m = re.search(r"n\s*<\s*(\d+)\s*OR\s*n\s*>\s*(\d+)", self.sql)
        assert m, "nao achei a faixa 1..120 (P2) — ela tambem blinda o cast para smallint"
        self.assertEqual((int(m.group(1)), int(m.group(2))), (1, 120))

    def test_rejeita_competencia_como_documento(self):
        self.assertIn(r"'^(19|20)\d{2}$'", self.sql, "sem P4, '2026/07' vira parcela 7")

    def test_a_regra_extraida_reproduz_a_amostra_real(self):
        """Reimplementa a regra EM PYTHON usando os parametros extraidos do SQL."""
        strip_re = re.compile(r"\(\d+\)$")
        split_re = re.compile(r"^(.*?)\s*/\s*(\d+)$")
        teto = int(re.search(r"length\(sufixo\)\s*>\s*(\d+)", self.sql).group(1))
        low, high = (int(x) for x in re.search(r"n\s*<\s*(\d+)\s*OR\s*n\s*>\s*(\d+)", self.sql).groups())
        ano_re = re.compile(r"^(19|20)\d{2}$")

        def parcela(valor: str):
            base = strip_re.sub("", valor.strip()).strip()
            m = split_re.match(base)
            if not m:
                return None
            prefixo, sufixo = m.group(1).strip(), m.group(2)
            if len(sufixo) > teto:
                return None
            n = int(sufixo)
            if n < low or n > high:
                return None
            if len(re.sub(r"\D", "", prefixo)) < 3:
                return None
            if ano_re.match(prefixo) and n <= 12:
                return None
            if re.match(r"^\d{1,2}/\d{1,2}$", prefixo):
                return None
            return n

        for entrada, esperado in self.AMOSTRA:
            with self.subTest(entrada=entrada):
                self.assertEqual(parcela(entrada), esperado)

    def test_nao_existe_coluna_de_TOTAL_de_parcelas(self):
        # O total NAO existe na origem: o reader grava doc/ORDINAL (read_emails.py:5289). Criar
        # `installment_total` a partir do sufixo escreveria "3 de 3" num carne de 12.
        for p in MIGRACOES.glob("*.sql"):
            self.assertNotIn(
                "installment_total",
                _codigo(p),
                f"{p.name} cria installment_total — o total nao existe na origem; use "
                "analytics.parcelamentos(), que devolve o OBSERVADO e as parcelas faltando",
            )


class G3DimDateTest(unittest.TestCase):
    """O calendario erra em silencio: 'faltam 3 dias uteis' onde faltam 2."""

    def setUp(self):
        self.sql = _codigo(_migration_que_contem("CREATE TABLE IF NOT EXISTS public.dim_date"))

    def test_sanidade_do_parser(self):
        self.assertIn("CREATE TABLE IF NOT EXISTS public.dim_date", self.sql)

    def test_as_funcoes_sao_IMMUTABLE(self):
        # STABLE aqui impediria o uso em qualquer coluna gerada futura — e o erro so apareceria la.
        for fn in ("br_easter", "br_holiday_name"):
            bloco = re.search(
                rf"CREATE OR REPLACE FUNCTION public\.{fn}\(.*?\$\$", self.sql, re.DOTALL
            )
            assert bloco, f"nao achei a definicao de {fn}"
            self.assertIn("IMMUTABLE", bloco.group(0))

    def test_nao_usa_to_char(self):
        # to_char e STABLE (depende de lc_time): o nome do mes dependeria da sessao de quem rodou
        # o INSERT. Os nomes em pt-BR saem de CASE explicito.
        self.assertNotIn("to_char", self.sql)

    def test_a_migration_se_auto_verifica_e_ABORTA(self):
        self.assertIn("RAISE EXCEPTION", self.sql)
        # Vetores de Pascoa conferidos contra calendario civil (fonte independente do algoritmo).
        # 🔴 A asserção olha a COMPARAÇÃO, nao a presença do texto: a mensagem de erro do RAISE
        # repete a data esperada, e um `assertIn('2026-04-05', sql)` continuava verde com o vetor
        # da comparacao trocado — a guarda estava lendo a mensagem, nao a verificacao.
        for ano, esperado in ((2024, "2024-03-31"), (2025, "2025-04-20"), (2026, "2026-04-05")):
            self.assertRegex(
                self.sql,
                re.compile(rf"br_easter\({ano}\)\s*<>\s*DATE '{esperado}'"),
                f"a migration nao COMPARA br_easter({ano}) com {esperado}",
            )

    def test_o_oraculo_diferencial_tabela_x_funcao_existe(self):
        self.assertIn("IS DISTINCT FROM public.br_holiday_name", self.sql)

    def test_respeita_a_vigencia_da_lei_da_consciencia_negra(self):
        # Nacional so a partir de 2024 (Lei 14.759/2023). Marca-lo em 2015 diria "banco fechado"
        # num dia em que ele operou.
        self.assertRegex(self.sql, r"ano\s*>=\s*2024")


class G7RecorrenciaTest(unittest.TestCase):
    """Recorrencia por CADENCIA, com a RLS valendo — as duas coisas erram em silencio."""

    def setUp(self):
        self.sql = _codigo(_migration_que_contem("CREATE OR REPLACE FUNCTION analytics.fornecedores_recorrentes"))
        m = re.search(
            r"CREATE OR REPLACE FUNCTION analytics\.fornecedores_recorrentes(.*?)\$\$;",
            self.sql,
            re.DOTALL,
        )
        assert m, "nao achei a definicao de fornecedores_recorrentes"
        self.corpo = m.group(1)

    def test_e_SECURITY_INVOKER(self):
        # DEFINER aqui seria escalada silenciosa: um usuario restrito veria a cadencia de
        # fornecedores que ele nao pode enxergar.
        self.assertIn("SECURITY INVOKER", self.corpo)
        self.assertNotIn("SECURITY DEFINER", self.corpo)

    def test_fixa_o_search_path(self):
        self.assertIn("SET search_path = ''", self.corpo)

    def test_o_anon_perde_o_EXECUTE(self):
        self.assertRegex(self.sql, r"REVOKE\s+EXECUTE[^;]*fornecedores_recorrentes[^;]*anon")

    def test_classifica_por_INTERVALO_e_nunca_por_valor(self):
        classificacao = re.search(r"classificado AS \((.*?)\n    \)", self.corpo, re.DOTALL)
        assert classificacao, "nao achei o bloco de classificacao de cadencia"
        self.assertIn("mediana", classificacao.group(1))
        self.assertNotIn(
            "amount",
            classificacao.group(1),
            "a cadencia passou a olhar valor — so 3 de 11 recorrentes tem valor estavel, entao "
            "classificar por valor descartaria os outros 8",
        )

    def test_mede_a_cadencia_entre_DATAS_DISTINTAS(self):
        # Defeito real encontrado ao RODAR a funcao (2026-08-10): medindo entre CONTAS, um
        # fornecedor com 53 contas em 21 datas gera intervalos zero, a mediana desaba e sai
        # "cadencia semanal, confianca provavel" para serie sem cadencia nenhuma.
        self.assertRegex(self.corpo, re.compile(r"datas AS \(.*?GROUP BY 1, 2", re.DOTALL))

    def test_a_saida_carrega_a_propria_ressalva(self):
        # Quem quiser so a palavra "mensal" tera de ignorar ativamente os campos que a contradizem.
        for campo in ("ocorrencias", "intervalo_min_dias", "intervalo_max_dias", "confianca", "regular"):
            self.assertIn(campo, self.corpo, f"a saida perdeu o campo de honestidade '{campo}'")

    def test_as_bandas_de_cadencia_sao_disjuntas(self):
        bandas = [
            (int(a), int(b))
            for a, b in re.findall(r"mediana BETWEEN\s+(\d+)\s+AND\s+(\d+)", self.corpo)
        ]
        self.assertGreaterEqual(len(bandas), 4, "o parser nao achou as bandas de cadencia")
        ordenadas = sorted(bandas)
        for (_, fim), (ini, _) in zip(ordenadas, ordenadas[1:]):
            self.assertLess(
                fim, ini,
                "as bandas de cadencia se sobrepoem — com faixas derivadas de uma tolerancia de 5 "
                "dias, 'semanal' virava [2,12] e uma mediana de 2 dias saia rotulada semanal",
            )


class G9TruncagemDeclaradaTest(unittest.TestCase):
    """Funcao com LIMIT tem de DECLARAR o total — senao truncar e indistinguivel de "acabou".

    Achado B1 do code review de 2026-08-10, medido no banco: `fornecedores_recorrentes()` devolvia
    50 de 63 fornecedores sem nenhum campo indicando o corte. Quem contasse as linhas responderia
    "50 fornecedores recorrentes" — errado, plausivel e sem erro nenhum. E a MESMA armadilha ja
    corrigida em `gasto_por_fornecedor` (Onda 1) e `documentos_fiscais` (Onda 3, migration 108).

    Esta guarda existe porque o defeito e INVISIVEL em teste de dado: a funcao responde 200, com
    linhas validas. So a comparacao entre o total declarado e o total real o revela.
    """

    FUNCOES = ("analytics.fornecedores_recorrentes", "analytics.parcelamentos")

    def setUp(self):
        # Localiza pela definicao VIGENTE (a 116 redefine as duas da 115).
        self.sql = _codigo(_migration_que_contem(
            "DROP FUNCTION IF EXISTS analytics.fornecedores_recorrentes"
        ))

    def _corpo(self, nome: str) -> str:
        m = re.search(rf"CREATE FUNCTION {re.escape(nome)}\(.*?\$\$(.*?)\$\$;", self.sql, re.DOTALL)
        assert m, f"nao achei o corpo de {nome} (a migration mudou de forma?)"
        return m.group(1)

    def test_sanidade_do_parser(self):
        # Sem isto, um regex que pare de casar deixaria TODA a classe vacuamente verde.
        for nome in self.FUNCOES:
            self.assertIn("LIMIT", self._corpo(nome), f"o parser nao achou o corpo de {nome}")

    def test_toda_funcao_com_LIMIT_declara_o_total(self):
        for nome in self.FUNCOES:
            with self.subTest(funcao=nome):
                # RETURNS TABLE — a coluna precisa EXISTIR na assinatura, nao so no SELECT.
                assinatura = re.search(
                    rf"CREATE FUNCTION {re.escape(nome)}\(.*?RETURNS TABLE\s*\((.*?)\)\s*LANGUAGE",
                    self.sql, re.DOTALL,
                )
                assert assinatura, f"nao achei o RETURNS TABLE de {nome}"
                self.assertIn(
                    "total_encontrado", assinatura.group(1),
                    f"{nome} tem LIMIT e nao declara total_encontrado — truncar fica indistinguivel "
                    "de nao haver mais nada, e quem contar as linhas erra o numero",
                )

    def test_o_total_e_JANELA_e_nao_subconsulta(self):
        # `count(*) OVER ()` e avaliado ANTES do ORDER BY/LIMIT. Uma subconsulta que repetisse o
        # corpo herdaria o LIMIT e devolveria o total TRUNCADO — o mesmo bug com cara de correcao.
        for nome in self.FUNCOES:
            with self.subTest(funcao=nome):
                self.assertRegex(
                    self._corpo(nome), r"\(count\(\*\)\s*OVER\s*\(\)\)::integer",
                    f"{nome} nao usa (count(*) OVER ())::integer — os parenteses externos tambem "
                    "importam: sem eles o cast cai sobre a janela vazia",
                )

    def test_o_LIMIT_e_protegido_contra_valor_negativo(self):
        # LIMIT negativo levanta 2201W em runtime. p_limit vem de parametro de tool/LLM.
        for nome in self.FUNCOES:
            with self.subTest(funcao=nome):
                self.assertRegex(
                    self._corpo(nome), r"LIMIT\s+GREATEST\(COALESCE\(p_limit,\s*\d+\),\s*0\)",
                    f"{nome} nao protege o LIMIT — p_limit negativo derruba a chamada",
                )

    def test_a_ordem_e_TOTAL_para_o_recorte_ser_deterministico(self):
        """Sem desempate unico, o LIMIT recorta um conjunto que varia com o plano de execucao.

        Mesma licao de lib/stableOrder.ts e do applyOrder da Next API: `ORDER BY` que empata +
        corte = linha que aparece numa execucao e some na seguinte, sem erro. Aqui o sintoma seria
        "o ranking mudou sozinho".
        """
        esperado = {
            # a PK do agrupamento fecha a ordem em cada funcao
            "analytics.fornecedores_recorrentes": r"ORDER BY[^;]*?c\.sk_supplier\s*\n?\s*(--|LIMIT)",
            "analytics.parcelamentos": r"ORDER BY[^;]*?p\.sk_supplier,\s*p\.installment_base",
        }
        for nome, padrao in esperado.items():
            with self.subTest(funcao=nome):
                self.assertRegex(
                    self._corpo(nome), re.compile(padrao, re.DOTALL),
                    f"o ORDER BY de {nome} nao termina em chave unica — o recorte do LIMIT fica "
                    "dependente do plano de execucao",
                )

    def test_a_migration_se_auto_verifica_comparando_declarado_x_real(self):
        # O oraculo tem de comparar os DOIS CAMINHOS entre si, nunca contra um numero fixo: 63 e 10
        # derivam a cada conta lancada e um assert fixo ficaria vermelho sozinho em dias.
        self.assertIn("RAISE EXCEPTION", self.sql)
        self.assertRegex(
            self.sql, re.compile(r"declarado IS DISTINCT FROM real_", re.DOTALL),
            "a migration nao compara o total declarado com o total real",
        )
        self.assertNotRegex(
            self.sql, r"IS DISTINCT FROM\s+63\b",
            "o oraculo fixou um numero que deriva com o dado",
        )

    def test_o_DROP_reemite_os_grants(self):
        # DROP FUNCTION leva os grants junto: sem reemitir, a funcao nasce aberta a PUBLIC e
        # fechada para authenticated — aberta para quem nao deve, quebrada para quem deve.
        for nome in self.FUNCOES:
            with self.subTest(funcao=nome):
                self.assertRegex(
                    self.sql, re.compile(rf"GRANT\s+EXECUTE[^;]*{re.escape(nome)}[^;]*authenticated"),
                    f"{nome} foi recriada sem devolver o EXECUTE a authenticated",
                )
                self.assertRegex(
                    self.sql, re.compile(rf"REVOKE\s+EXECUTE[^;]*{re.escape(nome)}[^;]*anon"),
                    f"{nome} foi recriada sem revogar o EXECUTE de anon",
                )


class G8PonteiroNavegavelTest(unittest.TestCase):
    """Cada migration da onda cita ESTE arquivo: renomear o teste deixa o ponteiro cego."""

    def test_as_migrations_da_onda_citam_este_arquivo(self):
        eu = Path(__file__).name
        marcadores = (
            ("CREATE TABLE IF NOT EXISTS public.dim_date",),                    # 111
            ("ADD COLUMN IF NOT EXISTS competence_month",),                     # 112
            ("CREATE OR REPLACE FUNCTION public.fac_installment_number",),      # 113
            ("ADD COLUMN IF NOT EXISTS installment_base",),                     # 114
            # 🔴 A 115 e localizada pela VIEW, nao pela funcao de recorrencia: desde a 116 o
            # localizador devolve a definicao VIGENTE, entao o marcador da funcao resolveria para a
            # 116 e a 115 deixaria de ser verificada em silencio.
            ("CREATE OR REPLACE VIEW analytics.vw_payables", "f.installment_base"),   # 115
            ("DROP FUNCTION IF EXISTS analytics.fornecedores_recorrentes",),    # 116
        )
        vistos = set()
        for trechos in marcadores:
            p = _migration_que_contem(*trechos)
            vistos.add(p.name)
            self.assertIn(eu, p.read_text(encoding="utf-8"), f"{p.name} nao cita {eu}")
        # Sanidade: os marcadores tem de apontar para arquivos DISTINTOS. Sem isto, dois marcadores
        # colapsando na mesma migration deixariam outra sem verificacao nenhuma — que e exatamente
        # o modo de falha que a mudanca do localizador introduziu.
        self.assertEqual(
            len(vistos), len(marcadores),
            f"marcadores colidiram na mesma migration: {sorted(vistos)}",
        )


if __name__ == "__main__":
    unittest.main()
