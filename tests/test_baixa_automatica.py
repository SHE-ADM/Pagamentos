"""
Testes da skill `baixa-automatica` (run.py).

Cobre a parte pura e testável sem rede: o construtor do filtro PostgREST das contas
elegíveis à baixa e as constantes das situações em aberto. As chamadas HTTP
(count_eligible / apply_baixa) não são exercidas aqui — dependem do Supabase.
"""

import importlib.util
import unittest
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


if __name__ == "__main__":
    unittest.main()
