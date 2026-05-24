// scripts/apps/combat-dashboard.js
// ════════════════════════════════════════════════════════════════════════════
//  WT ORE COMBAT DASHBOARD — Phase 2: Flag-Backed Display Layer
//  ApplicationV2 window showing the Declaration roster and Resolution
//  speed ladder. Roll data is read from Combat document flags
//  (written by combat-flags.js) for a single canonical data source.
//
//  Architecture:
//    - Singleton pattern: one instance stored on game.wildtalents.dashboard
//    - Auto-shows when combat starts, closes when combat ends
//    - Hooks into updateCombat, updateCombatant, createChatMessage
//    - Per-user collapse state stored on game.user flags
// ════════════════════════════════════════════════════════════════════════════

import { parseORE, getHitLocation, getHitLocationLabel, parseDamageFormula } from "../helpers/ore-engine.js";
import { HIT_LOCATIONS, HIT_LOCATION_LABELS } from "../helpers/config.js";
import { ScrollPreserveMixin } from "../helpers/scroll-mixin.js";
import { getAllRollData, getSpotlight, advanceSpotlight, validateGobble, requestGobble } from "../combat/combat-flags.js";

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;
const { renderTemplate } = foundry.applications.handlebars;

// ─── Constants ───────────────────────────────────────────────────────────────

const TEMPLATE_PATH = "systems/wild-talents-2e/templates/apps/combat-dashboard.hbs";

/** Decode the Width×100 + Height initiative encoding. */
function decodeInitiative(initValue) {
  if (!Number.isNumeric(initValue) || initValue <= 0) return null;
  const rawBase = Math.floor(initValue);
  const width = Math.floor(rawBase / 100);
  const height = rawBase % 100;
  if (width < 1 || height < 1 || height > 10) return null;
  return { width, height };
}

/** Tier label and CSS class from Width value. */
function tierMeta(width) {
  if (width >= 5) return { cls: "w5", label: `Width ${width} — Fastest`, pips: width };
  if (width === 4) return { cls: "w4", label: "Width 4", pips: 4 };
  if (width === 3) return { cls: "w3", label: "Width 3", pips: 3 };
  if (width === 2) return { cls: "w2", label: "Width 2", pips: 2 };
  return { cls: "w1", label: "Width 1 — Slowest", pips: 1 };
}

/** Hit location zone CSS class for colouring. */
function zoneClass(locKey) {
  const map = { head: "hz-head", torso: "hz-torso", armR: "hz-arm", armL: "hz-arm", legR: "hz-leg", legL: "hz-leg" };
  return map[locKey] || "";
}

/** Short hit location label without die-face range. */
function shortLocLabel(locKey) {
  const map = { head: "Head", torso: "Torso", armR: "R. Arm", armL: "L. Arm", legR: "R. Leg", legL: "L. Leg" };
  return map[locKey] || "Unknown";
}

// ─── Dashboard Class ─────────────────────────────────────────────────────────

export class CombatDashboard extends ScrollPreserveMixin(HandlebarsApplicationMixin(ApplicationV2)) {

  /** Track whether the dashboard was manually closed by the user this combat. */
  _userDismissed = false;

  static DEFAULT_OPTIONS = {
    id: "wt-combat-dashboard",
    classes: ["wt", "combat-dashboard", "app-v2"],
    tag: "div",
    window: {
      title: "⚔ Combat Dashboard",
      icon: "fas fa-swords",
      resizable: true,
      minimizable: true,
    },
    position: {
      width: 880,
      height: "auto",
    },
    actions: {
      panToToken:        CombatDashboard.prototype._onPanToToken,
      openSheet:         CombatDashboard.prototype._onOpenSheet,
      toggleCollapse:    CombatDashboard.prototype._onToggleCollapse,
      advanceSpotlight:  CombatDashboard.prototype._onAdvanceSpotlight,
      applyGobble:       CombatDashboard.prototype._onApplyGobble,
    }
  };

  static PARTS = {
    main: { template: TEMPLATE_PATH }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  /** Register hooks on first render. */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    this._registerHooks();
  }

  /** Clean up hooks on close. */
  close(options = {}) {
    this._userDismissed = true;
    this._unregisterHooks();
    return super.close(options);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HOOKS
  // ═══════════════════════════════════════════════════════════════════════════

  _hookIds = [];

  _registerHooks() {
    const refresh = foundry.utils.debounce(() => {
      if (this.rendered) this.render(false);
    }, 100);

    this._hookIds.push(Hooks.on("updateCombat", refresh));
    this._hookIds.push(Hooks.on("updateCombatant", refresh));
    this._hookIds.push(Hooks.on("createChatMessage", refresh));
    this._hookIds.push(Hooks.on("deleteCombat", () => this.close()));
    this._hookIds.push(Hooks.on("updateActor", (actor) => {
      if (actor.type === "character" || actor.type === "threat") refresh();
    }));
  }

  _unregisterHooks() {
    for (const id of this._hookIds) Hooks.off(id);
    this._hookIds = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DATA PREPARATION
  // ═══════════════════════════════════════════════════════════════════════════

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const combat = game.combat;

    context.isGM = game.user.isGM;
    context.hasCombat = !!combat?.started;
    context.collapsed = !!game.user.getFlag("wild-talents-2e", "dashboardCollapsed");

    if (!context.hasCombat) {
      context.phase = null;
      return context;
    }

    context.phase = combat.getFlag("wild-talents-2e", "phase") || "declaration";
    context.round = combat.round || 1;

    if (context.phase === "declaration") {
      context.declaration = this._prepareDeclarationData(combat);
    } else {
      context.resolution = this._prepareResolutionData(combat);
    }

    return context;
  }

  // ─── Declaration Phase ─────────────────────────────────────────────────────

  _prepareDeclarationData(combat) {
    const combatants = [];
    const sorted = combat.combatants.contents.sort((a, b) =>
      combat._sortCombatants ? combat._sortCombatants(a, b) : 0
    );

    for (const c of sorted) {
      const actor = c.actor;
      if (!actor) continue;

      const isPC = !!actor.hasPlayerOwner;
      const declared = c.getFlag("wild-talents-2e", "declared") || false;
      const declText = c.getFlag("wild-talents-2e", "declarationText") || "";
      const declAction = c.getFlag("wild-talents-2e", "declarationAction") || "";
      const sense = actor.system?.attributes?.sense?.value || 0;
      const hasShield = actor.items?.some(i => i.type === "shield" && i.system.equipped) || false;

      // Conditions
      const conditions = [];
      if (actor.statuses?.has("dazed")) conditions.push("Dazed");
      if (actor.statuses?.has("prone")) conditions.push("Prone");
      if (actor.statuses?.has("blind")) conditions.push("Blind");
      if (actor.statuses?.has("pinned")) conditions.push("Pinned");
      if (actor.statuses?.has("restrained")) conditions.push("Restrained");

      // Aim state from previous round
      const aimBonus = actor.getFlag("wild-talents-2e", "aimBonus") || 0;

      combatants.push({
        id: c.id,
        actorId: actor.id,
        name: c.name || actor.name,
        img: actor.img || "icons/svg/mystery-man.svg",
        isPC,
        isThreat: actor.type === "threat",
        isCreature: actor.type === "threat" && actor.system.creatureMode,
        declared,
        declText: foundry.utils.escapeHTML(declText),
        declAction,
        sense,
        hasShield,
        conditions,
        hasConditions: conditions.length > 0,
        aimBonus,
        hasAim: aimBonus > 0,
        // Magnitude for threats
        magnitude: actor.type === "threat" ? (actor.system.magnitude?.value || 0) : null,
        magnitudeMax: actor.type === "threat" ? (actor.system.magnitude?.max || 0) : null,
      });
    }

    const declaredCount = combatants.filter(c => c.declared).length;
    const totalCount = combatants.length;
    const progressPercent = totalCount > 0 ? Math.round((declaredCount / totalCount) * 100) : 0;

    return { combatants, declaredCount, totalCount, progressPercent };
  }

  // ─── Resolution Phase ──────────────────────────────────────────────────────

  _prepareResolutionData(combat) {
    const entries = [];
    const rollCache = getAllRollData(combat);

    for (const c of combat.combatants) {
      const actor = c.actor;
      if (!actor) continue;
      if (c.initiative === null || c.initiative === undefined) continue;

      const decoded = decodeInitiative(c.initiative);
      if (!decoded) continue;

      const { width, height } = decoded;
      const rollData = rollCache.get(actor.id) || null;

      // Determine action type from roll flags
      const rollFlags = rollData?.rollFlags || {};
      const label = rollData?.label || "";
      const isDefense = rollData?.isDefense || rollFlags.isDefense || /dodge|parry|counterspell/i.test(label);
      const isSpell = rollData?.itemData?.type === "spell";
      const isAttack = !isDefense;

      // Hit location (from Height)
      const locKey = getHitLocation(height);
      const locLabel = getHitLocationLabel(locKey);

      // Dice data from the roll message
      let matchedDice = [];
      let wasteDice = [];
      let gobbleDice = [];
      let allResults = [];

      if (rollData?.results) {
        allResults = rollData.results;
        const parsed = parseORE(allResults, rollFlags.isMinion);
        // Find the specific set matching this initiative
        const matchingSet = parsed.sets.find(s => s.width === width && s.height === height);
        if (matchingSet) {
          matchedDice = Array(matchingSet.width).fill(matchingSet.height);
        }
        wasteDice = parsed.waste || [];

        // Gobble dice for defense rolls
        if (isDefense && rollData.gobbleDice) {
          gobbleDice = rollData.gobbleDice;
        }
      }

      // Damage preview for attacks
      let dmgPreview = null;
      if (isAttack && rollData?.itemData?.system?.damageFormula) {
        const formula = rollData.itemData.system.damageFormula;
        const dmg = parseDamageFormula(formula, width);
        const parts = [];
        if (dmg.shock > 0) parts.push(`${dmg.shock} Shock`);
        if (dmg.killing > 0) parts.push(`${dmg.killing} Killing`);
        if (dmg.healing > 0) parts.push(`${dmg.healing} Healing`);
        dmgPreview = parts.join(" + ") || null;
      }

      // Weapon qualities
      const qualities = [];
      if (rollData?.itemData?.system?.qualities) {
        const q = rollData.itemData.system.qualities;
        if (q.ap) qualities.push(`AP ${q.ap}`);
        if (q.slow) qualities.push(`Slow ${q.slow}`);
        if (q.area) qualities.push(`Area ${q.area}`);
        if (q.massive) qualities.push("Massive");
        if (q.twoHanded) qualities.push("2H");
      }

      // Defense type label
      let defenseTypeLabel = "";
      if (isDefense) {
        const dt = rollData?.defenseType || "generic";
        if (dt === "dodge") defenseTypeLabel = "Dodge";
        else if (dt === "parry") defenseTypeLabel = "Parry";
        else if (dt === "counterspell") defenseTypeLabel = "Counterspell";
        else defenseTypeLabel = "Defense";
      }

      // Action description
      let actionDesc = "";
      if (isDefense) {
        actionDesc = `🛡 ${defenseTypeLabel}`;
      } else if (isSpell) {
        actionDesc = `✦ ${rollData?.itemData?.name || "Spell"}`;
      } else if (rollData?.itemData?.name) {
        actionDesc = `⚔ ${rollData.itemData.name}`;
      } else if (label) {
        actionDesc = `⚔ ${label}`;
      } else {
        actionDesc = "⚔ Attack";
      }

      // Actor conditions for badges
      const conditions = [];
      if (actor.statuses?.has("dazed")) conditions.push({ id: "dazed", label: "Dazed", icon: "fas fa-dizzy" });
      if (actor.statuses?.has("prone")) conditions.push({ id: "prone", label: "Prone", icon: "fas fa-arrow-down" });
      if (actor.statuses?.has("blind")) conditions.push({ id: "blind", label: "Blind", icon: "fas fa-eye-slash" });

      entries.push({
        combatantId: c.id,
        actorId: actor.id,
        name: c.name || actor.name,
        img: actor.img || "icons/svg/mystery-man.svg",
        isPC: !!actor.hasPlayerOwner,
        isThreat: actor.type === "threat",
        isCreature: actor.type === "threat" && actor.system.creatureMode,
        initiative: c.initiative,
        width,
        height,
        initBadge: `${width}×${height}`,
        actionDesc: foundry.utils.escapeHTML(actionDesc),
        isAttack,
        isDefense,
        isSpell,
        locKey,
        locLabel,
        locShort: shortLocLabel(locKey),
        zoneClass: zoneClass(locKey),
        // Dice
        hasDiceData: matchedDice.length > 0,
        matchedDice,
        wasteDice,
        totalRolled: allResults.length,
        // Defense
        gobbleDice,
        gobbleCount: gobbleDice.length,
        hasGobble: gobbleDice.length > 0,
        defenseTypeLabel,
        // Damage
        dmgPreview,
        qualities,
        hasQualities: qualities.length > 0,
        // Conditions
        conditions,
        hasConditions: conditions.length > 0,
        // Threat data
        magnitude: actor.type === "threat" ? (actor.system.magnitude?.value || 0) : null,
      });
    }

    // Sort by initiative descending (widest/highest first)
    entries.sort((a, b) => b.initiative - a.initiative);

    // Group into Width tiers
    const tierMap = new Map();
    for (const entry of entries) {
      if (!tierMap.has(entry.width)) {
        const meta = tierMeta(entry.width);
        tierMap.set(entry.width, {
          width: entry.width,
          tierClass: meta.cls,
          tierLabel: meta.label,
          pips: Array(meta.pips).fill(true),
          entries: [],
          count: 0,
        });
      }
      const tier = tierMap.get(entry.width);
      tier.entries.push(entry);
      tier.count++;
    }

    // Convert to array sorted by Width descending
    const tiers = [...tierMap.values()].sort((a, b) => b.width - a.width);

    // Detect simultaneous sets (same Width AND Height from different actors)
    for (const tier of tiers) {
      const byHeight = new Map();
      for (const entry of tier.entries) {
        const key = entry.height;
        if (!byHeight.has(key)) byHeight.set(key, []);
        byHeight.get(key).push(entry);
      }
      for (const [h, group] of byHeight) {
        if (group.length > 1) {
          for (const entry of group) {
            entry.isSimultaneous = true;
            entry.simultaneousWith = group
              .filter(e => e.actorId !== entry.actorId)
              .map(e => e.name)
              .join(", ");
          }
        }
      }
    }

    // ─── Phase 3: Spotlight from combat flags ───────────────────────────
    const spotlight = getSpotlight(combat);
    let spotlightEntry = null;
    const pendingRolls = combat.getFlag("wild-talents-2e", "pendingRolls") || {};

    // Apply per-set status from flags and identify the spotlit entry
    for (const entry of entries) {
      const payload = pendingRolls[entry.combatantId];
      if (payload?.sets) {
        // Find the matching set in the flag data by width/height
        const flagSet = payload.sets.find(s => s.width === entry.width && s.height === entry.height);
        if (flagSet?.status) {
          entry.setStatus = flagSet.status;
          entry.isResolved = flagSet.status === "resolved";
          entry.isBroken = flagSet.status === "broken";
          entry.isReacting = flagSet.status === "reacting";
        }
      }

      // Match against the spotlight flag
      if (spotlight && spotlight.combatantId === entry.combatantId) {
        const flagSet = payload?.sets?.[spotlight.setIndex];
        if (flagSet && flagSet.width === entry.width && flagSet.height === entry.height) {
          entry.isSpotlight = true;
          spotlightEntry = entry;
        }
      }
    }

    // Fallback: if no spotlight flag exists, spotlight the first pending entry
    if (!spotlightEntry && entries.length > 0) {
      const firstPending = entries.find(e => !e.isResolved && !e.isBroken);
      if (firstPending) {
        firstPending.isSpotlight = true;
        spotlightEntry = firstPending;
      }
    }

    // ─── Phase 3: Gobble validation for defense entries ───────────────
    // When a spotlight exists on an attack set, validate each defender's
    // gobble dice against it and attach the validation results.
    if (spotlightEntry && !spotlightEntry.isDefense) {
      const atkSet = { width: spotlightEntry.width, height: spotlightEntry.height };

      for (const entry of entries) {
        if (!entry.isDefense || !entry.hasGobble) continue;

        const defPayload = pendingRolls[entry.combatantId];
        const defActor = game.actors.get(entry.actorId);
        const validation = validateGobble(defPayload, atkSet, defActor);

        entry.gobbleValidation = {
          valid: validation.valid,
          timingOk: validation.timingOk,
          heightOk: validation.heightOk,
          reason: validation.reason,
          validCount: validation.validDice.length,
          invalidCount: validation.invalidDice.length,
        };

        // Tag each gobble die as valid or invalid for template rendering
        entry.gobbleDiceTagged = entry.gobbleDice.map(dieValue => ({
          value: dieValue,
          isValid: validation.timingOk && (validation.validDice.includes(dieValue)),
        }));

        // Data for the apply button
        if (validation.valid) {
          entry.gobbleTarget = {
            attackerCombatantId: spotlightEntry.combatantId,
            attackSetIndex: spotlight?.setIndex ?? 0,
            defenderCombatantId: entry.combatantId,
          };
        }
      }
    }

    // Build spotlight label for the action bar
    const spotLabel = spotlightEntry
      ? `${spotlightEntry.name} · ${spotlightEntry.initBadge} · ${spotlightEntry.locShort}`
      : "";

    // Count resolved
    const resolvedCount = entries.filter(e => e.isResolved || e.isBroken).length;

    return {
      tiers,
      totalSets: entries.length,
      spotlightLabel: spotLabel,
      hasEntries: entries.length > 0,
      hasSpotlight: !!spotlightEntry,
      resolvedCount,
      allResolved: resolvedCount === entries.length && entries.length > 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Click portrait: pan canvas to the combatant's token. */
  _onPanToToken(event, target) {
    const actorId = target.closest("[data-actor-id]")?.dataset.actorId;
    if (!actorId) return;
    const token = canvas?.tokens?.placeables.find(t => t.actor?.id === actorId);
    if (token) {
      token.control({ releaseOthers: true });
      canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
    } else {
      game.actors.get(actorId)?.sheet?.render(true);
    }
  }

  /** Double-click portrait: open actor sheet. */
  _onOpenSheet(event, target) {
    const actorId = target.closest("[data-actor-id]")?.dataset.actorId;
    if (!actorId) return;
    game.actors.get(actorId)?.sheet?.render(true);
  }

  /** Toggle collapse state per user. */
  async _onToggleCollapse(event, target) {
    const current = !!game.user.getFlag("wild-talents-2e", "dashboardCollapsed");
    await game.user.setFlag("wild-talents-2e", "dashboardCollapsed", !current);
    this.render(false);
  }

  /** GM: Advance the spotlight to the next set in resolution order. */
  async _onAdvanceSpotlight(event, target) {
    if (!game.user.isGM) return;
    const combat = game.combat;
    if (!combat?.started) return;
    const result = await advanceSpotlight(combat);
    if (!result) {
      ui.notifications.info("All sets resolved for this round.");
    }
  }

  /** Apply a gobble die from a defender to the currently spotlit attack. */
  async _onApplyGobble(event, target) {
    const defCombatantId = target.dataset.defenderCombatantId;
    const atkCombatantId = target.dataset.attackerCombatantId;
    const atkSetIndex = parseInt(target.dataset.attackSetIndex);

    if (!defCombatantId || !atkCombatantId || isNaN(atkSetIndex)) return;

    // Permission check: player must own the defender, or be GM
    if (!game.user.isGM) {
      const combat = game.combat;
      const defCombatant = combat?.combatants.get(defCombatantId);
      if (!defCombatant?.isOwner) {
        return ui.notifications.warn("You can only use your own gobble dice.");
      }
    }

    requestGobble(defCombatantId, atkCombatantId, atkSetIndex);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  STATIC HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Show the dashboard if combat is active and the user hasn't dismissed it.
   * Called from hooks in wild-talents-2e.mjs.
   */
  static show(instance) {
    if (!game.combat?.started) return;
    if (instance._userDismissed) return;
    if (!instance.rendered) {
      instance.render(true);
    }
  }

  /**
   * Manually toggle the dashboard open/closed. Called from the scene control
   * button in wild-talents-2e.mjs. Resets the dismissal flag when opening so future
   * auto-show hooks (combatStart, phase transitions) work normally again.
   */
  static toggle(instance) {
    if (!instance) return;
    if (instance.rendered) {
      instance.close();
    } else {
      instance._userDismissed = false;
      instance.render(true);
    }
  }

  /** Reset dismissal flag — called when a new combat starts. */
  resetDismissal() {
    this._userDismissed = false;
  }
}
