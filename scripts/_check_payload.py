import os, json, urllib.request
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parents[1] / ".env")

base = os.getenv("SUPABASE_URL", "").rstrip("/")
key  = os.getenv("SUPABASE_SERVICE_KEY", "")
headers = {"apikey": key, "Authorization": f"Bearer {key}"}

req = urllib.request.Request(
    f"{base}/rest/v1/email_processing_errors"
    "?select=id,error_type,raw_payload,error_message"
    "&order=logged_at.desc&limit=3",
    headers=headers,
)
with urllib.request.urlopen(req, timeout=10) as r:
    errors = json.loads(r.read())

for e in errors:
    print(f"\n--- id={e['id']} {e['error_type']} ---")
    print(f"error_message: {e.get('error_message')}")
    payload = e.get("raw_payload") or {}
    if isinstance(payload, str):
        payload = json.loads(payload)
    print("raw_payload (keys com valores):")
    for k, v in payload.items():
        if v is not None:
            print(f"  {k}: {v}")
