"""A RAZÃO SOCIAL da empresa pagadora nunca é o fornecedor (`_finalize_supplier`).

Caso real (contas 1020 e 1474, fatura Leadster; correção de dados na migration 136): o corpo
traz "Empresa: Têxtil E Confecções Otimotex Ltda" — o DESTINATÁRIO da fatura. "empresa" é
rótulo de fornecedor em `_BODY_NAME_RE`, e o nome da pagadora casava por razão social o
cadastro sk 4, que impunha à conta o plano ICMS-ST dele. O mesmo ímã puxou as contas 29, 497
e 978. A exclusão por CNPJ (raiz) já existia; faltava a exclusão por NOME.

Propriedades travadas:

🔴 1. O nome da pagadora extraído do corpo NÃO chega à RPC. Executa `extract_from_email_body`
      + `_finalize_supplier` com o corpo real — não só a função pura.
🔴 2. A guarda cobre as fontes DERIVADAS de nome (assunto ancorado em sigla), não só o nome
      extraído: "FATURAMENTO -- TEXTIL E CONFECCOES OTIMOTEX LTDA".
      ⚠️ Assunto em que a razão social vem PRECEDIDA de texto no mesmo segmento ("Confirmação
      de Títulos TEXTIL E CONFECCOES OTIMOTEX LTDA", conta 160) NÃO é pego: a âncora devolve
      o segmento inteiro e a guarda é de igualdade exata, de propósito.
🔴 3. Igualdade EXATA do nome normalizado — fornecedor que apenas CONTÉM o nome da pagadora
      continua válido.
🔴 4. Ctrl legado sem `company_legal_names` degrada para o comportamento anterior.
🔴 5. `SupabaseControl.company_legal_names` sai da MESMA leitura de `company` que o CNPJ.
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))

import read_emails as R  # noqa: E402

PAGADORA = "TÊXTIL E CONFECÇÕES OTIMOTEX LTDA"
SK_IMA = 4
SK_LEADSTER = 1369
SK_OPHIR = 777
ASSUNTO_1474 = "Leadster | Aqui  está  sua fatura"
REMETENTE_LEADSTER = "financeiro@leadster.com.br"

# Corpo REAL do e-mail 2156 (conta 1474), como gravado em email_control.body_full.
CORPO_1474 = (
    "Leadster \r\n"
    " Geramos sua Fatura 🙂\r\n"
    " Olá, que tudo esteja bem! \r\n"
    " Empresa: Têxtil E Confecções Otimotex Ltda\n"
    " Geramos sua fatura referente ao período de 30/08/2026 a 29/09/2026\n"
    " Confira os detalhes e acesse a fatura no botão abaixo:\r\n"
    " • \r\n"
    " Plano: Growth 3k - Mensal \r\n"
    " • \r\n"
    " Valor: R$ 362,62 \r\n"
    " • \r\n"
    " Confira a data do vencimento de sua fatura clicando no link abaixo!\r\n"
    " Observações:\n"
    " O valor final e o vencimento da fatura podem variar conforme negociação.\n"
    " Caso tenha alguma dúvida ou divergência responda esse e-mail.\r\n"
    " Acesse aqui sua fatura\r\n"
    " WhatsApp: (41) 8817-4969 Falar no WhatsApp\n"
    " E-mail: financeiro@leadster.com.br\n"
    " Rua José Loureiro, 464, Centro, Curitiba - PR / CEP: 80010-000\n"
    " Leadster Tecnologia Ltda"
)


class _RpcCtrl:
    """SupabaseControl mínimo que EMULA a ordem da RPC `resolve_supplier_id` — nome (razão
    social/fantasia) ANTES do e-mail — sobre um cadastro com o ímã (a razão social da pagadora
    no sk 4). `resolve_payloads` registra o que chegou à RPC."""

    def __init__(self, names=None, emails=None, own=(PAGADORA,)):
        self._own = frozenset(R._normalize_company_name(n) for n in own)
        self.names = {R._normalize_company_name(k): v for k, v in (names or {}).items()}
        self.emails = {k.lower(): v for k, v in (emails or {}).items()}
        self.resolve_payloads = []

    def company_legal_names(self):
        return self._own

    def company_cnpj(self):
        return "47273917000123"

    def find_supplier_by_email(self, email):
        return None

    def resolve_supplier(self, payload):
        self.resolve_payloads.append(dict(payload))
        name = R._normalize_company_name(payload.get("supplier_name"))
        if name and name in self.names:
            return self.names[name]
        return self.emails.get((payload.get("sender_email") or "").lower())

    def supplier_defaults(self, sk_supplier):
        return (0, 0)


# Cadastro como estava no dia do defeito, MAIS o e-mail da Leadster no cadastro certo (estado
# pós-136). Com a guarda, o nome da pagadora não é consultado e o e-mail decide.
_NOMES = {PAGADORA: SK_IMA, "LEBIANCO": SK_IMA, "Leadster": SK_LEADSTER}
_EMAILS = {REMETENTE_LEADSTER: SK_LEADSTER, "controladoria@ophir.com.br": SK_OPHIR}


class NormalizacaoTest(unittest.TestCase):

    def test_acento_caixa_pontuacao_e_sigla_nao_distinguem_a_mesma_razao_social(self):
        esperado = "textil e confeccoes otimotex"
        for variante in (PAGADORA, "Têxtil E Confecções Otimotex Ltda",
                         "TEXTIL E CONFECCOES OTIMOTEX LTDA.", "textil e confeccoes otimotex",
                         "TEXTIL E CONFECCOES OTIMOTEX S/A", "Textil e Confeccoes Otimotex S.A."):
            with self.subTest(variante=variante):
                self.assertEqual(R._normalize_company_name(variante), esperado)

    def test_vazio_nunca_casa(self):
        # Sanidade do parser: um normalizador que devolvesse '' para tudo tornaria a guarda
        # verdadeira para qualquer nome (ou falsa para todos) — o caso vazio fica explícito.
        self.assertEqual(R._normalize_company_name(None), "")
        self.assertEqual(R._normalize_company_name(" LTDA "), "")
        self.assertFalse(R._is_own_company_name("", frozenset({""})))
        self.assertFalse(R._is_own_company_name("LTDA", frozenset({""})))

    def test_so_igualdade_exata_nome_que_contem_a_pagadora_segue_valido(self):
        own = frozenset({R._normalize_company_name(PAGADORA)})
        self.assertTrue(R._is_own_company_name("Têxtil e Confecções Otimotex", own))
        for fornecedor in ("OTIMOTEX", "OTIMOTEX TRANSPORTES LTDA",
                           "TEXTIL E CONFECCOES OTIMOTEX FILIAL NORTE LTDA", "LEBIANCO"):
            with self.subTest(fornecedor=fornecedor):
                self.assertFalse(R._is_own_company_name(fornecedor, own))


class FinalizeSupplierExecutadoTest(unittest.TestCase):

    def test_nome_da_pagadora_extraido_do_corpo_nao_decide_o_fornecedor(self):
        payload = R.extract_from_email_body(CORPO_1474, "2026-09-14T10:57:10+00:00",
                                            "<leadster-1474@local>", REMETENTE_LEADSTER,
                                            subject=ASSUNTO_1474)
        # Anti-vacuidade: o cenário reproduz a ENTRADA do defeito — o extrator do corpo
        # entrega a razão social da pagadora como fornecedor. Se isto mudar, o teste abaixo
        # passaria sem exercitar a guarda.
        self.assertEqual(R._normalize_company_name(payload["supplier_name"]),
                         R._normalize_company_name(PAGADORA))
        payload["sender_email"] = REMETENTE_LEADSTER
        payload["subject"] = ASSUNTO_1474
        ctrl = _RpcCtrl(names=_NOMES, emails=_EMAILS)

        self.assertTrue(R._finalize_supplier(ctrl, payload, CORPO_1474))

        self.assertEqual(payload["sk_supplier"], SK_LEADSTER)
        self.assertTrue(ctrl.resolve_payloads, "a RPC precisa ter sido consultada")
        for enviado in ctrl.resolve_payloads:
            self.assertFalse(
                R._is_own_company_name(enviado.get("supplier_name"), ctrl.company_legal_names()),
                f"a razão social da pagadora chegou à RPC: {enviado.get('supplier_name')!r}")

    def test_nome_da_pagadora_no_assunto_ancorado_nao_vira_fornecedor(self):
        assunto = "ENC: FATURAMENTO -- TEXTIL E CONFECCOES OTIMOTEX LTDA 03/07/2026"
        # Anti-vacuidade: a âncora de sigla do assunto É a pagadora — é o caminho exercitado.
        self.assertEqual(R._normalize_company_name(R._supplier_name_by_legal_suffix(assunto)),
                         R._normalize_company_name(PAGADORA))
        payload = {"supplier_name": None, "supplier_cnpj": None, "supplier_cpf": None,
                   "subject": assunto, "sender_email": "controladoria@ophir.com.br",
                   "document_type": "outro"}
        ctrl = _RpcCtrl(names=_NOMES, emails=_EMAILS)

        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))

        self.assertEqual(payload["sk_supplier"], SK_OPHIR)
        for enviado in ctrl.resolve_payloads:
            self.assertFalse(
                R._is_own_company_name(enviado.get("supplier_name"), ctrl.company_legal_names()))

    def test_fornecedor_real_extraido_segue_intacto(self):
        # NÃO REGREDIR: a guarda só remove a pagadora; um nome real vai à RPC como antes.
        payload = {"supplier_name": "Leadster", "subject": ASSUNTO_1474,
                   "sender_email": REMETENTE_LEADSTER, "document_type": "fatura"}
        ctrl = _RpcCtrl(names=_NOMES, emails=_EMAILS)

        self.assertTrue(R._finalize_supplier(ctrl, payload, ""))

        self.assertEqual(payload["sk_supplier"], SK_LEADSTER)
        self.assertEqual(ctrl.resolve_payloads[0]["supplier_name"], "Leadster")


class CtrlDegradadoTest(unittest.TestCase):

    def test_ctrl_sem_o_metodo_devolve_conjunto_vazio(self):
        self.assertEqual(R._own_company_names(object()), frozenset())

    def test_falha_ao_ler_as_razoes_sociais_e_logada_e_nao_derruba(self):
        class _Quebrado:
            def company_legal_names(self):
                raise RuntimeError("rede fora")

        with self.assertLogs(R.log, level="ERROR"):
            self.assertEqual(R._own_company_names(_Quebrado()), frozenset())


class SupabaseControlRazaoSocialTest(unittest.TestCase):

    def _ctrl(self, rows):
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl.base, ctrl.key, ctrl.headers, ctrl._available = "https://x", "k", {}, True
        resposta = mock.MagicMock()
        resposta.read.return_value = json.dumps(rows).encode()
        cm = mock.MagicMock()
        cm.__enter__.return_value = resposta
        return ctrl, mock.patch.object(R.urllib.request, "urlopen", return_value=cm)

    def test_razao_social_vem_da_mesma_leitura_e_inclui_empresa_sem_cnpj(self):
        ctrl, alvo = self._ctrl([
            {"sk_company": 1, "cnpj": "47273917000123", "legal_name": PAGADORA},
            {"sk_company": 5, "cnpj": None, "legal_name": "EMPRESA SEM CNPJ LTDA"},
            {"sk_company": 6, "cnpj": "11111111000111", "legal_name": None},
        ])
        with alvo as m:
            nomes = ctrl.company_legal_names()
            self.assertEqual(ctrl.company_cnpj(), "47273917000123")
            self.assertEqual(m.call_count, 1, "CNPJ e razão social saem de UMA leitura")
            self.assertIn("legal_name", m.call_args.args[0].full_url)
        self.assertEqual(nomes, frozenset({"textil e confeccoes otimotex", "empresa sem cnpj"}))

    def test_supabase_indisponivel_devolve_vazio(self):
        ctrl = R.SupabaseControl.__new__(R.SupabaseControl)
        ctrl.base, ctrl.key, ctrl.headers, ctrl._available = "https://x", "k", {}, True
        with mock.patch.object(R.urllib.request, "urlopen", side_effect=OSError("rede fora")):
            self.assertEqual(ctrl.company_legal_names(), frozenset())


if __name__ == "__main__":
    unittest.main()
