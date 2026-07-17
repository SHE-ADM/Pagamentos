"""
supabase_log.py
Duas tabelas separadas no Supabase:
  - cobranca_envios_log  -> emails enviados com sucesso
  - cobranca_erros_log   -> falhas categorizadas com motivo
"""
from __future__ import annotations
import logging, os, traceback
from datetime import date
from decimal import Decimal
from typing import Literal
import httpx
logger = logging.getLogger(__name__)
ErrorType = Literal["email_ausente","email_invalido","smtp_falha","smtp_bloqueio","supabase_falha","firebird_falha","erro_inesperado"]

def _headers():
    return {"apikey":os.environ["SUPABASE_SERVICE_KEY"],"Authorization":f"Bearer {os.environ['SUPABASE_SERVICE_KEY']}","Content-Type":"application/json","Prefer":"return=minimal"}

def _base_url(): return os.environ["SUPABASE_URL"].rstrip("/")+"/rest/v1"

def _fmt_date(d):
    if d is None: return None
    return d.isoformat() if isinstance(d,date) else str(d)

def already_sent(document_id:str)->bool:
    try:
        r=httpx.get(f"{_base_url()}/cobranca_envios_log",headers=_headers(),params={"document_id":f"eq.{document_id}","select":"id","limit":"1"},timeout=10)
        r.raise_for_status(); return len(r.json())>0
    except Exception as e:
        # Falha na CHECAGEM de duplicidade não é um erro de cobrança — não vai para
        # cobranca_erros_log. Apenas registra um aviso e segue (retorna False).
        logger.warning("Não foi possível verificar duplicidade de %s; seguindo. (%s)", document_id, e)
        return False

def log_envio_sucesso(*,document_id,customer_name,primary_email,cc_email,due_date,bill_amount,email_subject):
    hdr={**_headers(),"Prefer":"resolution=merge-duplicates,return=minimal"}
    pay={"document_id":document_id,"customer_name":customer_name,"primary_email":primary_email,"cc_email":cc_email,"due_date":_fmt_date(due_date),"bill_amount":float(bill_amount),"email_subject":email_subject}
    try:
        r=httpx.post(f"{_base_url()}/cobranca_envios_log",headers=hdr,json=pay,timeout=10); r.raise_for_status()
    except Exception as e:
        logger.exception("Falha envios_log %s: %s",document_id,e)
        log_envio_erro(error_type="supabase_falha",error_message="A cobrança foi enviada, mas houve falha ao registrar o envio no sistema.",document_id=document_id,customer_name=customer_name,primary_email=primary_email,cc_email=cc_email,due_date=due_date,bill_amount=bill_amount,email_subject=email_subject,error_detail=f"{e}\n\n{traceback.format_exc()}")

def log_envio_erro(*,error_type:ErrorType,error_message:str,document_id=None,customer_name=None,primary_email=None,cc_email=None,due_date=None,bill_amount=None,email_subject=None,error_detail=None):
    pay={"error_type":error_type,"error_message":error_message}
    if document_id is not None: pay["document_id"]=document_id
    if customer_name is not None: pay["customer_name"]=customer_name
    if primary_email is not None: pay["primary_email"]=primary_email
    if cc_email is not None: pay["cc_email"]=cc_email
    if due_date is not None: pay["due_date"]=_fmt_date(due_date)
    if bill_amount is not None: pay["bill_amount"]=float(bill_amount)
    if email_subject is not None: pay["email_subject"]=email_subject
    if error_detail is not None: pay["error_detail"]=error_detail
    try:
        r=httpx.post(f"{_base_url()}/cobranca_erros_log",headers=_headers(),json=pay,timeout=10); r.raise_for_status()
    except Exception as e: logger.exception("Falha CRITICA erros_log %s: %s",document_id,e)

def fetch_erro_rows(ids:list[int])->list[dict]:
    # Busca linhas de cobranca_erros_log por id (para o reenvio manual via /cobranca/erros).
    # Retorna só os campos necessários para reconstruir o e-mail — não depende do Firebird.
    if not ids: return []
    id_list=",".join(str(int(i)) for i in ids)
    r=httpx.get(f"{_base_url()}/cobranca_erros_log",headers=_headers(),params={"id":f"in.({id_list})","select":"id,document_id,customer_name,primary_email,cc_email,due_date,bill_amount,email_subject,error_type"},timeout=15)
    r.raise_for_status(); return r.json()

def delete_erro_rows(ids:list[int])->None:
    # Remove linhas de cobranca_erros_log por id. Usado pelo reenvio manual: todo título
    # reenviado com SUCESSO (ou que já constava enviado) sai do log de erros — a tabela
    # passa a refletir só falhas pendentes. service_role ignora RLS.
    if not ids: return
    id_list=",".join(str(int(i)) for i in ids)
    r=httpx.delete(f"{_base_url()}/cobranca_erros_log",headers=_headers(),params={"id":f"in.({id_list})"},timeout=15)
    r.raise_for_status()

def delete_erro_rows_by_document_id(document_id)->None:
    # Remove TODAS as linhas de cobranca_erros_log de um título. Usado pela TASK diária:
    # um título antes com erro (ex.: e-mail corrigido no Firebird) volta ao fluxo e, ao ser
    # enviado com sucesso, suas falhas antigas deixam de ser pendências. service_role ignora RLS.
    if not document_id: return
    r=httpx.delete(f"{_base_url()}/cobranca_erros_log",headers=_headers(),params={"document_id":f"eq.{document_id}"},timeout=15)
    r.raise_for_status()

def fetch_error_document_ids()->set[str]:
    # Conjunto de document_ids que possuem alguma linha em cobranca_erros_log. A task usa isso
    # para limpar SÓ os títulos que já tinham erro ao enviá-los com sucesso, evitando um DELETE
    # por título para quem nunca falhou.
    r=httpx.get(f"{_base_url()}/cobranca_erros_log",headers=_headers(),params={"select":"document_id"},timeout=15)
    r.raise_for_status()
    return {row["document_id"] for row in r.json() if row.get("document_id")}

def fetch_company_smtp()->dict|None:
    try:
        r=httpx.get(f"{_base_url()}/company",headers=_headers(),params={"select":"email,legal_name,trade_name","sk_company":"eq.1","limit":"1"},timeout=10)
        if r.status_code==404: logger.warning("company not found"); return None
        r.raise_for_status(); d=r.json(); return d[0] if d else None
    except Exception as e: logger.warning("company fail: %s",e); return None
