import json

filepath = "/Users/os/Library/Application Support/Windsurf/User/globalStorage/opensource.ai-quote/windsurf-accounts.json"
target = "PaulWilliams5967"

with open(filepath) as f:
    data = json.load(f)

for a in data.get("accounts", []):
    if target in a.get("email", ""):
        print(f"email: {a.get('email')}")
        print(f"plan: {a.get('plan')}")
        print(f"hasApiKey: {bool(a.get('apiKey'))}")
        print(f"apiServerUrl: {a.get('apiServerUrl', 'N/A')}")
        print(f"password length: {len(a.get('password', ''))}")
        print(f"lastCheckedAt: {a.get('lastCheckedAt')}")
        print(f"addedAt: {a.get('addedAt')}")
        rq = a.get("realQuota", {})
        print(f"\n--- realQuota ---")
        for k, v in rq.items():
            print(f"  {k}: {v}")
        break
