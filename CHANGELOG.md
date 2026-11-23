# Changelog

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
