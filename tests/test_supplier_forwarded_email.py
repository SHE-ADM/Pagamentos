"""Roteamento de fornecedor pelo E-MAIL do remetente ORIGINAL de um bloco ENCAMINHADO
(fallback 1b de `_finalize_supplier`, migration 134).

Caso real (conta id 1101): o despachante manda a guia da Junta Comercial de Mato Grosso
para a funcionária, que a encaminha internamente. O PDF de guia de arrecadação NÃO traz
favorecido, o remetente imediato é interno (bloqueado como fornecedor desde a 046), e o
único sinal do credor real é o "De:" do bloco encaminhado. Sem este fallback a conta caía
na Regra de IMPOSTO e era gravada sob a própria OTIMOTEX, herdando a classificação
contábil default dela (Recursos Humanos / Festas e Confraternizações) numa guia da Junta.

Três propriedades que estes testes existem para travar:

🔴 1. O fallback roda ANTES da Regra de IMPOSTO. Ela faz `return True` INCONDICIONAL,
      então qualquer coisa depois dela é inalcançável para guia de tributo sem favorecido
      — exatamente o caso a resolver.
🔴 2. Ele só IDENTIFICA fornecedor já cadastrado, NUNCA cria. O endereço diz quem MANDOU
      o documento, não quem RECEBE o pagamento, e qualquer pessoa pode encaminhar uma
      guia. Trocar `find_supplier_by_email` por `resolve_supplier` compila e passa no
      caminho feliz, mas faria cada encaminhador virar fornecedor no primeiro e-mail.
🔴 3. O CALL SITE do caminho de PDF passa `body_text`. Sem isso a mudança compila e fica
      MORTA em produção — que é exatamente o estado em que o fallback 3 (por NOME) está,
      porque ele lê `payload['email_body_excerpt']`, coluna que o caminho de anexo nunca
      povoa.
"""

import csv
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import read_emails as R  # noqa: E402

SK_DESPACHANTE = 1262
EMAIL_DESPACHANTE = "ricardo.advogado@yahoo.com.br"

# Corpo REAL do e-mail da conta 1101 (email_control id 1573).
CORPO_1101 = (
    "De: JOSE RICARDO PRUDENTE <ricardo.advogado@yahoo.com.br> \r\n"
    "Enviada em: terça-feira, 18 de agosto de 2026 13:13\r\n"
    "Para: Bárbara <barbara@otimotex.com.br>\r\n"
    "Assunto: R. A UTILIDADES E ACESSORIOS LTDA - 52.595.513/0001-96\r\n"
)


class _FakeCtrl:
    """SupabaseControl mínimo. `cadastrados` mapeia e-mail → sk_supplier (o que a RPC
    find_supplier_by_email devolveria). `resolve_calls` prova o curto-circuito: se ele
    for > 0 no caminho do encaminhador, alguém trocou a consulta pura pela que CRIA."""

    def __init__(self, cadastrados=None, defaults=(14, 116)):
        self.cadastrados = cadastrados or {}
        self.defaults = defaults
        self.resolve_calls = 0
        self.lookup_calls = []
        self.last_payload = None

    def find_supplier_by_email(self, email):
        self.lookup_calls.append(email)
        return self.cadastrados.get((email or "").lower())

    def resolve_supplier(self, payload):
        self.resolve_calls += 1
        self.last_payload = dict(payload)
        name = (payload.get("supplier_name") or "").strip()
        cnpj = (payload.get("supplier_cnpj") or "").strip()
        cpf = (payload.get("supplier_cpf") or "").strip()
        return 12345 if (name or cnpj or cpf) else None

    def supplier_defaults(self, sk_supplier):
        return self.defaults


class _LegacyCtrl(_FakeCtrl):
    """Ctrl SEM o método novo — o pipeline tem de degradar, não estourar."""

    find_supplier_by_email = None

    def __getattr__(self, name):
        if name == "find_supplier_by_email":
            raise AttributeError(name)
        raise AttributeError(name)


class ForwardedSenderEmailTest(unittest.TestCase):
    """A extração do endereço em si."""

    def test_extrai_o_email_do_bloco_encaminhado(self):
        self.assertEqual(R._forwarded_sender_email(CORPO_1101), EMAIL_DESPACHANTE)

    def test_usa_o_de_mais_profundo_da_cadeia(self):
        """🔴 Mutante: trocar `reversed(...)` pela 1ª ocorrência — passaria a devolver o
        intermediário (o mais raso), não quem originou a cobrança."""
        corpo = (
            "De: Intermediario Repassador <repasse@intermediario.com>\n"
            "Assunto: Fwd: guia\n"
            "De: Credor Original <credor@original.com.br>\n"
            "Assunto: guia\n"
        )
        self.assertEqual(R._forwarded_sender_email(corpo), "credor@original.com.br")

    def test_ignora_de_de_dominio_interno(self):
        """🔴 Mutante: remover o filtro `_INTERNAL_EMAIL_DOMAINS` — o funcionário que
        encaminhou viraria o credor."""
        for dominio in ("otimotex.com.br", "lebianco.com.br"):
            corpo = f"De: Barbara <barbara@{dominio}>\nAssunto: boleto\n"
            self.assertIsNone(R._forwarded_sender_email(corpo), dominio)

    def test_pula_o_interno_e_alcanca_o_externo_abaixo(self):
        corpo = (
            "De: Fornecedor <cobranca@fornecedor.com.br>\n"
            "De: Eunice <eunice@otimotex.com.br>\n"
        )
        self.assertEqual(R._forwarded_sender_email(corpo), "cobranca@fornecedor.com.br")

    def test_normaliza_para_minusculas(self):
        corpo = "De: Fulano <Fulano.SOBRENOME@Exemplo.COM.BR>\n"
        self.assertEqual(R._forwarded_sender_email(corpo), "fulano.sobrenome@exemplo.com.br")

    def test_sem_corpo_ou_sem_linha_de(self):
        for corpo in (None, "", "   ", "corpo sem cabecalho de encaminhamento nenhum"):
            self.assertIsNone(R._forwarded_sender_email(corpo), repr(corpo))

    def test_linha_de_sem_endereco(self):
        self.assertIsNone(R._forwarded_sender_email("De: Fulano de Tal\nAssunto: x\n"))


class FinalizeSupplierForwardedTest(unittest.TestCase):
    """O fallback 1b dentro de `_finalize_supplier`."""

    def _payload_1101(self):
        """Payload equivalente ao da conta 1101: guia DAR / DARE, sem favorecido."""
        return {
            "amount": "51.00",
            "document_type": "dar / dare",
            "subject": "boleto: R. A UTILIDADES E ACESSORIOS LTDA - 52.595.513/0001-96",
            "payer_name": "TEXTIL E CONFECÇÕES OTIMOTEX LTDA",
            "payer_cnpj": "47273917000123",
        }

    def test_guia_encaminhada_por_email_cadastrado_resolve_o_fornecedor(self):
        """🔴 O caso 1101. Mutante: mover o bloco para DEPOIS da Regra de IMPOSTO — o
        `return True` incondicional dela torna o bloco inalcançável e o sk vira 1."""
        ctrl = _FakeCtrl({EMAIL_DESPACHANTE: SK_DESPACHANTE}, defaults=(14, 116))
        payload = self._payload_1101()

        self.assertTrue(R._finalize_supplier(ctrl, payload, CORPO_1101))

        self.assertEqual(payload["sk_supplier"], SK_DESPACHANTE)
        self.assertEqual(payload["cost_center_id"], 14)
        self.assertEqual(payload["chart_account_id"], 116)
        # 🔴 nunca passou pela resolução que CRIA fornecedor.
        self.assertEqual(ctrl.resolve_calls, 0)
        # e não sobrou nome/CNPJ denormalizado no payload.
        for col in ("supplier_name", "supplier_cnpj", "supplier_cpf"):
            self.assertNotIn(col, payload)

    def test_email_nao_cadastrado_nao_cria_fornecedor_e_cai_na_regra_de_imposto(self):
        """🔴 A propriedade central. Mutante: trocar `find_supplier_by_email` por
        `resolve_supplier` — nasceria o fornecedor "JOSE RICARDO PRUDENTE"."""
        ctrl = _FakeCtrl(cadastrados={})  # ninguém cadastrado
        payload = self._payload_1101()

        self.assertTrue(R._finalize_supplier(ctrl, payload, CORPO_1101))

        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.resolve_calls, 0)
        # o lookup FOI consultado (anti-vacuidade: o bloco rodou e recusou)
        self.assertEqual(ctrl.lookup_calls, [EMAIL_DESPACHANTE])

    def test_favorecido_real_extraido_vence_o_encaminhador(self):
        """🔴 Mutante: remover a guarda `if not has_real_supplier` — o encaminhador
        passaria por cima do favorecido impresso no documento."""
        ctrl = _FakeCtrl({EMAIL_DESPACHANTE: SK_DESPACHANTE})
        payload = self._payload_1101()
        payload["supplier_name"] = "PREFEITURA DO MUNICIPIO DE SAO PAULO"

        self.assertTrue(R._finalize_supplier(ctrl, payload, CORPO_1101))

        self.assertEqual(payload["sk_supplier"], 12345)   # resolvido pelo nome real
        self.assertEqual(ctrl.lookup_calls, [])           # nem consultou o encaminhador

    def test_sem_corpo_o_comportamento_e_o_de_antes(self):
        ctrl = _FakeCtrl({EMAIL_DESPACHANTE: SK_DESPACHANTE})
        payload = self._payload_1101()

        self.assertTrue(R._finalize_supplier(ctrl, payload))  # sem body_text

        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)

    def test_encaminhador_interno_nao_identifica(self):
        ctrl = _FakeCtrl({"barbara@otimotex.com.br": 999})
        payload = self._payload_1101()
        corpo = "De: Bárbara <barbara@otimotex.com.br>\nAssunto: boleto\n"

        self.assertTrue(R._finalize_supplier(ctrl, payload, corpo))

        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)
        self.assertEqual(ctrl.lookup_calls, [])

    def test_ctrl_sem_o_metodo_nao_quebra(self):
        """🔴 Mutante: chamar `ctrl.find_supplier_by_email(...)` direto, sem getattr —
        AttributeError no meio da gravação da conta."""
        ctrl = _LegacyCtrl()
        payload = self._payload_1101()

        self.assertTrue(R._finalize_supplier(ctrl, payload, CORPO_1101))

        self.assertEqual(payload["sk_supplier"], R.OTIMOTEX_SK_SUPPLIER)

    def test_boleto_comum_sem_ancora_no_assunto_usa_o_encaminhador(self):
        """O fallback não é exclusivo de guia: vale para qualquer documento sem
        favorecido extraído — desde que o assunto não tenha âncora própria."""
        ctrl = _FakeCtrl({"cobranca@fornecedor.com.br": 777}, defaults=(5, 50))
        payload = {"amount": "100.00", "document_type": "boleto", "subject": "boleto"}
        corpo = "De: Fornecedor <cobranca@fornecedor.com.br>\n"

        self.assertTrue(R._finalize_supplier(ctrl, payload, corpo))

        self.assertEqual(payload["sk_supplier"], 777)
        self.assertEqual(ctrl.resolve_calls, 0)

    def test_assunto_ancorado_em_sigla_vence_o_encaminhador_em_NAO_tributo(self):
        """🔴 A LIÇÃO DA CONTA 401, que o fallback 1b não pode regredir.

        Rodar antes da Regra de IMPOSTO significa rodar antes do fallback 2 (assunto
        ancorado em sigla). Sem a guarda, um INTERMEDIÁRIO cadastrado venceria um assunto
        já correto — "FATURAMENTO -- MOVVI LOGISTICA LTDA" viraria conta do repassador,
        em silêncio. Pior que o bug original, que ao menos falhava de forma óbvia.

        Mutante: remover `or not _subject_has_anchor` da guarda do bloco 1b."""
        ctrl = _FakeCtrl({"repasse@intermediario.com.br": 888}, defaults=(9, 61))
        payload = {
            "amount": "1200.00", "document_type": "boleto",
            "subject": "FATURAMENTO -- MOVVI LOGISTICA LTDA",
        }
        corpo = "De: Intermediario Repassador <repasse@intermediario.com.br>\n"

        self.assertTrue(R._finalize_supplier(ctrl, payload, corpo))

        # resolvido pelo ASSUNTO (fallback 2 → resolve_supplier), não pelo encaminhador
        self.assertEqual(payload["sk_supplier"], 12345)
        self.assertNotEqual(payload["sk_supplier"], 888)
        self.assertEqual(ctrl.lookup_calls, [], "o encaminhador nem deveria ser consultado")
        self.assertEqual(ctrl.last_payload["supplier_name"], "MOVVI LOGISTICA LTDA")

    def test_em_GUIA_o_encaminhador_vence_o_assunto_ancorado(self):
        """O outro lado da mesma guarda — e é o caso 1101, cujo assunto TEM sigla
        ("R. A UTILIDADES E ACESSORIOS LTDA", que é a empresa do processo, não o credor).

        Em guia de tributo o assunto NUNCA foi fonte: a Regra de IMPOSTO o curto-circuita
        de propósito, porque assunto de guia produz fornecedor-lixo ("IMPOSTOS"). Logo o
        1b não tira precedência de ninguém — ele concorre com "OTIMOTEX".

        Mutante: exigir `not _subject_has_anchor` também para tributo → a 1101 volta a
        cair na OTIMOTEX, que é exatamente o defeito relatado."""
        ctrl = _FakeCtrl({EMAIL_DESPACHANTE: SK_DESPACHANTE}, defaults=(14, 116))
        payload = self._payload_1101()
        self.assertIn("LTDA", payload["subject"], "sanidade: o assunto tem âncora de sigla")

        self.assertTrue(R._finalize_supplier(ctrl, payload, CORPO_1101))

        self.assertEqual(payload["sk_supplier"], SK_DESPACHANTE)


class PdfCallSiteTest(unittest.TestCase):
    """🔴 O call site EXECUTADO. Guarda por texto não cobre o que este teste cobre:
    ela prova que a chamada existe, não que o argumento chega. Sem este caso, remover
    `body_text` de `_finalize_supplier(ctrl, payload, body_text)` na linha do caminho de
    PDF passaria em TODOS os outros testes deste arquivo."""

    CSV_ROW = {
        "amount": "51.00",
        "document_type": "DAR MODELO 1",
        "due_date": "2026-09-17",
        "source_file": "guia_junta_comercial.pdf",
        "payer_name": "TEXTIL E CONFECÇÕES OTIMOTEX LTDA",
        "payer_cnpj": "47273917000123",
        "extraction_source": "pdf_text",
        "barcode": "858000000003510001232028609174546035380374231904",
        "description": "SERV.REG.COMERCIO JUCEMAT-CAPITAL",
    }

    class _Ctrl(_FakeCtrl):
        """Acrescenta o mínimo que `extract_and_store_accounts` consome."""

        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self.gravadas = []
            self.erros = []

        def company_cnpj(self):
            return "47273917000123"

        def payer_cnpjs(self):
            return ["47273917000123"]

        def find_financial_duplicate(self, payload):
            return None

        def insert_financial_account(self, payload):
            self.gravadas.append(dict(payload))
            return 1

        def resolve_user(self, sender_email):
            return None

        def supplier_contact_writeback(self, *a, **kw):
            return None

        def update_supplier_classification(self, *a, **kw):
            return None

        def register_error(self, *a, **kw):
            self.erros.append((a, kw))
            return None

        def upload_attachment(self, *a, **kw):
            return None

        def register_attachment(self, *a, **kw):
            return None

        def __getattr__(self, name):
            # Qualquer outro método do SupabaseControl que o caminho toque vira no-op —
            # o que está sob teste é o REPASSE do corpo, não a persistência.
            if name.startswith("_"):
                raise AttributeError(name)
            return lambda *a, **kw: None

    def test_call_site_do_pdf_passa_o_corpo(self):
        ctrl = self._Ctrl({EMAIL_DESPACHANTE: SK_DESPACHANTE}, defaults=(14, 116))
        capturado = {}

        real_finalize = R._finalize_supplier

        def espiao(c, payload, body_text=""):
            capturado["body_text"] = body_text
            capturado["sk_supplier"] = None
            ok = real_finalize(c, payload, body_text)
            capturado["sk_supplier"] = payload.get("sk_supplier")
            return ok

        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "extracao.csv"
            with csv_path.open("w", encoding="utf-8", newline="") as fh:
                # delimiter=";" — o mesmo de `read_extraction_csv` no pipeline.
                w = csv.DictWriter(fh, fieldnames=list(self.CSV_ROW), delimiter=";")
                w.writeheader()
                w.writerow(self.CSV_ROW)

            pdf_path = Path(tmp) / "guia_junta_comercial.pdf"
            pdf_path.write_bytes(b"%PDF-1.4\n")   # so precisa existir para o .stat()

            with mock.patch.object(R, "_finalize_supplier", espiao), \
                 mock.patch.object(R, "run_extraction", return_value=(str(csv_path), None)), \
                 mock.patch.object(R, "_attachment_text", return_value=""), \
                 mock.patch.object(R, "_register_fiscal_documents", return_value=None):
                R.extract_and_store_accounts(
                    [pdf_path], "<msg-call-site>", ctrl, email_rec={},
                    body_text=CORPO_1101,
                )

        self.assertIn("body_text", capturado,
                      "_finalize_supplier não foi chamado — o teste não provou nada")
        self.assertEqual(capturado["body_text"], CORPO_1101,
                         "o call site do caminho de PDF não repassou body_text — o "
                         "fallback 1b nasceria MORTO em produção")
        # E o efeito de ponta a ponta: a conta nasce sob o despachante, não sob a OTIMOTEX.
        self.assertEqual(capturado["sk_supplier"], SK_DESPACHANTE)

    def test_pdf_nao_passa_a_gravar_email_body_excerpt(self):
        """O corpo viaja por PARÂMETRO, nunca pelo payload: povoar
        `email_body_excerpt` no caminho de anexo faria `apply_contact_writeback`
        escrever contato no cadastro do fornecedor.

        🔴 A asserção observa a CONSEQUÊNCIA, não só a ausência da chave: um
        `assertNotIn` sozinho é trivialmente verdadeiro (nenhum caminho jamais escreveu
        essa coluna) e passaria com o fallback 1b inteiro removido. Aqui o corpo carrega
        um telefone e uma chave PIX, e o que se prova é que `apply_contact_writeback`
        rodou e NÃO os gravou no cadastro — porque não enxerga o corpo neste caminho.

        Mutante: em `_finalize_supplier`, gravar `payload["email_body_excerpt"] =
        body_text` — o writeback passa a ver o corpo e grava o contato do DESPACHANTE."""
        ctrl = _FakeCtrl({EMAIL_DESPACHANTE: SK_DESPACHANTE})
        gravados = []
        ctrl.company_cnpj = lambda: "47273917000123"
        ctrl.update_supplier_contact = lambda *a, **kw: gravados.append((a, kw))

        corpo = CORPO_1101 + "Telefone: (37) 3249-4200\nChave PIX: 04986533000131\n"
        payload = {"amount": "51.00", "document_type": "dar / dare"}

        R._finalize_supplier(ctrl, payload, corpo)
        self.assertEqual(payload["sk_supplier"], SK_DESPACHANTE,
                         "sanidade: o 1b resolveu — sem isso o writeback nem rodaria")
        self.assertNotIn("email_body_excerpt", payload)

        # o writeback roda logo em seguida no pipeline real, SEM o corpo
        R.apply_contact_writeback(ctrl, payload)
        self.assertEqual(gravados, [],
                         "o corpo vazou para o writeback e gravou contato no cadastro")

        # ANTI-VACUIDADE: com o corpo passado explicitamente (o caminho de CORPO, onde
        # isso É desejado), o mesmo texto GRAVA — logo o teste acima não passa por
        # inércia de um detector que nunca dispara.
        R.apply_contact_writeback(ctrl, payload, extra_text=corpo)
        self.assertTrue(gravados, "sanidade: o detector de contato não disparou nem com "
                                  "o corpo explícito — o oráculo do teste está quebrado")


if __name__ == "__main__":
    unittest.main()
