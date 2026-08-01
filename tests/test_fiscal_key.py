"""Chave de acesso de documento fiscal (Onda 3 / migration 107).

O que estes testes travam:
  - a chave REAL de CT-e que existe hoje no banco (conta 376) e aceita, e os campos
    decompostos batem com o que o nome do arquivo original ja dizia ("Numero 1898003
    serie 0") — oraculo independente do parser;
  - os SETE codigos de 44 digitos que hoje estao gravados em `barcode` e NAO sao chave
    (guias DAM/DARF/DAE e recibos) sao rejeitados. Sao dados reais: e por causa deles que
    "44 digitos" nao serve de criterio — 7 de 8 seriam falso positivo;
  - o DV da SEFAZ nao e o do boleto (posicao e regra do resto divergem);
  - a varredura de texto acha a chave impressa em blocos de 4, como o DACTE imprime.

Todas as chaves aqui sao dado publico de nota fiscal (UF, CNPJ do emitente, numero) —
nao ha segredo envolvido.
"""

import re
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "skills" / "pdf-contas-pagar" / "scripts"))

import fiscal_key as F  # noqa: E402

# Conta 376 — CT-e da Transportadora (SP, modelo 57), source_file
# "sistemas_CT-e_-_Numero_1898003_serie_0__...". A serie e o numero decompostos abaixo
# tem de bater com esse nome: e o oraculo que prova que o layout esta correto.
CTE_REAL = "35260792528538000434570000018980031498026869"

# Gravados em financial_account_control.barcode, 44 digitos, nao-boleto — e NENHUM e chave
# de acesso: sao codigos de arrecadacao truncados (ids 267, 268, 423, 424, 428, 626, 641).
NAO_SAO_CHAVE = [
    "81819467030002993820000023635570120871010001",  # 267 dam / duam
    "81846946529800299670000041518057016067101000",  # 268 dam / duam
    "85800000037800025026025426189025723559100003",  # 423 recibo
    "85812650255910000030000057600025020525426189",  # 424 recibo
    "85686621128447032000000023362800060226071620",  # 428 recibo
    "85862017651999824330003798440603856230507162",  # 626 darf
    "85610000152490400062056092120266271360914700",  # 641 dae
]

# Achado no backfill de 2026-08-01 dentro de locacao_Boleto_de_Aluguel_...pdf: 44 digitos
# que passam em UF, mes, modelo e DV, mas datam de 09/1991 — antes de existir NF-e.
FALSO_POSITIVO_ALUGUEL = "41910920600933153140599434300052149800042211"


def _dv_oraculo(corpo43: str) -> str:
    """DV da SEFAZ calculado de forma INDEPENDENTE do modulo sob teste.

    Formulacao diferente de proposito (lista de pesos explicita, do fim para o inicio):
    se o oraculo fosse uma copia do codigo testado, os dois erram juntos e o teste vira
    decoracao. Ele e validado contra a chave real em `test_oraculo_do_dv_bate_com_a_chave_real`.
    """
    pesos = [2, 3, 4, 5, 6, 7, 8, 9]
    soma = sum(int(d) * pesos[i % 8] for i, d in enumerate(reversed(corpo43)))
    resto = soma % 11
    return "0" if resto in (0, 1) else str(11 - resto)


def _com_modelo(modelo: int) -> str:
    """A chave real com o modelo trocado e o DV recalculado — chave sintetica valida."""
    corpo = CTE_REAL[:20] + f"{modelo:02d}" + CTE_REAL[22:43]
    return corpo + _dv_oraculo(corpo)


def _com_ano(aa: int) -> str:
    """Idem, trocando os 2 digitos do ANO (posicoes 2-3) da chave."""
    corpo = CTE_REAL[:2] + f"{aa:02d}" + CTE_REAL[4:43]
    return corpo + _dv_oraculo(corpo)


class OraculoTest(unittest.TestCase):
    def test_oraculo_do_dv_bate_com_a_chave_real(self):
        """Sanidade do oraculo: sem isto, os testes de modelo abaixo provariam nada."""
        self.assertEqual(_dv_oraculo(CTE_REAL[:43]), CTE_REAL[43])


class ParseAccessKeyTest(unittest.TestCase):
    def test_chave_real_de_cte_e_aceita_e_decomposta(self):
        p = F.parse_access_key(CTE_REAL)
        self.assertIsNotNone(p)
        self.assertEqual(p["model"], 57)
        self.assertEqual(p["model_name"], "cte")
        self.assertEqual(p["uf_code"], 35)                    # SP
        self.assertEqual(p["emitter_cnpj"], "92528538000434")
        self.assertEqual(p["issue_yearmonth"], "2607")
        # Estes dois sao o oraculo externo: o nome do arquivo original diz
        # "Numero 1898003 serie 0".
        self.assertEqual(p["doc_number"], 1898003)
        self.assertEqual(p["series"], 0)

    def test_os_sete_codigos_reais_que_nao_sao_chave_sao_rejeitados(self):
        for barcode in NAO_SAO_CHAVE:
            with self.subTest(barcode=barcode):
                self.assertIsNone(F.parse_access_key(barcode))

    def test_dv_errado_e_rejeitado(self):
        """Validacao por mutante: trocar um digito do DV tem de derrubar a chave."""
        outro = "0" if CTE_REAL[43] != "0" else "1"
        self.assertIsNone(F.parse_access_key(CTE_REAL[:43] + outro))

    def test_digito_do_corpo_alterado_e_rejeitado_pelo_dv(self):
        mutante = CTE_REAL[:30] + ("0" if CTE_REAL[30] != "0" else "1") + CTE_REAL[31:]
        self.assertIsNone(F.parse_access_key(mutante))

    def test_os_quatro_modelos_do_dominio_sao_aceitos(self):
        for modelo in (55, 57, 59, 65):
            with self.subTest(modelo=modelo):
                p = F.parse_access_key(_com_modelo(modelo))
                self.assertIsNotNone(p)
                self.assertEqual(p["model"], modelo)

    def test_modelo_fora_do_dominio_e_rejeitado_mesmo_com_dv_valido(self):
        """58 nao existe; 56 e 66 existem no mundo mas nao entram nesta onda."""
        for modelo in (0, 56, 58, 66):
            with self.subTest(modelo=modelo):
                self.assertIsNone(F.parse_access_key(_com_modelo(modelo)))

    def test_uf_invalida_e_rejeitada(self):
        corpo = "99" + CTE_REAL[2:43]
        self.assertIsNone(F.parse_access_key(corpo + _dv_oraculo(corpo)))

    def test_mes_invalido_e_rejeitado(self):
        corpo = CTE_REAL[:4] + "13" + CTE_REAL[6:43]
        self.assertIsNone(F.parse_access_key(corpo + _dv_oraculo(corpo)))

    def test_falso_positivo_real_do_backfill_e_rejeitado(self):
        """Achado no backfill de 2026-08-01, dentro de um "Boleto de Aluguel".

        Passava em TODAS as outras camadas — UF 41 (PR) valida, mes 09, modelo 59, DV
        fechando — e so nao e chave porque AAMM diz **setembro de 1991**, quando nenhum
        documento fiscal eletronico existia. Foi este caso que criou a camada do ano.
        """
        self.assertIsNone(F.parse_access_key(FALSO_POSITIVO_ALUGUEL))
        # Prova de que as outras quatro camadas realmente passavam (senao o teste acima
        # estaria "passando pelo motivo errado").
        self.assertTrue(F.access_key_dv_ok(FALSO_POSITIVO_ALUGUEL))
        self.assertEqual(int(FALSO_POSITIVO_ALUGUEL[20:22]), 59)

    def test_ano_anterior_a_nfe_e_rejeitado(self):
        for aa in ("05", "99", "91"):
            corpo = CTE_REAL[:2] + aa + CTE_REAL[4:43]
            with self.subTest(aa=aa):
                self.assertIsNone(F.parse_access_key(corpo + _dv_oraculo(corpo)))

    def test_ano_futuro_alem_da_tolerancia_e_rejeitado(self):
        ref = date(2026, 8, 1)
        aceito = F.parse_access_key(_com_ano(27), ref_date=ref)      # 2027 = ref + 1
        self.assertIsNotNone(aceito)
        self.assertEqual(aceito["issue_year"], 2027)
        self.assertIsNone(F.parse_access_key(_com_ano(28), ref_date=ref))

    def test_ano_de_2006_e_aceito(self):
        """Piso do domínio: a NF-e comeca em 2006 — nao e chute sobre estes dados."""
        p = F.parse_access_key(_com_ano(6), ref_date=date(2026, 8, 1))
        self.assertIsNotNone(p)
        self.assertEqual(p["issue_year"], 2006)

    def test_comprimento_errado_e_none(self):
        self.assertIsNone(F.parse_access_key(CTE_REAL[:43]))
        self.assertIsNone(F.parse_access_key(CTE_REAL + "0"))
        self.assertIsNone(F.parse_access_key(None))
        self.assertIsNone(F.parse_access_key(""))

    def test_aceita_chave_formatada(self):
        formatada = " ".join(re.findall(r"\d{4}", CTE_REAL))
        p = F.parse_access_key(formatada)
        self.assertIsNotNone(p)
        self.assertEqual(p["access_key"], CTE_REAL)


class DvOkTest(unittest.TestCase):
    def test_dv_da_sefaz_nao_e_o_do_boleto(self):
        """Guarda contra usar `barcode_dv_refuted` no lugar deste (posicao/resto divergem).

        A chave real tem DV valido pela regra da SEFAZ; a funcao do boleto, por design,
        nem opina sobre ela (devolve False = "nao ha o que refutar").
        """
        import febraban  # noqa: PLC0415 — import local: e o ponto do teste

        self.assertTrue(F.access_key_dv_ok(CTE_REAL))
        self.assertFalse(febraban.barcode_dv_refuted(CTE_REAL))
        self.assertFalse(febraban.is_boleto_barcode(CTE_REAL))


class ExtractAccessKeysTest(unittest.TestCase):
    def test_acha_a_chave_em_blocos_de_quatro(self):
        """Como o DACTE imprime: 11 blocos de 4 digitos separados por espaco."""
        texto = ("DACTE\nCHAVE DE ACESSO\n"
                 + " ".join(re.findall(r"\d{4}", CTE_REAL))
                 + "\nConsulta em www.cte.fazenda.gov.br")
        self.assertEqual(F.extract_access_keys(texto), [CTE_REAL])

    def test_acha_a_chave_colada_a_outro_numero(self):
        """Celula de tabela em que a chave gruda no numero vizinho — a janela cobre."""
        self.assertEqual(F.extract_access_keys("R$ 1234" + CTE_REAL + "99"), [CTE_REAL])

    def test_nao_repete_a_mesma_chave(self):
        texto = f"{CTE_REAL}\n... verso ...\n{CTE_REAL}"
        self.assertEqual(F.extract_access_keys(texto), [CTE_REAL])

    def test_texto_sem_chave_devolve_lista_vazia(self):
        ruido = "Valor 1.234,56 CNPJ 47.273.917/0001-23 venc 10/08/2026 NF 000152737"
        self.assertEqual(F.extract_access_keys(ruido), [])

    def test_linha_digitavel_de_boleto_nao_vira_chave_fiscal(self):
        """O caso que mais importa: boleto e chave fiscal convivem no mesmo PDF."""
        boleto = "23793.39100 90000.004375 07000.842000 3 15250000018190"
        self.assertEqual(F.extract_access_keys(boleto), [])

    def test_texto_vazio_ou_none(self):
        self.assertEqual(F.extract_access_keys(""), [])
        self.assertEqual(F.extract_access_keys(None), [])

    def test_acha_duas_chaves_distintas_na_ordem(self):
        outra = _com_modelo(55)
        self.assertEqual(F.extract_access_keys(f"{CTE_REAL}\n{outra}"), [CTE_REAL, outra])


if __name__ == "__main__":
    unittest.main()
