"""
failure_notify.py -- Notificação de falhas de cobrança ao representante (CC).

Quando a cobrança a um cliente NÃO sai por uma falha DEFINITIVA (exige ação humana),
o representante copiado no título (CC) recebe, ao fim do batch diário, UM resumo com
seus títulos que falharam: cliente, título, vencimento, valor e o motivo.

Só falhas definitivas entram: transitórias (smtp_falha/timeout) re-tentam sozinhas no
próximo run e não devem gerar ruído. Decisão do usuário (2026-06-22): resumo por CC,
apenas no batch diário.
"""

from __future__ import annotations

import html
from datetime import date
from decimal import Decimal, InvalidOperation

# Falhas que EXIGEM ação humana -> notificam o CC. As transitórias ficam de fora.
DEFINITIVE_ERROR_TYPES = frozenset({"email_ausente", "email_invalido", "smtp_bloqueio"})


def group_by_cc(failures: list[dict]) -> dict[str, list[dict]]:
    """Agrupa as falhas por cc_email. Falhas SEM CC são ignoradas (não há quem notificar)."""
    by_cc: dict[str, list[dict]] = {}
    for f in failures:
        cc = (f.get("cc_email") or "").strip()
        if cc:
            by_cc.setdefault(cc, []).append(f)
    return by_cc


def build_subject(n: int) -> str:
    return f"Cobranças não enviadas — ação necessária ({n} título{'s' if n != 1 else ''})"


def _fmt_due(v) -> str:
    return v.strftime("%d/%m/%Y") if isinstance(v, date) else str(v or "")


def _fmt_amount(v) -> str:
    try:
        return f"R$ {Decimal(str(v)):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    except (InvalidOperation, ValueError, TypeError):
        return str(v or "")


def _td(value: str, *, right: bool = False) -> str:
    align = "right" if right else "left"
    return (f"<td style='padding:6px 10px;border:1px solid #ccc;text-align:{align};'>"
            f"{html.escape(value)}</td>")


def render_failure_digest(failures: list[dict]) -> str:
    """HTML do resumo de falhas de UM representante. `failures` = dicts com
    customer_name, document_id, due_date, bill_amount, motivo."""
    linhas = "".join(
        "<tr>"
        + _td(str(f.get("customer_name") or "—"))
        + _td(str(f.get("document_id") or "—"))
        + _td(_fmt_due(f.get("due_date")))
        + _td(_fmt_amount(f.get("bill_amount")), right=True)
        + _td(str(f.get("motivo") or "—"))
        + "</tr>"
        for f in failures
    )
    return f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:'Times New Roman',serif;color:#000000;">
<div style="max-width:760px;margin:0 auto;padding:24px;">
  <p>Olá,</p>
  <p>As cobranças abaixo <strong>não puderam ser enviadas ao cliente</strong> e precisam de
     atenção (ex.: cliente sem e-mail cadastrado ou e-mail recusado pelo destino).</p>
  <table style="border-collapse:collapse;width:100%;font-size:11pt;">
    <thead>
      <tr style="background-color:#f0f0f0;">
        <th style="padding:6px 10px;border:1px solid #ccc;text-align:left;">Cliente</th>
        <th style="padding:6px 10px;border:1px solid #ccc;text-align:left;">Título</th>
        <th style="padding:6px 10px;border:1px solid #ccc;text-align:left;">Vencimento</th>
        <th style="padding:6px 10px;border:1px solid #ccc;text-align:right;">Valor</th>
        <th style="padding:6px 10px;border:1px solid #ccc;text-align:left;">Motivo</th>
      </tr>
    </thead>
    <tbody>{linhas}</tbody>
  </table>
  <p>Após corrigir o cadastro (ex.: informar o e-mail do cliente), a cobrança volta ao fluxo
     automático no próximo envio.</p>
  <p>Att<br>Departamento Financeiro</p>
</div></body></html>"""
