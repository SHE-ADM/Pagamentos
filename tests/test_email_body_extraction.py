"""
Testes de regressao para a extracao pelo corpo do e-mail (read_emails.py).

Cobre o bug em que notificacoes de NF-e/NFS-e (ex.: NFe da Editora Globo)
vazavam para financial_account_control como document_type='outro', porque o caminho de
corpo nao aplicava SKIP_ACCOUNT_TYPES nem a validacao de valor do caminho de PDF.
"""

import sys
import unittest
from pathlib import Path

# O modulo vive em skills/email-reader/scripts/ (diretorio com hifen — nao
# importavel como pacote). Adiciona o caminho ao sys.path, como server/app.py faz.
_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "email-reader" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import read_emails  # noqa: E402


class FakeControl:
    """Stub de SupabaseControl — registra as chamadas em vez de tocar o banco."""

    def __init__(self):
        self.financial_calls = []
        self.error_calls = []
        self.duplicate = False  # simula documento ja existente em financial_account_control

    def register_financial(self, payload):
        self.financial_calls.append(payload)
        return True

    def register_error(self, email_rec, error_type, error_message, raw_payload=None):
        self.error_calls.append((error_type, error_message))
        return True

    def unique_invoice_number(self, base):
        return base

    def financial_duplicate_exists(self, payload):
        return self.duplicate

    def find_financial_duplicate(self, payload):
        # try_extract_from_body usa o id da conta existente na nota de duplicidade.
        return {"id": 999} if self.duplicate else None


# Corpo real (resumido) da notificacao de NF-e da Editora Globo S.A.
# Inclui a chave de acesso de 44 digitos — o que tornava o payload nao-nulo e
# fazia o registro vazar para financial_account_control antes da correcao.
NFE_BODY = (
    "A/C\nCHANG WON AHN,\n\n"
    "Voce esta recebendo, anexada a esta mensagem, a Nota Fiscal Eletronica "
    "numero 22427228, serie 2, emitida pela Editora Globo S.A.\n"
    "Junto com a mercadoria voce recebera tambem um DANFE correspondente a esta NF-e.\n"
    "Chave de acesso NFe 33260504067191000755550020224272281436319068"
)

NFSE_BODY = (
    "Prezado cliente,\n"
    "Segue a Nota Fiscal de Servico Eletronica referente ao mes vigente.\n"
    "NFS-e numero 12345."
)

PIX_BODY = (
    "Nome: Fornecedor Exemplo\n"
    "Valor: R$ 1.250,00\n"
    "Vencimento: 20/06/2026\n"
    "Chave Pix: exemplo@empresa.com.br"
)

# Corpo real (resumido) do caso reportado: o rotulo 'Fornecedor:' e o CNPJ
# estavam no corpo, mas a extracao gravava o e-mail do remetente como fornecedor.
FORNECEDOR_BODY = (
    "Bom dia,\n"
    "Por gentileza fazer o pagamento abaixo:\n\n"
    "Fornecedor: DENAMU\n"
    "CNPJ: 49.575.333/0001-38\n\n"
    "Vencimento: 12/06/2026\n"
    "Valor: R$ 14.390,26\n\n"
    "CHAVE PIX E-MAIL:\n"
    "Denamuembalagems@gmail.com"
)

# Fatura com linha digitavel (boleto, 47 digitos) no corpo.
BOLETO_BODY = (
    "Ola Textil e Confeccoes Otimotex,\n"
    "Este e um lembrete de pagamento da sua fatura.\n"
    "Por gentileza efetuar o pagamento.\n"
    "Linha digitavel: 07790001161205794159807275845787314770000469086\n"
    "Valor: R$ 4.690,86\n"
    "Vencimento: 14/06/2026"
)

# Phishing / notificacao de dinheiro RECEBIDO — nao e conta a pagar.
COMPROVANTE_BODY = (
    "Comprovante de Pix Recebido.\n"
    "Passando aqui pra dizer que o Pix recebido de Joao Roberto Marinho, "
    "foi confirmado no valor de R$ 79.362,50 do Banco do Brasil.\n"
    "comprovante no 264081981410-1981410"
)


class ClassifyBodyDocTypeTest(unittest.TestCase):
    def test_classifica_nfe(self):
        self.assertEqual(read_emails._classify_body_doc_type(NFE_BODY), "nfe")

    def test_classifica_nfse(self):
        # NFS-e (servico) deve ter precedencia sobre NF-e (mercadoria).
        self.assertEqual(read_emails._classify_body_doc_type(NFSE_BODY), "nfse")

    def test_corpo_sem_nota_fiscal_continua_outro(self):
        self.assertEqual(
            read_emails._classify_body_doc_type("Cobranca avulsa sem tipo definido"),
            "outro",
        )

    def test_confeccoes_nao_vira_nfe(self):
        # Regressão (e-mail da RTE): 'nfe' como substring casava "CONFECCOES" e
        # classificava uma FATURA como NF-e (pulada). Agora casa palavra inteira:
        # o destinatário "TEXTIL E CONFECCOES OTIMOTEX" não vira nfe, e o termo
        # 'fatura' do corpo prevalece — gerando conta a pagar.
        body = "Olá TEXTIL E CONFECCOES OTIMOTEX LTDA, aqui está sua fatura 13647248-26"
        self.assertEqual(read_emails._classify_body_doc_type(body), "fatura")

    def test_substring_curta_nao_dispara_tipo_errado(self):
        # 'das' não pode casar "vendas"; 'gru' não pode casar "grupo";
        # 'iss' não pode casar "emissao" — todos viram 'outro'.
        for txt in ("relatorio de vendas", "nosso grupo de clientes", "data de emissao"):
            self.assertEqual(read_emails._classify_body_doc_type(txt), "outro", txt)

    def test_classifica_container(self):
        self.assertEqual(
            read_emails._classify_body_doc_type("Demurrage de contêiner no porto"),
            "container",
        )


class ExtractFromEmailBodyTest(unittest.TestCase):
    def test_nfe_e_classificada_como_nfe(self):
        payload = read_emails.extract_from_email_body(
            NFE_BODY, "2026-06-10T14:23:39+00:00", "<msg-nfe>", "nfe@edglobo.com.br"
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["document_type"], "nfe")

    def test_extrai_fornecedor_e_cnpj_do_corpo(self):
        """Bug reportado: 'Fornecedor:' + CNPJ no corpo nao podem virar sender_email."""
        payload = read_emails.extract_from_email_body(
            FORNECEDOR_BODY, "2026-06-11T10:00:00+00:00", "<msg-forn>",
            "estela@lebianco.com.br",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["supplier_name"], "DENAMU")
        self.assertEqual(payload["supplier_cnpj"], "49575333000138")
        self.assertEqual(payload["amount"], 14390.26)

    def test_rotulo_favorecido_capturado(self):
        body = "Favorecido: ACME SERVICOS LTDA\nValor: R$ 100,00"
        payload = read_emails.extract_from_email_body(
            body, "2026-06-11T10:00:00+00:00", "<msg-fav>", "x@y.com",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["supplier_name"], "ACME SERVICOS LTDA")

    def test_rotulo_nome_sem_separador(self):
        # Caso real (zona azul): "Nome MATEUS JAE WON AHN" — rótulo sem ":"/"-".
        # CRLF + espaço no fim (como o e-mail real): o \r não pode bloquear o $.
        body = "Nome MATEUS JAE WON AHN \r\nValor R$ 19,99"
        payload = read_emails.extract_from_email_body(
            body, "2026-06-17T00:00:00+00:00", "<msg-nome>", "financeiro@otimotex.com.br",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["supplier_name"], "MATEUS JAE WON AHN")
        self.assertEqual(payload["amount"], 19.99)

    def test_rotulos_prestador_e_responsavel(self):
        for label in ("Prestador", "Responsável", "Fornecedor"):
            body = f"{label}: BETA SERVICOS LTDA\nValor R$ 50,00"
            p = read_emails.extract_from_email_body(
                body, "2026-06-17T00:00:00+00:00", f"<msg-{label}>", "x@y.com")
            self.assertEqual(p["supplier_name"], "BETA SERVICOS LTDA", label)

    def test_rotulo_sem_separador_nao_captura_continuacao_de_frase(self):
        # "Responsável pela compra" não pode virar fornecedor "pela compra"
        # (minúsculo → guarda de maiúscula barra). Cai no fallback do remetente.
        body = "Responsável pela compra do mês\nValor R$ 50,00"
        p = read_emails.extract_from_email_body(
            body, "2026-06-17T00:00:00+00:00", "<msg-frase>", "compras@otimotex.com.br")
        self.assertEqual(p["supplier_name"], "compras@otimotex.com.br")

    def test_extrai_barcode_do_corpo(self):
        payload = read_emails.extract_from_email_body(
            BOLETO_BODY, "2026-06-11T10:00:00+00:00", "<msg-bol>",
            "boleto@smartwebservices.com.br",
        )
        self.assertIsNotNone(payload)
        # F2: o corpo agora usa a normalização canônica (extract_pdf.normalize_barcode),
        # igual ao caminho de PDF — a linha digitável de 47 dígitos é convertida para
        # o código de barras de 44 (reordenação FEBRABAN), em vez dos dígitos crus.
        self.assertEqual(payload["barcode"], "07793147700004690860001112057941590727584578")

    def test_comprovante_recebido_retorna_none(self):
        """Comprovante de pix recebido (sem pedido de pagamento) nao e conta a pagar."""
        payload = read_emails.extract_from_email_body(
            COMPROVANTE_BODY, "2026-06-11T10:00:00+00:00", "<msg-comp>",
            "no-reply@phishing.com",
        )
        self.assertIsNone(payload)

    def test_honorarios_vira_tipo_honorarios_e_pix(self):
        """E-mail de honorários (serviços) → document_type 'honorários' + payment 'pix'."""
        body = (
            "Bom dia,\n"
            "Por gentileza fazer o pix dos honorários advocatícios do mês.\n"
            "Valor: R$ 1.500,00\nVencimento: 20/06/2026"
        )
        payload = read_emails.extract_from_email_body(
            body, "2026-06-15T10:00:00+00:00", "<msg-hon>", "adv@escritorio.com.br")
        self.assertIsNotNone(payload)
        self.assertEqual(payload["document_type"], "honorários")
        self.assertEqual(payload["payment_method"], "pix")

    def test_honorarios_sem_mencao_pix_ainda_forca_pix(self):
        """Regra de negócio: honorários sempre paga via pix, mesmo sem citar 'pix'."""
        body = "Cobrança de honorários contábeis referente ao mês. Valor R$ 800,00."
        payload = read_emails.extract_from_email_body(
            body, "2026-06-15T10:00:00+00:00", "<msg-hon2>", "contador@x.com.br")
        self.assertIsNotNone(payload)
        self.assertEqual(payload["document_type"], "honorários")
        self.assertEqual(payload["payment_method"], "pix")

    def test_sem_rotulo_e_sem_documento_usa_sender_email(self):
        """Fallback preservado: sem rotulo, sem CNPJ/CPF e sem sinais, usa o remetente."""
        body = "Pode pagar o pix de R$ 50,00 hoje?"
        payload = read_emails.extract_from_email_body(
            body, "2026-06-11T10:00:00+00:00", "<msg-fb>", "rose@otimotex.com.br",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["supplier_name"], "rose@otimotex.com.br")

    def test_container_vira_tipo_container(self):
        """E-mail de frete/movimentação de container → document_type 'container'."""
        body = "Cobrança de frete de container. Vencimento 20/06/2026. Valor R$ 3.500,00"
        payload = read_emails.extract_from_email_body(
            body, "2026-06-15T10:00:00+00:00", "<msg-cont>", "frete@transp.com.br",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["document_type"], "container")

    def test_nome_pela_assinatura_titulada_tem_prioridade(self):
        """'pix p/ Wesley' + assinatura 'Prof. Wesley S. Paixão' → usa a assinatura."""
        body = (
            "Pfv pode fazer o pix p/ Wesley Ref so honorários dos serviços. "
            "Total R$ 675,00\nAtenciosamente\nProf. Wesley S. Paixão"
        )
        payload = read_emails.extract_from_email_body(
            body, "2026-06-10T10:00:00+00:00", "<msg-wesley>", "rose@otimotex.com.br",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["supplier_name"], "Wesley S. Paixão")
        self.assertEqual(payload["document_type"], "honorários")

    def test_nome_pelo_destinatario_do_pix(self):
        """Sem assinatura: usa o destinatário do pagamento ('p/ <Nome>')."""
        body = "Bom dia, favor pagar o pix para João Silva. Valor R$ 200,00"
        payload = read_emails.extract_from_email_body(
            body, "2026-06-11T10:00:00+00:00", "<msg-joao>", "rose@otimotex.com.br",
        )
        self.assertIsNotNone(payload)
        self.assertEqual(payload["supplier_name"], "João Silva")


class SiegBodyTest(unittest.TestCase):
    """Caso SIEG: o aviso de fatura (link quebrado) é pagável pelo corpo, mas a
    confirmação de pagamento já feito não pode virar conta."""

    FATURA = ("TEXTIL E CONFECÇÕES OTIMOTEX LTDA, Estamos enviando esse e-mail apenas "
              "para lembrar que a cobrança referente a utilização das SOLUÇÕES SIEG no "
              "valor de R$ 426,80 vence hoje. Clique aqui para visualizar a sua fatura.")
    CONFIRMACAO = ("TEXTIL E CONFECÇÕES OTIMOTEX LTDA, Essa mensagem é só para informar "
                   "que identificamos o pagamento da fatura R$ 426,80 vencimento 15/05/2026. "
                   "Mais uma vez, obrigado por escolher a SIEG!")

    def test_fatura_sieg_link_quebrado_extrai_do_corpo(self):
        # 'CONFECÇÕES' não pode mais classificar como nfe; 'fatura' → pagável.
        p = read_emails.extract_from_email_body(
            self.FATURA, "2026-06-16T00:00:00+00:00", "<sieg-fat>", sender_email="financeiro@sieg.com")
        self.assertIsNotNone(p)
        self.assertEqual(p["amount"], 426.80)
        self.assertEqual(p["document_type"], "fatura")

    def test_confirmacao_sieg_nao_gera_conta(self):
        # "identificamos o pagamento" = comprovante de pagamento já feito → None.
        p = read_emails.extract_from_email_body(
            self.CONFIRMACAO, "2026-06-16T00:00:00+00:00", "<sieg-conf>", sender_email="financeiro@sieg.com")
        self.assertIsNone(p)

    def test_lembretes_sieg_do_mesmo_bill_geram_mesmo_numero(self):
        # "Vencimento Próximo" (dia 14) e "Hoje" (dia 15) da MESMA fatura (bill=486729741)
        # devem produzir o MESMO invoice_number (sieg_<bill>) — base p/ a dedup casar e
        # não criar 2 contas/mês. Antes o nº saía de data relativa e divergia.
        link = " Clique aqui <https://app.sieg.com/faturas?bill=486729741&name=TEXTIL>."
        proximo = ("Estamos enviando esse e-mail apenas para lembrar que a cobrança "
                   "das SOLUÇÕES SIEG no valor de R$ 426,80 vence em breve." + link)
        hoje = ("Estamos enviando esse e-mail apenas para lembrar que a cobrança "
                "das SOLUÇÕES SIEG no valor de R$ 426,80 vence hoje." + link)
        p1 = read_emails.extract_from_email_body(proximo, "2026-06-14T00:00:00+00:00", "<sieg-prox>", sender_email="financeiro@sieg.com")
        p2 = read_emails.extract_from_email_body(hoje, "2026-06-15T00:00:00+00:00", "<sieg-hoje>", sender_email="financeiro@sieg.com")
        self.assertEqual(p1["invoice_number"], "sieg_486729741")
        self.assertEqual(p1["invoice_number"], p2["invoice_number"])


class TryExtractFromBodyTest(unittest.TestCase):
    def test_nfe_nao_gera_conta_a_pagar(self):
        """Regressao do bug: NF-e nao pode ser gravada em financial_account_control."""
        ctrl = FakeControl()
        outcome = read_emails.try_extract_from_body(
            {"message_id": "<msg-nfe>"}, NFE_BODY,
            "2026-06-10T14:23:39+00:00", "<msg-nfe>", ctrl,
            sender_email="nfe@edglobo.com.br",
        )
        self.assertEqual(outcome, read_emails.BODY_NONE)
        self.assertEqual(ctrl.financial_calls, [])  # nada gravado
        self.assertEqual(ctrl.error_calls, [])      # skip silencioso, nao e erro

    def test_corpo_sem_valor_anota_motivo_e_nao_grava(self):
        ctrl = FakeControl()
        # Corpo com numero de documento (sinal financeiro) mas sem valor R$.
        body = "Fatura n. 9876 referente ao servico prestado."
        rec = {"message_id": "<msg-sem-valor>"}
        outcome = read_emails.try_extract_from_body(
            rec, body, "2026-06-10T00:00:00+00:00", "<msg-sem-valor>", ctrl,
        )
        self.assertEqual(outcome, read_emails.BODY_NONE)
        self.assertEqual(ctrl.financial_calls, [])
        # O log de erro agora e centralizado em process_message (TODA falha).
        # Aqui a funcao apenas anota o motivo em rec["notes"].
        self.assertEqual(ctrl.error_calls, [])
        self.assertIn("valor", rec["notes"].lower())

    def test_pedido_pix_legitimo_continua_gravando(self):
        """Garante que a correcao nao quebrou o caminho feliz (pagamento PIX)."""
        ctrl = FakeControl()
        outcome = read_emails.try_extract_from_body(
            {"message_id": "<msg-pix>"}, PIX_BODY,
            "2026-06-10T00:00:00+00:00", "<msg-pix>", ctrl,
        )
        self.assertEqual(outcome, read_emails.BODY_CREATED)
        self.assertEqual(len(ctrl.financial_calls), 1)
        self.assertEqual(ctrl.financial_calls[0]["payment_method"], "pix")
        self.assertEqual(ctrl.error_calls, [])

    def test_documento_duplicado_vira_duplicidade(self):
        """Conteudo ja existente no banco (remetente reenviou) nao grava de novo:
        retorna BODY_DUPLICATE e referencia o id da conta existente."""
        ctrl = FakeControl()
        ctrl.duplicate = True  # find_financial_duplicate -> {"id": 999}
        rec = {"message_id": "<msg-pix-2>"}
        outcome = read_emails.try_extract_from_body(
            rec, PIX_BODY,
            "2026-06-10T00:00:00+00:00", "<msg-pix-2>", ctrl,
        )
        self.assertEqual(outcome, read_emails.BODY_DUPLICATE)
        self.assertEqual(rec.get("duplicate_of"), 999)
        self.assertIn("999", rec.get("notes", ""))
        self.assertEqual(ctrl.financial_calls, [])  # nada gravado
        self.assertEqual(ctrl.error_calls, [])      # duplicata e skip, nao erro


if __name__ == "__main__":
    unittest.main()
