/* global HTMLElement, Event */
// scripts/helpers/character-roller.js

const { renderTemplate } = foundry.applications.handlebars;
import { parseORE } from "./ore-engine.js";
import { postOREChat } from "./chat.js";
import { SUGGESTED_SKILLS, DEBUG_ROLLS } from "./config.js";
import { MANEUVERS, getManeuverOptions, resolveWidthTier } from "./maneuvers.js";

import { wtDialog } from "./dialog-util.js";
import { BaseORERoller } from "./base-roller.js";

/**
 * Calculates final dice pool composition for Wild Talents ORE rolls.
 *
 * WT Key Differences from Reign:
 *   - No "1 special die" cap — pools can have multiple HD and WD simultaneously
 *   - Hard Dice (HD) are locked to a face (always 10 unless specified otherwise)
 *   - Wiggle Dice (WD) are assigned AFTER rolling to any face (1–10)
 *   - Penalties remove Normal dice first, then HD — never WD
 *
 * 📖 WT Rulebook Ch2 — verify penalty order and HD/WD interaction rules
 *
 * @param {number} totalNormal - Sum of stat.normal + skill.normal + bonus dice
 * @param {number} totalHard   - Sum of stat.hard + skill.hard
 * @param {number} totalWiggle - Sum of stat.wiggle + skill.wiggle
 * @param {number} calledShot  - Called shot height (0 = none)
 * @param {number} basePenalty - Penalty dice (from wounds, conditions, etc.)
 * @param {number} multiActions - Number of declared actions (1 = normal)
 * @param {boolean} ignoreMultiPenalty - AE flag to skip multi-action penalty
 * @returns {object} Pool composition for BaseORERoller.finalizeWithSpecialDice()
 */
export function calculateWTPool(totalNormal, totalHard, totalWiggle, calledShot, basePenalty, multiActions, ignoreMultiPenalty = false) {
    let normalCount = Math.max(0, totalNormal);
    let hardCount   = Math.max(0, totalHard);
    let wiggleCount = Math.max(0, totalWiggle);

    // ── Called Shot ──
    // With HD: if any HD is already at the called height, the CS is free.
    // With WD: WD can be assigned to the called height after rolling — free.
    // Without either: a normal die is dedicated as the CS die (−1d penalty).
    let calledShotFree = false;
    let appliedCsPenalty = 0;
    let finalCalledShot = calledShot;

    if (finalCalledShot > 0) {
        if (wiggleCount > 0) {
            calledShotFree = true; // WD can always be set to the called height
        } else if (hardCount > 0) {
            calledShotFree = true; // HD is at 10 — if CS is 10, it's automatic
            // TODO: If HD face ≠ called shot height, this may not be free
            // 📖 WT Rulebook Ch6 — verify called shot + HD interaction
        } else {
            appliedCsPenalty = 1; // Dedicate one normal die
        }
    }

    // ── Multi-Action Penalty ──
    let multiActionPenalty = (!ignoreMultiPenalty && multiActions > 1) ? (multiActions - 1) : 0;

    // ── Total Penalty ──
    let totalPenalty = basePenalty + multiActionPenalty + appliedCsPenalty;

    // ── Apply Penalties ──
    // WT Rulebook Ch1 p.25 + Reference Sheet:
    // "Penalty Dice: Each removes one die from your dice pool:
    //  Hard Dice first, then normal dice, then Wiggle Dice last."
    let totalBeforePenalty = normalCount + hardCount + wiggleCount;
    let overflow = Math.max(0, totalBeforePenalty - 10); // Pool cap is 10

    // Overflow absorbs penalty first
    let netPenalty = Math.max(0, totalPenalty - overflow);

    // 1. Remove Hard Dice FIRST
    if (netPenalty > 0) {
        let hardLoss = Math.min(hardCount, netPenalty);
        hardCount -= hardLoss;
        netPenalty -= hardLoss;
    }

    // 2. Then remove Normal dice
    if (netPenalty > 0) {
        let normalLoss = Math.min(normalCount, netPenalty);
        normalCount -= normalLoss;
        netPenalty -= normalLoss;
    }

    // 3. Wiggle Dice removed LAST (only if nothing else remains)
    if (netPenalty > 0) {
        let wiggleLoss = Math.min(wiggleCount, netPenalty);
        wiggleCount -= wiggleLoss;
        netPenalty -= wiggleLoss;
    }

    // ── Enforce Pool Cap (10d) ──
    let totalAfterPenalty = normalCount + hardCount + wiggleCount;
    if (totalAfterPenalty > 10) {
        // Reduce Normal dice to fit cap
        let excess = totalAfterPenalty - 10;
        let normalReduce = Math.min(normalCount, excess);
        normalCount -= normalReduce;
        excess -= normalReduce;
        // If still over (unlikely), reduce HD
        if (excess > 0) {
            let hardReduce = Math.min(hardCount, excess);
            hardCount -= hardReduce;
        }
    }

    // ── Build Hard Dice Array (each locked to face 10) ──
    // TODO: Support custom HD faces if rulebook allows
    const hardDice = [];
    for (let i = 0; i < hardCount; i++) {
        hardDice.push({ face: 10 });
    }

    let diceToRoll = normalCount; // Only normal dice are actually rolled
    let wasCapped = totalBeforePenalty > 10;

    return {
        normalDiceCount: normalCount,
        hardDice,           // Array of {face} — appended to results before WD prompt
        hardCount,
        wiggleDiceCount: wiggleCount,
        finalCalledShot: calledShotFree ? 0 : finalCalledShot,
        calledShotFree,
        diceToRoll,         // Only the normal dice
        wasCapped,
        totalPool: normalCount + hardCount + wiggleCount,
        penaltyApplied: totalPenalty,
        unresolvablePenalty: netPenalty  // Penalty that couldn't be applied
    };
}

export class CharacterRoller extends BaseORERoller {
  static async rollCharacter(actor, dataset, options = {}) {
    try {
        if (DEBUG_ROLLS) console.log("WT Roller | Execution Started.", dataset);

        const { type, key, label } = dataset;
        const system = actor.system;

        const headMax = parseInt(system.effectiveMax?.head) || 4;
        const torsoMax = parseInt(system.effectiveMax?.torso) || 10;
        const headK = parseInt(system.health.head.killing) || 0;
        const headS = parseInt(system.health.head.shock) || 0;
        const torsoK = parseInt(system.health.torso.killing) || 0;
        const torsoS = parseInt(system.health.torso.shock) || 0;

        if (headK >= headMax || torsoK >= torsoMax) return ui.notifications.error("Character is dead and cannot act.");
        if (headS + headK >= headMax) return ui.notifications.warn("Character is unconscious and cannot act.");

        let itemRef = null;
        if (type === "item") itemRef = actor.items.get(key);

        // --- V14 ACTIVE EFFECTS EXTRACTION ---
        const modifiers = system.modifiers || {};
        const systemFlags = modifiers.systemFlags || {};
        const combatMods = modifiers.combat || {};
        const actionEconomy = modifiers.actionEconomy || {};

        if (systemFlags.cannotUseTwoHanded && type === "item" && itemRef?.type === "weapon" && itemRef.system.qualities?.twoHanded) {
            return ui.notifications.error(`Cannot wield ${itemRef.name}. You cannot use two-handed weapons due to a missing limb or restriction.`);
        }

        let isCompletingCast = false;

        if (game.combat) {
            const combatant = game.combat.combatants.find(c => c.actorId === actor.id);
            if (combatant) {
                if (type === "item" && itemRef?.type === "weapon" && itemRef.system.qualities?.slow > 0) {
                    const cooldownUntil = combatant.getFlag("wild-talents-2e", "slowCooldown") || 0;
                    if (game.combat.round <= cooldownUntil) return ui.notifications.warn(`${itemRef.name} is still being readied. Available on round ${cooldownUntil + 1}.`);
                }

                const activeCast = combatant.getFlag("wild-talents-2e", "activeCast");
                
                if (activeCast) {
                    if (game.combat.round < activeCast.round) {
                        return ui.notifications.warn(`${actor.name} is concentrating on ${activeCast.name} and cannot take other actions until Round ${activeCast.round}.`);
                    } else if (type === "item" && key === activeCast.itemId) {
                        await combatant.unsetFlag("wild-talents-2e", "activeCast");
                        isCompletingCast = true;
                    } else {
                        return ui.notifications.error(`You have ${activeCast.name} prepared. You must cast it before taking other actions!`);
                    }
                } else if (!isCompletingCast && type === "item" && itemRef?.type === "spell" && itemRef.system.castingTime > 0) {
                    const castCompleteRound = game.combat.round + itemRef.system.castingTime;
                    await combatant.setFlag("wild-talents-2e", "activeCast", { itemId: itemRef.id, name: itemRef.name, round: castCompleteRound });
                    
                    let chatHtml = `
                      <div class="wt-chat-card wt-card-magic">
                        <h3 class="wt-text-magic"><i class="fas fa-magic"></i> Casting Started</h3>
                        <p><strong>${actor.name}</strong> begins gathering power for <em>${itemRef.name}</em>.</p>
                        <p class="wt-text-small wt-text-muted">The spell requires total concentration and will be ready to release on <strong>Round ${castCompleteRound}</strong>.</p>
                      </div>`;
                    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({actor}), content: chatHtml });
                    return;
                }
            }
        }

        let baseValue = 0; let defaultAttr = "none"; let defaultSkill = "none";
        let isPowerRoll = false;
        let powerItem = null;
        let powerDiceOverride = null; // { normal, hard, wiggle } — set for standalone Miracle rolls

        if (type === "attribute") {
            baseValue = 0; defaultAttr = key; 
        } else if (type === "power") {
            // ── POWER ROLL ──
            // 📖 WT Rulebook Ch6 p.114-115: "Using a power is as easy as declaring
            //     an action and rolling the appropriate dice."
            // Key: itemId of the power
            powerItem = actor.items.get(key);
            if (!powerItem || powerItem.type !== "power") return ui.notifications.warn("Power not found on this character.");
            isPowerRoll = true;
            const pd = powerItem.system.dice || {};
            const powerN = parseInt(pd.normal) || 0;
            const powerH = parseInt(pd.hard) || 0;
            const powerW = parseInt(pd.wiggle) || 0;

            if (powerItem.system.powerType === "hyperstat") {
                // Hyperstat: adds dice to a stat. Roll stat + power dice.
                // 📖 WT Rulebook Ch6 p.104: "A Hyperstat simply adds dice to the Stat."
                const linkedStat = powerItem.system.linkedStat || "";
                if (linkedStat && system.attributes[linkedStat]) {
                    defaultAttr = linkedStat;
                    // Power dice get added in the pool assembly section below
                } else {
                    defaultAttr = "body"; // Fallback
                }
                defaultSkill = "none";

            } else if (powerItem.system.powerType === "hyperskill") {
                // Hyperskill: adds dice to a skill (and its linked stat).
                // 📖 WT Rulebook Ch6 p.105: "A Hyperskill adds dice to the Skill."
                const linkedSkill = powerItem.system.linkedSkill || "";
                if (linkedSkill) {
                    // Find the skill in the freeform skills
                    const sk = system.skills?.[linkedSkill];
                    if (sk) {
                        defaultSkill = linkedSkill;
                        defaultAttr = sk.attribute || "body";
                    } else {
                        // Try matching by label
                        const matchedKey = Object.keys(system.skills || {}).find(k =>
                            (system.skills[k].label || "").toLowerCase() === linkedSkill.toLowerCase()
                        );
                        if (matchedKey) {
                            defaultSkill = matchedKey;
                            defaultAttr = system.skills[matchedKey].attribute || "body";
                        } else {
                            defaultAttr = "body";
                        }
                    }
                } else {
                    defaultAttr = "body";
                }

            } else {
                // Miracle: standalone dice pool. No stat or skill.
                // 📖 WT Rulebook Ch6 p.106: "you roll the Miracle's dice pool alone"
                powerDiceOverride = { normal: powerN, hard: powerH, wiggle: powerW };
                defaultAttr = "none";
                defaultSkill = "none";
            }

            // Build itemRef-like data for the chat card if the power has an Attacks quality
            const hasAttacks = (powerItem.system.qualities || []).some(q => q.type === "attacks");
            if (hasAttacks) {
                // 📖 WT Rulebook Ch6 p.112: Attack damage is Width in Shock by default.
                // Bonus damage levels from the Attacks quality add to Killing.
                // Needs rulebook verification: exact formula for quality level → damage bonus.
                const attackQuality = (powerItem.system.qualities || []).find(q => q.type === "attacks");
                const bonusLevels = attackQuality?.level || 0;
                let dmg = "Width Shock";
                if (bonusLevels > 0) dmg += ` + ${bonusLevels} Killing`;
                itemRef = {
                    id: powerItem.id,
                    name: powerItem.name,
                    type: "power",
                    img: powerItem.img,
                    system: {
                        damage: dmg,
                        pool: "",
                        range: "",
                        qualities: { armorPiercing: 0, slow: 0, area: 0, massive: false }
                    }
                };
            }

        } else if (type === "skill") { 
            const skillData = system.skills?.[key];
            if (!skillData) return ui.notifications.warn("Skill not found on this character.");
            baseValue = parseInt(skillData.value) || 0;
            // WT: Read the attribute binding from the skill's own data
            defaultAttr = skillData.attribute || "body";
        } else if (type === "move") {
            const m = system.validCustomMoves ? system.validCustomMoves[key] : system.customMoves[key];
            if (!m) return ui.notifications.error("That custom move no longer exists.");
            let aVal = m.attrKey !== "none" ? (parseInt(system.attributes[m.attrKey]?.normal) || 0) : 0;
            let sVal = 0;
            if (m.skillKey !== "none") {
                // WT: All skills are freeform in system.skills with N/HD/WD dice.
                const sk = system.skills[m.skillKey];
                if (sk) sVal = parseInt(sk.value) || 0;
            }
            baseValue = aVal + sVal + (parseInt(m.modifier) || 0);
        } else if (type === "item") { 
            const poolRaw = itemRef?.system?.pool || ""; 
            
            // WT: Weapon items use ITEM-9 structured skill binding below.
            // Weapon items use ITEM-9 structured skill binding below.
            {
                // ITEM-9: Structured skill binding — prefer skillKey on weapon items over
                // freetext pool-string parsing. Empty skillKey = original behaviour (full
                // backward compatibility for all existing weapons).
                //
                // skillKey format:
                //   ""           → use pool-string parsing (existing path, no change)
                //   "fight"      → direct key in system.skills (WT freeform)
                //   "custom:id"  → legacy format, treated as direct key (strip prefix)
                //
                // WT: All skills are freeform in system.skills.
                const structuredKey = (itemRef?.type === "weapon") ? (itemRef.system.skillKey || "") : "";

                if (structuredKey) {
                    // Strip legacy "custom:" prefix if present
                    const cleanKey = structuredKey.replace(/^custom:/, "");
                    const sk = system.skills?.[cleanKey];
                    if (sk) {
                        defaultSkill = cleanKey; baseValue = 0;
                        defaultAttr = sk.attribute || SUGGESTED_SKILLS[cleanKey] || "coordination";
                    } else {
                        console.warn(`WT | Weapon "${itemRef?.name}" has skillKey "${structuredKey}" but skill not found on "${actor.name}". Falling back to pool string.`);
                        const matched = Object.keys(system.skills || {}).find(k => k.toLowerCase() === poolRaw.toLowerCase());
                        if (matched) {
                            defaultSkill = matched; baseValue = 0;
                            defaultAttr = system.skills[matched]?.attribute || SUGGESTED_SKILLS[matched] || "coordination";
                        } else {
                            baseValue = parseInt(poolRaw) || 0; defaultAttr = "coordination";
                        }
                    }
                } else {
                    // No skillKey — parse pool string as skill name lookup
                    const matched = Object.keys(system.skills || {}).find(k => k.toLowerCase() === poolRaw.toLowerCase());
                    if (matched) {
                        defaultSkill = matched; baseValue = 0;
                        defaultAttr = system.skills[matched]?.attribute || SUGGESTED_SKILLS[matched] || "coordination";
                    } else {
                        baseValue = parseInt(poolRaw) || 0; defaultAttr = "coordination";
                    }
                }
            }
        }

        if (type === "item" && itemRef?.type === "weapon" && itemRef.system.qualities?.massive) {
            const bodyDice = system.attributes.body || {};
            const bodyTotal = (parseInt(bodyDice.normal) || 0) + (parseInt(bodyDice.hard) || 0) + (parseInt(bodyDice.wiggle) || 0);
            if (bodyTotal < 4) {
                return ui.notifications.error(`Cannot wield ${itemRef.name}. Massive weapons require Body 4d or higher (Current: ${bodyTotal}d).`);
            }
        }

        // ISSUE-004 FIX: Encumbrance must use derivedWeight (computed from coverage + AR per RAW Ch6 p.113),
        // NOT the author-set armorWeight StringField which can diverge from RAW silently.
        // armorWeight is kept as a cosmetic / tooltip field only.
        let armorWeight = "none";
        const equippedArmor = actor.items.filter(i => i.type === "armor" && i.system.equipped);
        const encumbWeights = equippedArmor.map(a => a.system.derivedWeight || a.system.armorWeight || "none");
        if (encumbWeights.includes("heavy")) armorWeight = "heavy";
        else if (encumbWeights.includes("medium")) armorWeight = "medium";
        else if (encumbWeights.includes("light")) armorWeight = "light";

        const equippedShields = actor.items.filter(i => i.type === "shield" && i.system.equipped);
        const hasShield = equippedShields.length > 0;
        const hasTower = equippedShields.some(s => s.system.shieldSize === "tower");

        // Resolve precise Skill Key for Active Effects matching
        // WT: Skill keys are plain freeform slugs.
        let rawSkillKey = defaultSkill;
        if (!rawSkillKey || rawSkillKey === "none") rawSkillKey = key; 
        
        const skillMods = modifiers.skills?.[rawSkillKey] || {};
        // ignoreMultiPenaltySkills is a StringField — comma-separated skill names, e.g. "sorcery" or "sorcery,fight".
        // Defensive: handle legacy array values or unexpected types without crashing.
        const rawIgnoreSkills = actionEconomy.ignoreMultiPenaltySkills;
        const ignoreSkillsStr = Array.isArray(rawIgnoreSkills)
            ? rawIgnoreSkills.join(",")
            : String(rawIgnoreSkills || "");
        const ignoreSkillsList = ignoreSkillsStr.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
        const ignoreMultiPenalty = ignoreSkillsList.includes(rawSkillKey);

        const showSkillSelect = (type === "item");
        const hasPowerAttacks = isPowerRoll && itemRef?.type === "power";
        const hasPowerDefends = isPowerRoll && (powerItem?.system?.qualities || []).some(q => q.type === "defends");
        const isCombatRoll = (type === "item" && itemRef?.type === "weapon") || (type === "skill" && key === "fight") || (type === "move") || hasPowerAttacks;
        const isDefenseRoll = rawSkillKey === "parry" || rawSkillKey === "dodge" || rawSkillKey === "counterspell" || hasPowerDefends;
        const isAttackRoll = (isCombatRoll && !isDefenseRoll) || hasPowerAttacks;

        let isDazed = actor.statuses.has("dazed");
        let isProne = actor.statuses.has("prone");
        let isBlind = actor.statuses.has("blind");

        if (isProne && rawSkillKey === "dodge") {
            return ui.notifications.error("You cannot Dodge while Prone. The action auto-fails.");
        }

        let encumbDiff = 0; let encumbPen = 0; let encumbImpossible = false;

        if (hasTower && (rawSkillKey === "stealth" || rawSkillKey === "climb")) {
            encumbImpossible = true;
        }

        const heavyPenaltySkills = ["climb", "run", "stealth", "endurance", "athletics"];
        const mediumPenaltySkills = ["stealth", "climb", "run", "endurance", "athletics"];
        
        const isHeavyPenalty = heavyPenaltySkills.includes(rawSkillKey);
        const isMediumPenalty = mediumPenaltySkills.includes(rawSkillKey);

        if (armorWeight === "heavy") {
            if (rawSkillKey === "stealth") encumbImpossible = true;
            if (isHeavyPenalty) {
                if (rawSkillKey === "climb" || rawSkillKey === "run") encumbPen = 2;
                if (rawSkillKey === "endurance" || rawSkillKey === "athletics") encumbDiff = 4;
            }
        } 
        
        if ((armorWeight === "medium" || hasShield) && isMediumPenalty) {
            encumbDiff = Math.max(encumbDiff, 3);
        }

        // Active Effect Override: Immunity to Fatigue & Armor Penalties
        // ISSUE-015 FIX: ignoreFatiguePenalties must clear ALL encumbrance impossible checks
        // consistently — previously it cleared heavy-armor+Stealth but not Tower Shield+Stealth
        // or Tower Shield+Climb, making the flag behave differently depending on equipment type.
        // RAW basis: this flag is intended for supernatural beings that ignore physical encumbrance
        // entirely (e.g. spirits, golems). Apply uniformly or not at all.
        if (systemFlags.ignoreFatiguePenalties) {
            encumbPen = 0;
            encumbDiff = 0;
            encumbImpossible = false; // Clears ALL impossible checks: heavy+Stealth, Tower+Stealth, Tower+Climb
        }

        if (encumbImpossible) return ui.notifications.error(`This action is impossible while ${hasTower ? "carrying a Tower Shield" : "wearing Heavy Armor"}. It auto-fails.`);

        // Aggregate Global & Skill-Specific Pool Modifiers
        const aePoolMod = (modifiers.globalPool || 0) + (skillMods.pool || 0);
        let effectBonus = aePoolMod > 0 ? aePoolMod : 0;
        let effectPenalty = aePoolMod < 0 ? Math.abs(aePoolMod) : 0;

        let autoPenalty = effectPenalty; 
        let finalDifficulty = 0;
        let penaltyNames = [];

        if (isDazed) penaltyNames.push("DAZED");

        if (isProne && isCombatRoll) {
            autoPenalty += 1;
            penaltyNames.push("PRONE (−1d)");
        }

        if (isBlind && isCombatRoll) {
            let isRanged = false;
            if (itemRef?.type === "weapon" && itemRef.system.range && !["touch", "melee", "close", ""].includes(itemRef.system.range.toLowerCase().trim())) isRanged = true;
            else if (rawSkillKey === "athletics" && isAttackRoll) isRanged = true;
            else if (["shoot", "bow", "archery", "firearms"].some(s => rawSkillKey.includes(s))) isRanged = true;

            if (isRanged) {
                autoPenalty += 2;
                penaltyNames.push("BLIND Ranged (−2d)");
            } else {
                finalDifficulty = Math.max(finalDifficulty, 4);
                penaltyNames.push("BLIND Melee (Diff 4)");
            }
        }

        if (effectPenalty > 0 && !isDazed) penaltyNames.push(`Effects (−${effectPenalty}d)`);
        else if (effectPenalty > 1 && isDazed) penaltyNames.push(`Effects (−${effectPenalty}d)`);

        if ((isHeavyPenalty || isMediumPenalty) && (encumbPen > 0 || encumbDiff > 0)) {
            autoPenalty += encumbPen; 
            finalDifficulty = Math.max(finalDifficulty, encumbDiff);
            
            let reason = "Armor";
            if (hasShield && encumbPen === 0) reason = "Shield Defense";
            else if (hasShield) reason = "Armor & Shield";
            
            penaltyNames.push(`${reason} (−${encumbPen}d, Diff ${encumbDiff})`);
        }

        let penaltyTitle = penaltyNames.join(" & ");

        let shieldBonus = 0;
        let shieldName = "";
        if (rawSkillKey === "parry" && hasShield) {
            const bestShield = equippedShields.reduce((prev, current) => {
                return (parseInt(prev.system.parryBonus) || 0) > (parseInt(current.system.parryBonus) || 0) ? prev : current;
            });
            shieldBonus = parseInt(bestShield.system.parryBonus) || 0;
            shieldName = bestShield.name;
        }

        let autoBonus = shieldBonus + effectBonus;

        // PACKAGE C Item 6: Read accumulated aim bonus from actor flags
        const aimBonus = (isAttackRoll && actor.getFlag("wild-talents-2e", "aimBonus")) || 0;
        if (aimBonus > 0) autoBonus += aimBonus;

        const aquaticSkills = ["athletics", "dodge", "endurance", "vigor", "stealth"];
        const showEnvContext = isCombatRoll || aquaticSkills.includes(rawSkillKey);

        // WT: No Expert Dice (ED) or Master Dice (MD) — HD and WD serve those roles.
        let initialEdValue = 0;
        let initialMdValue = 0;

        let dialogTitle = `Roll ${label || "Action"}`;
        if (shieldBonus > 0) dialogTitle += ` (+${shieldBonus}d ${shieldName} Bonus)`;

        const attrOptions = { "none": "None", "body": "Body", "coordination": "Coordination", "sense": "Sense", "mind": "Mind", "command": "Command", "charm": "Charm" };
        
        // WT: Skills are freeform in system.skills with attribute binding.
        let skillOptions = { "none": "None" };
        if (showSkillSelect) {
            Object.keys(system.skills || {}).sort().forEach(sk => {
                const skData = system.skills[sk];
                const label = skData?.label || sk;
                skillOptions[sk] = label.toUpperCase();
            });
        }

        const calledShotOptions = { "0": "None", "10": "Head (10)", "9": "Torso High (9)", "8": "Torso Mid (8)", "7": "Torso Low (7)", "6": "Right Arm High (6)", "5": "Right Arm Low (5)", "4": "Left Arm High (4)", "3": "Left Arm Low (3)", "2": "Right Leg (2)", "1": "Left Leg (1)" };

        const isDodgeRoll = isDefenseRoll && rawSkillKey === "dodge";

        const dodgeManeuverOptions = isDodgeRoll
            ? Object.values(MANEUVERS).filter(m => m.poolType === "dodge")
            : null;

        // F3: Eerie detection context — passed from the "Roll Sense + Eerie" button
        const isEerieDetection      = !!dataset.eerieDetection;
        const eerieDetectionRadius  = dataset.eerieDetectionRadius || "";
        const eerieSpellName        = dataset.eerieSpellName || "a spell";

        // ISSUE-028 FIX: Auto-detect swimming from actor status so players don't have to
        // remember to set the environment context manually every roll while in water.
        const isSubmerged = actor.statuses.has("submerged") || actor.statuses.has("swimming") || actor.statuses.has("underwater");
        const defaultEnvContext = (showEnvContext && isSubmerged) ? "swimming" : "none";

        // BATCH A ITEM-12: Passion text — shown alongside toggle labels so players
        // can make an informed decision without needing to remember their biography.
        const passionMission = system.biography?.mission?.trim() || "";
        const passionDuty    = system.biography?.duty?.trim()    || "";
        const passionCraving = system.biography?.craving?.trim() || "";

        // 📖 WT Rulebook Ch3 p.52: "Inspiration" — WP > 0 enables the option
        const wpCurrent = parseInt(system.willpower?.current) || 0;

        const templateData = {
            defaultAttr, attrOptions, showSkillSelect, defaultSkill, skillOptions, isCombatRoll, calledShotOptions,
            difficulty: finalDifficulty, showEnvContext, autoBonus, autoPenalty, penaltyTitle, initialEdValue, initialMdValue,
            maneuverOptions: isCombatRoll ? getManeuverOptions() : null,
            isDodgeRoll,
            dodgeManeuverOptions,
            isEerieDetection,
            eerieDetectionRadius,
            eerieSpellName,
            defaultEnvContext,
            passionMission,
            passionDuty,
            passionCraving,
            canInspire: wpCurrent > 0,
            currentWP: wpCurrent
        };

        if (DEBUG_ROLLS) console.log("WT Roller | Rendering HTML Template...");
        const content = await renderTemplate("systems/wild-talents-2e/templates/dialogs/roll-character.hbs", templateData);
        if (DEBUG_ROLLS) console.log("WT Roller | Template rendered safely. Opening DialogV2...");

        const rollData = await wtDialog(
          dialogTitle,
          content,
          (e, b, d) => {
            const f = d.element.querySelector("form"); 
            return { 
              attr: f.querySelector('[name="attr"]')?.value || "none", skillKey: f.querySelector('[name="skillKey"]')?.value || "none",
              envContext: f.querySelector('[name="envContext"]')?.value || "none",
              calledShot: parseInt(f.querySelector('[name="calledShot"]')?.value) || 0, difficulty: parseInt(f.querySelector('[name="difficulty"]')?.value) || 0,
              multiActions: Math.max(parseInt(f.querySelector('[name="multiActions"]')?.value) || 1, 1),
              bonus: parseInt(f.querySelector('[name="bonus"]')?.value) || 0, penalty: parseInt(f.querySelector('[name="penalty"]')?.value) || 0, 
              maneuver: f.querySelector('[name="maneuver"]')?.value || "none",
              // 📖 WT Ch3 p.52: Inspiration — +1 bonus die for 1 WP
              inspiration: !!f.querySelector('[name="inspiration"]')?.checked,
              // 📖 WT Ch1 p.25: Special Maneuvers (each −1d)
              expertAction: !!f.querySelector('[name="expertAction"]')?.checked,
              determinedAction: !!f.querySelector('[name="determinedAction"]')?.checked,
              fastAction: !!f.querySelector('[name="fastAction"]')?.checked
            }; 
          },
          {
            defaultLabel: "Roll ORE",
            render: (event, html) => {
              let element = event?.target?.element ?? (event instanceof HTMLElement ? event : (event[0] || null));
              if (!element) return;
     
              const f = element.querySelector("form");
              const poolPreviewSpan = element.querySelector("#pool-value");
              const multiInput = f.querySelector('[name="multiActions"]');
              
              if (multiInput && !ignoreMultiPenalty) {
                  multiInput.title = "RAW: Taking multiple actions automatically drops 1 die from your pool per extra action. The roller handles this math automatically!";
                  const multiLabel = multiInput.previousElementSibling;
                  if (multiLabel) multiLabel.innerHTML += ' <i class="fas fa-info-circle wt-text-muted wt-cursor-help" title="RAW: -1d penalty per extra action. The roller calculates this automatically."></i>';
              } else if (multiInput && ignoreMultiPenalty) {
                  multiInput.title = "Active Effect: You are immune to multiple action penalties for this skill!";
                  const multiLabel = multiInput.previousElementSibling;
                  if (multiLabel) multiLabel.innerHTML += ' <i class="fas fa-shield-alt wt-text-success" title="Immune to multi-action penalties!"></i>';
              }

              // WT: No ED/MD conversion or passion input setup needed.
              
              if (!f) return;
     
              const updatePool = () => {
                const attrKey = f.querySelector('[name="attr"]')?.value || "none";
                const skillKey = f.querySelector('[name="skillKey"]')?.value || "none";
                const envContext = f.querySelector('[name="envContext"]')?.value || "none";
                const calledShot = parseInt(f.querySelector('[name="calledShot"]')?.value) || 0;
                const multiActions = Math.max(parseInt(f.querySelector('[name="multiActions"]')?.value) || 1, 1);
                const bonus = parseInt(f.querySelector('[name="bonus"]')?.value) || 0;
                let penalty = parseInt(f.querySelector('[name="penalty"]')?.value) || 0;
     
                if (envContext === "swimming") {
                    if (armorWeight === "heavy") {
                        if (systemFlags.ignoreHeavyArmorSwim) {
                            // ignoreHeavyArmorSwim AE: allows swimming in Heavy Armor at mandatory −4d.
                            // RAW use case: Whale Blessed Advantage (Ch4). Also valid for GMs to apply
                            // for special circumstances (creatures, effects, etc.).
                            penalty += 4;
                        } else {
                            // RAW Ch6 p.113: no chance of success without ignoreHeavyArmorSwim.
                            poolPreviewSpan.innerHTML = `<span class="wt-text-danger">Impossible (Heavy Armor — no exception Active Effect)</span>`;
                            return;
                        }
                    } else if (armorWeight === "medium") {
                        penalty += 2;
                    }
                }
     
                let attrVal = attrKey !== "none" ? (parseInt(system.attributes[attrKey]?.normal) || 0) : 0;
                // WT: Also extract HD/WD from the selected attribute and skill
                const previewAttr = attrKey !== "none" ? (system.attributes[attrKey] || {}) : {};
                const previewAttrN = parseInt(previewAttr.normal) || 0;
                const previewAttrH = parseInt(previewAttr.hard) || 0;
                const previewAttrW = parseInt(previewAttr.wiggle) || 0;

                let previewSkillN = 0, previewSkillH = 0, previewSkillW = 0;
                let previewSkillKeyForHyper = null;
                if (type === "skill") {
                    // Direct skill roll — always include the skill's dice
                    const skData = system.skills?.[key] || {};
                    previewSkillN = parseInt(skData.value) || parseInt(skData.normal) || 0;
                    previewSkillH = parseInt(skData.hard) || 0;
                    previewSkillW = parseInt(skData.wiggle) || 0;
                    previewSkillKeyForHyper = key;
                } else if (showSkillSelect && skillKey !== "none") {
                    const skData = system.skills?.[skillKey] || {};
                    previewSkillN = parseInt(skData.value) || parseInt(skData.normal) || 0;
                    previewSkillH = parseInt(skData.hard) || 0;
                    previewSkillW = parseInt(skData.wiggle) || 0;
                    previewSkillKeyForHyper = skillKey;
                }

                // ── Passive Hyperstat / Hyperskill Preview (Sprint 2.2.3 fix) ──
                // Mirror the same passive-hyper scan used in the final assembly
                // so the dialog preview matches the rolled pool.
                //   📖 WT Rulebook Ch6 p.104 — Hyperstat adds dice to the Stat
                //   📖 WT Rulebook Ch6 p.105 — Hyperskill adds dice to the Skill
                // Reads the LIVE attrKey/skillKey from the dialog so the preview
                // updates if the user changes the attribute dropdown.
                let previewPassiveN = 0, previewPassiveH = 0, previewPassiveW = 0;
                const previewActivePowerId = (isPowerRoll && powerItem) ? powerItem.id : null;
                const previewStatKey = (attrKey && attrKey !== "none") ? attrKey : null;
                for (const it of actor.items) {
                    if (it.type !== "power") continue;
                    if (it.id === previewActivePowerId) continue;
                    const ps = it.system || {};
                    const pd = ps.dice || {};
                    const pN = parseInt(pd.normal) || 0;
                    const pH = parseInt(pd.hard)   || 0;
                    const pW = parseInt(pd.wiggle) || 0;
                    if (pN + pH + pW === 0) continue;

                    if (ps.powerType === "hyperstat" && ps.linkedStat && previewStatKey) {
                        const lk = String(ps.linkedStat).trim().toLowerCase();
                        if (lk === previewStatKey) {
                            previewPassiveN += pN; previewPassiveH += pH; previewPassiveW += pW;
                        }
                    } else if (ps.powerType === "hyperskill" && ps.linkedSkill && previewSkillKeyForHyper) {
                        const linkedRaw = String(ps.linkedSkill).trim();
                        const linkedLower = linkedRaw.toLowerCase();
                        let skillKeyMatch = null;
                        if (system.skills?.[linkedRaw]) skillKeyMatch = linkedRaw;
                        if (!skillKeyMatch) {
                            skillKeyMatch = Object.keys(system.skills || {}).find(k => k.toLowerCase() === linkedLower) || null;
                        }
                        if (!skillKeyMatch) {
                            skillKeyMatch = Object.keys(system.skills || {}).find(k =>
                                (system.skills[k].label || "").toLowerCase() === linkedLower
                            ) || null;
                        }
                        if (skillKeyMatch && skillKeyMatch === previewSkillKeyForHyper) {
                            previewPassiveN += pN; previewPassiveH += pH; previewPassiveW += pW;
                        }
                    }
                }

                const pTotalN = previewAttrN + previewSkillN + previewPassiveN + bonus;
                const pTotalH = previewAttrH + previewSkillH + previewPassiveH;
                const pTotalW = previewAttrW + previewSkillW + previewPassiveW;

                const poolMath = calculateWTPool(pTotalN, pTotalH, pTotalW, calledShot, penalty, multiActions, ignoreMultiPenalty);
                
                if (poolMath.totalPool < 1) {
                    poolPreviewSpan.innerHTML = `<span class="wt-text-danger">Action Fails (Pool &lt; 1)</span>`;
                } else {
                    let displayStr = `${poolMath.normalDiceCount}d10`;
                    if (poolMath.hardCount > 0) displayStr += ` <span class="wt-text-hard">+${poolMath.hardCount}hd</span>`;
                    if (poolMath.wiggleDiceCount > 0) displayStr += ` <span class="wt-text-wiggle">+${poolMath.wiggleDiceCount}wd</span>`;
                    if (poolMath.wasCapped) displayStr += ` <span class="wt-text-small wt-text-muted">(Capped at 10)</span>`;
                    poolPreviewSpan.innerHTML = displayStr;
                }
              };
     
              const enforceExclusivity = () => {
                updatePool();
              };

              // Ch7 MANEUVER WIRING: When the maneuver dropdown changes,
              // auto-apply pool modifications from the maneuver definition.
              const maneuverSelect = f.querySelector('[name="maneuver"]');
              const calledShotSelect = f.querySelector('[name="calledShot"]');
              const difficultyInput = f.querySelector('[name="difficulty"]');
              const penaltyInput = f.querySelector('[name="penalty"]');
              const multiActionsInput = f.querySelector('[name="multiActions"]');
              const bonusInput = f.querySelector('[name="bonus"]');

              if (maneuverSelect) {
                  // Store the user's original values so we can restore them when switching back to "none"
                  let userCalledShot = calledShotSelect?.value || "0";
                  let userDifficulty = difficultyInput?.value || "0";
                  let userPenalty = penaltyInput?.value || String(autoPenalty);
                  let userMultiActions = multiActionsInput?.value || "1";
                  let userBonus = bonusInput?.value || String(autoBonus);
                  let lastManeuver = "none";

                  // D+: Submission Hold — restrict calledShot dropdown to limb locations only.
                  // Heights 1–6 are arms and legs; 7–10 are torso and head (invalid for a joint lock).
                  const LIMB_HEIGHTS = new Set(["0", "1", "2", "3", "4", "5", "6"]);

                  function restrictCalledShotToLimbs(select) {
                      if (!select) return;
                      for (const opt of select.options) {
                          if (!LIMB_HEIGHTS.has(opt.value)) {
                              opt.disabled = true;
                              opt.style.display = "none";
                          }
                      }
                      // If current selection is head/torso, default to Right Arm High
                      if (!LIMB_HEIGHTS.has(select.value)) select.value = "6";
                      // Add a visual hint on the select itself
                      select.title = "Submission Hold requires a limb (arm or leg)";
                  }

                  function unrestrictCalledShot(select) {
                      if (!select) return;
                      for (const opt of select.options) {
                          opt.disabled = false;
                          opt.style.display = "";
                      }
                      select.title = "";
                  }

                  maneuverSelect.addEventListener("change", () => {
                      const mId = maneuverSelect.value;

                      // Restore user values when leaving a maneuver
                      if (lastManeuver !== "none") {
                          if (calledShotSelect) calledShotSelect.value = userCalledShot;
                          if (difficultyInput) difficultyInput.value = userDifficulty;
                          if (penaltyInput) penaltyInput.value = userPenalty;
                          if (multiActionsInput) multiActionsInput.value = userMultiActions;
                          if (bonusInput) bonusInput.value = userBonus;
                          // D+: Remove limb restriction if we're leaving Submission Hold
                          if (lastManeuver === "submissionHold") unrestrictCalledShot(calledShotSelect);
                      }

                      if (mId === "none") {
                          lastManeuver = "none";
                          // BATCH A ITEM-7: Clear the preview panel when no maneuver is selected
                          const previewEl = element.querySelector("#maneuver-preview");
                          if (previewEl) { previewEl.style.display = "none"; previewEl.innerHTML = ""; }
                          updatePool();
                          return;
                      }

                      // Snapshot the current user values before we overwrite
                      if (lastManeuver === "none") {
                          userCalledShot = calledShotSelect?.value || "0";
                          userDifficulty = difficultyInput?.value || "0";
                          userPenalty = penaltyInput?.value || String(autoPenalty);
                          userMultiActions = multiActionsInput?.value || "1";
                          userBonus = bonusInput?.value || String(autoBonus);
                      }

                      const mDef = MANEUVERS[mId];
                      if (!mDef) { lastManeuver = mId; updatePool(); return; }

                      // Auto-set called shot
                      if (mDef.calledShot && calledShotSelect) {
                          if (mDef.calledShot === "head") calledShotSelect.value = "10";
                          else if (mDef.calledShot === "arm") calledShotSelect.value = "6"; // Default right arm high
                          else if (mDef.calledShot === "leg") calledShotSelect.value = "2"; // Default right leg
                      }

                      // D+: Submission Hold — restrict called shot to limb locations (arms/legs only)
                      if (mId === "submissionHold") {
                          restrictCalledShotToLimbs(calledShotSelect);
                      }

                      // Auto-set difficulty
                      if (mDef.difficulty > 0 && difficultyInput) {
                          difficultyInput.value = String(Math.max(parseInt(difficultyInput.value) || 0, mDef.difficulty));
                      }

                      // Auto-set penalty (additive with existing)
                      if (mDef.poolPenalty < 0 && penaltyInput) {
                          const currentBase = parseInt(userPenalty) || 0;
                          penaltyInput.value = String(currentBase + Math.abs(mDef.poolPenalty));
                      }

                      // Trip special: no called-shot penalty even though it has a called shot
                      // Iron Kiss special: -2d is its own penalty (already in poolPenalty), no standard CS penalty
                      // These are handled by calledShotPenalty: false in the definition.
                      // The pool math already handles the -1d for called shots; we need to OFFSET it
                      // for maneuvers where calledShotPenalty is false but a called shot is set.
                      if (mDef.calledShot && !mDef.calledShotPenalty && bonusInput) {
                          // Add +1d to bonus to cancel out the automatic called-shot penalty
                          const currentBonus = parseInt(bonusInput.value) || 0;
                          bonusInput.value = String(currentBonus + 1);
                      }

                      // Auto-set multiple actions if the maneuver requires it
                      if (mDef.isMultiAction && multiActionsInput) {
                          const current = parseInt(multiActionsInput.value) || 1;
                          if (current < 2) multiActionsInput.value = "2";
                      }

                      lastManeuver = mId;

                      // BATCH A ITEM-7: Populate the live rules preview panel.
                      // All data comes from the MANEUVERS definition — no extra fetch needed.
                      const previewEl = element.querySelector("#maneuver-preview");
                      if (previewEl && mDef) {
                          const catMap = { simple: "Simple Maneuver", advanced: "Advanced Combat", expert: "Expert" };
                          const catLabel = catMap[mDef.category] || mDef.category;
                          const penParts = [];
                          if (mDef.poolPenalty < 0) penParts.push(`${mDef.poolPenalty}d`);
                          if (mDef.difficulty > 0)  penParts.push(`Difficulty ${mDef.difficulty}`);
                          if (mDef.firstRoundOnly)  penParts.push("First round only");
                          if (mDef.isMultiAction)   penParts.push("Requires 2 actions");
                          const metaStr = penParts.length ? penParts.join(" · ") : "No modifiers";
                          const rulesStr = mDef.rulesText ? game.i18n.localize(mDef.rulesText) : "";
                          previewEl.innerHTML = `
                              <div class="wt-maneuver-preview-header">
                                  <span class="wt-maneuver-preview-cat">${catLabel}</span>
                                  <span class="wt-maneuver-preview-meta">${metaStr}</span>
                              </div>
                              ${rulesStr ? `<p class="wt-maneuver-preview-rules">${rulesStr}</p>` : ""}
                          `;
                          previewEl.style.display = "";
                      }

                      updatePool();
                  });
              }
     
              // WT: No edInput/mdInput event wiring — HD/WD come from character data.

              f.querySelectorAll("input, select").forEach(input => {
                  input.addEventListener("input", updatePool);
                  input.addEventListener("change", updatePool);
              });

              // ITEM-8a: If the declaration dialog passed a preMultiActions hint, pre-set
              // the Multi-Actions counter so the player doesn't have to enter it manually.
              // This is a default only — the player can still adjust it before rolling.
              if (dataset.preMultiActions && multiInput && !ignoreMultiPenalty) {
                  const pre = parseInt(dataset.preMultiActions);
                  if (pre > 1) multiInput.value = pre;
              }

              enforceExclusivity();

              // BATCH C ITEM-11: Pre-fill dialog fields from a stored lastRollContext.
              // Called by the ↺ re-roll handler and the Pin escape button.
              const prefill = options?.prefillContext;
              if (prefill) {
                  const setField = (name, value) => {
                      if (value === undefined || value === null) return;
                      const el = f.querySelector(`[name="${name}"]`);
                      if (el) el.value = value;
                  };
                  setField("bonus",        prefill.bonus);
                  setField("penalty",      prefill.penalty);
                  setField("totalActions", prefill.multiActions);
                  setField("calledShot",   prefill.calledShot);
                  setField("difficulty",   prefill.difficulty);
                  // Maneuver: set value then fire change so the preview and pool update
                  if (prefill.maneuver && prefill.maneuver !== "none") {
                      const mSel = f.querySelector('[name="maneuver"]');
                      if (mSel) {
                          mSel.value = prefill.maneuver;
                          mSel.dispatchEvent(new Event("change"));
                      }
                  }
                  updatePool();
              }

              // BATCH A ITEM-12: Wire passion toggle buttons.
              // Each group has three buttons (Against / Neutral / Aligned) backed by a hidden input.
              // Clicking a button updates the hidden input and recalculates the pool preview.
              element.querySelectorAll(".wt-passion-toggles").forEach(group => {
                  const passionName = group.dataset.passion;
                  const hiddenInput = f.querySelector(`[name="${passionName}"]`);
                  const btns = group.querySelectorAll(".wt-passion-btn");

                  btns.forEach(btn => {
                      btn.addEventListener("click", () => {
                          btns.forEach(b => b.classList.remove("active"));
                          btn.classList.add("active");
                          if (hiddenInput) {
                              hiddenInput.value = btn.dataset.value;
                              updatePool();
                          }
                      });
                  });
              }); 
            }
          }
        );
        
        if (!rollData) return;

        if (DEBUG_ROLLS) console.log("WT Roller | Dialog Submitted.", rollData);

        if (type === "item" && itemRef?.type === "spell" && rollData.multiActions > 1) {
            const rawIgnoreSpell = actionEconomy.ignoreMultiPenaltySkills;
            const ignoreSpellStr = Array.isArray(rawIgnoreSpell)
                ? rawIgnoreSpell.join(",")
                : String(rawIgnoreSpell || "");
            const ignoreSpellList = ignoreSpellStr.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
            const isSpellImmune = ignoreSpellList.includes("sorcery");
            if (!isSpellImmune) {
                ui.notifications.warn("Sorcery requires full concentration and cannot be part of a multiple action. Reverting to 1 action.");
                rollData.multiActions = 1;
            }
        }

        if (rollData.envContext === "swimming") {
            if (armorWeight === "heavy") {
                if (systemFlags.ignoreHeavyArmorSwim) {
                    // ignoreHeavyArmorSwim AE: mandatory −4d; the auto-fail is lifted but the
                    // penalty cannot be reduced. RAW example: Whale Blessed Advantage (Ch4).
                    rollData.penalty += 4;
                    ui.notifications.warn("Swimming in Heavy Armor: mandatory −4d penalty applies.");
                } else {
                    // RAW Ch6 p.113: impossible without the ignoreHeavyArmorSwim Active Effect.
                    return ui.notifications.error("Swimming in Heavy Armor is impossible. Apply the 'Can Swim in Heavy Armor' Active Effect to allow it.");
                }
            } else if (armorWeight === "medium") {
                rollData.penalty += 2;
                ui.notifications.warn("Swimming in Medium Armor applies a −2d penalty.");
            }
        }
        
        let finalAttrVal = rollData.attr !== "none" ? (parseInt(system.attributes[rollData.attr]?.normal) || 0) : 0;
        let finalItemSkillValue = 0;
        if (showSkillSelect && rollData.skillKey !== "none") {
            finalItemSkillValue = parseInt(system.skills[rollData.skillKey]?.value) || 0;
        }

        // C1: Shove Bonus — +1d on Trip or Slam against the token that was shoved this round.
        // Must check after rollData is available (maneuver selected in dialog).
        let shoveBonus = 0;
        if (isAttackRoll && (rollData.maneuver === "trip" || rollData.maneuver === "slam") && game.combat) {
          const myCombatant = game.combat.combatants.find(c => c.actorId === actor.id);
          const shoveBonusAgainst = myCombatant?.getFlag("wild-talents-2e", "shoveBonusAgainst");
          if (shoveBonusAgainst && [...game.user.targets].some(t => t.id === shoveBonusAgainst)) {
            shoveBonus = 1;
          }
        }

        // ── WT Pool Assembly: Sum Normal/Hard/Wiggle from stat + skill + power ──
        const resolvedAttr = rollData.attr !== "none" ? rollData.attr : null;
        const attrData = resolvedAttr ? (system.attributes[resolvedAttr] || {}) : {};

        // Resolve skill dice
        let skillData = {};
        if (type === "skill") {
            // Direct skill roll — use the original key from the dataset
            skillData = system.skills?.[key] || {};
        } else if (type === "power" && defaultSkill !== "none") {
            // Hyperskill roll — use the linked skill
            skillData = system.skills?.[defaultSkill] || {};
        } else if (showSkillSelect && rollData.skillKey !== "none") {
            // Item roll — use the skill selected in the dialog dropdown
            skillData = system.skills?.[rollData.skillKey] || {};
        }

        // 📖 WT Rulebook Ch3 p.52: "Zero Base Will Points: you can't use your
        //     Charm or Command Stats at all. You may still use Charm or Command
        //     Skills, but roll only the Skill dice, not Stat dice."
        const isZeroBW = !!system.zeroBaseWill;
        const isBlockedStat = isZeroBW && (resolvedAttr === "charm" || resolvedAttr === "command");

        // For direct skill/attribute rolls (non-item), use the pre-resolved baseValue as normal dice
        let attrNormal = parseInt(attrData.normal) || 0;
        let attrHard   = parseInt(attrData.hard) || 0;
        let attrWiggle = parseInt(attrData.wiggle) || 0;

        if (isBlockedStat) {
            attrNormal = 0;
            attrHard = 0;
            attrWiggle = 0;
            ui.notifications.warn(`Zero Base Will: ${resolvedAttr.charAt(0).toUpperCase() + resolvedAttr.slice(1)} stat dice removed. Skill dice only.`);
        }

        const skillNormal = parseInt(skillData.value) || parseInt(skillData.normal) || 0;
        const skillHard   = parseInt(skillData.hard) || 0;
        const skillWiggle = parseInt(skillData.wiggle) || 0;

        // ── Power Dice Addition ──
        let powerNormal = 0, powerHard = 0, powerWiggle = 0;
        if (isPowerRoll && powerItem) {
            const pd = powerItem.system.dice || {};
            if (powerDiceOverride) {
                // Miracle: standalone pool — override stat+skill entirely
                powerNormal = powerDiceOverride.normal;
                powerHard = powerDiceOverride.hard;
                powerWiggle = powerDiceOverride.wiggle;
            } else {
                // Hyperstat/Hyperskill: add power dice on top of stat+skill
                powerNormal = parseInt(pd.normal) || 0;
                powerHard = parseInt(pd.hard) || 0;
                powerWiggle = parseInt(pd.wiggle) || 0;
            }
        }

        // ── Passive Hyperstat / Hyperskill Dice (Sprint 2.2.2 fix) ──────
        // 📖 WT Rulebook Ch6 p.104: Hyperstat "simply adds dice to the Stat"
        // 📖 WT Rulebook Ch6 p.105: Hyperskill "adds dice to the Skill"
        // When the player rolls a stat or skill DIRECTLY (not by activating
        // the power), any linked Hyperstats or Hyperskills on the actor must
        // still contribute their dice. This block scans the actor's items
        // and folds in the bonus passively, in addition to whatever the
        // active powerItem (if any) contributes.
        //
        // We do NOT add passive dice when the active roll IS a Hyperstat or
        // Hyperskill power roll — that would double-count, because the
        // powerNormal/Hard/Wiggle above already includes that exact power's
        // dice. We DO scan for OTHER hyperpowers on the same stat/skill so
        // a character with two Hyperstats both on Body gets both bonuses
        // when rolling Body (rulebook does not forbid stacking).
        let passiveNormal = 0, passiveHard = 0, passiveWiggle = 0;
        const passiveSources = []; // names for the chat-card breakdown

        // What stat / skill is this roll using?
        // resolvedAttr is the lowercase stat key (or null for stat-less rolls).
        // For type="skill", `key` is the skill key. For type="power" Hyperskill,
        // defaultSkill is the skill key. For weapon rolls the skill is
        // resolved into defaultSkill / rollData.skillKey earlier.
        const rolledStatKey = resolvedAttr || null;
        let rolledSkillKey = null;
        if (type === "skill") rolledSkillKey = key;
        else if (type === "power" && defaultSkill !== "none") rolledSkillKey = defaultSkill;
        else if (showSkillSelect && rollData.skillKey && rollData.skillKey !== "none") rolledSkillKey = rollData.skillKey;

        // The id of the *active* power being rolled (if any) — used to skip
        // double-counting when the player rolls FROM a hyperpower directly.
        const activePowerId = (isPowerRoll && powerItem) ? powerItem.id : null;

        for (const it of actor.items) {
            if (it.type !== "power") continue;
            if (it.id === activePowerId) continue; // avoid double-count
            const ps = it.system || {};
            const pd = ps.dice || {};
            const pN = parseInt(pd.normal) || 0;
            const pH = parseInt(pd.hard)   || 0;
            const pW = parseInt(pd.wiggle) || 0;
            if (pN + pH + pW === 0) continue;

            if (ps.powerType === "hyperstat" && ps.linkedStat && rolledStatKey) {
                const lk = String(ps.linkedStat).trim().toLowerCase();
                if (lk === rolledStatKey) {
                    passiveNormal += pN; passiveHard += pH; passiveWiggle += pW;
                    passiveSources.push(`Hyperstat ${it.name}`);
                }
            } else if (ps.powerType === "hyperskill" && ps.linkedSkill && rolledSkillKey) {
                const linkedRaw = String(ps.linkedSkill).trim();
                const linkedLower = linkedRaw.toLowerCase();
                // Resolve by exact key, then case-insensitive key, then label
                let skillKeyMatch = null;
                if (system.skills?.[linkedRaw]) skillKeyMatch = linkedRaw;
                if (!skillKeyMatch) {
                    skillKeyMatch = Object.keys(system.skills || {}).find(k => k.toLowerCase() === linkedLower) || null;
                }
                if (!skillKeyMatch) {
                    skillKeyMatch = Object.keys(system.skills || {}).find(k =>
                        (system.skills[k].label || "").toLowerCase() === linkedLower
                    ) || null;
                }
                if (skillKeyMatch && skillKeyMatch === rolledSkillKey) {
                    passiveNormal += pN; passiveHard += pH; passiveWiggle += pW;
                    passiveSources.push(`Hyperskill ${it.name}`);
                }
            }
        }

        // Fold passive hyper-dice into the power dice variables so the
        // Zero-WP rule below applies to them too. (📖 Ch3 p.53 — Zero WP
        // turns HD/WD into Normal and halves pool. Hyperstat/Hyperskill
        // dice are power dice and are subject to this.)
        powerNormal += passiveNormal;
        powerHard   += passiveHard;
        powerWiggle += passiveWiggle;
        // Track that we have passive power dice so the Zero-WP block,
        // which currently gates on `isPowerRoll`, still triggers when
        // the active roll is a plain stat/skill but passive hyper-dice
        // are present.
        const hasPassivePowerDice = (passiveNormal + passiveHard + passiveWiggle) > 0;

        // 📖 WT Rulebook Ch3 p.53: "Zero Willpower Points: All Wiggle Dice and
        //     Hard Dice become regular dice and all dice pools are cut in half."
        // Applies to all power dice (Hyperstats, Hyperskills, Miracles) UNLESS
        // the power has Native Power Extra (📖 Ch8 p.127) or uses Inhuman Stats
        // (📖 Ch5 p.97). Those immunities are checked via Active Effect flags.
        const isZeroWP = !!system.zeroWillpower;
        const isNativePower = !!(powerItem?.system?.qualities || []).some(q =>
            (q.extras || []).some(e => e.name?.toLowerCase().includes("native"))
        );

        if (isZeroWP && (isPowerRoll || hasPassivePowerDice) && !isNativePower) {
            // Convert all HD and WD to Normal dice, then halve the total pool
            const totalBeforeHalving = (powerDiceOverride ? 0 : attrNormal + attrHard + attrWiggle + skillNormal + skillHard + skillWiggle)
                + powerNormal + powerHard + powerWiggle;

            // Convert HD/WD → Normal
            powerNormal += powerHard + powerWiggle;
            powerHard = 0;
            powerWiggle = 0;

            if (!powerDiceOverride) {
                // Also convert stat+skill HD/WD for Hyper rolls
                attrNormal += attrHard + attrWiggle;
                attrHard = 0;
                attrWiggle = 0;
                // Note: skillNormal is const, so we adjust via powerNormal
                powerNormal += skillHard + skillWiggle;
                // Zero out skill HD/WD — we'll skip them in totalHard/totalWiggle below
            }

            // Halve total pool (round down)
            const halvedTotal = Math.floor(totalBeforeHalving / 2);
            const currentTotal = powerDiceOverride
                ? powerNormal
                : attrNormal + skillNormal + powerNormal;
            const excessDice = currentTotal - halvedTotal;
            if (excessDice > 0) powerNormal = Math.max(0, powerNormal - excessDice);

            ui.notifications.warn("Zero Willpower: All power HD/WD become Normal dice. Pool halved.");
        }

        // Bonus dice add to Normal pool
        // 📖 WT Rulebook Ch3 p.52: Inspiration adds +1 bonus die for 1 WP
        const inspirationBonus = rollData.inspiration ? 1 : 0;
        const bonusDice = (rollData.bonus || 0) + shoveBonus + inspirationBonus;

        // 📖 WT Rulebook Ch1 p.25: Special Maneuvers — each costs −1d
        let specialManeuverPenalty = 0;
        if (rollData.expertAction) specialManeuverPenalty += 1;
        if (rollData.determinedAction) specialManeuverPenalty += 1;
        if (rollData.fastAction) specialManeuverPenalty += 1;
        const totalPenalty = (rollData.penalty || 0) + specialManeuverPenalty;

        // For the Zero-WP check on skill dice: only trigger when there's a power-dice
        // pathway active (either an explicit power roll OR passive hyper-dice were folded in).
        const zwpAffectsSkill = isZeroWP && (isPowerRoll || hasPassivePowerDice) && !isNativePower;
        const totalNormal = (powerDiceOverride ? powerNormal : attrNormal + skillNormal + powerNormal) + bonusDice;
        const totalHard   = (powerDiceOverride ? powerHard : attrHard + (zwpAffectsSkill ? 0 : skillHard) + powerHard);
        const totalWiggle = (powerDiceOverride ? powerWiggle : attrWiggle + (zwpAffectsSkill ? 0 : skillWiggle) + powerWiggle);

        const poolMath = calculateWTPool(
            totalNormal, totalHard, totalWiggle,
            rollData.calledShot || 0,
            totalPenalty,
            rollData.multiActions || 1,
            ignoreMultiPenalty
        );

        if (poolMath.totalPool < 1) return ui.notifications.warn("Penalties reduced your dice pool below 1. Action fails.");

        if (poolMath.calledShotFree && rollData.calledShot > 0) {
            ui.notifications.info("Called shot is automatic with Hard or Wiggle Dice — no penalty applied.");
        }

        let poolBreakdown = [];
        if (!powerDiceOverride && (attrNormal + attrHard + attrWiggle > 0)) {
            let attrLabel = `${(resolvedAttr || "").toUpperCase()} (${attrNormal}`;
            if (attrHard > 0) attrLabel += `+${attrHard}hd`;
            if (attrWiggle > 0) attrLabel += `+${attrWiggle}wd`;
            attrLabel += ")";
            poolBreakdown.push({ label: attrLabel, value: `+${attrNormal + attrHard + attrWiggle}`, isPenalty: false });
        }
        if (!powerDiceOverride && (skillNormal + skillHard + skillWiggle > 0)) {
            let skLabel = `Skill (${skillNormal}`;
            if (skillHard > 0) skLabel += `+${skillHard}hd`;
            if (skillWiggle > 0) skLabel += `+${skillWiggle}wd`;
            skLabel += ")";
            poolBreakdown.push({ label: skLabel, value: `+${skillNormal + skillHard + skillWiggle}`, isPenalty: false });
        }
        if (isPowerRoll && powerItem) {
            const pn = powerDiceOverride ? powerNormal : (powerItem.system.dice?.normal || 0);
            const ph = powerDiceOverride ? powerHard : (powerItem.system.dice?.hard || 0);
            const pw = powerDiceOverride ? powerWiggle : (powerItem.system.dice?.wiggle || 0);
            let pwrLabel = `${foundry.utils.escapeHTML(powerItem.name)} (${pn}`;
            if (ph > 0) pwrLabel += `+${ph}hd`;
            if (pw > 0) pwrLabel += `+${pw}wd`;
            pwrLabel += ")";
            poolBreakdown.push({ label: pwrLabel, value: `+${pn + ph + pw}`, isPenalty: false });
        }
        // Passive Hyperstat / Hyperskill dice (Sprint 2.2.2 fix)
        // 📖 WT Rulebook Ch6 — bonus dice from a Hyperpower linked to the rolled stat/skill.
        if (hasPassivePowerDice) {
            const total = passiveNormal + passiveHard + passiveWiggle;
            let phLabel = passiveSources.length === 1
                ? foundry.utils.escapeHTML(passiveSources[0])
                : `${passiveSources.length}× Hyperpower`;
            phLabel += ` (${passiveNormal}`;
            if (passiveHard > 0)   phLabel += `+${passiveHard}hd`;
            if (passiveWiggle > 0) phLabel += `+${passiveWiggle}wd`;
            phLabel += ")";
            poolBreakdown.push({ label: phLabel, value: `+${total}`, isPenalty: false });
        }
        if (shieldBonus > 0) poolBreakdown.push({ label: `Shield (${shieldName})`, value: `+${shieldBonus}`, isPenalty: false });
        if (effectBonus > 0) poolBreakdown.push({ label: "Active Effects", value: `+${effectBonus}`, isPenalty: false });
        if (rollData.bonus > 0) poolBreakdown.push({ label: "Manual Bonus", value: `+${rollData.bonus}`, isPenalty: false });
        if (inspirationBonus > 0) poolBreakdown.push({ label: "Inspiration (1 WP)", value: "+1", isPenalty: false });
        if (aimBonus > 0) poolBreakdown.push({ label: `Aim Bonus (${aimBonus} rnd)`, value: `+${aimBonus}`, isPenalty: false });
        if (shoveBonus > 0) poolBreakdown.push({ label: "Shove Bonus", value: "+1", isPenalty: false });
        if (isBlockedStat) poolBreakdown.push({ label: `Zero Base Will (${resolvedAttr} blocked)`, value: "−stat", isPenalty: true });
        if (isZeroWP && (isPowerRoll || hasPassivePowerDice) && !isNativePower) poolBreakdown.push({ label: "Zero Willpower (powers halved)", value: "⚠", isPenalty: true });
        if (rollData.penalty > 0) poolBreakdown.push({ label: "Penalties", value: `-${rollData.penalty}`, isPenalty: true });
        if (rollData.expertAction) poolBreakdown.push({ label: "Expert Action", value: "-1", isPenalty: true });
        if (rollData.determinedAction) poolBreakdown.push({ label: "Determined Action", value: "-1", isPenalty: true });
        if (rollData.fastAction) poolBreakdown.push({ label: "Fast Action", value: "-1", isPenalty: true });
        if (rollData.multiActions > 1) {
            if (ignoreMultiPenalty) poolBreakdown.push({ label: "Multiple Actions (Ignored)", value: `-0`, isPenalty: false });
            else poolBreakdown.push({ label: "Multiple Actions", value: `-${rollData.multiActions - 1}`, isPenalty: true });
        }
        if (rollData.calledShot > 0 && !poolMath.calledShotFree) poolBreakdown.push({ label: "Called Shot", value: `-1`, isPenalty: true });

        // Package Advanced DataModel Catch-Basin Modifiers for the Chat Engine
        const advancedMods = {
            minHeight: skillMods.minHeight || 0,
            bonusWidth: skillMods.bonusWidth || 0,
            bonusTiming: skillMods.bonusTiming || 0,
            squishLimit: skillMods.squishLimit || 0,
            bonusDamageShock:   combatMods.bonusDamageShock   || 0,
            bonusDamageKilling: combatMods.bonusDamageKilling || 0,
            ignoreArmorTarget: combatMods.ignoreArmorTarget || 0,
            forceHitLocation: combatMods.forceHitLocation || 0,
            shiftHitLocationUp: combatMods.shiftHitLocationUp || 0,
            combineGobbleDice: combatMods.combineGobbleDice || false,
            crossBlockActive: combatMods.crossBlockActive || false,
            appendManeuvers: combatMods.appendManeuvers || [],
            // ISSUE-017 FIX: isMassive stored in server-side flags (not DOM data-attribute) so it
            // cannot be spoofed by a player editing HTML. Also re-validates Body ≥ 4 at roll time.
            isMassive: !!(type === "item" && itemRef?.type === "weapon" && itemRef.system.qualities?.massive && ((parseInt(system.attributes.body?.normal) || 0) + (parseInt(system.attributes.body?.hard) || 0) + (parseInt(system.attributes.body?.wiggle) || 0)) >= 4),
            maneuver: null
        };

        // Ch7: Serialize the selected maneuver definition for the chat engine
        if (rollData.maneuver && rollData.maneuver !== "none" && MANEUVERS[rollData.maneuver]) {
            const mDef = MANEUVERS[rollData.maneuver];
            advancedMods.maneuver = {
                id: mDef.id,
                label: mDef.label,
                category: mDef.category,
                tier: mDef.tier,
                requiresKill: mDef.requiresKill,
                noDamage: mDef.noDamage,
                firstRoundOnly: mDef.firstRoundOnly,
                widthTiers: mDef.widthTiers,
                rulesText: mDef.rulesText,
                // Snapshot attacker stats needed for Display Kill / Threaten morale math
                // WT: Sum N+HD+WD for total dice count
                attackerCommand: (parseInt(system.attributes?.command?.normal) || 0) + (parseInt(system.attributes?.command?.hard) || 0) + (parseInt(system.attributes?.command?.wiggle) || 0),
                attackerIntimidate: (parseInt(system.skills?.intimidation?.value) || 0) + (parseInt(system.skills?.intimidation?.hard) || 0) + (parseInt(system.skills?.intimidation?.wiggle) || 0),
                // BATCH C ITEM-2: Attacker Body and Fight for Pin escape difficulty.
                // RAW Ch7: escape difficulty = max(pinner's Body, pinner's Grapple/Fight)
                attackerBody: (parseInt(system.attributes?.body?.normal) || 0) + (parseInt(system.attributes?.body?.hard) || 0) + (parseInt(system.attributes?.body?.wiggle) || 0),
                attackerFight: (parseInt(system.skills?.brawling?.value) || 0) + (parseInt(system.skills?.brawling?.hard) || 0) + (parseInt(system.skills?.brawling?.wiggle) || 0)
            };

            // Add maneuver to pool breakdown for visibility
            const mLabel = game.i18n.localize(mDef.label);
            if (mDef.poolPenalty < 0) {
                poolBreakdown.push({ label: `Maneuver: ${mLabel}`, value: `${mDef.poolPenalty}`, isPenalty: true });
            } else {
                poolBreakdown.push({ label: `Maneuver: ${mLabel}`, value: `+0`, isPenalty: false });
            }
        }

        if (DEBUG_ROLLS) console.log("WT Roller | Evaluating Final Dice...");

        const finalizeCombatRoll = async (finalResults, finalPoolMath, rollInstance) => {
            // PACKAGE C Item 6: Consume aim bonus on attack (it's been used)
            if (isAttackRoll && aimBonus > 0) {
                await actor.unsetFlag("wild-talents-2e", "aimBonus");
                await actor.unsetFlag("wild-talents-2e", "aimedThisRound");
            }
            // C1: Consume shove bonus flag once it has been applied to a Trip or Slam roll
            if (isAttackRoll && shoveBonus > 0 && game.combat) {
                const myCombatant = game.combat.combatants.find(c => c.actorId === actor.id);
                if (myCombatant) await myCombatant.unsetFlag("wild-talents-2e", "shoveBonusAgainst");
            }

            // 📖 WT Rulebook Ch3 p.52: Spend Inspiration WP after rolling
            if (rollData.inspiration) {
                const { applyWillpowerChange } = await import("../combat/damage.js");
                await applyWillpowerChange(actor, -1, "Inspiration (+1 bonus die)", { silent: false });
            }

            // 📖 WT Rulebook Ch3 p.52: "Natural '10': If you roll a set of matching
            //     10s (Hard Dice and Wiggle Dice don't count!), you gain a point of
            //     Willpower."
            const hdCount = finalPoolMath?.hardCount || poolMath.hardCount || 0;
            const wdCount = finalPoolMath?.wiggleDiceCount || poolMath.wiggleDiceCount || 0;

            // Count natural 10s: total 10s minus HD count minus any WD set to 10
            const total10s = finalResults.filter(r => r === 10).length;
            const naturalOnly10s = total10s - hdCount;
            // If there are 2+ natural 10s (a set of matching 10s), award 1 WP.
            // WD assigned to 10 are NOT natural; subtract them too.
            // We can't perfectly distinguish which 10s are WD-assigned vs natural,
            // but we can be conservative: if total10s > hdCount + wdCount,
            // there must be natural 10s forming a set.
            const definiteNatural10s = Math.max(0, total10s - hdCount - wdCount);
            if (definiteNatural10s >= 2) {
                const { applyWillpowerChange } = await import("../combat/damage.js");
                await applyWillpowerChange(actor, 1, "Natural 10s!", { silent: false });
            }

            // 📖 WT Ch1 p.25: Expert Action — set one die to any face after rolling
            // (VTT adaptation: roll all dice, then let player choose which to lock)
            if (rollData.expertAction) {
                const sorted = [...finalResults].sort((a, b) => b - a);
                const currentDisplay = sorted.join(", ");
                const expertContent = `<form class="wt-dialog-form">
                  <p class="wt-text-large"><strong>Your Roll:</strong> ${currentDisplay}</p>
                  <p class="wt-text-small wt-text-muted">Expert Action: Set one die to any face value (1–10).</p>
                  <div class="form-group">
                    <label>Set die to:</label>
                    <input type="number" name="expertFace" value="10" min="1" max="10"/>
                  </div>
                </form>`;

                const expertFace = await wtDialog("Expert Action — Set Die Value", expertContent, (e, b, d) => {
                    const val = parseInt(d.element.querySelector('[name="expertFace"]').value) || 10;
                    return Math.max(1, Math.min(10, val));
                }, { defaultLabel: "Set Die" });

                if (expertFace) {
                    // Replace the first non-matching die (the worst die) with the chosen face
                    // Find the die least useful — lowest value not already matching something
                    const countMap = {};
                    finalResults.forEach(r => countMap[r] = (countMap[r] || 0) + 1);
                    // Find first die that isn't in a set or is the lowest singleton
                    let replaceIdx = -1;
                    let lowestVal = 11;
                    for (let i = 0; i < finalResults.length; i++) {
                        // Skip HD (indices past normalDiceCount in the original layout)
                        // For simplicity, replace the lowest singleton
                        if (countMap[finalResults[i]] === 1 && finalResults[i] < lowestVal) {
                            lowestVal = finalResults[i];
                            replaceIdx = i;
                        }
                    }
                    // If all dice are in sets, just replace the last die
                    if (replaceIdx === -1) replaceIdx = finalResults.length - 1;
                    finalResults[replaceIdx] = expertFace;
                }
            }

            const rollFlagsForContext = {
                multiActions: rollData.multiActions, calledShot: rollData.calledShot,
                difficulty: rollData.difficulty, wasCapped: poolMath.wasCapped,
                isAttack: isAttackRoll, isDefense: isDefenseRoll,
                poolBreakdown, advancedMods,
                hardCount: hdCount, wiggleCount: wdCount,
                // 📖 WT Ch1 p.25: Special Maneuver flags
                expertAction: rollData.expertAction,
                determinedAction: rollData.determinedAction,
                fastAction: rollData.fastAction
            };
            let chatMsg = null;

            // Post to chat — pass 0 for legacy edFace/mdCount, include HD/WD in rollFlags
            chatMsg = await postOREChat(actor, label || "Action", poolMath.totalPool, finalResults, 0, 0, itemRef, rollFlagsForContext, rollInstance);

            // Store roll context for re-roll
            await actor.setFlag("wild-talents-2e", "lastRollContext", {
                label:      label || "Action",
                totalPool:  poolMath.totalPool,
                normalDice: poolMath.normalDiceCount,
                hardCount:  hdCount,
                wiggleCount: wdCount,
                edFace:     0,
                mdCount:    0,
                itemId:     itemRef?.id || null,
                rollFlags:  rollFlagsForContext
            });

            if (DEBUG_ROLLS) console.log("WT Roller | Execution Complete.");
        };

        // WT: Delegate to finalizeWithSpecialDice (rolls Normal, appends HD, prompts WD)
        await this.finalizeWithSpecialDice(poolMath, finalizeCombatRoll);
    } catch (err) {
        console.error("WT Roller | CRITICAL EXCEPTION CAUGHT:", err);
        ui.notifications.error("The roll crashed silently. Check the F12 console to see exactly why.");
    }
  }


  // ==========================================
  // BATCH C ITEM-11: REROLL LAST CONTEXT
  // ==========================================

  /**
   * Re-runs the last stored roll for an actor without reopening the dialog.
   * Called by the ↺ button on chat cards via wild-talents-2e.mjs.
   * @param {Actor} actor
   * @param {Object} context - stored lastRollContext from actor flags
   */
  static async reroll(actor, context) {
    try {
      // normalDice may be absent on older stored contexts — derive it safely
      const normalDice = context.normalDice
        ?? Math.max(0, context.totalPool - context.mdCount - (context.edFace > 0 ? 1 : 0));

      // ITEM-19: Use BaseORERoller.rollDice for consistent dice evaluation.
      const { roll: rollInstance, results } = await this.rollDice(normalDice);
      if (context.edFace > 0) results.push(context.edFace);

      const itemRef = context.itemId ? actor.items.get(context.itemId) : null;

      // ITEM-19: Use BaseORERoller.promptMasterDice for consistent MD dialog.
      if (context.mdCount > 0) {
        const mdFaces = await this.promptMasterDice(results, context.mdCount);
        if (!mdFaces) return;
        results.push(...mdFaces);
      }

      await postOREChat(actor, context.label, context.totalPool, results, context.edFace, context.mdCount, itemRef, context.rollFlags || {}, rollInstance);
    } catch (err) {
      console.error("WT Roller | Reroll failed:", err);
      ui.notifications.error("Re-roll failed — check the console for details.");
    }
  }


  // ==========================================
  // PACKAGE C ITEM 6: AIM MANEUVER
  // ==========================================

  /**
   * RAW Ch6 "Aim": Declares the character is spending this round aiming.
   *
   * Penalty: Spend a round without rolled actions, OR roll only Dodge/Parry at -1d.
   * Result:  +1d (or offset -1d) on next round's attack against the aimed target.
   *          Stackable to +2d over two consecutive rounds. No further benefit after 2.
   *
   * The bonus is consumed when the character makes an attack roll (handled in rollCharacter).
   * If the character doesn't aim or attack next round, the bonus is cleared at nextRound().
   *
   * @param {Actor} actor - The aiming character.
   */
  static async declareAim(actor) {
    if (!actor || actor.type !== "character") return;

    const currentBonus = actor.getFlag("wild-talents-2e", "aimBonus") || 0;

    if (currentBonus >= 2) {
      return ui.notifications.warn("Maximum aim bonus already reached (+2d from 2 rounds). Further aiming has no additional effect.");
    }

    const newBonus = currentBonus + 1;
    await actor.setFlag("wild-talents-2e", "aimBonus", newBonus);
    await actor.setFlag("wild-talents-2e", "aimedThisRound", true);

    const safeName = foundry.utils.escapeHTML(actor.name);
    const roundDesc = newBonus === 1
      ? "takes careful aim at their target"
      : "continues to sight in, refining their aim";

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div class="wt-chat-card">
        <h3><i class="fas fa-crosshairs"></i> Aiming (Round ${newBonus}/2)</h3>
        <p>${safeName} ${roundDesc}.</p>
        <p class="wt-text-success wt-text-bold">+${newBonus}d bonus on next attack.</p>
        <p class="wt-text-muted wt-text-small">RAW: While aiming, the character may take no rolled actions, or roll only Dodge/Parry at −1d.</p>
      </div>`
    });
  }


  // ==========================================
  // PACKAGE C ITEM 4: SHIELD LOCATION ASSIGNMENT
  // ==========================================

  /**
   * RAW Ch6 "Shields": At the beginning of each combat round, a player declares
   * which hit location their shield protects.
   *
   * - Small shields protect one hit location at a time.
   * - Large shields always protect the carrying arm PLUS one other location
   *   (or both arm locations if no other is specified).
   * - Tower shields provide cover to arm + two additional locations when stationary.
   *
   * If not declared, the shield defaults to protecting the carrying arm.
   * The assignment is stored as actor flags and cleared each round by nextRound().
   *
   * @param {Actor} actor - The character with equipped shield(s).
   */
  static async assignShieldCoverage(actor) {
    if (!actor || actor.type !== "character") return;

    const shields = actor.items.filter(i => i.type === "shield" && i.system.equipped);
    if (shields.length === 0) return ui.notifications.info(`${actor.name} has no equipped shields.`);

    const locationLabels = {
      head: "Head (10)", torso: "Torso (7-9)", armR: "R. Arm (5-6)",
      armL: "L. Arm (3-4)", legR: "R. Leg (2)", legL: "L. Leg (1)"
    };
    const locationKeys = ["head", "torso", "armR", "armL", "legR", "legL"];

    const coverageResult = {};

    for (const shield of shields) {
      const sys = shield.system;
      const size = sys.shieldSize || "small";
      const shieldArm = sys.shieldArm || "armL";
      const safeName = foundry.utils.escapeHTML(shield.name);

      // Determine how many free choices the player gets
      let fixedLocations = [];
      let freeSlots = 1;

      if (size === "large") {
        // Large shields always protect the shield arm + 1 choice
        fixedLocations = [shieldArm];
        freeSlots = 1;
      } else if (size === "tower") {
        // Tower shields protect the arm + 2 extra when stationary
        fixedLocations = [shieldArm];
        freeSlots = 2;
      } else {
        // Small shield: 1 choice (defaults to shield arm if not specified)
        freeSlots = 1;
      }

      const fixedLabels = fixedLocations.map(k => locationLabels[k]).join(", ");
      const availableKeys = locationKeys.filter(k => !fixedLocations.includes(k));

      let selectHtml = "";
      if (freeSlots === 1) {
        const options = availableKeys.map(k => `<option value="${k}">${locationLabels[k]}</option>`).join("");
        selectHtml = `<div class="form-group"><label>Protect location:</label><select name="shieldLoc0">${options}</select></div>`;
      } else {
        for (let i = 0; i < freeSlots; i++) {
          const options = availableKeys.map(k => `<option value="${k}">${locationLabels[k]}</option>`).join("");
          selectHtml += `<div class="form-group"><label>Location ${i + 1}:</label><select name="shieldLoc${i}">${options}</select></div>`;
        }
      }

      const content = `
        <form class="wt-dialog-form">
          <p class="wt-text-center wt-text-large"><strong>${safeName}</strong> (${size.charAt(0).toUpperCase() + size.slice(1)})</p>
          ${fixedLabels ? `<p class="wt-text-center wt-text-muted">Always protects: <strong>${fixedLabels}</strong></p>` : ""}
          <p class="wt-text-center wt-text-small wt-text-muted">Choose ${freeSlots === 1 ? "which additional location" : `${freeSlots} additional locations`} to protect this round:</p>
          ${selectHtml}
        </form>
      `;

      const result = await wtDialog(
        `Shield Coverage: ${shield.name}`,
        content,
        (e, b, d) => {
          const f = d.element.querySelector("form") || d.element;
          const chosen = [];
          for (let i = 0; i < freeSlots; i++) {
            const val = f.querySelector(`[name="shieldLoc${i}"]`)?.value;
            if (val) chosen.push(val);
          }
          return chosen;
        },
        { defaultLabel: "Assign Coverage" }
      );

      if (!result) continue;

      // Build the coverage map for this shield
      const coverage = {};
      for (const k of locationKeys) coverage[k] = false;
      for (const k of fixedLocations) coverage[k] = true;
      for (const k of result) coverage[k] = true;

      coverageResult[shield.id] = coverage;
    }

    // Store as actor flags (read by getProtectedShieldLAR in damage.js)
    if (!foundry.utils.isEmpty(coverageResult)) {
      await actor.setFlag("wild-talents-2e", "shieldCoverage", coverageResult);

      const safeName = foundry.utils.escapeHTML(actor.name);
      const summaryParts = [];
      for (const [shieldId, locs] of Object.entries(coverageResult)) {
        const shield = actor.items.get(shieldId);
        const protectedNames = Object.entries(locs)
          .filter(([, v]) => v)
          .map(([k]) => locationLabels[k]?.split(" (")[0] || k);
        summaryParts.push(`<strong>${shield?.name || "Shield"}:</strong> ${protectedNames.join(", ")}`);
      }

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="wt-chat-card">
          <h3><i class="fas fa-shield-alt"></i> Shield Coverage Set</h3>
          <p>${safeName} positions their shield${shields.length > 1 ? "s" : ""} for this round:</p>
          <div class="wt-callout">${summaryParts.join("<br>")}</div>
        </div>`
      });
    }
  }
}