"""精确量出截图坐标系 vs 屏幕逻辑坐标系的偏移。"""
import sys, subprocess, struct, json
sys.path.insert(0, ".")
import Quartz
from gui_agent.perception import Perception
from gui_agent.config import DEFAULT_CONFIG
from gui_agent.logger import AgentLogger

log = AgentLogger("probe", DEFAULT_CONFIG, verbose=False)
p = Perception(DEFAULT_CONFIG, log)

# 1. 获取窗口 Quartz 边界
windows = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID
)
win_quartz = None
for w in windows:
    owner = w.get("kCGWindowOwnerName", "")
    bounds = w.get("kCGWindowBounds", {})
    layer = w.get("kCGWindowLayer", 0)
    name = w.get("kCGWindowName", "")
    if "Windsurf" in owner and layer == 0 and bounds.get("Width", 0) > 1000 and name:
        win_quartz = bounds
        print(f"Quartz 窗口: name='{name}' x={bounds['X']} y={bounds['Y']} w={bounds['Width']} h={bounds['Height']}")
        break

# 2. AppleScript 窗口信息
win_as = p.get_window_info("Windsurf")
print(f"AppleScript: x={win_as.x} y={win_as.y} w={win_as.width} h={win_as.height}")

# 3. 截窗口图
ss = p.capture_window("Windsurf")
print(f"截图: {ss.width}x{ss.height}")

# 4. 截全屏图
import time, tempfile, os
full_path = "/tmp/_probe_full.png"
subprocess.run(["screencapture", "-x", "-C", full_path])
with open(full_path, "rb") as f:
    hdr = f.read(32)
fw, fh = struct.unpack(">II", hdr[16:24])
print(f"全屏截图: {fw}x{fh}")

# 5. 核心计算
# screencapture -l window_id 截出什么尺寸？
# 理论: 截图物理尺寸 = 窗口逻辑尺寸 × display_scale
# 但实测 3104x1834 对应逻辑 1440x805=?
win_screenshot_scale_x = ss.width / win_as.width
win_screenshot_scale_y = ss.height / win_as.height
print(f"\n窗口截图 scale: x={win_screenshot_scale_x:.4f} y={win_screenshot_scale_y:.4f}")

# 全屏截图 scale
full_scale = fw / 1440  # 逻辑宽 1440
print(f"全屏截图 scale: {full_scale:.4f}")

# 差值
print(f"\n截图尺寸: {ss.width}x{ss.height}")
print(f"理论尺寸(窗口逻辑×全屏scale): {int(win_as.width*full_scale)}x{int(win_as.height*full_scale)}")
extra_x = ss.width  - int(win_as.width  * full_scale)
extra_y = ss.height - int(win_as.height * full_scale)
print(f"多出: {extra_x}px(x方向)  {extra_y}px(y方向)")
print(f"多出逻辑pt: {extra_x/full_scale:.1f}pt(x)  {extra_y/full_scale:.1f}pt(y)")

# 如果截图包含了 title bar，title bar 高度(逻辑)
titlebar_h_pt = extra_y / full_scale
print(f"\n推算 title bar 高度: {titlebar_h_pt:.1f} pt  ({extra_y} px)")

# 6. 鼠标当前位置
event = Quartz.CGEventCreate(None)
pt = Quartz.CGEventGetLocation(event)
print(f"\n鼠标当前: 逻辑({int(pt.x)},{int(pt.y)})")
# 正确的截图像素坐标（考虑 title bar）
correct_scale = full_scale  # 用全屏 scale 因为截图可能包含 title bar
print(f"  → 截图像素(不含titlebar): ({int((pt.x - win_as.x)*full_scale)}, {int((pt.y - win_as.y)*full_scale)})")
print(f"  → 截图像素(含titlebar偏移{extra_y}px): ({int((pt.x - win_as.x)*full_scale)}, {int((pt.y - win_as.y)*full_scale + extra_y)})")
