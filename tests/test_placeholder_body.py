"""Corpo de e-mail que e so um AVISO de "conteudo em HTML".

Defeito coberto (2026-08-03): `process_message` so caia no HTML quando o texto plano era
VAZIO (`if not body_text`). A plataforma SSW manda um text/plain de 55 caracteres
dizendo que a mensagem esta em HTML — nao-vazio, portanto o fallback nunca disparava.
Consequencias medidas na base: 29 e-mails gravaram o aviso como se fosse o corpo, a
guarda do cedente (`_ssw_cedente_from_body`) nunca teve texto para ler e o `body_full`
da Onda 2 ficou inutil para a tool `buscar_emails`.
"""

import sys
import unittest
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"))

import read_emails as R  # noqa: E402

# O texto EXATO gravado em email_control por 29 e-mails da plataforma SSW.
PLACEHOLDER_REAL = "O conteúdo deste e-mail está somente disponível em HTML"


class DetectaPlaceholderTest(unittest.TestCase):
    def test_o_aviso_real_do_ssw_e_placeholder(self):
        self.assertTrue(R._plain_body_is_placeholder(PLACEHOLDER_REAL))

    def test_variantes_do_aviso(self):
        for txt in (
            "O conteudo deste e-mail esta somente disponivel em HTML",
            "Este e-mail esta disponivel apenas em HTML",
            "This message is only available in HTML",
            "Please enable HTML to view this email",
            "Habilite HTML para visualizar esta mensagem",
        ):
            with self.subTest(txt=txt):
                self.assertTrue(R._plain_body_is_placeholder(txt))

    def test_vazio_e_none_nao_sao_placeholder(self):
        # Vazio ja era tratado pelo ramo antigo; aqui a funcao apenas nao opina.
        self.assertFalse(R._plain_body_is_placeholder(""))
        self.assertFalse(R._plain_body_is_placeholder(None))
        self.assertFalse(R._plain_body_is_placeholder("   \r\n  "))


class NaoDescartaCorpoLegitimoTest(unittest.TestCase):
    """Corpo CURTO e legitimo e a norma neste projeto — um criterio por tamanho
    descartaria justamente o texto de onde saem fornecedor, valor e vencimento."""

    def test_corpos_curtos_reais_da_base_nao_sao_placeholder(self):
        for txt in (
            "FORNECEDOR HORAS EXTRAS\r\n\r\nVALOR R$ 9.864,00\r\n\r\nVENCIMENTO 03/08/2026",
            "NOME GRIFE\r \r VALOR R$158.164,39\r \r VENCIMENTO 16/07/26",
            "FORNECEDOR SEVEN DESPACHOS ADUANEIROS\r\n\r\nVALOR R$ 18.000,00",
            "Bom dia. Segue anexo o boleto referente a JULHO do contrato de manutencao.",
            "Prezado(a), segue anexo boleto de aluguel com o vencimento para 10/07/2026.",
        ):
            with self.subTest(txt=txt[:40]):
                self.assertFalse(R._plain_body_is_placeholder(txt))

    def test_corpo_longo_que_menciona_html_nao_e_descartado(self):
        # Fatura de uma agencia web: fala de HTML, mas E o conteudo. O teto de tamanho
        # protege esse caso.
        corpo = "Prezados, segue a fatura do servico de desenvolvimento HTML e CSS " \
                "do site institucional, disponivel para conferencia. " * 3
        self.assertGreater(len(corpo), R._PLACEHOLDER_BODY_MAX_CHARS)
        self.assertFalse(R._plain_body_is_placeholder(corpo))


def _msg_multipart(plain: str, html: str) -> EmailMessage:
    """multipart/alternative como o da plataforma: text/plain de aviso + text/html real."""
    msg = EmailMessage()
    msg["Subject"] = "Sua fatura Nº79399 está disponível."
    msg["From"] = "no-reply@sswsistemas.com.br"
    msg.set_content(plain)
    msg.add_alternative(html, subtype="html")
    return msg


class FallbackParaHtmlTest(unittest.TestCase):
    """Prova o COMPORTAMENTO: com o aviso, o corpo usado passa a ser o do HTML."""

    HTML_REAL = (
        "<html><body><p>Fatura 000079399-0</p>"
        "<p>Os servicos foram realizados por PANTANAL LOGISTICA E TRANSPORTES LTDA</p>"
        "<p>CNPJ: 08.662.661/0001-94</p></body></html>"
    )

    def _corpo_efetivo(self, msg) -> str:
        """Aplica a regra sobre as MESMAS funcoes que process_message usa.

        ATENCAO: isto DUPLICA a decisao — logo, sozinho, nao prova que o pipeline a
        executa (um mutante que remova a chamada em process_message deixa estes testes
        verdes). Quem trava a fiacao e FiacaoNoProcessMessageTest, abaixo.
        """
        body_text = R.get_body_text(msg)
        if not body_text or R._plain_body_is_placeholder(body_text):
            html_text = R._html_to_text(R.get_body_html(msg))
            if html_text:
                body_text = html_text
        return body_text

    def test_aviso_e_trocado_pelo_conteudo_do_html(self):
        corpo = self._corpo_efetivo(_msg_multipart(PLACEHOLDER_REAL, self.HTML_REAL))
        self.assertIn("PANTANAL LOGISTICA E TRANSPORTES LTDA", corpo)
        self.assertNotIn("somente disponível em HTML", corpo)

    def test_corpo_legitimo_nao_e_trocado(self):
        plano = "FORNECEDOR HORAS EXTRAS\n\nVALOR R$ 9.864,00"
        corpo = self._corpo_efetivo(_msg_multipart(plano, "<p>versao html qualquer</p>"))
        self.assertIn("HORAS EXTRAS", corpo)

    def test_html_vazio_nao_apaga_o_que_havia(self):
        # Sem isto, um HTML ilegivel deixaria o e-mail sem corpo NENHUM.
        corpo = self._corpo_efetivo(_msg_multipart(PLACEHOLDER_REAL, ""))
        self.assertEqual(corpo.strip(), PLACEHOLDER_REAL)


class GuardaDoCedenteVoltaAFuncionarTest(unittest.TestCase):
    """O motivo de negocio da correcao: com o corpo real, a guarda que aponta o CEDENTE
    da fatura SSW (e nao o emitente do CT-e agregado) volta a ter texto para ler."""

    def test_cedente_e_encontrado_no_corpo_vindo_do_html(self):
        html = (
            "<p>Os servicos de transporte foram realizados por PANTANAL LOGISTICA E "
            "TRANSPORTES LTDA</p><p>CNPJ: 08.662.661/0001-94</p>"
        )
        corpo_html = R._html_to_text(html)
        nome, _cnpj = R._ssw_cedente_from_body(
            "no-reply@sswsistemas.com.br", corpo_html, "47273917000123")
        self.assertIsNotNone(nome, "a guarda do cedente nao encontrou o beneficiario no corpo")
        self.assertIn("PANTANAL", str(nome).upper())

    def test_com_o_aviso_a_guarda_nao_acha_nada(self):
        # Estado ANTERIOR a correcao — documenta por que o fornecedor saia errado.
        # O contrato da funcao e devolver a TUPLA (nome, cnpj) com None quando nao acha.
        nome, cnpj = R._ssw_cedente_from_body(
            "no-reply@sswsistemas.com.br", PLACEHOLDER_REAL, "47273917000123")
        self.assertIsNone(nome)
        self.assertIsNone(cnpj)


class FiacaoNoProcessMessageTest(unittest.TestCase):
    """Guarda cross-layer: `process_message` REALMENTE consulta o detector.

    Le o codigo com `ast` — nao com regex/substring: a mencao ao nome aparece tambem no
    comentario que explica a regra, entao uma busca textual ficaria VERDE mesmo se a
    chamada fosse removida (o pior desfecho para uma guarda). `ast` so enxerga chamadas.
    """

    def _chamadas_em(self, func_name: str) -> set:
        import ast
        import inspect

        fonte = inspect.getsource(getattr(R, func_name))
        arvore = ast.parse(textwrap_dedent(fonte))
        nomes = set()
        for no in ast.walk(arvore):
            if isinstance(no, ast.Call):
                alvo = no.func
                if isinstance(alvo, ast.Name):
                    nomes.add(alvo.id)
                elif isinstance(alvo, ast.Attribute):
                    nomes.add(alvo.attr)
        return nomes

    def test_process_message_chama_o_detector_de_placeholder(self):
        chamadas = self._chamadas_em("process_message")
        # Sanidade do parser: se o AST parasse de casar, o assert seguinte viraria
        # vacuo. get_body_text e chamada obrigatoria e estavel nessa funcao.
        self.assertIn("get_body_text", chamadas, "parser do AST nao leu process_message")
        self.assertIn(
            "_plain_body_is_placeholder",
            chamadas,
            "process_message parou de detectar o corpo-placeholder: e-mails so-HTML "
            "voltam a gravar o aviso como corpo (ver o cabecalho deste arquivo)",
        )

    def test_process_message_ainda_cai_no_html(self):
        self.assertIn("_html_to_text", self._chamadas_em("process_message"))


def textwrap_dedent(s: str) -> str:
    import textwrap

    return textwrap.dedent(s)


if __name__ == "__main__":
    unittest.main()
