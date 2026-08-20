"""`document_type = 'dar / dare'` — Documento de Arrecadação estadual (migrations 132/133).

Caso de origem: conta id 1101, guia da Junta Comercial de Mato Grosso encaminhada pelo
despachante. O PDF imprime "DOCUMENTO DE ARRECADAÇÃO - DAR MODELO 1 - AUT"; o extrator
não tinha o tipo e gravou o fallback genérico 'tributo'.

O domínio consolidou os DOIS acrônimos num tipo só: DAR e DARE nomeiam o MESMO
instrumento — a guia de arrecadação estadual — e o que varia é o estado que a imprime.
Mesmo padrão de 'dam / duam'. A 133 fez o backfill das 26 contas que diziam 'dare'.

🔴 POR QUE ESTE ARQUIVO EXISTE — `dar` é o acrônimo mais perigoso do domínio:
  * é PREFIXO de `darf`, um dos tributos mais frequentes do acervo;
  * é VERBO COMUM do português ("dar baixa", "dar entrada") e SUBSTRING de palavras
    corriqueiras ("padaria", "guardar", "dará").
A decisão é: a forma "dar" é auto-classificada APENAS por RÓTULO EXPLÍCITO
(`_DOC_TYPE_NORM`, lookup EXATO por dict) ou por FRASE inequívoca. "dare" é inequívoco
e pode casar puro. Nenhum classificador difuso casa a forma pura "dar".

Os testes marcados 🔴 travam essa decisão. Validados por MUTANTE: com `"dar"` puro em
`KEYWORDS`/`_SUBJECT_TAX_DOC_KEYWORDS`/`_BODY_DOC_KEYWORDS`, eles ficam VERMELHOS.
"""

import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import extract_pdf as E  # noqa: E402
import read_emails as R  # noqa: E402

DAR_DARE = "dar / dare"

# Trechos REAIS do PDF da conta 1101 (SEFAZ-MT / JUCEMAT), usados como oráculo.
PDF_1101 = (
    "GOVERNO DO ESTADO DE MATO GROSSO\n"
    "SECRETARIA DE ESTADO DE FAZENDA\n"
    "DOCUMENTO DE ARRECADACAO - DAR MODELO 1 - AUT\n"
    "24 - ESPECIFICACAO DA RECEITA 25 - CODIGO 26 - VALOR\n"
    "SERV.REG.COMERCIO JUCEMAT-CAPITAL 4546 51,00\n"
    "22 - DATA VENCTO. 17/09/2026\n"
    "TOTAL A RECOLHER 31 - VALOR 51,00\n"
    "85800000000-3 51000123202-8 60917454603-5 38037423190-4\n"
)

# Frases em que "dar" aparece como VERBO ou dentro de outra palavra. Nenhuma pode
# classificar como DAR / DARE — em nenhuma das três camadas.
FALSOS_POSITIVOS = (
    "padaria pao quente ltda",
    "favor guardar o comprovante em anexo",
    "o cliente dara entrada no processo amanha",
    "por gentileza dar baixa neste titulo",
    "precisamos dar entrada na documentacao",
    "aguardar retorno do financeiro",
)


class NormalizeDocTypeTest(unittest.TestCase):
    """O vetor primário: rótulo explícito → 'dar / dare', pelo lookup EXATO."""

    def test_rotulo_explicito_normaliza(self):
        for raw in ("DAR", "dar", "Dar", " dar ", "DAR-1", "DAR MODELO 1",
                    "DAR MODELO 1 - AUT", "DAR/AUT", "DAR-1/AUT", "DAR avulso",
                    "DARE", "dare", "DAR / DARE"):
            self.assertEqual(E._normalize_doc_type(raw), DAR_DARE, repr(raw))

    def test_darf_nao_vira_dar(self):
        """🔴 Anti-regressão do PREFIXO. Mutante: trocar o dict por startswith/prefixo."""
        self.assertEqual(E._normalize_doc_type("DARF"), "darf")
        self.assertEqual(E._normalize_doc_type("darf"), "darf")
        self.assertEqual(E._normalize_doc_type(" DARF "), "darf")

    def test_lixo_continua_caindo_em_outro(self):
        for raw in ("dario", "padaria", "guardar", "xyz", ""):
            self.assertEqual(E._normalize_doc_type(raw), "outro", repr(raw))


class ClassifyDocumentTest(unittest.TestCase):
    """`classify_document` (extract_pdf) casa por SUBSTRING — a camada mais frágil."""

    def test_dar_solto_no_texto_do_pdf_nao_classifica(self):
        """🔴 Mutante: KEYWORDS[_DAR_DARE] = ["dar"] → "padaria" vira uma guia."""
        for texto in FALSOS_POSITIVOS:
            self.assertNotEqual(E.classify_document(texto), E._DAR_DARE, repr(texto))

    def test_pdf_real_da_1101_classifica_como_dar(self):
        """Anti-vacuidade do caso acima: a frase impressa TEM de casar."""
        self.assertEqual(E.classify_document(PDF_1101), E._DAR_DARE)

    def test_dare_impresso_tambem_classifica(self):
        self.assertEqual(
            E.classify_document("Documento de Arrecadacao de Receitas Estaduais - DARE"),
            E._DAR_DARE)

    def test_documento_de_arrecadacao_estadual_e_DAE_nao_DAR(self):
        """🔴 Achado com PROVA no acervo: "Documento de Arrecadação Estadual" é o nome
        por EXTENSO do **DAE** em Pernambuco e no Ceará, NÃO do DAR. Cabeçalhos reais:
        conta 1103 = "DAE JUCEPE / Documento de Arrecadação Estadual"; conta 821 =
        "DAE - Documento de Arrecadação Estadual".

        Mutante: acrescentar "documento de arrecadacao estadual" às frases de
        _DAR_DARE — como esse bucket vem ANTES do DAE, TODO DAE passaria a ser gravado
        como DAR / DARE, sem erro nenhum."""
        for texto in (
            "Governo do Estado de Pernambuco\nDAE JUCEPE\n"
            "Documento de Arrecadacao Estadual\nATO: CERTIDAO DE INTEIRO TEOR",
            "DAE - Documento de Arrecadacao Estadual\n"
            "6491 - Emolumentos e Custas Judiciais",
        ):
            self.assertEqual(E.classify_document(texto), "DAE", repr(texto[:40]))

    def test_dare_nao_cai_mais_no_bucket_do_dae(self):
        """🔴 Regressão histórica: "dare" morava na lista do DAE (eSocial, FEDERAL), então
        toda DARE lida por este caminho saía rotulada como guia federal. Mutante: mover
        "dare" de volta para o bucket "DAE"."""
        self.assertNotEqual(E.classify_document("guia dare do estado"), "DAE")
        # Anti-vacuidade: o DAE de verdade continua sendo reconhecido.
        self.assertEqual(E.classify_document("documento de arrecadacao do esocial"), "DAE")

    def test_darf_no_texto_ainda_vence(self):
        self.assertEqual(E.classify_document("Documento de Arrecadacao de Receitas "
                                             "Federais - DARF"), "DARF")


class SubjectClassificationTest(unittest.TestCase):
    """`_SUBJECT_TAX_DOC_KEYWORDS` SOBREPÕE a classificação do PDF — falso positivo
    aqui corrompe um DARF corretamente extraído."""

    def test_dar_solto_no_assunto_nao_classifica(self):
        """🔴 Mutante: ("dar / dare", ["dar"]) na lista."""
        for assunto in FALSOS_POSITIVOS + ("PAGAMENTO PADARIA CENTRAL",):
            self.assertNotEqual(R._classify_tax_doc_type_from_subject(assunto), DAR_DARE,
                                repr(assunto))

    def test_frases_inequivocas_no_assunto_classificam(self):
        """Anti-vacuidade. Sem este caso o teste acima passaria com a lista VAZIA."""
        for assunto in ("PAGAMENTO DAR MODELO 1 - JUCEMAT",
                        "guia DAR-1 do estado", "envio do DAR avulso",
                        "PAGAMENTO DARE - REF. T05S1"):
            self.assertEqual(R._classify_tax_doc_type_from_subject(assunto), DAR_DARE,
                             repr(assunto))

    def test_darf_no_assunto_nao_vira_dar(self):
        self.assertEqual(R._classify_tax_doc_type_from_subject("PAGAMENTO DARF"), "darf")

    def test_documento_de_arrecadacao_estadual_no_assunto_nao_vira_dar(self):
        """Mesmo achado do PDF, na camada do assunto: a frase nomeia o DAE de PE/CE."""
        self.assertNotEqual(
            R._classify_tax_doc_type_from_subject("DAE - Documento de Arrecadacao Estadual"),
            DAR_DARE)
        self.assertEqual(
            R._classify_tax_doc_type_from_subject("DAE - Documento de Arrecadacao Estadual"),
            "dae")


class BodyClassificationTest(unittest.TestCase):
    """`_BODY_DOC_KEYWORDS` casa por palavra inteira — insuficiente para um verbo."""

    def test_dar_solto_no_corpo_nao_classifica(self):
        """🔴 Mutante: ("DAR / DARE", ["dar"]) na lista."""
        for corpo in FALSOS_POSITIVOS:
            self.assertNotEqual((R._classify_body_doc_type(corpo) or "").lower(),
                                DAR_DARE, repr(corpo))

    def test_frases_inequivocas_no_corpo_classificam(self):
        """Anti-vacuidade do caso acima."""
        for corpo in ("segue o DAR MODELO 1 para pagamento",
                      "Documento de Arrecadacao de Receitas Estaduais",
                      "segue a DARE do mes"):
            self.assertEqual((R._classify_body_doc_type(corpo) or "").lower(), DAR_DARE,
                             repr(corpo))

    def test_documento_de_arrecadacao_estadual_no_corpo_nao_vira_dar(self):
        """Mesmo achado, na camada do corpo — em DOIS cenários, porque um só não bastava.

        Com o acrônimo presente ("DAE - Documento de Arrecadação Estadual") quem protege
        é a ORDEM da lista, não a ausência da frase: o par 'DAE' vem antes. O caso que
        realmente trava a decisão é a frase SOZINHA, sem acrônimo — aí ela é ambígua
        (PE e CE a usam para o DAE; MT usa "DAR") e a resposta correta é o genérico
        'tributo', nunca DAR / DARE.

        Mutante: devolver "documento de arrecadacao estadual" às frases de DAR / DARE."""
        com_acronimo = (R._classify_body_doc_type("DAE - Documento de Arrecadacao Estadual") or "")
        self.assertEqual(com_acronimo, "DAE")

        sozinha = (R._classify_body_doc_type("Segue o Documento de Arrecadacao Estadual") or "")
        self.assertNotEqual(sozinha.lower(), DAR_DARE)
        self.assertEqual(sozinha, "tributo")


class TaxSemanticsTest(unittest.TestCase):
    """`dar / dare` é guia de arrecadação ESTADUAL e força o plano de contas."""

    def test_e_documento_de_tributo(self):
        for dt in (DAR_DARE, "DAR / DARE", "dar", "dare", "DAR"):
            self.assertTrue(R._is_tax_document(dt), dt)
        self.assertIn(DAR_DARE, E.TAX_DOC_TYPES)

    def test_forca_a_esfera_estadual(self):
        """🔴 Decisão do usuário: o tipo entra nas regras de plano de contas dos
        documentos tributários, na esfera ESTADUAL (4.4.02) — a mesma que o antigo
        'dare' já usava. Mutante: remover a entrada de _TAX_SPHERE_CHART_CODES."""
        self.assertEqual(R._resolve_tax_chart_code(DAR_DARE, ""), "4.4.02")
        self.assertEqual(R._resolve_tax_chart_code("dare", ""), "4.4.02")
        self.assertEqual(R._resolve_tax_chart_code("dar", ""), "4.4.02")

    def test_esfera_federal_e_municipal_nao_se_confundem(self):
        """Anti-vacuidade: o mapa não passou a devolver 4.4.02 para tudo."""
        self.assertEqual(R._resolve_tax_chart_code("darf", ""), "4.4.04")
        self.assertEqual(R._resolve_tax_chart_code("dam / duam", ""), "4.4.03")

    def test_tributo_generico_continua_sem_forcar(self):
        self.assertIsNone(R._resolve_tax_chart_code("tributo", ""))


class SupplierGuardTest(unittest.TestCase):
    """'DAR' no assunto nunca pode virar nome de fornecedor."""

    def test_dar_nao_e_fornecedor(self):
        for nome in ("DAR", "dar", "DAR MT", "DARE", "dare"):
            self.assertTrue(R._is_non_supplier_term(nome), nome)

    def test_nome_que_apenas_contem_dar_continua_fornecedor(self):
        """🔴 Contraprova. Mutante: _is_non_supplier_term por substring — apagaria
        fornecedores legítimos."""
        self.assertFalse(R._is_non_supplier_term("DAR ALIMENTOS LTDA"))
        self.assertFalse(R._is_non_supplier_term("PADARIA CENTRAL"))


class KeywordGuardTest(unittest.TestCase):
    """'dar' não é keyword de assunto — e, se alguém o tornar pelo .env, o casamento
    tem de ser por PALAVRA INTEIRA."""

    def test_dar_nao_e_keyword_default(self):
        self.assertNotIn("dar", [k.lower() for k in R.KEYWORDS_DEFAULT])

    def test_dar_esta_em_word_keywords(self):
        """🔴 Mutante: remover 'dar' de WORD_KEYWORDS → match_keyword volta ao
        casamento por substring e 'padaria' passa a disparar a extração."""
        self.assertIn("dar", R.WORD_KEYWORDS)
        self.assertIsNone(R.match_keyword("cadastro da padaria central", ["dar"]))
        self.assertIsNone(R.match_keyword("favor aguardar retorno", ["dar"]))
        # Anti-vacuidade: como PALAVRA inteira, ainda casa.
        self.assertEqual(R.match_keyword("segue o DAR do estado", ["dar"]), "dar")


class PromptTest(unittest.TestCase):
    """O prompt é o que faz o modelo emitir o rótulo — sem ele o vetor primário é inerte."""

    def test_prompt_cita_dar_dare_com_a_regra_anti_prefixo(self):
        prompt = E.EXTRACTION_PROMPT
        # Sanidade do parser: se o prompt for reformatado, o teste falha em vez de
        # virar `0 == 0`.
        self.assertIn("DARF (", prompt, "sanidade: a lista de tributos mudou de formato")
        self.assertIn("DAR / DARE (", prompt)
        self.assertIn("copie EXATAMENTE o acronimo IMPRESSO", prompt)
        self.assertIn("DAR MODELO 1", prompt)


if __name__ == "__main__":
    unittest.main()
