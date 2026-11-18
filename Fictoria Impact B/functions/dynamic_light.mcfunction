# 普通地面用这个：光块放在脚上方一格。
#
# ★ 2026-11-04：这里**只放两条命令，不要加 `execute if block` 判断**。
#   上一版为了避开草径，加了
#       execute if block ~ ~ ~ minecraft:dirt_path run fill ~ ~2 ~ …
#   结果整个函数加载失败 —— 该方块在本版本里可能叫 `minecraft:grass_path`，
#   未知 id 让解析直接失败，于是**清理也没跑**：既不发光，旧光源还滞留。
#   判断改到脚本里（guard.pulseLight 按脚下的方块选函数），见 dynamic_light_high。
#
# 只清自定义方块，绝不碰地图里刻意摆放的原版光源。
fill ~-2 ~-1 ~-2 ~2 ~3 ~2 air replace block:dm_light_1
fill ~ ~1 ~ ~ ~1 ~ block:dm_light_1 replace air
