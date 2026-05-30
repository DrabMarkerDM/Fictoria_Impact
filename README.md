# ⚔️ Fictoria_Impact

**A Minecraft Bedrock Edition universal combat AI framework** — making entities *fight* instead of just *chasing the nearest target*.

---

## 📘 Tutorial

- [Introduction](docs/Images/tutorial.md)

## 📦 Overview

| Item | Value |
|------|-------|
| Behavior Pack Entities | 98+ |
| Animation Controllers | 167 |
| Core JS Engine | 6 modules, ~60 KB |
| Total JSON | ~1.2 MB |
| License | MIT |
| Min Engine Version | 1.20.30 |
| Script API | `@minecraft/server` 1.19.0 |

---

## 🧠 Architecture

### Three-Layer Design

```
Layer 1: JSON Data Layer (entity definitions, component groups, events)
         → Base stats, variant switching, taming, damage reduction

Layer 2: Animation Controller State Machine (167 controllers)
         → Weapon animations, effects, scoreboard-driven states

Layer 3: JavaScript Runtime (DmTargetEngine)
         → Targeting weights, movement decisions, stuck detection, damage handling
```

**Design philosophy**: JSON does what JSON is good at (data, events, animation states). JS does what JS is good at (runtime decisions, collision detection, config-driven logic). **They don't fight for control.**

---

## ⚙️ Core Engine: `DmTargetEngine`

### Workflow

```
Every 1 tick (main.js):
  └─ driveMaidMuscles() → iterate dimensions + entity types
       ├─ read dynamicProperty velocity commands
       └─ applyImpulse()

Every 5 tick (target_engine.js):
  └─ DmTargetEngine.update() → target weighting + movement decision

Tactical clock (random 30–50 ticks):
  └─ Multi-mode direction selection (straight retreat / left circle / right circle)
```

### Implemented Subsystems

| Subsystem | File | Status |
|-----------|------|--------|
| Custom-skill system | `The.json file in entities folder and animation controllers` | ✅ Complete |
| Weight-based Targeting | `target_engine.js` | ✅ Complete |
| Ranged Movement | `movement_ranged.js` | ✅ With threat detection + hit damping |
| Stuck Detection | (built-in) | ✅ Wall / pit / low-ceiling / lava / cliff |
| Friendly Fire Protection | `player_attack_blocker.js` | ✅ Triple-layer (projectile → JSON → JS heal) |
| Override Damage | `bullet_manager.js` | ✅ Bypass vanilla invincibility frames |
| Lava Detection | `maid_manager.js` | ✅ Event-driven, not polling |
| Melee Engine | `movement_melee.js` | ⏳ In design (aggressive / balanced / retreat) |
| Patrol Mode | `patrol.js` | ⏳ In design (roam / follow / patrol) |

---

## 🧬 Entity System

### Type A: JSON Self-Contained Entities (Elite Units)

These entities have complete self-contained combat systems — targeting, weapon switching, and ultimate skills (SSS) all handled in JSON. The engine only provides stuck detection and friendly fire protection.

| Entity | Role | Specialty |
|--------|------|-----------|
| **dm0** | Versatile hybrid fighter | sword / bow / SSS, self-contained template |
| **dm41** | Heavy single-hit striker | Up to 198 damage per hit |
| **dm60** | AoE crowd-clearer | Scoreboard-driven rage, large-area damage |
| **dm61** | Ranged artillery | Summons ice pillars to taunt enemies in SSS mode |
| **dm63** | Ranged tank | Override damage-reflect shield, high-pressure specialist |
| **dm52** | Summoner support | Heals allies, summons mobile units |
| **dm25** | Linebreaker | AoE melee, 300 DPS single-target execute |
| **boss1** | Hybrid melee/ranged boss | 1000 HP, explosive projectiles, interruptible wind-up |
| **fire_boy** | Melee-focused super boss | 250 HP, fire immune, large AoE fire explosions |

### Type B: Engine-Driven Entities (Config-Driven Units)

These entities get their full combat capabilities from the `DmTargetRegistry` config table + JS engine.

| Entity | Modes | Weapons |
|--------|-------|---------|
| **dm34_1** (Arsenal Maid) | 5 combat modes | M4A1 / Mossberg / AWP / Melee / Glock |
| **dm34** (Base Maid) | 3 combat + 2 logistics | Melee / Bow / Crossbow + Cooking / Farming |

### Key Utility Systems

| System | Description |
|--------|-------------|
| **hug_maid** | 4.4 KB invisible entity using `parrot_tame` family to let players "carry" maids |
| **player.json** | `family: ["player", "dm"]` — enables friendly fire immunity between player and dm entities |
| **Projectile System** | 10+ ammo types, some with `dm` family immunity, others backed by JS heal fallback |

---

## 🎬 Animation Controller Ecosystem (167 total)

### Categories

| Category | Count | Description |
|----------|-------|-------------|
| Weapon State Machines | 5 | sword / bow / crossbow / gun(50KB) / ak47 |
| Base States | 3 | idle / move / sprint / retreat |
| Combat States | 4 | targeting / health / death / blocking |
| Skill System | 8 | generic skills + ultimate + various skill charge types |
| **Tag System** | **31** | Scoreboard-driven orthogonal state bits |
| Status Tags | 6 | equipment / attack / item / mode / move / target |
| Effects | 6 | attack effects / hit particles |
| Mounts | 3 | riding / being ridden / maid riding |
| Boss Exclusive | 4 | weaker idle states for assassination opportunities |
| Maid Exclusive | 6 | base / attack / follow / skill / sit / pickup |

---

## 🛠️ Creating a New Entity

### Plan A: JSON Self-Contained (for elite units)

```
1. Decide variant count (e.g. 3 weapon modes)
2. Write component_groups (one per variant)
3. Design target_nearby_sensor thresholds
4. Design SSS mechanic (scoreboard / timer / event chain)
5. Write animation controllers (~5–8 files)
6. Register dm family immunity in player.json
```

### Plan B: Engine-Driven (for mass-production units)

```
1. Pick identifier and variant number
2. Add entry to DmTargetRegistry config
3. Add identifier to targetTypes in main.js
4. (Optional) Add bullet damage to DAMAGE table
5. No complex combat JSON needed
```

---

## 📊 Project Status

| Module | Progress | Notes |
|--------|----------|-------|
| Ranged Movement Engine | ✅ 100% | Includes stuck detection + friendly fire |
| Targeting Engine | ✅ 100% | Focus / cooldown / damage timeout |
| Override Damage | ✅ 100% | Bullets + melee |
| Lava Detection | ✅ 100% | Maid teleport + demon bounce |
| Friendly Fire Protection | ✅ 100% | Triple-layer |
| Custom-skill system | ⏳ 80% | melee_box_attack will be soon added to replace delayed_attack |
| Melee 3-Strategy | ⏳ 30% | Designed, not yet implemented |
| Patrol Mode | ⏳ 0% | Slot-driven + ActionForm UI |
| Capture System | ⏳ 0% | Entity serialization |
| Level System | ❌ Shelved | Low priority |

---

## 🧪 Technical Notes

### JSON Format Versions in Use

| Version | Used By | Status |
|---------|---------|--------|
| 1.8.0 | Most dm entities | ⚠️ Will upgrade to ≥1.16.0 |
| 1.12.0 | Legacy projectile entities | ⚠️ `onHit` deprecated, will migrate |
| 1.20.30 | Current min_engine_version | ✅ Target version |
| 1.21.0 | dm34 projectiles | ✅ Latest |
| 1.26.0 | player.json | ⚠️ Preview format, will downgrade |

### JS Dependencies

```json
"@minecraft/server": "^1.19.0",
"@minecraft/server-ui": "^1.2.0"
```

---

## 📝 Credits

- **Aplok guns** — Override damage projectile logic
- **TouhouLittleMaidBE** — State machine architecture, hug_maid & inventory detection references
- **NotUnaNancyOwen** — Java skeleton strafing logic
- **The_XD259** — Shield blocking concept (future)
- **Sounds** — Sound resource from [あみたろの声素材工房](https://amitaro.net/)

---

## 🤝 Contributing

Areas open for discussion:

- Melee engine 3-strategy implementation
- JSON format version migration
- Projectile system unification
- New entity design (self-contained or engine-driven)

---

## 📬 Contact

- **QQ Group**: `191050693` (recommended, daily chat + dev discussion)
- **GitHub Issues**: [Submit bugs or suggestions](https://github.com/DrabMarkerDM/Fictoria_Impact/issues)

> Before submitting an Issue or PR, consider reading `attackable_target_manager.js` and `main.js` first to understand the routing logic. For testing, use `/summon` with the `variant` parameter.

---

## 📜 License

MIT — Free to use, modify, and distribute with attribution.

---

