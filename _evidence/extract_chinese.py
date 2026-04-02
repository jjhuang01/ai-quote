import re
with open("_evidence/original-vsix/extension/out/extension.js", "r", errors="ignore") as f:
    content = f.read()
chinese = set(re.findall(r'[\u4e00-\u9fff]+', content))
for c in sorted(chinese):
    print(c)
