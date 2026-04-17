"""精确量出截图里红框与真实位置的 y 方向偏差。
用鼠标指向真实输入框的左上角，然后按 Enter，读取逻辑坐标并换算成截图像素。
再与 calibration.json 里的 px_y 对比，得出偏差。
"""
import sys, json
sys.path.insert(0, ".")
import Quartz

with open("/Users/os/.quote-autopilot/gui-agent/calibration.json") as f:
    cal = json.load(f)

saved_px_y = cal["input_box"]["px_y"]
saved_ly   = cal["input_box"]["ly"]
print(f"保存的截图像素 y: {saved_px_y}")
print(f"保存的逻辑    ly: {saved_ly}")
print()

# 当前 coords 参数
window_y = 30
ds = 2.0      # display_scale
shadow = 112  # shadow_px

print(f"当前参数: window_y={window_y} ds={ds} shadow={shadow}")
print()
print("把鼠标移到输入框左上角，按 Enter ...")
input()

ev = Quartz.CGEventCreate(None)
pt = Quartz.CGEventGetLocation(ev)
lx, ly = int(pt.x), int(pt.y)
print(f"鼠标逻辑坐标: ({lx}, {ly})")

# 新公式
new_px_x = int((lx - 0) * ds) + shadow
new_px_y = int((ly - window_y) * ds) + shadow
print(f"新公式截图像素: ({new_px_x}, {new_px_y})")
print(f"旧公式截图像素: px_y={saved_px_y}")
print(f"y 方向差值: {new_px_y - saved_px_y} px (新-旧，正=新的更低)")
print()
print(f"理论上新公式的逻辑 ly = (px_y - shadow) / ds + window_y")
print(f"  = ({new_px_y} - {shadow}) / {ds} + {window_y} = {(new_px_y - shadow) / ds + window_y:.1f}")
