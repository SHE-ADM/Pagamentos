"""
Testes da descriptografia de boletos protegidos por senha (extract_pdf.py) e da
geração de senhas candidatas (read_emails.pdf_password_candidates).

Regra de negócio: boletos de cobrança pedem os N primeiros dígitos do CNPJ do pagador
ou o CNPJ COMPLETO. O pipeline tenta [:3] → [:4] → [:5] → [:6] → completo, para CADA
empresa pagadora (as filiais compartilham a raiz, mas o CNPJ completo difere e o pagador
do e-mail só é resolvido depois da extração); em sucesso, descriptografa para um arquivo
temporário e segue a extração. Sem senha que abra → None (o caller cai no fallback do
corpo).
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pypdf

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import extract_pdf  # noqa: E402
import read_emails  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_fatura_boleto import REC, FakeControl, _row  # noqa: E402


# Linha digitavel real (caso padariabelga) — a linha extraida precisa parecer um boleto
# para o passo 2 seguir o fluxo normal; aqui so o que chega em run_extraction e observado.
_BOLETO_REAL = "23797150300020100800165090000000182600836500"


def _make_encrypted_pdf(password: str) -> Path:
    """Cria um PDF de 1 página cifrado com a senha de usuário informada."""
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.encrypt(user_password=password)
    fd, tmp = tempfile.mkstemp(suffix=".pdf")
    import os
    with os.fdopen(fd, "wb") as fh:
        writer.write(fh)
    return Path(tmp)


def _make_plain_pdf() -> Path:
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=200, height=200)
    fd, tmp = tempfile.mkstemp(suffix=".pdf")
    import os
    with os.fdopen(fd, "wb") as fh:
        writer.write(fh)
    return Path(tmp)


_ESPERADO_TECIDOS = ["472", "4727", "47273", "472739", "47273917000123"]


class TestPasswordCandidates(unittest.TestCase):
    def test_cnpj_gera_prefixos_3_a_6_e_numero_completo(self):
        # O CNPJ COMPLETO é o último candidato — foi a senha que faltava no e-mail
        # "PAGAMENTO BOLETO CABERNET 0108-1408".
        self.assertEqual(
            read_emails.pdf_password_candidates("47273917000123"),
            _ESPERADO_TECIDOS,
        )

    def test_aceita_cnpj_mascarado(self):
        self.assertEqual(
            read_emails.pdf_password_candidates("47.273.917/0001-23"),
            _ESPERADO_TECIDOS,
        )

    def test_cnpj_curto_ou_vazio_retorna_vazio(self):
        self.assertEqual(read_emails.pdf_password_candidates("123"), [])
        self.assertEqual(read_emails.pdf_password_candidates(""), [])
        self.assertEqual(read_emails.pdf_password_candidates(None), [])

    def test_tipo_invalido_nao_levanta(self):
        # Dado vindo do banco pode ser numérico/None; a função é chamada no caminho
        # quente do reader e não pode derrubar a extração do e-mail.
        self.assertEqual(read_emails.pdf_password_candidates(12345678000199), [])
        self.assertEqual(read_emails.pdf_password_candidates([None, 42]), [])

    def test_filiais_repetem_prefixo_uma_vez_e_somam_os_completos(self):
        # As três pagadoras compartilham a raiz: os prefixos aparecem UMA vez (dedup
        # preservando a ordem) e cada CNPJ completo entra na ordem de sk_company.
        self.assertEqual(
            read_emails.pdf_password_candidates(
                ["47273917000123", "47273917000223", "47273917000323"]
            ),
            _ESPERADO_TECIDOS + ["47273917000223", "47273917000323"],
        )

    def test_minimo_de_digitos_deriva_dos_prefixos(self):
        # Guarda contra prefixo novo maior sem ajuste do mínimo: um CNPJ com menos
        # dígitos que o maior prefixo geraria senha TRUNCADA, que não é regra nenhuma.
        self.assertEqual(
            read_emails.PDF_PASSWORD_MIN_DIGITS,
            max(t for t in read_emails.PDF_PASSWORD_CNPJ_LENGTHS if t is not None),
        )
        curto = "4" * (read_emails.PDF_PASSWORD_MIN_DIGITS - 1)
        self.assertEqual(read_emails.pdf_password_candidates(curto), [])


class TestPayerCnpjSource(unittest.TestCase):
    """O reader alimenta as senhas com o CNPJ de TODAS as pagadoras (`company_cnpjs`),
    degradando para a principal quando o controle não expõe a lista."""

    def test_usa_a_lista_completa_quando_disponivel(self):
        ctrl = mock.Mock(spec=["company_cnpjs", "company_cnpj"])
        ctrl.company_cnpjs.return_value = ["47273917000123", "47273917000223"]
        self.assertEqual(
            read_emails._payer_cnpjs(ctrl), ["47273917000123", "47273917000223"]
        )

    def test_degrada_para_a_pagadora_principal(self):
        ctrl = mock.Mock(spec=["company_cnpj"])
        ctrl.company_cnpj.return_value = "47273917000123"
        self.assertEqual(read_emails._payer_cnpjs(ctrl), ["47273917000123"])

    def test_controle_sem_cnpj_nenhum_nao_levanta(self):
        self.assertEqual(read_emails._payer_cnpjs(mock.Mock(spec=[])), [])
        ctrl = mock.Mock(spec=["company_cnpj"])
        ctrl.company_cnpj.return_value = None
        self.assertEqual(read_emails._payer_cnpjs(ctrl), [])


class TestDecryptPdf(unittest.TestCase):
    def test_detecta_cifrado_e_descriptografa_com_candidato(self):
        enc = _make_encrypted_pdf("472739")  # senha = 6 primeiros dígitos do CNPJ
        try:
            self.assertTrue(extract_pdf._pdf_is_encrypted(enc))
            dec = extract_pdf._decrypt_pdf(enc, ["4727", "47273", "472739"])
            self.assertIsNotNone(dec)
            # O arquivo gerado abre SEM senha.
            self.assertFalse(pypdf.PdfReader(str(dec)).is_encrypted)
            dec.unlink()
        finally:
            enc.unlink()

    def test_descriptografa_com_o_cnpj_completo(self):
        """Caso CABERNET: a senha é o CNPJ inteiro, não um prefixo. Percorre a lista REAL
        de candidatas para provar que ela contém a senha que abre o arquivo."""
        enc = _make_encrypted_pdf("47273917000123")
        try:
            dec = extract_pdf._decrypt_pdf(
                enc, read_emails.pdf_password_candidates("47.273.917/0001-23")
            )
            self.assertIsNotNone(dec)
            self.assertFalse(pypdf.PdfReader(str(dec)).is_encrypted)
            dec.unlink()
        finally:
            enc.unlink()

    def test_descriptografa_com_os_3_primeiros_digitos(self):
        enc = _make_encrypted_pdf("472")
        try:
            dec = extract_pdf._decrypt_pdf(
                enc, read_emails.pdf_password_candidates("47273917000123")
            )
            self.assertIsNotNone(dec)
            dec.unlink()
        finally:
            enc.unlink()

    def test_descriptografa_com_o_cnpj_de_outra_filial(self):
        """Boleto emitido para a filial: a senha é o CNPJ COMPLETO dela, que não sai do
        CNPJ da pagadora principal — daí a lista de candidatas cobrir todas as empresas."""
        enc = _make_encrypted_pdf("47273917000223")
        try:
            candidatas = read_emails.pdf_password_candidates(["47273917000123"])
            self.assertIsNone(extract_pdf._decrypt_pdf(enc, candidatas))
            todas = read_emails.pdf_password_candidates(
                ["47273917000123", "47273917000223"]
            )
            dec = extract_pdf._decrypt_pdf(enc, todas)
            self.assertIsNotNone(dec)
            dec.unlink()
        finally:
            enc.unlink()

    def test_senhas_erradas_retornam_none(self):
        enc = _make_encrypted_pdf("999999")
        try:
            dec = extract_pdf._decrypt_pdf(enc, ["4727", "47273", "472739"])
            self.assertIsNone(dec)
        finally:
            enc.unlink()

    def test_pdf_simples_nao_e_cifrado(self):
        plain = _make_plain_pdf()
        try:
            self.assertFalse(extract_pdf._pdf_is_encrypted(plain))
        finally:
            plain.unlink()


class TestEncryptedOwnerOnlyFallback(unittest.TestCase):
    """Boleto cifrado só com senha de DONO (senha de usuario vazia): o pypdf marca
    cifrado e decrypt('') devolve 0, mas o pdfminer/pdfplumber le. process_pdf deve
    seguir com o ORIGINAL em vez de descartar como 'protegido por senha' (SB Credito)."""

    def test_cifrado_mas_legivel_segue_com_original(self):
        plain = _make_plain_pdf()
        try:
            with mock.patch.object(extract_pdf, "_is_image_file", return_value=False), \
                 mock.patch.object(extract_pdf, "_pdf_is_encrypted", return_value=True), \
                 mock.patch.object(extract_pdf, "_decrypt_pdf", return_value=None), \
                 mock.patch.object(extract_pdf, "_pdf_text_readable", return_value=True), \
                 mock.patch.object(extract_pdf, "_payable_pages", return_value=[]), \
                 mock.patch.object(extract_pdf, "_extract_records",
                                   return_value=[{"amount": 8615.64,
                                                  "document_type": "boleto"}]) as m_extract:
                recs = extract_pdf.process_pdf(plain)
            self.assertEqual(len(recs), 1)
            self.assertEqual(recs[0]["document_type"], "boleto")  # nao e failure_record
            # Extraiu do ORIGINAL (fallback pdfplumber), nao de um decifrado.
            self.assertEqual(m_extract.call_args.args[0], plain)
        finally:
            plain.unlink()

    def test_cifrado_e_ilegivel_retorna_falha(self):
        plain = _make_plain_pdf()
        try:
            with mock.patch.object(extract_pdf, "_is_image_file", return_value=False), \
                 mock.patch.object(extract_pdf, "_pdf_is_encrypted", return_value=True), \
                 mock.patch.object(extract_pdf, "_decrypt_pdf", return_value=None), \
                 mock.patch.object(extract_pdf, "_pdf_text_readable", return_value=False):
                recs = extract_pdf.process_pdf(plain)
            self.assertEqual(len(recs), 1)
            self.assertEqual(recs[0]["document_type"], "ERRO")
            self.assertIn("senha", (recs[0].get("processing_notes") or "").lower())
        finally:
            plain.unlink()


class TestPasswordsChegamNaExtracao(unittest.TestCase):
    """CALL SITE EXECUTADO: não basta a função pura devolver as senhas — o que importa é
    o que `extract_and_store_accounts` entrega a `run_extraction` para cada anexo."""

    class _CtrlComFiliais(FakeControl):
        CNPJS = ["47273917000123", "47273917000223", "47273917000323"]

        def company_cnpjs(self):
            return list(self.CNPJS)

    def _senhas_vistas(self, ctrl) -> list[list[str]]:
        vistas: list[list[str]] = []

        def fake_run_extraction(pdf_path, pdf_passwords=None):
            vistas.append(list(pdf_passwords or []))
            return (pdf_path.name, None)

        with tempfile.TemporaryDirectory() as td:
            pdf = Path(td) / "boleto.pdf"
            pdf.write_bytes(_make_plain_pdf().read_bytes())
            with mock.patch.object(read_emails, "run_extraction", fake_run_extraction),                  mock.patch.object(read_emails, "read_extracted_rows",
                                   return_value=[_row("boleto.pdf", _BOLETO_REAL)]),                  mock.patch.object(read_emails, "_attachment_text", return_value=""),                  mock.patch.object(read_emails, "_register_fiscal_documents", return_value=None):
                read_emails.extract_and_store_accounts(
                    [pdf], "<MID-SENHA>", ctrl, email_rec=dict(REC))
        return vistas

    def test_senhas_das_tres_pagadoras_chegam_ao_extrator(self):
        vistas = self._senhas_vistas(self._CtrlComFiliais())
        self.assertEqual(len(vistas), 1, "run_extraction deveria rodar uma vez por anexo")
        senhas = vistas[0]
        self.assertEqual(senhas[0], "472")                    # prefixo novo mais curto
        for cnpj in self._CtrlComFiliais.CNPJS:               # CNPJ completo de cada filial
            self.assertIn(cnpj, senhas)

    def test_controle_sem_cnpj_nao_manda_senha_nenhuma(self):
        # FakeControl.company_cnpj() devolve None: nada a tentar, e o anexo segue a extração
        # normalmente (a ausência de senha não pode virar erro).
        self.assertEqual(self._senhas_vistas(FakeControl()), [[]])


class TestCompanyCnpjMap(unittest.TestCase):
    """A leitura do CNPJ das pagadoras — a fonte das senhas. Exercita a query real do
    `SupabaseControl` com o urlopen mockado (nenhuma rede)."""

    PAYLOAD = [
        {"sk_company": 1, "cnpj": "47.273.917/0001-23"},
        {"sk_company": 2, "cnpj": "47273917000223"},
        {"sk_company": 3, "cnpj": "47273917000323"},
    ]

    def _ctrl(self, payload, falha=None):
        ctrl = read_emails.SupabaseControl.__new__(read_emails.SupabaseControl)
        ctrl.base, ctrl.key, ctrl.headers, ctrl._available = "https://x", "k", {}, True
        resposta = mock.MagicMock()
        resposta.read.return_value = json.dumps(payload).encode()
        cm = mock.MagicMock()
        cm.__enter__.return_value = resposta
        alvo = mock.patch.object(read_emails.urllib.request, "urlopen",
                                 side_effect=falha) if falha else                mock.patch.object(read_emails.urllib.request, "urlopen", return_value=cm)
        return ctrl, alvo

    def test_todas_as_pagadoras_viram_senha_e_a_principal_e_a_sk_1(self):
        ctrl, alvo = self._ctrl(self.PAYLOAD)
        with alvo as m:
            self.assertEqual(
                ctrl.company_cnpjs(),
                ["47273917000123", "47273917000223", "47273917000323"],
            )
            self.assertEqual(ctrl.company_cnpj(), "47273917000123")
            # Cache por instância: a 2ª leitura não bate no Supabase de novo.
            self.assertEqual(m.call_count, 1)
            # A CONSULTA precisa pedir TODAS as pagadoras: com o mock devolvendo sempre o
            # mesmo payload, só a URL prova que a query não voltou a filtrar a sk_company=1
            # (era o defeito original — o CNPJ completo da filial nunca viraria senha).
            url = m.call_args.args[0].full_url
            self.assertNotIn("sk_company=eq.", url)
            self.assertIn("order=sk_company", url)  # ordem determinística das candidatas
        # As senhas cobrem o CNPJ completo de CADA filial (o que faltava no caso CABERNET).
        senhas = read_emails.pdf_password_candidates(ctrl.company_cnpjs())
        for cnpj in ("47273917000123", "47273917000223", "47273917000323"):
            self.assertIn(cnpj, senhas)

    def test_sk_company_como_texto_nao_perde_a_pagadora_principal(self):
        ctrl, alvo = self._ctrl([{"sk_company": "1", "cnpj": "47273917000123"}])
        with alvo:
            self.assertEqual(ctrl.company_cnpj(), "47273917000123")

    def test_linha_sem_cnpj_ou_sem_sk_e_ignorada_sem_levantar(self):
        ctrl, alvo = self._ctrl([{"sk_company": 1, "cnpj": None},
                                 {"cnpj": "47273917000223"},
                                 {"sk_company": 3, "cnpj": "47273917000323"}])
        with alvo:
            self.assertEqual(ctrl.company_cnpjs(), ["47273917000323"])
            self.assertIsNone(ctrl.company_cnpj())

    def test_supabase_indisponivel_nao_levanta_e_nao_repete_a_consulta(self):
        ctrl, alvo = self._ctrl([], falha=OSError("rede fora"))
        with alvo as m:
            self.assertEqual(ctrl.company_cnpjs(), [])
            self.assertIsNone(ctrl.company_cnpj())
            self.assertEqual(m.call_count, 1)


if __name__ == "__main__":
    unittest.main()
