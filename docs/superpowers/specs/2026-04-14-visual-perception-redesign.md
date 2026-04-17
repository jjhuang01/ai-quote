# GUI Agent 视觉感知层重设计

> 日期: 2026-04-14 | 方案: C (视觉优先管线)

## 核心问题

OCR 无法区分发送按钮的两种视觉状态:
- ↑ 箭头 (紫色圆圈) = 可发送
- ■ 方块 (深色圆圈) = 正在运行

需要**像素级视觉检测**作为主信号。

## 架构

```
截图 → visual.py (像素检测, <50ms)
           ↓
     annotator.py (红框/网格/标签)
           ↓
     perception.py (+ OCR 交叉验证)
           ↓
     coordinator.py (编排 + --visual 延迟)
```

## 新增模块

### visual.py — UIDetector
- `detect_input_box(img)`: 底部25%扫描, 找边框色差, 返回 bbox
- `detect_send_button(img, input_box)`: 右侧圆形区域, HSV 色相分类
  - 紫/蓝 H:220-280 → SENDABLE
  - 白色方块图案 → RUNNING
  - 低饱和度 → DISABLED
- `detect_all(img)`: 返回 UIElements 汇总

### annotator.py — Annotator
- `draw_box(img, bbox, label, color)`: 红框 + 标签
- `draw_grid(img, spacing=50)`: 坐标网格
- `annotate_all(img, elements)`: 综合标注
- `show(img, delay=2.0)`: 保存 + open Preview + 延迟

## 运行模式

- **默认**: 静默, 仅 JSON + 日志
- **--visual**: 全可视 (红框标注 + 网格 + Preview + 2s延迟)

## 自适应检测 (无需校准)

每次运行:
1. 截图 → 聚焦底部25%
2. 颜色扫描找输入框边界
3. 输入框右侧找发送按钮
4. HSV 分类按钮状态
5. OCR 交叉验证 ("Ask anything" / "send")

## 验收标准

- [ ] 正确识别 SENDABLE / RUNNING / DISABLED 三种状态
- [ ] --visual 模式产出带红框标注的截图
- [ ] 网格叠加可用
- [ ] 延迟可配置
- [ ] OCR 交叉验证不一致时有 warning 日志
