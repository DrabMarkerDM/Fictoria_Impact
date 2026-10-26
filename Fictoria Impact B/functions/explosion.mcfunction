camerashake add @a[rm=0, r=5] 1.0 0.5 rotational
camerashake add @a[rm=5, r=9] 0.8 0.5 rotational
camerashake add @a[rm=9, r=13] 0.6 0.4 rotational
playsound dm_explosion @a[r=50] ~~~ 100 1 0.01
playsound dm_debris @a[r=40] ~~~ 10 1 0.01
scoreboard players add @e[type=demon:soldier_9,r=50] dm_skill_timer_4 1
effect @e[r=5,family=!demon,family=!monster] wither 30 10
effect @e[r=5,family=!demon,family=!monster] slowness 30 3