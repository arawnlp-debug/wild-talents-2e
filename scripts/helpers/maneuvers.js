// scripts/helpers/maneuvers.js
//
// Chapter 7: Advanced Combat — Centralized Maneuver Definitions
//
// Every maneuver from RAW Ch7 is defined here. The roller dialog reads this
// to populate the dropdown menu and auto-apply pool modifications. The chat
// engine reads it to resolve Width-tiered outcomes. damage.js reads it to
// apply special damage flags (Knockout conversion, Charge bonus damage).
//
// TIER 1 = Full automation (pool mods, outcome resolution, damage/status).
// TIER 2 = Data-defined, rules text shown in chat, GM resolves manually.

/**
 * @typedef {Object} ManeuverDef
 * @property {string}  id              - Unique key.
 * @property {string}  label           - Localization key for the name.
 * @property {string}  category        - "simple" | "advanced" | "expert"
 * @property {number}  tier            - 1 = fully automated, 2 = GM-resolved
 * @property {string}  poolType        - "attack" | "fight" | "grapple" | "dodge" | "intimidate" | "custom"
 * @property {number}  poolPenalty     - Flat dice penalty applied to the pool (e.g. -1 for Tackle).
 * @property {number}  difficulty      - Minimum Height required (e.g. 3 for Slam).
 * @property {string|null} calledShot  - Forced called-shot location key, or null.
 * @property {boolean} calledShotPenalty - Whether the standard -1d called-shot penalty applies.
 * @property {boolean} requiresKill    - Must kill the target to trigger the effect (Display Kill).
 * @property {boolean} firstRoundOnly  - Can only be used on the first round of combat.
 * @property {boolean} isMultiAction   - Requires a multiple-action declaration.
 * @property {boolean} noDamage        - The maneuver itself does no direct damage.
 * @property {Object}  widthTiers      - Keyed by minimum Width (2, 3, 4). Each tier describes the outcome.
 * @property {string}  rulesText       - Localization key for the rules summary shown in chat (Tier 2).
 */

export const MANEUVERS = Object.freeze({

  // =============================================
  // SIMPLE MANEUVERS (Ch7 p126-129)
  // =============================================

  displayMove: {
    id: "displayMove",
    label: "WT.ManeuverDisplayMove",
    category: "simple",
    tier: 2,
    poolType: "attack",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: true,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {
      2: { description: "WT.ManeuverDisplayMoveResult" }
    },
    rulesText: "WT.ManeuverDisplayMoveRules"
  },

  draw: {
    id: "draw",
    label: "WT.ManeuverDraw",
    category: "simple",
    tier: 2,
    poolType: "attack",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {},
    rulesText: "WT.ManeuverDrawRules"
  },

  feint: {
    id: "feint",
    label: "WT.ManeuverFeint",
    category: "simple",
    tier: 2,
    poolType: "attack",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {
      2: { description: "WT.ManeuverFeintResult" }
    },
    rulesText: "WT.ManeuverFeintRules"
  },

  pin: {
    id: "pin",
    label: "WT.ManeuverPin",
    category: "simple",
    tier: 1,
    poolType: "grapple",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {
      2: { applyStatus: "pinned", statusTarget: "target", description: "WT.ManeuverPinResult" }
    },
    rulesText: "WT.ManeuverPinRules"
  },

  restrain: {
    id: "restrain",
    label: "WT.ManeuverRestrain",
    category: "simple",
    tier: 1,
    poolType: "grapple",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {
      2: { applyStatus: "restrained", statusTarget: "target", description: "WT.ManeuverRestrainResult" }
    },
    rulesText: "WT.ManeuverRestrainRules"
  },

  shove: {
    id: "shove",
    label: "WT.ManeuverShove",
    category: "simple",
    tier: 1,
    poolType: "attack",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {
      2: { setFlag: "shoveBonusAgainst", statusTarget: "target", description: "WT.ManeuverShoveResult" }
    },
    rulesText: "WT.ManeuverShoveRules"
  },

  stand: {
    id: "stand",
    label: "WT.ManeuverStand",
    category: "simple",
    tier: 1,
    poolType: "attack",
    poolPenalty: -1,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {
      2: { clearStatus: "prone", statusTarget: "self", description: "WT.ManeuverStandResult" }
    },
    rulesText: "WT.ManeuverStandRules"
  },

  tackle: {
    id: "tackle",
    label: "WT.ManeuverTackle",
    category: "simple",
    tier: 2,
    poolType: "grapple",
    poolPenalty: -1,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: false,
    widthTiers: {
      2: { description: "WT.ManeuverTackleResult" }
    },
    rulesText: "WT.ManeuverTackleRules"
  },

  threaten: {
    id: "threaten",
    label: "WT.ManeuverThreaten",
    category: "simple",
    tier: 1,
    poolType: "intimidate",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: true,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {
      2: { moraleAttack: "width", description: "WT.ManeuverThreatenResult2" }
    },
    rulesText: "WT.ManeuverThreatenRules"
  },

  wait: {
    id: "wait",
    label: "WT.ManeuverWait",
    category: "simple",
    tier: 2,
    poolType: "attack",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {},
    rulesText: "WT.ManeuverWaitRules"
  },

  // =============================================
  // ADVANCED MANEUVERS (Ch7 p130-134)
  // =============================================

  charge: {
    id: "charge",
    label: "WT.ManeuverCharge",
    category: "advanced",
    tier: 1,
    poolType: "attack",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: true,
    noDamage: false,
    widthTiers: {
      2: { bonusShock: 1, bonusKilling: 0, description: "WT.ManeuverChargeResult2" },
      3: { bonusShock: 2, bonusKilling: 1, description: "WT.ManeuverChargeResult3" },
      4: { bonusShock: 3, bonusKilling: 2, description: "WT.ManeuverChargeResult4" }
    },
    rulesText: "WT.ManeuverChargeRules"
  },

  disarm: {
    id: "disarm",
    label: "WT.ManeuverDisarm",
    category: "advanced",
    tier: 1,
    poolType: "attack",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: "arm",           // Player chooses which arm
    calledShotPenalty: true,     // Standard -1d called-shot penalty applies
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: true,              // 2× does no damage; higher tiers do Shock to hand
    widthTiers: {
      2: { noDamage: true, disarmDistance: "height", description: "WT.ManeuverDisarmResult2" },
      3: { bonusShock: 1, shockLocation: "arm", disarmDistance: "height", description: "WT.ManeuverDisarmResult3" },
      4: { bonusShock: 2, shockLocation: "arm", catchWeapon: true, description: "WT.ManeuverDisarmResult4" }
    },
    rulesText: "WT.ManeuverDisarmRules"
  },

  disfiguringStrike: {
    id: "disfiguringStrike",
    label: "WT.ManeuverDisfiguringStrike",
    category: "advanced",
    tier: 2,
    poolType: "attack",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: "head",
    calledShotPenalty: true,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: false,
    widthTiers: {
      2: { description: "WT.ManeuverDisfiguringStrikeResult2" },
      3: { description: "WT.ManeuverDisfiguringStrikeResult3" },
      4: { description: "WT.ManeuverDisfiguringStrikeResult4" }
    },
    rulesText: "WT.ManeuverDisfiguringStrikeRules"
  },

  displayKill: {
    id: "displayKill",
    label: "WT.ManeuverDisplayKill",
    category: "advanced",
    tier: 1,
    poolType: "attack",
    poolPenalty: -1,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: true,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: false,
    widthTiers: {
      // RAW: 2× = Morale Attack = max(Height, Width)
      // RAW: 3× = Morale Attack = max(Height, Width) + Command stat
      // RAW: 4× = Morale Attack = max(Height, Width) + Command stat + Intimidation skill
      2: { moraleAttack: "maxHeightWidth", description: "WT.ManeuverDisplayKillResult2" },
      3: { moraleAttack: "maxHeightWidth+command", description: "WT.ManeuverDisplayKillResult3" },
      4: { moraleAttack: "maxHeightWidth+command+intimidate", description: "WT.ManeuverDisplayKillResult4" }
    },
    rulesText: "WT.ManeuverDisplayKillRules"
  },

  knockout: {
    id: "knockout",
    label: "WT.ManeuverKnockout",
    category: "advanced",
    tier: 1,
    poolType: "attack",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: "head",
    calledShotPenalty: true,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: false,
    widthTiers: {
      // RAW: 2× = Normal damage, Killing becomes Shock
      // RAW: 3× = As 2×, plus +1 extra Shock
      // RAW: 4× = As 2×, plus +3 extra Shock, overflow discarded instead of converting
      2: { convertKillingToShock: true, bonusShock: 0, description: "WT.ManeuverKnockoutResult2" },
      3: { convertKillingToShock: true, bonusShock: 1, description: "WT.ManeuverKnockoutResult3" },
      4: { convertKillingToShock: true, bonusShock: 3, discardOverflow: true, description: "WT.ManeuverKnockoutResult4" }
    },
    rulesText: "WT.ManeuverKnockoutRules"
  },

  slam: {
    id: "slam",
    label: "WT.ManeuverSlam",
    category: "advanced",
    tier: 1,
    poolType: "grapple",
    poolPenalty: 0,
    difficulty: 3,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: false,
    widthTiers: {
      // RAW: all tiers make target Prone. Width 3+ adds Shock; Width 4+ hits multiple locations.
      2: { applyStatus: "prone", statusTarget: "target", slamShock: 0, slamMultiLoc: false, description: "WT.ManeuverSlamResult2" },
      3: { applyStatus: "prone", statusTarget: "target", slamShock: 1, slamMultiLoc: false, description: "WT.ManeuverSlamResult3" },
      4: { applyStatus: "prone", statusTarget: "target", slamShock: 1, slamMultiLoc: true,  description: "WT.ManeuverSlamResult4" }
    },
    rulesText: "WT.ManeuverSlamRules"
  },

  strangle: {
    id: "strangle",
    label: "WT.ManeuverStrangle",
    category: "advanced",
    tier: 1,
    poolType: "grapple",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: "head",
    calledShotPenalty: true,     // Standard -1d unless already pinned
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: false,
    widthTiers: {
      // strangleShock: initial Shock this round (string "width+1" resolved at outcome build time)
      // strangleNextRound: auto Shock next round if hold maintained
      2: { strangleShock: 2, strangleNextRound: 2, description: "WT.ManeuverStrangleResult2" },
      3: { strangleShock: 3, strangleNextRound: 3, description: "WT.ManeuverStrangleResult3" },
      4: { strangleShock: "width+1", strangleNextRound: 4, description: "WT.ManeuverStrangleResult4" }
    },
    rulesText: "WT.ManeuverStrangleRules"
  },

  trip: {
    id: "trip",
    label: "WT.ManeuverTrip",
    category: "advanced",
    tier: 1,
    poolType: "attack",
    poolPenalty: 0,
    difficulty: 0,
    calledShot: "leg",           // Player chooses which leg (1 or 2)
    calledShotPenalty: false,    // RAW EXCEPTION: No -1d penalty for Trip called shot
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {
      // RAW: 2× = No damage, target loses a die from a set, -1d penalty next round
      // RAW: 3× = As 2×, plus target is downed
      // RAW: 4× = As 3×, plus 1 Shock to each arm
      2: { loseDie: true, penaltyNextRound: 1, description: "WT.ManeuverTripResult2" },
      3: { loseDie: true, penaltyNextRound: 1, downed: true, description: "WT.ManeuverTripResult3" },
      4: { loseDie: true, penaltyNextRound: 1, downed: true, shockToArms: 1, description: "WT.ManeuverTripResult4" }
    },
    rulesText: "WT.ManeuverTripRules"
  },

  // =============================================
  // EXPERT MANEUVERS (Ch7 p134-137)
  // =============================================

  ironKiss: {
    id: "ironKiss",
    label: "WT.ManeuverIronKiss",
    category: "expert",
    tier: 1,
    poolType: "attack",
    poolPenalty: -2,             // RAW: -2d instead of the standard -1d called-shot penalty
    difficulty: 0,
    calledShot: "head",
    calledShotPenalty: false,    // The -2d IS the penalty (replaces standard -1d)
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {
      // ironKissVirtualWidth: the Width of the guaranteed auto-attack next round (Height always 10)
      2: { ironKissVirtualWidth: 2, description: "WT.ManeuverIronKissResult2" },
      3: { ironKissVirtualWidth: 4, description: "WT.ManeuverIronKissResult3" },
      4: { ironKissVirtualWidth: 6, description: "WT.ManeuverIronKissResult4" }
    },
    rulesText: "WT.ManeuverIronKissRules"
  },

  redirect: {
    id: "redirect",
    label: "WT.ManeuverRedirect",
    category: "expert",
    tier: 1,
    poolType: "dodge",
    poolPenalty: -2,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {
      // redirectWidthMod: applied to attacker's Width when redirecting (-1, 0, 0)
      // redirectAny: tier 4 only — can redirect even non-ruined attacks
      2: { redirectWidthMod: -1, redirectAny: false, description: "WT.ManeuverRedirectResult2" },
      3: { redirectWidthMod:  0, redirectAny: false, description: "WT.ManeuverRedirectResult3" },
      4: { redirectWidthMod:  0, redirectAny: true,  description: "WT.ManeuverRedirectResult4" }
    },
    rulesText: "WT.ManeuverRedirectRules"
  },

  submissionHold: {
    id: "submissionHold",
    label: "WT.ManeuverSubmissionHold",
    category: "expert",
    tier: 1,
    poolType: "grapple",
    poolPenalty: -1,             // RAW: -1d unless already pinned
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: false,
    widthTiers: {
      // holdShock: Shock applied to held limb this round
      // wrenchKilling: Killing self-inflicted if target wrenches free
      2: { holdShock: 1, wrenchKilling: 2, description: "WT.ManeuverSubmissionHoldResult2" },
      3: { holdShock: 3, wrenchKilling: 3, description: "WT.ManeuverSubmissionHoldResult3" },
      4: { holdShock: 5, wrenchKilling: 4, description: "WT.ManeuverSubmissionHoldResult4" }
    },
    rulesText: "WT.ManeuverSubmissionHoldRules"
  },

  formationCharge: {
    id: "formationCharge",
    label: "WT.ManeuverFormationCharge",
    category: "expert",
    tier: 2,
    poolType: "custom",        // Ride, Expert: Charioteer, or Expert: Sand Craft Pilot
    poolPenalty: 0,
    difficulty: 0,
    calledShot: null,
    calledShotPenalty: false,
    requiresKill: false,
    firstRoundOnly: false,
    isMultiAction: false,
    noDamage: true,
    widthTiers: {
      2: { description: "WT.ManeuverFormationChargeResult" }
    },
    rulesText: "WT.ManeuverFormationChargeRules"
  }
});

/**
 * Returns the maneuver options grouped by category for the roller dialog dropdown.
 * Each entry has { id, label, category }.
 * @returns {Object} Keyed by category with arrays of { id, label }.
 */
export function getManeuverOptions() {
  const groups = {
    simple: [],
    advanced: [],
    expert: []
  };

  for (const m of Object.values(MANEUVERS)) {
    groups[m.category].push({
      id: m.id,
      label: m.label
    });
  }

  return groups;
}

/**
 * Resolves the Width tier for a given maneuver based on the rolled Width.
 * Returns the highest matching tier (e.g., Width 5 matches the 4+ tier).
 * @param {Object} maneuver - The maneuver definition from MANEUVERS.
 * @param {number} width - The rolled Width of the set.
 * @returns {Object|null} The tier result object, or null if no tier matches.
 */
export function resolveWidthTier(maneuver, width) {
  if (!maneuver?.widthTiers) return null;

  const thresholds = Object.keys(maneuver.widthTiers)
    .map(Number)
    .sort((a, b) => b - a);   // Descending: check highest tier first

  for (const threshold of thresholds) {
    if (width >= threshold) {
      return { ...maneuver.widthTiers[threshold], tier: threshold };
    }
  }

  return null;
}

/**
 * Calculates the Morale Attack value for Display Kill based on the tier formula,
 * the set's Width/Height, and the attacker's stats.
 *
 * RAW Ch7:
 *   2× = max(Height, Width)
 *   3× = max(Height, Width) + Command stat
 *   4× = max(Height, Width) + Command stat + Intimidation skill
 *
 * @param {Object} tierResult - The resolved tier from resolveWidthTier.
 * @param {number} width - The Width of the set.
 * @param {number} height - The Height of the set.
 * @param {Object} [actorSystem={}] - The actor's system data (for Command/Intimidation).
 * @returns {number} The Morale Attack value.
 */
export function calculateManeuverMorale(tierResult, width, height, actorSystem = {}) {
  if (!tierResult?.moraleAttack) return 0;

  const formula = tierResult.moraleAttack;

  // Threaten: Morale Attack = Width
  if (formula === "width") {
    return width;
  }

  // Display Kill base: max(Height, Width)
  const base = Math.max(height, width);

  if (formula === "maxHeightWidth") {
    return base;
  }

  const commandStat = parseInt(actorSystem.attributes?.command?.value) || 0;

  if (formula === "maxHeightWidth+command") {
    return base + commandStat;
  }

  const intimidateSkill = parseInt(actorSystem.skills?.intimidate?.value) || 0;

  if (formula === "maxHeightWidth+command+intimidate") {
    return base + commandStat + intimidateSkill;
  }

  return base;
}