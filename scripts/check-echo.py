import json

filepath = "/Users/os/Library/Application Support/Code/User/globalStorage/opensource.ai-echo/windsurf-accounts.json"
target = "PaulWilliams5967"

with open(filepath) as f:
    data = json.load(f)

for a in data.get("accounts", []):
    if target in a.get("email", ""):
        print(f"=== ai-echo stored data for {a.get('email')} ===")
        print(f"plan: {a.get('plan')}")
        rq = a.get("realQuota", a.get("quota", {}))
        print(f"realQuota/quota keys: {list(rq.keys())}")
        for k, v in rq.items():
            print(f"  {k}: {v}")
        break
else:
    print(f"Account {target} not found in ai-echo data")
    print(f"Available accounts ({len(data.get('accounts', []))}):")
    for a in data.get("accounts", [])[:5]:
        print(f"  {a.get('email')} - plan: {a.get('plan')}")
