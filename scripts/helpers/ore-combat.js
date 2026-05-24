/* global Combat */
// scripts/combat/ore-combat.js

/**
 * Custom Combat class for the Wild Talents 2e ORE system.
 * Handles dual-phase sorting with specific Wild Talents 2e tiebreakers:
 * 1. Declaration Phase: Sense (Asc), GMCs before PCs, Sight (Asc).
 * 2. Resolution Phase: Sorted by Initiative (Width.Height, Descending).
 */
export class WTCombat extends Combat {

  /**
   * Overrides the standard combatant sorting logic.
   * @param {Combatant} a
   * @param {Combatant} b
   * @protected
   */
  _sortCombatants(a, b) {
    // Safely retrieve the combat document to avoid 'this' context loss
    const combat = a.combat || b.combat;
    const phase = combat?.getFlag("wild-talents-2e", "phase") || "declaration";

    // --- PHASE 1: DECLARATION (Commitment Order) ---
    // Rule: Characters with less awareness/priority declare first.
    if (phase === "declaration") {
      // 1. Primary: Sense (Lowest declares first)
      const senseA = a.actor?.system?.attributes?.sense?.value || 0;
      const senseB = b.actor?.system?.attributes?.sense?.value || 0;
      if (senseA !== senseB) return senseA - senseB;

      // 2. Secondary: GMC vs PC (GMCs must declare before PCs)
      // hasPlayerOwner is false (0) for GMCs and true (1) for PCs
      const isPcA = a.actor?.hasPlayerOwner ? 1 : 0;
      const isPcB = b.actor?.hasPlayerOwner ? 1 : 0;
      if (isPcA !== isPcB) return isPcA - isPcB;

      // 3. Tertiary: Sight Skill (Lowest Sight declares first)
      const sightA = a.actor?.system?.skills?.sight?.value || 0;
      const sightB = b.actor?.system?.skills?.sight?.value || 0;
      if (sightA !== sightB) return sightA - sightB;
    } 
    
    // --- PHASE 2: RESOLUTION (Speed Order) ---
    else {
      // Rule: Higher Width (speed) goes first. If Widths are tied, higher Height goes first.
      // Initiative is stored as a decimal (Width.Height), e.g., 2x10 is 2.10
      const initA = Number.isNumeric(a.initiative) ? a.initiative : -999;
      const initB = Number.isNumeric(b.initiative) ? b.initiative : -999;

      // Primary Sort: Initiative Descending
      if (initA !== initB) return initB - initA;

      // ISSUE-010 — Tiebreaker for truly simultaneous resolution (identical W×H):
      // RAW Ch6 describes identical sets as happening simultaneously. For cases where the
      // system requires an ordering (e.g. damage sequencing), RAW suggests a die roll.
      // We use Sense (descending) as a stable deterministic tiebreaker to avoid re-rolls.
      // This is a system design choice, not a RAW rule. Consider a coin-flip dialog for
      // strict RAW if simultaneous resolution is needed.
      // RAW citation needed: exact wording of "truly simultaneous" resolution tie resolution.
      const resSenseA = a.actor?.system?.attributes?.sense?.value || 0;
      const resSenseB = b.actor?.system?.attributes?.sense?.value || 0;
      if (resSenseA !== resSenseB) return resSenseB - resSenseA;
    }

    // Final Fallback: Alphabetical then ID
    const nameSort = a.name.localeCompare(b.name);
    if (nameSort !== 0) return nameSort;
    return a.id.localeCompare(b.id);
  }

  /**
   * Ensures that the tracker re-sorts whenever turns are set up 
   * (e.g., when the Phase flag is toggled in wild-talents-2e.mjs).
   */
  async setupTurns() {
    return super.setupTurns();
  }

  /**
   * ITEM-1: Whisper owning players when a slow weapon or slow spell becomes ready
   * on the round we are about to enter.
   *
   * Must be called before super.nextRound() so that this.round still refers to
   * the outgoing round. The block condition in character-roller.js is:
   *   game.combat.round <= cooldownUntil
   * A cooldown stored as (firedRound + slowN) therefore expires the moment
   * the round advances past it. When cooldownUntil === outgoingRound the weapon
   * is blocked this round and free on the next — exactly when we want to notify.
   *
   * Weapons share a single combatant flag (flags?.["wild-talents-2e"].slowCooldown) because
   * only one slow weapon can be in cooldown at a time.
   * Spells each carry their own flag (flags?.["wild-talents-2e"].spellSlowCooldown_<itemId>)
   * so that different slow spells on the same character do not clobber each other.
   *
   * Multiple ready items for the same actor are batched into one whisper to avoid
   * notification spam.
   *
   * @private
   */
  async _notifySlowReady() {
    const outgoingRound = this.round;

    await Promise.all(this.combatants.map(async combatant => {
      const actor = combatant.actor;
      if (!actor) return;

      const whisperTargets = game.users
        .filter(u => actor.testUserPermission(u, "OWNER") && u.active)
        .map(u => u.id);
      if (whisperTargets.length === 0) return;

      const lines = [];

      // --- Weapon slow ---
      const weaponCooldown = combatant.getFlag("wild-talents-2e", "slowCooldown") ?? -1;
      if (weaponCooldown === outgoingRound) {
        // The flag records the cooldown round but not which weapon was fired.
        // Surface all equipped slow weapons; in practice there will be at most one.
        const slowWeapons = actor.items.filter(
          i => i.type === "weapon" && i.system.equipped && (i.system.qualities?.slow ?? 0) > 0
        );
        const label = slowWeapons.length > 0
          ? slowWeapons.map(w => `<strong>${foundry.utils.escapeHTML(w.name)}</strong>`).join(" &amp; ")
          : "<strong>Slow weapon</strong>";
        lines.push(`${label} is readied and can fire this round.`);
      }

      // --- Spell slow (per-item flags) ---
      const wtFlags = combatant.flags?.["wild-talents-2e"] ?? {};
      for (const [key, value] of Object.entries(wtFlags)) {
        if (!key.startsWith("spellSlowCooldown_")) continue;
        if (value !== outgoingRound) continue;
        const itemId = key.slice("spellSlowCooldown_".length);
        const spell = actor.items.get(itemId);
        const spellLabel = spell
          ? `<strong>${foundry.utils.escapeHTML(spell.name)}</strong>`
          : "<strong>Slow spell</strong>";
        lines.push(`${spellLabel} is ready to cast this round.`);
      }

      if (lines.length === 0) return;

      await ChatMessage.create({
        content: `<div class="wt-chat-card">
          <p><i class="fas fa-hourglass-end wt-text-info"></i> <strong>${foundry.utils.escapeHTML(actor.name)}</strong> — ${lines.join(" | ")}</p>
        </div>`,
        whisper: whisperTargets,
        speaker: { alias: "⚔ Combat" }
      });
    }));
  }

  /**
   * Round advancement logic.
   * Resets initiative, declaration flags, shield assignments, and aim state for all participants.
   * PACKAGE C: Clears per-round shield coverage flags and processes aim state persistence.
   * ITEM-1: Notifies owning players when a slow weapon or slow spell becomes ready.
   * ITEM-8: Clears declarationText and declarationAction flags each round.
   */
  async nextRound() {
    // ITEM-1: Fire before super.nextRound() so this.round is still the outgoing round,
    // which is the value compared against stored cooldown flags.
    await this._notifySlowReady();
    const updates = this.combatants.map(c => ({
      _id: c.id,
      initiative: null,
      "flags.wild-talents-2e.declared": false,
      "flags.wild-talents-2e.declarationText": "",       // ITEM-8: clear declaration text each round
      "flags.wild-talents-2e.declarationAction": null    // ITEM-8: clear declaration action each round
    }));
    
    await this.updateEmbeddedDocuments("Combatant", updates);
    await this.setFlag("wild-talents-2e", "phase", "declaration");

    // Dashboard Phase 2: Clear pending roll data from the previous round.
    await this.unsetFlag("wild-talents-2e", "pendingRolls");

    // ISSUE-030 FIX: Process all combatant actors in parallel (Promise.all) rather than
    // sequential await calls. For a 20-combatant encounter this reduces ~60 DB writes to
    // ~20 parallel writes.
    await Promise.all(this.combatants.map(async combatant => {
      const actor = combatant.actor;
      if (!actor || actor.type !== "character") return;

      const actorUpdates = {};

      // Shield Coverage: Clear per-round assignments so players must re-declare.
      // ISSUE-027 FIX: After clearing, whisper a reminder to the owning player(s) if the
      // character has a shield equipped but hadn't declared coverage this round.
      const hadCoverage = !!actor.getFlag("wild-talents-2e", "shieldCoverage");
      const hasShieldEquipped = actor.items.some(i => i.type === "shield" && i.system.equipped);

      if (hadCoverage) {
        actorUpdates["flags.wild-talents-2e.shieldCoverage"] = foundry.data.operators.ForcedDeletion;
      } else if (hasShieldEquipped && game.combat?.round > 1) {
        // Shield equipped but no coverage was declared this past round — whisper a reminder
        const whisperTargets = game.users.filter(u => actor.testUserPermission(u, "OWNER") && u.active).map(u => u.id);
        if (whisperTargets.length > 0) {
          await ChatMessage.create({
            content: `<div class="wt-chat-card"><p><i class="fas fa-exclamation-triangle wt-text-warning"></i> <strong>${foundry.utils.escapeHTML(actor.name)}</strong> had a shield equipped but no <strong>Shield Coverage</strong> was declared last round — the shield fell back to its static default locations. Declare coverage at the start of the new round.</p></div>`,
            whisper: whisperTargets,
            speaker: { alias: "⚔ Combat" }
          });
        }
      }

      // Dodge Cover: Clear dive-for-cover protection from previous round.
      const hadDodgeCover = !!actor.getFlag("wild-talents-2e", "dodgeCover");
      if (hadDodgeCover) {
        actorUpdates["flags.wild-talents-2e.dodgeCover"] = foundry.data.operators.ForcedDeletion;
      }

      // Aim State: Preserve bonus only if the character aimed this round.
      const aimedThisRound = actor.getFlag("wild-talents-2e", "aimedThisRound") || false;
      if (!aimedThisRound) {
        if (actor.getFlag("wild-talents-2e", "aimBonus")) {
          actorUpdates["flags.wild-talents-2e.aimBonus"] = foundry.data.operators.ForcedDeletion;
        }
      }
      if (aimedThisRound) {
        actorUpdates["flags.wild-talents-2e.aimedThisRound"] = foundry.data.operators.ForcedDeletion;
      }

      // Commit all actor flag changes in one write per actor.
      if (!foundry.utils.isEmpty(actorUpdates)) {
        await actor.update(actorUpdates);
      }

      // Prone from dive-for-cover: clear the prone status that was applied when
      // the character dived behind cover last round. Uses the pre-deletion snapshot
      // (hadDodgeCover) since getFlag returns undefined after flag deletion.
      if (hadDodgeCover && actor.statuses.has("prone")) {
        await actor.toggleStatusEffect("prone", { active: false });
      }
    }));

    // C1: Clear Shove bonus and Iron Kiss flags from all combatants in one batch.
    const combatantFlagUpdates = this.combatants
      .filter(c => c.getFlag("wild-talents-2e", "shoveBonusAgainst") || c.getFlag("wild-talents-2e", "ironKissSetup"))
      .map(c => {
        const u = { _id: c.id };
        if (c.getFlag("wild-talents-2e", "shoveBonusAgainst")) u["flags.wild-talents-2e.shoveBonusAgainst"] = foundry.data.operators.ForcedDeletion;
        if (c.getFlag("wild-talents-2e", "ironKissSetup")) u["flags.wild-talents-2e.ironKissSetup"] = foundry.data.operators.ForcedDeletion;
        return u;
      });

    if (combatantFlagUpdates.length > 0) {
      await this.updateEmbeddedDocuments("Combatant", combatantFlagUpdates);
    }

    // G4.1: Seed free Gobble Dice for creature-mode threats that have freeGobbleDicePerRound > 0.
    // RAW Ch13 Big Cat: "1–3 free Dodge Gobble Dice per round, usable at any time, with a value of 10."
    // The pool is stored as an actor flag so consumeGobbleDie can read it as a fallback.
    await Promise.all(this.combatants.map(async combatant => {
      const actor = combatant.actor;
      if (!actor || actor.type !== "threat" || !actor.system.creatureMode) return;
      const freeCount = actor.system.creatureFlags?.freeGobbleDicePerRound || 0;
      if (freeCount > 0) {
        await actor.setFlag("wild-talents-2e", "freeGobbleDice", Array(freeCount).fill(10));
      }
    }));

    return super.nextRound();
  }
}