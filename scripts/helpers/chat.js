/* global fromUuid */
// scripts/helpers/chat.js
import { parseORE, getHitLocation, getHitLocationLabel, calculateInitiative } from "./ore-engine.js";
import { resolveWidthTier, calculateManeuverMorale } from "./maneuvers.js";

/**
 * Generates data for visual 10-sided dice icons.
 */
function getDiceData(diceArray, isSuccess = true, isWaste = false) {
  if (!diceArray || diceArray.length === 0) return [];
  
  return diceArray.map(rawFaceValue => {
    const faceValue = parseInt(rawFaceValue, 10);
    if (isNaN(faceValue)) return null;

    let cssClass = "matched";
    if (isWaste) cssClass = "waste";
    else if (!isSuccess) cssClass = "failed";

    return { value: faceValue, cssClass };
  }).filter(d => d !== null);
}

/**
 * Generates the full ORE chat card HTML from roll results.
 * * Gobble Dice Flow (V2.0.0 RAW Fix):
 * - On defense rolls: if flags.gobbleDice is undefined AND there is >1 set, we prompt the user.
 * - If there is only 1 set, we auto-assign it.
 *
 * @param {string} actorType - The type of actor rolling.
 * @param {string} label - The roll label.
 * @param {number} totalPool - Total dice in the pool.
 * @param {Array} results - Array of individual die face results.
 * @param {number} hardDieCount - Number of Hard Dice in the pool (always face 10).
 * @param {number} wiggleDieCount - Number of Wiggle Dice in the pool (assigned post-roll).
 * @param {Object|null} itemData - The serialized item data, if any.
 * @param {Object} flags - Additional roll flags (isAttack, isDefense, gobbleDice, etc).
 * @param {Object|null} [parsedOverride=null] - Pre-parsed ORE result to avoid redundant re-parsing.
 */
export async function generateOREChatHTML(actorType, label, totalPool, results, hardDieCount, wiggleDieCount, itemData = null, flags = {}, parsedOverride = null) {
  const parsed = parsedOverride || parseORE(results, flags.isMinion);
  
  const isSpell = itemData && itemData.type === "spell";
  const spellIntensity = isSpell ? (parseInt(itemData.system.intensity) || 0) : 0;
  const difficulty = flags.difficulty || 0;

  // Detection radius table (RAW Realms p.147)
  const DETECTION_RADIUS = ["—","—","5 ft","10 ft","50 ft","1,000 ft","1 mile","10 miles","25 miles","50 miles","100 miles"];
  const spellDetectionRadius = isSpell && spellIntensity >= 1
      ? DETECTION_RADIUS[Math.min(10, spellIntensity)] : null;

  // AUDIT FIX P2: Security - Escape all raw string inputs from items to prevent XSS
  let rawDmgStr = itemData?.system?.damageFormula || itemData?.system?.damage || "";
  if (typeof rawDmgStr === "string") rawDmgStr = foundry.utils.escapeHTML(rawDmgStr);
  
  if (!rawDmgStr && flags.isAttack && itemData?.type === "weapon") {
      rawDmgStr = "Width Shock";
  }

  const safeLabel = foundry.utils.escapeHTML(label);
  const isDefense = flags.isDefense || /dodge|parry|counterspell/i.test(safeLabel);
  let defenseType = "none";
  if (isDefense) {
      if (/dodge/i.test(safeLabel)) defenseType = "dodge";
      else if (/parry/i.test(safeLabel)) defenseType = "parry";
      else if (/counterspell/i.test(safeLabel)) defenseType = "counterspell";
      else defenseType = "generic";
  }

  // P1 RAW FIX: Stop auto-gobbling all sets.
  let gobbleDice = flags.gobbleDice;
  let needsGobbleSelection = false;
  
  if (isDefense && gobbleDice === undefined) {
      if (parsed.sets.length === 1) {
          // If only one set was rolled, auto-assign it for UX speed.
          // ISSUE-034 FIX: Record auto-assignment so the template can display a confirmation banner.
          gobbleDice = [];
          for (let i = 0; i < parsed.sets[0].width; i++) gobbleDice.push(parsed.sets[0].height);
          flags = { ...flags, gobbleDiceAutoAssigned: true };
      } else if (parsed.sets.length > 1) {
          // If multiple sets were rolled, flag the template to show the selection buttons
          needsGobbleSelection = true;
          gobbleDice = null;
      }
  }

  const isFirstAid = /healing|medicine/i.test(safeLabel);
  const isHealingSpell = isSpell && /healing/i.test(rawDmgStr);

  let wasteType = null;
  let wasteAp = itemData?.system?.qualities?.armorPiercing || 0;
  const wasteMatch = rawDmgStr.match(/waste\s+(shock|killing|healing)/i);
  if (wasteMatch) {
      wasteType = foundry.utils.escapeHTML(wasteMatch[1].toLowerCase());
  }

  const isAttack = (!!flags.isAttack || (isSpell && rawDmgStr.trim() !== "")) && !isHealingSpell && !isDefense;

  // Ch7: Extract maneuver definition from advancedMods (serialized at roll time)
  const maneuverDef = flags.advancedMods?.maneuver || null;

  let wasteData = null;
  if (wasteType && parsed.waste.length > 0 && !isDefense) {
      const wasteFaces = parsed.waste.map(f => parseInt(f, 10));
      const wasteLocs = wasteFaces.map(f => getHitLocationLabel(getHitLocation(f)).split(" (")[0]);
      wasteData = {
          type: wasteType.charAt(0).toUpperCase() + wasteType.slice(1),
          faces: JSON.stringify(wasteFaces),
          locations: foundry.utils.escapeHTML(wasteLocs.join(", ")),
          ap: parseInt(wasteAp) || 0,
          isHealing: wasteType === "healing"
      };
  }

  // PHASE 4: MAGIC TRANSFER SYSTEM
  // Check if at least one set actually succeeded to reveal the Apply Effect button
  let hasSuccessfulSet = false;

  // Equipment Width Bonus (RAW Ch6 p.114): Items can grant +Width to successful sets
  const bonusWidth = flags.advancedMods?.bonusWidth || 0;
  // minHeight: AE-driven minimum Height for a set to count as successful (RAW: certain Advantages)
  const minHeight  = flags.advancedMods?.minHeight  || 0;
  // squishLimit: AE-driven maximum Width cap per set (RAW: certain Advantages / weapon properties)
  const squishLimit = flags.advancedMods?.squishLimit || 0; // 0 = no cap

  const setsData = [];
  parsed.sets.forEach((s, index) => {
    let locKey = getHitLocation(s.height);
    let isSuccess = true;
    let failReason = "";

    if (s.height < difficulty) {
      isSuccess = false;
      failReason = `Difficulty ${difficulty} Required`;
    } else if (isSpell && s.width < spellIntensity) {
      isSuccess = false;
      failReason = `Intensity ${spellIntensity} Required (Width too low)`;
    } else if (minHeight > 0 && s.height < minHeight) {
      // minHeight AE: set Height must reach the minimum or the set doesn't count
      isSuccess = false;
      failReason = `Minimum Height ${minHeight} Required`;
    }

    if (isSuccess) hasSuccessfulSet = true;

    // Apply equipment Width bonus to successful sets, then clamp to squishLimit
    const rawEffectiveWidth = isSuccess ? s.width + bonusWidth : s.width;
    const effectiveWidth = (squishLimit > 0 && rawEffectiveWidth > squishLimit)
        ? squishLimit
        : rawEffectiveWidth;
    const widthBonusText = (isSuccess && bonusWidth > 0) ? ` (+${bonusWidth}W)` : "";
    const squishText     = (isSuccess && squishLimit > 0 && s.width + bonusWidth > squishLimit)
        ? ` (capped ${squishLimit})` : "";

    const setObj = {
      width: effectiveWidth,
      height: s.height,
      text: foundry.utils.escapeHTML(`${effectiveWidth}×${s.height}${widthBonusText}${squishText}`),
      location: (actorType === "character" && (isAttack || isHealingSpell || isFirstAid) && !isDefense) ? foundry.utils.escapeHTML(getHitLocationLabel(locKey)) : null,
      isSuccess,
      failReason: foundry.utils.escapeHTML(failReason),
      dice: getDiceData(Array(s.width).fill(s.height), isSuccess, false),
      dmg: null,
      heal: null,
      companyDmg: null,
      initBtn: parsed.sets.length > 1,
      maneuverOutcome: null
    };

    if ((isAttack || isHealingSpell) && rawDmgStr.trim() !== "") {
      let primaryStr = rawDmgStr.replace(/waste\s+(shock|killing|healing)/ig, "").replace(/^\s*\+\s*/, "").replace(/\s*\+\s*$/, "").trim();

      if (primaryStr.length > 0) {
        let calculatedVal = primaryStr.replace(/width/ig, s.width);
        calculatedVal = calculatedVal.replace(/(\d+)\s*\+\s*(\d+)/g, (match, a, b) => parseInt(a) + parseInt(b));
        
        if (isHealingSpell) {
            setObj.heal = {
                formula: foundry.utils.escapeHTML(calculatedVal)
            };
        } else {
            setObj.dmg = {
                formula: foundry.utils.escapeHTML(calculatedVal),
                ap: parseInt(itemData?.system?.qualities?.armorPiercing) || 0,
                slow: parseInt(itemData?.system?.qualities?.slow) || 0,
                twoHanded: !!itemData?.system?.qualities?.twoHanded,
                massive: !!itemData?.system?.qualities?.massive,
                area: parseInt(itemData?.system?.qualities?.area) || 0
            };
        }
      }
    }

    // Ch7: Resolve maneuver Width tier and build outcome data for the template
    if (maneuverDef && isSuccess) {
        const tierResult = resolveWidthTier(maneuverDef, s.width);
        if (tierResult) {
            const outcome = {
                maneuverKey: maneuverDef.id,
                maneuverLabel: maneuverDef.label,
                tier: tierResult.tier,
                tierLabel: tierResult.tier >= 4 ? "Master" : tierResult.tier === 3 ? "Expert" : "Standard",
                description: tierResult.description || "",
                isTier1: maneuverDef.tier === 1,
                isTier2: maneuverDef.tier === 2,
                rulesText: maneuverDef.rulesText || "",
                requiresKill: !!maneuverDef.requiresKill,
                noDamage: !!maneuverDef.noDamage,
                moraleAttack: 0,
                hasMoraleAttack: false,
                bonusShock: tierResult.bonusShock || 0,
                bonusKilling: tierResult.bonusKilling || 0,
                convertKillingToShock: !!tierResult.convertKillingToShock,
                discardOverflow: !!tierResult.discardOverflow,
                // C1: Status effect application fields
                applyStatus: tierResult.applyStatus || "",
                clearStatus: tierResult.clearStatus || "",
                setFlag: tierResult.setFlag || "",
                statusTarget: tierResult.statusTarget || "target",
                slamShock: tierResult.slamShock || 0,
                slamMultiLoc: !!tierResult.slamMultiLoc,
                hasStatusEffect: !!(tierResult.applyStatus || tierResult.clearStatus || tierResult.setFlag),
                // C2: Per-round hold/setup fields — Strangle
                strangleShock: tierResult.strangleShock === "width+1" ? s.width + 1 : (tierResult.strangleShock || 0),
                strangleNextRound: tierResult.strangleNextRound || 0,
                hasStrangleSetup: !!tierResult.strangleShock,
                // C2: Iron Kiss setup
                ironKissVirtualWidth: tierResult.ironKissVirtualWidth || 0,
                hasIronKissSetup: !!tierResult.ironKissVirtualWidth,
                // C2: Redirect
                redirectWidthMod: tierResult.redirectWidthMod ?? 0,
                redirectAny: !!tierResult.redirectAny,
                hasRedirectSetup: tierResult.redirectWidthMod !== undefined,
                // C2: Submission Hold
                holdShock: tierResult.holdShock || 0,
                wrenchKilling: tierResult.wrenchKilling || 0,
                holdHeight: flags.calledShot || 0,
                hasSubmissionHold: !!tierResult.holdShock,
                // BATCH B ITEM-2: Pin escape — attacker stats for escape difficulty.
                // attackerBody/attackerFight stamped by character-roller.js (Batch C).
                isPinManeuver: maneuverDef.id === "pin",
                attackerBody: maneuverDef.attackerBody || 0,
                attackerFight: maneuverDef.attackerFight || 0
            };

            // Morale Attack calculation for Threaten and Display Kill
            if (tierResult.moraleAttack) {
                const fakeSystem = {
                    attributes: { command: { value: maneuverDef.attackerCommand || 0 } },
                    skills: { intimidate: { value: maneuverDef.attackerIntimidate || 0 } }
                };
                outcome.moraleAttack = calculateManeuverMorale(tierResult, s.width, s.height, fakeSystem);
                outcome.hasMoraleAttack = outcome.moraleAttack > 0;
            }

            setObj.maneuverOutcome = outcome;
        }
    }

    if (actorType === "company" && flags.targetQuality && flags.targetQuality !== "none") {
      setObj.companyDmg = { width: s.width, quality: foundry.utils.escapeHTML(flags.targetQuality.toUpperCase()) };
    }

    setsData.push(setObj);
  });

  const templateData = {
    actorType: foundry.utils.escapeHTML(actorType),
    label: safeLabel,
    totalPool,
    wasCapped: !!flags.wasCapped,
    poolBreakdown: flags.poolBreakdown || [],
    isAttack: isAttack,
    isDefense: isDefense,
    defenseType: defenseType,
    defenseTypeLabel: defenseType !== "none" ? (defenseType.charAt(0).toUpperCase() + defenseType.slice(1)) : "",
    needsGobbleSelection: needsGobbleSelection,
    gobbleDice: gobbleDice,
    gobbleCount: gobbleDice ? gobbleDice.length : 0,
    isHealingSpell: isHealingSpell,
    isFirstAid: isFirstAid,
    isMinion: !!flags.isMinion,
    multiActions: flags.multiActions || 1,
    calledShot: flags.calledShot || 0,
    hardDieCount: hardDieCount || 0,
    wiggleDieCount: wiggleDieCount || 0,
    sets: setsData,
    hasSuccessfulSet: hasSuccessfulSet, 
    waste: getDiceData(parsed.waste, false, true),
    wasteDmg: wasteData, 
    itemUuid: itemData?.uuid || null,
    hasEffects: !!itemData?.hasEffects,
    // 8b: Multi-action set assignment
    isMultiAction: (flags.multiActions || 1) > 1 && (flags.declaredActions || []).length > 0,
    declaredActions: flags.declaredActions || [],
    setAssignments: flags.setAssignments || {},
    // ── Spell metadata ──────────────────────────────────────────────────
    isSpell: isSpell,
    spellIntensity: spellIntensity,
    spellFired: isSpell && hasSuccessfulSet,
    spellDetectionRadius: spellDetectionRadius,
    spellSlow: isSpell ? (parseInt(itemData.system.slow) || 0) : 0,
    spellSchool: isSpell ? foundry.utils.escapeHTML(itemData.system.school || "") : "",
    spellDuration: isSpell ? foundry.utils.escapeHTML(itemData.system.duration || "") : "",
    spellDodgeable: isSpell && !!itemData.system.dodgeable,
    spellParriable: isSpell && !!itemData.system.parriable,
    spellArmorBlocks: isSpell && !!itemData.system.armorBlocks,
    spellIsAttunementSpell: isSpell && !!itemData.system.isAttunementSpell,
    spellAttunementRequired: isSpell && !!itemData.system.attunementRequired,
    // BATCH B ITEM-10: Incoming defence status — populated by Batch C when a defender rolls.
    // Null on initial render; the attack card is updated in-place when defence arrives.
    defenceStatus: flags.defenceStatus || null,
    // ISSUE-034: Signal the template when gobble dice were automatically assigned (single set)
    gobbleDiceAutoAssigned: !!(flags.gobbleDiceAutoAssigned)
  };

  return await foundry.applications.handlebars.renderTemplate("systems/wild-talents-2e/templates/chat/ore-roll.hbs", templateData);
}

/**
 * Posts a complete ORE roll result to the chat log.
 * Handles initiative calculation, Gobble Dice generation for defense rolls,
 * slow weapon cooldowns, and Dice So Nice integration.
 *
 * @param {Actor} actor - The rolling actor.
 * @param {string} label - The roll label.
 * @param {number} totalPool - Total dice in the pool.
 * @param {Array} results - Array of individual die face results.
 * @param {number} hardDieCount - Number of Hard Dice in the pool.
 * @param {number} wiggleDieCount - Number of Wiggle Dice in the pool.
 * @param {Item|null} item - The source item, if any.
 * @param {Object} flags - Additional roll flags.
 * @param {Roll|null} rollInstance - The Foundry Roll object for Dice So Nice.
 * @param {Object} advancedMods - Snapshot of active modifier data to prevent state desync.
 */
export async function postOREChat(actor, label, totalPool, results, hardDieCount, wiggleDieCount, item = null, flags = {}, rollInstance = null, advancedMods = {}) {
  const parsed = parseORE(results, flags.isMinion);

  const safeLabel = foundry.utils.escapeHTML(label);
  const isDefense = flags.isDefense || /dodge|parry|counterspell/i.test(safeLabel);
  let defenseType = "none";
  if (isDefense) {
      if (/dodge/i.test(safeLabel)) defenseType = "dodge";
      else if (/parry/i.test(safeLabel)) defenseType = "parry";
      else if (/counterspell/i.test(safeLabel)) defenseType = "counterspell";
      else defenseType = "generic";
  }

  // P1 RAW FIX: Stop auto-gobbling all sets. Only auto-gobble if exactly 1 set.
  let gobbleDice = flags.gobbleDice;
  if (isDefense && gobbleDice === undefined) {
      if (parsed.sets.length === 1) {
          gobbleDice = [];
          for (let i = 0; i < parsed.sets[0].width; i++) gobbleDice.push(parsed.sets[0].height);
          flags.gobbleDice = gobbleDice;
      }
  }

  if (game.combat && actor && parsed.sets.length > 0) {
    const range = item?.type === "weapon" ? (item.system.range || "0") : "0";
    let initValue = calculateInitiative(parsed.sets, isDefense, flags.isAttack, flags.isMinion, foundry.utils.escapeHTML(range));

    // bonusTiming AE: flat initiative bonus from Advantages (RAW: certain disciplines add +1 timing)
    const bonusTiming = flags.advancedMods?.bonusTiming || 0;
    if (bonusTiming !== 0) initValue += bonusTiming;

    // 📖 WT Rulebook Ch1 p.25: Fast Action — "+1 Width for speed only"
    // This adds to initiative (speed/timing) but NOT to damage Width.
    if (flags.fastAction) initValue += 1;

    const combatants = game.combat.combatants.filter(c => c.actorId === actor.id);
    
    if (item?.type === "weapon" && item.system.qualities?.slow > 0 && combatants.length > 0) {
        const slowRounds = parseInt(item.system.qualities.slow) || 0;
        const currentRound = game.combat.round;
        const updates = combatants.map(c => ({ _id: c.id, initiative: initValue, "flags.wild-talents-2e.slowCooldown": currentRound + slowRounds }));
        await game.combat.updateEmbeddedDocuments("Combatant", updates);
    } else if (item?.type === "spell" && (parseInt(item.system.slow) || 0) > 0 && combatants.length > 0) {
        // Spell slow: per-item cooldown flag so different slow spells don't clobber each other
        const slowRounds = parseInt(item.system.slow) || 0;
        const currentRound = game.combat.round;
        const updates = combatants.map(c => ({ _id: c.id, initiative: initValue, [`flags.wild-talents-2e.spellSlowCooldown_${item.id}`]: currentRound + slowRounds }));
        await game.combat.updateEmbeddedDocuments("Combatant", updates);
        ui.notifications.info(`${item.name} (Slow ${slowRounds}) — next available on Round ${currentRound + slowRounds + 1}.`);
    } else if (combatants.length > 0) {
        const updates = combatants.map(c => ({ _id: c.id, initiative: initValue }));
        await game.combat.updateEmbeddedDocuments("Combatant", updates);
    }
  }

  // ITEM-8 Option A: Rolling during declaration phase is sufficient to declare.
  // Applies in both simple and advanced modes. A roll with no sets is still a
  // declaration — the character attempted an action and committed to a pool.
  if (game.combat && actor) {
    const combatPhase = game.combat.getFlag("wild-talents-2e", "phase") || "declaration";
    if (combatPhase === "declaration") {
      const undeclaredCombatants = game.combat.combatants.filter(
        c => c.actorId === actor.id && !c.getFlag("wild-talents-2e", "declared")
      );
      if (undeclaredCombatants.length > 0) {
        await game.combat.updateEmbeddedDocuments("Combatant",
          undeclaredCombatants.map(c => ({ _id: c.id, "flags.wild-talents-2e.declared": true }))
        );
      }
    }
  }

  // 8b: For multi-action rolls, read the declared action list from the combatant flag so
  // the chat card can offer per-set assignment. Only populated if the player used the
  // advanced declaration dialog AND declared a multi action this round.
  let declaredActions = [];
  if ((flags.multiActions || 1) > 1 && game.combat && actor) {
    const combatant = game.combat.combatants.find(c => c.actorId === actor.id);
    const declarationAction = combatant?.getFlag("wild-talents-2e", "declarationAction");
    if (declarationAction?.type === "multi" && Array.isArray(declarationAction.actions) && declarationAction.actions.length > 0) {
      declaredActions = declarationAction.actions.map(a => ({
        label: foundry.utils.escapeHTML(a.label || "Action"),
        type: a.type || "unknown"
      }));
    }
  }

  const actorType = actor?.type || "character";
  
  // Slim projection: only serialize the fields actually consumed by chat cards and damage applicators.
  // Avoids bloating ChatMessage documents with full item notes/HTML/effect arrays.
  const itemData = item ? {
    uuid: item.uuid,
    name: item.name,
    type: item.type,
    hasEffects: item.effects ? (item.effects.size > 0 || item.effects.contents?.length > 0) : false,
    system: {
      damageFormula: item.system.damageFormula,
      damage: item.system.damage,
      range: item.system.range,
      intensity: item.system.intensity,
      pool: item.system.pool,
      castingStat: item.system.castingStat,
      qualities: item.system.qualities ? foundry.utils.deepClone(item.system.qualities) : {},
      // Spell-specific fields
      slow: item.system.slow || 0,
      duration: item.system.duration || "",
      school: item.system.school || "",
      attunementRequired: !!item.system.attunementRequired,
      isAttunementSpell: !!item.system.isAttunementSpell,
      dodgeable: !!item.system.dodgeable,
      parriable: !!item.system.parriable,
      armorBlocks: !!item.system.armorBlocks
    }
  } : null;
  
  const flavor = await generateOREChatHTML(actorType, label, totalPool, results, hardDieCount, wiggleDieCount, itemData, { ...flags, declaredActions, setAssignments: flags.setAssignments || {} }, parsed);

  // ✅ Serialize `advancedMods` natively into `rollFlags`
  // advancedMods is passed inside flags by the roller — extract it cleanly so
  // the spread below doesn't let the empty local parameter shadow the real value.
  const resolvedAdvancedMods = flags.advancedMods || advancedMods || {};
  const messageFlags = { 
    "wild-talents-2e": { 
        actorType, label: safeLabel, totalPool, results, hardDieCount, wiggleDieCount, 
        itemData, rollFlags: { ...flags, advancedMods: resolvedAdvancedMods, declaredActions, setAssignments: {} },
        isDefense, defenseType, gobbleDice,
        // ISSUE-024/025: Stamp current combat round so gobble/spoil lookups can filter by round.
        combatRound: game.combat?.round ?? undefined
    } 
  };

  const messageData = { 
    speaker: ChatMessage.getSpeaker({ actor }), 
    content: flavor, 
    flags: messageFlags 
  };

  if (rollInstance) {
      messageData.rolls = [rollInstance];
  }

  await ChatMessage.create(messageData);
}

/**
 * P1 RAW FIX: Assigns a specific set to become the Gobble Dice pool.
 * This is triggered when a player clicks a set on a defense card with multiple options.
 */
export async function assignGobbleSet(message, width, height) {
    const flags = message.flags?.["wild-talents-2e"];
    if (!flags) return;

    const newGobbleArray = [];
    for (let i = 0; i < width; i++) {
        newGobbleArray.push(height);
    }

    const updatedRollFlags = foundry.utils.deepClone(flags.rollFlags || {});
    updatedRollFlags.gobbleDice = newGobbleArray;

    const newContent = await generateOREChatHTML(
        flags.actorType,
        flags.label,
        flags.totalPool,
        flags.results,
        flags.hardDieCount ?? flags.expertDie ?? 0,
        flags.wiggleDieCount ?? flags.masterDiceCount ?? 0,
        flags.itemData,
        updatedRollFlags
    );

    await message.update({
        content: newContent,
        "flags.wild-talents-2e.rollFlags": updatedRollFlags,
        "flags.wild-talents-2e.gobbleDice": newGobbleArray
    });
    
    ui.notifications.info(`Assigned ${width}x${height} as Gobble Dice.`);
}

/**
 * 8b: Assigns a rolled set to a declared action on a multi-action chat card.
 *
 * Stores the assignment in rollFlags.setAssignments and re-renders the card
 * in-place, following the same pattern as assignGobbleSet.
 *
 * @param {ChatMessage} message   - The chat message to update.
 * @param {number}      setIndex  - Zero-based index of the set in the sets array.
 * @param {string}      actionLabel - Label of the declared action to assign to.
 */
export async function assignSetToAction(message, setIndex, actionLabel) {
  const flags = message.flags?.["wild-talents-2e"];
  if (!flags) return;

  const updatedRollFlags = foundry.utils.deepClone(flags.rollFlags || {});
  updatedRollFlags.setAssignments = {
    ...(updatedRollFlags.setAssignments || {}),
    [String(setIndex)]: actionLabel
  };

  const newContent = await generateOREChatHTML(
    flags.actorType,
    flags.label,
    flags.totalPool,
    flags.results,
    flags.hardDieCount ?? flags.expertDie ?? 0,
    flags.wiggleDieCount ?? flags.masterDiceCount ?? 0,
    flags.itemData,
    updatedRollFlags
  );

  await message.update({
    content: newContent,
    "flags.wild-talents-2e.rollFlags": updatedRollFlags
  });
}

/**
 * PHASE 4: MAGIC TRANSFER SYSTEM
 * Extracts Active Effects from a source Item and copies them to all currently targeted Tokens.
 * This is triggered by the UI button on a successful Spell or Technique chat card.
 */
export async function applyItemEffectsToTargets(itemUuid) {
    const targets = Array.from(game.user.targets);
    if (targets.length === 0) return ui.notifications.warn("Please target at least one token to apply the effect to.");

    const item = await fromUuid(itemUuid);
    if (!item) return ui.notifications.error("Could not find the source item to extract effects from.");

    // Retrieve native Active Effects
    const effects = Array.from(item.effects || []);
    if (effects.length === 0) return ui.notifications.warn(`The item '${item.name}' has no Active Effects built into it.`);

    const effectsToApply = effects.map(e => {
        let effData = e.toObject();
        effData.origin = itemUuid;
        effData.disabled = false; // Force the effect to be active immediately when pasted onto the target
        delete effData._id;       // Strip ID to ensure Foundry creates a new instance on the target
        return effData;
    });

    for (const target of targets) {
        const actor = target.actor;
        if (!actor) continue;
        
        await actor.createEmbeddedDocuments("ActiveEffect", effectsToApply);
        
        const safeItemName = foundry.utils.escapeHTML(item.name);
        const safeTargetName = foundry.utils.escapeHTML(actor.name);
        
        // Post a stylized narrative chat message confirming the transfer
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: game.user.character }),
            content: `<div class="wt-chat-card wt-card-magic">
                        <h3 class="wt-text-magic"><i class="fas fa-sparkles"></i> Effect Applied</h3>
                        <p>The mystical effects of <strong>${safeItemName}</strong> wrap around <strong>${safeTargetName}</strong>.</p>
                      </div>`
        });
    }
    
    ui.notifications.success(`Successfully applied ${item.name} effects to ${targets.length} target(s).`);
}