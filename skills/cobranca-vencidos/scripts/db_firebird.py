"""
db_firebird.py
Conexão com Firebird 5 e execução da query de títulos vencidos.
"""

from __future__ import annotations

import logging
import os
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

def fetch_titulos_vencidos() -> list[TituloVencido]:
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
        logger.info("Firebird: %d títulos vencidos", len(rows))
        return rows
    finally: con.close()
