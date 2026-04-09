import json
import sys

filepath = "/Users/os/Library/Application Support/Windsurf/User/globalStorage/opensource.ai-quote/windsurf-accounts.json"
target = "PaulWilliams5967"

with open(filepath) as f:
    data = json.load(f)

for a in data.get("accounts", []):
    if target in a.get("email", ""):
        rq = a.get("realQuota", {})
        print(f"email: {a.get('email')}")
        print(f"plan: {a.get('plan')}")
        print(f"realQuota.planName: {rq.get('planName')}")
        print(f"realQuota.billingStrategy: {rq.get('billingStrategy')}")
        print(f"realQuota.dailyRemainingPercent: {rq.get('dailyRemainingPercent')}")
        print(f"realQuota.weeklyRemainingPercent: {rq.get('weeklyRemainingPercent')}")
        print(f"realQuota.remainingMessages: {rq.get('remainingMessages')}")
        print(f"realQuota.source: {rq.get('source')}")
        print(f"realQuota.fetchedAt: {rq.get('fetchedAt')}")
        print(f"realQuota.planEndTimestamp: {rq.get('planEndTimestamp')}")
        sys.exit(0)

print(f"Account {target} not found")
sys.exit(1)
