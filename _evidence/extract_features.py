import re

with open("_evidence/original-vsix/extension/out/extension.js", "r", errors="ignore") as f:
    content = f.read()

# Extract readable escaped strings like \x27xxx\x27
escaped = re.findall(r"'([A-Za-z0-9_./\-@: ]{2,50})'", content)
# Filter for feature-related keywords
keywords = set()
feature_words = ['account', 'credit', 'quota', 'usage', 'import', 'batch', 'switch', 
                 'machine', 'reset', 'template', 'shortcut', 'setting', 'diagnos', 'repair',
                 'clean', 'cache', 'rule', 'breathing', 'sound', 'enter', 'prompt', 'history',
                 'update', 'version', 'download', 'install', 'feedback', 'height', 'font',
                 'opacity', 'theme', 'position', 'panel', 'window', 'sidebar', 'tab',
                 'status', 'stats', 'queue', 'search', 'waiting', 'submit', 'continue',
                 'end', 'delete', 'clear', 'save', 'load', 'get', 'set', 'add', 'remove',
                 'windsurf', 'cursor', 'kiro', 'trae', 'vscode', 'firebase', 'login',
                 'verify', 'token', 'email', 'password', 'expire', 'plan', 'pro', 'trial',
                 'auto', 'interval', 'threshold', 'check', 'detect', 'port', 'server',
                 'bridge', 'sse', 'event', 'message', 'mcp', 'config', 'api']

for s in escaped:
    s_lower = s.lower()
    for kw in feature_words:
        if kw in s_lower:
            keywords.add(s)
            break

for k in sorted(keywords):
    print(k)

print("\n=== HTML template fragments ===")
# Look for HTML-like content
html_frags = re.findall(r"'(<[^']{5,200})'", content)
for h in sorted(set(html_frags))[:100]:
    print(h)

print("\n=== Hex-escaped Chinese strings ===")
# Find escaped unicode like \u-style Chinese
hex_chinese = re.findall(r'\\x([0-9a-fA-F]{2})', content[:50000])
# Actually look for literal Chinese phrases (2+ chars that are actual words)
cn_phrases = re.findall(r'[\u4e00-\u9fff]{2,20}', content)
# Filter to real phrases (not random CJK from obfuscation)
real_cn = set()
real_words = ['服务', '端口', '配置', '规则', '账号', '导入', '批量', '模板', '快捷', 
              '额度', '积分', '统计', '设置', '状态', '更新', '诊断', '修复', '维护',
              '清理', '清空', '历史', '呼吸', '弹窗', '主题', '提示', '版本', '检测',
              '下载', '安装', '重置', '保存', '删除', '添加', '搜索', '反馈', '记录',
              '切换', '自动', '启用', '关闭', '打开', '刷新', '复制', '粘贴', '导出',
              '永久', '到期', '激活', '运行', '使用', '总对话', '继续', '暂停', '结束',
              '日均', '窗口', '字体', '大小', '透明', '颜色', '高度', '宽度', '间隔',
              '阈值', '分预', '密码', '邮箱', '登录', '注册', '机器', '设备', '重写',
              '缓存', '权限', '生效', '推荐', '深色', '外观', '尺寸', '快捷键', '条数',
              '回车', '发送', '显示', '用户', '提问']
for phrase in cn_phrases:
    for w in real_words:
        if w in phrase:
            real_cn.add(phrase)
            break

for c in sorted(real_cn):
    print(c)
