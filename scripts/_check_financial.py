import os, json, urllib.request
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parents[1] / ".env")

base = os.getenv("SUPABASE_URL", "").rstrip("/")
key  = os.getenv("SUPABASE_SERVICE_KEY", "")
headers = {"apikey": key, "Authorization": f"Bearer {key}"}

req = urllib.request.Request(
    f"{base}/rest/v1/financial_emails"
    "?select=id,gmail_message_id,supplier_name,document_type,amount,due_date,status,extracted_at"
    "&order=extracted_at.desc",
    headers=headers,
)
with urllib.request.urlopen(req, timeout=10) as r:
    data = json.loads(r.read())

print(f"Registros em financial_emails: {len(data)}")
for row in data:
    print(
        f"  id={row['id']} type={row['document_type']} "
        f"supplier={str(row.get('supplier_name') or '')[:30]} "
        f"amount={row.get('amount')} due={row.get('due_date')} "
        f"status={row.get('status')}"
    )
