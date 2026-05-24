// scripts/helpers/config.js — Wild Talents 2e Configuration

export const WT = {};

/**
 * Debug flag for roller diagnostics. Never commit as true.
 * @constant {boolean}
 */
export const DEBUG_ROLLS = false;

/**
 * Canonical hit locations (ORE-universal — identical to Reign).
 * @constant {string[]}
 */
export const HIT_LOCATIONS = Object.freeze(["head", "torso", "armR", "armL", "legR", "legL"]);
export const HIT_LOCATIONS_SET = new Set(HIT_LOCATIONS);

export const HIT_LOCATION_LABELS = Object.freeze({
  head: "Head (10)", torso: "Torso (7–9)", armR: "R. Arm (5–6)",
  armL: "L. Arm (3–4)", legR: "R. Leg (2)", legL: "L. Leg (1)"
});

export const HIT_LOCATION_SHORT_LABELS = Object.freeze({
  head: "Head", torso: "Torso", armR: "Right Arm", armL: "Left Arm",
  legR: "Right Leg", legL: "Left Leg"
});

/**
 * Pool cap for ORE rolls (WT standard).
 * 📖 WT Rulebook Ch2 — verify maximum pool size
 */
WT.MAX_DICE = 10;

/**
 * WT suggested skills mapped to their default attributes.
 * WT Rulebook Reference Sheet — official skill list.
 * Skills are freeform in WT — this is a suggested-defaults list for
 * new characters and the roller dropdown. Players can define custom
 * skills with any attribute binding.
 *
 * Skills with "(Type)" are parameterised — players specify the type
 * when adding the skill (e.g., "Melee Weapon (Sword)", "Language (French)").
 */
export const SUGGESTED_SKILLS = Object.freeze({
  // Body
  athletics: "body",
  block: "body",
  brawling: "body",
  endurance: "body",
  meleeWeapon: "body",          // Melee Weapon (Type)

  // Coordination
  dodge: "coordination",
  driving: "coordination",      // Driving (Type)
  rangedWeapon: "coordination", // Ranged Weapon (Type)
  stealth: "coordination",

  // Sense
  empathy: "sense",
  scrutiny: "sense",
  perception: "sense",

  // Mind
  firstAid: "mind",
  knowledge: "mind",            // Knowledge (Type)
  language: "mind",             // Language (Type)
  medicine: "mind",
  navigation: "mind",
  research: "mind",
  securitySystems: "mind",
  streetwise: "mind",
  survival: "mind",
  tactics: "mind",

  // Charm
  lie: "charm",
  performance: "charm",         // Performance (Type)
  persuasion: "charm",

  // Command
  interrogation: "command",
  intimidation: "command",
  leadership: "command",
  stability: "command"
});

// ── Effect Dictionary ──

let _effectDictionaryCache = null;

/**
 * Active Effect dictionary for WT character sheets.
 * Rebuilt for WT modifier paths (HAR/LAR instead of single AR, willpower, etc.)
 */
export function getEffectDictionary() {
  if (_effectDictionaryCache) return _effectDictionaryCache;

  const dict = [];

  // Global
  dict.push({ group: "Global", value: "system.modifiers.globalPool", label: "Bonus Dice Pool", mode: 2 });
  dict.push({ group: "Global", value: "system.modifiers.globalSpeed", label: "Bonus Speed (Initiative)", mode: 2 });

  // Willpower
  dict.push({ group: "Willpower", value: "system.willpower.max", label: "Max Willpower Modifier", mode: 2 });

  // Combat & Damage
  dict.push({ group: "Combat", value: "system.modifiers.combat.bonusDamageShock", label: "Bonus Shock Damage", mode: 2 });
  dict.push({ group: "Combat", value: "system.modifiers.combat.bonusDamageKilling", label: "Bonus Killing Damage", mode: 2 });
  dict.push({ group: "Combat", value: "system.modifiers.combat.ignoreArmorTarget", label: "Ignore Target Armor (points)", mode: 2 });

  // HAR / LAR per location
  for (const [k, v] of Object.entries(HIT_LOCATION_SHORT_LABELS)) {
    dict.push({ group: "Heavy Armor (HAR)", value: `system.modifiers.naturalHAR.${k}`, label: `${v} HAR`, mode: 2 });
    dict.push({ group: "Light Armor (LAR)", value: `system.modifiers.naturalLAR.${k}`, label: `${v} LAR`, mode: 2 });
    dict.push({ group: "Health Boxes", value: `system.modifiers.healthMax.${k}`, label: `${v} Bonus Boxes`, mode: 2 });
  }

  // Hit Redirection
  for (const [k, v] of Object.entries(HIT_LOCATION_SHORT_LABELS)) {
    dict.push({ group: "Hit Redirection", value: `system.modifiers.hitRedirects.${k}`, label: `Redirect ${v} to...`, mode: 5, isString: true });
  }

  // Immunities
  dict.push({ group: "Immunities", value: "system.modifiers.systemFlags.ignoreFatiguePenalties", label: "Ignore Fatigue", mode: 5, isBool: true });
  dict.push({ group: "Immunities", value: "system.modifiers.systemFlags.cannotUseTwoHanded", label: "Cannot Use Two-Handed", mode: 5, isBool: true });

  _effectDictionaryCache = Object.freeze(dict);
  return _effectDictionaryCache;
}

/**
 * Shield coverage utility (ORE-universal).
 */
export function getEffectiveShieldLocations(shieldSystemData) {
  const locs = shieldSystemData.protectedLocations || {};
  const anyActive = Object.values(locs).some(v => v === true);
  let effectiveLocations = foundry.utils.deepClone(locs);
  if (!anyActive && shieldSystemData.equipped && shieldSystemData.shieldArm) {
    effectiveLocations[shieldSystemData.shieldArm] = true;
  }
  return effectiveLocations;
}

/**
 * Item-specific Active Effect extras.
 * Returns additional effect dictionary entries for item sheets.
 * TODO: Populate with WT-specific item effect paths (power modifiers, etc.)
 */
export function getItemEffectExtras() {
  return [];
}
