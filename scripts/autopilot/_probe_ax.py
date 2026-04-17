import Quartz
import CoreFoundation as CF
print("Quartz OK")
print("CoreFoundation OK")
print("AX trusted:", Quartz.AXIsProcessTrusted())

# 试创建一个 event tap
def handler(proxy, type_, event, refcon):
    return event

mask = (1 << Quartz.kCGEventLeftMouseDown) | (1 << Quartz.kCGEventLeftMouseUp)
tap = Quartz.CGEventTapCreate(
    Quartz.kCGSessionEventTap,
    Quartz.kCGHeadInsertEventTap,
    Quartz.kCGEventTapOptionListenOnly,
    mask,
    handler,
    None,
)
print(f"CGEventTap created: {tap is not None}")
