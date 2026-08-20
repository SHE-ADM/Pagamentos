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

import json
import re
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

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

# Sentinela para OMITIR uma chave do JSON de teste — `None` nao serve: "campo ausente" e
# "campo nulo" sao estados distintos e os dois precisam ser exercitados.
_AUSENTE = object()


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


# ─────────────────────────────────────────────────────────────────────────────
# CAMINHO VISUAL (2026-08-20) — as duas regras deixaram de valer só no texto.
#
# Até aqui `apply_arrecadacao_amount`/`apply_text_due_date` eram chamadas apenas em
# `_build_records_text`; guia ESCANEADA dependia inteiramente do que o modelo leu. No
# visual não existe texto do PDF, então a data-limite chega pelo campo `payment_deadline`
# do prompt — mas quem DECIDE adotá-la é o código, com gate determinístico pelo barcode.
# ─────────────────────────────────────────────────────────────────────────────

class IsoDateTest(unittest.TestCase):
    """Dado que entra de FORA (o modelo) é validado ANTES de virar `due_date`."""

    def test_aceita_iso_e_formato_br(self):
        self.assertEqual(E._iso_date("2026-07-31"), "2026-07-31")
        self.assertEqual(E._iso_date("31/07/2026"), "2026-07-31")
        self.assertEqual(E._iso_date("2026-07-31T00:00:00Z"), "2026-07-31")
        self.assertEqual(E._iso_date("  2026-07-31  "), "2026-07-31")

    def test_recusa_data_impossivel_e_prosa(self):
        # Sem esta guarda o texto arbitrário chegaria ao INSERT do PostgREST, longe daqui.
        for ruim in ("32/13/2026", "2026-13-01", "amanhã", "", "   ", None, 12345, "31/07"):
            with self.subTest(valor=repr(ruim)):
                self.assertIsNone(E._iso_date(ruim))

    def test_recusa_digito_a_mais_DEPOIS_da_data(self):
        """Mutante: parse por PREFIXO (`s[:10]` sem olhar o resto). Um dígito a mais — a
        assinatura de um deslocamento na transcrição — virava data plausível com o
        excedente descartado em silêncio, em vez de virar None."""
        for ruim in ("31/07/20260", "2026-07-3199", "2026-07-31-", "31/07/2026/"):
            with self.subTest(valor=repr(ruim)):
                self.assertIsNone(E._iso_date(ruim))

    def test_o_sufixo_de_HORA_continua_valendo(self):
        """Anti-vacuidade da guarda acima: recusar todo resto mataria o timestamp ISO."""
        self.assertEqual(E._iso_date("2026-07-31T00:00:00Z"), "2026-07-31")
        self.assertEqual(E._iso_date("31/07/2026 12:00"), "2026-07-31")


class ArrecadacaoValueRefutedTest(unittest.TestCase):
    """A 2ª barreira do valor no caminho visual — o DV sozinho deixa passar ~13%."""

    def test_deslocamento_de_digito_e_refutado(self):
        # Assinatura medida do OCR: o código diz 10× o que o documento mostra.
        self.assertTrue(F.arrecadacao_value_refuted(GNRE_773, GNRE_773_TOTAL / 10))

    def test_juros_legitimos_NAO_sao_refutados(self):
        # Casos reais: 1,01× (id 773) e 1,19× (id 817). A guarda tem de DISCRIMINAR —
        # uma que refutasse sempre mataria a correção inteira e passaria no teste acima.
        self.assertFalse(F.arrecadacao_value_refuted(GNRE_773, GNRE_773_PRINCIPAL))
        self.assertFalse(F.arrecadacao_value_refuted(GNRE_773, GNRE_773_TOTAL / 3))

    def test_a_fronteira_e_10x(self):
        self.assertTrue(F.arrecadacao_value_refuted(GNRE_773, GNRE_773_TOTAL / 10.0))
        self.assertFalse(F.arrecadacao_value_refuted(GNRE_773, GNRE_773_TOTAL / 9.99))

    def test_direcao_UNICA_barcode_menor_nao_refuta(self):
        """🔴 Refutar o lado oposto faria a guarda preservar o número do LLM e gravar A
        MENOR — o estrago que a regra da guia existe para matar (R$ 297,17 em 27 GNRE)."""
        self.assertFalse(F.arrecadacao_value_refuted(GNRE_773, GNRE_773_TOTAL * 10))

    def test_nao_ha_o_que_refutar(self):
        # Semântica do nome, igual a `barcode_self_refuted`: False ≠ "válido".
        self.assertFalse(F.arrecadacao_value_refuted(BOLETO_BANCARIO, 1.0))
        self.assertFalse(F.arrecadacao_value_refuted(None, 1.0))
        for sem_valor in (None, "", 0, -5, "n/d"):
            with self.subTest(amount=repr(sem_valor)):
                self.assertFalse(F.arrecadacao_value_refuted(GNRE_773, sem_valor))


class ArrecadacaoDeadlineRefutedTest(unittest.TestCase):
    """A 2ª barreira da DATA no caminho visual — contraparte da guarda de VALOR.

    O `_iso_date` valida só a FORMA: um dígito de ANO trocado atravessa a validação
    inteira. E o estrago não é simétrico ao do valor — uma data-limite de **2126** grava um
    vencimento que NUNCA chega, e a conta desaparece de todo KPI, do aging e da cobrança
    sem levantar erro nenhum."""

    VENC_TRIBUTO = "2026-07-28"

    def test_a_folga_REAL_da_guia_nao_e_refutada(self):
        """Medido: 0 a 3 dias entre a data-limite e o vencimento do tributo (31 guias); e
        −11 a +16 dias entre `due_date` e a extração nas 38 guias lidas por Vision. Uma
        guarda que refutasse isto mataria a correção inteira e ainda passaria no teste
        seguinte — é o par que a torna discriminante."""
        for dl in ("2026-07-28", "2026-07-31", "2026-08-27", "2026-07-01"):
            with self.subTest(data_limite=dl):
                self.assertFalse(E.arrecadacao_deadline_refuted(dl, self.VENC_TRIBUTO))

    def test_ano_trocado_pela_transcricao_e_refutado(self):
        for ruim in ("2016-07-31", "2126-07-31", "2027-07-31", "2025-07-31"):
            with self.subTest(data_limite=ruim):
                self.assertTrue(E.arrecadacao_deadline_refuted(ruim, self.VENC_TRIBUTO))

    def test_a_fronteira_e_180_dias(self):
        base = date.fromisoformat(self.VENC_TRIBUTO)
        no_teto = (base + timedelta(days=180)).isoformat()
        passou = (base + timedelta(days=181)).isoformat()
        self.assertFalse(E.arrecadacao_deadline_refuted(no_teto, self.VENC_TRIBUTO))
        self.assertTrue(E.arrecadacao_deadline_refuted(passou, self.VENC_TRIBUTO))

    def test_DUAS_direcoes_ao_contrario_da_guarda_de_VALOR(self):
        """Na de valor, refutar o lado oposto preservaria o número errado do LLM — o
        estrago original. Aqui a recusa preserva a data do DOCUMENTO nos dois sentidos,
        então nenhuma direção é perigosa: uma data-limite muito ANTES do vencimento do
        tributo é tão implausível quanto uma muito depois."""
        base = date.fromisoformat(self.VENC_TRIBUTO)
        self.assertTrue(E.arrecadacao_deadline_refuted(
            (base - timedelta(days=200)).isoformat(), self.VENC_TRIBUTO))
        self.assertTrue(E.arrecadacao_deadline_refuted(
            (base + timedelta(days=200)).isoformat(), self.VENC_TRIBUTO))

    def test_o_que_ela_NAO_cobre_e_parte_do_contrato(self):
        """Erro de MÊS ou DIA (até ~31 dias) não é separável de uma validade longa
        legítima. A guarda deliberadamente não tenta pegá-lo — travado aqui para que
        ninguém aperte o teto acreditando que ela cobre isso."""
        self.assertFalse(E.arrecadacao_deadline_refuted("2026-08-28", self.VENC_TRIBUTO))

    def test_o_MODO_DE_FALHA_ACEITO_esta_travado(self):
        """⚠️ A contraprova cruza DUAS leituras do MESMO modelo. Se o que ele errou foi a
        REFERÊNCIA — leu o vencimento do tributo com um ano a menos e a data-limite certa —,
        a recusa cai sobre a data BOA e o registro fica com o vencimento do tributo: o estado
        anterior à correção, visível e anotado.

        Não é um defeito escondido, é a direção conservadora do erro (incoerência não diz
        QUAL das duas leituras errou), e está travado aqui para que a documentação não
        prometa uma garantia que o código não dá."""
        rec = {"barcode": GNRE_773, "due_date": "2025-07-28"}     # referência errada
        self.assertFalse(E.apply_arrecadacao_deadline(
            rec, "2026-07-31", doc_due_date="2025-07-28"))         # data-limite CERTA
        self.assertEqual(rec["due_date"], "2025-07-28")
        self.assertIn("refutada", rec["processing_notes"])

    def test_nao_ha_o_que_refutar(self):
        """Semântica do nome, igual a `arrecadacao_value_refuted`: False ≠ "correta".

        Sem `due_date` lido do documento não há contraprova — e a guarda NÃO inventa uma
        referência. Usar "hoje" faria um reprocessamento histórico refutar justamente a
        data certa, que é a armadilha já documentada em `apply_text_due_date`."""
        self.assertFalse(E.arrecadacao_deadline_refuted(None, self.VENC_TRIBUTO))
        self.assertFalse(E.arrecadacao_deadline_refuted("2126-07-31", None))
        self.assertFalse(E.arrecadacao_deadline_refuted("2126-07-31", "amanhã"))
        self.assertFalse(E.arrecadacao_deadline_refuted("prosa", self.VENC_TRIBUTO))


class ApplyArrecadacaoDeadlineTest(unittest.TestCase):
    """A regra canônica do vencimento — o gate é o BARCODE, nunca o `document_type`."""

    def test_adota_a_data_limite_na_guia(self):
        rec = {"barcode": GNRE_773, "due_date": "2026-07-28"}
        self.assertTrue(E.apply_arrecadacao_deadline(rec, "2026-07-31"))
        self.assertEqual(rec["due_date"], "2026-07-31")
        self.assertIn("data-limite", rec["processing_notes"])

    def test_boleto_comum_NAO_adota(self):
        rec = {"barcode": BOLETO_BANCARIO, "due_date": "2026-07-28"}
        self.assertFalse(E.apply_arrecadacao_deadline(rec, "2026-09-30"))
        self.assertEqual(rec["due_date"], "2026-07-28")

    def test_sem_barcode_NAO_adota(self):
        rec = {"barcode": None, "due_date": "2026-07-28"}
        self.assertFalse(E.apply_arrecadacao_deadline(rec, "2026-09-30"))
        self.assertEqual(rec["due_date"], "2026-07-28")

    def test_data_invalida_nao_altera(self):
        rec = {"barcode": GNRE_773, "due_date": "2026-07-28"}
        self.assertFalse(E.apply_arrecadacao_deadline(rec, "32/13/2026"))
        self.assertEqual(rec["due_date"], "2026-07-28")

    def test_idempotente(self):
        rec = {"barcode": GNRE_773, "due_date": "2026-07-31"}
        self.assertFalse(E.apply_arrecadacao_deadline(rec, "31/07/2026"))
        self.assertIsNone(rec.get("processing_notes"))

    def test_data_refutada_PRESERVA_o_vencimento_e_ANOTA(self):
        rec = {"barcode": GNRE_773, "due_date": "2026-07-28"}
        self.assertFalse(E.apply_arrecadacao_deadline(
            rec, "2126-07-31", doc_due_date="2026-07-28"))
        self.assertEqual(rec["due_date"], "2026-07-28")
        self.assertIn("refutada", rec["processing_notes"])

    def test_a_contraprova_e_OPT_IN_como_o_ocr_barcode(self):
        """Contraprova do parâmetro: no caminho de TEXTO (sem `doc_due_date`) a MESMA data
        absurda ainda é adotada. A data de lá é determinística — um regex sobre o próprio
        documento —, e a guarda ali custaria correções boas, exatamente pelo motivo que faz
        o `ocr_barcode` da guarda de VALOR ser opt-in."""
        rec = {"barcode": GNRE_773, "due_date": "2026-07-28"}
        self.assertTrue(E.apply_arrecadacao_deadline(rec, "2126-07-31"))
        self.assertEqual(rec["due_date"], "2126-07-31")

    def test_e_a_MESMA_funcao_que_o_caminho_de_texto_usa(self):
        """🔴 FONTE ÚNICA: se `apply_text_due_date` voltar a ter cópia própria da regra,
        desligar a canônica deixaria de afetar o texto — e as duas divergiriam no primeiro
        ajuste, com a guia de um dos caminhos voltando a nascer vencida, sem erro."""
        rec = {"barcode": GNRE_773, "due_date": "2026-07-28", "issue_date": None}
        with mock.patch.object(E, "apply_arrecadacao_deadline", return_value=False) as spy:
            E.apply_text_due_date(rec, ApplyTextDueDateTest.TEXTO_GNRE)
        spy.assert_called_once()
        self.assertEqual(spy.call_args.args[1], "2026-07-31")   # a data extraída do texto
        self.assertEqual(rec["due_date"], "2026-07-28")         # e nada mudou sem ela


class VisionAplicaAsRegrasDaGuiaTest(unittest.TestCase):
    """🔴 ESTRUTURAL: as duas correções valem em TODA fonte de `VISION_SOURCES`."""

    VENC_TRIBUTO = "2026-07-28"
    DATA_LIMITE = "2026-07-31"

    def _json(self, **over):
        item = {"document_type": "GNRE", "supplier_name": "SEFAZ PR",
                "amount": GNRE_773_PRINCIPAL, "due_date": self.VENC_TRIBUTO,
                "barcode": GNRE_773, "payment_deadline": self.DATA_LIMITE}
        item.update(over)
        return json.dumps({k: v for k, v in item.items() if v is not _AUSENTE})

    def _rec(self, source="pdf_vision", doc_text=None, **over):
        return E.build_records(Path("guia.pdf"), self._json(**over), source,
                               doc_text=doc_text)[0]

    def test_as_TRES_fontes_visuais_corrigem_valor_e_vencimento(self):
        # Sanidade do laço: uma constante vazia faria o teste passar sem asserir nada.
        self.assertEqual(len(E.VISION_SOURCES), 3, E.VISION_SOURCES)
        for source in E.VISION_SOURCES:
            with self.subTest(source=source):
                rec = self._rec(source)
                self.assertAlmostEqual(rec["amount"], GNRE_773_TOTAL, places=2)
                self.assertAlmostEqual(rec["amount_charged"], GNRE_773_TOTAL, places=2)
                self.assertEqual(rec["due_date"], self.DATA_LIMITE)

    def test_sem_as_regras_a_guia_nasceria_errada(self):
        """Anti-vacuidade: o registro CRU do modelo traz os dois números errados — é
        exatamente o que era gravado antes desta correção."""
        rec = E.build_record_from_json(Path("guia.pdf"), json.loads(self._json()),
                                       "pdf_vision")
        self.assertAlmostEqual(rec["amount"], GNRE_773_PRINCIPAL, places=2)
        self.assertEqual(rec["due_date"], self.VENC_TRIBUTO)

    def test_payment_deadline_NAO_vaza_para_o_CSV(self):
        """O campo é insumo da decisão, não coluna. Chave que não é coluna faz o
        PostgREST recusar o INSERT (PGRST204) e a conta deixa de ser gravada."""
        rec = self._rec()
        self.assertNotIn("payment_deadline", rec)
        self.assertEqual(set(rec) - set(E.CSV_COLUMNS), set())

    def test_boleto_comum_ignora_o_payment_deadline(self):
        """Oráculo diferencial: com e sem o campo, o boleto termina no MESMO vencimento.

        ⚠️ A data-limite deste caso NÃO pode ser a `DATA_LIMITE` da guia: o fator do
        `BOLETO_BANCARIO` decodifica justamente em 2026-07-31 (vencimento real dele), e o
        `assertNotEqual` seria verde por coincidência — vazamento e acerto ficariam
        indistinguíveis."""
        alheia = "2026-09-30"
        comum = dict(document_type="boleto", barcode=BOLETO_BANCARIO, amount=502.40,
                     due_date="2026-03-12", payment_deadline=alheia)
        com = self._rec(**comum)
        sem = self._rec(**{**comum, "payment_deadline": _AUSENTE})
        self.assertEqual(com["due_date"], sem["due_date"])
        self.assertNotEqual(com["due_date"], alheia)

    def test_payment_deadline_invalido_nao_altera_o_vencimento(self):
        for ruim in ("32/13/2026", "amanhã", "", None):
            with self.subTest(valor=repr(ruim)):
                self.assertEqual(self._rec(payment_deadline=ruim)["due_date"],
                                 self.VENC_TRIBUTO)

    def test_texto_do_documento_VENCE_o_campo_do_modelo(self):
        """Quando há texto real, a extração determinística tem precedência — mesma ordem
        do caminho de texto. Cobre o tier 2 e a página espelhada."""
        rec = self._rec(payment_deadline="2026-09-09",
                        doc_text="Documento Válido para pagamento 31/07/2026")
        self.assertEqual(rec["due_date"], self.DATA_LIMITE)

    def test_com_N_pagaveis_o_texto_NAO_carimba_todos(self):
        """🔴 O regex é do documento INTEIRO e devolve a PRIMEIRA data-limite. Aplicá-la a
        N registros daria à guia 2 o dia-limite da guia 1 — data errada, plausível e
        silenciosa. Com N itens cada um usa o `payment_deadline` que o modelo leu DELE.

        Mesma armadilha que faz o caminho de TEXTO recusar N pagáveis (o barcode do
        primeiro indo para todos)."""
        duas = json.dumps([
            {"document_type": "GNRE", "amount": GNRE_773_PRINCIPAL, "barcode": GNRE_773,
             "due_date": "2026-07-28", "payment_deadline": "2026-07-31"},
            {"document_type": "GNRE", "amount": GNRE_773_PRINCIPAL, "barcode": GNRE_773,
             "due_date": "2026-08-28", "payment_deadline": "2026-08-31"},
        ])
        recs = E.build_records(Path("duas_guias.pdf"), duas, "pdf_vision",
                               doc_text="Documento Válido para pagamento 31/07/2026")
        self.assertEqual([r["due_date"] for r in recs], ["2026-07-31", "2026-08-31"])

    def test_ano_corrompido_na_TRANSCRICAO_nao_vira_vencimento(self):
        """🔴 Metade "data" da regra da guia, no caminho em que ela é TRANSCRITA por um
        modelo. Sem a contraprova, `payment_deadline` de 2126 gravava uma conta que nunca
        vence — invisível em todo KPI, no aging e na cobrança, sem erro nenhum."""
        for ruim in ("31/07/2016", "2126-07-31", "2027-07-31"):
            with self.subTest(payment_deadline=ruim):
                rec = self._rec(payment_deadline=ruim)
                self.assertEqual(rec["due_date"], self.VENC_TRIBUTO)
                self.assertIn("refutada", rec["processing_notes"])

    def test_a_contraprova_segue_a_PROCEDENCIA_nao_o_call_site(self):
        """🔴 A data-limite tem DUAS procedências no builder visual. A do TEXTO é
        determinística e entra SEM cruzamento — aqui ela está a 521 dias do vencimento que
        o modelo leu, muito além do teto de 180, e ainda assim é adotada. Um call site que
        colapsasse as duas numa chamada só com contraprova fixa submeteria a data
        determinística a uma guarda que ela não precisa, e este caso ficaria vermelho."""
        rec = self._rec(payment_deadline=_AUSENTE,
                        doc_text="Documento Válido para pagamento 31/12/2027")
        self.assertEqual(rec["due_date"], "2027-12-31")

    def test_com_N_pagaveis_cada_item_cruza_com_o_PROPRIO_vencimento(self):
        """🔴 A referência é do ITEM, nunca do documento. Um carnê de parcelamento traz
        guias a MESES de distância: julgadas contra a data da primeira, as parcelas
        distantes — legítimas — seriam refutadas em bloco e nasceriam com o vencimento do
        tributo, exatamente o defeito que a regra existe para matar.

        Mutante que este caso trava: `doc_due_date=itens[0].get("due_date")`. Ele exige
        parcelas ESPAÇADAS — com as três a dias uma da outra o veredito seria o mesmo e o
        caso passaria verde com o defeito instalado (foi o que aconteceu na 1ª versão).
        A 3ª parcela tem o ano corrompido: prova que a recusa cai no item CERTO."""
        def _parcela(venc, limite):
            return {"document_type": "GNRE", "amount": GNRE_773_PRINCIPAL,
                    "barcode": GNRE_773, "due_date": venc, "payment_deadline": limite}

        carne = json.dumps([
            _parcela("2026-01-05", "2026-01-08"),      # legítima
            _parcela("2026-12-20", "2026-12-23"),      # legítima, 352 dias após a 1ª
            _parcela("2026-06-10", "2016-06-13"),      # ano corrompido na transcrição
        ])
        recs = E.build_records(Path("carne.pdf"), carne, "pdf_vision")
        self.assertEqual([r["due_date"] for r in recs],
                         ["2026-01-08", "2026-12-23", "2026-06-10"])
        self.assertNotIn("refutada", recs[0]["processing_notes"] or "")
        self.assertNotIn("refutada", recs[1]["processing_notes"] or "")
        self.assertIn("refutada", recs[2]["processing_notes"])

    def test_sem_vencimento_lido_a_data_limite_ainda_entra(self):
        """🔴 Não há contraprova a INVENTAR. Com o modelo sem `due_date`, o `ensure_due_date`
        põe HOJE no registro — e usar esse valor como referência faria um reprocessamento
        histórico refutar justamente a data certa, que é a armadilha já documentada em
        `apply_text_due_date`. Sem referência do documento, a data-limite entra: é o mesmo
        "não há o que refutar" da guarda de valor.

        Mutante que este caso trava: `doc_due_date=item.get("due_date") or hoje`. A guia
        aqui é de 300 dias atrás — de propósito, porque uma guia RECENTE caberia no teto de
        180 e o caso ficaria verde com o defeito instalado. Data derivada de `today()`, não
        literal: a distância precisa continuar sendo 300 dias no ano que vem."""
        antiga = (date.today() - timedelta(days=300)).isoformat()
        rec = self._rec(due_date=_AUSENTE, payment_deadline=antiga)
        self.assertEqual(rec["due_date"], antiga)
        self.assertNotIn("refutada", rec["processing_notes"] or "")

    def test_barcode_10x_NAO_sobrescreve_o_valor_e_ANOTA(self):
        """No visual o próprio código é OCR: um dígito deslocado gravaria 10× a dívida.
        O valor do documento é preservado e a divergência fica auditável."""
        rec = self._rec(amount=GNRE_773_TOTAL / 10)
        self.assertAlmostEqual(rec["amount"], GNRE_773_TOTAL / 10, places=2)
        self.assertIn("refutada", rec["processing_notes"])

    def test_a_guarda_de_OCR_e_do_caminho_VISUAL_apenas(self):
        """Contraprova do parâmetro: no TEXTO os dígitos vêm do PDF (228/228 conferindo) e
        a mesma divergência de 10× ainda corrige — a guarda ali custaria correções boas."""
        rec = {"barcode": GNRE_773, "amount": GNRE_773_TOTAL / 10}
        self.assertTrue(E.apply_arrecadacao_amount(rec))
        self.assertAlmostEqual(rec["amount"], GNRE_773_TOTAL, places=2)

    def test_prompt_declara_o_campo_payment_deadline(self):
        """Anti-drift: sem o campo no prompt o applier recebe None para sempre e a metade
        'vencimento' vira decoração — sem erro e sem teste vermelho em lugar nenhum."""
        campos = re.findall(r"^- (\w+):", E.EXTRACTION_PROMPT, re.M)
        self.assertGreater(len(campos), 10, "parser do prompt parou de casar")
        self.assertIn("due_date", campos)              # sanidade do parser
        self.assertIn("payment_deadline", campos)


class VisionWiringTest(unittest.TestCase):
    """As funções puras acima não provam que o TOPO as executa."""

    _JSON_GUIA = json.dumps({
        "document_type": "GNRE", "amount": GNRE_773_PRINCIPAL, "due_date": "2026-07-28",
        "barcode": GNRE_773, "payment_deadline": "2026-07-31"})

    def test_process_pdf_de_guia_ESCANEADA_entrega_total_e_data_limite(self):
        with mock.patch.object(E, "_is_image_file", return_value=False), \
                mock.patch.object(E, "is_docx", return_value=False), \
                mock.patch.object(E, "_pdf_is_encrypted", return_value=False), \
                mock.patch.object(E, "_payable_pages", return_value=[]), \
                mock.patch.object(E, "is_scanned_pdf", return_value=True), \
                mock.patch.object(E, "extract_with_vision",
                                  return_value=(self._JSON_GUIA, "pdf_vision")):
            recs = E.process_pdf(Path("gnre_escaneada.pdf"))
        self.assertEqual(len(recs), 1)
        self.assertAlmostEqual(recs[0]["amount"], GNRE_773_TOTAL, places=2)
        self.assertEqual(recs[0]["due_date"], "2026-07-31")

    def test_tier2_preserva_a_data_limite_lida_do_TEXTO(self):
        """O tier 2 (texto sem valor → Vision) trocava a lista INTEIRA pelo resultado
        visual, e a data-limite determinística ia junto. Aqui o modelo devolve
        `payment_deadline` nulo de propósito: quem entrega a data é o texto."""
        texto = ("GUIA NACIONAL DE RECOLHIMENTO - GNRE\n"
                 "Data de Vencimento 28/07/2026\n"
                 "Documento Válido para pagamento 31/07/2026\n"
                 "Contribuinte: OTIMOTEX TECIDOS LTDA - inscricao estadual 1234567890\n")
        visual = json.dumps({"document_type": "GNRE", "amount": GNRE_773_PRINCIPAL,
                             "due_date": "2026-07-28", "barcode": GNRE_773,
                             "payment_deadline": None})
        with mock.patch.object(E, "is_scanned_pdf", return_value=False), \
                mock.patch.object(E, "extract_with_pdfplumber",
                                  return_value=(texto, "pdf_text")), \
                mock.patch.object(E, "extract_fields_with_claude",
                                  return_value={"document_type": "GNRE", "amount": None,
                                                "due_date": "2026-07-28"}), \
                mock.patch.object(E, "_try_barcode_vision", return_value=None), \
                mock.patch.object(E, "extract_with_vision",
                                  return_value=(visual, "pdf_vision")):
            recs = E._extract_records(Path("gnre.pdf"))
        self.assertEqual(recs[0]["extraction_source"], "pdf_vision")
        self.assertEqual(recs[0]["due_date"], "2026-07-31")


if __name__ == "__main__":
    unittest.main()
