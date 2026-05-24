// scripts/helpers/archetype-engine.js — Wild Talents 2e Archetype & Character Cost Engine
//
// Pure-function module — no Foundry dependency.  Fully unit-testable in isolation.
//
// Increment 6, Sprint 6.1:
//   - calculateArchetypeCost(metaQualities)
//   - validateArchetype(metaQualities, powers)
//   - calculateTotalCharacterCost(characterData)
//
// 📖 WT Rulebook Ch5 p.96–103 — Archetypes & Meta-Qualities
// 📖 WT Rulebook Reference Sheet — Character Costs
//
// CRITICAL RULEBOOK CONSTRAINT: No copyrighted text is reproduced here.
// All cost values are mechanical data referenced by page number.  The developer
// MUST verify every cost against their copy of the rulebook.

// ═══════════════════════════════════════════════════════════════════════════════
//  META-QUALITY CATALOG
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Canonical catalog of Meta-Qualities.
 *
 * Each entry stores the mechanical cost only.  Description fields contain
 * rulebook page references — never rulebook text.
 *
 * Variable-cost Intrinsics (e.g., Allergy, Inhuman Stats, Vulnerable) use
 * `variableCost: true` and `costFn` to compute cost from parameters.
 *
 * 📖 WT Rulebook Ch5 p.96–103 — verify every cost value below.
 */
export const META_QUALITY_CATALOG = Object.freeze({

  // ── Sources (📖 WT Rulebook Ch5 p.97) ──────────────────────────────────
  conduit:          { id: "conduit",          name: "Conduit",                        type: "source", cost: 5,   ref: "Ch5 p.97" },
  construct:        { id: "construct",        name: "Construct",                      type: "source", cost: 5,   ref: "Ch5 p.97" },
  cyborg:           { id: "cyborg",           name: "Cyborg",                         type: "source", cost: 5,   ref: "Ch5 p.97" },
  divine:           { id: "divine",           name: "Divine",                         type: "source", cost: 5,   ref: "Ch5 p.97" },
  driven:           { id: "driven",           name: "Driven",                         type: "source", cost: 5,   ref: "Ch5 p.97" },
  extraterrestrial: { id: "extraterrestrial", name: "Extraterrestrial/Extradimensional", type: "source", cost: 5, ref: "Ch5 p.97" },
  genetic:          { id: "genetic",          name: "Genetic",                        type: "source", cost: 5,   ref: "Ch5 p.97" },
  lifeForce:        { id: "lifeForce",        name: "Life Force",                     type: "source", cost: 5,   ref: "Ch5 p.97" },
  paranormal:       { id: "paranormal",       name: "Paranormal",                     type: "source", cost: 5,   ref: "Ch5 p.97" },
  powerFocus:       { id: "powerFocus",       name: "Power Focus",                    type: "source", cost: -8,  ref: "Ch5 p.97" },
  psi:              { id: "psi",              name: "Psi",                            type: "source", cost: 5,   ref: "Ch5 p.97" },
  technological:    { id: "technological",    name: "Technological",                  type: "source", cost: 5,   ref: "Ch5 p.97" },
  unknown:          { id: "unknown",          name: "Unknown",                        type: "source", cost: -5,  ref: "Ch5 p.97" },

  // ── Permissions (📖 WT Rulebook Ch5 p.97–98) ──────────────────────────
  hypertrained:     { id: "hypertrained",     name: "Hypertrained",                   type: "permission", cost: 5,  ref: "Ch5 p.97" },
  inhumanStats:     { id: "inhumanStats",     name: "Inhuman Stats",                  type: "permission", cost: 0,  ref: "Ch5 p.97–98", variableCost: true },
  inventor:         { id: "inventor",         name: "Inventor",                       type: "permission", cost: 5,  ref: "Ch5 p.98" },
  onePower:         { id: "onePower",         name: "One Power",                      type: "permission", cost: 1,  ref: "Ch5 p.98" },
  peakPerformer:    { id: "peakPerformer",    name: "Peak Performer",                 type: "permission", cost: 5,  ref: "Ch5 p.98" },
  powerTheme:       { id: "powerTheme",       name: "Power Theme",                    type: "permission", cost: 5,  ref: "Ch5 p.98" },
  primeSpecimen:    { id: "primeSpecimen",    name: "Prime Specimen",                 type: "permission", cost: 5,  ref: "Ch5 p.98" },
  super:            { id: "super",            name: "Super",                          type: "permission", cost: 15, ref: "Ch5 p.98" },
  superEquipment:   { id: "superEquipment",   name: "Super-Equipment",                type: "permission", cost: 2,  ref: "Ch5 p.98" },

  // ── Intrinsics (📖 WT Rulebook Ch5 p.98–101) ──────────────────────────
  allergy:          { id: "allergy",          name: "Allergy",                        type: "intrinsic", cost: 0,   ref: "Ch5 p.99",  variableCost: true },
  bruteFrail:       { id: "bruteFrail",       name: "Brute/Frail",                    type: "intrinsic", cost: -8,  ref: "Ch5 p.99" },
  customStats:      { id: "customStats",      name: "Custom Stats",                   type: "intrinsic", cost: 5,   ref: "Ch5 p.99" },
  globular:         { id: "globular",         name: "Globular",                       type: "intrinsic", cost: 8,   ref: "Ch5 p.100" },
  inhuman:          { id: "inhuman",          name: "Inhuman",                        type: "intrinsic", cost: -8,  ref: "Ch5 p.100" },
  mandatoryPower:   { id: "mandatoryPower",   name: "Mandatory Power",                type: "intrinsic", cost: 0,   ref: "Ch5 p.100" },
  mutable:          { id: "mutable",          name: "Mutable",                        type: "intrinsic", cost: 15,  ref: "Ch5 p.100" },
  noBaseWill:       { id: "noBaseWill",       name: "No Base Will",                   type: "intrinsic", cost: -10, ref: "Ch5 p.100" },
  noWillpower:      { id: "noWillpower",      name: "No Willpower",                   type: "intrinsic", cost: -5,  ref: "Ch5 p.101" },
  noWillpowerNoWay: { id: "noWillpowerNoWay", name: "No Willpower No Way",            type: "intrinsic", cost: -5,  ref: "Ch5 p.101" },
  unhealing:        { id: "unhealing",        name: "Unhealing",                      type: "intrinsic", cost: -8,  ref: "Ch5 p.101" },
  vulnerable:       { id: "vulnerable",       name: "Vulnerable",                     type: "intrinsic", cost: 0,   ref: "Ch5 p.101", variableCost: true },
  willpowerContest: { id: "willpowerContest", name: "Willpower Contest",              type: "intrinsic", cost: -10, ref: "Ch5 p.101" },
  // Catch-all for GM-created or campaign-specific Meta-Qualities
  custom:           { id: "custom",           name: "Custom Meta-Quality",            type: "intrinsic", cost: 0,   ref: "GM-defined", variableCost: true }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  ALLERGY COST TABLE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 📖 WT Rulebook Ch5 p.99 — Allergy cost matrix.
 * Rows: substance frequency.  Columns: effect type.
 * All values are negative (cost reductions).
 */
const ALLERGY_COST_TABLE = Object.freeze({
  common:   { incapacitates: -4,  kills: -8,  drainsWillpower: -16 },
  frequent: { incapacitates: -3,  kills: -6,  drainsWillpower: -12 },
  uncommon: { incapacitates: -2,  kills: -4,  drainsWillpower: -8 },
  rare:     { incapacitates: -1,  kills: -2,  drainsWillpower: -4 }
});

/**
 * Compute the cost of an Allergy Intrinsic from its parameters.
 *
 * @param {object} params
 * @param {string} params.frequency  — "common" | "frequent" | "uncommon" | "rare"
 * @param {string} params.effect     — "incapacitates" | "kills" | "drainsWillpower"
 * @param {boolean} [params.touchOnly=false] — halves cost reduction if true
 * @returns {number} Cost (always ≤ 0)
 *
 * 📖 WT Rulebook Ch5 p.99 — verify allergy cost table
 */
export function calculateAllergyCost(params = {}) {
  const row = ALLERGY_COST_TABLE[params.frequency];
  if (!row) return 0;
  let cost = row[params.effect] || 0;
  if (params.touchOnly) cost = Math.ceil(cost / 2); // Half, rounded toward zero
  return cost;
}


/**
 * Compute the cost of the Inhuman Stats Permission from its parameters.
 *
 * 📖 WT Rulebook Ch5 p.97–98:
 *   3 points per stat raised above the normal max of 5.
 *   −1 point per die a stat is lowered below 5.
 *   Minimum Permission cost: 1 point.
 *
 * @param {object} params
 * @param {object} params.statMaximums — e.g. { body: 10, coordination: 3 }
 *   Only include stats that differ from the normal max of 5.
 * @returns {number} Cost (always ≥ 1 if any stats are modified)
 */
export function calculateInhumanStatsCost(params = {}) {
  const statMaximums = params.statMaximums || {};
  const entries = Object.entries(statMaximums);
  if (entries.length === 0) return 1; // minimum cost

  let cost = 0;
  for (const [, max] of entries) {
    const m = parseInt(max) || 5;
    if (m > 5) cost += 3;       // Each stat above 5 costs 3
    else if (m < 5) cost -= (5 - m); // Each die below 5 saves 1
  }
  return Math.max(1, cost);
}

/**
 * Compute the cost of the Vulnerable Intrinsic.
 *
 * 📖 WT Rulebook Ch5 p.101:
 *   −2 points per extra brain box.
 *
 * @param {object} params
 * @param {number} params.extraBrainBoxes — number of extra brain boxes
 * @returns {number} Cost (always ≤ 0)
 */
export function calculateVulnerableCost(params = {}) {
  const boxes = parseInt(params.extraBrainBoxes) || 0;
  return -2 * boxes;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  ARCHETYPE COST CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate the total cost of an Archetype from its Meta-Qualities.
 *
 * Rules applied:
 *   1. The first Source is free (📖 Ch5 p.97).
 *   2. Minimum Archetype cost is 0 — never negative (📖 Ch5 p.98).
 *   3. Variable-cost MQs use their `parameters` to compute cost.
 *
 * @param {Array<object>} metaQualities — array of { id, type, cost, parameters? }
 * @returns {{ totalCost: number, breakdown: Array<{name: string, cost: number}>, warnings: string[] }}
 */
export function calculateArchetypeCost(metaQualities = []) {
  const breakdown = [];
  const warnings = [];
  let sourceCount = 0;

  for (const mq of metaQualities) {
    const catalogEntry = META_QUALITY_CATALOG[mq.id];
    let cost;

    // Resolve cost — variable-cost MQs compute from parameters
    if (mq.id === "allergy") {
      cost = calculateAllergyCost(mq.parameters || {});
    } else if (mq.id === "inhumanStats") {
      cost = calculateInhumanStatsCost(mq.parameters || {});
    } else if (mq.id === "vulnerable") {
      cost = calculateVulnerableCost(mq.parameters || {});
    } else if (mq.id === "custom") {
      // Custom MQ uses manually-entered cost
      cost = parseInt(mq.cost) || 0;
    } else if (catalogEntry) {
      cost = catalogEntry.cost;
    } else {
      // Unknown MQ — use whatever cost was stored, warn
      cost = parseInt(mq.cost) || 0;
      warnings.push(`Unknown Meta-Quality "${mq.name || mq.id}" — using manually entered cost (${cost}).`);
    }

    // First Source is free (📖 Ch5 p.97)
    if (mq.type === "source") {
      sourceCount++;
      if (sourceCount === 1) {
        breakdown.push({ name: mq.name || catalogEntry?.name || mq.id, cost: 0, note: "First Source is free" });
        continue;
      }
    }

    breakdown.push({ name: mq.name || catalogEntry?.name || mq.id, cost });
  }

  // Sum and clamp to minimum 0 (📖 Ch5 p.98)
  const rawTotal = breakdown.reduce((sum, entry) => sum + entry.cost, 0);
  const totalCost = Math.max(0, rawTotal);

  if (rawTotal < 0) {
    warnings.push(`Archetype cost clamped from ${rawTotal} to 0 (minimum Archetype cost is 0 Points).`);
  }

  return { totalCost, breakdown, warnings };
}


// ═══════════════════════════════════════════════════════════════════════════════
//  ARCHETYPE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate an Archetype's Meta-Quality composition.
 *
 * @param {Array<object>} metaQualities
 * @param {Array<object>} [powers=[]] — character's powers for permission gating
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateArchetype(metaQualities = [], powers = []) {
  const errors = [];
  const warnings = [];

  const sources     = metaQualities.filter(mq => mq.type === "source");
  const permissions = metaQualities.filter(mq => mq.type === "permission");
  const hasPowers   = powers.length > 0;

  // Must have ≥1 Source to have any powers or Intrinsics
  if (sources.length === 0 && (hasPowers || metaQualities.some(mq => mq.type === "intrinsic"))) {
    errors.push("At least one Source Meta-Quality is required to have powers or Intrinsics.");
  }

  // Must have ≥1 Permission to have powers
  if (permissions.length === 0 && hasPowers) {
    errors.push("At least one Permission Meta-Quality is required to have powers.");
  }

  // Permission-specific power type validation
  const permissionIds = new Set(permissions.map(p => p.id));

  if (hasPowers && permissions.length > 0) {
    const hasMiracles   = powers.some(p => p.powerType === "miracle");
    const hasHyperstats = powers.some(p => p.powerType === "hyperstat");
    const hasHyperskills= powers.some(p => p.powerType === "hyperskill");

    // Hypertrained: Hyperskills only (📖 Ch5 p.97)
    if (permissionIds.has("hypertrained") && !permissionIds.has("super") && !permissionIds.has("primeSpecimen") && !permissionIds.has("powerTheme")) {
      if (hasMiracles)   warnings.push("Hypertrained Permission only allows Hyperskills, but character has Miracles.");
      if (hasHyperstats) warnings.push("Hypertrained Permission only allows Hyperskills, but character has Hyperstats.");
    }

    // Prime Specimen: Hyperstats only (📖 Ch5 p.98)
    if (permissionIds.has("primeSpecimen") && !permissionIds.has("super") && !permissionIds.has("hypertrained") && !permissionIds.has("powerTheme")) {
      if (hasMiracles)    warnings.push("Prime Specimen Permission only allows Hyperstats, but character has Miracles.");
      if (hasHyperskills) warnings.push("Prime Specimen Permission only allows Hyperskills, but character has Hyperskills.");
    }

    // One Power: max 1 power (📖 Ch5 p.98)
    if (permissionIds.has("onePower") && !permissionIds.has("super") && !permissionIds.has("inventor")) {
      if (powers.length > 1) warnings.push("One Power Permission allows only a single power, but character has multiple.");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
//  CHARACTER COST TABLES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cost-per-die tables for Stats, Skills, Hyperstats, and Hyperskills.
 *
 * 📖 WT Rulebook Reference Sheet — verify all values.
 * 📖 WT Rulebook Ch2 p.40 — "Cost Per Die" doubling rule:
 *   Normal → Hard = ×2, Hard → Wiggle = ×2  (so Normal → Wiggle = ×4)
 */
export const CHARACTER_COSTS = Object.freeze({
  stat:       { normal: 5,  hard: 10, wiggle: 20 },
  skill:      { normal: 2,  hard: 4,  wiggle: 8 },
  hyperstat:  { normal: 4,  hard: 8,  wiggle: 16 },
  hyperskill: { normal: 1,  hard: 2,  wiggle: 4 },
  baseWill:   3,  // per point above computed base
  willpower:  1   // per point
});


// ═══════════════════════════════════════════════════════════════════════════════
//  TOTAL CHARACTER COST CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate the total Point cost of a character.
 *
 * @param {object} data — character system data (actor.system shape)
 * @param {object} [data.attributes] — { body: {normal,hard,wiggle}, ... }
 * @param {object} [data.skills] — { skillKey: {value,hard,wiggle}, ... }
 * @param {object} [data.archetypeData] — { metaQualities: [...] }
 * @param {object} [data.willpower] — { base, current, max }
 * @param {Array<object>} [powers=[]] — array of power system data objects
 *   Each must have { powerType, totalCost } (from WTPowerData.prepareDerivedData)
 * @returns {{
 *   total: number,
 *   breakdown: { stats: number, skills: number, archetype: number, powers: number, baseWill: number, willpower: number }
 * }}
 *
 * 📖 WT Rulebook Reference Sheet — Character Costs
 */
export function calculateTotalCharacterCost(data = {}, powers = []) {
  const costs = CHARACTER_COSTS;
  let statsCost = 0;
  let skillsCost = 0;

  // ── Stats ──
  const attrs = data.attributes || {};
  for (const stat of Object.values(attrs)) {
    statsCost += (parseInt(stat.normal) || 0) * costs.stat.normal;
    statsCost += (parseInt(stat.hard)   || 0) * costs.stat.hard;
    statsCost += (parseInt(stat.wiggle) || 0) * costs.stat.wiggle;
  }

  // ── Skills ──
  const skills = data.skills || {};
  for (const skill of Object.values(skills)) {
    const normal = parseInt(skill.value) || parseInt(skill.normal) || 0;
    skillsCost += normal * costs.skill.normal;
    skillsCost += (parseInt(skill.hard)   || 0) * costs.skill.hard;
    skillsCost += (parseInt(skill.wiggle) || 0) * costs.skill.wiggle;
  }

  // ── Archetype ──
  const archetypeResult = calculateArchetypeCost(data.archetypeData?.metaQualities || []);
  const archetypeCost = archetypeResult.totalCost;

  // ── Powers ──
  // Each power's totalCost is already computed by WTPowerData.prepareDerivedData()
  let powersCost = 0;
  for (const power of powers) {
    powersCost += parseInt(power.totalCost) || 0;
  }

  // ── Base Will ──
  // Computed Base Will = Charm + Command (total dice).  Extra BW = max − computed.
  // 📖 WT Rulebook Ch3 p.51
  const charmTotal = sumStatDice(attrs.charm);
  const commandTotal = sumStatDice(attrs.command);
  const computedBaseWill = charmTotal + commandTotal;
  const maxWill = parseInt(data.willpower?.max) || 0;
  const extraBaseWill = Math.max(0, maxWill - computedBaseWill);
  const baseWillCost = extraBaseWill * costs.baseWill;

  // ── Willpower ──
  // 📖 WT Rulebook Ch2 p.40: Remaining points become Willpower at 1:1
  // During character creation, WP cost = current WP − max (the "extra" WP bought)
  // But typically, remaining points ARE the WP — so WP cost = total − everything else
  // For display purposes, we compute how many WP points were "purchased"
  const currentWP = parseInt(data.willpower?.current) || 0;
  const purchasedWP = Math.max(0, currentWP - maxWill);
  const willpowerCost = purchasedWP * costs.willpower;

  const total = statsCost + skillsCost + archetypeCost + powersCost + baseWillCost + willpowerCost;

  return {
    total,
    breakdown: {
      stats: statsCost,
      skills: skillsCost,
      archetype: archetypeCost,
      powers: powersCost,
      baseWill: baseWillCost,
      willpower: willpowerCost
    }
  };
}

/**
 * Sum all dice (Normal + Hard + Wiggle) for a stat.
 * @param {object} stat — { normal, hard, wiggle }
 * @returns {number}
 */
function sumStatDice(stat) {
  if (!stat) return 0;
  return (parseInt(stat.normal) || 0) + (parseInt(stat.hard) || 0) + (parseInt(stat.wiggle) || 0);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  POWER LEVEL PRESETS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Campaign Point Total presets.
 * 📖 WT Rulebook Ch2 p.42 — "Character Power Levels" table.
 *
 * The "recommended" value is a representative midpoint for each tier.
 * GMs can use "custom" and set any value.
 */
export const POWER_LEVEL_PRESETS = Object.freeze({
  normalHuman:     { label: "Normal Human (40–100)",       points: 100 },
  exceptional:     { label: "Exceptional Human (100–200)", points: 200 },
  powerful:        { label: "Powerful Superhuman (200–500)", points: 250 },
  earthShaking:    { label: "Earth-Shaking Entity (500–750)", points: 500 },
  galactic:        { label: "Galactic Entity (750–1,000)", points: 750 },
  universal:       { label: "Universal Entity (1,000–2,000)", points: 1000 },
  custom:          { label: "Custom",                      points: 0 }
});
