import os, json, urllib.request
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parents[1] / ".env")

base = os.getenv("SUPABASE_URL", "").rstrip("/")
key  = os.getenv("SUPABASE_SERVICE_KEY", "")
headers = {"apikey": key, "Authorization": f"Bearer {key}"}

# email_processing_errors
req = urllib.request.Request(
    f"{base}/rest/v1/email_processing_errors"
    "?select=id,error_type,error_message,source_file,subject,logged_at"
    "&order=logged_at.desc&limit=20",
    headers=headers,
)
with urllib.request.urlopen(req, timeout=10) as r:
    errors = json.loads(r.read())

print(f"Registros em email_processing_errors: {len(errors)}")
for e in errors:
    print(f"  [{e.get('logged_at','')[:16]}] {e.get('error_type')} — {e.get('source_file','')}")
    print(f"    msg: {str(e.get('error_message',''))[:100]}")
    print(f"    subject: {str(e.get('subject',''))[:60]}")
