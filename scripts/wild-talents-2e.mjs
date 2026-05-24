/**
 * Wild Talents 2nd Edition
 * Foundry VTT v14+ (ApplicationV2)
 *
 * Forked from Reign: Realities of Lords and Leaders.
 * ORE engine core reused; character model, powers, and combat adapted for WT.
 */

/* global Handlebars, Hooks, game, ui, document, CONFIG, foundry, ChatMessage, HTMLElement */

// ─── Sheets ──────────────────────────────────────────────────────────────────
import { WTActorSheet }   from "./sheets/character-sheet.js";
import { WTThreatSheet }  from "./sheets/threat-sheet.js";
import { WTItemSheet }    from "./sheets/item-sheet.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────
import { applyItemEffectsToTargets, assignGobbleSet, assignSetToAction } from "./helpers/chat.js";
import { parseORE, calculateInitiative } from "./helpers/ore-engine.js";
import { CharacterRoller } from "./helpers/character-roller.js";
import { wtDialog } from "./helpers/dialog-util.js";
import { SUGGESTED_SKILLS } from "./helpers/config.js";

// ─── Combat ──────────────────────────────────────────────────────────────────
import { applyDamageToTarget, applyScatteredDamageToTarget, applyHealingToTarget, applyFirstAidToTarget, applyManeuverStatus, applyOffensiveMoraleAttack, applyWillpowerChange, performPostCombatRecovery } from "./combat/damage.js";
import { consumeGobbleDie, diveForCover } from "./combat/defense.js";
import { WTCombat } from "./combat/ore-combat.js";
import { openHazardRoller, handlePoisonResist } from "./combat/hazards.js";
import { initCombatSocket, onRollChatMessage } from "./combat/combat-flags.js";

// ─── Apps ────────────────────────────────────────────────────────────────────
import { GMToolbar, fulfillRollRequest } from "./apps/gm-toolbar.js";
import { CombatDashboard } from "./apps/combat-dashboard.js";
import { WTCrucible } from "./apps/crucible.js";

// ─── System ──────────────────────────────────────────────────────────────────
import { migrateWorld } from "./system/migration.js";
import * as models from "./system/models.js";

const SYSTEM_ID = "wild-talents-2e";

// ═══════════════════════════════════════════════════════════════════════════════
//  INIT HOOK — System Registration
// ═══════════════════════════════════════════════════════════════════════════════

Hooks.once("init", async () => {

  // ── Global UI skin ──
  document.body.classList.add("system-wild-talents-2e");

  // ── Handlebars Helpers ──
  Handlebars.registerHelper("multiply", (a, b) => (parseInt(a) || 0) * (parseInt(b) || 0));
  Handlebars.registerHelper("array", (...args) => args.slice(0, -1)); // Strip Handlebars options arg
  Handlebars.registerHelper("eq", (a, b) => a === b);

  // ── Client Settings ──
  game.settings.register(SYSTEM_ID, "colorblindMode", {
    name: "Colourblind Mode",
    hint: "Shifts the colour palette to a high-contrast scheme distinguishable under protanopia, deuteranopia, and tritanopia.",
    scope: "client", config: true, type: Boolean, default: false,
    onChange: (enabled) => document.body.classList.toggle("colorblind-mode", enabled)
  });

  // ── World Settings ──
  game.settings.register(SYSTEM_ID, "lastMigrationVersion", {
    name: "Last Migration Version", scope: "world", config: false,
    type: String, default: "0"
  });

  game.settings.register(SYSTEM_ID, "postCombatRecovery", {
    name: "Post-Combat Shock Recovery",
    hint: "WT Rulebook: verify post-combat recovery rules. Half is the ORE standard default.",
    scope: "world", config: true, type: String, default: "half",
    choices: {
      half: "Half — rounded up (default)",
      all:  "All — full recovery (house rule)",
      none: "None — no recovery (house rule)"
    }
  });

  game.settings.register(SYSTEM_ID, "declarationMode", {
    name: "Declaration Mode",
    hint: "Simple: toggle-only. Advanced: structured declaration dialog.",
    scope: "world", config: true, type: String, default: "simple",
    choices: {
      simple:   "Simple — toggle only (default)",
      advanced: "Advanced — declaration dialog"
    }
  });

  // ── Character Creation: Campaign Power Level (Increment 6) ──
  // 📖 WT Rulebook Ch2 p.42 — "The Point Total"
  game.settings.register(SYSTEM_ID, "powerLevel", {
    name: "Campaign Power Level",
    hint: "Sets the default Point Total for new characters. Players see this in The Crucible (character builder).",
    scope: "world", config: true, type: String, default: "powerful",
    choices: {
      normalHuman:  "Normal Human (40–100 pts, default 100)",
      exceptional:  "Exceptional Human (100–200 pts, default 200)",
      powerful:     "Powerful Superhuman (200–500 pts, default 250)",
      earthShaking: "Earth-Shaking Entity (500–750 pts, default 500)",
      galactic:     "Galactic Entity (750–1,000 pts, default 750)",
      universal:    "Universal Entity (1,000–2,000 pts, default 1,000)",
      custom:       "Custom (set manually below)"
    }
  });

  game.settings.register(SYSTEM_ID, "powerLevelCustom", {
    name: "Custom Point Total",
    hint: "Only used when Campaign Power Level is set to 'Custom'.",
    scope: "world", config: true, type: Number, default: 250
  });

  // ── Optional Sub-Budgets (📖 WT Rulebook Ch2 p.42 "Setting the Ground Rules") ──
  game.settings.register(SYSTEM_ID, "statBudget", {
    name: "Stat Points Budget (0 = unlimited)",
    hint: "Optional. Maximum points a player can spend on Stats. 0 means no limit.",
    scope: "world", config: true, type: Number, default: 0
  });

  game.settings.register(SYSTEM_ID, "skillBudget", {
    name: "Skill Points Budget (0 = unlimited)",
    hint: "Optional. Maximum points a player can spend on Skills. 0 means no limit.",
    scope: "world", config: true, type: Number, default: 0
  });

  game.settings.register(SYSTEM_ID, "powerBudget", {
    name: "Power Points Budget (0 = unlimited)",
    hint: "Optional. Maximum points a player can spend on Powers. 0 means no limit.",
    scope: "world", config: true, type: Number, default: 0
  });

  // ── Combat Document ──
  CONFIG.Combat.documentClass = WTCombat;
  CONFIG.Combat.initiative = { formula: "0", decimals: 2 };

  // ── Trackable Attributes (Token Bars) ──
  CONFIG.Actor.trackableAttributes = {
    character: {
      bar: [],
      value: ["xp.value", "willpower.current"]
    },
    threat: {
      bar: ["magnitude", "morale"],
      value: ["threatLevel"]
    }
  };

  // ── Status Effects (V14 keyed object) ──
  // TODO: Verify WT-specific status list — WT Rulebook Ch6
  const wtStatuses = [
    { id: "dead",         name: "WT.StatusDead",         img: "icons/svg/skull.svg",        _id: "dead000000000000" },
    { id: "unconscious",  name: "WT.StatusUnconscious",  img: "icons/svg/unconscious.svg",  _id: "unconscious00000" },
    { id: "dazed",        name: "WT.StatusDazed",        img: "icons/svg/daze.svg",         _id: "dazed00000000000",
      changes: [{ key: "system.modifiers.globalPool", mode: 2, value: "-1" }] },
    { id: "maimed",       name: "WT.StatusMaimed",       img: "icons/svg/sword.svg",        _id: "maimed0000000000" },
    { id: "prone",        name: "WT.StatusProne",        img: "icons/svg/falling.svg",      _id: "prone00000000000" },
    { id: "bleeding",     name: "WT.StatusBleeding",     img: "icons/svg/blood.svg",        _id: "bleeding00000000" },
    { id: "pinned",       name: "WT.StatusPinned",       img: "icons/svg/net.svg",          _id: "pinned0000000000" },
    { id: "restrained",   name: "WT.StatusRestrained",   img: "icons/svg/anchor.svg",       _id: "restrained000000" },
    { id: "blind",        name: "WT.StatusBlind",        img: "icons/svg/blind.svg",        _id: "blind00000000000" },
    // 📖 WT Rulebook Ch3 p.53: Zero WP — all power HD/WD become Normal, pools halved
    { id: "zeroWillpower", name: "WT.StatusZeroWP",      img: "icons/svg/hazard.svg",       _id: "zerowp0000000000" },
    // 📖 WT Rulebook Ch3 p.52: Zero Base Will — Charm/Command stats unusable
    { id: "zeroBaseWill",  name: "WT.StatusZeroBW",      img: "icons/svg/terror.svg",       _id: "zerobw0000000000" }
  ];
  CONFIG.statusEffects.splice(0, CONFIG.statusEffects.length, ...wtStatuses);

  // ── Data Models ──
  CONFIG.Actor.dataModels = {
    character: models.WTCharacterData,
    threat:    models.WTThreatData
  };

  CONFIG.Item.dataModels = {
    weapon:    models.WTWeaponData,
    armor:     models.WTArmorData,
    shield:    models.WTShieldData,
    gear:      models.WTGearData,
    advantage: models.WTAdvantageData,
    problem:   models.WTProblemData,
    poison:    models.WTPoisonData,
    power:     models.WTPowerData
  };

  // ── Template Preloading ──
  await foundry.applications.handlebars.loadTemplates([
    `systems/${SYSTEM_ID}/templates/parts/damage-silhouette.hbs`,
    `systems/${SYSTEM_ID}/templates/actor/parts/header.hbs`,
    `systems/${SYSTEM_ID}/templates/actor/parts/tabs.hbs`,
    `systems/${SYSTEM_ID}/templates/actor/parts/tab-stats.hbs`,
    `systems/${SYSTEM_ID}/templates/actor/parts/tab-combat.hbs`,
    `systems/${SYSTEM_ID}/templates/actor/parts/combat-health.hbs`,
    `systems/${SYSTEM_ID}/templates/actor/parts/combat-moves.hbs`,
    `systems/${SYSTEM_ID}/templates/actor/parts/combat-inventory.hbs`,
    `systems/${SYSTEM_ID}/templates/actor/parts/tab-biography.hbs`,
    `systems/${SYSTEM_ID}/templates/actor/parts/tab-effects.hbs`,
    `systems/${SYSTEM_ID}/templates/actor/parts/tab-powers.hbs`,
    `systems/${SYSTEM_ID}/templates/actor/parts/dashboard.hbs`,
    `systems/${SYSTEM_ID}/templates/apps/gm-toolbar.hbs`,
    `systems/${SYSTEM_ID}/templates/apps/combat-dashboard.hbs`,
    `systems/${SYSTEM_ID}/templates/apps/crucible.hbs`,
  ]);

  // ── Sheet Registration ──
  const { DocumentSheetConfig } = foundry.applications.apps;
  DocumentSheetConfig.registerSheet(Actor, SYSTEM_ID, WTActorSheet,  { types: ["character"], makeDefault: true });
  DocumentSheetConfig.registerSheet(Actor, SYSTEM_ID, WTThreatSheet, { types: ["threat"],    makeDefault: true });
  DocumentSheetConfig.registerSheet(Item,  SYSTEM_ID, WTItemSheet,   { makeDefault: true });

  // ── Global API ──
  game.wildtalents = {
    parseORE, calculateInitiative,
    applyDamageToTarget, applyScatteredDamageToTarget,
    applyHealingToTarget, applyFirstAidToTarget,
    consumeGobbleDie, diveForCover,
    applyItemEffectsToTargets, assignGobbleSet,
    declareAim: CharacterRoller.declareAim,
    assignShieldCoverage: CharacterRoller.assignShieldCoverage,
    openQuickDiceRoller, GMToolbar, CombatDashboard, WTCrucible,
  };
});

// ═══════════════════════════════════════════════════════════════════════════════
//  READY HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

Hooks.once("ready", () => {
  if (game.settings.get(SYSTEM_ID, "colorblindMode")) {
    document.body.classList.add("colorblind-mode");
  }
});

Hooks.once("ready", async () => {
  if (!game.user.isGM) return;
  const currentVersion = game.system.version;
  const lastMigration = game.settings.get(SYSTEM_ID, "lastMigrationVersion") || "0";
  if (foundry.utils.isNewerVersion(currentVersion, lastMigration)) {
    console.log(`WT | Migrating from ${lastMigration} to ${currentVersion}`);
    const result = await migrateWorld();
    if ((result?.failureCount || 0) > 0) {
      ui.notifications.error(`WT | Migration encountered ${result.failureCount} failure(s). See console.`);
      return;
    }
    await game.settings.set(SYSTEM_ID, "lastMigrationVersion", currentVersion);
  }
});

Hooks.once("ready", async () => {
  if (!game.user.isGM) return;
  const toolbar = new GMToolbar();
  await toolbar.init();
  game.wildtalents.toolbar = toolbar;
});

Hooks.once("ready", () => {
  initCombatSocket();
  Hooks.on("createChatMessage", onRollChatMessage);
  const mode = game.settings.get(SYSTEM_ID, "declarationMode") || "simple";
  if (mode !== "advanced") return;
  const dashboard = new CombatDashboard();
  game.wildtalents.dashboard = dashboard;
  if (game.combat?.started) CombatDashboard.show(dashboard);
  Hooks.on("combatStart", () => { dashboard.resetDismissal(); CombatDashboard.show(dashboard); });
  Hooks.on("updateCombat", (combat, changes) => {
    if (changes.flags?.[SYSTEM_ID]?.phase) CombatDashboard.show(dashboard);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  DOCUMENT LIFECYCLE HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

Hooks.on("preCreateActor", (actor, data) => {
  if (actor.type === "character") {
    actor.updateSource({ "prototypeToken.actorLink": true, "prototypeToken.name": data.name });

    // Pre-populate suggested skills if none exist (new character)
    if (!data.system?.skills || Object.keys(data.system?.skills || {}).length === 0) {
      const defaultSkills = {};
      // Capitalise skill labels: "firstAid" → "First Aid", "meleeWeapon" → "Melee Weapon"
      const toLabel = (key) => key
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, c => c.toUpperCase())
        .trim();
      for (const [key, attr] of Object.entries(SUGGESTED_SKILLS)) {
        const id = foundry.utils.randomID();
        defaultSkills[id] = { label: toLabel(key), attribute: attr, value: 0, hard: 0, wiggle: 0 };
      }
      actor.updateSource({ "system.skills": defaultSkills });
    }
  }
});

Hooks.on("preUpdateItem", (item, changes, options, userId) => {
  if (game.user.id !== userId) return;
  if (!item.parent || item.parent.type !== "character") return;
  if (changes.system?.equipped === true && item.type === "weapon" && item.system.qualities?.massive) {
    const attrs = item.parent.system.attributes?.body || {};
    const bodyTotal = (attrs.normal || 0) + (attrs.hard || 0) + (attrs.wiggle || 0);
    if (bodyTotal < 4) {
      ui.notifications.error(`Cannot equip ${item.name}. Massive weapons require Body 4+ (current: ${bodyTotal}).`);
      return false;
    }
  }
  return true;
});

// ═══════════════════════════════════════════════════════════════════════════════
//  COMBAT HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

Hooks.on("combatStart", async (combat) => {
  if (!game.user.isGM || !game.combats.has(combat.id)) return;
  await combat.setFlag(SYSTEM_ID, "phase", "declaration");
  const updates = combat.combatants.map(c => ({
    _id: c.id, [`flags.${SYSTEM_ID}.declared`]: false, initiative: null
  }));
  if (updates.length > 0) await combat.updateEmbeddedDocuments("Combatant", updates);
});

Hooks.on("updateCombatant", async (combatant, changes) => {
  if (!game.user.isGM) return;
  const combat = combatant.combat;
  if (!combat || !game.combats.has(combat.id)) return;
  if (combat.getFlag(SYSTEM_ID, "phase") === "declaration" &&
      foundry.utils.hasProperty(changes, `flags.${SYSTEM_ID}.declared`)) {
    const allDeclared = combat.combatants.filter(c => c.getFlag(SYSTEM_ID, "declared")).length === combat.combatants.size;
    if (allDeclared && combat.combatants.size > 0) {
      await combat.setFlag(SYSTEM_ID, "phase", "resolution");
      combat.setupTurns();
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  CHAT CARD BUTTON DELEGATION
//  TODO: Port individual action handlers from Reign entrypoint.
//        Structure is identical; remove sorcery/attunement/company actions.
// ═══════════════════════════════════════════════════════════════════════════════

Hooks.on("renderChatMessageHTML", (message, html) => {
  const element = (html instanceof HTMLElement) ? html : html?.firstElementChild || html;
  if (!element?.querySelectorAll) return;
  const msg = message;

  // ── Apply Damage (set-based) ──
  element.querySelectorAll(".apply-dmg-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const width = parseInt(btn.dataset.width);
      const height = parseInt(btn.dataset.height);
      const dmgFormula = btn.dataset.dmgString || btn.dataset.dmg || "Width Shock";
      const ap = parseInt(btn.dataset.ap) || 0;
      const areaDice = parseInt(btn.dataset.areaDice) || 0;
      const advancedMods = msg.flags?.["wild-talents-2e"]?.rollFlags?.advancedMods || {};
      const isMassive = !!(advancedMods.isMassive);
      const attackerActor = msg?.speaker?.actor ? game.actors.get(msg.speaker.actor) : null;
      await applyDamageToTarget(width, height, dmgFormula, ap, isMassive, areaDice, attackerActor, advancedMods);
    });
  });

  // ── Apply Scattered/Waste Damage ──
  element.querySelectorAll(".apply-waste-dmg-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const faces = btn.dataset.faces;
      const type = btn.dataset.type;
      const ap = parseInt(btn.dataset.ap) || 0;
      const advancedMods = msg.flags?.["wild-talents-2e"]?.rollFlags?.advancedMods || {};
      await applyScatteredDamageToTarget(faces, type, ap, null, advancedMods);
    });
  });

  // ── Apply Healing ──
  element.querySelectorAll(".apply-heal-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const width = parseInt(btn.dataset.width);
      const height = parseInt(btn.dataset.height);
      const healFormula = btn.dataset.heal || "Width Shock";
      await applyHealingToTarget(width, height, healFormula);
    });
  });

  // ── Apply First Aid ──
  element.querySelectorAll(".apply-first-aid-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const width = parseInt(btn.dataset.width);
      await applyFirstAidToTarget(width);
    });
  });

  // ── Gobble Dice (consume from attacker's set) ──
  element.querySelectorAll(".gobble-dmg-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      if (!msg.isAuthor && !game.user.isGM) return ui.notifications.warn("Only the GM or the rolling player can alter this roll's dice.");
      const heightToRemove = parseInt(btn.dataset.height);
      await consumeGobbleDie(msg, heightToRemove);
    });
  });

  // ── Assign Gobble Set (choose which set becomes gobble pool) ──
  element.querySelectorAll(".assign-gobble-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const width = parseInt(btn.dataset.width);
      const height = parseInt(btn.dataset.height);
      await assignGobbleSet(msg, width, height);
    });
  });

  // ── Assign Set to Action (multi-action) ──
  element.querySelectorAll(".assign-action-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const width = parseInt(btn.dataset.width);
      const height = parseInt(btn.dataset.height);
      const actionIndex = parseInt(btn.dataset.actionIndex) || 0;
      await assignSetToAction(msg, width, height, actionIndex);
    });
  });

  // ── Apply Maneuver Status ──
  element.querySelectorAll(".apply-maneuver-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      await applyManeuverStatus({
        maneuverKey:  btn.dataset.maneuverKey,
        applyStatus:  btn.dataset.applyStatus || "",
        clearStatus:  btn.dataset.clearStatus || "",
        setFlag:      btn.dataset.setFlag || "",
        statusTarget: btn.dataset.statusTarget || "target",
        slamShock:    parseInt(btn.dataset.slamShock) || 0,
        slamMultiLoc: btn.dataset.slamMultiLoc === "true",
        actorId:      msg?.speaker?.actor || ""
      });
    });
  });

  // ── Dive for Cover ──
  element.querySelectorAll(".wt-dive-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      await diveForCover(msg);
    });
  });

  // ── Morale Attack ──
  element.querySelectorAll(".apply-morale-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const moraleVal = parseInt(btn.dataset.width) || 1;
      const sourceDesc = btn.dataset.label || "Attack";
      await applyOffensiveMoraleAttack(moraleVal, sourceDesc);
    });
  });

  // ── Reroll ──
  element.querySelectorAll('[data-action="rerollLast"]').forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const actorId = msg?.speaker?.actor;
      const actor = actorId ? game.actors.get(actorId) : null;
      if (!actor) return ui.notifications.warn("Cannot determine rolling actor for reroll.");
      const lastContext = actor.getFlag(SYSTEM_ID, "lastRollContext");
      if (!lastContext) return ui.notifications.warn("No previous roll context found for this character.");
      await CharacterRoller.reroll(actor, lastContext);
    });
  });

  // ── Roll Request (GM toolbar) ──
  element.querySelectorAll(".fulfil-request-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      await fulfillRollRequest(msg);
    });
  });

  // ── Poison Resist ──
  element.querySelectorAll(".venom-resist-btn, .poison-resist-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const resistType = btn.dataset.resistType || "vigor";
      const targetIds = btn.dataset.targetId || btn.dataset.targetIds || "";
      const difficulty = parseInt(btn.dataset.difficulty) || 0;
      await handlePoisonResist(resistType, targetIds, difficulty);
    });
  });

  // ── Shake It Off (WP spend to reduce damage) ──
  // 📖 WT Rulebook Ch3 p.53
  element.querySelectorAll(".shake-off-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const action = btn.dataset.action;
      const actorId = btn.dataset.actorId;
      const actor = actorId ? game.actors.get(actorId) : null;
      if (!actor) return ui.notifications.warn("Cannot find actor.");
      if (!actor.isOwner) return ui.notifications.warn("You do not own this character.");

      const currentWP = parseInt(actor.system.willpower?.current) || 0;
      const wpCost = action === "shakeOffKilling" ? 2 : 1;
      if (currentWP < wpCost) return ui.notifications.warn(`Not enough Willpower (need ${wpCost}, have ${currentWP}).`);

      // Prompt for location
      const locContent = `<form class="wt-dialog-form">
        <div class="form-group">
          <label>Location:</label>
          <select name="loc">
            <option value="head">Head</option>
            <option value="torso" selected>Torso</option>
            <option value="armR">Right Arm</option>
            <option value="armL">Left Arm</option>
            <option value="legR">Right Leg</option>
            <option value="legL">Left Leg</option>
          </select>
        </div>
      </form>`;

      const loc = await wtDialog("Shake It Off — Choose Location", locContent,
        (e, b, d) => d.element.querySelector('[name="loc"]').value,
        { defaultLabel: "Apply" }
      );
      if (!loc) return;

      const health = actor.system.health;
      const updates = {};

      if (action === "shakeOffShock") {
        if ((health[loc]?.shock || 0) <= 0) return ui.notifications.warn("No Shock on that location.");
        updates[`system.health.${loc}.shock`] = health[loc].shock - 1;
        await actor.update(updates);
        await applyWillpowerChange(actor, -1, "Shake It Off (−1 Shock)");
      } else if (action === "shakeOffConvert") {
        if ((health[loc]?.killing || 0) <= 0) return ui.notifications.warn("No Killing on that location to convert.");
        updates[`system.health.${loc}.killing`] = health[loc].killing - 1;
        updates[`system.health.${loc}.shock`] = (health[loc].shock || 0) + 1;
        await actor.update(updates);
        await applyWillpowerChange(actor, -1, "Shake It Off (K→S)");
      } else if (action === "shakeOffKilling") {
        if ((health[loc]?.killing || 0) <= 0) return ui.notifications.warn("No Killing on that location.");
        updates[`system.health.${loc}.killing`] = health[loc].killing - 1;
        await actor.update(updates);
        await applyWillpowerChange(actor, -2, "Shake It Off (−1 Kill)");
      }

      const { syncCharacterStatusEffects } = await import("./combat/damage.js");
      await syncCharacterStatusEffects(actor);
    });
  });

  // ── Stay Alive (WP spend to survive one round) ──
  // 📖 WT Rulebook Ch3 p.53
  element.querySelectorAll(".stay-alive-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const actorId = btn.dataset.actorId;
      const actor = actorId ? game.actors.get(actorId) : null;
      if (!actor) return ui.notifications.warn("Cannot find actor.");
      if (!actor.isOwner) return ui.notifications.warn("You do not own this character.");

      const currentWP = parseInt(actor.system.willpower?.current) || 0;
      if (currentWP < 1) return ui.notifications.warn("Not enough Willpower to Stay Alive.");

      // Remove dead status, apply unconscious instead
      const deadEffect = actor.effects.find(e => e.statuses.has("dead"));
      if (deadEffect) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", [deadEffect.id]);
      }

      // Set flag for tracking expiry
      if (game.combat) {
        const combatant = game.combat.combatants.find(c => c.actorId === actor.id);
        if (combatant) {
          await combatant.setFlag("wild-talents-2e", "stayAliveRound", game.combat.round);
        }
      }

      await applyWillpowerChange(actor, -1, "Stay Alive!");

      const safeName = foundry.utils.escapeHTML(actor.name);
      await ChatMessage.create({
        content: `<div class="wt-chat-card wt-card-success">
          <h3><i class="fas fa-heartbeat"></i> Staying Alive!</h3>
          <p><strong>${safeName}</strong> spends 1 Willpower to cling to life — unconscious but alive for one more round.</p>
        </div>`
      });

      // Disable the button after use
      btn.disabled = true;
      btn.textContent = "Used";
    });
  });

  // ── Wake Up (unconscious → risk half WP for Endurance roll) ──
  // 📖 WT Rulebook Ch3 p.52: "In the declaration phase, if you're unconscious
  //     you can risk half your Willpower to make an Endurance roll. If you succeed,
  //     you regain consciousness for width in rounds and lose only one point of
  //     Willpower. If you fail, you remain unconscious and lose half your Willpower."
  element.querySelectorAll(".wake-up-btn").forEach(btn => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      const actorId = btn.dataset.actorId;
      const actor = actorId ? game.actors.get(actorId) : null;
      if (!actor) return ui.notifications.warn("Cannot find actor.");
      if (!actor.isOwner) return ui.notifications.warn("You do not own this character.");

      const currentWP = parseInt(actor.system.willpower?.current) || 0;
      if (currentWP < 1) return ui.notifications.warn("No Willpower remaining to attempt Wake Up.");

      const halfWP = Math.floor(currentWP / 2);
      const safeName = foundry.utils.escapeHTML(actor.name);

      // Confirm the risk
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Wake Up — Risk Willpower", classes: ["wt-dialog-window"] },
        position: { height: "auto" },
        content: `<div class="wt-dialog-form">
          <p><strong>${safeName}</strong> is unconscious and wants to fight back to consciousness.</p>
          <p>This risks <strong>${halfWP} Willpower</strong> (half of ${currentWP}) on a Body + Endurance roll.</p>
          <p><strong>Success:</strong> Conscious for Width rounds, lose only 1 WP.</p>
          <p><strong>Failure:</strong> Remain unconscious, lose ${halfWP} WP.</p>
        </div>`,
        rejectClose: false
      });
      if (!confirmed) return;

      // Roll Body + Endurance
      const sys = actor.system;
      const bodyData = sys.attributes?.body || {};
      const bodyTotal = (parseInt(bodyData.normal) || 0) + (parseInt(bodyData.hard) || 0) + (parseInt(bodyData.wiggle) || 0);
      const enduranceSkill = Object.values(sys.skills || {}).find(s => (s.label || "").toLowerCase() === "endurance");
      const enduranceTotal = enduranceSkill
        ? ((parseInt(enduranceSkill.value) || 0) + (parseInt(enduranceSkill.hard) || 0) + (parseInt(enduranceSkill.wiggle) || 0))
        : 0;
      const pool = Math.max(1, bodyTotal + enduranceTotal);

      const roll = new Roll(`${pool}d10`);
      await roll.evaluate();
      const results = roll.dice[0]?.results.map(r => r.result) || [];
      const parsed = parseORE(results);
      const hasSet = parsed.sets.length > 0;

      if (hasSet) {
        // Success: conscious for Width rounds, lose only 1 WP
        const bestWidth = Math.max(...parsed.sets.map(s => s.width));
        await applyWillpowerChange(actor, -1, "Wake Up (success)", { silent: true });

        // Remove unconscious status
        const uncEffect = actor.effects.find(e => e.statuses.has("unconscious"));
        if (uncEffect) await actor.deleteEmbeddedDocuments("ActiveEffect", [uncEffect.id]);

        // Track consciousness duration
        if (game.combat) {
          const combatant = game.combat.combatants.find(c => c.actorId === actor.id);
          if (combatant) {
            await combatant.setFlag("wild-talents-2e", "wakeUpExpiresRound", game.combat.round + bestWidth);
          }
        }

        const diceDisplay = results.sort((a, b) => b - a).map(r => `<span class="wt-die wt-die-plain">${r}</span>`).join(" ");
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<div class="wt-chat-card wt-card-success">
            <h3><i class="fas fa-eye-open"></i> Waking Up!</h3>
            <div class="dice-tray wrap">${diceDisplay}</div>
            <p><strong>${safeName}</strong> claws back to consciousness! Active for <strong>${bestWidth} round${bestWidth !== 1 ? "s" : ""}</strong>.</p>
            <p class="wt-text-small wt-text-muted">Lost 1 Willpower (${parseInt(actor.system.willpower?.current) || 0} remaining).</p>
          </div>`,
          rolls: [roll]
        });
      } else {
        // Failure: remain unconscious, lose half WP
        await applyWillpowerChange(actor, -halfWP, "Wake Up (failed)", { silent: true });

        const diceDisplay = results.sort((a, b) => b - a).map(r => `<span class="wt-die wt-die-plain">${r}</span>`).join(" ");
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<div class="wt-chat-card wt-card-critical">
            <h3><i class="fas fa-bed"></i> Wake Up Failed</h3>
            <div class="dice-tray wrap">${diceDisplay}</div>
            <p><strong>${safeName}</strong> fails to regain consciousness.</p>
            <p class="wt-text-danger">Lost <strong>${halfWP} Willpower</strong> (${parseInt(actor.system.willpower?.current) || 0} remaining).</p>
          </div>`,
          rolls: [roll]
        });
      }

      btn.disabled = true;
      btn.textContent = hasSet ? "Awake!" : "Failed";
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  COMBAT TRACKER INJECTION
//  📖 WT Rulebook Ch4 p.60: Declare → Roll → Resolve phase structure.
//  Injects phase toggle buttons, wound penalty banners, and declaration
//  status indicators into Foundry's native combat tracker.
// ═══════════════════════════════════════════════════════════════════════════════

Hooks.on("renderCombatTracker", (app, html) => {
  const combat = game.combat;
  if (!combat?.started) return;

  const element = html instanceof HTMLElement ? html : html[0];
  if (!element) return;

  const phase = combat.getFlag("wild-talents-2e", "phase") || "declaration";
  const isDeclaring = phase === "declaration";
  const isGM = game.user.isGM;

  // ── Phase Toggle Buttons ──
  if (!element.querySelector(".wt-combat-phase-control")) {
    const phaseDiv = document.createElement("div");
    phaseDiv.className = "wt-combat-phase-control";
    phaseDiv.innerHTML = `
      <button class="wt-phase-btn wt-declare-btn ${isDeclaring ? 'wt-phase-active' : ''}" data-phase="declaration">
        <i class="fas fa-eye"></i> Declare
      </button>
      <button class="wt-phase-btn wt-resolve-btn ${!isDeclaring ? 'wt-phase-active' : ''}" data-phase="resolution">
        <i class="fas fa-bolt"></i> Resolve
      </button>
    `;

    const header = element.querySelector(".combat-tracker-header");
    if (header) header.insertAdjacentElement("afterend", phaseDiv);

    if (isGM) {
      phaseDiv.querySelectorAll(".wt-phase-btn").forEach(btn => {
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const activeCombat = game.combats.get(combat.id);
          if (!activeCombat) return;
          const newPhase = ev.currentTarget.dataset.phase;
          if (phase !== newPhase) {
            await activeCombat.setFlag("wild-talents-2e", "phase", newPhase);
            activeCombat.setupTurns();
          }
        });
      });
    } else {
      phaseDiv.querySelectorAll(".wt-phase-btn").forEach(btn => {
        btn.disabled = true;
      });
    }
  }

  // ── Wound Penalty Banner ──
  const currentTurn = combat.combatant;
  if (currentTurn?.actor) {
    const statuses = Array.from(currentTurn.actor.statuses);
    const penalties = [];
    if (statuses.includes("dazed")) penalties.push("DAZED (−1d)");
    if (statuses.includes("prone")) penalties.push("PRONE (−1d)");
    if (statuses.includes("blind")) penalties.push("BLIND (−2d Ranged / Diff 4 Melee)");
    if (statuses.includes("zeroWillpower")) penalties.push("ZERO WP (powers halved)");

    const phaseControl = element.querySelector(".wt-combat-phase-control");
    if (penalties.length > 0 && !element.querySelector(".wt-wound-banner") && phaseControl) {
      const banner = document.createElement("div");
      banner.className = "wt-wound-banner";
      banner.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Current Turn Penalties: <span>${penalties.join(" | ")}</span>`;
      phaseControl.insertAdjacentElement("afterend", banner);
    }
  }

  // ── Per-Combatant Declaration Status ──
  const combatants = element.querySelectorAll(".combatant");
  combatants.forEach(li => {
    const cid = li.dataset.combatantId;
    const c = combat.combatants.get(cid);
    if (!c) return;

    const isDeclared = c.getFlag("wild-talents-2e", "declared") || false;
    const initDiv = li.querySelector(".token-initiative");

    if (initDiv && isDeclaring) {
      // Replace initiative display with declaration toggle
      const rollBtn = initDiv.querySelector(".roll");
      if (rollBtn) rollBtn.style.display = "none";

      // Only add if not already injected
      if (!initDiv.querySelector(".wt-declare-btn")) {
        const declBtn = document.createElement("a");
        declBtn.className = `combatant-control wt-declare-btn ${isDeclared ? 'wt-declared' : 'wt-pending'}`;
        declBtn.dataset.combatantId = cid;
        declBtn.title = isDeclared ? "Declaration Confirmed" : "Confirm Declaration";
        declBtn.innerHTML = `<i class="${isDeclared ? 'fas fa-check-circle' : 'far fa-circle'}"></i>`;

        declBtn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const activeCombat = game.combats.get(combat.id);
          if (!activeCombat) return;
          const activeCombatant = activeCombat.combatants.get(cid);
          if (!activeCombatant) return;
          if (!isGM && !activeCombatant.isOwner) {
            return ui.notifications.warn("You do not own this combatant.");
          }
          await activeCombatant.setFlag("wild-talents-2e", "declared", !isDeclared);
        });

        initDiv.appendChild(declBtn);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  POST-COMBAT CLEANUP
//  TODO: Port from Reign entrypoint (deleteCombat hook).
// ═══════════════════════════════════════════════════════════════════════════════

Hooks.on("deleteCombat", async (combat) => {
  if (!game.user.isGM) return;

  // 📖 WT Rulebook: Post-combat Shock recovery for all PC combatants.
  // performPostCombatRecovery rounds down per WT "ALWAYS ROUND DOWN" rule.
  for (const combatant of combat.combatants) {
    const actor = combatant.actor;
    if (actor?.type === "character") {
      try {
        await performPostCombatRecovery(actor);
      } catch (err) {
        console.error(`WT | Post-combat recovery failed for ${actor.name}:`, err);
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SCENE CONTROLS
// ═══════════════════════════════════════════════════════════════════════════════

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  // V14: controls is a keyed object, not an array
  const tokenControls = controls.tokens;
  if (!tokenControls?.tools) return;
  tokenControls.tools.hazardRoller = {
    name: "hazardRoller", title: "Hazard Roller", icon: "fas fa-fire",
    onClick: () => openHazardRoller(), button: true
  };
  // TODO: Increment 4 — Power Activation Tracker button
});

// ═══════════════════════════════════════════════════════════════════════════════
//  DICE SO NICE
// ═══════════════════════════════════════════════════════════════════════════════

Hooks.once("diceSoNiceReady", (dice3d) => {
  dice3d.addColorset({
    name: "wild-talents-2e", description: "Wild Talents 2e",
    category: "Wild Talents 2e",
    foreground: "#ffffff", background: "#1a237e",
    outline: "#ffffff", edge: "#0d47a1",
    material: "metal", font: "Arial Black"
  }, "default");
  // TODO: Increment 3 — HD (red) and WD (blue) coloursets
});

// ═══════════════════════════════════════════════════════════════════════════════
//  QUICK DICE ROLLER
// ═══════════════════════════════════════════════════════════════════════════════

async function openQuickDiceRoller() {
  const content = `<div class="wt-dialog-form">
    <div class="form-group">
      <label>Number of d10s</label>
      <input type="number" id="quickDiceCount" value="5" min="1" max="15"/>
    </div></div>`;
  const count = await wtDialog("Quick ORE Roll", content,
    (e, b, d) => parseInt(d.element.querySelector("#quickDiceCount")?.value) || 5,
    { defaultLabel: "Roll!" });
  if (count == null) return;
  const roll = new Roll(`${Math.min(count, 15)}d10`);
  await roll.evaluate();
  const results = roll.dice[0]?.results.map(r => r.result) || [];
  const parsed = parseORE(results);
  let html = `<div class="wt-chat-card"><h3>Quick Roll: ${count}d10</h3>`;
  html += `<p><strong>Results:</strong> ${results.sort((a, b) => b - a).join(", ")}</p>`;
  if (parsed.sets.length > 0) html += `<p><strong>Sets:</strong> ${parsed.sets.map(s => s.text).join(", ")}</p>`;
  if (parsed.waste.length > 0) html += `<p><strong>Waste:</strong> ${parsed.waste.join(", ")}</p>`;
  html += `</div>`;
  await ChatMessage.create({ content: html, speaker: ChatMessage.getSpeaker(), rolls: [roll] });
}
