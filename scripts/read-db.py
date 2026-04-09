import sqlite3
import json
import sys

db_path = "/Users/os/Library/Application Support/Windsurf/User/globalStorage/state.vscdb"
conn = sqlite3.connect(db_path)
cur = conn.cursor()

# Read current session info
cur.execute("SELECT value FROM ItemTable WHERE key = 'codeium.windsurf-windsurf_auth'")
row = cur.fetchone()
if row:
    try:
        data = json.loads(row[0])
        print("=== windsurf_auth ===")
        if isinstance(data, dict):
            for k, v in data.items():
                val_str = str(v)
                if len(val_str) > 200:
                    val_str = val_str[:200] + "..."
                print(f"  {k}: {val_str}")
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    print(f"  email: {item.get('email', 'N/A')}")
                    print(f"  displayName: {item.get('displayName', 'N/A')}")
    except:
        print("  (raw):", row[0][:300])

# Read cached plan
cur.execute("SELECT value FROM ItemTable WHERE key = 'windsurf.settings.cachedPlanInfo'")
row = cur.fetchone()
if row:
    data = json.loads(row[0])
    print("\n=== cachedPlanInfo ===")
    print(f"  planName: {data.get('planName')}")
    print(f"  billingStrategy: {data.get('billingStrategy')}")
    print(f"  hasBillingWritePermissions: {data.get('hasBillingWritePermissions')}")
    print(f"  gracePeriodStatus: {data.get('gracePeriodStatus')}")
    qu = data.get("quotaUsage", {})
    print(f"  dailyRemainingPercent: {qu.get('dailyRemainingPercent')}")
    print(f"  weeklyRemainingPercent: {qu.get('weeklyRemainingPercent')}")
    usage = data.get("usage", {})
    print(f"  messages: {usage.get('messages')}")
    print(f"  flowActions: {usage.get('flowActions')}")
    print(f"  teamsTier: {data.get('teamsTier')}")

# Check windsurfAuthStatus
cur.execute("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'")
row = cur.fetchone()
if row:
    print(f"\n=== windsurfAuthStatus ===")
    print(f"  {row[0][:500]}")

conn.close()
