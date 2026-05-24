// scripts/combat/defense.js
import { parseORE, calculateInitiative, computeLocationDamage, getHitLocationLabel, parseDamageFormula, applyArmor } from "../helpers/ore-engine.js";
import { generateOREChatHTML } from "../helpers/chat.js";
import { wtDialog } from "../helpers/dialog-util.js";
import { syncCharacterStatusEffects } from "./damage.js";
import { HIT_LOCATIONS } from "../helpers/config.js";

// NOTE: Damage formula parsing is now centralized in parseDamageFormula() (ore-engine.js).
// evaluateWeaponDamage has been removed. All call sites use parseDamageFormula instead.

/**
 * ITEM-13: Renders Width×Height as a row of die-face icons for use in chat cards.
 * @param {number} width  - Number of dice to render.
 * @param {number} height - The face value shown on each die.
 * @param {string} style  - CSS modifier: "matched" (blood red) or "waste" (muted).
 * @returns {string} HTML string.
 */
function renderTimingDice(width, height, style = "matched") {
    if (width <= 0) return `<em class="wt-text-muted">(no set)</em>`;
    const dice = Array.from({ length: width }, () =>
        `<span class="wt-die ${style}">${height}</span>`
    ).join("");
    return `<span class="wt-timing-dice">${dice}</span>`;
}

/**
 * PACKAGE B HELPER: Checks whether a character has adequate equipment to parry
 * armed attacks safely (weapon, shield, or arm armor AR >= 1).
 *
 * RAW Ch6 Parry rules:
 * - "If you're normally dressed and not holding something that can block a blow
 *    (even once), you can only safely parry unarmed attacks."
 * - "If you're wearing armor of at least AR 1 on your arms, you can parry all
 *    you want with them and take no damage."
 *
 * @param {Actor} actor - The defending actor.
 * @returns {{ adequate: boolean, parryArm: string }}
 */
function checkParryEquipment(actor) {
    if (!actor || actor.type !== "character") return { adequate: true, parryArm: "armR" };

    const items = actor.items || [];
    const hasWeapon = items.some(i => i.type === "weapon" && i.system.equipped);
    const equippedShield = items.find(i => i.type === "shield" && i.system.equipped);

    if (hasWeapon || equippedShield) return { adequate: true, parryArm: "armR" };

    // Check arm armor — HAR or LAR >= 1 is adequate for parrying armed attacks.
    // 📖 WT Rulebook Ch4: "If you're wearing armor of at least AR 1 on your arms,
    //     you can parry all you want with them and take no damage."
    const armRAr = (actor.system.effectiveHAR?.armR || 0) + (actor.system.effectiveLAR?.armR || 0);
    const armLAr = (actor.system.effectiveHAR?.armL || 0) + (actor.system.effectiveLAR?.armL || 0);

    if (armRAr >= 1 || armLAr >= 1) return { adequate: true, parryArm: armRAr >= 1 ? "armR" : "armL" };

    // No adequate equipment — default parrying arm is right arm
    return { adequate: false, parryArm: "armR" };
}


/**
 * RAW Ch6: Gobble Dice Consumption
 * V14 UPDATE: Includes Superior Interception, Cross Block Logic,
 * AND strict P2 RAW Width-Timing enforcement.
 * PACKAGE B: Adds unarmed parry redirect — if a parry succeeds without adequate
 * equipment against an armed attack, the attack's full damage hits the parrying arm.
 */
export async function consumeGobbleDie(attackMsg, targetSetHeight) {
    if (!attackMsg) return false;

    const attackFlags = attackMsg.flags?.["wild-talents-2e"];
    if (!attackFlags?.results) return false;

    const attackerActorId = attackMsg.speaker?.actor;

    // P2 FIX: Determine the speed/timing of the incoming attack
    const parsedAttack = parseORE(attackFlags.results, attackFlags.rollFlags?.isMinion);
    const attackSet = parsedAttack.sets.find(s => s.height === targetSetHeight);
    if (!attackSet) {
        ui.notifications.warn("Could not find the target attack set.");
        return false;
    }
    const attackInit = attackSet.width + (attackSet.height / 100);

    let slowDefenders = 0;
    // ITEM-13: Collect richer detail for failure messaging.
    const slowDefenderDetails = [];       // { name, defWidth, defHeight }
    const insufficientHeightDetails = []; // { name, heights: number[] }

    // ISSUE-024 FIX: Increased from 50 → 200 messages. Additionally filter by combat round
    // when the flag is present (stamped by postOREChat) to avoid stale cross-round gobbles.
    const currentCombatRound = game.combat?.round ?? -1;

    const defenseMessages = game.messages.contents.slice(-200).filter(m => {
        if (m.id === attackMsg.id) return false;
        if (m.speaker?.actor === attackerActorId) return false;
        const rf = m.flags?.["wild-talents-2e"];
        if (!rf?.isDefense) return false;
        const gd = rf.gobbleDice;
        if (!gd || !Array.isArray(gd) || gd.length === 0) return false;

        // If the message was stamped with a combat round, reject cross-round gobbles.
        if (rf.combatRound !== undefined && currentCombatRound >= 0 && rf.combatRound !== currentCombatRound) {
            return false;
        }

        const defActor = game.actors.get(m.speaker?.actor);
        const defMods = defActor?.system?.modifiers?.combat || {};

        let hasHeight = false;
        if (defMods.crossBlockActive) {
            // ISSUE-014 — Cross Block / The Hidden Shell (Iron Tortoise, 4pt):
            // Grants AR2 to all locations and provides gobble dice for all incoming hits.
            // Current implementation: crossBlockActive bypasses the height gate (any die height works)
            // but is still subject to the standard timing gate.
            // RAW citation needed: confirm whether The Hidden Shell also grants timing immunity
            // (like Superior Interception) or is limited to height-only bypass.
            hasHeight = true;
        } else if (defMods.combineGobbleDice) {
            hasHeight = gd.reduce((a, b) => a + b, 0) >= targetSetHeight;
        } else {
            hasHeight = gd.some(h => h >= targetSetHeight);
        }

        if (!hasHeight) {
            // ITEM-13: Record for the failure chat card.
            insufficientHeightDetails.push({ name: defActor?.name || "Unknown", heights: [...gd] });
            return false;
        }

        // P2 FIX: Enforce Width Timing — but NOT for Superior Interception (combineGobbleDice),
        // which RAW explicitly states applies "regardless of timing" (Ch7 p.140).
        const parsedDef = parseORE(rf.results, rf.rollFlags?.isMinion);
        const defHeight = gd[0];
        const defSet = parsedDef.sets.find(s => s.height === defHeight);
        const defInit = defSet ? (defSet.width + (defSet.height / 100)) : 0;

        if (!defMods.combineGobbleDice && defInit < attackInit) {
            // ITEM-13: Record for the failure chat card.
            slowDefenderDetails.push({ name: defActor?.name || "Unknown", defWidth: defSet?.width || 0, defHeight });
            slowDefenders++;
            return false;
        }

        return true;
    });

    if (defenseMessages.length === 0) {
        // G4.1: Check if the attacked creature has free Gobble Dice from a special ability.
        // RAW Ch13 Big Cat: "1–3 free Dodge Gobble Dice per round, usable at any time, with a value of 10."
        // "At any time" means no timing restriction — checked here regardless of attack initiative.
        const attackerActorId = attackMsg?.speaker?.actor;
        const attackedCombatant = game.combat?.combatants.find(c => c.actor?.id !== attackerActorId
            && c.actor?.type === "threat" && c.actor?.system.creatureMode);
        const attackedActor = attackedCombatant?.actor;
        const freePool = attackedActor ? (attackedActor.getFlag("wild-talents-2e", "freeGobbleDice") || []) : [];

        if (freePool.length > 0) {
            if (!freePool.some(h => h >= targetSetHeight)) {
                ui.notifications.warn(`${attackedActor.name}'s free Gobble Dice (value 10) cannot cancel Height ${targetSetHeight}.`);
            } else {
                // Consume one free die
                const newPool = [...freePool];
                newPool.splice(newPool.indexOf(10), 1);
                await attackedActor.setFlag("wild-talents-2e", "freeGobbleDice", newPool);

                const newResults = [...attackFlags.results];
                const dieIdx = newResults.indexOf(targetSetHeight);
                if (dieIdx !== -1) newResults.splice(dieIdx, 1);
                await attackMsg.update({ "flags.wild-talents-2e.results": newResults });

                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor: attackedActor }),
                    content: `<div class="wt-chat-card">
                      <h3><i class="fas fa-paw"></i> ${foundry.utils.escapeHTML(attackedActor.name)} — Free Gobble Die!</h3>
                      <p>Reflexively cancelled Height <strong>${targetSetHeight}</strong>. Free dice remaining: <strong>${newPool.length}</strong>.</p>
                    </div>`
                });
                return true;
            }
        }

        if (slowDefenders > 0) {
            // ITEM-13: Timing gate failure — show attacker and each slow defender as dice.
            const attackDice = renderTimingDice(attackSet.width, attackSet.height, "matched");
            const defLines = slowDefenderDetails.map(d => {
                const safeName = foundry.utils.escapeHTML(d.name);
                const defDice = renderTimingDice(d.defWidth, d.defHeight, "waste");
                return `<p style="margin:4px 0;"><strong>${safeName}:</strong> ${defDice}</p>`;
            }).join("");
            await ChatMessage.create({
                content: `<div class="wt-chat-card wt-card-warn">
                  <h3 class="wt-text-warning"><i class="fas fa-shield-alt"></i> Defense Too Slow</h3>
                  <p style="margin-bottom:4px;">Attack: ${attackDice}</p>
                  <p class="wt-text-small wt-text-muted" style="margin-bottom:6px;">The following defender(s) had the height but acted too late:</p>
                  ${defLines}
                  <p class="wt-text-small wt-text-muted" style="margin-top:6px;">Wider sets act first. A higher Width beats a slower defense even at the same Height.</p>
                </div>`
            });
        } else {
            // ITEM-13: Height failure — show what gobble dice defenders actually had.
            const neededDie = renderTimingDice(1, targetSetHeight, "matched");
            let defLines = "";
            if (insufficientHeightDetails.length > 0) {
                defLines = insufficientHeightDetails.map(d => {
                    const safeName = foundry.utils.escapeHTML(d.name);
                    const dicePips = d.heights.map(h =>
                        `<span class="wt-die waste">${h}</span>`
                    ).join("");
                    return `<p style="margin:4px 0;"><strong>${safeName}:</strong> <span class="wt-timing-dice">${dicePips}</span></p>`;
                }).join("");
            } else {
                defLines = `<p class="wt-text-muted wt-text-small">No defense rolls found this round.</p>`;
            }
            await ChatMessage.create({
                content: `<div class="wt-chat-card wt-card-warn">
                  <h3 class="wt-text-warning"><i class="fas fa-shield-alt"></i> No Defense Available</h3>
                  <p style="margin-bottom:4px;">Height needed: ${neededDie}</p>
                  <p class="wt-text-small wt-text-muted" style="margin-bottom:6px;">Gobble dice available — none high enough:</p>
                  ${defLines}
                </div>`
            });
        }
        return false;
    }

    let chosenDefenseMsg = defenseMessages[0];

    if (defenseMessages.length > 1) {
        const options = defenseMessages.map((m, i) => {
            const name = game.actors.get(m.speaker?.actor)?.name || "Unknown";
            const gd = m.flags?.["wild-talents-2e"].gobbleDice;
            return `<option value="${i}">${name} (${gd.length} dice: ${gd.join(", ")})</option>`;
        }).join("");

        const content = `
            <form class="wt-dialog-form">
                <p class="wt-text-center">Multiple defenders have Gobble Dice available and are fast enough to react.</p>
                <div class="form-group">
                    <label>Use Gobble Die from:</label>
                    <select name="defenderIdx">${options}</select>
                </div>
            </form>
        `;

        const chosenIdx = await wtDialog(
            "Choose Defender",
            content,
            (e, b, d) => parseInt(d.element.querySelector('[name="defenderIdx"]').value),
            { defaultLabel: "Consume Gobble Die" }
        );

        if (chosenIdx === undefined || chosenIdx === null) return false;
        chosenDefenseMsg = defenseMessages[chosenIdx];
    }

    const defenderActor = game.actors.get(chosenDefenseMsg.speaker?.actor);
    const defMods = defenderActor?.system?.modifiers?.combat || {};
    const defenderName = defenderActor?.name || "Defender";

    let gobblePool = [...chosenDefenseMsg.flags?.["wild-talents-2e"].gobbleDice];

    // ACTIVE EFFECT: Superior Interception
    if (defMods.combineGobbleDice && gobblePool.length > 1) {
        let totalHeight = gobblePool.reduce((sum, val) => sum + val, 0);
        gobblePool = [totalHeight];
        ui.notifications.info(`${defenderName} combined their Gobble Dice into a single die of Height ${totalHeight}!`);
    }

    const validDice = gobblePool
        .map((h, i) => ({ height: h, index: i }))
        .filter(d => defMods.crossBlockActive || d.height >= targetSetHeight)
        .sort((a, b) => a.height - b.height);

    if (validDice.length === 0) {
        ui.notifications.warn("No Gobble Die of sufficient Height available.");
        return false;
    }

    const consumed = validDice[0];
    gobblePool.splice(consumed.index, 1);

    if (defMods.combineGobbleDice) {
        gobblePool = [];
    }

    const newResults = [...attackFlags.results];
    const dieIdx = newResults.indexOf(targetSetHeight);
    if (dieIdx === -1) {
        ui.notifications.warn("Could not find a die of that height in the attack results.");
        return false;
    }
    newResults.splice(dieIdx, 1);

    const newHtml = await generateOREChatHTML(
        attackFlags.actorType,
        attackFlags.label,
        attackFlags.totalPool,
        newResults,
        attackFlags.hardDieCount ?? attackFlags.expertDie ?? 0,
        attackFlags.wiggleDieCount ?? attackFlags.masterDiceCount ?? 0,
        attackFlags.itemData,
        attackFlags.rollFlags
    );

    const gobbleBanner = `<div class="wt-status-banner gobbled"><i class="fas fa-shield-alt"></i> GOBBLED! ${defenderName} used a Gobble Die (Height ${consumed.height}) to cancel a die of Height ${targetSetHeight}.</div>`;
    const finalHtml = newHtml.replace('<div class="wt-chat-card">', `<div class="wt-chat-card">${gobbleBanner}`);

    await attackMsg.update({
        content: finalHtml,
        "flags.wild-talents-2e.results": newResults
    });

    const defFlags = chosenDefenseMsg.flags?.["wild-talents-2e"];
    const newDefenseHtml = await generateOREChatHTML(
        defFlags.actorType, defFlags.label, defFlags.totalPool,
        defFlags.results, defFlags.hardDieCount ?? defFlags.expertDie ?? 0, defFlags.wiggleDieCount ?? defFlags.masterDiceCount ?? 0,
        defFlags.itemData, { ...defFlags.rollFlags, gobbleDice: gobblePool }
    );

    await chosenDefenseMsg.update({
        content: newDefenseHtml,
        "flags.wild-talents-2e.gobbleDice": gobblePool
    });


    // ==========================================
    // PACKAGE B: UNARMED PARRY REDIRECT
    // ==========================================
    // RAW Ch6: "If you have nothing tough enough to stop a blow and you parry
    // successfully anyhow, you just redirect the blow to the parrying arm.
    // It does full damage, but to your arm instead of (for example) your head."
    //
    // "If you're wearing armor of at least AR 1 on your arms, you can parry
    // all you want with them and take no damage."
    //
    // Exception: Unarmed attacks (punches, kicks) can be safely parried bare-handed.

    const isParry = defFlags.defenseType === "parry" || /parry/i.test(defFlags.label || "");

    if (isParry && defenderActor?.type === "character") {
        // Check if the attack is armed (a held weapon, not a natural/body attack).
        // RAW: "you can only safely parry unarmed attacks" bare-handed.
        // Weapons marked with the 'unarmed' quality (Bite, Punch, Kick) are body attacks.
        const isArmedAttack = attackFlags.itemData
            && attackFlags.itemData.type === "weapon"
            && !attackFlags.itemData.system.qualities?.unarmed;

        if (isArmedAttack) {
            const { adequate, parryArm } = checkParryEquipment(defenderActor);

            if (!adequate) {
                // Parry "succeeded" mechanically (gobble die consumed) but without equipment
                // the force of an armed blow transfers directly to the parrying arm.
                // Use the pre-gobble Width for "full damage" as the rules specify.
                const attackWidth = attackSet.width;
                const dmgStr = attackFlags.itemData?.system?.damage
                            || attackFlags.itemData?.system?.damageFormula
                            || "Width Shock";
                const { shock, killing } = parseDamageFormula(dmgStr, attackWidth);

                if (shock > 0 || killing > 0) {
                    const localHealth = foundry.utils.deepClone(defenderActor.system.health);
                    // Apply HAR/LAR armor on the parrying arm (likely minimal since
                    // checkParryEquipment already confirmed total AR < 1, but natural
                    // armor or Active Effects may contribute).
                    const armHAR = defenderActor.system.effectiveHAR?.[parryArm] || 0;
                    const armLAR = defenderActor.system.effectiveLAR?.[parryArm] || 0;
                    const armHardened = !!defenderActor.system.isHardenedAt?.[parryArm];
                    const armorResult = applyArmor(shock, killing, attackWidth, armHAR, armLAR, 0, armHardened);

                    const finalShock = armorResult.blocked ? 0 : armorResult.finalShock;
                    const finalKilling = armorResult.blocked ? 0 : armorResult.finalKilling;

                    if (finalShock > 0 || finalKilling > 0) {
                        const effectiveMax = defenderActor.system.effectiveMax?.[parryArm] || 5;
                        const result = computeLocationDamage(
                            localHealth[parryArm].shock || 0,
                            localHealth[parryArm].killing || 0,
                            finalShock,
                            finalKilling,
                            effectiveMax
                        );

                        localHealth[parryArm].shock = result.newShock;
                        localHealth[parryArm].killing = result.newKilling;

                        // Overflow from a destroyed arm goes to torso
                        if (result.overflowKilling > 0) {
                            const torsoMax = defenderActor.system.effectiveMax?.torso || 10;
                            const torsoResult = computeLocationDamage(
                                localHealth.torso.shock || 0,
                                localHealth.torso.killing || 0,
                                0,
                                result.overflowKilling,
                                torsoMax
                            );
                            localHealth.torso.shock = torsoResult.newShock;
                            localHealth.torso.killing = torsoResult.newKilling;
                        }

                        // Write health updates
                        const healthUpdates = {};
                        for (const k of HIT_LOCATIONS) {
                            if (localHealth[k].shock !== defenderActor.system.health[k].shock) {
                                healthUpdates[`system.health.${k}.shock`] = localHealth[k].shock;
                            }
                            if (localHealth[k].killing !== defenderActor.system.health[k].killing) {
                                healthUpdates[`system.health.${k}.killing`] = localHealth[k].killing;
                            }
                        }
                        if (!foundry.utils.isEmpty(healthUpdates)) {
                            await defenderActor.update(healthUpdates);
                        }
                        await syncCharacterStatusEffects(defenderActor);

                        // Post redirect notification
                        const safeDefName = foundry.utils.escapeHTML(defenderName);
                        const armLabel = getHitLocationLabel(parryArm).split(" (")[0];
                        const shockSoaked = Math.min(shock, armHAR + armLAR);
                        const killingSoaked = Math.min(killing, armHAR + armLAR);

                        let redirectHtml = `<div class="wt-chat-card wt-card-danger">`;
                        redirectHtml += `<h3 class="wt-text-danger"><i class="fas fa-hand-paper"></i> Bare-Handed Parry!</h3>`;
                        redirectHtml += `<p>${safeDefName} caught the blow with a bare arm — the full force transfers!</p>`;
                        redirectHtml += `<div class="wt-callout wt-callout-danger">`;
                        redirectHtml += `<strong>${armLabel}:</strong> `;
                        if (finalKilling > 0) redirectHtml += `<span class="wt-text-danger">${finalKilling} Kill</span> `;
                        if (finalShock > 0) redirectHtml += `<span>${finalShock} Shock</span> `;
                        if ((armHAR + armLAR) > 0) redirectHtml += `<span class="wt-text-muted wt-text-small">(Armor stopped ${shockSoaked}S/${killingSoaked}K)</span>`;
                        if (result.overflowKilling > 0) redirectHtml += `<br><span class="wt-text-danger wt-text-small">(+${result.overflowKilling} Killing overflow to Torso)</span>`;
                        redirectHtml += `</div>`;
                        redirectHtml += `<p class="wt-text-muted wt-text-small">Without a weapon, shield, or arm armor (AR 1+), a parry redirects full damage to the parrying arm.</p>`;
                        redirectHtml += `</div>`;

                        await ChatMessage.create({
                            speaker: ChatMessage.getSpeaker({ actor: defenderActor }),
                            content: redirectHtml
                        });
                    }
                }
            }
        }
    }


    // Update initiative for the attacker based on remaining sets
    if (game.combat) {
        const newParsed = parseORE(newResults, attackFlags.rollFlags?.isMinion);
        const combatant = game.combat.combatants.find(c => c.actorId === attackerActorId);
        if (combatant) {
            let newInit = 0;
            if (newParsed.sets.length > 0) {
                const flags = attackFlags.rollFlags || {};
                const isDefense = flags.isDefense || /dodge|parry|counterspell/i.test(attackFlags.label);
                const range = attackFlags.itemData?.type === "weapon" ? (attackFlags.itemData.system.range || "0") : "0";
                newInit = calculateInitiative(newParsed.sets, isDefense, flags.isAttack, flags.isMinion, range);
            }
            await combatant.update({ initiative: newInit });
        }
    }

    ui.notifications.info(`${defenderName} gobbled a die from the attack! Height ${targetSetHeight} die removed.`);
    return true;
}

// ==========================================
// ITEM 8: DIVE FOR COVER
// ==========================================

/**
 * RAW Ch6 "Dodge / Cover": When a Dodge roll produces sets, the player may choose
 * to dive for cover instead of using Gobble Dice. This sacrifices all Gobble Dice
 * from the Dodge in exchange for location-based immunity behind an obstacle.
 *
 * "If you retain a Dodge set, when it goes off you can protect your bits as you see fit."
 *
 * Mechanically:
 * - All Gobble Dice from the Dodge message are consumed (no longer available for gobbling)
 * - The player selects which locations are hidden behind cover
 * - Those locations gain full immunity to attacks for the remainder of the round
 * - The character is considered "downed" (prone) from the dive
 *
 * @param {ChatMessage} dodgeMsg - The Dodge roll chat message with gobble dice.
 * @returns {Promise<boolean>} True if cover was successfully applied.
 */
export async function diveForCover(dodgeMsg) {
    if (!dodgeMsg) return false;

    const flags = dodgeMsg.flags?.["wild-talents-2e"];
    if (!flags) return false;

    // Validate this is a Dodge defense
    const isValidDodge = flags.isDefense && (flags.defenseType === "dodge" || /dodge/i.test(flags.label || ""));
    if (!isValidDodge) {
        ui.notifications.warn("Dive for Cover can only be used with a Dodge roll.");
        return false;
    }

    // Check gobble dice are available
    const gobbleDice = flags.gobbleDice;
    if (!gobbleDice || !Array.isArray(gobbleDice) || gobbleDice.length === 0) {
        ui.notifications.warn("No Gobble Dice remaining on this Dodge to sacrifice for cover.");
        return false;
    }

    const actorId = dodgeMsg.speaker?.actor;
    const actor = game.actors.get(actorId);
    if (!actor || actor.type !== "character") {
        ui.notifications.warn("Could not find a valid character actor for this Dodge.");
        return false;
    }

    // Check if cover is already active
    if (actor.getFlag("wild-talents-2e", "dodgeCover")) {
        ui.notifications.warn(`${actor.name} is already in cover this round.`);
        return false;
    }

    const locationLabels = {
        head: "Head (10)", torso: "Torso (7-9)", armR: "R. Arm (5-6)",
        armL: "L. Arm (3-4)", legR: "R. Leg (2)", legL: "L. Leg (1)"
    };
    const locationKeys = ["head", "torso", "armR", "armL", "legR", "legL"];

    // Prompt: which locations does the cover protect?
    const checkboxes = locationKeys.map(k => {
        return `<label class="wt-checkbox-row"><input type="checkbox" name="cover_${k}" value="${k}" /> ${locationLabels[k]}</label>`;
    }).join("");

    const content = `
        <form class="wt-dialog-form">
            <p class="wt-text-center wt-text-large wt-text-bold">Dive for Cover!</p>
            <p class="wt-text-center wt-text-small wt-text-muted">
                Sacrifice your <strong>${gobbleDice.length} Gobble Dice</strong> (${gobbleDice.join(", ")})
                to dive behind an obstacle. You will be <strong>downed</strong> (prone) but protected.
            </p>
            <p class="wt-text-center wt-text-small">Select which locations are hidden behind the cover:</p>
            <div class="wt-cover-checkboxes wt-flex-col">
                ${checkboxes}
            </div>
            <p class="wt-text-center wt-text-muted wt-text-small">
                The GM determines what cover is available. A low wall might hide legs and torso;
                a narrow pillar might only cover the torso.
            </p>
        </form>
    `;

    const result = await wtDialog(
        "Dive for Cover",
        content,
        (e, b, d) => {
            const f = d.element.querySelector("form") || d.element;
            const covered = {};
            for (const k of locationKeys) {
                covered[k] = !!f.querySelector(`[name="cover_${k}"]`)?.checked;
            }
            return covered;
        },
        { defaultLabel: "Dive!" }
    );

    if (!result) return false;

    // Verify at least one location was selected
    const anyProtected = Object.values(result).some(v => v);
    if (!anyProtected) {
        ui.notifications.warn("No locations selected for cover. Dive cancelled.");
        return false;
    }

    // 1) Consume all gobble dice from the Dodge message
    const updatedRollFlags = foundry.utils.deepClone(flags.rollFlags || {});
    updatedRollFlags.gobbleDice = [];

    const newDodgeHtml = await generateOREChatHTML(
        flags.actorType, flags.label, flags.totalPool,
        flags.results, flags.hardDieCount ?? flags.expertDie ?? 0, flags.wiggleDieCount ?? flags.masterDiceCount ?? 0,
        flags.itemData, updatedRollFlags
    );

    const coverBanner = `<div class="wt-status-banner gobbled"><i class="fas fa-shield-alt"></i> DOVE FOR COVER! Gobble Dice sacrificed. ${actor.name} is behind cover and downed.</div>`;
    const finalDodgeHtml = newDodgeHtml.replace('<div class="wt-chat-card">', `<div class="wt-chat-card">${coverBanner}`);

    await dodgeMsg.update({
        content: finalDodgeHtml,
        "flags.wild-talents-2e.gobbleDice": [],
        "flags.wild-talents-2e.rollFlags": updatedRollFlags,
        "flags.wild-talents-2e.coverApplied": true
    });

    // 2) Set cover flags on the actor (read by isLocationInCover in damage.js)
    await actor.setFlag("wild-talents-2e", "dodgeCover", result);

    // 3) Apply prone/downed status — diving for cover puts you on the ground
    if (!actor.statuses.has("prone")) {
        await actor.toggleStatusEffect("prone", { active: true });
    }

    // 4) Post a summary chat card
    const safeName = foundry.utils.escapeHTML(actor.name);
    const protectedNames = Object.entries(result)
        .filter(([, v]) => v)
        .map(([k]) => locationLabels[k]?.split(" (")[0] || k);
    const exposedNames = Object.entries(result)
        .filter(([, v]) => !v)
        .map(([k]) => locationLabels[k]?.split(" (")[0] || k);

    let chatHtml = `<div class="wt-chat-card">`;
    chatHtml += `<h3><i class="fas fa-shield-alt"></i> ${safeName} Dives for Cover!</h3>`;
    chatHtml += `<div class="wt-callout">`;
    chatHtml += `<p><strong>Protected:</strong> ${protectedNames.join(", ")}</p>`;
    if (exposedNames.length > 0) {
        chatHtml += `<p><strong>Exposed:</strong> <span class="wt-text-danger">${exposedNames.join(", ")}</span></p>`;
    }
    chatHtml += `</div>`;
    chatHtml += `<p class="wt-text-muted wt-text-small">Downed (prone) until they spend an action to stand. Attacks targeting protected locations are blocked entirely.</p>`;
    chatHtml += `</div>`;

    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: chatHtml });

    ui.notifications.info(`${actor.name} dove for cover! ${protectedNames.length} location(s) protected.`);
    return true;
}