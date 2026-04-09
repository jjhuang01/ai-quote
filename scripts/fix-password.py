"""修复 PaulWilliams5967 的密码：---Aa263646 → Aa263646"""
import json

filepath = "/Users/os/Library/Application Support/Windsurf/User/globalStorage/opensource.ai-quote/windsurf-accounts.json"

with open(filepath) as f:
    data = json.load(f)

fixed = False
for a in data.get("accounts", []):
    if "PaulWilliams5967" in a.get("email", ""):
        old_pwd = a["password"]
        new_pwd = old_pwd.lstrip("-")
        if old_pwd != new_pwd:
            print(f"Fixing: '{old_pwd}' -> '{new_pwd}'")
            a["password"] = new_pwd
            fixed = True
        else:
            print(f"Password already correct: '{old_pwd}'")
        break

if fixed:
    with open(filepath, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    print("Saved.")
else:
    print("No fix needed.")
