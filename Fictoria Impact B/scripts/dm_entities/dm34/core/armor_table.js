/*
 * armor_table.js — 自动生成，勿手改（改 tools/dm34/gen_armor_table.js）
 * 手持物品 id → 装备槽（EquipmentSlot 枚举名）。原版 38 件（写死）+ 本包自定义 0 件
 * （扫 items/*.json 的 minecraft:wearable.slot）。
 */

export const ARMOR_SLOT = {
  "minecraft:carved_pumpkin": "Head",
  "minecraft:chainmail_boots": "Feet",
  "minecraft:chainmail_chestplate": "Chest",
  "minecraft:chainmail_helmet": "Head",
  "minecraft:chainmail_leggings": "Legs",
  "minecraft:copper_boots": "Feet",
  "minecraft:copper_chestplate": "Chest",
  "minecraft:copper_helmet": "Head",
  "minecraft:copper_leggings": "Legs",
  "minecraft:creeper_head": "Head",
  "minecraft:diamond_boots": "Feet",
  "minecraft:diamond_chestplate": "Chest",
  "minecraft:diamond_helmet": "Head",
  "minecraft:diamond_leggings": "Legs",
  "minecraft:dragon_head": "Head",
  "minecraft:elytra": "Chest",
  "minecraft:golden_boots": "Feet",
  "minecraft:golden_chestplate": "Chest",
  "minecraft:golden_helmet": "Head",
  "minecraft:golden_leggings": "Legs",
  "minecraft:iron_boots": "Feet",
  "minecraft:iron_chestplate": "Chest",
  "minecraft:iron_helmet": "Head",
  "minecraft:iron_leggings": "Legs",
  "minecraft:leather_boots": "Feet",
  "minecraft:leather_chestplate": "Chest",
  "minecraft:leather_helmet": "Head",
  "minecraft:leather_leggings": "Legs",
  "minecraft:netherite_boots": "Feet",
  "minecraft:netherite_chestplate": "Chest",
  "minecraft:netherite_helmet": "Head",
  "minecraft:netherite_leggings": "Legs",
  "minecraft:piglin_head": "Head",
  "minecraft:player_head": "Head",
  "minecraft:skeleton_skull": "Head",
  "minecraft:turtle_helmet": "Head",
  "minecraft:wither_skeleton_skull": "Head",
  "minecraft:zombie_head": "Head",
};

/** 原版物品标签：任意盔甲（1.26 起可用于 ItemStack.getTags()） */
export const ARMOR_TAG = "minecraft:is_armor";

/*
 * 这件物品是不是盔甲（标签兜底）。表里查不到部位、但标签说它是盔甲时，用来给玩家一句清楚的
 * 提示，而不是把盔甲当成普通物品吞掉。
 */
export function looksLikeArmor(itemStack) {
    if (!itemStack) return false;
    try {
        const tags = itemStack.getTags ? itemStack.getTags() : [];
        return Array.isArray(tags) && tags.indexOf(ARMOR_TAG) >= 0;
    } catch (e) {
        return false;
    }
}
