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

    def test_aviso_locaweb_no_corpo_descarta_todos_os_links(self):
        """Aviso 'Tem certeza que deseja acessar este link' → nenhum link seguido."""
        text = (
            "Tem certeza que deseja acessar este link? Você está prestes a acessar "
            "um link presente em uma mensagem que foi identificada como potencialmente "
            f"suspeita. Link Selecionado: {BRASPRESS_LINK}"
        )
        self.assertEqual(read_emails.extract_pdf_links(text, ""), [])


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
