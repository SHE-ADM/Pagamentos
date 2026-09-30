"""
Testes da detecção de domínio com erro de digitação (send_core.suggest_domain_fix /
validate_email).

O relay aceita qualquer destinatário sintaticamente válido; sem esta barreira o run
registrava "enviado" para "@gemail.com" (caso real 251796-A, 2026-09-29) e a cobrança
nunca chegava. O lado oposto importa tanto quanto: falso positivo deixa um cliente real
sem cobrança — por isso os e-mails REAIS do log de produção entram como anti-regressão.
"""

import sys
import unittest
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "skills" / "cobranca-vencidos" / "scripts"
sys.path.insert(0, str(_SCRIPTS_DIR))

from send_core import (  # noqa: E402
    _GENERIC_SUFFIXES,
    _MISSING_COM_SUFFIXES,
    _edit_distance,
    suggest_domain_fix,
    validate_email,
)


class EditDistanceTest(unittest.TestCase):
    def test_transposicao_conta_como_uma_edicao(self):
        self.assertEqual(_edit_distance("hotmial", "hotmail"), 1)

    def test_operacoes_basicas(self):
        self.assertEqual(_edit_distance("gemail", "gmail"), 1)   # inserção
        self.assertEqual(_edit_distance("gmai", "gmail"), 1)     # remoção
        self.assertEqual(_edit_distance("gmeil", "gmail"), 1)    # troca
        self.assertEqual(_edit_distance("gmail", "gmail"), 0)
        self.assertEqual(_edit_distance("", "com"), 3)


class SuggestDomainFixTest(unittest.TestCase):
    def test_erros_de_digitacao_sao_detectados_com_a_correcao(self):
        casos = {
            "gemail.com": "gmail.com",        # caso real 251796-A
            "gmial.com": "gmail.com",
            "gmail.con": "gmail.com",
            "gmail.co": "gmail.com",
            "gmail.com.br": "gmail.com",      # gmail não usa .com.br
            "GMAIL.COM.BR": "gmail.com",
            "hotmial.com": "hotmail.com",
            "hotmai.com.br": "hotmail.com.br",
            "hotmail.com.b": "hotmail.com.br",
            "yaho.com.br": "yahoo.com.br",
            "outlok.com": "outlook.com",
            "icloud.com.br": "icloud.com",
            # "com." esquecido — caso real 244621-D (lidercouros@yahoo.br, 2026-09-30).
            "yahoo.br": "yahoo.com.br",
            "YAHOO.BR": "yahoo.com.br",
            "hotmail.br": "hotmail.com.br",
            "outlook.br": "outlook.com.br",
            "gmail.br": "gmail.com",          # o gmail não usa .com.br
            "icloud.br": "icloud.com",
            "gamil.com": "gmail.com",         # caso real 252108-A (produção, 2026-09-30)
        }
        for domain, esperado in casos.items():
            self.assertEqual(suggest_domain_fix(domain), esperado, domain)

    def test_dominios_legitimos_nao_sao_barrados(self):
        # Todos os domínios de cliente do log de produção de 2026-09-29, mais provedores
        # reais a 1 edição de um da lista e domínios de país.
        legitimos = [
            "gmail.com", "hotmail.com", "hotmail.com.br", "yahoo.com.br", "yahoo.com",
            "outlook.com", "icloud.com", "bol.com.br", "uol.com.br", "terra.com.br",
            "caterplast.com.br", "mobonline.com.br", "mma.com.br", "tessconcept.com.br",
            "handred.com.br", "mimobom.com.br", "atualcortinas.com.br", "wafeh.io",
            "dinaarmarinhos.com.br", "holiverdecoracoes.com.br", "tricolinhas.com.br",
            "ymail.com", "mail.com", "email.com",
            "hotmail.fr", "hotmail.co.uk", "yahoo.com.ar", "outlook.com.pt",
            "hotmal.empresa.com.br",           # subdomínio corporativo, não erro
            "", "semponto", ".",
            # Forma curta só vale para rótulo de provedor EXATO: dois erros juntos, ou
            # domínio .br que não é de provedor gratuito, ficam de fora.
            "yaho.br", "empresa.br", "bol.br", "uol.br", "ymail.br",
        ]
        for domain in legitimos:
            self.assertIsNone(suggest_domain_fix(domain), domain)

    def test_dominios_do_dry_run_de_producao_seguem_liberados(self):
        # Todos os domínios de cliente do `run.py --dry-run` de produção de 2026-09-30
        # (162 títulos) exceto os 3 com erro real — nenhum pode virar falso positivo.
        producao = [
            "hotmail.com", "gmail.com", "yahoo.com.br", "bol.com.br", "outlook.com",
            "icloud.com", "hotmail.com.br", "uol.com.br", "lemonbasics.com",
            "wafeh.io", "caterplast.com.br", "mobonline.com.br", "alojinhainbox.com.br",
            "dinaarmarinhos.com.br", "melsc.com.br", "casadamamae.com",
            "grupomorenarosa.com.br", "handred.com.br", "tessconcept.com.br",
            "mimobom.com.br", "mma.com.br", "danaka.com.br", "atualcortinas.com.br",
            "ribeirastore.com.br", "laisutilidades.com.br", "cdbrj.com.br",
            "caroldiasbrand.com", "falcaoespumas.com.br", "holiverdecoracoes.com.br",
        ]
        for domain in producao:
            self.assertIsNone(suggest_domain_fix(domain), domain)

    def test_forma_curta_e_derivada_dos_sufixos_genericos(self):
        # Sanidade estrutural: a forma curta vem de _GENERIC_SUFFIXES, não de uma 2ª lista.
        self.assertEqual(_MISSING_COM_SUFFIXES, {"br": "com.br"})
        for curto, generico in _MISSING_COM_SUFFIXES.items():
            self.assertIn(generico, _GENERIC_SUFFIXES)
            self.assertEqual(f"com.{curto}", generico)


class ValidateEmailTest(unittest.TestCase):
    def test_dominio_digitado_errado_e_invalido_com_motivo_leigo(self):
        ok, motivo = validate_email(" marceloaugustobranco@gemail.com ")
        self.assertFalse(ok)
        self.assertIn("erro de digitação", motivo)
        self.assertIn("@gmail.com", motivo)

    def test_com_esquecido_e_invalido_com_a_correcao(self):
        ok, motivo = validate_email("lidercouros@yahoo.br")
        self.assertFalse(ok)
        self.assertIn("@yahoo.com.br", motivo)

    def test_casos_anteriores_seguem_iguais(self):
        self.assertEqual(validate_email(None), (False, "Cliente sem e-mail cadastrado."))
        self.assertEqual(validate_email("  "), (False, "Cliente sem e-mail cadastrado."))
        ok, motivo = validate_email("sem-arroba")
        self.assertFalse(ok)
        self.assertIn("parece inválido", motivo)
        self.assertEqual(validate_email("cliente@gmail.com"), (True, None))


if __name__ == "__main__":
    unittest.main()
