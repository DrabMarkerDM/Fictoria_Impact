playsound dm_explosion @a[r=50] ~~~ 100 1 0.01
playsound dm_debris @a[r=40] ~~~ 10 1 0.01
camerashake add @a[rm=0, r=4] 0.6 0.4 rotational
camerashake add @a[rm=4, r=8] 0.4 0.4 rotational
camerashake add @a[rm=8, r=12] 0.2 0.2 rotational
scoreboard players add @e[type=demon:soldier_9,r=50] dm_skill_timer_4 1
effect @e[r=5,family=!demon] wither 30 10
effect @e[r=5,family=!demon] slowness 30 3