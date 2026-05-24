/* global HTMLElement */
// scripts/helpers/threat-roller.js

import { postOREChat } from "./chat.js";
import { parseORE, checkThreatElimination, calculateMoraleAttackRemoval } from "./ore-engine.js";
import { wtDialog } from "./dialog-util.js";
import { BaseORERoller } from "./base-roller.js";
import { WT, DEBUG_ROLLS } from "./config.js";

const { renderTemplate } = foundry.applications.handlebars;

export class ThreatRoller extends BaseORERoller {

  /**
   * RAW Ch6 "Ganging Up": Rolls the threat group's collective attack pool.
   *
   * PACKAGE A CHANGE: Pool is now driven by magnitude.value (number of active fighters),
   * NOT threatLevel. Per RAW, "The GM rolls a pool of dice equal to the number of fighters
   * in the group. These pools can never be higher than 15 dice."
   *
   * threatLevel (1-4) is the Threat Rating — it determines the elimination threshold,
   * NOT the pool size.
   */
  static async rollThreat(actor, dataset) {
    try {
        if (DEBUG_ROLLS) console.log("WT Threat Roller | Execution Started.", dataset);
        const system = actor.system;

        if (system.morale?.value === 0) return ui.notifications.warn(game.i18n.localize("WT.ThreatMoraleZero"));

        // PACKAGE A: Pool = number of active fighters (magnitude.value), capped at 15
        const groupSize = system.magnitude?.value || 0;
        const threatRating = system.threatLevel || 1;

        if (groupSize <= 0) {
          return ui.notifications.warn(`${actor.name} has no active fighters remaining.`);
        }

        const content = await renderTemplate("systems/wild-talents-2e/templates/dialogs/roll-threat.hbs", {
          basePool: groupSize,
          threatRating: threatRating,
          groupSize: groupSize,
          maxGroup: system.magnitude?.max || groupSize
        });
        
        const rollData = await wtDialog(
          game.i18n.localize("WT.RollThreatAction") || "Roll Threat",
          content,
          (e, b, d) => {
              const f = d.element.querySelector("form") || d.element;
              return {
                  bonus: parseInt(f.querySelector('[name="bonus"]')?.value) || 0,
                  penalty: parseInt(f.querySelector('[name="penalty"]')?.value) || 0
              };
          },
          {
            defaultLabel: game.i18n.localize("WT.RollThreatAction") || "Roll Threat",
            render: (event, html) => {
                let element = event?.target?.element ?? (event instanceof HTMLElement ? event : (event[0] || null));
                if (!element) return;

                const f = element.querySelector("form") || element;
                const poolPreviewSpan = element.querySelector("#pool-value");
                
                if (!poolPreviewSpan) {
                    console.warn("WT Threat Roller | Missing #pool-value span in roll-threat.hbs. Dynamic preview disabled.");
                }

                const updatePool = () => {
                    let bonus = parseInt(f.querySelector('[name="bonus"]')?.value) || 0;
                    let penalty = parseInt(f.querySelector('[name="penalty"]')?.value) || 0;
                    let current = groupSize + bonus - penalty;

                    const maxDice = WT.MAX_DICE || 15;

                    if (poolPreviewSpan) {
                        if (current > maxDice) {
                            poolPreviewSpan.textContent = `${maxDice} (Capped from ${current})`;
                            poolPreviewSpan.style.color = "var(--wt-orange, #d97706)";
                        } else if (current < 1) {
                            poolPreviewSpan.textContent = `${current} (Fails)`;
                            poolPreviewSpan.style.color = "var(--wt-red, #8b1f1f)";
                        } else {
                            poolPreviewSpan.textContent = `${current} fighters`;
                            poolPreviewSpan.style.color = "var(--wt-green, #2d5a27)";
                        }
                    }
                };

                f.querySelectorAll("input").forEach(input => {
                    input.addEventListener("input", updatePool);
                    input.addEventListener("change", updatePool);
                });

                updatePool();
            }
          }
        );
        
        if (!rollData) return;
        
        let intendedPool = groupSize + rollData.bonus - rollData.penalty;
        const maxDice = WT.MAX_DICE || 15;
        let diceToRoll = Math.min(intendedPool, maxDice);
        let wasCapped = intendedPool > maxDice;
        
        if (diceToRoll < 1) return ui.notifications.warn("Penalties reduced the horde's pool below 1. They hesitate!");
        
        // ITEM-19: Use BaseORERoller.rollDice for consistent dice evaluation.
        const { roll, results } = await this.rollDice(diceToRoll);
        
        // Construct a pseudo-weapon item for the chat card engine
        const pseudoWeapon = { 
            id: "threat-weapon",
            _id: "threat-weapon",
            type: "weapon", 
            name: actor.name, 
            img: actor.img || "icons/svg/sword.svg",
            system: { 
                damage: system.damageFormula || "Width Shock",
                qualities: {},
                range: "melee"
            }
        };
        
        // Build pool breakdown for chat card
        let poolBreakdown = [];
        poolBreakdown.push({ label: "Group Size", value: `+${groupSize}`, isPenalty: false });
        if (rollData.bonus > 0) poolBreakdown.push({ label: "Ganging Up / Bonus", value: `+${rollData.bonus}`, isPenalty: false });
        if (rollData.penalty > 0) poolBreakdown.push({ label: "Penalties", value: `-${rollData.penalty}`, isPenalty: true });

        await postOREChat(actor, game.i18n.localize("WT.RollThreatAction") || "Threat Action", diceToRoll, results, 0, 0, pseudoWeapon, { isMinion: true, wasCapped, isAttack: true, poolBreakdown: poolBreakdown });
        
    } catch (err) {
        console.error("WT Threat Roller | CRITICAL EXCEPTION:", err);
        ui.notifications.error("Threat roller crashed. Please press F12 and check the console for details.");
    }
  }

  /**
   * Morale Check: GM tool for testing whether a battered group keeps fighting.
   *
   * This is a GM discretion tool, not strictly RAW for unworthies (RAW uses Morale Attacks
   * to scatter them, not morale "checks"). However, it models the RAW guidance that
   * "if a mob of twenty people attacks five foreigners and half of them are bleeding paste
   * on the pavement, the remainder runs even if no one specifically made a Morale Attack."
   *
   * Pool is driven by morale.value, which the GM adjusts to represent fighting spirit.
   */
  static async rollMorale(actor) {
    try {
        const system = actor.system;
        const moraleVal = system.morale?.value || 0;

        if (moraleVal < 1) {
            return ui.notifications.warn(game.i18n.localize("WT.ThreatMoraleZero"));
        }

        const maxDice = WT.MAX_DICE || 15;
        let diceToRoll = Math.min(moraleVal, maxDice);
        let wasCapped = moraleVal > maxDice;

        // ITEM-19: Use BaseORERoller.rollDice for consistent dice evaluation.
        const { roll, results } = await this.rollDice(diceToRoll);

        const parsed = parseORE(results);
        let routed = parsed.sets.length === 0;

        let outcomeText = routed 
            ? ` — ${game.i18n.localize("WT.ThreatRoutes") || "THE HORDE ROUTS!"}`
            : ` — ${game.i18n.localize("WT.ThreatMoraleHold") || "The horde holds its ground."}`;

        let actionLabel = (game.i18n.localize("WT.RollMorale") || "Morale Check") + outcomeText;

        let poolBreakdown = [{ label: "Morale", value: `+${moraleVal}`, isPenalty: false }];
        await postOREChat(actor, actionLabel, diceToRoll, results, 0, 0, null, { isMinion: true, wasCapped, poolBreakdown: poolBreakdown });

        if (routed) {
            await actor.toggleStatusEffect("dead", { active: true });
            // Zero out both magnitude and morale — the group has fled
            await actor.update({
                "system.morale.value": 0,
                "system.magnitude.value": 0
            });
        }
    } catch (err) {
        console.error("WT Threat Roller | Morale Roll Failed:", err);
        ui.notifications.error("Morale roller crashed. Check F12 Console.");
    }
  }


  // ==========================================
  // PACKAGE A: OFFENSIVE MORALE ATTACK RECEIVER
  // ==========================================

  /**
   * RAW Ch6: Applies an incoming Morale Attack against this threat group.
   * Called from the threat sheet's "Receive Morale Attack" action or from damage.js.
   *
   * A number of fighters equal to the MA value flee, UNLESS the group's Threat
   * is >= the MA value (ties go to the mooks — they resist).
   *
   * @param {Actor} actor - The threat actor receiving the Morale Attack.
   * @param {number} moraleAttackValue - Strength of the incoming Morale Attack (1-10).
   * @param {string} [sourceDesc="Morale Attack"] - Description for the chat card.
   * @returns {Promise<{removed: number, resisted: boolean}>}
   */
  static async receiveMoraleAttack(actor, moraleAttackValue, sourceDesc = "Morale Attack") {
    const system = actor.system;
    const threatRating = system.threatLevel || 1;
    const currentGroup = system.magnitude?.value || 0;
    const maxGroup = system.magnitude?.max || currentGroup;
    const safeActorName = foundry.utils.escapeHTML(actor.name);

    if (currentGroup <= 0) {
      ui.notifications.info(`${actor.name} is already destroyed.`);
      return { removed: 0, resisted: false };
    }

    const removed = calculateMoraleAttackRemoval(moraleAttackValue, threatRating, currentGroup);
    const resisted = removed === 0;

    if (resisted) {
      // Threat >= Morale Attack: the group stands firm
      const chatContent = `<div class="wt-chat-card"><h3>${sourceDesc}</h3><p>Morale Attack <strong>${moraleAttackValue}</strong> vs Threat <strong>${threatRating}</strong></p><p class="wt-text-success wt-text-bold">${safeActorName} stands firm!</p><p class="wt-text-muted wt-text-small">Threat ≥ Morale Attack value — the horde is unimpressed.</p></div>`;
      await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: chatContent });
      return { removed: 0, resisted: true };
    }

    // Fighters flee
    const newGroup = Math.max(0, currentGroup - removed);
    await actor.update({ "system.magnitude.value": newGroup });

    let chatContent = `<div class="wt-chat-card wt-card-danger"><h3 class="wt-text-danger">${sourceDesc}</h3>`;
    chatContent += `<p>Morale Attack <strong>${moraleAttackValue}</strong> vs Threat <strong>${threatRating}</strong></p>`;
    chatContent += `<p><strong>${removed}</strong> fighter${removed !== 1 ? "s" : ""} ${removed !== 1 ? "flee" : "flees"} in terror!</p>`;
    chatContent += `<p class="wt-text-bold">Group Strength: <strong>${newGroup}</strong> / ${maxGroup}</p>`;

    if (newGroup === 0) {
      chatContent += `<div class="wt-status-banner dead">☠ ${safeActorName} HAS BEEN ROUTED</div>`;
      await actor.toggleStatusEffect("dead", { active: true });
      await actor.update({ "system.morale.value": 0 });
    }

    chatContent += `</div>`;
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: chatContent });

    if (newGroup === 0) {
      ui.notifications.warn(`${safeActorName} has been completely routed!`);
    }

    return { removed, resisted: false };
  }


  /**
   * Utility: Directly eliminates N fighters from a threat group.
   * Used for manual GM adjustments or effects that bypass the standard attack flow.
   *
   * @param {Actor} actor - The threat actor.
   * @param {number} count - Number of fighters to remove.
   * @param {string} [reason="Manual Removal"] - Reason displayed in chat.
   * @returns {Promise<number>} The new group size.
   */
  static async eliminateMinions(actor, count, reason = "Manual Removal") {
    const currentGroup = actor.system.magnitude?.value || 0;
    const maxGroup = actor.system.magnitude?.max || currentGroup;
    const actualRemoved = Math.min(count, currentGroup);
    const newGroup = Math.max(0, currentGroup - actualRemoved);
    const safeActorName = foundry.utils.escapeHTML(actor.name);

    await actor.update({ "system.magnitude.value": newGroup });

    let chatContent = `<div class="wt-chat-card"><h3>${reason}</h3>`;
    chatContent += `<p><strong>${actualRemoved}</strong> fighter${actualRemoved !== 1 ? "s" : ""} removed from ${safeActorName}.</p>`;
    chatContent += `<p class="wt-text-bold">Group Strength: <strong>${newGroup}</strong> / ${maxGroup}</p>`;

    if (newGroup === 0) {
      chatContent += `<div class="wt-status-banner dead">☠ ${safeActorName} HAS BEEN DESTROYED</div>`;
      await actor.toggleStatusEffect("dead", { active: true });
    }

    chatContent += `</div>`;
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: chatContent });

    return newGroup;
  }
}