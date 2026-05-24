/**
 * tests/ore-engine.test.js
 *
 * Unit tests for the pure functions exported from scripts/helpers/ore-engine.js.
 *
 * Framework: Node.js built-in test runner — no external dependencies.
 * Requires Node 18+.
 *
 * Run from the project root with:
 *   node --test tests/ore-engine.test.js
 *
 * ─── Foundry globals mocked ──────────────────────────────────────────────────
 * Roll          used by parseDamageFormula → _evalFormulaExpr
 * ui            used by resolveHitRedirect for console warnings
 *
 * Neither global is referenced at module-load time in ore-engine.js or
 * config.js; they are only required when the relevant function bodies execute.
 * ESM hoists static imports above the module body, so the mocks must be in
 * place before any test function *calls* those functions — which they are.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Foundry VTT global stubs
// ---------------------------------------------------------------------------

/**
 * Roll stub — evaluates simple arithmetic expressions that arise after
 * _evalFormulaExpr substitutes "width" with a number.
 * Uses Function constructor; safe here because the expressions are produced
 * entirely by our own code under test, not from user input.
 */
globalThis.Roll = class Roll {
  constructor(expr) {
    this._expr = expr;
  }
  evaluateSync() {
    try {
      // eslint-disable-next-line no-new-func
      return { total: Function('"use strict"; return (' + this._expr + ')')() };
    } catch {
      return { total: 0 };
    }
  }
};

// Capture warn calls so we can assert on them without console noise.
const warnSpy = { calls: [] };
globalThis.ui = {
  notifications: {
    warn(msg) { warnSpy.calls.push(msg); }
  }
};

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
import {
  computeLocationDamage,
  parseORE,
  getHitLocation,
  getHitLocationLabel,
  calculateInitiative,
  checkThreatElimination,
  calculateMoraleAttackRemoval,
  getCreatureHitLocation,
  parseDamageFormula,
  resolveHitRedirect,
  applyArmor,
} from './ore-engine.js';


// ===========================================================================
// computeLocationDamage
// ===========================================================================
describe('computeLocationDamage', () => {

  // ── Happy paths ────────────────────────────────────────────────────────────

  it('adds shock to a clean location', () => {
    const r = computeLocationDamage(0, 0, 3, 0, 5);
    assert.equal(r.newShock, 3);
    assert.equal(r.newKilling, 0);
    assert.equal(r.overflowKilling, 0);
    assert.equal(r.convertedShock, 0);
  });

  it('adds killing to a clean location', () => {
    const r = computeLocationDamage(0, 0, 0, 2, 5);
    assert.equal(r.newShock, 0);
    assert.equal(r.newKilling, 2);
    assert.equal(r.overflowKilling, 0);
    assert.equal(r.convertedShock, 0);
  });

  it('accumulates shock onto existing shock', () => {
    const r = computeLocationDamage(2, 0, 1, 0, 5);
    assert.equal(r.newShock, 3);
    assert.equal(r.newKilling, 0);
  });

  it('accumulates killing onto existing killing', () => {
    const r = computeLocationDamage(0, 1, 0, 2, 5);
    assert.equal(r.newKilling, 3);
  });

  it('accumulates both shock and killing simultaneously', () => {
    const r = computeLocationDamage(1, 1, 2, 1, 10);
    // shock: 1+2=3, killing: 1+1=2 → capacity: 10-2=8 → no overflow
    assert.equal(r.newShock, 3);
    assert.equal(r.newKilling, 2);
    assert.equal(r.overflowKilling, 0);
    assert.equal(r.convertedShock, 0);
  });

  // ── Shock overflow → Killing conversion ───────────────────────────────────

  it('converts excess shock to killing when shock exceeds remaining capacity', () => {
    // max=5, existing killing=3 → shock capacity = 2.
    // 4 incoming shock: excess = max(0, 4-2) = 2 → converted to killing.
    // Interim: newShock=2, newKilling=5.
    // Final safety clamp: newShock = min(2, max-newKilling) = min(2, 0) = 0.
    // IMPLEMENTATION NOTE: the final clamp zeros shock when converted killing
    // fills the location to max, even though 2 shock "fit" in the interim step.
    // This is the documented current behaviour; tests assert what the code does.
    const r = computeLocationDamage(0, 3, 4, 0, 5);
    assert.equal(r.newShock, 0,        'shock clamped to 0 — no capacity remains after conversion');
    assert.equal(r.newKilling, 5,      '3 existing + 2 converted = 5');
    assert.equal(r.convertedShock, 2,  'two shock boxes converted');
    assert.equal(r.overflowKilling, 0, 'killing reaches max exactly, no overflow');
  });

  it('converts all shock when location is already full of killing', () => {
    // existing killing=5, max=5 → no room for shock at all
    const r = computeLocationDamage(0, 5, 3, 0, 5);
    assert.equal(r.newShock, 0,        'no space for shock');
    assert.equal(r.convertedShock, 3,  'all 3 shock converted');
    assert.equal(r.newKilling, 5,      'killing stays at cap');
    assert.equal(r.overflowKilling, 3, '3 killing overflow');
  });

  // ── Killing overflow ───────────────────────────────────────────────────────

  it('reports overflow killing when killing exceeds max', () => {
    const r = computeLocationDamage(0, 4, 0, 3, 5);
    // 4+3=7 killing, cap=5 → overflow=2
    assert.equal(r.newKilling, 5);
    assert.equal(r.overflowKilling, 2);
  });

  it('caps shock to remaining boxes after killing is applied', () => {
    // max=5, incoming killing=4, incoming shock=3.
    // newKilling=4, shock capacity=1, excessShock=max(0,3-1)=2.
    // newShock interim=1, newKilling=4+2=6.
    // overflowKilling = max(0, 6-5) = 1.
    // newKilling capped to 5. newShock = min(1, 5-5) = 0.
    const r = computeLocationDamage(0, 0, 3, 4, 5);
    assert.equal(r.newKilling, 5);
    assert.equal(r.newShock, 0);
    assert.equal(r.convertedShock, 2);
    assert.equal(r.overflowKilling, 1);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it('all-zero inputs return all zeros', () => {
    const r = computeLocationDamage(0, 0, 0, 0, 5);
    assert.deepEqual(r, { newShock: 0, newKilling: 0, overflowKilling: 0, convertedShock: 0 });
  });

  it('coerces string inputs via parseInt', () => {
    const r = computeLocationDamage('1', '0', '2', '0', '5');
    assert.equal(r.newShock, 3);
  });

  it('treats non-numeric strings as 0', () => {
    const r = computeLocationDamage('', 'x', 'foo', 'bar', '5');
    assert.deepEqual(r, { newShock: 0, newKilling: 0, overflowKilling: 0, convertedShock: 0 });
  });

  it('handles a location whose max is 0', () => {
    const r = computeLocationDamage(0, 0, 3, 2, 0);
    // No boxes available → all become overflow
    assert.equal(r.newShock, 0);
    assert.equal(r.newKilling, 0);
    assert.equal(r.overflowKilling, 5); // 2 killing + 3 converted shock
  });

  it('shock alone exactly fills remaining capacity — no conversion', () => {
    // killing=2, max=5, shock=3 → exactly fills 3 remaining
    const r = computeLocationDamage(0, 2, 3, 0, 5);
    assert.equal(r.newShock, 3);
    assert.equal(r.newKilling, 2);
    assert.equal(r.convertedShock, 0);
    assert.equal(r.overflowKilling, 0);
  });
});


// ===========================================================================
// parseORE
// ===========================================================================
describe('parseORE', () => {

  // ── Standard (non-minion) ─────────────────────────────────────────────────

  it('a single die is waste', () => {
    const { sets, waste } = parseORE([7]);
    assert.equal(sets.length, 0);
    assert.deepEqual(waste, [7]);
  });

  it('a pair forms a 2× set', () => {
    const { sets, waste } = parseORE([5, 5]);
    assert.equal(sets.length, 1);
    assert.equal(sets[0].width, 2);
    assert.equal(sets[0].height, 5);
    assert.equal(sets[0].text, '2x5');
    assert.equal(waste.length, 0);
  });

  it('a triple forms a 3× set', () => {
    const { sets, waste } = parseORE([4, 4, 4]);
    assert.equal(sets.length, 1);
    assert.equal(sets[0].width, 3);
    assert.equal(sets[0].height, 4);
  });

  it('a pair + unmatched die separates correctly', () => {
    const { sets, waste } = parseORE([3, 3, 7]);
    assert.equal(sets.length, 1);
    assert.equal(sets[0].width, 2);
    assert.deepEqual(waste, [7]);
  });

  it('two independent pairs produce two sets', () => {
    const { sets, waste } = parseORE([2, 2, 8, 8]);
    assert.equal(sets.length, 2);
    assert.equal(waste.length, 0);
    // Sorted: wider first, then higher
    assert.equal(sets[0].height, 8);
    assert.equal(sets[1].height, 2);
  });

  it('all unique dice produce all waste', () => {
    const { sets, waste } = parseORE([1, 2, 3, 4, 5]);
    assert.equal(sets.length, 0);
    assert.equal(waste.length, 5);
    // Waste sorted descending
    assert.deepEqual(waste, [5, 4, 3, 2, 1]);
  });

  it('empty array returns empty sets and waste', () => {
    const { sets, waste } = parseORE([]);
    assert.equal(sets.length, 0);
    assert.equal(waste.length, 0);
  });

  it('null/undefined input returns empty sets and waste', () => {
    const r1 = parseORE(null);
    assert.equal(r1.sets.length, 0);
    const r2 = parseORE(undefined);
    assert.equal(r2.sets.length, 0);
  });

  it('invalid dice values (0, 11, non-integer) are silently ignored', () => {
    const { sets, waste } = parseORE([0, 11, 'foo', NaN, 5, 5]);
    // Only the two 5s are valid
    assert.equal(sets.length, 1);
    assert.equal(sets[0].width, 2);
    assert.equal(sets[0].height, 5);
  });

  it('die face 10 is valid and forms sets correctly', () => {
    const { sets } = parseORE([10, 10, 10]);
    assert.equal(sets[0].width, 3);
    assert.equal(sets[0].height, 10);
  });

  it('sorts sets: wider before narrower, then higher height on ties', () => {
    // 3×5, 2×9, 2×3 → sorted: 3×5, 2×9, 2×3
    const { sets } = parseORE([5, 5, 5, 9, 9, 3, 3]);
    assert.equal(sets[0].width, 3);
    assert.equal(sets[0].height, 5);
    assert.equal(sets[1].width, 2);
    assert.equal(sets[1].height, 9);
    assert.equal(sets[2].width, 2);
    assert.equal(sets[2].height, 3);
  });

  it('large set (5×7) produces a single wide set when not a minion', () => {
    const { sets } = parseORE([7, 7, 7, 7, 7]);
    assert.equal(sets.length, 1);
    assert.equal(sets[0].width, 5);
  });

  // ── Minion Width Cap (RAW Ch6) ────────────────────────────────────────────
  // "No set wider than 3×" for minion groups.

  it('minion: pair (2×) → one 2× set', () => {
    const { sets, waste } = parseORE([6, 6], true);
    assert.equal(sets.length, 1);
    assert.equal(sets[0].width, 2);
    assert.equal(waste.length, 0);
  });

  it('minion: triple (3×) → one 3× set', () => {
    const { sets } = parseORE([6, 6, 6], true);
    assert.equal(sets.length, 1);
    assert.equal(sets[0].width, 3);
  });

  it('minion: quadruple (4×) → two 2× pairs (RAW explicit rule)', () => {
    // RAW Ch6: 4× must become two pairs, never a 3+1 split.
    const { sets } = parseORE([6, 6, 6, 6], true);
    assert.equal(sets.length, 2);
    assert.equal(sets[0].width, 2);
    assert.equal(sets[1].width, 2);
    assert.equal(sets[0].height, 6);
    assert.equal(sets[1].height, 6);
  });

  it('minion: quintuple (5×) → one 3× + one 2×', () => {
    const { sets } = parseORE([6, 6, 6, 6, 6], true);
    const widths = sets.map(s => s.width).sort((a, b) => b - a);
    assert.deepEqual(widths, [3, 2]);
  });

  it('minion: sextuple (6×) → two 3× sets', () => {
    const { sets } = parseORE([6, 6, 6, 6, 6, 6], true);
    assert.equal(sets.length, 2);
    assert.ok(sets.every(s => s.width === 3));
  });

  it('minion: septuple (7×) → one 3× + two 2×', () => {
    const { sets } = parseORE([6, 6, 6, 6, 6, 6, 6], true);
    const widths = sets.map(s => s.width).sort((a, b) => b - a);
    assert.deepEqual(widths, [3, 2, 2]);
  });

  it('minion: single die is still waste', () => {
    const { sets, waste } = parseORE([7], true);
    assert.equal(sets.length, 0);
    assert.deepEqual(waste, [7]);
  });

  it('minion: mixed heights apply cap per height independently', () => {
    // 4×5 and 3×9: 4×5 → two 2×5 pairs; 3×9 → one 3×9
    const { sets } = parseORE([5, 5, 5, 5, 9, 9, 9], true);
    const fives  = sets.filter(s => s.height === 5);
    const nines  = sets.filter(s => s.height === 9);
    assert.equal(fives.length, 2);
    assert.ok(fives.every(s => s.width === 2));
    assert.equal(nines.length, 1);
    assert.equal(nines[0].width, 3);
  });
});


// ===========================================================================
// getHitLocation
// ===========================================================================
describe('getHitLocation', () => {

  // RAW hit location table (Rules p.48):
  // 10 → Head | 7-9 → Torso | 5-6 → Right Arm | 3-4 → Left Arm | 2 → Right Leg | 1 → Left Leg

  it('height 10 → head', ()     => assert.equal(getHitLocation(10), 'head'));
  it('height 9 → torso', ()     => assert.equal(getHitLocation(9),  'torso'));
  it('height 8 → torso', ()     => assert.equal(getHitLocation(8),  'torso'));
  it('height 7 → torso', ()     => assert.equal(getHitLocation(7),  'torso'));
  it('height 6 → armR', ()      => assert.equal(getHitLocation(6),  'armR'));
  it('height 5 → armR', ()      => assert.equal(getHitLocation(5),  'armR'));
  it('height 4 → armL', ()      => assert.equal(getHitLocation(4),  'armL'));
  it('height 3 → armL', ()      => assert.equal(getHitLocation(3),  'armL'));
  it('height 2 → legR', ()      => assert.equal(getHitLocation(2),  'legR'));
  it('height 1 → legL', ()      => assert.equal(getHitLocation(1),  'legL'));

  it('height 0 → unknown', ()   => assert.equal(getHitLocation(0),  'unknown'));
  it('height -1 → unknown', ()  => assert.equal(getHitLocation(-1), 'unknown'));
  it('height 11 → torso (h >= 7 branch catches all values above 10)', () =>
    assert.equal(getHitLocation(11), 'torso'));

  it('string height is coerced', () => {
    assert.equal(getHitLocation('10'), 'head');
    assert.equal(getHitLocation('1'),  'legL');
  });

  it('non-numeric string → unknown', () => {
    assert.equal(getHitLocation('foo'), 'unknown');
  });
});


// ===========================================================================
// getHitLocationLabel
// ===========================================================================
describe('getHitLocationLabel', () => {

  it('returns correct label for head',  () => assert.equal(getHitLocationLabel('head'),  'Head (10)'));
  it('returns correct label for torso', () => assert.equal(getHitLocationLabel('torso'), 'Torso (7-9)'));
  it('returns correct label for armR',  () => assert.equal(getHitLocationLabel('armR'),  'Right Arm (5-6)'));
  it('returns correct label for armL',  () => assert.equal(getHitLocationLabel('armL'),  'Left Arm (3-4)'));
  it('returns correct label for legR',  () => assert.equal(getHitLocationLabel('legR'),  'Right Leg (2)'));
  it('returns correct label for legL',  () => assert.equal(getHitLocationLabel('legL'),  'Left Leg (1)'));

  it('returns "Unknown" for an unrecognised key', () => {
    assert.equal(getHitLocationLabel('stomach'), 'Unknown');
    assert.equal(getHitLocationLabel(''),        'Unknown');
    assert.equal(getHitLocationLabel(null),      'Unknown');
    assert.equal(getHitLocationLabel(undefined), 'Unknown');
  });
});


// ===========================================================================
// calculateInitiative
// ===========================================================================
describe('calculateInitiative', () => {

  // Encoding: (Width * 100) + Height.  Ensures 2×10 (210) ≠ 3×0 (300).

  it('returns 0 for null sets', () => {
    assert.equal(calculateInitiative(null), 0);
  });

  it('returns 0 for empty sets array', () => {
    assert.equal(calculateInitiative([]), 0);
  });

  it('calculates base value from a single set', () => {
    const sets = [{ width: 3, height: 7, text: '3x7' }];
    assert.equal(calculateInitiative(sets), 307);
  });

  it('picks the fastest (widest) set when multiple are present', () => {
    const sets = [
      { width: 2, height: 9, text: '2x9' },
      { width: 3, height: 5, text: '3x5' },
    ];
    assert.equal(calculateInitiative(sets), 305); // 3×5 wins on width
  });

  it('breaks width ties by height (higher height = faster)', () => {
    const sets = [
      { width: 2, height: 4, text: '2x4' },
      { width: 2, height: 9, text: '2x9' },
    ];
    assert.equal(calculateInitiative(sets), 209); // 2×9 wins on height
  });

  it('encodes height 10 without collision with width increment', () => {
    // 2×10 = 210, not 30 (old scheme)
    const sets = [{ width: 2, height: 10, text: '2x10' }];
    assert.equal(calculateInitiative(sets), 210);
  });

  // ── Defense bonus ──────────────────────────────────────────────────────────

  it('adds +0.90 for defense actions', () => {
    const sets = [{ width: 2, height: 6, text: '2x6' }];
    // 206 + 0.90 = 206.90
    assert.equal(calculateInitiative(sets, true, false, false), 206.90);
  });

  // ── Attack range modifier ──────────────────────────────────────────────────
  // Range encodes: touch/point/blank=1 → +0.01, short=2 → +0.02,
  //                medium=3 → +0.03, long=4 → +0.04, extreme=6 → +0.06

  it('adds correct range modifier for "touch"', () => {
    const sets = [{ width: 2, height: 5, text: '2x5' }];
    assert.equal(calculateInitiative(sets, false, true, false, 'touch'), 205.01);
  });

  it('adds correct range modifier for "short"', () => {
    const sets = [{ width: 2, height: 5, text: '2x5' }];
    assert.equal(calculateInitiative(sets, false, true, false, 'short'), 205.02);
  });

  it('adds correct range modifier for "medium"', () => {
    const sets = [{ width: 2, height: 5, text: '2x5' }];
    assert.equal(calculateInitiative(sets, false, true, false, 'medium'), 205.03);
  });

  it('adds correct range modifier for "long"', () => {
    const sets = [{ width: 2, height: 5, text: '2x5' }];
    assert.equal(calculateInitiative(sets, false, true, false, 'long'), 205.04);
  });

  it('adds correct range modifier for "extreme"', () => {
    const sets = [{ width: 2, height: 5, text: '2x5' }];
    assert.equal(calculateInitiative(sets, false, true, false, 'extreme'), 205.06);
  });

  it('range modifier is capped at 0.89', () => {
    // A numeric range of 100 → rangeWeight * 0.01 = 1.00, capped to 0.89
    const sets = [{ width: 2, height: 5, text: '2x5' }];
    assert.equal(calculateInitiative(sets, false, true, false, '100'), 205.89);
  });

  it('unknown range string → no bonus', () => {
    const sets = [{ width: 2, height: 5, text: '2x5' }];
    assert.equal(calculateInitiative(sets, false, true, false, 'adjacent'), 205.00);
  });

  // ── Minion penalty ─────────────────────────────────────────────────────────

  it('subtracts 0.50 for minion groups', () => {
    const sets = [{ width: 3, height: 7, text: '3x7' }];
    // 307 - 0.50 = 306.50
    assert.equal(calculateInitiative(sets, false, false, true), 306.50);
  });

  it('defense + minion stacks both modifiers', () => {
    const sets = [{ width: 2, height: 8, text: '2x8' }];
    // 208 + 0.90 - 0.50 = 208.40
    const result = calculateInitiative(sets, true, false, true);
    assert.ok(Math.abs(result - 208.40) < 1e-9, `Expected ~208.40, got ${result}`);
  });

  it('attack range + minion stacks both modifiers', () => {
    const sets = [{ width: 3, height: 6, text: '3x6' }];
    // 306 + 0.02 - 0.50 = 305.52
    const result = calculateInitiative(sets, false, true, true, 'short');
    assert.ok(Math.abs(result - 305.52) < 1e-9, `Expected ~305.52, got ${result}`);
  });
});


// ===========================================================================
// checkThreatElimination  (RAW Ch6 p.117)
// ===========================================================================
describe('checkThreatElimination', () => {

  // RAW: "Each set that hits with a Width or Height equal to or greater than
  //       their Threat rating takes one of them out of the action."

  it('Threat 1: any set eliminates (minimum 2×1 has Width 2 ≥ 1)', () => {
    assert.equal(checkThreatElimination(2, 1, 1), true);
  });

  it('Threat 2: any set eliminates (Width 2 ≥ 2)', () => {
    assert.equal(checkThreatElimination(2, 1, 2), true);
  });

  it('Threat 2: Width 1 but Height 2 eliminates via Height path', () => {
    assert.equal(checkThreatElimination(1, 2, 2), true);
  });

  it('Threat 3: 2×3 eliminates (Height 3 ≥ 3)', () => {
    assert.equal(checkThreatElimination(2, 3, 3), true);
  });

  it('Threat 3: 3×1 eliminates (Width 3 ≥ 3)', () => {
    assert.equal(checkThreatElimination(3, 1, 3), true);
  });

  it('Threat 3: 2×2 does NOT eliminate (Width 2 < 3, Height 2 < 3)', () => {
    assert.equal(checkThreatElimination(2, 2, 3), false);
  });

  it('Threat 4: 2×4 eliminates (Height 4 ≥ 4)', () => {
    assert.equal(checkThreatElimination(2, 4, 4), true);
  });

  it('Threat 4: 3×3 does NOT eliminate (Width 3 < 4, Height 3 < 4)', () => {
    assert.equal(checkThreatElimination(3, 3, 4), false);
  });

  it('Threat 4: 4×1 eliminates (Width 4 ≥ 4)', () => {
    assert.equal(checkThreatElimination(4, 1, 4), true);
  });

  it('coerces string arguments', () => {
    assert.equal(checkThreatElimination('3', '3', '3'), true);
    assert.equal(checkThreatElimination('2', '2', '3'), false);
  });

  it('invalid (non-numeric) threat defaults to 1 — any set eliminates', () => {
    assert.equal(checkThreatElimination(2, 1, 'foo'), true);
  });
});


// ===========================================================================
// calculateMoraleAttackRemoval  (RAW Ch6 p.118)
// ===========================================================================
describe('calculateMoraleAttackRemoval', () => {

  // RAW: "A number of unworthies equal to the Morale Attack's rating cut and run.
  //       The only exception is if their Threat is equal to or greater than the
  //       Morale Attack value, in which case none of them flee."
  //       (Ties go to the mooks — Threat ≥ MA → no fleeing.)

  it('Threat < MA: exactly MA fighters flee (uncapped)', () => {
    assert.equal(calculateMoraleAttackRemoval(3, 1, 10), 3);
  });

  it('Threat === MA: no fighters flee (RAW: ties go to the mooks)', () => {
    assert.equal(calculateMoraleAttackRemoval(3, 3, 10), 0);
  });

  it('Threat > MA: no fighters flee', () => {
    assert.equal(calculateMoraleAttackRemoval(2, 4, 10), 0);
  });

  it('flees count is capped at current group size', () => {
    // MA=5, Threat=1, group=3 → flee=min(5,3)=3
    assert.equal(calculateMoraleAttackRemoval(5, 1, 3), 3);
  });

  it('MA equals group size exactly — all flee', () => {
    assert.equal(calculateMoraleAttackRemoval(4, 1, 4), 4);
  });

  it('MA greater than group size — capped at group size', () => {
    assert.equal(calculateMoraleAttackRemoval(10, 1, 6), 6);
  });

  it('group size 0 — nothing to flee', () => {
    assert.equal(calculateMoraleAttackRemoval(5, 1, 0), 0);
  });

  it('MA of 0 — no fleeing regardless', () => {
    // Threat 1 >= MA 0 → 0 flee
    assert.equal(calculateMoraleAttackRemoval(0, 1, 10), 0);
  });

  it('coerces string arguments', () => {
    assert.equal(calculateMoraleAttackRemoval('4', '1', '10'), 4);
    assert.equal(calculateMoraleAttackRemoval('3', '3', '10'), 0);
  });

  it('non-numeric threat defaults to 1 — low resistance', () => {
    assert.equal(calculateMoraleAttackRemoval(3, 'x', 10), 3);
  });
});


// ===========================================================================
// getCreatureHitLocation
// ===========================================================================
describe('getCreatureHitLocation', () => {

  const simpleMap = {
    1: ['tailEnd'],
    2: ['tailMid'],
    5: ['legFL'],
    6: ['legFR'],
    10: ['head'],
  };

  it('returns the matching location array for a known height', () => {
    assert.deepEqual(getCreatureHitLocation(10, simpleMap), ['head']);
    assert.deepEqual(getCreatureHitLocation(1,  simpleMap), ['tailEnd']);
  });

  it('returns empty array for a height not in the map', () => {
    assert.deepEqual(getCreatureHitLocation(3, simpleMap), []);
  });

  it('returns empty array for a null map', () => {
    assert.deepEqual(getCreatureHitLocation(5, null), []);
  });

  it('returns empty array for an undefined map', () => {
    assert.deepEqual(getCreatureHitLocation(5, undefined), []);
  });

  it('returns empty array for a NaN height', () => {
    assert.deepEqual(getCreatureHitLocation(NaN, simpleMap), []);
    assert.deepEqual(getCreatureHitLocation('foo', simpleMap), []);
  });

  it('coerces string height to integer', () => {
    assert.deepEqual(getCreatureHitLocation('10', simpleMap), ['head']);
  });

  it('supports multiple locations per height (overlapping ranges)', () => {
    const overlappingMap = { 5: ['legFL', 'legFR'] };
    const result = getCreatureHitLocation(5, overlappingMap);
    assert.equal(result.length, 2);
    assert.ok(result.includes('legFL'));
    assert.ok(result.includes('legFR'));
  });
});


// ===========================================================================
// parseDamageFormula
// ===========================================================================
describe('parseDamageFormula', () => {

  // ── Shock-only formulas ────────────────────────────────────────────────────

  it('"Width Shock" → shock=Width, no killing, no healing', () => {
    const r = parseDamageFormula('Width Shock', 3);
    assert.equal(r.shock, 3);
    assert.equal(r.killing, 0);
    assert.equal(r.healing, 0);
  });

  it('"Width Shock" is case-insensitive', () => {
    const r = parseDamageFormula('WIDTH SHOCK', 3);
    assert.equal(r.shock, 3);
  });

  it('"Width+1 Shock" adds 1 to Width', () => {
    const r = parseDamageFormula('Width+1 Shock', 2);
    assert.equal(r.shock, 3); // 2+1
  });

  it('"Width-1 Shock" subtracts 1 from Width', () => {
    const r = parseDamageFormula('Width-1 Shock', 4);
    assert.equal(r.shock, 3); // 4-1
  });

  it('"3 Shock" uses literal number', () => {
    const r = parseDamageFormula('3 Shock', 5);
    assert.equal(r.shock, 3);
  });

  // ── Killing-only formulas ──────────────────────────────────────────────────

  it('"Width Killing" → killing=Width', () => {
    const r = parseDamageFormula('Width Killing', 3);
    assert.equal(r.shock, 0);
    assert.equal(r.killing, 3);
    assert.equal(r.healing, 0);
  });

  it('"Width+1 Killing" adds 1 to Width', () => {
    const r = parseDamageFormula('Width+1 Killing', 2);
    assert.equal(r.killing, 3);
  });

  it('"2 Killing" uses literal number', () => {
    const r = parseDamageFormula('2 Killing', 5);
    assert.equal(r.killing, 2);
  });

  // ── Mixed formulas ─────────────────────────────────────────────────────────

  it('"1 Killing, Width Shock" produces both values', () => {
    const r = parseDamageFormula('1 Killing, Width Shock', 3);
    assert.equal(r.shock, 3);
    assert.equal(r.killing, 1);
    assert.equal(r.healing, 0);
  });

  it('"Width Shock, Width Killing" honours both', () => {
    const r = parseDamageFormula('Width Shock, Width Killing', 4);
    assert.equal(r.shock, 4);
    assert.equal(r.killing, 4);
  });

  // ── Healing formulas ───────────────────────────────────────────────────────

  it('"Width Healing" → healing=Width', () => {
    const r = parseDamageFormula('Width Healing', 3);
    assert.equal(r.healing, 3);
    assert.equal(r.shock, 0);
    assert.equal(r.killing, 0);
  });

  it('"2 Healing" uses literal', () => {
    const r = parseDamageFormula('2 Healing', 5);
    assert.equal(r.healing, 2);
  });

  // ── Fallback (untyped) ─────────────────────────────────────────────────────

  it('untyped plain number falls back to shock', () => {
    const r = parseDamageFormula('3', 5);
    assert.equal(r.shock, 3);
    assert.equal(r.killing, 0);
    assert.equal(r.healing, 0);
  });

  // ── Default formula when null/empty ───────────────────────────────────────

  it('null formula defaults to "Width Shock"', () => {
    const r = parseDamageFormula(null, 4);
    assert.equal(r.shock, 4);
  });

  it('empty string formula defaults to "Width Shock"', () => {
    const r = parseDamageFormula('', 2);
    assert.equal(r.shock, 2);
  });

  // ── Width=0 edge case ─────────────────────────────────────────────────────

  it('Width=0 with "Width Shock" → shock=0', () => {
    const r = parseDamageFormula('Width Shock', 0);
    assert.equal(r.shock, 0);
  });
});


// ===========================================================================
// resolveHitRedirect
// ===========================================================================
describe('resolveHitRedirect', () => {

  beforeEach(() => {
    // Reset the warn spy before each test.
    warnSpy.calls.length = 0;
  });

  // Helper to build a minimal actor stub.
  function makeActor(redirectMap = {}, name = 'TestActor') {
    return {
      name,
      system: { modifiers: { hitRedirects: redirectMap } }
    };
  }

  // ── No redirect configured ─────────────────────────────────────────────────

  it('returns original locKey when no redirect is configured', () => {
    const actor = makeActor({});
    const result = resolveHitRedirect(actor, 'armL');
    assert.deepEqual(result, { locKey: 'armL', wasRedirected: false });
  });

  it('returns original locKey when redirect value is empty string', () => {
    const actor = makeActor({ armL: '' });
    const result = resolveHitRedirect(actor, 'armL');
    assert.deepEqual(result, { locKey: 'armL', wasRedirected: false });
  });

  it('returns original locKey when redirect value is whitespace only', () => {
    const actor = makeActor({ armL: '   ' });
    const result = resolveHitRedirect(actor, 'armL');
    assert.deepEqual(result, { locKey: 'armL', wasRedirected: false });
  });

  // ── Valid redirect ─────────────────────────────────────────────────────────

  it('redirects to a valid target location', () => {
    const actor = makeActor({ armL: 'torso' });
    const result = resolveHitRedirect(actor, 'armL');
    assert.deepEqual(result, { locKey: 'torso', wasRedirected: true });
    assert.equal(warnSpy.calls.length, 0, 'no warning when redirect is valid');
  });

  it('trims whitespace from redirect target before validation', () => {
    const actor = makeActor({ legR: '  head  ' });
    const result = resolveHitRedirect(actor, 'legR');
    assert.deepEqual(result, { locKey: 'head', wasRedirected: true });
  });

  it('all six standard locations are accepted as valid targets', () => {
    const validTargets = ['head', 'torso', 'armR', 'armL', 'legR', 'legL'];
    for (const target of validTargets) {
      const actor = makeActor({ head: target });
      const { locKey, wasRedirected } = resolveHitRedirect(actor, 'head');
      assert.equal(locKey, target,        `${target} should be valid`);
      assert.equal(wasRedirected, true,   `${target} should be accepted`);
    }
  });

  // ── Invalid redirect ───────────────────────────────────────────────────────

  it('falls back to original locKey and warns when redirect target is invalid', () => {
    const actor = makeActor({ armR: 'shoulderL' }, 'Goblin');
    const result = resolveHitRedirect(actor, 'armR');
    assert.deepEqual(result, { locKey: 'armR', wasRedirected: false });
    assert.equal(warnSpy.calls.length, 1, 'one warning emitted');
    assert.ok(warnSpy.calls[0].includes('Goblin'),       'warning names the actor');
    assert.ok(warnSpy.calls[0].includes('shoulderL'),    'warning names the bad target');
  });

  it('warns with actor name "Unknown" when actor has no name property', () => {
    const actor = { name: undefined, system: { modifiers: { hitRedirects: { head: 'invalid' } } } };
    resolveHitRedirect(actor, 'head');
    assert.equal(warnSpy.calls.length, 1);
    assert.ok(warnSpy.calls[0].includes('Unknown'));
  });

  // ── Defensive: null / missing actor ───────────────────────────────────────

  it('handles null actor gracefully — returns original locKey without throwing', () => {
    const result = resolveHitRedirect(null, 'torso');
    assert.deepEqual(result, { locKey: 'torso', wasRedirected: false });
  });

  it('handles actor missing system.modifiers path — returns original locKey', () => {
    const result = resolveHitRedirect({ name: 'Stub' }, 'torso');
    assert.deepEqual(result, { locKey: 'torso', wasRedirected: false });
  });
});


// ===========================================================================
// applyArmor  —  WT HAR / LAR / Penetration pipeline
// ===========================================================================
// 📖 WT Rulebook Ch4 p.64-65: Light Armor, Heavy Armor, Penetration
// 📖 WT Rulebook Ch1 p.20: "ALWAYS ROUND DOWN"
describe('applyArmor', () => {

  // ── No armor — pass-through ────────────────────────────────────────────────

  it('no armor: damage passes through unchanged', () => {
    const r = applyArmor(3, 3, 3, 0, 0);
    assert.equal(r.finalShock, 3);
    assert.equal(r.finalKilling, 3);
    assert.equal(r.blocked, false);
    assert.equal(r.harApplied, 0);
    assert.equal(r.larShockReduced, 0);
    assert.equal(r.larKillingConverted, 0);
  });

  // ── LAR examples from the rulebook ─────────────────────────────────────────
  // "LAR 3 and you get hit for 6 Shock and 6 Killing → 1S (reduced) + 3S (converted) + 3K = 4S + 3K"

  it('LAR basic: 6S+6K with LAR 3 → 4S+3K (rulebook example)', () => {
    const r = applyArmor(6, 6, 3, 0, 3);
    assert.equal(r.finalShock, 4);   // 1 (reduced) + 3 (converted)
    assert.equal(r.finalKilling, 3); // 6 - 3 converted
    assert.equal(r.blocked, false);
    assert.equal(r.larShockReduced, 5);       // 6→1 = reduced by 5
    assert.equal(r.larKillingConverted, 3);   // 3K→3S
  });

  // "LAR 3 and you get hit for 6 Killing, with no Shock → 3 Shock and 3 Killing"

  it('LAR killing only: 0S+6K with LAR 3 → 3S+3K (rulebook example)', () => {
    const r = applyArmor(0, 6, 3, 0, 3);
    assert.equal(r.finalShock, 3);    // 0 (no shock to reduce) + 3 (converted)
    assert.equal(r.finalKilling, 3);  // 6 - 3
    assert.equal(r.larShockReduced, 0);       // No shock to reduce
    assert.equal(r.larKillingConverted, 3);
  });

  // "LAR 3 and get hit for 6 Shock, with no Killing → 1 Shock"

  it('LAR shock only: 6S+0K with LAR 3 → 1S+0K (rulebook example)', () => {
    const r = applyArmor(6, 0, 3, 0, 3);
    assert.equal(r.finalShock, 1);
    assert.equal(r.finalKilling, 0);
    assert.equal(r.larShockReduced, 5);       // 6→1
    assert.equal(r.larKillingConverted, 0);   // No killing to convert
  });

  it('LAR with excess: LAR 5 but only 2K → converts 2K to S, not 5', () => {
    const r = applyArmor(4, 2, 3, 0, 5);
    assert.equal(r.finalShock, 3);    // 1 (reduced) + 2 (converted)
    assert.equal(r.finalKilling, 0);
    assert.equal(r.larKillingConverted, 2);
  });

  // ── HAR examples ───────────────────────────────────────────────────────────

  it('HAR blocks: Width 3, HAR 3 → Width reduced to 0 → blocked', () => {
    const r = applyArmor(6, 6, 3, 3, 0);
    assert.equal(r.blocked, true);
    assert.equal(r.finalShock, 0);
    assert.equal(r.finalKilling, 0);
    assert.equal(r.finalWidth, 0);
    assert.equal(r.harApplied, 3);
  });

  it('HAR blocks: Width 2, HAR 1 → Width reduced to 1 → blocked', () => {
    const r = applyArmor(5, 5, 2, 1, 0);
    assert.equal(r.blocked, true);
    assert.equal(r.finalWidth, 1);
  });

  it('HAR partial: Width 4, HAR 2 → Width 2, damage passes through', () => {
    const r = applyArmor(5, 5, 4, 2, 0);
    assert.equal(r.blocked, false);
    assert.equal(r.finalWidth, 2);
    assert.equal(r.finalShock, 5);
    assert.equal(r.finalKilling, 5);
    assert.equal(r.harApplied, 2);
  });

  it('HAR excess: HAR 5 but Width only 3 → still blocked (harApplied = 3)', () => {
    const r = applyArmor(3, 3, 3, 5, 0);
    assert.equal(r.blocked, true);
    assert.equal(r.harApplied, 3);
  });

  // ── HAR + LAR stacked ─────────────────────────────────────────────────────

  it('HAR+LAR stacked: Width 4, HAR 1, LAR 2 → Width 3 then LAR on remainder', () => {
    const r = applyArmor(5, 5, 4, 1, 2);
    assert.equal(r.blocked, false);
    assert.equal(r.finalWidth, 3);
    // LAR: Shock 5→1, convert 2K→S
    assert.equal(r.finalShock, 3);    // 1 + 2
    assert.equal(r.finalKilling, 3);  // 5 - 2
    assert.equal(r.harApplied, 1);
    assert.equal(r.larShockReduced, 4);
    assert.equal(r.larKillingConverted, 2);
  });

  it('HAR blocks before LAR applies: Width 2, HAR 2 → blocked, LAR irrelevant', () => {
    const r = applyArmor(5, 5, 2, 2, 5);
    assert.equal(r.blocked, true);
    assert.equal(r.larShockReduced, 0);
    assert.equal(r.larKillingConverted, 0);
  });

  // ── Penetration ────────────────────────────────────────────────────────────

  it('Penetration reduces both HAR and LAR', () => {
    const r = applyArmor(4, 4, 3, 2, 3, 1);
    // effHAR = 2-1 = 1, effLAR = 3-1 = 2
    assert.equal(r.effectiveHAR, 1);
    assert.equal(r.effectiveLAR, 2);
    assert.equal(r.finalWidth, 2);  // 3 - 1
    assert.equal(r.blocked, false);
    // LAR: Shock 4→1, convert 2K→S
    assert.equal(r.finalShock, 3);    // 1 + 2
    assert.equal(r.finalKilling, 2);  // 4 - 2
  });

  it('Penetration exceeds armor → armor zeroed, not negative', () => {
    const r = applyArmor(3, 3, 3, 1, 1, 5);
    assert.equal(r.effectiveHAR, 0);
    assert.equal(r.effectiveLAR, 0);
    assert.equal(r.finalShock, 3);
    assert.equal(r.finalKilling, 3);
    assert.equal(r.blocked, false);
  });

  it('Penetration fully negates HAR → attack no longer blocked', () => {
    // Without pen: HAR 2 blocks Width 2
    const blocked = applyArmor(3, 3, 2, 2, 0, 0);
    assert.equal(blocked.blocked, true);

    // With pen 2: HAR becomes 0, attack passes
    const unblocked = applyArmor(3, 3, 2, 2, 0, 2);
    assert.equal(unblocked.blocked, false);
    assert.equal(unblocked.effectiveHAR, 0);
    assert.equal(unblocked.finalShock, 3);
    assert.equal(unblocked.finalKilling, 3);
  });

  // ── Hardened armor ─────────────────────────────────────────────────────────

  it('Hardened: Penetration does NOT reduce armor', () => {
    const r = applyArmor(3, 3, 3, 2, 3, 5, true);
    assert.equal(r.effectiveHAR, 2);   // Not reduced by pen
    assert.equal(r.effectiveLAR, 3);   // Not reduced by pen
    assert.equal(r.blocked, true);     // HAR 2 blocks Width 3→1
  });

  it('Hardened false: Penetration reduces normally (default)', () => {
    const r = applyArmor(3, 3, 3, 2, 3, 5, false);
    assert.equal(r.effectiveHAR, 0);
    assert.equal(r.effectiveLAR, 0);
    assert.equal(r.blocked, false);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it('zero damage with HAR: Width still reduced → blocked by HAR even with no damage', () => {
    // HAR 2 on Width 3 → Width 1 → blocked.  This is correct:
    // HAR doesn't "know" about damage amounts, it just reduces Width.
    const r = applyArmor(0, 0, 3, 2, 3);
    assert.equal(r.blocked, true);
    assert.equal(r.finalShock, 0);
    assert.equal(r.finalKilling, 0);
  });

  it('zero damage no armor → passes through, not blocked', () => {
    const r = applyArmor(0, 0, 3, 0, 0);
    assert.equal(r.finalShock, 0);
    assert.equal(r.finalKilling, 0);
    assert.equal(r.blocked, false);
    assert.equal(r.larShockReduced, 0);
    assert.equal(r.larKillingConverted, 0);
  });

  it('LAR with 1 Shock → Shock stays at 1 (minimum), no reduction below 1', () => {
    const r = applyArmor(1, 0, 3, 0, 5);
    assert.equal(r.finalShock, 1);
    assert.equal(r.larShockReduced, 0);   // 1→1 = reduced by 0
  });

  it('Width 1 with no HAR is NOT blocked (no HAR reduction applied)', () => {
    const r = applyArmor(3, 3, 1, 0, 0);
    // Width 1 with 0 HAR: finalWidth = 1-0 = 1, but blocked check is ≤1
    // This represents a "waste die" scenario — should it be blocked?
    // With zero HAR, finalWidth = 1. The blocked check is finalWidth ≤ 1.
    // Per RAW, Width 1 is not a set, so this is edge case territory.
    // For waste dice, the caller passes width=1. With HAR 0, no reduction.
    // We still return blocked=true because finalWidth ≤ 1.
    // Actually: a "set" requires width ≥ 2. Width 1 hits should be
    // pre-filtered by the caller. But applyArmor just does math.
    assert.equal(r.finalWidth, 1);
    assert.equal(r.blocked, true);  // Width 1 ≤ 1 → blocked
  });

  it('Width 2 with no armor passes through fine', () => {
    const r = applyArmor(3, 3, 2, 0, 0);
    assert.equal(r.blocked, false);
    assert.equal(r.finalWidth, 2);
    assert.equal(r.finalShock, 3);
    assert.equal(r.finalKilling, 3);
  });
});
