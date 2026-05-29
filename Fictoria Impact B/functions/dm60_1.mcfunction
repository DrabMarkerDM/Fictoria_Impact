scoreboard players set @e[family=monster,r=12] dm60a 1
execute as @e[type=player:dm60] run scoreboard players operation @s dm60 += @e[family=monster] dm60a
execute at @e[type=!player:dm60,tag=!dm,family=monster,r=12] run particle dm:dm60_att_4 ~~1.2~
playsound dm60z @a[r=42] ~~~ 1.8 1.0
event entity @e[scores={dm60=58..}] satt
effect @s instant_health 5 50 true
effect @e[tag=!dm,type=!player:dm60,family=monster,r=12] weakness 3 3 true
effect @e[tag=!dm,type=!player:dm60,family=monster,r=12] slowness 3 3 true
execute at @e[type=!player:dm60,tag=!dm,family=monster,r=3,c=4] run particle minecraft:cherry_leaves_particle ~~2.1~
execute at @e[type=!player:dm60,tag=!dm,family=monster,r=3,c=4] run particle minecraft:cherry_leaves_particle ~~2.1~
execute at @e[type=!player:dm60,tag=!dm,family=monster,r=3,c=4] run particle minecraft:cherry_leaves_particle ~~2.1~