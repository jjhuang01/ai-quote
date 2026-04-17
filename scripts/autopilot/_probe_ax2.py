import Quartz
import CoreFoundation as CF

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
if tap:
    src = Quartz.CFMachPortCreateRunLoopSource(None, tap, 0)
    print(f"RunLoopSource: {src is not None}")
