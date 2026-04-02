#!/usr/bin/env python3
"""
解码 windsurfAuthStatus.userStatusProtoBinaryBase64
尝试从 protobuf 二进制中提取 quota 信息
"""
import subprocess, json, base64, struct, sys

DB = f"{__import__('os').path.expanduser('~')}/Library/Application Support/Windsurf/User/globalStorage/state.vscdb"

def sqlite_query(sql):
    r = subprocess.run(['sqlite3', DB, sql], capture_output=True, text=True, timeout=5)
    return r.stdout.strip()

def parse_varint(data, pos):
    result = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            break
    return result, pos

def decode_proto_fields(data):
    """简单 protobuf 解码器，提取所有字段"""
    fields = {}
    pos = 0
    while pos < len(data):
        try:
            tag_varint, pos = parse_varint(data, pos)
            field_num = tag_varint >> 3
            wire_type = tag_varint & 0x7
            if wire_type == 0:  # varint
                val, pos = parse_varint(data, pos)
                fields[field_num] = ('varint', val)
            elif wire_type == 2:  # length-delimited
                length, pos = parse_varint(data, pos)
                val = data[pos:pos+length]
                pos += length
                fields[field_num] = ('bytes', val)
            elif wire_type == 5:  # 32-bit
                val = struct.unpack_from('<I', data, pos)[0]
                pos += 4
                fields[field_num] = ('fixed32', val)
            elif wire_type == 1:  # 64-bit
                val = struct.unpack_from('<Q', data, pos)[0]
                pos += 8
                fields[field_num] = ('fixed64', val)
            else:
                break
        except Exception:
            break
    return fields

def try_as_string(b):
    try:
        return b.decode('utf-8')
    except:
        return None

def print_fields(fields, indent=0):
    prefix = "  " * indent
    for field_num, (wtype, val) in sorted(fields.items()):
        if wtype == 'bytes':
            s = try_as_string(val)
            if s and s.isprintable() and len(s) > 0:
                print(f"{prefix}field[{field_num}] = string: {repr(s[:200])}")
            else:
                # 递归尝试解码为子 message
                sub = decode_proto_fields(val)
                if sub:
                    print(f"{prefix}field[{field_num}] = message {{")
                    print_fields(sub, indent+1)
                    print(f"{prefix}}}")
                else:
                    print(f"{prefix}field[{field_num}] = bytes[{len(val)}]: {val[:40].hex()}")
        elif wtype == 'varint':
            print(f"{prefix}field[{field_num}] = int: {val}")
        else:
            print(f"{prefix}field[{field_num}] = {wtype}: {val}")

# --- Main ---
raw = sqlite_query("SELECT value FROM ItemTable WHERE key='windsurfAuthStatus';")
if not raw:
    print("ERROR: windsurfAuthStatus is empty")
    sys.exit(1)

try:
    status = json.loads(raw)
except json.JSONDecodeError:
    print("ERROR: not JSON")
    sys.exit(1)

print("Keys in windsurfAuthStatus:", list(status.keys()))
print()

b64 = status.get('userStatusProtoBinaryBase64', '')
if not b64:
    print("No userStatusProtoBinaryBase64 field")
    sys.exit(1)

print(f"Base64 length: {len(b64)}")
binary = base64.b64decode(b64)
print(f"Binary length: {len(binary)} bytes")
print(f"Hex preview: {binary[:32].hex()}")
print()

print("=== Proto field dump ===")
fields = decode_proto_fields(binary)
print_fields(fields)

# 也尝试 JSON parse（有时 proto binary 里嵌了 JSON）
print()
print("=== 搜索 JSON 片段 ===")
text = binary.decode('latin-1')
for marker in ['"planName"', '"quotaUsage"', '"dailyRemaining"', '"planInfo"', '"billingStrategy"']:
    idx = text.find(marker)
    if idx >= 0:
        print(f"找到 {marker} at pos {idx}: ...{repr(text[max(0,idx-20):idx+100])}...")
