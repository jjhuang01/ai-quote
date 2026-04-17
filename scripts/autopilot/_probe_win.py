import sys
sys.path.insert(0, ".")
import Quartz
from gui_agent.perception import Perception
from gui_agent.config import DEFAULT_CONFIG
from gui_agent.logger import AgentLogger

log = AgentLogger("probe", DEFAULT_CONFIG, verbose=False)
p = Perception(DEFAULT_CONFIG, log)

win = p.get_window_info("Windsurf")
print(f"AppleScript: x={win.x} y={win.y} w={win.width} h={win.height}")

windows = Quartz.CGWindowListCopyWindowInfo(
    Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID
)
for w in windows:
    owner = w.get("kCGWindowOwnerName", "")
    if "Windsurf" in owner or "Cursor" in owner:
        bounds = w.get("kCGWindowBounds", {})
        layer = w.get("kCGWindowLayer", 0)
        if layer == 0 and bounds.get("Width", 0) > 100:
            name = w.get("kCGWindowName", "")
            print(f"Quartz [{owner}] '{name}' x={bounds.get('X')} y={bounds.get('Y')} "
                  f"w={bounds.get('Width')} h={bounds.get('Height')}")

ss = p.capture_window("Windsurf")
print(f"\n截图: {ss.width}x{ss.height}")
print(f"window_scale = {ss.width}/{win.width} = {ss.width/win.width:.4f}")
print(f"截图高 / window_scale = {ss.height/( ss.width/win.width):.1f} (应等于窗口逻辑高度)")
