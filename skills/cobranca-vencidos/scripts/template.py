"""
template.py -- Template HTML do email de cobrança
"""
from __future__ import annotations
from datetime import date
from decimal import Decimal
from html import escape

def render_html(customer_name:str, document_id:str, bill_amount:Decimal, due_date:date) -> str:
    due_fmt = due_date.strftime("%d/%m/%Y") if isinstance(due_date,date) else str(due_date)
    amt_fmt = f"R$ {bill_amount:,.2f}".replace(",","X").replace(".",",").replace("X",".")
    # Escapa os campos vindos do Firebird (nome/título) antes de interpolar no HTML —
    # evita HTML/script injection no e-mail enviado ao cliente (cadastro hostil/acidental).
    name = escape(str(customer_name) if customer_name is not None else "")
    doc = escape(str(document_id) if document_id is not None else "")
    return f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:'Times New Roman',serif;color:#000000;">
<div style="max-width:680px;margin:0 auto;padding:24px;">
  <p>Bom dia,<br><strong>{name}</strong></p>
  <p>O(s) título(s) abaixo consta(m) em aberto em nosso sistema, favor verificar.</p>
  <p style="background-color:#FF0000;color:#FFFFFF;padding:6px 10px;display:inline-block;">Caso já tenha efetuado o pagamento do(s) mesmo(s), favor desconsiderar essa mensagem.</p>
  <p>Título <strong>({doc})</strong> no valor de <strong>({amt_fmt})</strong> vencido no dia <strong>({due_fmt})</strong></p>
  <p>Tenha um ótimo dia.</p>
  <p style="font-size:14pt;font-weight:bold;">Em caso de dúvidas, entre em contato com seu representante ou com o vendedor responsável, que está copiado neste e-mail.</p>
  <p>Att</p>
  <img src="cid:signature" alt="Departamento Financeiro | Otimotex / Le Bianco" width="349" style="max-width:100%;"/>
</div></body></html>"""
