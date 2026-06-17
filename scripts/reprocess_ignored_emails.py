"""
reprocess_ignored_emails.py — Reprocessa e-mails afetados pela ampliacao do
filtro de assunto (acronimos de tributo casando por palavra inteira) e pela
regra de NF-e "pura".

Duas fases independentes:

  A) 'ignorado' que agora CASAM uma keyword (ex.: DAS/IPVA/ISS como palavra
     inteira). Rebusca o e-mail no IMAP pelo Message-ID e roda o pipeline
     completo (anexo -> link -> corpo) via read_emails.process_message, gerando
     a conta a pagar. Como register() ignora duplicatas, a linha 'ignorado'
     antiga e REMOVIDA antes para o status correto ser regravado.

  B) NF-e "pura" (assunto NF-e/NFS-e sem indicio de pagavel) que esta fora de
     'ignorado' e NAO gerou conta a pagar: apenas atualiza o status -> 'ignorado'
     (sem IMAP), alinhando ao novo status_for_result. E-mails com boleto/fatura
     no assunto (subject_is_pure_nfe=False) sao preservados para revisao.

Uso:
    py -3 scripts/reprocess_ignored_emails.py --dry-run   # so lista o que faria
    py -3 scripts/reprocess_ignored_emails.py             # aplica
"""

import os, sys, json, argparse, logging, urllib.request
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parents[1]
load_dotenv(BASE_DIR / ".env")
sys.path.insert(0, str(BASE_DIR / "skills" / "email-reader" / "scripts"))
import read_emails as R  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout)])
log = logging.getLogger("reprocess-ignored")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _keywords() -> list:
    """Mesma fonte do run_reader: EMAIL_KEYWORDS (.env) ou KEYWORDS_DEFAULT."""
    kw_env = os.getenv("EMAIL_KEYWORDS", "")
    return [k.strip() for k in kw_env.split(",")] if kw_env else R.KEYWORDS_DEFAULT


def _get(ctrl, path: str) -> list:
    req = urllib.request.Request(ctrl.base + "/rest/v1/" + path, headers=ctrl.headers)
    return json.loads(urllib.request.urlopen(req, timeout=20).read())


def _delete_email_control(ctrl, ec_id: int) -> None:
    req = urllib.request.Request(
        ctrl.base + f"/rest/v1/email_control?id=eq.{ec_id}",
        method="DELETE", headers={**ctrl.headers, "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=15)


def _set_ignored(ctrl, ec_id: int, note: str) -> None:
    body = json.dumps({"status": "ignorado", "notes": note}).encode()
    req = urllib.request.Request(
        ctrl.base + f"/rest/v1/email_control?id=eq.{ec_id}",
        data=body, method="PATCH",
        headers={**ctrl.headers, "Prefer": "return=minimal"})
    urllib.request.urlopen(req, timeout=15)


def _find_uid(mail, message_id: str) -> "bytes | None":
    _, data = mail.uid("search", None, "HEADER", "Message-ID", message_id)
    uids = (data[0] or b"").split()
    return uids[-1] if uids else None


# Message-IDs que o usuario marcou explicitamente para 'ignorado' (avisos que
# nenhuma regra de assunto pega — ex.: alerta de protesto/SPC).
EXPLICIT_IGNORE_IDS = frozenset({
    "<010d019ecb578947-75e14f59-03d5-4e1c-9750-fe92ec2c983e-000000@ca-central-1.amazonses.com>",
    "<178141067126.3156.9499819598040139061@otimotex.com.br>",
    "<d400380c-54e7-4990-a78c-b8017a9ba431@transminuano.com.br>",
    # Avisos/oferta sem termo de assunto generalizavel (marcados manualmente):
    "<CACV6zXcZ+6=AuRDVNFOtwbqWa4fQQBTuR040jcotXtH4zyeHJA@mail.gmail.com>",  # Fwd: Fretes (oferta)
    "<671F5CD1-FD5B-4E08-9590-09542AA45218@ssw.inf.br>",                     # NOVA AREA DO CLIENTE
    "<B66E11DF-847F-4C99-B817-2188CDA52CBB@ssw.inf.br>",                     # Taxa de Agendamento
})


# ---------------------------------------------------------------------------
# Fase A — 'ignorado' que agora casam keyword -> reprocessa via IMAP
# ---------------------------------------------------------------------------
def _phase_a_candidates(rows: list, keywords: list) -> list:
    """'ignorado' que casam keyword MAS nao sao notificacao/NF-e pura nem estao na
    lista explicita — i.e., avisos antes ignorados por falta de keyword que agora
    casam um acronimo novo (ex.: DAS) e podem gerar conta a pagar."""
    hits = []
    for r in rows:
        subj = r.get("subject") or ""
        if (r.get("message_id") or "") in EXPLICIT_IGNORE_IDS:
            continue
        if R.subject_is_pure_nfe(subj) or R.subject_is_ignorable_notification(subj):
            continue
        kw = R.match_keyword(subj, keywords)
        if kw:
            hits.append((r, kw))
    return hits


def _reprocess_hit(mail, ctrl, keywords: list, r: dict) -> None:
    uid = _find_uid(mail, r["message_id"])
    if not uid:
        log.warning(f"    id={r['id']} — Message-ID nao encontrado no IMAP, pulado")
        return
    _delete_email_control(ctrl, r["id"])                   # regrava com status real
    rec = R.process_message(mail, uid, keywords, False, False, ctrl)
    log.info(f"    id={r['id']} -> status={rec.get('status') if rec else '?'}")


def phase_a(ctrl, keywords: list, dry_run: bool) -> None:
    rows = _get(ctrl, "email_control?status=eq.ignorado"
                      "&select=id,message_id,subject&order=received_at")
    hits = _phase_a_candidates(rows, keywords)
    log.info(f"[A] 'ignorado' que passam a casar keyword: {len(hits)}")
    for r, kw in hits:
        log.info(f"    id={r['id']} kw={kw!r} — {(r.get('subject') or '')[:60]}")
    if dry_run or not hits:
        return

    mail = R._connect_imap()
    try:
        for r, _kw in hits:
            _reprocess_hit(mail, ctrl, keywords, r)
    finally:
        try:
            mail.logout()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Fase B — NF-e "pura" sem conta a pagar, fora de 'ignorado' -> 'ignorado'
# ---------------------------------------------------------------------------
def _accounts_message_ids(ctrl) -> set:
    """Conjunto de message_ids (sufixo #N removido) que possuem conta a pagar."""
    rows = _get(ctrl, "financial_account_control?select=gmail_message_id&limit=10000")
    out = set()
    for r in rows:
        gmid = r.get("gmail_message_id") or ""
        out.add(gmid.split("#", 1)[0])
    return out


def _ignore_reason(r: dict, has_account: bool) -> "str | None":
    """Motivo p/ reclassificar o e-mail como 'ignorado', ou None se deve ficar.
    Regra: conta a pagar gerada nunca vira 'ignorado'."""
    if has_account:
        return None
    subject = r.get("subject") or ""
    if (r.get("message_id") or "") in EXPLICIT_IGNORE_IDS:
        return "Marcado manualmente como ignorado (Message-ID)"
    if R.subject_is_pure_nfe(subject):
        return "NF-e/NFS-e sem conta a pagar (reclassificacao)"
    # Notificacao (aviso/confirmacao/informe/SIEG) so vale SEM anexo — com anexo,
    # o PDF deve ser revisado (pendente), nao ignorado.
    if not r.get("has_attachment") and R.subject_is_ignorable_notification(subject):
        return "Notificacao sem anexo/conta no corpo (reclassificacao)"
    return None


def phase_b(ctrl, dry_run: bool) -> None:
    rows = _get(ctrl, "email_control?status=neq.ignorado"
                      "&select=id,message_id,subject,status,has_attachment&order=received_at")
    with_account = _accounts_message_ids(ctrl)
    candidates = []
    for r in rows:
        has_acc = (r.get("message_id") or "").split("#", 1)[0] in with_account
        reason = _ignore_reason(r, has_acc)
        if reason:
            candidates.append((r, reason))

    log.info(f"[B] e-mails a reclassificar -> 'ignorado': {len(candidates)}")
    for r, reason in candidates:
        log.info(f"    id={r['id']} ({r['status']}) — {(r.get('subject') or '')[:55]} [{reason[:28]}]")
    if dry_run:
        return
    for r, reason in candidates:
        _set_ignored(ctrl, r["id"], reason)


def main() -> None:
    ap = argparse.ArgumentParser(description="Reprocessa 'ignorado' (keyword nova) e NF-e pura.")
    ap.add_argument("--dry-run", action="store_true", help="apenas lista, nao grava")
    args = ap.parse_args()

    ctrl = R.SupabaseControl()
    if not ctrl._available:
        log.error("Supabase indisponivel (SUPABASE_URL/SUPABASE_SERVICE_KEY). Abortando.")
        sys.exit(1)

    keywords = _keywords()
    log.info(f"{'DRY-RUN' if args.dry_run else 'EXECUCAO'} — {len(keywords)} keywords")
    phase_a(ctrl, keywords, args.dry_run)
    phase_b(ctrl, args.dry_run)
    log.info("Concluido.")


if __name__ == "__main__":
    main()
