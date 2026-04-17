import sys
sys.path.insert(0, ".")
import Quartz

main_id = Quartz.CGMainDisplayID()
bounds = Quartz.CGDisplayBounds(main_id)
phys_w = Quartz.CGDisplayPixelsWide(main_id)
phys_h = Quartz.CGDisplayPixelsHigh(main_id)
logic_w = int(bounds.size.width)
logic_h = int(bounds.size.height)
print(f"显示器: 逻辑={logic_w}x{logic_h}  物理={phys_w}x{phys_h}  scale={phys_w/logic_w:.4f}")

from gui_agent.perception import Perception
from gui_agent.config import DEFAULT_CONFIG
from gui_agent.logger import AgentLogger
log = AgentLogger("probe", DEFAULT_CONFIG, verbose=False)
p = Perception(DEFAULT_CONFIG, log)

win = p.get_window_info("Windsurf")
if win:
    print(f"窗口逻辑: x={win.x} y={win.y} w={win.width} h={win.height}")
    display_scale = phys_w / logic_w
    print(f"窗口偏移物理px (用显示器scale {display_scale:.3f}x): x={win.x * display_scale:.0f} y={win.y * display_scale:.0f}")

# 截图
ss = p.capture_window("Windsurf")
print(f"窗口截图: {ss.width}x{ss.height}  window_scale={ss.width/win.width:.4f} (截图px/逻辑pt)")

# 鼠标当前位置
event = Quartz.CGEventCreate(None)
pt = Quartz.CGEventGetLocation(event)
print(f"鼠标当前逻辑坐标: ({int(pt.x)}, {int(pt.y)})")
print(f"  → 窗口截图像素 (用窗口scale {ss.width/win.width:.4f}): x={( int(pt.x) - win.x) * ss.width/win.width:.0f} y={(int(pt.y) - win.y) * ss.height/win.height:.0f}")
