# Changelog

## [0.3.8.8] — 2026-11-26

### Added

- **Chunk keep** — a switch on her panel gives each companion her own 3×3 ticking area that slides with her, plus an optional particle border drawing the 48×48 outline for the owner only. The setting rides on the Fictoria Ball, so a recalled companion comes back with it, and base defence keeps working in a dimension with no player.
- **Crossbow aim** — in crossbow form she raises the weapon while she has a live target and lowers it after firing. Multishot is fired by her, not by the engine: vanilla mobs ignore it.
- **Death-return balls** — three `_dead` ball items (green / blue / gold), so a ball that brought her back from death reads differently from one you recalled by hand.
- **Localization** — 334 keys in zh_CN / en_US / en_GB covering panels, the manual, item names and every player-facing line.

### Changed

- 18 more companions join the panel command system: follow / random / patrol now works on **34**, not 16.
- Their right-click menu is now two top-level interactions (sit / stand) with the sneak tag driven by `entity_sensor`, instead of `interact` blocks repeated in every component group.
- Posture animation uses our own `dm_state_sit` controller; 17 companions no longer borrow `controller.animation.player.sit`, and dm34's crossbow uses `dm34.crossbow`.
- **dm21 and dm6 were on `format_version` 1.8.0**, where every newer component is silently dropped. Both are now 1.21.50.
- `dm34/` scripts split by responsibility into `core/` `combat/` `gather/` `inventory/` `life/` `ball/`.
- Manual chapter text moved into `.lang`; the script keeps only the flow.

### Fixed

- **Panel inventory reads start at slot 1** — slot 0 is the saddle slot of a horse container, so anything written there was invisible.
- Ball lore lines built with `t()` were dropped by a `typeof string` check, which could wipe her name and status off a recalled ball.
- A `follow_2` arriving while she was already patrolling cleared her patrol list.
- Item names are language keys now, so `模块-GLOCK` and the manual title render in every client instead of Chinese only.

## [0.3.8.6] — 2026-11-23

### Added

- **Death recall** — a companion who dies is sealed into a Fictoria Ball instead of spilling onto the ground. Inventory, tool and weapon records, and her last form all come back with her.
- Spare ball of the same grade if you have one, otherwise one is forged on the spot, otherwise the ball drops at your feet.
- Death cooldown is three times a normal recall: **75 s gold / 45 s blue / 15 s green**, with a red lore line `干员已自行撤回`.
- Only what the ball actually took is swept off the ground, so nothing is deleted twice. Works for all 60 companions, not just dm34.

### Changed

- `scripts/dm_entities/common/` split into `core/` / `tactical/` / `fictoria_logic/` / `travel/`. 56 modules, no behaviour change.
- dm3 melee: `behavior.delayed_attack` → `behavior.melee_box_attack`.
- Shield keeps its pose through the 12-second threat-grace window instead of dropping it the tick the target disappears.

### Fixed

- **Backpack slot 0 is the saddle slot** — purge and `Container.setItem` boundaries are pinned at index 1. Writing 2 deletes the first item the player sees.
- **Armor removal** — `replaceitem … slot.armor.X air` must be sent for all four indices, or the armor stays on.
- **Form on recall** — the death ball used to write variant 0, so a maid who died holding a sword came back idle with her weapon record still live and handed the real sword over on the first right-click. Her form now survives.
- **Name on the ball** — the death ball never set an item name. It now takes `§r` + her custom name, same as a manual recall.
- **Full inventory** — the ball used to spawn inside your body and lose its data, dumping the whole kit back at the death spot. It now lands clear of you, its payload is re-verified before anything is swept, and the ground copy is kept if that check fails.
