"""直接测试点击标定坐标是否能聚焦输入框。"""
import sys, time
sys.path.insert(0, ".")
from gui_agent.action import Action
from gui_agent.config import DEFAULT_CONFIG
from gui_agent.logger import AgentLogger

log = AgentLogger("test", DEFAULT_CONFIG, verbose=True)
act = Action(DEFAULT_CONFIG, log)

# 先激活 Windsurf
act.activate_app("Windsurf")
time.sleep(0.5)

# 点击标定的输入框坐标
print("点击 (295, 769)...")
r = act.click(295, 769)
print(f"结果: {r}")
time.sleep(0.3)

# 输入测试文字
print("粘贴测试文字...")
act.clipboard_set("test_calibration_click")
time.sleep(0.05)
r = act.paste()
print(f"粘贴结果: {r}")
time.sleep(0.5)
print("完成 - 请看 Windsurf 输入框是否有文字出现")
print("(不会按 Enter，不会真正发送)")
