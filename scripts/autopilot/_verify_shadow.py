window_x, window_y = 0, 30
window_w = 1440
ds = 2.0
shadow = 112  # (3104 - 1440*2) / 2 = (3104 - 2880) / 2 = 112

# 鼠标点在逻辑 (295, 769) 时，截图像素坐标是？
lx, ly = 295, 769
px_x = int((lx - window_x) * ds) + shadow
px_y = int((ly - window_y) * ds) + shadow
print(f"输入框中心: 逻辑({lx},{ly}) → 截图像素({px_x},{px_y})")
print(f"截图高1834, py={px_y} 占 {px_y/1834:.1%}  (输入框应在约87-91%)")

# 反验: pixel_to_logical
back_lx = int((px_x - shadow) / ds) + window_x
back_ly = int((px_y - shadow) / ds) + window_y
print(f"反算回来: 逻辑({back_lx},{back_ly})  应={lx},{ly}")

print()
# 旧公式 (没有 shadow 补偿)
old_scale = 1440 / 3104  # = 0.4639
old_lx = int(px_x * old_scale) + window_x
old_ly = int(px_y * old_scale) + window_y
print(f"旧公式 pixel_to_logical: 逻辑({old_lx},{old_ly})  (偏差: dx={old_lx-lx} dy={old_ly-ly})")
