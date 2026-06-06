import os, json, urllib.request
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parents[1] / ".env")

base = os.getenv("SUPABASE_URL", "").rstrip("/")
key  = os.getenv("SUPABASE_SERVICE_KEY", "")
headers = {"apikey": key, "Authorization": f"Bearer {key}"}

req = urllib.request.Request(
    f"{base}/rest/v1/email_control"
    "?select=id,message_id,subject,status,pdf_extracted,attachment_saved,attachment_names",
    headers=headers,
)
with urllib.request.urlopen(req, timeout=10) as r:
    data = json.loads(r.read())

print(f"Total registros: {len(data)}")
for row in data:
    subj = (row.get("subject") or "")[:60]
    atts = row.get("attachment_names") or "(none)"
    print(
        f"id={row['id']} status={row['status']} "
        f"pdf_ext={row['pdf_extracted']} att_saved={row['attachment_saved']}"
    )
    print(f"  subject : {subj}")
    print(f"  att_names: {atts}")
