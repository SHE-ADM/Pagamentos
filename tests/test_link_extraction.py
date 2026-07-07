"""
Testes para a extração/filtragem de links no corpo do e-mail (read_emails.py).

Cobre as regras:
  - sem anexo + com link → o link de boleto/fatura deve virar candidato
    (inclui o portal BRASPRESS /protocoloweb?protocolo=...).
  - links que a Locaweb entende como suspeitos (redirect/ofuscados, ex.: Bing
    /ck/a com destino em base64) devem ser ignorados.
  - construção da URL direta de download da fatura BRASPRESS.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

BRASPRESS_LINK = "https://www.braspress.com.br/protocoloweb?protocolo=3246040A3D67E543"
# Link suspeito real (aviso da Locaweb): redirect do Bing com destino em base64.
BING_SUSPICIOUS = (
    "https://www.bing.com/ck/a?!&&p=d06bf86ee3fcc1b3"
    "&u=a1aHR0cHM6Ly9waGlzaGluZy5leGFtcGxlL21hbHdhcmU"
)


class SuspiciousLinkTest(unittest.TestCase):
    def test_bing_ck_redirect_e_suspeito(self):
        self.assertTrue(read_emails._is_suspicious_link(BING_SUSPICIOUS))

    def test_safelinks_e_suspeito(self):
        url = "https://nam.safelinks.protection.outlook.com/?url=http%3A%2F%2Fx"
        self.assertTrue(read_emails._is_suspicious_link(url))

    def test_link_legitimo_nao_e_suspeito(self):
        self.assertFalse(read_emails._is_suspicious_link(BRASPRESS_LINK))
        self.assertFalse(read_emails._is_suspicious_link("https://www.braspress.com.br/area-do-cliente"))


class BraspressDownloadUrlTest(unittest.TestCase):
    def test_constroi_url_de_download(self):
        self.assertEqual(
            read_emails._braspress_download_url(BRASPRESS_LINK),
            "https://www.braspress.com.br/fatura/download"
            "?protocolo=3246040A3D67E543&protocoloWeb=true",
        )

    def test_url_nao_braspress_retorna_none(self):
        self.assertIsNone(read_emails._braspress_download_url("https://outro.com/protocolo=ABC"))

    def test_braspress_sem_protocolo_retorna_none(self):
        self.assertIsNone(read_emails._braspress_download_url("https://www.braspress.com.br/contato"))


class ExtractPdfLinksTest(unittest.TestCase):
    def test_link_braspress_vira_candidato(self):
        text = f"Prezado, acesse a fatura: {BRASPRESS_LINK}"
        links = read_emails.extract_pdf_links(text, "")
        self.assertIn(BRASPRESS_LINK, links)

    def test_link_suspeito_e_ignorado(self):
        text = f"Veja: {BING_SUSPICIOUS} e a fatura {BRASPRESS_LINK}"
        links = read_emails.extract_pdf_links(text, "")
        self.assertIn(BRASPRESS_LINK, links)
        self.assertNotIn(BING_SUSPICIOUS, links)

    def test_link_suspeito_em_ancora_html_e_ignorado(self):
        html = f'<a href="{BING_SUSPICIOUS}">clique aqui para a fatura boleto</a>'
        links = read_emails.extract_pdf_links("", html)
        self.assertEqual(links, [])

    def test_link_irrelevante_nao_entra(self):
        text = "Visite https://www.exemplo.com/sobre-nos para saber mais."
        self.assertEqual(read_emails.extract_pdf_links(text, ""), [])

    def test_desescapa_amp_no_link(self):
        """Links de fatura/boleto vêm com &amp; no HTML — devem ser desescapados
        para os parâmetros não quebrarem (ex.: SIEG → Vindi ?b=…&m=…&t=…)."""
        text = "Sua fatura: https://app.sieg.com/faturas?bill=506792844&amp;name=TEXTIL&amp;branchid=10"
        links = read_emails.extract_pdf_links(text, "")
        self.assertEqual(
            links, ["https://app.sieg.com/faturas?bill=506792844&name=TEXTIL&branchid=10"])

    def test_aviso_locaweb_no_corpo_descarta_todos_os_links(self):
        """Aviso 'Tem certeza que deseja acessar este link' → nenhum link seguido."""
        text = (
            "Tem certeza que deseja acessar este link? Você está prestes a acessar "
            "um link presente em uma mensagem que foi identificada como potencialmente "
            f"suspeita. Link Selecionado: {BRASPRESS_LINK}"
        )
        self.assertEqual(read_emails.extract_pdf_links(text, ""), [])


class SswLinkSelectionTest(unittest.TestCase):
    """SSW (transportadoras): o e-mail 'Sua fatura Nº... está disponível' traz o link de
    FATURA (id=F, com o BOLETO no rodapé — âncora 'AQUI'/número) e vários de DACTE (id=D/E/X,
    CT-e fiscal, sem boleto — âncora 'Download do arquivo'). O pipeline DEVE preferir a fatura
    e descartar os DACTE (caso real da conta 596597 — Arlete — que caía em 'ignorado')."""

    F = "https://ssw.inf.br/cgi-local/ssw1188?id=46303030353936353937333630354F4E52545845564F"
    D = "https://ssw.inf.br/cgi-local/ssw1188?id=44303030363238373430333630354F4E52545845564F"
    E = "https://ssw.inf.br/cgi-local/ssw1188?id=45303030363238373430333630354F4E52545845564F"
    X = "https://ssw.inf.br/cgi-local/ssw1188?id=58303030363238373430333630354F4E52545845564F"

    def test_ssw_doc_kind(self):
        self.assertEqual(read_emails._ssw_doc_kind(self.F), "fatura")  # 46 = 'F'
        for u in (self.D, self.E, self.X):                             # 44/45/58 = D/E/X
            self.assertEqual(read_emails._ssw_doc_kind(u), "dacte", u)
        self.assertIsNone(read_emails._ssw_doc_kind("https://outro.com/x?id=46AA"))
        self.assertIsNone(read_emails._ssw_doc_kind(""))

    def test_prefere_fatura_e_descarta_dacte(self):
        # DACTE aparecem ANTES no HTML e a âncora 'Download do arquivo' casaria 'download';
        # ainda assim, só a fatura (id=F) deve sair — e em primeiro.
        html = (
            f'<a href="{self.D}">Download do arquivo</a>'
            f'<a href="{self.E}">Download do arquivo</a>'
            f'<a href="{self.X}">Download do arquivo</a>'
            f'<a href="{self.F}">AQUI</a>'
            f'<a href="{self.F}">0596597</a>'
        )
        links = read_emails.extract_pdf_links("", html)
        self.assertEqual(links, [self.F])  # só a fatura, uma vez, e primeiro

    def test_dacte_no_texto_puro_nao_e_seguido(self):
        self.assertEqual(read_emails.extract_pdf_links(f"Baixe: {self.D}", ""), [])
        self.assertEqual(read_emails.extract_pdf_links(f"Fatura: {self.F}", ""), [self.F])


class SuspiciousBodyWarningTest(unittest.TestCase):
    def test_aviso_acessar_link_e_suspeito(self):
        self.assertTrue(read_emails._body_has_suspicious_warning(
            "Tem certeza que deseja acessar este link?", ""))

    def test_aviso_potencialmente_suspeita_e_suspeito(self):
        self.assertTrue(read_emails._body_has_suspicious_warning(
            "", "mensagem que foi identificada como potencialmente suspeita"))

    def test_corpo_normal_nao_dispara(self):
        self.assertFalse(read_emails._body_has_suspicious_warning(
            "Segue a fatura para pagamento.", ""))


if __name__ == "__main__":
    unittest.main()
