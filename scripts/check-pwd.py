import json

filepath = "/Users/os/Library/Application Support/Windsurf/User/globalStorage/opensource.ai-quote/windsurf-accounts.json"

with open(filepath) as f:
    data = json.load(f)

for a in data.get("accounts", []):
    if "PaulWilliams5967" in a.get("email", ""):
        pwd = a.get("password", "")
        print(f"stored password: '{pwd}' (len={len(pwd)})")
        print(f"matches Aa263646: {pwd == 'Aa263646'}")
        break
