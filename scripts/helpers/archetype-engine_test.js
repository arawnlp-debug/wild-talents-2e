// scripts/helpers/archetype-engine_test.js — Unit Tests for Archetype & Cost Engine
//
// Run via: node --experimental-vm-modules scripts/helpers/archetype-engine_test.js
// (Or integrate into CI alongside ore-engine_test.js)

/* global process */

import {
  META_QUALITY_CATALOG,
  POWER_LEVEL_PRESETS,
  calculateAllergyCost,
  calculateInhumanStatsCost,
  calculateVulnerableCost,
  calculateArchetypeCost,
  validateArchetype,
  calculateTotalCharacterCost
} from "./archetype-engine.js";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label} — expected ${expected}, got ${actual}`);
  }
}

function section(name) {
  console.log(`\n── ${name} ──`);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  CATALOG INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════════

section("Meta-Quality Catalog");

assert(Object.keys(META_QUALITY_CATALOG).length >= 26, "Catalog has ≥26 entries");
assert(META_QUALITY_CATALOG.conduit.type === "source", "Conduit is a Source");
assert(META_QUALITY_CATALOG.super.type === "permission", "Super is a Permission");
assert(META_QUALITY_CATALOG.mutable.type === "intrinsic", "Mutable is an Intrinsic");
assert(META_QUALITY_CATALOG.super.cost === 15, "Super costs 15 pts");
assert(META_QUALITY_CATALOG.powerFocus.cost === -8, "Power Focus costs -8 pts");
assert(META_QUALITY_CATALOG.unknown.cost === -5, "Unknown costs -5 pts");
assert(META_QUALITY_CATALOG.allergy.variableCost === true, "Allergy is variable-cost");


// ═══════════════════════════════════════════════════════════════════════════════
//  ALLERGY COST
// ═══════════════════════════════════════════════════════════════════════════════

section("Allergy Cost Calculation");

// 📖 WT Rulebook Ch5 p.99
assertEqual(calculateAllergyCost({ frequency: "common", effect: "kills" }), -8,
  "Common + Kills = -8");
assertEqual(calculateAllergyCost({ frequency: "rare", effect: "incapacitates" }), -1,
  "Rare + Incapacitates = -1");
assertEqual(calculateAllergyCost({ frequency: "common", effect: "drainsWillpower" }), -16,
  "Common + Drains WP = -16");
assertEqual(calculateAllergyCost({ frequency: "uncommon", effect: "kills", touchOnly: true }), -2,
  "Uncommon + Kills + Touch Only = -2 (half of -4)");
assertEqual(calculateAllergyCost({ frequency: "rare", effect: "kills", touchOnly: true }), -1,
  "Rare + Kills + Touch Only = -1 (half of -2, ceil toward zero)");
assertEqual(calculateAllergyCost({}), 0,
  "Missing params = 0");


// ═══════════════════════════════════════════════════════════════════════════════
//  INHUMAN STATS COST
// ═══════════════════════════════════════════════════════════════════════════════

section("Inhuman Stats Cost Calculation");

// 📖 WT Rulebook Ch5 p.97–98
assertEqual(calculateInhumanStatsCost({ statMaximums: { body: 10 } }), 3,
  "Body to 10 = 3 pts");
assertEqual(calculateInhumanStatsCost({ statMaximums: { body: 10, coordination: 3 } }), 1,
  "Body 10 (+3), Coordination 3 (-2) = 1 pt (min 1)");
assertEqual(calculateInhumanStatsCost({ statMaximums: { body: 10, coordination: 10 } }), 6,
  "Body 10, Coordination 10 = 6 pts");
assertEqual(calculateInhumanStatsCost({ statMaximums: { body: 3, coordination: 2 } }), 1,
  "Both below 5 = clamped to minimum 1");
assertEqual(calculateInhumanStatsCost({}), 1,
  "No stat modifications = minimum 1");


// ═══════════════════════════════════════════════════════════════════════════════
//  VULNERABLE COST
// ═══════════════════════════════════════════════════════════════════════════════

section("Vulnerable Cost Calculation");

assertEqual(calculateVulnerableCost({ extraBrainBoxes: 1 }), -2, "1 extra brain box = -2");
assertEqual(calculateVulnerableCost({ extraBrainBoxes: 3 }), -6, "3 extra brain boxes = -6");
assertEqual(calculateVulnerableCost({}), 0, "No params = 0");


// ═══════════════════════════════════════════════════════════════════════════════
//  ARCHETYPE COST — FIRST SOURCE FREE
// ═══════════════════════════════════════════════════════════════════════════════

section("Archetype Cost — First Source Free");

{
  // Simple case: one Source (free) + one Permission
  const result = calculateArchetypeCost([
    { id: "genetic", type: "source", name: "Genetic" },
    { id: "super", type: "permission", name: "Super" }
  ]);
  assertEqual(result.totalCost, 15, "Genetic (free) + Super (15) = 15");
  assertEqual(result.breakdown[0].cost, 0, "First Source cost is 0");
  assertEqual(result.breakdown[1].cost, 15, "Super cost is 15");
}

{
  // Two Sources: first free, second at cost
  const result = calculateArchetypeCost([
    { id: "genetic", type: "source", name: "Genetic" },
    { id: "psi", type: "source", name: "Psi" },
    { id: "powerTheme", type: "permission", name: "Power Theme" }
  ]);
  assertEqual(result.totalCost, 10, "Genetic (free) + Psi (5) + Power Theme (5) = 10");
}

{
  // Negative-cost Source as first (still free)
  const result = calculateArchetypeCost([
    { id: "powerFocus", type: "source", name: "Power Focus" },
    { id: "onePower", type: "permission", name: "One Power" }
  ]);
  assertEqual(result.totalCost, 1, "Power Focus (free, not -8) + One Power (1) = 1");
}


// ═══════════════════════════════════════════════════════════════════════════════
//  ARCHETYPE COST — MINIMUM ZERO
// ═══════════════════════════════════════════════════════════════════════════════

section("Archetype Cost — Minimum Zero Clamp");

{
  // Lots of negative intrinsics — should clamp to 0
  const result = calculateArchetypeCost([
    { id: "unknown", type: "source", name: "Unknown" },      // free (first source)
    { id: "onePower", type: "permission", name: "One Power" }, // 1
    { id: "noBaseWill", type: "intrinsic", name: "No Base Will" }, // -10
    { id: "unhealing", type: "intrinsic", name: "Unhealing" }     // -8
  ]);
  assertEqual(result.totalCost, 0, "1 - 10 - 8 = -17, clamped to 0");
  assert(result.warnings.some(w => w.includes("clamped")), "Warning about clamping issued");
}


// ═══════════════════════════════════════════════════════════════════════════════
//  ARCHETYPE COST — VARIABLE-COST INTRINSICS
// ═══════════════════════════════════════════════════════════════════════════════

section("Archetype Cost — Variable-Cost Intrinsics");

{
  // Allergy with parameters
  const result = calculateArchetypeCost([
    { id: "genetic", type: "source", name: "Genetic" },
    { id: "super", type: "permission", name: "Super" },
    { id: "allergy", type: "intrinsic", name: "Allergy", parameters: { frequency: "common", effect: "kills" } }
  ]);
  assertEqual(result.totalCost, 7, "15 (Super) + (-8 Allergy) = 7");
}

{
  // Inhuman Stats with parameters
  const result = calculateArchetypeCost([
    { id: "genetic", type: "source", name: "Genetic" },
    { id: "inhumanStats", type: "permission", name: "Inhuman Stats", parameters: { statMaximums: { body: 10 } } }
  ]);
  assertEqual(result.totalCost, 3, "Inhuman Stats (body 10) = 3");
}


// ═══════════════════════════════════════════════════════════════════════════════
//  ARCHETYPE COST — SAMPLE ARCHETYPES FROM RULEBOOK
// ═══════════════════════════════════════════════════════════════════════════════

section("Archetype Cost — Rulebook Sample Archetypes");

{
  // Mutant (5 pts): Source Genetic + Permission Power Theme
  // 📖 WT Rulebook Ch5 p.103
  const result = calculateArchetypeCost([
    { id: "genetic", type: "source", name: "Genetic" },
    { id: "powerTheme", type: "permission", name: "Power Theme" }
  ]);
  assertEqual(result.totalCost, 5, "Mutant = Genetic (free) + Power Theme (5) = 5");
}

{
  // Super-Normal (5 pts): Source Driven + Permission Peak Performer
  // 📖 WT Rulebook Ch5 p.103
  const result = calculateArchetypeCost([
    { id: "driven", type: "source", name: "Driven" },
    { id: "peakPerformer", type: "permission", name: "Peak Performer" }
  ]);
  assertEqual(result.totalCost, 5, "Super-Normal = Driven (free) + Peak Performer (5) = 5");
}

{
  // Human+ (15 pts): Source Genetic + Permission Super
  // 📖 WT Rulebook Ch5 p.103
  const result = calculateArchetypeCost([
    { id: "genetic", type: "source", name: "Genetic" },
    { id: "super", type: "permission", name: "Super" }
  ]);
  assertEqual(result.totalCost, 15, "Human+ = Genetic (free) + Super (15) = 15");
}

{
  // Anachronist (20 pts): Source (pick one, free) + Inventor (5) + Mutable (15)
  // 📖 WT Rulebook Ch5 p.102
  const result = calculateArchetypeCost([
    { id: "technological", type: "source", name: "Technological" },
    { id: "inventor", type: "permission", name: "Inventor" },
    { id: "mutable", type: "intrinsic", name: "Mutable" }
  ]);
  assertEqual(result.totalCost, 20, "Anachronist = Tech (free) + Inventor (5) + Mutable (15) = 20");
}

{
  // Artificial (12 pts): Source Construct + Super (15) + No Base Will (-10) + Mutable (15) + Unhealing (-8)
  // 📖 WT Rulebook Ch5 p.103
  const result = calculateArchetypeCost([
    { id: "construct", type: "source", name: "Construct" },
    { id: "super", type: "permission", name: "Super" },
    { id: "noBaseWill", type: "intrinsic", name: "No Base Will" },
    { id: "mutable", type: "intrinsic", name: "Mutable" },
    { id: "unhealing", type: "intrinsic", name: "Unhealing" }
  ]);
  assertEqual(result.totalCost, 12, "Artificial = 0 + 15 - 10 + 15 - 8 = 12");
}

{
  // Godlike Talent (0 pts): Psi (free) + Super (15) + Mandatory Power (0) + WP Contest (-10) + No WP No Way (-5)
  // 📖 WT Rulebook Ch5 p.103
  const result = calculateArchetypeCost([
    { id: "psi", type: "source", name: "Psi" },
    { id: "super", type: "permission", name: "Super" },
    { id: "mandatoryPower", type: "intrinsic", name: "Mandatory Power" },
    { id: "willpowerContest", type: "intrinsic", name: "Willpower Contest" },
    { id: "noWillpowerNoWay", type: "intrinsic", name: "No Willpower No Way" }
  ]);
  assertEqual(result.totalCost, 0, "Godlike Talent = 0 + 15 + 0 - 10 - 5 = 0");
}


// ═══════════════════════════════════════════════════════════════════════════════
//  ARCHETYPE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

section("Archetype Validation");

{
  // No source but has powers → error
  const result = validateArchetype(
    [{ id: "super", type: "permission", name: "Super" }],
    [{ powerType: "miracle" }]
  );
  assert(!result.valid, "Invalid: powers without Source");
  assert(result.errors.some(e => e.includes("Source")), "Error mentions Source");
}

{
  // No permission but has powers → error
  const result = validateArchetype(
    [{ id: "genetic", type: "source", name: "Genetic" }],
    [{ powerType: "miracle" }]
  );
  assert(!result.valid, "Invalid: powers without Permission");
}

{
  // Valid archetype with matching permissions
  const result = validateArchetype(
    [
      { id: "genetic", type: "source", name: "Genetic" },
      { id: "super", type: "permission", name: "Super" }
    ],
    [{ powerType: "miracle" }]
  );
  assert(result.valid, "Valid: Source + Super + Miracle");
}

{
  // Hypertrained with Miracles → warning
  const result = validateArchetype(
    [
      { id: "lifeForce", type: "source", name: "Life Force" },
      { id: "hypertrained", type: "permission", name: "Hypertrained" }
    ],
    [{ powerType: "miracle" }]
  );
  assert(result.valid, "Still valid (warning, not error)");
  assert(result.warnings.some(w => w.includes("Hypertrained")), "Warning about Hypertrained + Miracle");
}

{
  // One Power with 2 powers → warning
  const result = validateArchetype(
    [
      { id: "genetic", type: "source", name: "Genetic" },
      { id: "onePower", type: "permission", name: "One Power" }
    ],
    [{ powerType: "miracle" }, { powerType: "hyperstat" }]
  );
  assert(result.warnings.some(w => w.includes("One Power")), "Warning about exceeding One Power limit");
}

{
  // No powers, no archetype → valid (normal human)
  const result = validateArchetype([], []);
  assert(result.valid, "Valid: normal human with no archetype");
}


// ═══════════════════════════════════════════════════════════════════════════════
//  CHARACTER TOTAL COST
// ═══════════════════════════════════════════════════════════════════════════════

section("Character Total Cost");

{
  // Minimal normal human: Body 2d, Mind 2d, all others 1d, no skills
  // Cost: 6 stats × varying dice × 5/die
  const data = {
    attributes: {
      body:         { normal: 2, hard: 0, wiggle: 0 },
      coordination: { normal: 1, hard: 0, wiggle: 0 },
      sense:        { normal: 1, hard: 0, wiggle: 0 },
      mind:         { normal: 2, hard: 0, wiggle: 0 },
      charm:        { normal: 1, hard: 0, wiggle: 0 },
      command:      { normal: 1, hard: 0, wiggle: 0 }
    },
    skills: {},
    archetypeData: { metaQualities: [] },
    willpower: { base: 2, current: 2, max: 2 }
  };
  // Stats: (2+1+1+2+1+1) × 5 = 40
  // BW: computed = 1+1 = 2, max = 2, extra = 0
  const result = calculateTotalCharacterCost(data, []);
  assertEqual(result.breakdown.stats, 40, "8 normal stat dice × 5 = 40");
  assertEqual(result.breakdown.skills, 0, "No skills = 0");
  assertEqual(result.breakdown.archetype, 0, "No archetype = 0");
  assertEqual(result.breakdown.powers, 0, "No powers = 0");
  assertEqual(result.breakdown.baseWill, 0, "No extra BW = 0");
  assertEqual(result.total, 40, "Total = 40");
}

{
  // Character with HD stat, skills, archetype, and a power
  const data = {
    attributes: {
      body:         { normal: 3, hard: 1, wiggle: 0 },  // 3×5 + 1×10 = 25
      coordination: { normal: 2, hard: 0, wiggle: 0 },  // 2×5 = 10
      sense:        { normal: 2, hard: 0, wiggle: 0 },  // 10
      mind:         { normal: 2, hard: 0, wiggle: 0 },  // 10
      charm:        { normal: 2, hard: 0, wiggle: 0 },  // 10
      command:      { normal: 2, hard: 0, wiggle: 0 }   // 10
    },
    skills: {
      brawling: { value: 3, hard: 0, wiggle: 0, attribute: "body" },  // 3×2 = 6
      dodge:    { value: 2, hard: 0, wiggle: 0, attribute: "coordination" } // 2×2 = 4
    },
    archetypeData: {
      metaQualities: [
        { id: "genetic", type: "source", name: "Genetic" },
        { id: "super", type: "permission", name: "Super" }
      ]
    },
    willpower: { base: 4, current: 4, max: 4 }
  };
  const powers = [
    { powerType: "miracle", totalCost: 20 }
  ];
  // Stats: 25+10+10+10+10+10 = 75
  // Skills: 6+4 = 10
  // Archetype: Genetic (free) + Super (15) = 15
  // Powers: 20
  // BW: computed = 2+2 = 4, max = 4, extra = 0
  const result = calculateTotalCharacterCost(data, powers);
  assertEqual(result.breakdown.stats, 75, "Stats = 75");
  assertEqual(result.breakdown.skills, 10, "Skills = 10");
  assertEqual(result.breakdown.archetype, 15, "Archetype = 15");
  assertEqual(result.breakdown.powers, 20, "Powers = 20");
  assertEqual(result.breakdown.baseWill, 0, "No extra BW");
  assertEqual(result.total, 120, "Total = 120");
}

{
  // Extra Base Will purchased
  const data = {
    attributes: {
      body: { normal: 2, hard: 0, wiggle: 0 },
      coordination: { normal: 2, hard: 0, wiggle: 0 },
      sense: { normal: 2, hard: 0, wiggle: 0 },
      mind: { normal: 2, hard: 0, wiggle: 0 },
      charm: { normal: 2, hard: 0, wiggle: 0 },   // 2
      command: { normal: 2, hard: 0, wiggle: 0 }   // 2
    },
    skills: {},
    archetypeData: { metaQualities: [] },
    willpower: { base: 4, current: 7, max: 7 }
    // Computed BW = 2+2 = 4.  Max = 7.  Extra BW = 3.  Cost = 3×3 = 9.
  };
  const result = calculateTotalCharacterCost(data, []);
  assertEqual(result.breakdown.stats, 60, "Stats: 12 dice × 5 = 60");
  assertEqual(result.breakdown.baseWill, 9, "3 extra BW × 3 = 9");
  assertEqual(result.total, 69, "Total = 60 + 9 = 69");
}

{
  // Wiggle dice on a stat
  const data = {
    attributes: {
      body: { normal: 3, hard: 0, wiggle: 1 },  // 3×5 + 1×20 = 35
      coordination: { normal: 2, hard: 0, wiggle: 0 },
      sense: { normal: 2, hard: 0, wiggle: 0 },
      mind: { normal: 2, hard: 0, wiggle: 0 },
      charm: { normal: 1, hard: 0, wiggle: 0 },
      command: { normal: 1, hard: 0, wiggle: 0 }
    },
    skills: {},
    archetypeData: { metaQualities: [] },
    willpower: { base: 2, current: 2, max: 2 }
  };
  const result = calculateTotalCharacterCost(data, []);
  assertEqual(result.breakdown.stats, 75, "Stats: 35 + 10+10+10+5+5 = 75");
}

{
  // HD skill dice
  const data = {
    attributes: {
      body: { normal: 2, hard: 0, wiggle: 0 },
      coordination: { normal: 2, hard: 0, wiggle: 0 },
      sense: { normal: 2, hard: 0, wiggle: 0 },
      mind: { normal: 2, hard: 0, wiggle: 0 },
      charm: { normal: 2, hard: 0, wiggle: 0 },
      command: { normal: 2, hard: 0, wiggle: 0 }
    },
    skills: {
      brawling: { value: 2, hard: 1, wiggle: 0, attribute: "body" }
      // 2×2 + 1×4 = 8
    },
    archetypeData: { metaQualities: [] },
    willpower: { base: 4, current: 4, max: 4 }
  };
  const result = calculateTotalCharacterCost(data, []);
  assertEqual(result.breakdown.skills, 8, "Skill: 2N×2 + 1HD×4 = 8");
}


// ═══════════════════════════════════════════════════════════════════════════════
//  POWER LEVEL PRESETS
// ═══════════════════════════════════════════════════════════════════════════════

section("Power Level Presets");

assert(POWER_LEVEL_PRESETS.powerful.points === 250, "Powerful preset = 250");
assert(POWER_LEVEL_PRESETS.custom.points === 0, "Custom preset = 0");
assert(Object.keys(POWER_LEVEL_PRESETS).length === 7, "7 presets (including custom)");


// ═══════════════════════════════════════════════════════════════════════════════
//  SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${"═".repeat(50)}`);
console.log(`  Archetype Engine Tests: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}`);

if (failed > 0) process.exit(1);
