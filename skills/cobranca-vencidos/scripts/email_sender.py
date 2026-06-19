"""
email_sender.py
Composição e envio de email de cobrança via SMTP Locaweb.
Remetente: campo `email` da tabela `company` no Supabase (ex.: financeiro@otimotex.com.br).
Senha do mailbox: variável `SMTP_PASSWORD` no .env (segredo nunca vai para o banco).
Host/porta/nome: default Locaweb (smtp.locaweb.com.br:587), com override opcional por .env
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM_NAME`, `SMTP_USER`).
"""

from __future__ import annotations

import logging
import os
import smtplib
import ssl
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

logger = logging.getLogger(__name__)
_SIGNATURE_PATH = Path(__file__).parent.parent / "assets" / "signature.png"

def _load_smtp_config(company_row: dict | None) -> dict:
    # Remetente: campo `email` da tabela company (financeiro@otimotex.com.br) — o MESMO
    # mailbox usado para recebimento (IMAP). Por isso a senha SMTP reusa `IMAP_PASS` do
    # .env quando `SMTP_PASSWORD` não está definido — sem duplicar segredo. Host/porta/
    # nome têm default Locaweb e aceitam override por .env; `SMTP_USER` só é necessário
    # se o login do mailbox diferir do endereço remetente.
    row = company_row or {}
    sender = row.get("email") or os.environ.get("SMTP_USER") or os.environ.get("IMAP_USER", "")
    from_name = (
        os.environ.get("SMTP_FROM_NAME")
        or row.get("trade_name")
        or row.get("legal_name")
        or "Departamento Financeiro"
    )
    return {
        # Mesmo servidor de e-mail do recebimento (IMAP_HOST = email-ssl.com.br na
        # Locaweb). `smtp.locaweb.com.br` não atende esta conta (timeout). Override
        # explícito via SMTP_HOST tem prioridade.
        "host": os.environ.get("SMTP_HOST") or os.environ.get("IMAP_HOST") or "email-ssl.com.br",
        "port": int(os.environ.get("SMTP_PORT", "587")),
        "user": os.environ.get("SMTP_USER") or sender,
        "password": os.environ.get("SMTP_PASSWORD") or os.environ.get("IMAP_PASS", ""),
        "from_name": from_name,
        "from_addr": sender,
    }

def send_cobranca(*,to_email:str,cc_email:str|None,subject:str,html_body:str,company_row:dict|None,dev_mode:bool=False,dev_override:str="")->None:
    smtp = _load_smtp_config(company_row)
    if dev_mode:
        # Em teste: To vai para DEV_OVERRIDE_EMAIL; a CÓPIA (Cc) vai para
        # DEV_OVERRIDE_CC_EMAIL (se definido), permitindo validar o Cc numa caixa
        # separada. Só adiciona Cc quando o título original tem cópia.
        actual_to=dev_override
        actual_cc=(os.environ.get("DEV_OVERRIDE_CC_EMAIL","").strip() or dev_override) if cc_email else None
        logger.info("[DEV] orig To=%s Cc=%s -> teste To=%s Cc=%s",to_email,cc_email,actual_to,actual_cc)
    else:
        actual_to=to_email; actual_cc=cc_email
    msg=MIMEMultipart("related")
    msg["Subject"]=subject; msg["From"]=f"{smtp['from_name']} <{smtp['from_addr']}>"; msg["To"]=actual_to
    if actual_cc: msg["Cc"]=actual_cc
    msg.attach(MIMEText(html_body,"html","utf-8"))
    if _SIGNATURE_PATH.exists():
        with open(_SIGNATURE_PATH,"rb") as f: img=MIMEImage(f.read())
        img.add_header("Content-ID","<signature>"); img.add_header("Content-Disposition","inline",filename="signature.png"); msg.attach(img)
    ctx=ssl.create_default_context()
    raw=msg.as_string()
    logger.info("Enviando email: to=%s via %s",to_email,smtp["host"])
    with smtplib.SMTP(smtp["host"],smtp["port"],timeout=30) as s:
        s.ehlo(); s.starttls(context=ctx); s.login(smtp["user"],smtp["password"])
        # 1) Envia o PRINCIPAL (To). Se falhar, a exceção propaga e o fluxo aborta AQUI —
        #    a cópia (Cc) NÃO é enviada quando o e-mail principal falha.
        s.sendmail(smtp["from_addr"],[actual_to],raw)
        # 2) Principal aceito -> envia a CÓPIA (Cc), se houver. Falha só no Cc não invalida
        #    o envio principal (apenas registra aviso; o título conta como enviado).
        if actual_cc:
            try:
                s.sendmail(smtp["from_addr"],[actual_cc],raw)
            except smtplib.SMTPException as cc_exc:
                logger.warning("Cópia (Cc) não entregue para %s (principal OK): %s",actual_cc,cc_exc)
    logger.info("Email enviado com sucesso -> %s",actual_to)
