"""
Testes da skill `baixa-automatica` (run.py) — DUAS regras independentes: baixa (marca
"pago") e marcação de vencidos (marca "vencido").

Cobre a parte pura e testável sem rede: os construtores de filtro PostgREST de cada
regra, as constantes de situação/status alvo, o isolamento de falha entre as etapas e a
ORDEM de execução em main() (baixa antes de vencido — ver comentário em main()). As
chamadas HTTP (count_eligible* / apply_baixa / apply_vencido) não são exercidas aqui —
dependem do Supabase.
"""

import importlib.util
import unittest
import unittest.mock as mock
from pathlib import Path

# Carrega run.py como modulo de nome UNICO (nao 'run') — varias skills tem run.py
# (cobranca-vencidos, backup-supabase). Importar 'run' via sys.path colidiria em
# sys.modules e poluiria a suite (quebrava os testes da cobranca). importlib isola.
_RUN_PATH = (Path(__file__).resolve().parents[1]
             / "skills" / "baixa-automatica" / "scripts" / "run.py")
_spec = importlib.util.spec_from_file_location("baixa_automatica_run", _RUN_PATH)
run = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(run)


class BuildFilterTest(unittest.TestCase):
    def test_inclui_todas_as_condicoes(self):
        q = run.build_filter("2026-07-10")
        self.assertIn("has_invoice=eq.true", q)
        self.assertIn("has_bank_slip=eq.true", q)
        self.assertIn("due_date=lte.2026-07-10", q)
        self.assertIn("status_id=in.(1,2,3)", q)

    def test_data_de_hoje_entra_no_filtro(self):
        # A data é interpolada verbatim (usada como limite superior do vencimento).
        self.assertIn("due_date=lte.2020-01-01", run.build_filter("2020-01-01"))

    def test_status_ids_em_aberto_e_alvo_pago(self):
        # Só pendente/vencido/a vencer são convertidos; o alvo é "pago" (id 8).
        self.assertEqual(run.OPEN_STATUS_IDS, (1, 2, 3))
        self.assertEqual(run.STATUS_ID_PAGO, 8)


class BuildFilterVencidoTest(unittest.TestCase):
    """Nova regra (marcação de vencidos) — independente da baixa acima, cobre
    build_filter_vencido/VENCIDO_ELIGIBLE_STATUS_IDS/STATUS_ID_VENCIDO."""

    def test_inclui_status_em_aberto_e_vencimento_estritamente_anterior(self):
        q = run.build_filter_vencido("2026-07-10")
        self.assertIn("status_id=in.(1,3)", q)
        self.assertIn("due_date=lt.2026-07-10", q)

    def test_nao_usa_lte_operador_estrito(self):
        # "inferior a data corrente" = due_date < hoje (não <=) — a conta que vence
        # HOJE ainda está 'a vencer', não 'vencido'. Trava contra regressão de operador.
        q = run.build_filter_vencido("2026-07-10")
        self.assertNotIn("due_date=lte.", q)

    def test_data_de_hoje_entra_no_filtro(self):
        self.assertIn("due_date=lt.2020-01-01", run.build_filter_vencido("2020-01-01"))

    def test_status_ids_em_aberto_excluem_vencido_e_fechados(self):
        # Só pendente(1)/a vencer(3) são convertidos — vencido(2) já é o alvo (não
        # entra na origem) e os estados fechados (4..10) nunca são tocados.
        self.assertEqual(run.VENCIDO_ELIGIBLE_STATUS_IDS, (1, 3))
        self.assertNotIn(2, run.VENCIDO_ELIGIBLE_STATUS_IDS)
        self.assertEqual(run.STATUS_ID_VENCIDO, 2)

    def test_independente_do_filtro_de_baixa(self):
        # As duas regras não compartilham filtro/elegibilidade/status alvo.
        self.assertNotEqual(run.build_filter_vencido("2026-07-10"), run.build_filter("2026-07-10"))
        self.assertNotEqual(run.VENCIDO_ELIGIBLE_STATUS_IDS, run.OPEN_STATUS_IDS)
        self.assertNotEqual(run.STATUS_ID_VENCIDO, run.STATUS_ID_PAGO)


class MainStepIsolationTest(unittest.TestCase):
    """As duas etapas do main() são isoladas — falha numa não impede a outra."""

    def test_run_baixa_step_falha_nao_impede_chamada_de_vencido(self):
        with mock.patch.object(run, "count_eligible", side_effect=RuntimeError("boom")):
            with mock.patch.object(run, "count_eligible_vencido", return_value=3) as m_vencido:
                ok_baixa = run._run_baixa_step(dry_run=True, today="2026-07-10")
                ok_vencido = run._run_vencido_step(dry_run=True, today="2026-07-10")
        self.assertFalse(ok_baixa)
        self.assertTrue(ok_vencido)
        m_vencido.assert_called_once()


class MainOrderTest(unittest.TestCase):
    """A ORDEM de main() importa (não regredir): uma conta com NF+Boleto confirmados E
    vencida é elegível pelas DUAS regras — a baixa precisa rodar ANTES da marcação de
    vencidos, senão essa conta seria marcada 'vencido' em vez de 'pago'."""

    def test_baixa_step_roda_antes_de_vencido_step(self):
        chamadas = []
        with mock.patch.object(run, "_run_baixa_step",
                                side_effect=lambda **kw: chamadas.append("baixa") or True) as m_baixa, \
             mock.patch.object(run, "_run_vencido_step",
                                side_effect=lambda **kw: chamadas.append("vencido") or True) as m_vencido, \
             mock.patch.object(run, "_require_env"):
            exit_code = run.main(["--dry-run"])
        self.assertEqual(chamadas, ["baixa", "vencido"])
        self.assertEqual(exit_code, 0)
        m_baixa.assert_called_once()
        m_vencido.assert_called_once()


if __name__ == "__main__":
    unittest.main()
