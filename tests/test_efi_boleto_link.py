"""
Boleto Efi/Gerencianet por LINK + bloco "Dados do emissor" em TABELA.

Caso de origem — conta 1685 (e-mail 2422, 25/09/2026, AGENCIA K1 DIGITAL, R$ 500,00), e a
MESMA falha na conta 766 (e-mail 1190, 31/07/2026):

  1. O e-mail nao traz o PDF: traz o link de uma PAGINA (visualizacao.gerencianet.com.br/
     emissao/... ou download.sejaefi.com.br/v1/...). A pagina nao tem <a href> para o PDF —
     o botao "Download PDF" monta a URL em JS. O link era ignorado ou dava HTML, e a conta
     caia no fallback do CORPO, sem codigo de barras nem anexo.
  2. No corpo, "Dados do emissor" passou a vir como tabela achatada ("Nome / Telefone /
     AGENCIA K1..."), e o CABECALHO "Nome" virava o fornecedor (cadastro-lixo sk 1319).

Os testes EXECUTAM download_pdf_from_url e extract_from_email_body (as funcoes de topo), com
a rede simulada em _fetch_url — nao so os helpers puros.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402

# URLs REAIS dos e-mails 2422 (pagina) e 1190/1299 (/v1/), e o PDF que a pagina baixa.
VIEW_URL = ("https://visualizacao.gerencianet.com.br/emissao/"
            "429810_657_XILE5/A4XB-429810-668-LUATA9")
VIEW_PDF = "https://download.sejaefi.com.br/429810_657_XILE5/429810-668-LUATA9.pdf"
V1_URL = "https://download.sejaefi.com.br/v1/429810_610_LEBRA7/429810-621-RAARRA6"
V1_PDF = "https://download.sejaefi.com.br/429810_610_LEBRA7/429810-621-RAARRA6.pdf"

PDF_BYTES = b"%PDF-1.4\n...boleto..."
HTML_BYTES = b"<!doctype html><html><body>Visualizacao de Emissao</body></html>"

# Trecho REAL do corpo do e-mail 2422 (layout em TABELA achatada pelo webmail).
BODY_1685 = (
    " Olá, !\n"
    " A cobrança do seu plano de assinatura Manutenção a cada 2 meses\n"
    " está disponível para pagamento.\n"
    " Assinatura nº\n 1062969\n"
    " Cobrança nº\n 1067823245\n"
    " Vencimento\n 05/10/2026\n"
    " Manutenção - otimotex.com.br \n 1 \n R$ 500,00 \n R$ 500,00 \n"
    " Valor da assinatura (Bimestral)\n R$ 500,00\n"
    " Acessar Bolix \n"
    " Caso não seja possível acessar a tela de pagamento através do botão, copie e cole o"
    f" link abaixo na barra de endereços do seu navegador: {VIEW_URL}\n"
    " Dados do emissor\n"
    " Nome \n"
    " Telefone \n"
    " AGENCIA K1 DIGITAL WEBSITES E MARKETING \n"
    " (87) 98862-0378 \n"
    " Nome \n __ \n Telefone \n"
    " AGENCIA K1 DIGITAL WEBSITES E MARKETING \n __ \n (87) 98862-0378 \n"
)
SUBJECT_1685 = "Boleto referente à assinatura 1067823245 de Manutenção - ot..."
SENDER = "naoresponda@notificacao.sejaefimail.com.br"


class TestEfiPdfUrl(unittest.TestCase):
    def test_pagina_de_visualizacao_vira_o_pdf(self):
        self.assertEqual(read_emails._efi_pdf_url(VIEW_URL), VIEW_PDF)

    def test_link_v1_vira_o_pdf(self):
        self.assertEqual(read_emails._efi_pdf_url(V1_URL), V1_PDF)

    def test_query_e_barra_final_nao_atrapalham(self):
        self.assertEqual(read_emails._efi_pdf_url(VIEW_URL + "/?print=1"), VIEW_PDF)

    def test_host_fora_da_allowlist_nao_e_efi(self):
        for url in ("https://evil.example/emissao/429810_657_XILE5/A4XB-429810-668-LUATA9",
                    "https://visualizacao.gerencianet.com.br.evil.example/emissao/a_b/A4XB-c",
                    "ftp://visualizacao.gerencianet.com.br/emissao/a_b/A4XB-c"):
            self.assertIsNone(read_emails._efi_pdf_url(url), url)

    def test_pdf_direto_fica_com_o_download_normal(self):
        self.assertIsNone(read_emails._efi_pdf_url(VIEW_PDF))

    def test_id_malformado_e_recusado(self):
        for url in ("https://visualizacao.gerencianet.com.br/emissao/../../etc",
                    "https://visualizacao.gerencianet.com.br/emissao/",
                    "https://visualizacao.gerencianet.com.br/outra/coisa",
                    "https://download.sejaefi.com.br/",
                    "https://visualizacao.gerencianet.com.br:99999/emissao/a_b/c-d",
                    "https://visualizacao.gerencianet.com.br:8080/emissao/a_b/c-d"):
            self.assertIsNone(read_emails._efi_pdf_url(url), url)

    def test_vazio_e_none(self):
        self.assertIsNone(read_emails._efi_pdf_url(None))
        self.assertIsNone(read_emails._efi_pdf_url(""))


class TestExtractPdfLinksEfi(unittest.TestCase):
    def test_link_no_texto_vira_o_pdf_derivado(self):
        self.assertEqual(read_emails.extract_pdf_links(BODY_1685, ""), [VIEW_PDF])

    def test_ancora_acessar_bolix_no_html(self):
        html = f'<a href="{VIEW_URL}">Acessar Bolix</a>'
        self.assertEqual(read_emails.extract_pdf_links("", html), [VIEW_PDF])

    def test_link_v1_substitui_a_pagina_html(self):
        # Antes: o /v1/ entrava como candidato (casa 'download'), mas devolvia HTML sem PDF.
        self.assertEqual(read_emails.extract_pdf_links(f"baixe: {V1_URL}\n", ""), [V1_PDF])

    def test_site_institucional_da_plataforma_nunca_e_candidato(self):
        # Rodape real: "Clique aqui e abra a sua gratuitamente" -> sejaefi.com.br. O laco de
        # download baixa TODOS os candidatos; um PDF do site viraria conta espuria.
        html = (f'<a href="{VIEW_URL}">Acessar Bolix</a>'
                '<a href="https://sejaefi.com.br/">Clique aqui</a>'
                '<a href="https://www.gerencianet.com.br/tarifas.pdf">tarifas</a>')
        self.assertEqual(read_emails.extract_pdf_links("", html), [VIEW_PDF])

    def test_efi_tem_prioridade_sobre_outras_candidatas(self):
        text = f"https://exemplo.com.br/fatura/123.pdf\n{VIEW_URL}\n"
        self.assertEqual(read_emails.extract_pdf_links(text, "")[0], VIEW_PDF)


class TestDownloadPdfFromUrlEfi(unittest.TestCase):
    """Executa download_pdf_from_url; _fetch_url simulado e o save interceptado."""

    def _run(self, responses, url=VIEW_PDF):
        calls = []

        def fake_fetch(u, timeout=30, opener=None):
            calls.append(u)
            return responses.get(u)

        saved = []
        with patch.object(read_emails, "_fetch_url", side_effect=fake_fetch), \
             patch.object(read_emails, "_save_pdf_data",
                          side_effect=lambda data, *a: saved.append(data) or Path("x.pdf")):
            result = read_emails.download_pdf_from_url(url, SENDER, SUBJECT_1685,
                                                       "2026-09-25T04:27:45+00:00")
        return result, saved, calls

    def test_pdf_derivado_e_salvo(self):
        result, saved, _ = self._run({VIEW_PDF: (PDF_BYTES, "application/pdf", VIEW_PDF)})
        self.assertEqual(result, Path("x.pdf"))
        self.assertEqual(saved, [PDF_BYTES])

    def test_pdf_derivado_que_devolve_html_avisa_em_warning(self):
        with self.assertLogs(read_emails.log, level="WARNING") as cm:
            result, saved, _ = self._run({VIEW_PDF: (HTML_BYTES, "text/html", VIEW_PDF)})
        self.assertIsNone(result)
        self.assertEqual(saved, [])
        self.assertTrue(any("Efí/Gerencianet" in m for m in cm.output))

    def test_pdf_derivado_inacessivel_avisa_em_warning(self):
        with self.assertLogs(read_emails.log, level="WARNING") as cm:
            result, _, _ = self._run({})
        self.assertIsNone(result)
        self.assertTrue(any("Efí/Gerencianet" in m for m in cm.output))

    def test_redirect_de_rastreamento_ate_a_pagina_efi(self):
        tracker = "https://click.exemplo.com.br/r/abc123"
        result, saved, calls = self._run(
            {tracker: (HTML_BYTES, "text/html", VIEW_URL),
             VIEW_PDF: (PDF_BYTES, "application/pdf", VIEW_PDF)},
            url=tracker)
        self.assertEqual(result, Path("x.pdf"))
        self.assertEqual(saved, [PDF_BYTES])
        self.assertEqual(calls, [tracker, VIEW_PDF])


class TestFieldLabels(unittest.TestCase):
    def test_parser_casa_cada_rotulo_da_fonte_unica(self):
        # Sanidade do parser: um rotulo que o regex gerado deixasse de casar tornaria o
        # pulo do cabecalho inerte em silencio.
        import re
        line_re = re.compile(r"(?im)^[ \t]*" + read_emails._FIELD_LABEL_LINE + r"$")
        self.assertGreater(len(read_emails._FIELD_LABEL_TERMS), 5)
        for term in read_emails._FIELD_LABEL_TERMS:
            self.assertRegex(f" {term.upper()} ", line_re, term)
        self.assertRegex(" Razão Social: ", line_re)
        self.assertRegex(" Endereço ", line_re)
        self.assertNotRegex(" AGENCIA K1 DIGITAL ", line_re)

    def test_rotulo_nunca_e_fornecedor(self):
        for name in ("Nome", "NOME:", "Telefone", "Razão Social", "E-mail", "CNPJ/CPF"):
            self.assertTrue(read_emails._is_non_supplier_term(name), name)

    def test_nome_que_so_contem_o_rotulo_continua_valido(self):
        for name in ("Empresa Nome Ltda", "Nome Certo Comercio", "Telefonica Brasil SA",
                     "AGENCIA K1 DIGITAL WEBSITES E MARKETING"):
            self.assertFalse(read_emails._is_non_supplier_term(name), name)


class TestIssuerBlockEmTabela(unittest.TestCase):
    def _issuer(self, body):
        m = read_emails._BODY_ISSUER_RE.search(body)
        return m.group(1).strip() if m else None

    def test_pula_o_cabecalho_da_tabela(self):
        self.assertEqual(self._issuer(BODY_1685), "AGENCIA K1 DIGITAL WEBSITES E MARKETING")

    def test_bloco_so_com_rotulos_nao_captura_rotulo(self):
        # Anti-backtracking: sem o lookahead, o regex desfaria o pulo e devolveria "Nome".
        self.assertIsNone(self._issuer(" Dados do emissor\n Nome \n Telefone \n"))

    def test_layout_antigo_da_694_nao_regride(self):
        body = " Dados do emissor\n AGENCIA K1 DIGITAL WEBSITES E MARKETING\n (87) 98862-0378 \n"
        self.assertEqual(self._issuer(body), "AGENCIA K1 DIGITAL WEBSITES E MARKETING")

    def test_valor_que_comeca_com_rotulo_nao_e_pulado(self):
        body = " Dados do emissor\n Nome Certo Comercio Ltda\n"
        self.assertEqual(self._issuer(body), "Nome Certo Comercio Ltda")


class TestExtractFromEmailBody1685(unittest.TestCase):
    """Ponta a ponta do CORPO — a rede de seguranca quando o PDF nao vem."""

    def test_fornecedor_e_o_emissor_nao_o_rotulo(self):
        payload = read_emails.extract_from_email_body(
            BODY_1685, "2026-09-25T04:27:45+00:00", "<msg-1685>",
            sender_email=SENDER, subject=SUBJECT_1685)
        self.assertEqual(payload["supplier_name"], "AGENCIA K1 DIGITAL WEBSITES E MARKETING")
        self.assertEqual(payload["invoice_number"], "1067823245")
        self.assertEqual(payload["amount"], 500.00)
        self.assertEqual(payload["due_date"], "2026-10-05")


if __name__ == "__main__":
    unittest.main()
