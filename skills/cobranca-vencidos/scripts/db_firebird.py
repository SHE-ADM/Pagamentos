"""
db_firebird.py
Conexão com Firebird 5 e execução da query de títulos vencidos.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

logger = logging.getLogger(__name__)

@dataclass
class TituloVencido:
    document_id:    str
    due_date:       date
    bill_amount:    Decimal
    customer_name:  str
    primary_email:  str
    cc_email:       str | None
    email_subject:  str

_QUERY = """
SELECT
    PK.FIN_CLI_GP_NO,
    PK.FIN_TITULO    AS DOCUMENT_ID,
    PK.FIN_VCT_DATA  AS DUE_DATE,
    PK.FIN_VDUP      AS BILL_AMOUNT,
    PK.FIN_CLI_NO    AS CUSTOMER_NAME,
    PK.FIN_CLI_EMAIL AS PRIMARY_EMAIL,
    PK.FIN_VEN_EMAIL AS CC_EMAIL,
    'COBRANÇA' || ' ' || PK.FIN_EMP_NO AS EMAIL_SUBJECT
FROM VW_PSQ_FIN_REC_BAN PK
WHERE PK.FIN_STF_NO = 'VENCIDO'
  AND PK.FIN_VCT_DATA >= CURRENT_DATE - 7
  AND COALESCE(PK.FIN_CLI_GP_NO,'') <> 'INBRANDS'
  AND COALESCE(PK.FIN_CLI_GP_NO,'') <> 'RESTOQUE'
  AND COALESCE(PK.FIN_CLI_GP_NO,'') <> 'SHOULDER'
  AND COALESCE(PK.FIN_CLI_GP_NO,'') <> 'SKAI'
  AND COALESCE(PK.FIN_CLI_GP_NO,'') <> 'SOMA'
  AND COALESCE(PK.FIN_CLI_GP_NO,'') <> 'LOJAS MEL'
UNION ALL
SELECT
    PK.FIN_CLI_GP_NO,
    PK.FIN_TITULO    AS DOCUMENT_ID,
    PK.FIN_VCT_DATA  AS DUE_DATE,
    PK.FIN_VDUP      AS BILL_AMOUNT,
    PK.FIN_CLI_NO    AS CUSTOMER_NAME,
    PK.FIN_CLI_EMAIL AS PRIMARY_EMAIL,
    PK.FIN_VEN_EMAIL AS CC_EMAIL,
    'COBRANÇA' || ' ' || PK.FIN_EMP_NO AS EMAIL_SUBJECT
FROM VW_PSQ_FIN_REC_BAN_004 PK
WHERE PK.FIN_STF_NO = 'VENCIDO'
  AND PK.FIN_VCT_DATA >= CURRENT_DATE - 7
  AND COALESCE(PK.FIN_CLI_GP_NO,'') <> 'INBRANDS'
  AND COALESCE(PK.FIN_CLI_GP_NO,'') <> 'RESTOQUE'
  AND COALESCE(PK.FIN_CLI_GP_NO,'') <> 'SHOULDER'
  AND COALESCE(PK.FIN_CLI_GP_NO,'') <> 'SKAI'
  AND COALESCE(PK.FIN_CLI_GP_NO,'') <> 'SOMA'
  AND COALESCE(PK.FIN_CLI_GP_NO,'') <> 'LOJAS MEL'
ORDER BY 2
"""

def _get_driver():
    try:
        import fdb; return fdb
    except ImportError: pass
    try:
        import firebirdsql as fdb; return fdb
    except ImportError:
        raise ImportError("Nenhum driver Firebird. Instale: .venv\\Scripts\\pip install fdb")

def _has_email(titulo: TituloVencido) -> bool:
    """Critério default de "e-mail enviável": só a presença. O run injeta a validação real
    (`send_core.validate_email`) — esta camada não depende do módulo de envio."""
    return bool(titulo.primary_email)


def _dedupe_by_document_id(
    rows: list[TituloVencido],
    is_sendable: Callable[[TituloVencido], bool] = _has_email,
) -> list[TituloVencido]:
    """Uma linha por título, preservando a ordem da query.

    O UNION ALL entre VW_PSQ_FIN_REC_BAN e _004 devolve o MESMO título quando ele consta
    nas duas views (caso real 245821-D, 2026-09-29). O envio já era barrado pelo
    cobranca_envios_log, mas a duplicata inflava total/pulados, aparecia duas vezes no
    dry-run e, sem e-mail, gravaria DOIS erros e dois itens no aviso ao vendedor.

    Não se troca por UNION (DISTINCT): ele só funde linhas idênticas em TODAS as colunas,
    e as views podem divergir no e-mail/CC do mesmo título. Entre duplicatas vence a
    primeira — salvo quando ela não é enviável e a outra é (`is_sendable`): uma view com
    "@gemail.com" e a outra com "@gmail.com" deve cobrar pelo endereço certo, não virar erro.
    """
    by_doc: dict[str, int] = {}
    unique: list[TituloVencido] = []
    dropped = 0
    for t in rows:
        idx = by_doc.get(t.document_id)
        if idx is None:
            by_doc[t.document_id] = len(unique)
            unique.append(t)
            continue
        dropped += 1
        kept = unique[idx]
        if (kept.primary_email, kept.cc_email, kept.bill_amount, kept.due_date) != \
           (t.primary_email, t.cc_email, t.bill_amount, t.due_date):
            logger.warning(
                "Título %s duplicado com dados DIVERGENTES entre as views "
                "(e-mail %r x %r, CC %r x %r, valor %s x %s, vencimento %s x %s).",
                t.document_id, kept.primary_email, t.primary_email, kept.cc_email,
                t.cc_email, kept.bill_amount, t.bill_amount, kept.due_date, t.due_date,
            )
        if not is_sendable(kept) and is_sendable(t):
            unique[idx] = t
    if dropped:
        logger.info("Firebird: %d linha(s) duplicada(s) por título descartada(s).", dropped)
    return unique


def fetch_titulos_vencidos(
    is_sendable: Callable[[TituloVencido], bool] = _has_email,
) -> list[TituloVencido]:
    """Títulos vencidos, UMA linha por título. `is_sendable` decide qual duplicata fica."""
    fdb = _get_driver()
    dsn = f"{os.environ['FB_HOST']}/{int(os.environ.get('FB_PORT','3050'))}:{os.environ['FB_DATABASE']}"
    logger.info("Conectando Firebird: %s", dsn)
    con = fdb.connect(dsn=dsn, user=os.environ['FB_USER'], password=os.environ['FB_PASSWORD'], charset=os.environ.get('FB_CHARSET','WIN1252'))
    try:
        cur = con.cursor(); cur.execute(_QUERY)
        rows = []
        for row in cur.fetchall():
            # A 1ª coluna (FIN_CLI_GP_NO, grupo econômico) não é consumida pelo envio.
            _grupo, d, dt, amt, nm, mail, cc, subj = row
            # Só descarta linha SEM título (document_id) — inutilizável (sem chave de
            # dedup/registro). Linha SEM e-mail SEGUE adiante para virar "email_ausente"
            # em /cobranca/erros: cliente vencido sem e-mail é problema acionável, não some.
            if not d:
                logger.warning("Linha sem título (document_id) ignorada: %s", row)
                continue
            rows.append(TituloVencido(
                document_id=str(d).strip(),
                due_date=dt,
                bill_amount=Decimal(str(amt)) if amt else Decimal('0'),
                customer_name=str(nm).strip() if nm else '',
                primary_email=str(mail).strip() if mail else '',  # nulo/None -> '' (vira email_ausente)
                cc_email=str(cc).strip() if cc else None,
                email_subject=str(subj).strip() if subj else 'COBRANÇA',
            ))
        rows = _dedupe_by_document_id(rows, is_sendable)
        logger.info("Firebird: %d títulos vencidos", len(rows))
        return rows
    finally: con.close()
