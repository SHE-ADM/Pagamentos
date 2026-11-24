"""
test_poison_attachment.py — um ANEXO ruim não pode impedir a conta dos OUTROS anexos.

CASO REAL (18 a 21/11/2026). Duas imagens chegaram com a extensão errada:
  - RTE, 18/11 18:40 — `image.png` inline cujo conteúdo era GIF;
  - Sevenlog, 19/11 15:25 — `a66c1adb.png` (assinatura de e-mail, MIME image/png) cujo
    conteúdo era WebP, anexada ANTES da fatura e do boleto.
O pipeline declarava o media_type pela extensão; a Anthropic conferiu os bytes e respondeu
`400 invalid_request_error`. Esse 400 era lido como "API fora do ar": o e-mail inteiro era
abandonado sem registro (os dois PDFs nem eram lidos), o circuit breaker adiava todos os
e-mails financeiros seguintes e, como o e-mail voltava a cada 5 min, a fila ficou parada por
dois dias. 14 e-mails saíram da janela sem nunca serem registrados.

Garantias travadas aqui (camadas do `extract_pdf` e o call site do `read_emails`):
  1. o media_type enviado ao Vision sai do CONTEÚDO, não da extensão;
  2. conteúdo que não é imagem vira falha local, sem chamada à API;
  3. recusa de UM documento (400 que aponta o bloco enviado, 413) é falha DAQUELE documento —
     e todo o resto (crédito, 400 desconhecido, 401/403/404/429/5xx, rede, chave ausente)
     continua sendo indisponibilidade;
  4. o nome do arquivo nunca decide a classificação;
  5. recusa no caminho de texto não cai no fallback regex;
  6. com a imagem recusada, a conta do boleto do MESMO e-mail é gravada, e o motivo real da
     recusa chega a /erros.
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import anthropic
import httpx

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import extract_pdf as E  # noqa: E402
import read_emails  # noqa: E402
from test_fatura_boleto import BOLETO_REAL, REC, FakeControl  # noqa: E402

# Conteúdo mínimo de cada formato: só a assinatura importa para a classificação.
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG_BYTES = b"\xff\xd8\xff\xe0" + b"\x00" * 32
GIF_BYTES = b"GIF89a" + b"\x00" * 32
WEBP_BYTES = b"RIFF" + b"\x24\x00\x00\x00" + b"WEBP" + b"VP8 " + b"\x00" * 24
HTML_BYTES = b"<html><body>nao sou imagem</body></html>"

# Mensagens REAIS da API. A primeira é a do incidente, copiada de email_processing_errors.
MSG_TIPO_DE_IMAGEM = ("messages.0.content.0.image.source.base64: The image was specified using "
                      "the image/png media type, but the image appears to be a image/webp image")
MSG_CREDITO = ("Your credit balance is too low to access the Anthropic API. Please go to "
               "Plans & Billing to upgrade or purchase credits.")
MSG_400_DESCONHECIDO = "max_tokens: 99999999 > 64000, which is the maximum allowed number of output tokens"

_REQUEST = httpx.Request("POST", "https://api.anthropic.com/v1/messages")


def _status_error(status: int, message: str, cls=anthropic.APIStatusError,
                  error_type: str = "invalid_request_error"):
    """Exceção REAL do SDK, com `status_code` e a mensagem no formato que a API devolve."""
    body = {"type": "error", "error": {"type": error_type, "message": message},
            "request_id": "req_teste"}
    return cls(f"Error code: {status} - {body}",
               response=httpx.Response(status, request=_REQUEST, json=body), body=body)


class _TmpMixin(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)

    def _file(self, name: str, data: bytes) -> Path:
        path = self.tmp / name
        path.write_bytes(data)
        return path


class SniffImageMediaTypeTest(unittest.TestCase):
    FORMATOS = {"image/png": PNG_BYTES, "image/jpeg": JPEG_BYTES,
                "image/gif": GIF_BYTES, "image/webp": WEBP_BYTES}

    def test_reconhece_os_quatro_formatos(self):
        for esperado, dados in self.FORMATOS.items():
            with self.subTest(formato=esperado):
                self.assertEqual(E._sniff_image_media_type(dados), esperado)
        self.assertEqual(E._sniff_image_media_type(b"GIF87a" + b"\x00" * 8), "image/gif")

    def test_cobre_exatamente_os_tipos_que_o_pipeline_declara(self):
        # Guarda cross-layer: um formato novo em `_IMAGE_MEDIA_TYPES` sem assinatura aqui seria
        # roteado como imagem e RECUSADO localmente em 100% dos casos, sem teste vermelho.
        self.assertEqual(set(self.FORMATOS), set(E._IMAGE_MEDIA_TYPES.values()))

    def test_o_que_nao_e_imagem_devolve_none(self):
        for nome, dados in (("vazio", b""), ("pdf", b"%PDF-1.4"), ("html", HTML_BYTES),
                            ("zip", b"PK\x03\x04"), ("png truncado", b"\x89PNG"),
                            ("riff que nao e webp", b"RIFF\x24\x00\x00\x00WAVEfmt ")):
            with self.subTest(conteudo=nome):
                self.assertIsNone(E._sniff_image_media_type(dados))


class VisionUsaOConteudoTest(_TmpMixin):
    """Executa as duas funções que chamam a API e observa o bloco EFETIVAMENTE enviado."""

    def _media_type_enviado(self, chamada, nome: str, dados: bytes) -> str:
        arquivo = self._file(nome, dados)
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch("anthropic.Anthropic") as cliente:
            resposta = mock.MagicMock(stop_reason="end_turn")
            resposta.content = [mock.MagicMock(type="text", text="null")]
            cliente.return_value.messages.create.return_value = resposta
            chamada(arquivo)
        bloco = cliente.return_value.messages.create.call_args.kwargs["messages"][0]["content"][0]
        self.assertEqual(bloco["type"], "image")
        return bloco["source"]["media_type"]

    def test_webp_com_extensao_png_vai_como_webp(self):   # Sevenlog, 19/11/2026
        self.assertEqual(
            self._media_type_enviado(E.extract_with_vision, "a66c1adb.png", WEBP_BYTES),
            "image/webp")

    def test_gif_com_extensao_png_vai_como_gif(self):     # RTE, 18/11/2026
        self.assertEqual(
            self._media_type_enviado(E.extract_with_vision, "image.png", GIF_BYTES),
            "image/gif")

    def test_extensao_correta_nao_muda(self):
        self.assertEqual(
            self._media_type_enviado(E.extract_with_vision, "recibo.png", PNG_BYTES),
            "image/png")
        self.assertEqual(
            self._media_type_enviado(E.extract_with_vision, "foto.jpg", JPEG_BYTES),
            "image/jpeg")

    def test_releitura_do_codigo_de_barras_tambem_usa_o_conteudo(self):
        self.assertEqual(
            self._media_type_enviado(E._try_barcode_vision, "guia.png", WEBP_BYTES),
            "image/webp")


class ConteudoNaoImagemTest(_TmpMixin):
    def test_vira_falha_local_sem_chamar_a_api(self):
        arquivo = self._file("assinatura.png", HTML_BYTES)
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch("anthropic.Anthropic") as cliente:
            recs = E._extract_image(arquivo)
        # `assert_not_called`, e não `side_effect=AssertionError`: o `except Exception` de
        # `_extract_image` engoliria o AssertionError e o teste passaria com a API chamada.
        cliente.assert_not_called()
        self.assertEqual([r["extraction_source"] for r in recs], ["falha"])
        self.assertIn("nao e PNG, JPEG, GIF nem WebP", recs[0]["processing_notes"])


class ClassificacaoDaRecusaTest(_TmpMixin):
    """Executa `_extract_image` com a API levantando a exceção REAL do SDK."""

    def _registro(self, erro) -> dict:
        arquivo = self._file("documento.png", PNG_BYTES)
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch("anthropic.Anthropic") as cliente:
            cliente.return_value.messages.create.side_effect = erro
            recs = E._extract_image(arquivo)
        cliente.return_value.messages.create.assert_called_once()   # a API FOI chamada
        self.assertEqual(len(recs), 1)
        return recs[0]

    def test_sanidade_das_excecoes_do_teste(self):
        # Anti-vacuidade: se o SDK mudar a hierarquia ou o construtor, os casos abaixo
        # deixariam de exercitar a classificação por status sem ficar vermelhos.
        erro = _status_error(400, MSG_TIPO_DE_IMAGEM, anthropic.BadRequestError)
        self.assertIsInstance(erro, anthropic.APIStatusError)
        self.assertEqual(erro.status_code, 400)
        self.assertIn("messages.0.content.0.image", str(erro))
        self.assertNotIsInstance(anthropic.APITimeoutError(request=_REQUEST),
                                 anthropic.APIStatusError)

    def test_400_de_tipo_de_imagem_e_falha_do_documento(self):
        rec = self._registro(_status_error(400, MSG_TIPO_DE_IMAGEM, anthropic.BadRequestError))
        self.assertEqual(rec["extraction_source"], "falha")
        self.assertIn("appears to be a image/webp image", rec["processing_notes"])

    def test_413_e_falha_do_documento(self):
        rec = self._registro(_status_error(413, "Request exceeds the maximum allowed number of bytes",
                                           error_type="request_too_large"))
        self.assertEqual(rec["extraction_source"], "falha")

    def test_400_de_credito_segue_indisponibilidade(self):
        # Crédito esgotado chega com o MESMO status 400 da recusa de documento.
        rec = self._registro(_status_error(400, MSG_CREDITO, anthropic.BadRequestError))
        self.assertEqual(rec["extraction_source"], "erro_api")

    def test_400_que_aponta_o_bloco_mas_cita_credito_segue_indisponibilidade(self):
        rec = self._registro(_status_error(
            400, f"messages.0.content.0.image: {MSG_CREDITO}", anthropic.BadRequestError))
        self.assertEqual(rec["extraction_source"], "erro_api")

    def test_400_desconhecido_segue_indisponibilidade(self):
        # Lista fechada: um 400 que não aponta o bloco enviado pode ser do PEDIDO inteiro
        # (parâmetro recusado) e atingir todo documento — não é culpa deste arquivo.
        rec = self._registro(_status_error(400, MSG_400_DESCONHECIDO, anthropic.BadRequestError))
        self.assertEqual(rec["extraction_source"], "erro_api")

    def test_demais_status_e_falhas_de_rede_seguem_indisponibilidade(self):
        casos = {
            "401": _status_error(401, "invalid x-api-key", anthropic.AuthenticationError,
                                 "authentication_error"),
            "403": _status_error(403, "forbidden", anthropic.PermissionDeniedError,
                                 "permission_error"),
            "404": _status_error(404, "model: claude-inexistente", anthropic.NotFoundError,
                                 "not_found_error"),
            "429": _status_error(429, "rate limit", anthropic.RateLimitError, "rate_limit_error"),
            "500": _status_error(500, "Internal server error", anthropic.InternalServerError,
                                 "api_error"),
            "529": _status_error(529, "Overloaded", error_type="overloaded_error"),
            "timeout": anthropic.APITimeoutError(request=_REQUEST),
            "conexao": anthropic.APIConnectionError(request=_REQUEST),
        }
        for nome, erro in casos.items():
            with self.subTest(caso=nome):
                self.assertEqual(self._registro(erro)["extraction_source"], "erro_api")

    def test_chave_ausente_e_indisponibilidade_e_nao_chama_a_api(self):
        arquivo = self._file("documento.png", PNG_BYTES)
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": ""}), \
                mock.patch("anthropic.Anthropic") as cliente:
            recs = E._extract_image(arquivo)
        cliente.assert_not_called()
        self.assertEqual(recs[0]["extraction_source"], "erro_api")


class NomeDoArquivoNaoDecideTest(_TmpMixin):
    """O arquivo salvo carrega remetente e assunto no nome, e o nome viaja na mensagem de
    qualquer erro local. Antes, 'billing'/'quota'/'permission' na mensagem ligavam o breaker."""

    NOME_HOSTIL = "billing_quota_permission_rate limit_credit balance.png"

    def test_conteudo_invalido_com_nome_hostil_e_falha_do_documento(self):
        arquivo = self._file(self.NOME_HOSTIL, HTML_BYTES)
        # A chave é FIXADA: sem ela a recusa é "chave ausente" (`erro_api`), o teste nunca
        # chega ao conteúdo e o verde passa a depender do `.env` de quem roda (o CI não tem).
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch("anthropic.Anthropic") as cliente:
            recs = E._extract_image(arquivo)
        cliente.assert_not_called()                                # recusado antes da API
        self.assertIn("billing", recs[0]["processing_notes"])     # o nome ESTÁ na mensagem
        self.assertEqual(recs[0]["extraction_source"], "falha")

    def test_erro_local_de_arquivo_bloqueado_e_falha_do_documento(self):
        arquivo = self._file(self.NOME_HOSTIL, PNG_BYTES)
        erro = PermissionError(13, "Permission denied", str(arquivo))
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch.object(Path, "read_bytes", side_effect=erro):
            recs = E._extract_image(arquivo)
        self.assertIn("Permission denied", recs[0]["processing_notes"])
        self.assertEqual(recs[0]["extraction_source"], "falha")


class RecusaNoCaminhoDeTextoTest(unittest.TestCase):
    """`_extract_records` (topo do caminho de PDF de texto) com o Claude recusando o documento."""

    TEXTO = "Boleto de cobranca referente a prestacao de servicos de transporte. " * 4

    def _run(self, erro_do_claude):
        recusa_vision = _status_error(413, "Request exceeds the maximum allowed number of bytes",
                                      error_type="request_too_large")
        with mock.patch.object(E, "is_scanned_pdf", return_value=False), \
                mock.patch.object(E, "extract_with_pdfplumber",
                                  return_value=(self.TEXTO, "pdf_text")), \
                mock.patch.object(E, "extract_fields_with_claude", side_effect=erro_do_claude), \
                mock.patch.object(E, "extract_with_vision", side_effect=recusa_vision), \
                mock.patch.object(E, "_try_barcode_vision", return_value=None), \
                mock.patch.object(E, "build_record_regex", wraps=E.build_record_regex) as regex:
            recs = E._extract_records(Path("boleto.pdf"))
        return recs, regex

    def test_recusa_do_documento_vira_falha_e_nao_passa_pelo_regex(self):
        recs, regex = self._run(_status_error(
            400, MSG_TIPO_DE_IMAGEM.replace("image", "document"), anthropic.BadRequestError))
        regex.assert_not_called()
        self.assertEqual([r["extraction_source"] for r in recs], ["falha"])
        self.assertIn("Documento recusado pela API", recs[0]["processing_notes"])

    def test_resposta_ilegivel_do_modelo_continua_caindo_no_regex(self):
        # Contraprova: a guarda é ESPECÍFICA da recusa. Sem este caso, o teste acima passaria
        # também se o fallback regex tivesse sido removido para toda e qualquer falha.
        recs, regex = self._run(ValueError("resposta do modelo sem JSON"))
        regex.assert_called_once()
        self.assertNotEqual(recs[0]["extraction_source"], "erro_api")


class _Controle(FakeControl):
    """FakeControl + `has_error`, para o defeito antigo aparecer como o que ele era
    (`ApiUnavailableError`), e não como um AttributeError do dublê."""

    def has_error(self, message_id, error_type):
        return False


def _registro_csv(nome: str, **campos) -> dict:
    """Registro como o extract_pdf o devolve — vai ao CSV real e volta por `read_extracted_rows`."""
    rec = dict.fromkeys(E.CSV_COLUMNS)
    rec.update({"source_file": nome, "extraction_source": "pdf_text", "status": "pendente",
                "supplier_name": "SEVENLOG TRANSPORTES", "amount": 28877.41,
                "due_date": "2026-11-24", "issue_date": "2026-11-19"})
    rec.update(campos)
    return rec


class EmailComImagemRecusadaTest(_TmpMixin):
    """PONTA A PONTA do incidente: `extract_and_store_accounts` → `run_extraction` REAL →
    `extract_to_csv` REAL → `_extract_image` REAL, com a API recusando a imagem. Só o
    conteúdo dos dois PDFs é enlatado (não há PDF de boleto real na suíte)."""

    def _run(self):
        anexos = [self._file("adm_FATURA_a66c1adb.png", PNG_BYTES),       # 1º na ordem MIME
                  self._file("adm_FATURA_OTIMOTEX_14080.pdf", b"%PDF-1.4"),
                  self._file("adm_BOLETO_VENCIMENTO_241126.pdf", b"%PDF-1.4")]
        enlatados = {
            anexos[1].name: _registro_csv(anexos[1].name, document_type="fatura"),
            anexos[2].name: _registro_csv(anexos[2].name, document_type="boleto",
                                          barcode=BOLETO_REAL),
        }
        process_pdf_real = E.process_pdf

        def _process_pdf(caminho, **kwargs):
            if E._is_image_file(caminho):
                return process_pdf_real(caminho, **kwargs)     # caminho REAL da imagem
            return [enlatados[Path(caminho).name]]

        ctrl = _Controle()
        saida = self.tmp / "csv_output"
        saida.mkdir()
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-test"}), \
                mock.patch("anthropic.Anthropic") as cliente, \
                mock.patch.object(E, "process_pdf", _process_pdf), \
                mock.patch.object(read_emails, "CSV_OUTPUT", saida):
            cliente.return_value.messages.create.side_effect = _status_error(
                400, MSG_TIPO_DE_IMAGEM, anthropic.BadRequestError)
            resultado = read_emails.extract_and_store_accounts(
                anexos, "<015e@sevenlog.com.br>", ctrl,
                email_rec={**REC, "message_id": "<015e@sevenlog.com.br>",
                           "subject": "FATURA OTIMOTEX (14080) - Vencimento 24/11/26",
                           "sender_email": "adm@sevenlog.com.br"})
        cliente.return_value.messages.create.assert_called_once()   # a imagem FOI à API
        return ctrl, resultado

    def test_o_boleto_do_mesmo_email_vira_conta(self):
        ctrl, (csvs_ok, accounts_saved, _nonpayable, attachment_account) = self._run()
        self.assertEqual(accounts_saved, 1)
        self.assertTrue(attachment_account)
        self.assertEqual(len(csvs_ok), 2)                          # os dois PDFs foram lidos
        self.assertEqual([c["barcode"] for c in ctrl.financial_calls], [BOLETO_REAL])

    def test_o_motivo_real_da_recusa_chega_a_erros(self):
        ctrl, _ = self._run()
        erros = [(tipo, msg) for tipo, msg in ctrl.error_calls if tipo == "extracao_falhou"]
        self.assertEqual(len(erros), 1)
        mensagem = erros[0][1]
        self.assertIn("adm_FATURA_a66c1adb.png", mensagem)
        self.assertIn("appears to be a image/webp image", mensagem)   # o texto da API
        self.assertNotIn("erro_api", [tipo for tipo, _ in ctrl.error_calls])


class ExtracaoParcialTest(_TmpMixin):
    """CSV gerado, mas parte do documento falhou (ex.: uma página do carnê): as contas lidas
    seguem e a parte perdida deixa de ser silenciosa."""

    def test_falha_parcial_gera_linha_em_erros_e_mantem_a_conta(self):
        pdf = self._file("carne.pdf", b"%PDF-1.4")
        boleto = _registro_csv(pdf.name, document_type="boleto", barcode=BOLETO_REAL)
        falha = E._failure_record(pdf, "Resposta do modelo truncada: página 2")
        ctrl = _Controle()
        saida = self.tmp / "csv_output"
        saida.mkdir()
        with mock.patch.object(E, "process_pdf", lambda caminho, **kwargs: [boleto, falha]), \
                mock.patch.object(read_emails, "CSV_OUTPUT", saida):
            _csvs, accounts_saved, _np, _att = read_emails.extract_and_store_accounts(
                [pdf], "<carne@x.com.br>", ctrl, email_rec={**REC, "message_id": "<carne@x.com.br>"})
        self.assertEqual(accounts_saved, 1)
        parciais = [msg for tipo, msg in ctrl.error_calls if tipo == "extracao_falhou"]
        self.assertEqual(len(parciais), 1)
        self.assertIn("Extração parcial de carne.pdf", parciais[0])
        self.assertIn("truncada: página 2", parciais[0])


if __name__ == "__main__":
    unittest.main()
