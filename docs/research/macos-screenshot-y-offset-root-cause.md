# macOS 窗口截图 Y 方向偏移根因分析

> **日期**: 2026-04-14
> **状态**: ✅ 已修复
> **影响**: GUI Agent 标定坐标与实际位置偏移 ~18pt
> **修复**: `perception.py` — `screencapture` 添加 `-o` 参数

---

## 问题现象

GUI Agent 标定模式中，用户在验证截图上看到：

- 红框标注**向下偏移**，未准确覆盖目标 UI 元素
- 偏移量约等于窗口 toolbar 区域的高度
- 实际鼠标点击位置偏**上**，无法命中输入框

## 根因：macOS 窗口阴影垂直不对称

### 1. `screencapture -l` 截图包含窗口阴影

macOS 的 `screencapture -l <windowID>` 默认截取窗口**含阴影**的完整图像。
截图尺寸 > 窗口实际内容尺寸，多出来的像素是四周的 drop shadow。

```
┌─────────────── 3104 x 1834 (有阴影截图) ───────────────┐
│  shadow_top                                              │
│  ┌──────────── 2880 x 1610 (窗口内容) ──────────┐       │
│  │                                                │       │
│  │           Windsurf 窗口内容                     │       │
│  │                                                │       │
│  └────────────────────────────────────────────────┘       │
│  shadow_bottom                                            │
└──────────────────────────────────────────────────────────┘
```

### 2. 阴影分布是不对称的

macOS 的窗口 drop shadow 等效于 CSS:

```css
box-shadow: 0px 18pt 56pt rgba(0, 0, 0, 0.55);
/*          x=0  y=↓18pt  blur=56pt              */
```

**关键**: `y-offset = 18pt`，阴影向下偏移，导致 top 和 bottom 的 shadow 不等。

### 3. 实测数据 (M1 MacBook, Retina 2x, 1440×900)

| 方向 | 阴影 (物理 px) | 阴影 (逻辑 pt) | 说明 |
|------|---------------|---------------|------|
| Left | 112 | 56 | ✅ 对称 |
| Right | 112 | 56 | ✅ 对称 |
| **Top** | **76** | **38** | ❌ 比左右少 36px |
| **Bottom** | **148** | **74** | ❌ 比左右多 36px |

测量方法: 对比有阴影/无阴影截图，像素列匹配定位，匹配置信度 0.019。

```
有阴影截图: 3104 x 1834
无阴影截图: 2880 x 1610 (精确等于 1440×2 x 805×2)
阴影总量:   224px (x)  224px (y)
```

### 4. Bug 的触发机制

旧代码只从**水平方向**计算 shadow，然后**四面统一使用**:

```python
# perception.py — shadow 计算
content_px_w = int(window_w * display_scale)           # 2880
shadow_px = max(0, (ss.width - content_px_w) // 2)     # (3104 - 2880) / 2 = 112
```

在 `pixel_to_logical` 中统一使用 `shadow_px = 112`:

```python
# models.py — 坐标转换
content_y = px_y - self.shadow_px    # 减 112，但实际 shadow_top 只有 76
ly = int(content_y / ds) + self.window_y
```

**偏移量 = 112 - 76 = 36px = 18pt**

| 方向 | 影响 |
|------|------|
| `pixel_to_logical` | Y 方向多减 36px → 点击位置偏**上** 18pt |
| `logical_to_pixel` (标定) | Y 方向多加 36px → 红框偏**下** 36px |

## 解决方案

### 方案 A：`screencapture -o` 去掉阴影 ✅ 已采用

在 `screencapture` 命令中添加 `-o` 参数，完全移除窗口阴影。

```diff
# scripts/autopilot/gui_agent/perception.py line 109
- ["screencapture", "-x", "-l", str(win_id), path],
+ ["screencapture", "-x", "-o", "-l", str(win_id), path],
```

**效果**:
- 截图尺寸精确等于窗口内容: `2880 × 1610`
- `shadow_px` 自动归零 (计算逻辑 `max(0, (2880-2880)//2) = 0`)
- 坐标映射偏差: **0pt** (之前 18pt)

**优点**:
- 1 行改动，最小侵入
- 彻底消除阴影相关的所有坐标问题
- 截图文件更小 (~30% 少)
- 不依赖具体阴影参数，跨 macOS 版本通用

### 方案 B：分离 shadow_top / shadow_bottom (未采用)

在 `CoordinateSystem` 中添加独立的 `shadow_top` / `shadow_bottom` 字段:

```python
shadow_top: int = 0
shadow_bottom: int = 0
shadow_left: int = 0
shadow_right: int = 0
```

需要修改 `models.py` + `perception.py` + `calibrator.py`，增加测量阴影不对称性的逻辑。
复杂度远高于方案 A，且没有额外收益。

### 方案 C：全局禁用截图阴影 (不推荐)

```bash
defaults write com.apple.screencapture disable-shadow -bool true
```

全局生效，影响用户的正常截图操作，不适合作为程序内部修复。

## 验证

```bash
cd scripts/autopilot
python3 -c "
import sys; sys.path.insert(0, '.')
from gui_agent.perception import Perception
from gui_agent.config import DEFAULT_CONFIG
from gui_agent.logger import AgentLogger
log = AgentLogger('v', DEFAULT_CONFIG, verbose=False)
p = Perception(DEFAULT_CONFIG, log)
ss = p.capture_window('Windsurf')
print(f'截图: {ss.width}x{ss.height}')
print(f'shadow_px: {p.coords.shadow_px}')
print(f'display_scale: {p.coords.display_scale:.2f}')
cx, cy = ss.width//2, ss.height//2
lx, ly = p.coords.pixel_to_logical(cx, cy)
ex = p.coords.window_x + p.coords.window_w//2
ey = p.coords.window_y + p.coords.window_h//2
print(f'偏差: x={lx-ex}pt y={ly-ey}pt')
"
```

期望输出: `shadow_px: 0`, 偏差 `x=0pt y=0pt`。

## 相关知识

### macOS screencapture 常用参数

| 参数 | 说明 |
|------|------|
| `-x` | 静默模式 (无快门声) |
| `-o` | **不含窗口阴影** (window mode only) |
| `-l <windowID>` | 指定窗口 ID |
| `-C` | 包含光标 |
| `-i -s` | 交互式区域选择 |

### macOS 窗口 drop shadow 特征

- **非对称**: Y 方向有 ~18pt 下偏 (角度 90°)
- **版本变化**: shadow 参数随 macOS 版本微调 (10.7 vs Ventura vs Sequoia)
- **Retina 倍数**: shadow 的物理像素 = 逻辑 pt × display_scale
- **参考**: [StackOverflow — Mac OS X Window Shadow Params](https://apple.stackexchange.com/questions/73849)

### 坐标系层级 (GUI Agent)

```
Vision 归一化 (0.0-1.0, 原点左下)
      ↓ vision_to_pixel()
截图像素 (screencapture 物理像素, 原点左上)
      ↓ pixel_to_logical()
屏幕逻辑坐标 (CGEvent / AppleScript, 原点左上)
```

修复后 `pixel_to_logical` 简化为:

```python
lx = int(px_x / display_scale) + window_x   # shadow_px = 0, 无需偏移
ly = int(px_y / display_scale) + window_y
```

## 踩坑教训

1. **不要假设阴影对称** — macOS 的 drop shadow 有 y-offset，四面不等
2. **优先消除复杂性** — 与其精确测量不对称阴影，不如直接用 `-o` 消除阴影
3. **从水平推垂直是错误的** — `shadow_px` 从 X 方向计算后用于 Y 方向，隐含了对称假设
4. **多屏幕环境** — 不同显示器 display_scale 可能不同，阴影参数也可能不同
5. **验证闭环** — 用 `pixel_to_logical(截图中心)` 与 `窗口逻辑中心` 对比，偏差应为 0
