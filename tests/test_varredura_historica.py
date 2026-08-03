"""Testes da varredura historica (Onda 4) — `scripts/varredura_historica.py`.

O script e ESTRITAMENTE ADITIVO por contrato: nunca cria conta a pagar, nunca marca \\Seen,
nunca sobrescreve corpo/objeto/documento fiscal. Testes que apenas confirmassem o caminho feliz
nao provariam nada disso — cada caso aqui foi validado por MUTANTE (introduzir o defeito de
proposito e conferir que o teste fica VERMELHO), conforme a regra do projeto "teste que promete
uma garantia tem de entregá-la".

Guardas TEXTUAIS (o identificador da tabela financeira ausente do codigo, PEEK em todo fetch,
etc.) ficam em `test_fiscal_document_consistency.py`, junto das demais guardas cross-layer.
"""

import email
import importlib.util
import json
import sys
import tempfile
import unittest
import urllib.error
from email.message import EmailMessage
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(_ROOT / "scripts"))

import read_emails as R  # noqa: E402
import supabase_rest as SR  # noqa: E402


def _carrega(nome: str, caminho: Path):
    """Nome UNICO em sys.modules: varios `run.py`/scripts coexistem no repo e importar pelo
    nome simples colide, poluindo a suite inteira (ja aconteceu com as skills)."""
    spec = importlib.util.spec_from_file_location(nome, caminho)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[nome] = mod
    spec.loader.exec_module(mod)
    return mod


V = _carrega("varredura_historica_mod", _ROOT / "scripts" / "varredura_historica.py")

_PDF = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n"


def _mensagem(assunto="BOLETO TRANSPORTE", remetente="fin@transportes.com.br",
              message_id="<abc@x>", anexos=(), inline=()) -> bytes:
    msg = EmailMessage()
    msg["Subject"] = assunto
    msg["From"] = f"Fulano <{remetente}>"
    msg["Date"] = "Wed, 15 Jul 2026 10:00:00 -0300"
    if message_id:
        msg["Message-ID"] = message_id
    msg.set_content("corpo do e-mail com bastante texto para valer a pena guardar")
    for nome, dados, mime in anexos:
        maintype, subtype = mime.split("/")
        msg.add_attachment(dados, maintype=maintype, subtype=subtype, filename=nome)
    for cid, dados, mime in inline:
        maintype, subtype = mime.split("/")
        # `disposition="inline"` e o que distingue logo/assinatura de anexo-documento: o reader
        # exige "attachment" no Content-Disposition para considerar uma IMAGEM.
        msg.add_attachment(dados, maintype=maintype, subtype=subtype,
                           cid=f"<{cid}>", disposition="inline")
    return msg.as_bytes()


class DocumentPartsTest(unittest.TestCase):
    """A selecao de anexos tem de casar EXATAMENTE a do reader.

    Se a varredura pegar mais partes que `save_attachments`, sobe ao bucket coisa que o pipeline
    nunca consideraria documento (logo/assinatura); se pegar menos, perde justamente o CT-e que
    a onda existe para recuperar. Por isso o teste compara com o reader RODANDO, e as constantes
    de mime/extensao sao importadas dele, nao redefinidas aqui.
    """

    def test_seleciona_o_mesmo_conjunto_que_save_attachments(self):
        raw = _mensagem(
            anexos=[("dacte.pdf", _PDF, "application/pdf"),
                    ("foto.jpg", b"\xff\xd8\xff" + b"x" * 100, "image/jpeg")],
            inline=[("logo", b"\x89PNG" + b"y" * 50, "image/png")])
        msg = email.message_from_bytes(raw)

        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(R, "PDF_INBOX", Path(td)):
                salvos = R.save_attachments(msg, "fin@transportes.com.br", "BOLETO", "2026-07-15")
            nomes_reader = sorted(p.suffix for p in salvos)

        nossos = sorted(a["ext"] for a in V._document_parts(msg))
        self.assertEqual(nossos, nomes_reader)
        self.assertEqual(nossos, [".jpg", ".pdf"])   # o PNG INLINE fica de fora nos dois

    def test_ignora_parte_sem_payload(self):
        msg = EmailMessage()
        msg["Subject"] = "x"
        msg.set_content("so texto")
        self.assertEqual(V._document_parts(msg), [])


class StorageKeyTest(unittest.TestCase):
    """A chave do objeto decide se o PDF recuperado sobrescreve algo — e se, ao retomar apos uma
    queda, o mesmo anexo gera a mesma chave em vez de duplicar."""

    def _chave(self, objetos, payload=_PDF, filename="dacte.pdf"):
        return V.storage_key_for("fin@transportes.com.br", "BOLETO TRANSPORTE",
                                 "2026-07-15T10:00:00+00:00", filename, ".pdf",
                                 payload, objetos)

    def test_nome_livre_sobe_com_a_base(self):
        chave, subir = self._chave({})
        self.assertTrue(subir)
        self.assertEqual(chave, "fin_BOLETO_TRANSPORTE_20260715_dacte.pdf")

    def test_chave_e_deterministica_entre_execucoes(self):
        """Retomar apos uma queda tem de gerar a MESMA chave.

        Mutante que este teste derruba: resolver colisao por CONTADOR (`_1`, `_2`), como o reader
        faz contra o disco. Ali funciona porque o disco guarda o estado; aqui a segunda execucao
        comecaria do zero e criaria um objeto novo a cada tentativa.
        """
        ocupado = {"fin_BOLETO_TRANSPORTE_20260715_dacte.pdf": {"size": 999}}
        primeira = self._chave(ocupado)
        segunda = self._chave(ocupado)
        self.assertEqual(primeira, segunda)
        self.assertTrue(primeira[0].endswith(".pdf"))
        self.assertNotEqual(primeira[0], "fin_BOLETO_TRANSPORTE_20260715_dacte.pdf")

    def test_mesmo_tamanho_reusa_o_nome_e_nao_sobe(self):
        """Anexo ja processado pelo reader: a chave tem de ser a DELE, e nada e reenviado."""
        objetos = {"fin_BOLETO_TRANSPORTE_20260715_dacte.pdf": {"size": len(_PDF)}}
        chave, subir = self._chave(objetos)
        self.assertEqual(chave, "fin_BOLETO_TRANSPORTE_20260715_dacte.pdf")
        self.assertFalse(subir)

    def test_conteudo_diferente_no_mesmo_nome_ganha_sufixo(self):
        objetos = {"fin_BOLETO_TRANSPORTE_20260715_dacte.pdf": {"size": 1}}
        chave, subir = self._chave(objetos)
        self.assertTrue(subir)
        self.assertNotIn(chave, objetos)

    def test_size_ilegivel_nao_assume_identidade(self):
        """Metadata sem `size` (ou com lixo) NAO pode ser lido como "e o mesmo arquivo" — isso
        faria a varredura pular um upload legitimo e o PDF continuaria perdido."""
        for meta in ({}, {"size": None}, {"size": "abc"}):
            with self.subTest(meta=meta):
                _, subir = self._chave({"fin_BOLETO_TRANSPORTE_20260715_dacte.pdf": meta})
                self.assertTrue(subir)

    def test_chave_nunca_contem_barra(self):
        """`/` no nome criaria uma PASTA no bucket, fora da convencao flat do pipeline."""
        chave, _ = self._chave({}, filename="../../etc/passwd.pdf")
        self.assertNotIn("/", chave)
        self.assertNotIn("..", chave)

    def test_casa_o_nome_que_o_reader_produz(self):
        """Guarda cross-layer: sem colisao, a chave e IDENTICA a do `save_attachments`.

        E o que faz um anexo ja no bucket ser reconhecido em vez de duplicado, e o que mantem o
        prefixo `{remetente}_{assunto}_{AAAAMMDD}_` que a purga e o `_provenance_index` leem.
        """
        raw = _mensagem(anexos=[("dacte.pdf", _PDF, "application/pdf")])
        msg = email.message_from_bytes(raw)
        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(R, "PDF_INBOX", Path(td)):
                salvos = R.save_attachments(msg, "fin@transportes.com.br",
                                            "BOLETO TRANSPORTE", "2026-07-15")
        chave, _ = self._chave({})
        self.assertEqual(chave, salvos[0].name)


class MessageIdentityTest(unittest.TestCase):
    def test_sem_message_id_nao_inventa_proveniencia(self):
        """`gmail_message_id` fica NULO quando o header nao existe — preencher com o sintetico
        gravaria uma proveniencia falsa. O sintetico serve so para casar `email_control`, onde o
        reader usa a mesma forma."""
        raw = _mensagem(message_id=None)
        ctx = V._message_identity(email.message_from_bytes(raw), b"42", None)
        self.assertIsNone(ctx["message_id"])
        self.assertEqual(ctx["chave_indice"], "no-id-42")

    def test_com_message_id_usa_o_real_nos_dois(self):
        raw = _mensagem(message_id="<real@dominio>")
        ctx = V._message_identity(email.message_from_bytes(raw), b"7", None)
        self.assertEqual(ctx["message_id"], "<real@dominio>")
        self.assertEqual(ctx["chave_indice"], "<real@dominio>")
        self.assertEqual(ctx["sender_email"], "fin@transportes.com.br")


class CheckpointTest(unittest.TestCase):
    ATUAL = {"imap_user": "financeiro@otimotex.com.br", "mailbox": "INBOX",
             "uidvalidity": "1721038411", "criterio": "ALL"}

    def _salvo(self, **troca):
        base = {"versao": V.CHECKPOINT_VERSAO, **self.ATUAL}
        base.update(troca)
        return base

    def test_checkpoint_recusa_uidvalidity_diferente(self):
        """O UID so e estavel dentro de (mailbox, UIDVALIDITY). Se a caixa for recriada, os UIDs
        antigos designam OUTRAS mensagens: retomar pularia mensagens nunca processadas — em
        silencio, que e o pior desfecho possivel numa passada unica."""
        motivo = V._checkpoint_compativel(self._salvo(uidvalidity="999"), self.ATUAL)
        self.assertIsNotNone(motivo)
        self.assertIn("uidvalidity", motivo)

    def test_recusa_conta_pasta_ou_criterio_diferentes(self):
        for campo, valor in (("imap_user", "outro@x.com"), ("mailbox", "Arquivo"),
                             ("criterio", "UNSEEN")):
            with self.subTest(campo=campo):
                self.assertIsNotNone(
                    V._checkpoint_compativel(self._salvo(**{campo: valor}), self.ATUAL))

    def test_recusa_versao_antiga(self):
        self.assertIsNotNone(V._checkpoint_compativel(self._salvo(versao=0), self.ATUAL))

    def test_aceita_identico_e_ausente(self):
        self.assertIsNone(V._checkpoint_compativel(self._salvo(), self.ATUAL))
        self.assertIsNone(V._checkpoint_compativel({}, self.ATUAL))

    def test_gravacao_e_atomica(self):
        """Ctrl+C no meio de um `json.dump` direto deixaria o arquivo truncado e o run seguinte
        perderia o progresso inteiro — exatamente o que o checkpoint existe para evitar."""
        with tempfile.TemporaryDirectory() as td:
            alvo = Path(td) / "cp.json"
            V._salva_checkpoint(alvo, {"versao": 1, "concluidos": [1, 2]})
            self.assertEqual(json.loads(alvo.read_text(encoding="utf-8"))["concluidos"], [1, 2])
            self.assertFalse(alvo.with_suffix(".tmp").exists())

    def test_checkpoint_corrompido_nao_derruba_o_run(self):
        with tempfile.TemporaryDirectory() as td:
            alvo = Path(td) / "cp.json"
            alvo.write_text("{ truncad", encoding="utf-8")
            self.assertEqual(V._carrega_checkpoint(alvo), {})


class UidsPendentesTest(unittest.TestCase):
    def test_remove_concluidos_preservando_a_ordem(self):
        self.assertEqual(V._uids_pendentes([b"1", b"2", b"3"], {"2"}), [b"1", b"3"])

    def test_falhado_volta_para_a_fila(self):
        """Falhado NAO entra em `concluidos`, entao e retentado sozinho na proxima execucao."""
        self.assertEqual(V._uids_pendentes([b"1", b"2"], {"1"}), [b"2"])

    def test_tolera_uid_concluido_que_sumiu_da_caixa(self):
        self.assertEqual(V._uids_pendentes([b"5"], {"1", "2", "5"}), [])


class FiscalPayloadTest(unittest.TestCase):
    DOC = {"access_key": "3" * 44, "model": 57, "model_name": "CT-e", "uf_code": 35,
           "issue_yearmonth": "2607", "emitter_cnpj": "1" * 14, "series": 1,
           "doc_number": 123, "dv": 3}

    def test_payload_tem_as_colunas_da_migration_107(self):
        payload = V._fiscal_payload(self.DOC, "obj.pdf",
                                    {"message_id": "<a@b>", "sender_email": "x@y.com",
                                     "subject": "CT-e", "received_at": "2026-07-15T00:00:00Z"})
        self.assertEqual(set(payload), {
            "access_key", "model", "uf_code", "issue_yearmonth", "emitter_cnpj", "series",
            "doc_number", "storage_key", "gmail_message_id", "sender_email", "subject",
            "received_at"})
        self.assertEqual(payload["gmail_message_id"], "<a@b>")

    def test_sem_message_id_grava_nulo(self):
        payload = V._fiscal_payload(self.DOC, "obj.pdf", {"message_id": None})
        self.assertIsNone(payload["gmail_message_id"])

    def test_nao_grava_valor_monetario(self):
        """Documento fiscal NUNCA soma em relatorio financeiro — a barreira e ESTRUTURAL (a
        tabela nao tem coluna de valor). Um payload com valor nem chegaria ao banco, mas o teste
        trava a intencao antes de alguem tentar."""
        payload = V._fiscal_payload(self.DOC, "obj.pdf", {})
        self.assertFalse([c for c in payload if "amount" in c or "valor" in c])


class _FakeResposta:
    def __init__(self, corpo=b"[]"):
        self._corpo = corpo

    def read(self):
        return self._corpo

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class EscritasTest(unittest.TestCase):
    """As tres unicas funcoes que alteram algo. O `urlopen` e falseado dentro do
    `supabase_rest`, que e por onde as escritas passam (fonte unica de transporte)."""

    def setUp(self):
        self.chamadas = []

    def _urlopen(self, corpo=b"[]", erro=None):
        def falso(req, timeout=None):
            self.chamadas.append({
                "url": req.full_url,
                "metodo": req.get_method(),
                "headers": {k.lower(): v for k, v in req.header_items()},
                "corpo": json.loads(req.data.decode()) if (
                    req.data and req.get_header("Content-type", "").startswith("application/json")
                ) else req.data,
            })
            if erro:
                raise erro
            return _FakeResposta(corpo)
        return mock.patch.object(SR.urllib.request, "urlopen", falso)

    # ---- body_full -------------------------------------------------------------------
    def test_patch_so_alcanca_linha_nula(self):
        """O filtro `body_full=is.null` vai NA URL.

        Mutante que este teste derruba: filtrar so por `id=eq.N` (como o
        `reprocess_body_emails.save_body_full` faz, para outro fim) — o PATCH passaria a
        SOBRESCREVER um corpo ja gravado, violando o invariante de nao-sobrescrita e apagando
        texto que o reader acabou de guardar.
        """
        with self._urlopen(b'[{"id":7}]'):
            self.assertEqual(V._patch_body_full(7, "texto do corpo"), "gravado")
        url = self.chamadas[0]["url"]
        self.assertIn("id=eq.7", url)
        self.assertIn("body_full=is.null", url)
        self.assertEqual(self.chamadas[0]["metodo"], "PATCH")

    def test_resposta_vazia_significa_ja_tinha_corpo(self):
        """Corrida real: o reader agendado pode preencher a linha entre o inventario e o PATCH.
        Zero linhas afetadas nao e erro nem gravacao — e um terceiro desfecho."""
        with self._urlopen(b"[]"):
            self.assertEqual(V._patch_body_full(7, "texto"), "ja_tinha")

    def test_corpo_vazio_nao_toca_a_rede(self):
        with self._urlopen():
            self.assertEqual(V._patch_body_full(7, ""), "vazio")
        self.assertEqual(self.chamadas, [])

    def test_falha_de_rede_no_corpo_nao_levanta(self):
        with self._urlopen(erro=urllib.error.URLError("timed out")):
            self.assertEqual(V._patch_body_full(7, "texto"), "erro")

    def test_usa_o_teto_do_reader(self):
        """O corte do corpo vem de `R._body_full_for_storage` — fonte unica, coerente com o
        `left(...,100000)` da coluna gerada. Um teto proprio poderia divergir e estourar o limite
        de 1 MB do tsvector, derrubando a gravacao da linha inteira."""
        with self._urlopen(b'[{"id":1}]'):
            V._patch_body_full(1, "x" * 200_000)
        enviado = self.chamadas[0]["corpo"]["body_full"]
        self.assertEqual(enviado, R._body_full_for_storage("x" * 200_000))
        self.assertLess(len(enviado), 200_000)

    # ---- upload ----------------------------------------------------------------------
    def test_upload_nao_sobrescreve(self):
        """Mutante que este teste derruba: copiar o `x-upsert: true` do
        `SupabaseControl.upload_attachment` — o objeto que ja esta no bucket seria substituido,
        e num acervo historico isso e perda irreversivel."""
        with self._urlopen(b"{}"):
            self.assertEqual(V._upload_object("obj.pdf", _PDF, "application/pdf"), "subiu")
        headers = self.chamadas[0]["headers"]
        self.assertNotIn("x-upsert", headers)
        self.assertEqual(headers.get("Content-type".lower()), "application/pdf")

    def test_409_e_ja_existe_nao_falha(self):
        """"O objeto ja estava la" e sucesso para quem so quer garantir que o arquivo exista."""
        erro = urllib.error.HTTPError("u", 409, "Duplicate", {}, None)
        erro.read = lambda: b"duplicate"
        with self._urlopen(erro=erro):
            self.assertEqual(V._upload_object("obj.pdf", _PDF, "application/pdf"), "ja_existe")

    def test_erro_de_upload_e_reportado(self):
        erro = urllib.error.HTTPError("u", 500, "Boom", {}, None)
        erro.read = lambda: b"boom"
        with self._urlopen(erro=erro):
            self.assertEqual(V._upload_object("obj.pdf", _PDF, "application/pdf"), "erro")

    # ---- fiscal ----------------------------------------------------------------------
    def test_duplicado_nao_conta_como_inserido(self):
        """Mutante que este teste derruba: trocar `return=representation` por `return=minimal` —
        o PostgREST responde 201 mesmo SEM inserir, e o relatorio passaria a contar duplicata
        como documento novo, mentindo sobre o resultado da passada."""
        doc = FiscalPayloadTest.DOC
        with self._urlopen(b"[]"):
            self.assertEqual(V._registrar_fiscal(doc, "obj.pdf", {}), "duplicado")
        prefer = self.chamadas[0]["headers"]["prefer"]
        self.assertIn("resolution=ignore-duplicates", prefer)
        self.assertIn("return=representation", prefer)

    def test_insercao_real_e_distinguivel(self):
        with self._urlopen(b'[{"id":1}]'):
            self.assertEqual(V._registrar_fiscal(FiscalPayloadTest.DOC, "obj.pdf", {}),
                             "inserido")
        self.assertIn("on_conflict=access_key", self.chamadas[0]["url"])


class DecryptTemporarioTest(unittest.TestCase):
    """`extract_pdf._decrypt_pdf` grava a copia DESCRIPTOGRAFADA via `mkstemp` e devolve o Path,
    sem apagar. No reader e um arquivo por e-mail novo; aqui seria um boleto LEGIVEL por anexo
    cifrado da caixa inteira, acumulado no diretorio temporario do usuario."""

    def test_o_pdf_aberto_e_apagado_depois_de_lido(self):
        with tempfile.TemporaryDirectory() as td:
            aberto = Path(td) / "dec_abc.pdf"
            aberto.write_bytes(_PDF)
            fake = type(sys)("extract_pdf")
            fake._decrypt_pdf = lambda caminho, senhas: aberto
            with mock.patch.dict(sys.modules, {"extract_pdf": fake}), \
                 mock.patch.object(V.R, "pdf_password_candidates", return_value=[]), \
                 mock.patch.object(V, "_company_cnpj", return_value=""), \
                 mock.patch.object(V.R, "_pdf_text", return_value="texto"):
                self.assertEqual(V._texto_apos_decrypt(Path(td) / "orig.pdf"), "texto")
            self.assertFalse(aberto.exists(), "o PDF descriptografado ficou no disco")

    def test_falha_no_meio_tambem_apaga(self):
        with tempfile.TemporaryDirectory() as td:
            aberto = Path(td) / "dec_abc.pdf"
            aberto.write_bytes(_PDF)
            fake = type(sys)("extract_pdf")
            fake._decrypt_pdf = lambda caminho, senhas: aberto
            with mock.patch.dict(sys.modules, {"extract_pdf": fake}), \
                 mock.patch.object(V.R, "pdf_password_candidates", return_value=[]), \
                 mock.patch.object(V, "_company_cnpj", return_value=""), \
                 mock.patch.object(V.R, "_pdf_text", side_effect=ValueError("pdf quebrado")):
                self.assertEqual(V._texto_apos_decrypt(Path(td) / "orig.pdf"), "")
            self.assertFalse(aberto.exists())


class _FakeMail:
    """IMAP falso. Ha precedente no projeto (`tests/test_imap_retry.py` usa MagicMock)."""

    def __init__(self, mensagens=None, uidvalidity=b"1721038411"):
        self.mensagens = mensagens or {}
        self.uidvalidity = uidvalidity
        self.selects = []
        self.fetches = []
        self.deslogou = False
        self.falhar_proximo_fetch = None
        # Falha SO no fetch do corpo. `tamanho()` e `mensagem()` sao dois fetches distintos, e
        # so o segundo tem reconexao — um fake que falhasse "o proximo" derrubaria o primeiro e
        # o caminho de reconexao nunca seria exercido.
        self.falhar_proximo_body = None
        # Falha no corpo de UM uid especifico — permite deixar as mensagens anteriores passarem,
        # que e o cenario real de uma queda no MEIO da varredura (com progresso ja acumulado).
        self.falhar_body_do_uid = {}

    def select(self, mailbox, readonly=False):
        self.selects.append((mailbox, readonly))
        return "OK", [b"10"]

    def response(self, chave):
        return chave, [self.uidvalidity]

    def uid(self, comando, uid, spec=None):
        if comando == "fetch":
            self.fetches.append((uid, spec))
            if self.falhar_proximo_fetch:
                erro, self.falhar_proximo_fetch = self.falhar_proximo_fetch, None
                raise erro
            if self.falhar_proximo_body and "BODY.PEEK[]" in (spec or ""):
                erro, self.falhar_proximo_body = self.falhar_proximo_body, None
                raise erro
            if "BODY.PEEK[]" in (spec or "") and uid in self.falhar_body_do_uid:
                raise self.falhar_body_do_uid.pop(uid)
            tamanho = len(self.mensagens.get(uid, b""))
            if spec == "(RFC822.SIZE)":
                return "OK", [b"1 (RFC822.SIZE " + str(tamanho).encode() + b")"]
            meta = (b'1 (INTERNALDATE "15-Jul-2026 10:00:00 +0000" RFC822.SIZE '
                    + str(tamanho).encode() + b" BODY[] {1})")
            return "OK", [(meta, self.mensagens.get(uid, b""))]
        return "OK", [b" ".join(self.mensagens)]

    def list(self):
        return "OK", [b'(\\HasNoChildren) "." "INBOX"',
                      b'(\\HasNoChildren) "." "Itens Enviados"']

    def logout(self):
        self.deslogou = True


class CaixaTest(unittest.TestCase):
    def _abrir(self, mail, uids=(b"1",)):
        caixa = V.Caixa()
        with mock.patch.object(R, "_connect_and_search", lambda c: (mail, list(uids))):
            achados = caixa.abrir()
        return caixa, achados

    def test_a_caixa_e_aberta_em_readonly(self):
        """EXAMINE e a trava ESTRUTURAL contra marcar \\Seen: em read-only o servidor nao PODE
        gravar flag permanente, nem diante de um fetch sem PEEK.

        Mutante que este teste derruba: usar `select(mailbox)` simples, como `_connect_imap` do
        reader faz (ele PRECISA gravar \\Seen; aqui isso e proibido).
        """
        mail = _FakeMail()
        caixa, _ = self._abrir(mail)
        self.assertIn((V.MAILBOX, True), mail.selects)
        self.assertTrue(all(ro for _, ro in mail.selects))
        self.assertEqual(caixa.uidvalidity, "1721038411")

    def test_fetch_da_mensagem_usa_peek(self):
        raw = _mensagem()
        mail = _FakeMail({b"1": raw})
        caixa, _ = self._abrir(mail)
        caixa.mensagem(b"1")
        spec = [s for u, s in mail.fetches if u == b"1" and "BODY" in (s or "")][0]
        self.assertIn("BODY.PEEK[]", spec)
        self.assertNotIn("RFC822)", spec)

    def test_reconecta_e_retenta_o_mesmo_uid(self):
        """A queda no meio dos N mil FETCH e o modo de falha esperado numa varredura —
        `_connect_and_search` do reader cobre apenas o search INICIAL."""
        raw = _mensagem()
        mail = _FakeMail({b"1": raw})
        mail.falhar_proximo_fetch = TimeoutError("socket timeout")
        caixa, _ = self._abrir(mail)
        with mock.patch.object(R, "_connect_and_search", lambda c: (mail, [b"1"])):
            meta, obtido = caixa.mensagem(b"1")
        self.assertEqual(obtido, raw)

    def test_uidvalidity_diferente_apos_reconexao_aborta(self):
        """Continuar seria processar mensagens ERRADAS em silencio."""
        mail = _FakeMail({b"1": _mensagem()})
        caixa, _ = self._abrir(mail)
        mail.falhar_proximo_fetch = TimeoutError("caiu")
        outro = _FakeMail({b"1": _mensagem()}, uidvalidity=b"999")
        with mock.patch.object(R, "_connect_and_search", lambda c: (outro, [b"1"])):
            with self.assertRaises(RuntimeError) as ctx:
                caixa.mensagem(b"1")
        self.assertIn("UIDVALIDITY", str(ctx.exception))

    def test_tamanho_nao_baixa_a_mensagem(self):
        raw = _mensagem()
        mail = _FakeMail({b"1": raw})
        caixa, _ = self._abrir(mail)
        self.assertEqual(caixa.tamanho(b"1"), len(raw))
        self.assertEqual(mail.fetches[-1][1], "(RFC822.SIZE)")

    def test_previa_traz_cabecalho_e_tamanho_num_unico_fetch(self):
        """Numa caixa de milhares de mensagens, pedir tamanho e cabecalho em chamadas separadas
        dobraria as idas ao servidor no dry-run — que e justamente o passo BARATO."""
        raw = _mensagem()
        mail = _FakeMail({b"1": raw})
        caixa, _ = self._abrir(mail)
        antes = len(mail.fetches)
        _, obtido, tamanho = caixa.previa(b"1")
        self.assertEqual(len(mail.fetches) - antes, 1)
        self.assertEqual(tamanho, len(raw))
        self.assertIn("BODY.PEEK[HEADER.FIELDS", mail.fetches[-1][1])

    def test_lista_pastas_com_nome_composto(self):
        """Cortar o nome por espaco perderia "Itens Enviados" — e o inventario de pastas existe
        justamente para medir o acervo FORA da INBOX."""
        mail = _FakeMail()
        caixa, _ = self._abrir(mail)
        nomes = [n for n, _ in caixa.pastas()]
        self.assertEqual(nomes, ["INBOX", "Itens Enviados"])


class ProcessarMensagemTest(unittest.TestCase):
    """O fluxo por mensagem, com os bytes JA baixados — sem servidor IMAP nenhum."""

    def _estado(self, **troca):
        estado = {
            "registrados": set(),
            "corpo_pendente": {},
            "chaves_fiscais": set(),
            "objetos": {},
            "tally": V._novo_tally(),
            "dry_run": False,
            "upload_all": False,
            "amostra": [],
        }
        estado.update(troca)
        return estado

    def test_corpo_gravado_apenas_para_linha_pendente(self):
        estado = self._estado(corpo_pendente={"<abc@x>": 42})
        with mock.patch.object(V, "_patch_body_full", return_value="gravado") as patch:
            V._processar_mensagem(estado, b"1", _mensagem(), None)
        patch.assert_called_once()
        self.assertEqual(patch.call_args[0][0], 42)
        self.assertEqual(estado["tally"]["corpo_gravado"], 1)

    def test_email_fora_do_controle_nao_cria_linha(self):
        """Decisao de escopo: e-mail nunca registrado NAO ganha linha em `email_control` — so o
        documento fiscal, cuja tabela guarda a propria proveniencia e nao tem FK."""
        estado = self._estado()
        with mock.patch.object(V, "_patch_body_full") as patch:
            V._processar_mensagem(estado, b"1", _mensagem(), None)
        patch.assert_not_called()
        self.assertEqual(estado["tally"]["fora_do_email_control"], 1)

    def test_anexo_sem_chave_nao_sobe_ao_bucket(self):
        """Sem chave nao ha linha em `fiscal_document`, e a proxima purga apagaria o objeto como
        orfao: subir seria pagar banda por algo destinado a ser deletado."""
        estado = self._estado()
        raw = _mensagem(anexos=[("boleto.pdf", _PDF, "application/pdf")])
        with mock.patch.object(V, "_texto_do_pdf", return_value="boleto comum sem chave"), \
             mock.patch.object(V, "_upload_object") as upload:
            V._processar_mensagem(estado, b"1", raw, None)
        upload.assert_not_called()
        self.assertEqual(estado["tally"]["sem_chave"], 1)

    def test_falha_de_upload_nao_marca_a_mensagem_como_concluida(self):
        """Se o UID fosse dado por concluido, o checkpoint o pularia para sempre e o PDF — que
        so existe no IMAP — se perderia de vez."""
        estado = self._estado()
        raw = _mensagem(anexos=[("dacte.pdf", _PDF, "application/pdf")])
        chave = "3" * 44
        doc = {**FiscalPayloadTest.DOC, "access_key": chave}
        with mock.patch.object(V, "_texto_do_pdf", return_value=chave), \
             mock.patch.object(V.fiscal_key, "extract_access_keys", return_value=[chave]), \
             mock.patch.object(V.fiscal_key, "parse_access_key", return_value=doc), \
             mock.patch.object(V, "_upload_object", return_value="erro"), \
             mock.patch.object(V, "_quarentena") as quarentena, \
             mock.patch.object(V, "_registrar_fiscal") as registrar:
            ok = V._processar_mensagem(estado, b"1", raw, None)
        self.assertFalse(ok)
        quarentena.assert_called_once()
        registrar.assert_not_called()

    def test_upload_all_sobe_anexo_sem_chave_e_nao_registra_fiscal(self):
        """`--upload-all` e a UNICA flag que muda o comportamento de escrita.

        Sem este caso, inverter a condicao (`if not docs and not upload_all`) faria a varredura
        subir TODOS os anexos por padrao — objetos que a proxima purga apagaria como orfaos,
        depois de pagar a banda — e nenhum teste ficaria vermelho.
        """
        estado = self._estado(upload_all=True)
        raw = _mensagem(anexos=[("boleto.pdf", _PDF, "application/pdf")])
        with mock.patch.object(V, "_texto_do_pdf", return_value="boleto comum, sem chave"), \
             mock.patch.object(V, "_upload_object", return_value="subiu") as upload, \
             mock.patch.object(V, "_registrar_fiscal") as registrar:
            ok = V._processar_mensagem(estado, b"1", raw, None)
        self.assertTrue(ok)
        upload.assert_called_once()
        registrar.assert_not_called()          # sem chave nao ha o que registrar
        self.assertEqual(estado["tally"]["sem_chave"], 0)

    def test_dry_run_nao_chama_nenhuma_escrita(self):
        estado = self._estado(dry_run=True, corpo_pendente={"<abc@x>": 42})
        raw = _mensagem(anexos=[("dacte.pdf", _PDF, "application/pdf")])
        chave = "3" * 44
        doc = {**FiscalPayloadTest.DOC, "access_key": chave}
        with mock.patch.object(V, "_texto_do_pdf", return_value=chave), \
             mock.patch.object(V.fiscal_key, "extract_access_keys", return_value=[chave]), \
             mock.patch.object(V.fiscal_key, "parse_access_key", return_value=doc), \
             mock.patch.object(V, "_patch_body_full") as patch, \
             mock.patch.object(V, "_upload_object") as upload, \
             mock.patch.object(V, "_registrar_fiscal") as registrar:
            V._processar_mensagem(estado, b"1", raw, None)
        patch.assert_not_called()
        upload.assert_not_called()
        registrar.assert_not_called()
        self.assertEqual(estado["tally"]["corpo_a_gravar"], 1)
        self.assertEqual(estado["tally"]["fiscal_a_inserir"], 1)


class MainDryRunTest(unittest.TestCase):
    """Testes de `main` — SEMPRE com o estado local isolado num tmpdir.

    Sem este `setUp`, os casos liam o `data/varredura_checkpoint.json` REAL do projeto: enquanto
    o script nunca tinha rodado o arquivo nao existia e tudo passava por ACIDENTE. Na primeira
    execucao de verdade (2026-08-03) o checkpoint apareceu com o UIDVALIDITY da caixa real, o
    gate de compatibilidade disparou e `test_dry_run_nao_escreve_nada` ficou vermelho — teste
    verde por ausencia de estado e um so ambiente separando os dois resultados.
    """

    def setUp(self):
        temporario = tempfile.TemporaryDirectory()
        self.addCleanup(temporario.cleanup)
        raiz = Path(temporario.name)
        for atributo, valor in (("CHECKPOINT_PATH", raiz / "checkpoint.json"),
                                ("QUARENTENA_DIR", raiz / "quarentena")):
            remendo = mock.patch.object(V, atributo, valor)
            remendo.start()
            self.addCleanup(remendo.stop)

    def test_dry_run_nao_escreve_nada(self):
        """Ponta-a-ponta: com IMAP e inventario falsos, `main(--dry-run)` nao pode fazer UMA
        escrita sequer.

        Mutante que este teste derruba: mover qualquer chamada de escrita para fora da guarda de
        dry-run. E a rede de seguranca do modo que o roadmap torna obrigatorio ANTES da passada
        real.
        """
        raw = _mensagem(anexos=[("dacte.pdf", _PDF, "application/pdf")])
        mail = _FakeMail({b"1": raw})

        def _sem_rede(*a, **k):
            raise AssertionError("dry-run tentou falar com o Supabase")

        inventario = {"registrados": set(), "corpo_pendente": {}, "sem_keyword": 0,
                      "chaves_fiscais": set(), "objetos": {}}
        with mock.patch.object(V, "_inventario", return_value=inventario), \
             mock.patch.object(R, "_connect_and_search", lambda c: (mail, [b"1"])), \
             mock.patch.object(SR.urllib.request, "urlopen", _sem_rede), \
             mock.patch.object(V, "_salva_checkpoint") as salva:
            codigo = V.main(["--dry-run"])
        self.assertEqual(codigo, 0)
        salva.assert_not_called()
        self.assertTrue(mail.deslogou)

    def test_checkpoint_incompativel_aborta_antes_de_processar(self):
        mail = _FakeMail({b"1": _mensagem()})
        inventario = {"registrados": set(), "corpo_pendente": {}, "sem_keyword": 0,
                      "chaves_fiscais": set(), "objetos": {}}
        with mock.patch.object(V, "_inventario", return_value=inventario), \
             mock.patch.object(R, "_connect_and_search", lambda c: (mail, [b"1"])), \
             mock.patch.object(V, "_carrega_checkpoint",
                               return_value={"versao": V.CHECKPOINT_VERSAO,
                                             "uidvalidity": "999", "mailbox": V.MAILBOX,
                                             "criterio": "ALL", "imap_user": None}), \
             mock.patch.object(V, "_processar_mensagem") as processa:
            codigo = V.main([])
        self.assertEqual(codigo, 1)
        processa.assert_not_called()

    def test_uidvalidity_novo_nao_contamina_o_checkpoint(self):
        """O checkpoint grava a identidade capturada NA ABERTURA, nunca a corrente.

        Quando a reconexao aborta por UIDVALIDITY diferente, `caixa.uidvalidity` ja foi
        atualizado para o valor NOVO. Gravar esse valor ao lado dos UIDs do inventario ANTIGO
        tornaria o checkpoint "compativel" na execucao seguinte, e ela retomaria pulando as
        mensagens erradas — em silencio. Bug real, encontrado na autorrevisao.
        """
        msgs = {b"1": _mensagem(), b"2": _mensagem(), b"3": _mensagem()}
        original = _FakeMail(dict(msgs))
        # As duas primeiras passam; a queda vem na TERCEIRA — o cenario real, com progresso ja
        # acumulado que o checkpoint precisa preservar.
        original.falhar_body_do_uid = {b"3": TimeoutError("caiu no meio do fetch")}
        outra_caixa = _FakeMail(dict(msgs), uidvalidity=b"999")
        inventario = {"registrados": set(), "corpo_pendente": {}, "sem_keyword": 0,
                      "chaves_fiscais": set(), "objetos": {}}
        gravados = []
        conexoes = [original, outra_caixa]

        # A 1a conexao abre a caixa; a 2a (reconexao apos a queda) ja encontra OUTRO
        # UIDVALIDITY — e o `_reconectar` atualiza `caixa.uidvalidity` ANTES de abortar.
        def _conecta(_criterio):
            mail = conexoes.pop(0) if conexoes else outra_caixa
            return mail, [b"1", b"2", b"3"]

        with mock.patch.object(V, "_inventario", return_value=inventario), \
             mock.patch.object(R, "_connect_and_search", _conecta), \
             mock.patch.object(V, "_carrega_checkpoint", return_value={}), \
             mock.patch.object(V, "_salva_checkpoint",
                               side_effect=lambda p, e: gravados.append(e)):
            codigo = V.main([])

        self.assertEqual(codigo, 1, "run com falha tem de sinalizar exit != 0")
        self.assertTrue(gravados, "o progresso ja obtido precisa ser gravado antes de abortar")
        self.assertEqual(gravados[-1]["concluidos"], ["1", "2"])
        self.assertEqual(gravados[-1]["uidvalidity"], "1721038411",
                         "gravou a UIDVALIDITY NOVA: o proximo run retomaria na caixa errada")

    def test_caixa_que_muda_no_meio_ABORTA_o_laco(self):
        """Detectar que a caixa virou outra e seguir mesmo assim e o pior dos dois mundos.

        O `except Exception` do laco existe para isolar uma mensagem ruim — e por isso engolia o
        aborto: a varredura imprimia "Abortando" e ia para o UID seguinte, que na caixa nova
        designa OUTRA mensagem. Medido antes da correcao: os uids 2 e 3 seguiam sendo
        processados. `CaixaMudou` tem tipo proprio justamente para atravessar esse `except`.
        """
        original = _FakeMail({b"1": _mensagem(), b"2": _mensagem(), b"3": _mensagem()})
        original.falhar_proximo_body = TimeoutError("caiu")
        outra = _FakeMail({b"1": _mensagem(), b"2": _mensagem(), b"3": _mensagem()},
                          uidvalidity=b"999")
        conexoes = [original, outra]
        inventario = {"registrados": set(), "corpo_pendente": {}, "sem_keyword": 0,
                      "chaves_fiscais": set(), "objetos": {}}
        processadas = []

        with mock.patch.object(V, "_inventario", return_value=inventario), \
             mock.patch.object(R, "_connect_and_search",
                               lambda c: (conexoes.pop(0) if conexoes else outra,
                                          [b"1", b"2", b"3"])), \
             mock.patch.object(V, "_carrega_checkpoint", return_value={}), \
             mock.patch.object(V, "_salva_checkpoint"), \
             mock.patch.object(V, "_processar_mensagem",
                               side_effect=lambda e, u, r, m: processadas.append(u) or True):
            codigo = V.main([])

        self.assertEqual(codigo, 1)
        self.assertEqual(processadas, [],
                         "seguiu processando uids numa caixa que ja nao e a mesma")

    def test_aborto_no_gate_do_checkpoint_nao_imprime_relatorio_zerado(self):
        """Um relatorio inteiro de zeros logo abaixo da mensagem de erro empurra a causa para
        fora da tela e sugere que a varredura rodou. So ha relatorio depois que ela comeca."""
        mail = _FakeMail({b"1": _mensagem()})
        inventario = {"registrados": set(), "corpo_pendente": {}, "sem_keyword": 0,
                      "chaves_fiscais": set(), "objetos": {}}
        with mock.patch.object(V, "_inventario", return_value=inventario), \
             mock.patch.object(R, "_connect_and_search", lambda c: (mail, [b"1"])), \
             mock.patch.object(V, "_carrega_checkpoint",
                               return_value={"versao": V.CHECKPOINT_VERSAO,
                                             "uidvalidity": "999", "mailbox": V.MAILBOX,
                                             "criterio": "ALL", "imap_user": None}), \
             mock.patch.object(V, "_relatorio") as relatorio:
            self.assertEqual(V.main([]), 1)
        relatorio.assert_not_called()
        self.assertTrue(mail.deslogou, "a conexao IMAP tem de ser fechada mesmo no aborto")

    def test_relatorio_usa_as_contagens_de_ANTES_do_laco(self):
        """`estado = {**inv, ...}` e copia RASA — o processamento MUTA os dicionarios do
        inventario. Sem a foto inicial, o relatorio final diria "0 candidatos" logo depois de
        gravar todos eles, apagando a base de comparacao da passada."""
        inv = {"registrados": {"<a>"}, "corpo_pendente": {"<a>": 1}, "sem_keyword": 7,
               "chaves_fiscais": {"9" * 44}, "objetos": {"x.pdf": {"size": 1}}}
        inicial = V._contagens_iniciais(inv)

        inv["corpo_pendente"].pop("<a>")          # o que o processamento faz
        inv["chaves_fiscais"].add("8" * 44)
        inv["objetos"]["novo.pdf"] = {"size": 2}

        self.assertEqual(inicial["corpo_pendente"], 1)
        self.assertEqual(inicial["chaves_fiscais"], 1)
        self.assertEqual(inicial["objetos"], 1)
        self.assertEqual(inicial["sem_keyword"], 7)

    def test_inventario_incompleto_aborta_sem_gravar(self):
        """Decidir o que gravar com um inventario truncado e como a purga apagar o que nao devia:
        a leitura vem TODA antes, e falhar nela encerra o run."""
        with mock.patch.object(V, "_inventario", side_effect=SR.RestError("HTTP 500")), \
             mock.patch.object(R, "_connect_and_search") as conecta:
            self.assertEqual(V.main([]), 1)
        conecta.assert_not_called()


if __name__ == "__main__":
    unittest.main()
