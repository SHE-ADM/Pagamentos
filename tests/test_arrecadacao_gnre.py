"""
Testes das duas regras de GUIA DE ARRECADACAO (GNRE/DARE/DARF/GARE/DAM):

  1. VALOR = "Total a Recolher" (principal + atualizacao + juros + multa), lido do CODIGO
     DE BARRAS, e nao o "Valor Principal" que o LLM copia do lado. O emissor codifica o
     total nas posicoes 5-15 do codigo de arrecadacao.
  2. VENCIMENTO = "Documento Valido para pagamento" (data-limite), e nao "Data de
     Vencimento" (que numa guia e o vencimento do TRIBUTO, ja passado).

Caso de origem: 27 das 31 GNRE gravadas A MENOR (R$ 297,17 no total) e 31 das 32 com
vencimento ANTERIOR a propria emissao — nascendo "vencidas".
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

import extract_pdf as E   # noqa: E402
import febraban as F      # noqa: E402

# Linha digitavel REAL da GNRE do id 773 (a da imagem): PR, R$ 47,51 de total a recolher,
# "Valor Principal" impresso de R$ 47,04 e juros de R$ 0,47.
GNRE_773 = "858800000008475100902623120120260736170318519000"
GNRE_773_TOTAL = 47.51
GNRE_773_PRINCIPAL = 47.04

# Boleto bancario comum (Campinense) — NAO e arrecadacao; nenhuma regra daqui se aplica.
BOLETO_BANCARIO = "23792152400000502400289090000010602503122940"


class Arrecadacao44Test(unittest.TestCase):
    def test_linha_digitavel_48_vira_44_sem_os_dv_de_bloco(self):
        d44 = F.arrecadacao_44(GNRE_773)
        self.assertEqual(len(d44), 44)
        self.assertTrue(d44.startswith("8"))
        self.assertEqual(d44[2], "8")          # id_valor 8 = efetivo, DV modulo 11

    def test_44_e_aceito_direto(self):
        d44 = F.arrecadacao_44(GNRE_773)
        self.assertEqual(F.arrecadacao_44(d44), d44)

    def test_boleto_bancario_nao_e_arrecadacao(self):
        self.assertIsNone(F.arrecadacao_44(BOLETO_BANCARIO))

    def test_comprimento_invalido_e_vazio(self):
        self.assertIsNone(F.arrecadacao_44("8" * 40))
        self.assertIsNone(F.arrecadacao_44(""))
        self.assertIsNone(F.arrecadacao_44(None))

    def test_com_separadores(self):
        formatado = "85880000000-8 47510090262-3 12012026073-6 17031851900-0"
        self.assertEqual(F.arrecadacao_44(formatado), F.arrecadacao_44(GNRE_773))


class ArrecadacaoDvTest(unittest.TestCase):
    def test_barcode_real_nao_e_refutado(self):
        self.assertFalse(F.arrecadacao_dv_refuted(GNRE_773))

    def test_dv_DISCRIMINA_corrupcao(self):
        # Uma funcao que nunca refuta passaria no teste acima. Esta prova que ela decide:
        # corrompendo 1 digito por vez, a maioria esmagadora e pega (modulo 11 nao pega
        # 100% por natureza). Medido: 380/432.
        pego = total = 0
        for i in range(len(GNRE_773)):
            for novo in "0123456789":
                if novo == GNRE_773[i]:
                    continue
                total += 1
                if F.arrecadacao_dv_refuted(GNRE_773[:i] + novo + GNRE_773[i + 1:]):
                    pego += 1
        self.assertGreater(pego / total, 0.80, f"DV pegou so {pego}/{total}")

    def test_nao_refuta_o_que_nao_e_arrecadacao(self):
        # Semantica do nome: False = "nao ha o que refutar", nunca "valido".
        self.assertFalse(F.arrecadacao_dv_refuted(BOLETO_BANCARIO))
        self.assertFalse(F.arrecadacao_dv_refuted(None))


def _com_id_valor(barcode: str, id_valor: str) -> str:
    """Mesmo codigo, com outro `id_valor` e o DV GERAL RECALCULADO para conferir.

    Sem recalcular o DV, trocar o id_valor produz um codigo que o DV ja refuta — e um
    teste da guarda de REFERENCIA passaria pelo motivo errado (foi o que aconteceu: o
    mutante que remove a guarda nao era pego). O DV e achado por tentativa usando
    `arrecadacao_dv_refuted`, que e outra funcao e ja tem validacao propria (discriminacao
    + 31/31 dos barcodes reais)."""
    d44 = F.arrecadacao_44(barcode)
    for dv in "0123456789":
        cand = d44[:2] + id_valor + dv + d44[4:]
        if not F.arrecadacao_dv_refuted(cand):
            return cand
    raise AssertionError("nenhum DV fecha — helper do teste esta errado")


class AmountFromArrecadacaoTest(unittest.TestCase):
    def test_extrai_o_total_a_recolher(self):
        self.assertAlmostEqual(F.amount_from_arrecadacao(GNRE_773), GNRE_773_TOTAL, places=2)

    def test_valor_de_REFERENCIA_nao_vira_dinheiro(self):
        # id_valor 7/9 = valor de REFERENCIA (identificador: contrato, matricula,
        # competencia) — NAO e dinheiro. Gravar isso poria um numero arbitrario e enorme
        # como valor da conta. O codigo aqui tem DV VALIDO, entao o unico motivo possivel
        # para o None e a guarda de referencia.
        for id_valor in ("7", "9"):
            ref = _com_id_valor(GNRE_773, id_valor)
            self.assertFalse(F.arrecadacao_dv_refuted(ref), f"fixture id={id_valor} sem DV valido")
            self.assertIsNone(F.amount_from_arrecadacao(ref), f"id_valor={id_valor}")

    def test_valor_EFETIVO_nos_dois_modulos_entrega(self):
        # Contraprova: com DV valido, 6 (mod 10) e 8 (mod 11) entregam o valor. Sem ela,
        # o teste acima passaria mesmo que a funcao nunca entregasse nada.
        for id_valor in ("6", "8"):
            efetivo = _com_id_valor(GNRE_773, id_valor)
            self.assertAlmostEqual(F.amount_from_arrecadacao(efetivo), GNRE_773_TOTAL,
                                   places=2, msg=f"id_valor={id_valor}")

    def test_dv_refutado_nao_entrega_valor(self):
        # Barcode corrompido por OCR nao pode sobrescrever um valor lido corretamente.
        corrompido = GNRE_773[:20] + ("9" if GNRE_773[20] != "9" else "1") + GNRE_773[21:]
        if F.arrecadacao_dv_refuted(corrompido):
            self.assertIsNone(F.amount_from_arrecadacao(corrompido))

    def test_boleto_bancario_nao_responde(self):
        self.assertIsNone(F.amount_from_arrecadacao(BOLETO_BANCARIO))


class ApplyArrecadacaoAmountTest(unittest.TestCase):
    def test_sobrescreve_o_valor_principal_pelo_total(self):
        rec = {"barcode": GNRE_773, "amount": GNRE_773_PRINCIPAL, "document_type": "gnre"}
        self.assertTrue(E.apply_arrecadacao_amount(rec))
        self.assertAlmostEqual(rec["amount"], GNRE_773_TOTAL, places=2)
        self.assertIn("total a recolher", rec["processing_notes"].lower())

    def test_amount_charged_acompanha(self):
        # amount_charged e derivado; deixar o antigo criaria "documento" != "cobrado".
        rec = {"barcode": GNRE_773, "amount": GNRE_773_PRINCIPAL,
               "amount_charged": GNRE_773_PRINCIPAL}
        E.apply_arrecadacao_amount(rec)
        self.assertAlmostEqual(rec["amount_charged"], GNRE_773_TOTAL, places=2)

    def test_NAO_soma_os_juros_duas_vezes(self):
        # 🔴 Os juros ja estao DENTRO do total do barcode. Recalcular amount_charged pela
        # aritmetica de boleto (amount + fine_interest) produziria 47,98 — um valor que
        # nao existe no documento. Caso real: id 773 (juros de R$ 0,47).
        rec = {"barcode": GNRE_773, "amount": GNRE_773_PRINCIPAL,
               "amount_charged": GNRE_773_TOTAL, "fine_interest": 0.47,
               "discount": 0, "other_deductions": 0, "other_additions": 0}
        E.apply_arrecadacao_amount(rec)
        self.assertAlmostEqual(rec["amount"], GNRE_773_TOTAL, places=2)
        self.assertAlmostEqual(rec["amount_charged"], GNRE_773_TOTAL, places=2)
        # O componente e PRESERVADO como memoria de calculo, nao apagado.
        self.assertAlmostEqual(rec["fine_interest"], 0.47, places=2)

    def test_juros_grandes_nao_inflam_o_total(self):
        # id 817: principal 543,35 + juros 103,80 = 646,15. O erro de dupla contagem
        # daria 749,95 (+16%) — grande o bastante para passar despercebido como "juros".
        rec = {"barcode": GNRE_773, "amount": 543.35, "fine_interest": 103.80,
               "discount": 0, "other_deductions": 0, "other_additions": 0}
        E.apply_arrecadacao_amount(rec)
        self.assertAlmostEqual(rec["amount_charged"], GNRE_773_TOTAL, places=2)

    def test_idempotente(self):
        rec = {"barcode": GNRE_773, "amount": GNRE_773_TOTAL}
        self.assertFalse(E.apply_arrecadacao_amount(rec))
        self.assertIsNone(rec.get("processing_notes"))

    def test_nao_toca_boleto_bancario(self):
        rec = {"barcode": BOLETO_BANCARIO, "amount": 502.40}
        self.assertFalse(E.apply_arrecadacao_amount(rec))
        self.assertEqual(rec["amount"], 502.40)

    def test_preenche_quando_o_valor_esta_ausente(self):
        rec = {"barcode": GNRE_773, "amount": None}
        self.assertTrue(E.apply_arrecadacao_amount(rec))
        self.assertAlmostEqual(rec["amount"], GNRE_773_TOTAL, places=2)


class PaymentDeadlineTest(unittest.TestCase):
    def test_le_documento_valido_para_pagamento(self):
        texto = "Documento Válido para pagamento       31/07/2026\n"
        self.assertEqual(E.extract_payment_deadline_from_text(texto), "2026-07-31")

    def test_variantes_de_rotulo(self):
        for txt, esperado in [
            ("Válido para pagamento até 05/08/2026", "2026-08-05"),
            ("Pagar até: 10/08/2026", "2026-08-10"),
            ("Pague até 11/08/2026", "2026-08-11"),
            ("Pagamento até 13/08/2026", "2026-08-13"),
            ("Data limite para pagamento 12/08/2026", "2026-08-12"),
        ]:
            self.assertEqual(E.extract_payment_deadline_from_text(txt), esperado, txt)

    def test_nao_casa_variante_inexistente_do_verbo(self):
        # O regex anterior (`pag[au][ er]`) casava lixo como "pagae"/"pagur".
        self.assertIsNone(E.extract_payment_deadline_from_text("pagae ate 10/08/2026"))
        self.assertIsNone(E.extract_payment_deadline_from_text("pagur ate 10/08/2026"))

    def test_nao_casa_vencimento_comum(self):
        # O rotulo "Vencimento" pertence a extract_due_date_from_text, nao a esta.
        self.assertIsNone(E.extract_payment_deadline_from_text("Data de Vencimento 28/07/2026"))

    def test_texto_vazio_ou_data_invalida(self):
        self.assertIsNone(E.extract_payment_deadline_from_text(""))
        self.assertIsNone(E.extract_payment_deadline_from_text(None))
        self.assertIsNone(E.extract_payment_deadline_from_text(
            "Documento Válido para pagamento 32/13/2026"))

    def test_as_duas_datas_da_GNRE_sao_distinguidas(self):
        # O texto real tem AS DUAS; cada extrator pega a sua.
        texto = ("Data de Vencimento\n28/07/2026\n"
                 "Documento Válido para pagamento     31/07/2026\n")
        self.assertEqual(E.extract_due_date_from_text(texto), "2026-07-28")
        self.assertEqual(E.extract_payment_deadline_from_text(texto), "2026-07-31")


class ApplyTextDueDateTest(unittest.TestCase):
    """A CADEIA DE PRECEDENCIA do vencimento — a ordem E a regra de negocio."""

    # Texto como sai do pdfplumber numa GNRE: as duas datas convivem.
    TEXTO_GNRE = ("Guia Nacional de Recolhimento de Tributos Estaduais - GNRE\n"
                  "Data de Vencimento 28/07/2026\n"
                  "Valor Principal R$ 47,04\n"
                  "Total a Recolher R$ 47,51\n"
                  "Documento Válido para pagamento 31/07/2026\n")

    def test_guia_usa_a_data_limite_e_nao_o_vencimento_do_tributo(self):
        rec = {"barcode": GNRE_773, "due_date": "2026-07-28", "issue_date": "2026-07-31"}
        self.assertTrue(E.apply_text_due_date(rec, self.TEXTO_GNRE))
        self.assertEqual(rec["due_date"], "2026-07-31")

    def test_sem_barcode_de_arrecadacao_a_data_limite_e_IGNORADA(self):
        # NAO REGREDIR: num boleto comum, "válido para pagamento" nao e o vencimento.
        rec = {"barcode": BOLETO_BANCARIO, "due_date": "2026-07-28", "issue_date": "2026-07-01"}
        E.apply_text_due_date(rec, self.TEXTO_GNRE)
        self.assertEqual(rec["due_date"], "2026-07-28")

    def test_boleto_comum_mantem_a_precedencia_da_data_impressa(self):
        # Regra pre-existente (id 473/474): "Vencimento" impresso vence o LLM/fator.
        rec = {"barcode": BOLETO_BANCARIO, "due_date": "2025-04-14", "issue_date": "2026-07-01"}
        self.assertTrue(E.apply_text_due_date(rec, "Vencimento 21/07/2026\n"))
        self.assertEqual(rec["due_date"], "2026-07-21")

    def test_data_impressa_implausivel_e_descartada(self):
        # Vencimento anterior a emissao => nao adota (comportamento pre-existente).
        rec = {"barcode": BOLETO_BANCARIO, "due_date": "2026-07-20", "issue_date": "2026-07-15"}
        self.assertFalse(E.apply_text_due_date(rec, "Vencimento 01/01/2020\n"))
        self.assertEqual(rec["due_date"], "2026-07-20")

    def test_data_limite_ANTERIOR_a_emissao_ainda_vale_na_guia(self):
        # A guarda de plausibilidade NAO se aplica ao item 2. Em guia de tributo o
        # issue_date do documento e anulado (TAX_DOC_TYPES) e a coluna acaba preenchida
        # com a data do E-MAIL; um reenvio dias depois a poe DEPOIS do dia-limite, e a
        # guarda `>= emissao` descartaria justamente a data correta.
        rec = {"barcode": GNRE_773, "due_date": "2026-07-28", "issue_date": "2026-08-01"}
        E.apply_text_due_date(rec, self.TEXTO_GNRE)
        self.assertEqual(rec["due_date"], "2026-07-31")

    def test_texto_sem_data_nao_altera(self):
        rec = {"barcode": GNRE_773, "due_date": "2026-07-28"}
        self.assertFalse(E.apply_text_due_date(rec, "documento sem datas"))
        self.assertEqual(rec["due_date"], "2026-07-28")


if __name__ == "__main__":
    unittest.main()
