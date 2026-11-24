"""
test_purge_recent_objects.py — a purga de órfãos não apaga o anexo de um run EM ANDAMENTO.

`scripts/purge_orphan_attachments.py` remove do bucket o que nenhuma linha referencia, e a
remoção é IRREVERSÍVEL. Só que o reader publica o anexo no Passo 1, ANTES de gravar a conta, e
roda a cada 5 minutos em produção: no instante da purga, o anexo de um run em andamento ainda não
tem linha — é indistinguível de um órfão. Apagá-lo deixaria a conta que nasce segundos depois sem
o PDF, sem erro e sem status distinto.

Garantias:
  1. objeto escrito há menos de `MIN_AGE_HOURS` é preservado — e a DÚVIDA (data ausente,
     ilegível ou no futuro) também preserva;
  2. o instante usado é o da ÚLTIMA ESCRITA (`updated_at`): um upload que sobrescreve a chave
     não muda o `created_at`;
  3. a execução real grava a lista COMPLETA do que vai apagar ANTES do primeiro DELETE, e sem
     conseguir gravar o registro não apaga nada;
  4. `--dry-run` não apaga e não grava registro.

Os casos de fluxo executam `main()` — a função de topo —, com o bucket e o banco dublados.
"""

import importlib.util
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "skills" / "email-reader" / "scripts"))
sys.path.insert(0, str(_ROOT / "skills" / "pdf-contas-pagar" / "scripts"))
sys.path.insert(0, str(_ROOT / "scripts"))

import supabase_rest as SR  # noqa: E402


def _carrega(nome: str, caminho: Path):
    """Importa o script por caminho, com nome ÚNICO em sys.modules (não colide entre suítes)."""
    spec = importlib.util.spec_from_file_location(nome, caminho)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[nome] = mod
    spec.loader.exec_module(mod)
    return mod


PG = _carrega("purge_orphan_recent_mod", _ROOT / "scripts" / "purge_orphan_attachments.py")

AGORA = datetime(2026, 11, 24, 15, 0, tzinfo=timezone.utc)


def _ha(**delta) -> str:
    """Instante ISO no formato da Storage API (`…Z`), `delta` antes de AGORA."""
    return (AGORA - timedelta(**delta)).strftime("%Y-%m-%dT%H:%M:%S.275Z")


class EscritoHaPoucoTest(unittest.TestCase):
    def test_o_limiar_e_min_age_hours(self):
        self.assertTrue(PG._escrito_ha_pouco(_ha(hours=PG.MIN_AGE_HOURS, minutes=-1), AGORA))
        self.assertFalse(PG._escrito_ha_pouco(_ha(hours=PG.MIN_AGE_HOURS, minutes=1), AGORA))
        self.assertTrue(PG._escrito_ha_pouco(_ha(minutes=3), AGORA))
        self.assertFalse(PG._escrito_ha_pouco(_ha(days=5), AGORA))

    def test_a_janela_cobre_com_folga_um_run_do_reader(self):
        # A janela real entre o upload e a linha é de minutos; uma folga menor que 1 h deixaria
        # a decisão sensível a relógio fora de sincronia entre a máquina e o Storage.
        self.assertGreaterEqual(PG.MIN_AGE_HOURS, 1)

    def test_na_duvida_preserva(self):
        futuro = (AGORA + timedelta(days=400)).isoformat()
        for instante in (None, "", "lixo", 12345, futuro):
            with self.subTest(instante=instante):
                self.assertTrue(PG._escrito_ha_pouco(instante, AGORA))

    def test_instante_sem_fuso_e_lido_como_utc(self):
        self.assertFalse(PG._escrito_ha_pouco("2026-11-20T10:00:00", AGORA))
        self.assertTrue(PG._escrito_ha_pouco("2026-11-24T14:00:00", AGORA))


class MainTest(unittest.TestCase):
    """`main()` com bucket e banco dublados. Nenhuma chamada de rede acontece."""

    OBJETOS = {
        "antigo.pdf": "2026-11-18T12:00:00.000Z",        # órfão de dias atrás
        "antigo2.png": "2026-11-19T12:00:00.000Z",
        "recente.pdf": None,                             # preenchido no setUp (minutos atrás)
        "sem_data.pdf": None,                            # a API não informou a data
        "com_conta.pdf": "2026-11-18T12:00:00.000Z",     # referenciado por uma conta
    }

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="purge_test_")
        self.addCleanup(self.tmp.cleanup)
        self.log_dir = Path(self.tmp.name) / "logs"
        agora = datetime.now(timezone.utc)
        self.objetos = dict(self.OBJETOS)
        self.objetos["recente.pdf"] = (agora - timedelta(minutes=4)).isoformat()
        self.removidos: list = []
        self.registro_no_delete: list = []

    def _rest(self, path, order="id"):
        tabela = path.split("?")[0]
        return {
            "financial_account_attachment": [{"storage_key": "com_conta.pdf"}],
            "financial_account_control": [],
            "fiscal_document": [],
            "email_control": [],
            "email_processing_errors": [],
        }[tabela]

    def _remove(self, keys):
        # No instante do DELETE o registro JÁ tem de existir.
        self.registro_no_delete.append(sorted(p.name for p in self.log_dir.glob("*.txt")))
        self.removidos.extend(keys)
        return len(keys)

    def _roda(self, *argv, rest=None, registro=None, inspeciona=None):
        inspeciona = inspeciona or mock.MagicMock(return_value=False)
        patches = [
            mock.patch.object(PG, "BASE", "https://fake.supabase.co"),
            mock.patch.object(PG, "KEY", "x"),
            mock.patch.object(PG, "PURGE_LOG_DIR", self.log_dir),
            mock.patch.object(PG, "_storage_list", return_value=self.objetos),
            mock.patch.object(PG, "_rest", rest or self._rest),
            mock.patch.object(PG, "_tem_chave_fiscal", inspeciona),
            mock.patch.object(PG, "_storage_remove", self._remove),
            mock.patch.object(sys, "argv", ["purge_orphan_attachments.py", *argv]),
        ]
        if registro is not None:
            patches.append(mock.patch.object(PG, "_grava_registro", registro))
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.inspeciona = inspeciona
        return PG.main()

    def _registros(self) -> list:
        return sorted(self.log_dir.glob("purge_orphans_*.txt")) if self.log_dir.exists() else []

    def test_apaga_o_orfao_antigo_e_preserva_o_recente_e_o_sem_data(self):
        self.assertEqual(self._roda(), 0)
        self.assertEqual(sorted(self.removidos), ["antigo.pdf", "antigo2.png"])
        # 🔴 O recente pode ser de um run em andamento; o sem data, não dá para saber.
        self.assertNotIn("recente.pdf", self.removidos)
        self.assertNotIn("sem_data.pdf", self.removidos)
        self.assertNotIn("com_conta.pdf", self.removidos)

    def test_o_recente_nem_e_baixado_para_inspecao(self):
        self._roda()
        inspecionados = sorted(c.args[0] for c in self.inspeciona.call_args_list)
        self.assertEqual(inspecionados, ["antigo.pdf", "antigo2.png"])

    def test_o_registro_lista_tudo_e_existe_antes_do_primeiro_delete(self):
        self._roda()
        (registro,) = self._registros()
        dados = registro.read_bytes()
        self.assertNotIn(b"\r", dados)                       # LF, mesmo no Windows
        chaves = [ln for ln in dados.decode("utf-8").splitlines() if not ln.startswith("#")]
        self.assertEqual(sorted(chaves), ["antigo.pdf", "antigo2.png"])
        self.assertEqual(self.registro_no_delete, [[registro.name]])

    def test_sem_conseguir_gravar_o_registro_nao_apaga(self):
        falha = mock.MagicMock(side_effect=OSError("disco cheio"))
        with self.assertLogs(PG.log, level="ERROR") as logs:
            codigo = self._roda(registro=falha)
        self.assertEqual((codigo, self.removidos), (1, []))
        self.assertTrue(any("NADA foi apagado" in linha for linha in logs.output))

    def test_dry_run_nao_apaga_nem_grava_registro(self):
        self.assertEqual(self._roda("--dry-run"), 0)
        self.assertEqual(self.removidos, [])
        self.assertEqual(self._registros(), [])
        # A inspeção de conteúdo roda também no dry-run (o relatório não pode mentir).
        self.assertEqual(self.inspeciona.call_count, 2)

    def test_so_recentes_nao_ha_o_que_remover(self):
        agora = datetime.now(timezone.utc).isoformat()
        self.objetos = {"a.pdf": agora, "b.pdf": None}
        self.assertEqual(self._roda(), 0)
        self.assertEqual((self.removidos, self._registros()), ([], []))

    def test_leitura_incompleta_aborta_sem_apagar(self):
        def _rest_quebrado(path, order="id"):
            raise PG.RestError("email_control: falha de rede")

        with self.assertLogs(PG.log, level="ERROR"):
            codigo = self._roda(rest=_rest_quebrado)
        self.assertEqual((codigo, self.removidos, self._registros()), (1, [], []))


class UltimaEscritaTest(unittest.TestCase):
    """`supabase_rest.storage_list(com_ultima_escrita=True)` — a fonte da data usada na purga."""

    def _lista(self, paginas, **kwargs):
        from contextlib import contextmanager
        import json as _json
        chamadas = []

        @contextmanager
        def fake(req, **_):
            chamadas.append(req)
            corpo = paginas[min(len(chamadas) - 1, len(paginas) - 1)]

            class _R:
                @staticmethod
                def read():
                    return _json.dumps(corpo).encode()
            yield _R()

        with mock.patch.object(SR.urllib.request, "urlopen", fake):
            resultado = SR.storage_list("http://fake", {}, "attachments", **kwargs)
        return resultado, chamadas

    def test_usa_a_ultima_escrita_e_nao_a_criacao(self):
        # Upload que SOBRESCREVE a chave muda só o `updated_at`: é ele que diz "mexeram agora".
        pagina = [
            {"name": "sobrescrito.pdf", "id": "1", "created_at": "2026-06-22T09:21:06.275Z",
             "updated_at": "2026-11-24T14:58:00.000Z"},
            {"name": "so_criacao.pdf", "id": "2", "created_at": "2026-07-01T00:00:00.000Z"},
            {"name": "sem_data.pdf", "id": "3"},
            {"name": "manual", "id": None, "updated_at": "2026-11-24T14:58:00.000Z"},
        ]
        escrita, _ = self._lista([pagina], com_ultima_escrita=True)
        self.assertEqual(escrita, {"sobrescrito.pdf": "2026-11-24T14:58:00.000Z",
                                   "so_criacao.pdf": "2026-07-01T00:00:00.000Z",
                                   "sem_data.pdf": None})

    def test_o_modo_novo_tambem_pagina(self):
        cheia = [{"name": f"f{i}.pdf", "id": str(i), "updated_at": "2026-01-01T00:00:00Z"}
                 for i in range(SR.PAGE_SIZE)]
        escrita, chamadas = self._lista([cheia, [{"name": "ultimo.pdf", "id": "x"}]],
                                        com_ultima_escrita=True)
        self.assertEqual((len(escrita), len(chamadas)), (SR.PAGE_SIZE + 1, 2))
        self.assertIn("ultimo.pdf", escrita)

    def test_os_modos_antigos_nao_mudaram(self):
        pagina = [{"name": "a.pdf", "id": "1", "metadata": {"size": 7},
                   "updated_at": "2026-01-01T00:00:00Z"}]
        nomes, _ = self._lista([pagina])
        meta, _ = self._lista([pagina], com_metadata=True)
        self.assertEqual((nomes, meta), (["a.pdf"], {"a.pdf": {"size": 7}}))

    def test_a_purga_pede_a_ultima_escrita(self):
        with mock.patch.object(PG, "storage_list", return_value={}) as lista:
            PG._storage_list()
        self.assertIs(lista.call_args.kwargs.get("com_ultima_escrita"), True)


if __name__ == "__main__":
    unittest.main()
