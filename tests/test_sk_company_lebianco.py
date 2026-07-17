"""
test_sk_company_lebianco.py — regra da EMPRESA PAGADORA (sk_company) na extracao.

Regra (decisao do usuario, 2026-07-17):
  - referencia a "lebianco" no assunto / corpo / ANEXO / remetente / dominio -> sk_company = 2
  - SEM mencao -> SEMPRE OTIMOTEX (sk_company = 1)
  - a REFERENCIA VENCE o CNPJ: conta da LEBIANCO pode ter o CNPJ da OTIMOTEX no boleto, e o
    CNPJ sozinho (sem mencao) NAO classifica.
  - sk_company (PAGADORA) e independente de sk_supplier (FORNECEDOR).

Funcoes PURAS com literais (sem rede).
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))
import read_emails as R  # noqa: E402

LEBIANCO = R.SK_COMPANY_LEBIANCO   # 2
OTIMOTEX = R.SK_COMPANY_DEFAULT    # 1
CNPJ_LEBIANCO = "47273917000395"
CNPJ_OTIMOTEX = "47273917000123"


class IsLebiancoSenderTest(unittest.TestCase):
    def test_dominio_exato(self):
        self.assertTrue(R._is_lebianco_sender("fulano@lebianco.com.br"))

    def test_subdominio(self):
        self.assertTrue(R._is_lebianco_sender("nf@mail.lebianco.com.br"))

    def test_caixa_alta(self):
        self.assertTrue(R._is_lebianco_sender("FULANO@LEBIANCO.COM.BR"))

    def test_outro_dominio(self):
        self.assertFalse(R._is_lebianco_sender("fulano@otimotex.com.br"))

    def test_none(self):
        self.assertFalse(R._is_lebianco_sender(None))


class HasLebiancoReferenceTest(unittest.TestCase):
    def test_variacoes_de_caixa(self):
        for termo in ("Lebianco", "lebianco", "LEBIANCO", "LeBiAnCo"):
            with self.subTest(termo=termo):
                self.assertTrue(R._has_lebianco_reference(f"PAGAMENTO {termo} NF 123"))

    def test_dentro_de_email_e_nome_de_arquivo(self):
        # Substring (nao \b): precisa casar dentro de dominio e de nome de arquivo.
        self.assertTrue(R._has_lebianco_reference("envio de nf@lebianco.com.br"))
        self.assertTrue(R._has_lebianco_reference("boleto_lebianco_072026.pdf"))

    def test_razao_social(self):
        self.assertTrue(R._has_lebianco_reference("LEBIANCO PLASTICOS"))

    def test_com_acento_no_texto_ao_redor(self):
        self.assertTrue(R._has_lebianco_reference("Pagamento à LEBIANCO PLÁSTICOS"))

    def test_sem_mencao(self):
        self.assertFalse(R._has_lebianco_reference("PAGAMENTO BOLETO DAMSP", "Fatura 123"))

    def test_none_e_vazio_sao_ignorados(self):
        self.assertFalse(R._has_lebianco_reference(None, "", "boleto"))

    def test_qualquer_um_dos_textos_basta(self):
        self.assertTrue(R._has_lebianco_reference(None, "sem nada", "ref lebianco aqui"))


class LeBiancoComEspacoTest(unittest.TestCase):
    """NAO REGREDIR: "LE BIANCO" (com espaco) vale SO NO ASSUNTO.

    No assunto e referencia deliberada ("LE BIANCO - PAGAMENTO FORNECEDOR"); no CORPO ela
    aparece na ASSINATURA do grupo ("Departamento Financeiro | Otimotex / Le Bianco") e
    marcaria como LEBIANCO contas que sao da OTIMOTEX (falso positivo real: conta 167).
    """

    def test_assunto_com_espaco_classifica(self):
        self.assertEqual(
            R.resolve_sk_company(subject="LE BIANCO - PAGAMENTO FORNECEDOR (NF 12)"), LEBIANCO)

    def test_assunto_com_espaco_caixa_baixa(self):
        self.assertTrue(R._subject_has_lebianco("Re: le bianco - pagamento"))

    def test_assunto_forma_junta_tambem(self):
        self.assertTrue(R._subject_has_lebianco("COBRANCA LEBIANCO"))

    def test_assunto_sem_mencao(self):
        self.assertFalse(R._subject_has_lebianco("COBRANCA OTIMOTEX TECIDO"))
        self.assertFalse(R._subject_has_lebianco(None))

    def test_assinatura_no_CORPO_nao_classifica(self):
        # Caso real (conta 167): conta da OTIMOTEX; "Le Bianco" so na assinatura do grupo.
        self.assertEqual(
            R.resolve_sk_company(
                subject="Re: COBRANCA OTIMOTEX TECIDO",
                sender_email="meira.gabriela@handred.com",
                body_text="Att\n[image: Departamento Financeiro | Otimotex / Le Bianco]"),
            OTIMOTEX)

    def test_espaco_na_descricao_nao_classifica(self):
        self.assertEqual(R.resolve_sk_company(description="Otimotex / Le Bianco"), OTIMOTEX)


class ResolveSkCompanyTest(unittest.TestCase):
    def test_remetente_lebianco(self):
        self.assertEqual(
            R.resolve_sk_company(subject="PAGAMENTO BOLETO", sender_email="ana@lebianco.com.br"),
            LEBIANCO)

    def test_assunto(self):
        self.assertEqual(R.resolve_sk_company(subject="NF LEBIANCO 998"), LEBIANCO)

    def test_corpo(self):
        self.assertEqual(
            R.resolve_sk_company(subject="Boleto", body_text="favor pagar pela Lebianco"),
            LEBIANCO)

    def test_descricao_do_anexo(self):
        self.assertEqual(R.resolve_sk_company(description="Boleto LEBIANCO PLASTICOS"), LEBIANCO)

    def test_nome_do_arquivo_anexo(self):
        self.assertEqual(R.resolve_sk_company(source_file="boleto_lebianco.pdf"), LEBIANCO)

    def test_payer_name(self):
        self.assertEqual(R.resolve_sk_company(payer_name="LEBIANCO PLASTICOS"), LEBIANCO)

    def test_texto_do_pdf(self):
        # Flag vinda de _pdf_mentions_lebianco (texto cru do anexo).
        self.assertEqual(R.resolve_sk_company(subject="Boleto", pdf_lebianco=True), LEBIANCO)

    def test_email_body_excerpt(self):
        self.assertEqual(R.resolve_sk_company(email_body_excerpt="ref lebianco"), LEBIANCO)

    def test_sem_mencao_e_otimotex(self):
        self.assertEqual(
            R.resolve_sk_company(subject="PAGAMENTO BOLETO DAMSP",
                                 body_text="segue boleto para pagamento",
                                 sender_email="financeiro@otimotex.com.br",
                                 description="Boleto DAMSP", payer_name="OTIMOTEX LTDA"),
            OTIMOTEX)

    def test_tudo_vazio_e_otimotex(self):
        self.assertEqual(R.resolve_sk_company(), OTIMOTEX)


class ReferenciaVenceCnpjTest(unittest.TestCase):
    """NAO REGREDIR: o CNPJ nao participa da regra."""

    def test_cnpj_lebianco_sem_mencao_e_otimotex(self):
        # Caso real (conta 267): payer_cnpj e da LEBIANCO, mas nada menciona lebianco.
        payload = {"subject": "PAGAMENTO BOLETO DAMSP",
                   "sender_email": "financeiro@otimotex.com.br",
                   "payer_cnpj": CNPJ_LEBIANCO,
                   "payer_name": "TEXTIL E CONFECCOES OTIMOTEX LTDA."}
        R.apply_sk_company(payload)
        self.assertEqual(payload["sk_company"], OTIMOTEX)

    def test_mencao_com_cnpj_otimotex_e_lebianco(self):
        # A conta pode ser da LEBIANCO mesmo com o CNPJ da OTIMOTEX impresso no boleto.
        payload = {"subject": "PAGAMENTO LEBIANCO",
                   "sender_email": "financeiro@otimotex.com.br",
                   "payer_cnpj": CNPJ_OTIMOTEX,
                   "payer_name": "TEXTIL E CONFECCOES OTIMOTEX LTDA."}
        R.apply_sk_company(payload)
        self.assertEqual(payload["sk_company"], LEBIANCO)


class IndependenciaDoFornecedorTest(unittest.TestCase):
    """NAO REGREDIR: sk_company (PAGADORA) != sk_supplier (FORNECEDOR).

    supplier_name/supplier_cnpj ficam FORA da varredura — se a LEBIANCO for o FORNECEDOR,
    quem paga e a OTIMOTEX. (_finalize_supplier ja remove essas chaves antes da gravacao.)
    """

    def test_supplier_name_nao_classifica(self):
        payload = {"subject": "PAGAMENTO BOLETO", "sender_email": "x@fornecedor.com.br",
                   "supplier_name": "LEBIANCO PLASTICOS"}
        R.apply_sk_company(payload)
        self.assertEqual(payload["sk_company"], OTIMOTEX)


class ApplySkCompanyTest(unittest.TestCase):
    def test_usa_o_body_text_do_parametro(self):
        payload = {"subject": "Boleto"}
        R.apply_sk_company(payload, body_text="conta da lebianco")
        self.assertEqual(payload["sk_company"], LEBIANCO)

    def test_usa_o_flag_do_anexo(self):
        payload = {"subject": "Boleto"}
        R.apply_sk_company(payload, pdf_lebianco=True)
        self.assertEqual(payload["sk_company"], LEBIANCO)

    def test_respeita_valor_ja_presente(self):
        # Idiom de created_by: o caminho que ja decidiu manda; a rede universal nao sobrescreve.
        payload = {"subject": "PAGAMENTO LEBIANCO", "sk_company": OTIMOTEX}
        R.apply_sk_company(payload)
        self.assertEqual(payload["sk_company"], OTIMOTEX)

    def test_grava_sempre_mesmo_sem_mencao(self):
        # Gravar 1 explicitamente e o que impede o trigger de resolver pelo CNPJ.
        payload = {"subject": "Boleto DAMSP"}
        R.apply_sk_company(payload)
        self.assertEqual(payload["sk_company"], OTIMOTEX)


class PdfMentionsLebiancoTest(unittest.TestCase):
    def test_arquivo_inexistente_nao_levanta(self):
        # Best-effort: qualquer falha devolve False sem quebrar a gravacao da conta.
        self.assertFalse(R._pdf_mentions_lebianco(Path("nao_existe_xyz.pdf")))


if __name__ == "__main__":
    unittest.main()
