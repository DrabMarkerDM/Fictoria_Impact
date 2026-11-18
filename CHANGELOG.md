# Changelog

All notable changes to **Fictoria_Impact**.

---

## [0.3.8.5] — 2026-11-18

The maid release. Her entire behaviour layer moved out of entity JSON and into JavaScript, which is what made the new jobs possible in the first place.

### Added

**Maid logic rewritten in JavaScript** — 23 modules, ~13,000 lines (`scripts/dm_entities/dm34/`)

- A single interaction router now replaces **585 `minecraft:interact` entries** in entity JSON. Right-click precedence lives in one readable table instead of generated JSON.
- Equipment, item handover, cooking, farming, sleeping and guard duty are all script-driven. Tools are tracked as real items with a main-hand proxy, so nothing is duplicated, eaten, or lost on reload.
- **Mining and tree felling** — a 48-block snapshot picks the target, a 24-block pass confirms it, then native pathfinding closes in. Ore veins and whole trees come down as chains, and she pillars up when the next block is above reach.
- **Spear form** (`variant 8`) — a charge-and-thrust attack with knockback and splash damage on nearby targets.
- Companion movement: 38-block recall, mount riding with stuck rescue, boat boarding and rowing follow, suffocation escape, water traversal.

**Field Manual** (`item:field_manual`) — a six-chapter in-game guide, with its own item icon and chapter artwork.

**Starter kit** — first-time players now receive a Field Manual and a fully loaded Fictoria Ball on joining a world.

### Changed

- **Tactical UI overhaul** — new mode icons for Follow / Patrol / Random / Ride, plus a **Ride mode** toggle for mount and boat following.
- **Strategy switching clears every command item** in her inventory again, restoring the documented behaviour. The single-item cap introduced in 0.3.5 was a regression.
- Maid state now runs on component groups only. Sleep, gathering and cooking modes are mutually exclusive by construction, so nothing idles in the background when she is fighting or standing by.

### Fixed

- `dm34_light_detector.json`: removed two animation controllers that nothing referenced.
- `dm_light.json`: removed a `minecraft:custom_components` entry with no registered component behind it.
- `dm34_moss_bullet.json`: removed a dangling `event_trigger` pointing at an event that was never defined.

### Performance

- **5-frame bucketing** (0.3.8.3): units are split into 5 buckets, capped at `MAX_UNITS_PER_FRAME = 24`. Worst single `engine.update` call fell from 36 ms to 11 ms — 72% → 22% of the tick budget.
- **In-memory velocity bus** (0.3.8.1): the `dm:cmd_vel_x / y / z` dynamic properties are gone, replaced by a module-level `Map`. Saves ~0.49 ms/tick with 60 units on screen.
- **Net result, v0.3.5 → v0.3.8.3**: script cost **55.30 → 4.56 ms/tick** (110.6% → 9.1% of budget), `main.drive` **48.716 → 0.712 ms/tick**, mspt **111.20 → 50.50**, TPS **8.99 → 19.80**, and zero dropped-tick windows.

### Removed

- `bow.json`, `crossbow.json` and `sword.json` animation controllers — the last remains of the 2022 JSON timer pipeline.

---

## Upgrade notes

- **Back up the world before updating.** Component groups and entity formats changed in this release.
- **Restart the world, don't `/reload`.** Script modules are only re-read on world load.
- Existing maids keep their inventory, tactical state and equipped real items.

---

## Earlier

| Version | Focus                                                        |
| ------- | ------------------------------------------------------------ |
| 0.3.8.3 | 5-frame bucketing, peak smoothing                            |
| 0.3.8.1 | In-memory velocity bus, 34× traversal fix                    |
| 0.3.5   | Script API 2.7.0 migration, unified ActiveMovers drive       |
| 0.3.0   | Snapshot targeting, melee movement v2, support system        |
