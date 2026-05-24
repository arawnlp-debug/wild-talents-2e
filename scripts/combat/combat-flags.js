// scripts/combat/combat-flags.js
// ════════════════════════════════════════════════════════════════════════════
//  WT COMBAT FLAGS — Phase 3: Spotlight Engine & Gobble Dice
//
//  Stores parsed ORE roll data on the Combat document flags.
//  Manages the resolution spotlight (which set is currently being resolved)
//  and handles gobble dice application with RAW timing/height validation.
//
//  Flag paths:
//    game.combat.flags?.["wild-talents-2e"].pendingRolls[combatantId]  — roll data per combatant
//    game.combat.flags?.["wild-talents-2e"].spotlight                  — current spotlight position
//
//  Socket actions:
//    storeRoll    — player→GM relay for roll data writes
//    applyGobble  — player→GM relay for gobble die consumption
// ════════════════════════════════════════════════════════════════════════════

import { parseORE, calculateInitiative } from "../helpers/ore-engine.js";

const SOCKET_KEY = "system.wild-talents-2e";

// ─── Flag Write (GM-side) ────────────────────────────────────────────────────

async function _writeRollFlag(combat, combatantId, payload) {
  if (!game.user.isGM) return;
  if (!combat || !combatantId || !payload) return;
  try {
    await combat.setFlag("wild-talents-2e", `pendingRolls.${combatantId}`, payload);
  } catch (err) {
    console.error(`WT | Failed to write roll flag for combatant ${combatantId}:`, err);
  }
}

// ─── Payload Extraction ──────────────────────────────────────────────────────

function _extractPayload(message) {
  const rf = message.flags?.["wild-talents-2e"];
  if (!rf?.results || !Array.isArray(rf.results)) return null;
  const actorId = message.speaker?.actor;
  if (!actorId) return null;

  const isMinion = rf.rollFlags?.isMinion || false;
  const parsed = parseORE(rf.results, isMinion);

  return {
    actorId,
    actorType: rf.actorType || "character",
    round: rf.combatRound ?? game.combat?.round ?? -1,
    timestamp: Date.now(),
    results: rf.results,
    sets: parsed.sets.map(s => ({ width: s.width, height: s.height, status: "pending" })),
    waste: parsed.waste,
    expertDie: 0,   // WT: Legacy field — always 0 (HD/WD replace ED/MD)
    masterDie: 0,   // WT: Legacy field — always 0
    hardCount: rf.hardCount || 0,
    wiggleCount: rf.wiggleCount || 0,
    totalPool: rf.totalPool || rf.results.length,
    label: rf.label || "",
    isDefense: rf.isDefense || false,
    defenseType: rf.defenseType || "none",
    isMinion,
    itemData: rf.itemData || null,
    gobbleDice: rf.gobbleDice || [],
    advancedMods: rf.rollFlags?.advancedMods || {},
    rollFlags: rf.rollFlags || {},
  };
}

// ─── Socket Relay ────────────────────────────────────────────────────────────

export function initCombatSocket() {
  game.socket.on(SOCKET_KEY, async (data) => {
    if (!game.user.isGM) return;
    const combat = game.combat;
    if (!combat?.started) return;

    if (data?.action === "storeRoll") {
      const { combatantId, payload } = data;
      if (!combatantId || !payload) return;
      const combatant = combat.combatants.get(combatantId);
      if (!combatant) return;
      if (payload.actorId && combatant.actorId !== payload.actorId) return;
      await _writeRollFlag(combat, combatantId, payload);
    }

    if (data?.action === "applyGobble") {
      const { defenderCombatantId, attackerCombatantId, attackSetIndex } = data;
      await applyGobbleDie(combat, defenderCombatantId, attackerCombatantId, attackSetIndex);
    }

    if (data?.action === "spoilSet") {
      const { combatantId, setIndex } = data;
      await spoilSet(combat, combatantId, setIndex);
    }
  });
}

export function onRollChatMessage(message) {
  if (message.author?.id !== game.user.id) return;
  const combat = game.combat;
  if (!combat?.started) return;

  const payload = _extractPayload(message);
  if (!payload) return;
  if (payload.round >= 0 && combat.round >= 0 && payload.round !== combat.round) return;

  const combatant = combat.combatants.find(c => c.actorId === payload.actorId);
  if (!combatant) return;

  if (game.user.isGM) {
    _writeRollFlag(combat, combatant.id, payload);
  } else {
    game.socket.emit(SOCKET_KEY, { action: "storeRoll", combatantId: combatant.id, payload });
  }
}

// ─── Flag Readers ────────────────────────────────────────────────────────────

export function getAllRollData(combat) {
  const cache = new Map();
  if (!combat) return cache;
  const pendingRolls = combat.getFlag("wild-talents-2e", "pendingRolls") || {};

  for (const [combatantId, payload] of Object.entries(pendingRolls)) {
    if (!payload?.actorId) continue;
    if (payload.round >= 0 && combat.round >= 0 && payload.round !== combat.round) continue;

    cache.set(payload.actorId, {
      results: payload.results,
      label: payload.label || "",
      isDefense: payload.isDefense || false,
      defenseType: payload.defenseType || "none",
      gobbleDice: payload.gobbleDice || [],
      itemData: payload.itemData || null,
      rollFlags: payload.rollFlags || {},
      actorType: payload.actorType || "character",
      sets: payload.sets || [],
      waste: payload.waste || [],
      expertDie: 0,   // WT: Legacy — always 0
      masterDie: 0,   // WT: Legacy — always 0
      totalPool: payload.totalPool || 0,
      advancedMods: payload.advancedMods || {},
      combatantId,
    });
  }
  return cache;
}

export function getSpotlight(combat) {
  if (!combat) return null;
  return combat.getFlag("wild-talents-2e", "spotlight") || null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  RESOLUTION ORDER & SPOTLIGHT ENGINE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Builds the full resolution order from all pending rolls.
 * Sorted in RAW order: Width desc, Height desc, attacks before defenses,
 * minions after worthy opponents on ties.
 */
export function buildResolutionOrder(combat) {
  if (!combat) return [];
  const pendingRolls = combat.getFlag("wild-talents-2e", "pendingRolls") || {};
  const order = [];

  for (const [combatantId, payload] of Object.entries(pendingRolls)) {
    if (!payload?.sets) continue;
    if (payload.round >= 0 && combat.round >= 0 && payload.round !== combat.round) continue;

    const combatant = combat.combatants.get(combatantId);
    const name = combatant?.name || "Unknown";

    for (let i = 0; i < payload.sets.length; i++) {
      const set = payload.sets[i];
      if (set.width < 2) continue;

      const init = calculateInitiative(
        [{ width: set.width, height: set.height }],
        payload.isDefense, !payload.isDefense, payload.isMinion,
        payload.itemData?.system?.range || "0"
      );

      order.push({
        combatantId, setIndex: i,
        width: set.width, height: set.height,
        status: set.status || "pending",
        isDefense: payload.isDefense || false,
        isMinion: payload.isMinion || false,
        initiative: init, actorId: payload.actorId, name,
      });
    }
  }

  order.sort((a, b) => b.initiative - a.initiative);
  return order;
}

/**
 * Advances the spotlight to the next unresolved set.
 * GM-only. Marks previous as resolved, next as reacting.
 */
export async function advanceSpotlight(combat) {
  if (!game.user.isGM || !combat) return null;

  const order = buildResolutionOrder(combat);
  if (order.length === 0) return null;

  const currentSpotlight = getSpotlight(combat);
  const pendingRolls = foundry.utils.deepClone(combat.getFlag("wild-talents-2e", "pendingRolls") || {});

  // Mark current spotlit set as resolved
  if (currentSpotlight) {
    const prev = pendingRolls[currentSpotlight.combatantId];
    if (prev?.sets?.[currentSpotlight.setIndex]) {
      prev.sets[currentSpotlight.setIndex].status = "resolved";
    }
  }

  // Find next pending set
  let nextEntry = null;
  for (const entry of order) {
    const payload = pendingRolls[entry.combatantId];
    const set = payload?.sets?.[entry.setIndex];
    if (!set) continue;
    if (set.status === "resolved" || set.status === "broken") continue;
    nextEntry = entry;
    break;
  }

  if (!nextEntry) {
    await combat.setFlag("wild-talents-2e", "pendingRolls", pendingRolls);
    await combat.unsetFlag("wild-talents-2e", "spotlight");
    return null;
  }

  // Mark new set as reacting
  const nextPayload = pendingRolls[nextEntry.combatantId];
  if (nextPayload?.sets?.[nextEntry.setIndex]) {
    nextPayload.sets[nextEntry.setIndex].status = "reacting";
  }

  await combat.setFlag("wild-talents-2e", "pendingRolls", pendingRolls);
  await combat.setFlag("wild-talents-2e", "spotlight", {
    combatantId: nextEntry.combatantId,
    setIndex: nextEntry.setIndex,
  });

  // Sync combat.turn so the combat tracker highlights the active combatant
  const turnIndex = combat.turns.findIndex(c => c.id === nextEntry.combatantId);
  if (turnIndex >= 0 && combat.turn !== turnIndex) {
    await combat.update({ turn: turnIndex }, { wtSpotlightSync: true });
  }

  return { combatantId: nextEntry.combatantId, setIndex: nextEntry.setIndex };
}

// ═══════════════════════════════════════════════════════════════════════════
//  GOBBLE DICE VALIDATION & APPLICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pure validation: can this defender's gobble dice intercept the given attack set?
 * Used by the dashboard for display. No side effects.
 */
export function validateGobble(defPayload, atkSet, defActor) {
  const result = { valid: false, timingOk: false, heightOk: false, reason: "",
                   validDice: [], invalidDice: [] };

  if (!defPayload || !atkSet) { result.reason = "Missing data"; return result; }

  const gobbleDice = defPayload.gobbleDice || [];
  if (gobbleDice.length === 0) { result.reason = "No gobble dice"; return result; }

  const defMods = defActor?.system?.modifiers?.combat || {};
  const freeGobble = defActor?.getFlag("wild-talents-2e", "freeGobbleDice") || [];

  // Timing: defense Width >= attack Width
  const defSets = defPayload.sets || [];
  const defFastestWidth = defSets.reduce((max, s) => Math.max(max, s.width), 0);
  const timingImmune = !!defMods.combineGobbleDice;
  const hasFreeGobble = freeGobble.length > 0;

  result.timingOk = timingImmune || hasFreeGobble || (defFastestWidth >= atkSet.width);
  if (!result.timingOk) {
    result.reason = `Too slow — Width ${defFastestWidth} < ${atkSet.width}`;
    result.invalidDice = [...gobbleDice];
    return result;
  }

  // Height: die face >= attack height
  const heightImmune = !!defMods.crossBlockActive;

  if (defMods.combineGobbleDice && gobbleDice.length > 1) {
    const combined = gobbleDice.reduce((a, b) => a + b, 0);
    if (combined >= atkSet.height) {
      result.heightOk = true;
      result.validDice = [...gobbleDice];
    } else {
      result.invalidDice = [...gobbleDice];
      result.reason = `Combined ${combined} < height ${atkSet.height}`;
    }
  } else {
    for (const die of gobbleDice) {
      if (heightImmune || die >= atkSet.height) result.validDice.push(die);
      else result.invalidDice.push(die);
    }
    result.heightOk = result.validDice.length > 0;
    if (!result.heightOk) result.reason = `No die ≥ height ${atkSet.height}`;
  }

  result.valid = result.timingOk && result.heightOk;
  if (result.valid) result.reason = "";
  return result;
}

/**
 * Applies a single gobble die: removes one die from the attacker's set
 * and consumes one gobble die from the defender's pool.
 * GM-only.
 */
export async function applyGobbleDie(combat, defenderCombatantId, attackerCombatantId, attackSetIndex) {
  if (!game.user.isGM || !combat) return false;

  const pendingRolls = foundry.utils.deepClone(combat.getFlag("wild-talents-2e", "pendingRolls") || {});
  const atkPayload = pendingRolls[attackerCombatantId];
  const defPayload = pendingRolls[defenderCombatantId];

  if (!atkPayload || !defPayload) {
    ui.notifications.warn("WT | Gobble failed — roll data not found.");
    return false;
  }

  const atkSet = atkPayload.sets?.[attackSetIndex];
  if (!atkSet || atkSet.status === "resolved" || atkSet.status === "broken") {
    ui.notifications.warn("WT | Cannot gobble a resolved or broken set.");
    return false;
  }

  const defActor = game.actors.get(defPayload.actorId);
  const validation = validateGobble(defPayload, atkSet, defActor);
  if (!validation.valid) {
    ui.notifications.warn(`WT | Gobble failed — ${validation.reason}`);
    return false;
  }

  // Consume lowest valid die
  const gobblePool = [...defPayload.gobbleDice];
  const sortedValid = [...validation.validDice].sort((a, b) => a - b);
  const consumeIdx = gobblePool.indexOf(sortedValid[0]);
  if (consumeIdx === -1) return false;
  gobblePool.splice(consumeIdx, 1);
  defPayload.gobbleDice = gobblePool;

  // Remove die from attacker's set
  atkSet.width -= 1;
  const atkResults = [...atkPayload.results];
  const resultIdx = atkResults.indexOf(atkSet.height);
  if (resultIdx !== -1) atkResults.splice(resultIdx, 1);
  atkPayload.results = atkResults;

  if (atkSet.width < 2) atkSet.status = "broken";

  await combat.setFlag("wild-talents-2e", "pendingRolls", pendingRolls);

  // Chat receipt
  const atkName = game.actors.get(atkPayload.actorId)?.name || "Attacker";
  const defName = defActor?.name || "Defender";
  const broken = atkSet.width < 2;

  await ChatMessage.create({
    content: `<div class="wt-chat-card">
      <h3><i class="fas fa-shield-alt"></i> Gobble Die — ${foundry.utils.escapeHTML(defName)}</h3>
      <p>Cancelled Height <strong>${atkSet.height}</strong> from <strong>${foundry.utils.escapeHTML(atkName)}'s</strong> set.
      ${broken
        ? `<br><span class="wt-text-danger"><strong>Set broken!</strong> Action fails.</span>`
        : `<br>Reduced to <strong>${atkSet.width}×${atkSet.height}</strong>.`}
      </p>
      <p class="wt-text-small wt-text-muted">Gobble dice remaining: ${gobblePool.length}</p>
    </div>`
  });

  return true;
}

/**
 * Player-side gobble request via socket.
 */
export function requestGobble(defenderCombatantId, attackerCombatantId, attackSetIndex) {
  if (game.user.isGM) {
    const combat = game.combat;
    if (combat) applyGobbleDie(combat, defenderCombatantId, attackerCombatantId, attackSetIndex);
  } else {
    game.socket.emit(SOCKET_KEY, {
      action: "applyGobble", defenderCombatantId, attackerCombatantId, attackSetIndex,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 4: RESOLVE & SPOIL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Marks the current spotlit set as resolved and advances the spotlight.
 * GM-only. Called after applyDamageToTarget has fired.
 *
 * @param {Combat} combat
 * @returns {Object|null} The next spotlight position, or null if all resolved.
 */
export async function resolveCurrentSet(combat) {
  if (!game.user.isGM || !combat) return null;
  // advanceSpotlight already handles marking the current set as resolved
  // and finding the next pending set.
  return advanceSpotlight(combat);
}

/**
 * Spoils a die from a target's set. RAW Ch6: "As soon as your character
 * gets hit, you lose a die out of one of your sets (your choice)."
 *
 * The target player (or GM) calls this to choose which set loses a die.
 * GM-only write — players relay via socket.
 *
 * @param {Combat} combat
 * @param {string} combatantId - The combatant whose set is being spoiled.
 * @param {number} setIndex - Which of their sets to spoil.
 * @returns {boolean} True if the spoil was applied.
 */
export async function spoilSet(combat, combatantId, setIndex) {
  if (!game.user.isGM || !combat) return false;

  const pendingRolls = foundry.utils.deepClone(combat.getFlag("wild-talents-2e", "pendingRolls") || {});
  const payload = pendingRolls[combatantId];
  if (!payload?.sets?.[setIndex]) {
    ui.notifications.warn("WT | Spoil failed — set not found.");
    return false;
  }

  const set = payload.sets[setIndex];
  if (set.status === "resolved" || set.status === "broken") {
    ui.notifications.warn("WT | Cannot spoil an already resolved or broken set.");
    return false;
  }

  // Remove one die
  set.width -= 1;
  const results = [...payload.results];
  const idx = results.indexOf(set.height);
  if (idx !== -1) results.splice(idx, 1);
  payload.results = results;

  const broken = set.width < 2;
  if (broken) set.status = "broken";

  await combat.setFlag("wild-talents-2e", "pendingRolls", pendingRolls);

  // Chat receipt
  const actorName = game.actors.get(payload.actorId)?.name || "Combatant";
  await ChatMessage.create({
    content: `<div class="wt-chat-card">
      <h3><i class="fas fa-heart-broken"></i> Set Spoiled — ${foundry.utils.escapeHTML(actorName)}</h3>
      <p>Lost a die from ${set.width + 1}×${set.height}${broken
        ? ` — <span class="wt-text-danger"><strong>set broken!</strong> Action fails.</span>`
        : ` → now ${set.width}×${set.height}.`
      }</p>
    </div>`
  });

  return true;
}

/**
 * Player-side spoil request via socket.
 */
export function requestSpoil(combatantId, setIndex) {
  if (game.user.isGM) {
    const combat = game.combat;
    if (combat) spoilSet(combat, combatantId, setIndex);
  } else {
    game.socket.emit(SOCKET_KEY, {
      action: "spoilSet", combatantId, setIndex,
    });
  }
}
