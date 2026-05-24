// scripts/apps/gm-toolbar.js
// ════════════════════════════════════════════════════════════════════════════
//  WT GM TOOLBAR — Frameless HUD Shell (Tier 1)
//  Persistent top-centre bar with contextual drop-down panel.
//  GM-only. Two-layer architecture:
//    Layer 1 — Persistent Bar: World Month, Combat Phase, Party Vitals (Tier 2), Section Toggles
//    Layer 2 — Context Panel: Quick Roll (default), future Token Peek / Contest / Reference
// ════════════════════════════════════════════════════════════════════════════

import { postOREChat, generateOREChatHTML } from "../helpers/chat.js";
import { calculateWTPool, CharacterRoller } from "../helpers/character-roller.js";
import { parseORE } from "../helpers/ore-engine.js";
import { ThreatRoller } from "../helpers/threat-roller.js";
import { XPAwardPanel }     from "./xp-award.js";
import { openHazardRoller } from "../combat/hazards.js";
import { applyWillpowerChange } from "../combat/damage.js";
import { wtDialog } from "../helpers/dialog-util.js";
import { BaseORERoller } from "../helpers/base-roller.js";
import { SUGGESTED_SKILLS } from "../helpers/config.js";
// NOTE: FactionDashboard, SpellTracker, WealthRoller removed — no WT equivalent

const { renderTemplate } = foundry.applications.handlebars;

// ─── Constants ───────────────────────────────────────────────────────────────

const TEMPLATE_PATH = "systems/wild-talents-2e/templates/apps/gm-toolbar.hbs";
const TOOLBAR_ID    = "wt-gm-toolbar";

// ─── Utility ─────────────────────────────────────────────────────────────────

/** Derive the current world month from the highest chronicle entry across all companies. */
function _getWorldMonth() {
  let month = 0;
  for (const c of game.actors.filter(a => a.type === "company")) {
    for (const entry of (c.system.chronicle || [])) {
      if (entry.month > month) month = entry.month;
    }
  }
  return month || 1;
}

/** Get a compact combat summary for the persistent bar. */
function _getCombatSummary() {
  const combat = game.combat;
  if (!combat?.started) return null;
  const phase = combat.getFlag("wild-talents-2e", "phase") || "declaration";
  const round = combat.round || 1;
  const total = combat.combatants.size;
  const declared = combat.combatants.filter(c => c.getFlag("wild-talents-2e", "declared")).length;
  const currentName = combat.combatant?.name || "—";
  return { phase, round, total, declared, currentName, isDeclaring: phase === "declaration" };
}

/** Scan selected token for best attribute+skill pool to pre-populate Quick Roll. */
function _getTokenPoolHint() {
  const token = canvas?.tokens?.controlled?.[0];
  if (!token?.actor) return null;
  const actor = token.actor;
  if (actor.type !== "character" && actor.type !== "threat") return null;

  if (actor.type === "threat") {
    // Threat: pool = magnitude for mobs, or first attack for creatures
    if (actor.system.creatureMode) {
      const attacks = actor.system.creatureAttacks || [];
      if (attacks.length > 0) {
        const atk = attacks[0];
        const attrVal = actor.system.creatureAttributes?.[atk.attribute] || 0;
        const skillVal = actor.system.creatureSkills?.[atk.skill]?.value || 0;
        return { label: `${actor.name}: ${atk.name || "Attack"}`, pool: attrVal + skillVal, actorName: actor.name };
      }
    }
    const mag = actor.system.magnitude?.value || 0;
    return { label: `${actor.name}: Mob Attack`, pool: mag, actorName: actor.name };
  }

  // Character: find highest attribute+skill combination
  const attrs = actor.system.attributes || {};
  const skills = actor.system.skills || {};
  let bestPool = 0;
  let bestLabel = "";

  for (const [aKey, aData] of Object.entries(attrs)) {
    const aVal = parseInt(aData.value) || 0;
    for (const [sKey, sData] of Object.entries(skills)) {
      const sVal = parseInt(sData.value) || 0;
      if (aVal + sVal > bestPool) {
        bestPool = aVal + sVal;
        bestLabel = `${aKey.charAt(0).toUpperCase() + aKey.slice(1)} + ${sKey.charAt(0).toUpperCase() + sKey.slice(1)}`;
      }
    }
  }
  return bestPool > 0 ? { label: `${actor.name}: ${bestLabel}`, pool: bestPool, actorName: actor.name } : null;
}

const HEALTH_LOCS = ["head", "torso", "armR", "armL", "legR", "legL"];

/** Build vitals data for PCs, GMCs, and threats.
 *  PCs (system.isGMC === false): always shown, assigned or not.
 *  GMC characters (system.isGMC === true): shown only with a token on canvas.
 *  Threats: shown only with a token on canvas.
 *  Sorted by combat turn order during encounters, alphabetically otherwise. */
function _getPartyVitals() {
  const combat = game.combat?.started ? game.combat : null;
  const sceneTokens = canvas?.tokens?.placeables || [];

  // ── Gather PCs (isGMC false) — always visible ──
  const pcs = game.actors.filter(a => a.type === "character" && !a.system.isGMC);

  // ── Gather GMC characters with tokens on canvas ──
  const gmcActorIds = new Set();
  const gmcs = [];
  for (const token of sceneTokens) {
    const actor = token.actor;
    if (!actor || actor.type !== "character" || !actor.system.isGMC) continue;
    if (gmcActorIds.has(actor.id)) continue;
    gmcActorIds.add(actor.id);
    gmcs.push(actor);
  }

  // ── Gather threats with tokens on canvas ──
  const threatActorIds = new Set();
  const threats = [];
  for (const token of sceneTokens) {
    const actor = token.actor;
    if (!actor || actor.type !== "threat") continue;
    if (threatActorIds.has(actor.id)) continue; // Dedupe linked tokens
    threatActorIds.add(actor.id);
    threats.push(actor);
  }

  // ── Build entries ──
  const entries = [];

  for (const actor of pcs) {
    entries.push(_buildCharacterVital(actor, combat, false));
  }

  for (const actor of gmcs) {
    entries.push(_buildCharacterVital(actor, combat, true));
  }

  for (const actor of threats) {
    entries.push(_buildThreatVital(actor, combat));
  }

  // ── Sort ──
  if (combat) {
    const phase = combat.getFlag("wild-talents-2e", "phase") || "declaration";

    if (phase === "declaration") {
      // Declaration phase: mirror the RAW declaration order from _sortCombatants.
      // Within each declared/undeclared group: Sense asc → GMC before PC → Sight asc.
      // Non-combatants go last. Declared combatants go after undeclared (they've acted).
      entries.sort((a, b) => {
        const combA = combat.combatants.find(c => c.actorId === a.id);
        const combB = combat.combatants.find(c => c.actorId === b.id);
        const inA = !!combA;
        const inB = !!combB;
        // Non-combatants last
        if (inA !== inB) return inA ? -1 : 1;
        if (inA && inB) {
          // Declared combatants after undeclared
          const declA = combA.getFlag("wild-talents-2e", "declared") ? 1 : 0;
          const declB = combB.getFlag("wild-talents-2e", "declared") ? 1 : 0;
          if (declA !== declB) return declA - declB;
          // Within the same declared state, apply RAW declaration commitment order
          // 1. Sense ascending (least aware declares first)
          const senseA = combA.actor?.system?.attributes?.sense?.value ?? 0;
          const senseB = combB.actor?.system?.attributes?.sense?.value ?? 0;
          if (senseA !== senseB) return senseA - senseB;
          // 2. GMC before PC (tied Sense: GMC declares first per RAW)
          const isPcA = combA.actor?.system?.isGMC ? 0 : 1;
          const isPcB = combB.actor?.system?.isGMC ? 0 : 1;
          if (isPcA !== isPcB) return isPcA - isPcB;
          // 3. Sight ascending (tiebreaker within same type)
          const sightA = combA.actor?.system?.skills?.sight?.value ?? 0;
          const sightB = combB.actor?.system?.skills?.sight?.value ?? 0;
          if (sightA !== sightB) return sightA - sightB;
        }
        return a.name.localeCompare(b.name);
      });
    } else {
      // Resolve phase: sort by initiative descending (higher = faster = acts first in ORE)
      // Combatants with no initiative yet go to the end
      entries.sort((a, b) => {
        const combA = combat.combatants.find(c => c.actorId === a.id);
        const combB = combat.combatants.find(c => c.actorId === b.id);
        const inA = !!combA;
        const inB = !!combB;
        if (inA !== inB) return inA ? -1 : 1;
        if (inA && inB) {
          const initA = combA.initiative ?? -1;
          const initB = combB.initiative ?? -1;
          if (initA !== initB) return initB - initA; // Higher initiative first
        }
        return a.name.localeCompare(b.name);
      });
    }
  } else {
    // Out of combat: PCs alphabetical, then threats alphabetical
    entries.sort((a, b) => {
      if (a.isPC !== b.isPC) return a.isPC ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  return entries;
}

/** Build a vitals entry for a character actor.
 *  @param {boolean} isGMC — true if this character is marked as GMC on the sheet. */
function _buildCharacterVital(actor, combat, isGMC = false) {
  const health = actor.system.health || {};
  const effMax  = actor.system.effectiveMax || {};

  let worstState = "healthy";
  for (const loc of HEALTH_LOCS) {
    const killing = parseInt(health[loc]?.killing) || 0;
    const shock   = parseInt(health[loc]?.shock)   || 0;
    const max     = parseInt(effMax[loc])           || 5;
    if (killing >= max) { worstState = "critical"; break; }
    if (killing > 0 && worstState !== "critical") worstState = "wounded";
    if (shock > 0 && worstState === "healthy") worstState = "shocked";
  }

  const statuses = Array.from(actor.statuses || []);
  if (statuses.includes("dead"))        worstState = "dead";
  if (statuses.includes("unconscious")) worstState = "dead";

  const conditions = statuses.filter(s => ["dazed","prone","blind","pinned","restrained","bleeding"].includes(s));

  let declared = null;
  let initiative = null;
  let phase = null;
  if (combat) {
    phase = combat.getFlag("wild-talents-2e", "phase") || "declaration";
    const combatant = combat.combatants.find(c => c.actorId === actor.id);
    if (combatant) {
      declared = !!combatant.getFlag("wild-talents-2e", "declared");
      initiative = combatant.initiative;
    }
  }

  return {
    id: actor.id, name: actor.name,
    img: actor.img || "icons/svg/mystery-man.svg",
    worstState, conditions,
    hasConditions: conditions.length > 0,
    declared, inCombat: declared !== null,
    initiative, hasInitiative: initiative !== null && initiative !== undefined,
    isResolvePhase: phase !== "declaration" && phase !== null,
    isPC: !isGMC, isGMC, isThreat: false
  };
}

/** Build a vitals entry for a threat actor (mob or creature). */
function _buildThreatVital(actor, combat) {
  const sys = actor.system;
  const isCreature = !!sys.creatureMode;
  let worstState = "healthy";

  if (isCreature) {
    // Creature: scan custom locations like character health
    for (const loc of (sys.customLocations || [])) {
      const killing = loc.killing || 0;
      const shock   = loc.shock || 0;
      const max     = loc.woundBoxes || 5;
      if (killing >= max) { worstState = "critical"; break; }
      if (killing > 0 && worstState !== "critical") worstState = "wounded";
      if (shock > 0 && worstState === "healthy") worstState = "shocked";
    }
  } else {
    // Mob: health state from magnitude ratio
    const mag = parseInt(sys.magnitude?.value) || 0;
    const magMax = parseInt(sys.magnitude?.max) || 1;
    const ratio = mag / magMax;
    if (mag <= 0)        worstState = "dead";
    else if (ratio < 0.25) worstState = "critical";
    else if (ratio < 0.5)  worstState = "wounded";
    else if (ratio < 1)    worstState = "shocked";
    // Check morale
    const morale = parseInt(sys.morale?.value) || 0;
    if (morale <= 0 && mag > 0) worstState = "critical";
  }

  let declared = null;
  let initiative = null;
  let phase = null;
  if (combat) {
    phase = combat.getFlag("wild-talents-2e", "phase") || "declaration";
    const combatant = combat.combatants.find(c => c.actorId === actor.id);
    if (combatant) {
      declared = !!combatant.getFlag("wild-talents-2e", "declared");
      initiative = combatant.initiative;
    }
  }

  return {
    id: actor.id, name: actor.name,
    img: actor.img || "icons/svg/mystery-man.svg",
    worstState, conditions: [],
    hasConditions: false,
    declared, inCombat: declared !== null,
    initiative, hasInitiative: initiative !== null && initiative !== undefined,
    isResolvePhase: phase !== "declaration" && phase !== null,
    isPC: false, isThreat: true
  };
}

// ─── Condition Definitions ───────────────────────────────────────────────────

const CONDITIONS = [
  { id: "dazed",      icon: "fas fa-dizzy",        label: "Dazed",      effect: "−1d all actions" },
  { id: "prone",      icon: "fas fa-arrow-down",   label: "Prone",      effect: "−1d combat actions" },
  { id: "blind",      icon: "fas fa-eye-slash",    label: "Blind",      effect: "Diff 4 melee / −2d ranged" },
  { id: "pinned",     icon: "fas fa-thumbtack",    label: "Pinned",     effect: "Cannot move" },
  { id: "restrained", icon: "fas fa-lock",         label: "Restrained", effect: "Cannot act" },
  { id: "bleeding",   icon: "fas fa-tint",         label: "Bleeding",   effect: "Ongoing damage" },
  { id: "maimed",     icon: "fas fa-bone",         label: "Maimed",     effect: "Limb destroyed" },
  { id: "unconscious",icon: "fas fa-bed",          label: "Unconscious",effect: "Head filled with Shock" },
  { id: "dead",       icon: "fas fa-skull",        label: "Dead",       effect: "Head/Torso filled with Killing" }
];

const QUALITY_KEYS  = ["might", "treasure", "influence", "territory", "sovereignty"];
const QUALITY_ICONS = { might: "fas fa-fist-raised", treasure: "fas fa-coins", influence: "fas fa-eye", territory: "fas fa-chess-rook", sovereignty: "fas fa-crown" };
const QUALITY_LABELS = { might: "Might", treasure: "Treasure", influence: "Influence", territory: "Territory", sovereignty: "Sovereignty" };

// ─── Token Peek Data ─────────────────────────────────────────────────────────

/** Build peek data for the currently selected token. Returns null if no token. */
function _getTokenPeekData(expandedAttr = null, showSpells = false) {
  const token = canvas?.tokens?.controlled?.[0];
  if (!token?.actor) return null;
  const actor = token.actor;
  const type = actor.type;
  const statuses = new Set(actor.statuses || []);
  const inCombat = !!game.combat?.started;

  const base = {
    actorId: actor.id,
    tokenId: token.id,
    name: actor.name,
    img: actor.img || "icons/svg/mystery-man.svg",
    type,
    isCharacter: type === "character",
    isThreat: type === "threat",
    isCompany: type === "company"
  };

  // ── CHARACTER ──
  if (type === "character") {
    const sys = actor.system;
    const ATTR_KEYS = ["body", "coordination", "sense", "knowledge", "command", "charm"];
    const attrs = ATTR_KEYS.map(k => ({
      key: k, label: k.slice(0, 3).toUpperCase(), value: parseInt(sys.attributes?.[k]?.value) || 0,
      isExpanded: expandedAttr === k
    }));

    // Reverse skill map: attribute → skills under it
    // WT: Skills are freeform in system.skills with N/HD/WD dice composition.
    const skillsByAttr = {};
    for (const aKey of ATTR_KEYS) skillsByAttr[aKey] = [];
    for (const [sKey, sData] of Object.entries(sys.skills || {})) {
      const val = parseInt(sData?.value) || parseInt(sData?.normal) || 0;
      const hd = parseInt(sData?.hard) || 0;
      const wd = parseInt(sData?.wiggle) || 0;
      const attrKey = sData?.attribute || SUGGESTED_SKILLS[sKey] || "body";
      if (!skillsByAttr[attrKey]) skillsByAttr[attrKey] = [];
      const attrVal = parseInt(sys.attributes?.[attrKey]?.value) || 0;
      skillsByAttr[attrKey].push({
        key: sKey,
        label: sData?.label || sKey.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        value: val, hd, wd,
        pool: attrVal + val + hd + wd
      });
    }
    // Sort each group: highest pool first, then alphabetical
    for (const aKey of ATTR_KEYS) {
      if (skillsByAttr[aKey]) {
        skillsByAttr[aKey].sort((a, b) => b.pool - a.pool || a.label.localeCompare(b.label));
      }
    }

    // Expanded attribute skills (for dropdown)
    const expandedSkills = expandedAttr && skillsByAttr[expandedAttr] ? skillsByAttr[expandedAttr] : null;

    // ALL equipped weapons (not just first)
    const weapons = (actor.items || []).filter(i => i.type === "weapon" && i.system.equipped).map(w => ({
      id: w.id, name: w.name,
      damage: w.system.damage || "Width Shock",
      pool: w.system.pool || ""
    }));

    // Equipped shields
    const shields = (actor.items || []).filter(i => i.type === "shield" && i.system.equipped).map(s => ({
      name: s.name,
      parryBonus: parseInt(s.system.parryBonus) || 0,
      size: s.system.shieldSize || "small"
    }));
    const totalShieldBonus = shields.reduce((sum, s) => sum + s.parryBonus, 0);

    // Armor by location (for hover tooltip) — WT uses HAR + LAR
    const effHAR = sys.effectiveHAR || {};
    const effLAR = sys.effectiveLAR || {};
    const armorLocStr = ["head", "torso", "armR", "armL", "legR", "legL"]
      .map(k => {
        const har = effHAR[k] || 0;
        const lar = effLAR[k] || 0;
        const labels = { head: "Head", torso: "Torso", armR: "R.Arm", armL: "L.Arm", legR: "R.Leg", legL: "L.Leg" };
        const parts = [];
        if (har > 0) parts.push(`HAR${har}`);
        if (lar > 0) parts.push(`LAR${lar}`);
        return `${labels[k]}: ${parts.length > 0 ? parts.join("/") : "—"}`;
      }).join("  ·  ");

    // Armor weight
    const armors = (actor.items || []).filter(i => i.type === "armor" && i.system.equipped);
    const armorWeight = armors.length > 0 ? armors.reduce((w, a) => {
      const aw = a.system.armorWeight || a.system.derivedWeight || "light";
      return aw === "heavy" ? "heavy" : (aw === "medium" && w !== "heavy" ? "medium" : w);
    }, "light") : "none";

    // Techniques & Disciplines
    const techniques = (actor.items || []).filter(i => i.type === "technique").map(t => ({
      name: t.name, effect: t.system.effect || ""
    }));
    const disciplines = (actor.items || []).filter(i => i.type === "discipline").map(d => ({
      name: d.name, effect: d.system.effect || ""
    }));

    // WT: Powers are handled via Item documents on the character.

    // Conditions
    const conditions = CONDITIONS.map(c => ({ ...c, active: statuses.has(c.id) }));

    // Combat pools
    let combatPools = null;
    if (inCombat) {
      const body = parseInt(sys.attributes?.body?.value) || 0;
      const coord = parseInt(sys.attributes?.coordination?.value) || 0;
      const fight = parseInt(sys.skills?.fight?.value) || 0;
      const dodge = parseInt(sys.skills?.dodge?.value) || 0;
      const parry = parseInt(sys.skills?.parry?.value) || 0;
      combatPools = {
        attack: body + fight, dodge: coord + dodge,
        parry: body + parry + totalShieldBonus,
        hasShield: shields.length > 0
      };
    }

    base.attrs = attrs;
    base.expandedAttr = expandedAttr;
    base.expandedSkills = expandedSkills;
    base.hasExpandedSkills = !!expandedSkills;
    base.weapons = weapons;
    base.hasWeapons = weapons.length > 0;
    base.shields = shields;
    base.hasShields = shields.length > 0;
    base.armorWeight = armorWeight;
    base.armorLocStr = armorLocStr;
    base.wealth = parseInt(sys.wealth?.value) || 0;
    base.techniques = techniques;
    base.hasTechniques = techniques.length > 0;
    base.disciplines = disciplines;
    base.hasDisciplines = disciplines.length > 0;
    base.sorceryVal = 0;
    base.sorceryEd = 0;
    base.sorceryMd = 0;
    base.hasSorcery = false;
    base.spells = [];
    base.hasSpells = false;
    base.showSpells = showSpells;
    base.conditions = conditions;
    base.combatPools = combatPools;
    base.hasCombatPools = !!combatPools;
  }

  // ── THREAT ──
  if (type === "threat") {
    const sys = actor.system;
    const isCreature = !!sys.creatureMode;
    const magVal = parseInt(sys.magnitude?.value) || 0;
    const magMax = parseInt(sys.magnitude?.max) || magVal;
    const morVal = parseInt(sys.morale?.value) || 0;
    const morMax = parseInt(sys.morale?.max) || morVal;

    base.isCreature = isCreature;
    base.magnitude = { value: magVal, max: magMax, pct: magMax > 0 ? Math.round((magVal / magMax) * 100) : 0 };
    base.morale = { value: morVal, max: morMax, pct: morMax > 0 ? Math.round((morVal / morMax) * 100) : 0 };
    base.threatRating = parseInt(sys.threatLevel) || 1;
    base.damageFormula = sys.damageFormula || "Width Shock";

    if (isCreature) {
      base.creatureLocs = (sys.customLocations || []).map(loc => {
        const max = loc.woundBoxes || 5;
        const killing = loc.killing || 0;
        const shock = loc.shock || 0;
        let state = "healthy";
        if (killing >= max) state = "critical";
        else if (killing > 0) state = "wounded";
        else if (shock > 0) state = "shocked";
        return { name: loc.name, state, shock, killing, max, ar: loc.ar || 0 };
      });
      base.creatureAttacks = (sys.creatureAttacks || []).map(atk => ({
        name: atk.name || "Attack",
        damage: atk.damage || "Width Shock",
        index: (sys.creatureAttacks || []).indexOf(atk)
      }));
    }
  }

  // ── COMPANY ──
  if (type === "company") {
    const sys = actor.system;
    const pledges = sys.pledges || {};
    base.qualities = QUALITY_KEYS.map(key => {
      const q = sys.qualities?.[key] || {};
      const val = parseInt(q.value) || 0;
      const dmg = parseInt(q.damage) || 0;
      const uses = parseInt(q.uses) || 0;
      const eff = Math.max(0, val - dmg - uses);
      return {
        key, label: QUALITY_LABELS[key], icon: QUALITY_ICONS[key],
        value: val, damage: dmg, uses, effective: eff,
        isDamaged: dmg > 0, isUsed: uses > 0
      };
    });
    base.pledges = {
      bonus: parseInt(pledges.bonus) || 0,
      ed: parseInt(pledges.ed) || 0,
      md: parseInt(pledges.md) || 0
    };
    base.hasPledges = (base.pledges.bonus + base.pledges.ed + base.pledges.md) > 0;
  }

  return base;
}


// ═════════════════════════════════════════════════════════════════════════════
//  GM TOOLBAR CLASS
// ═════════════════════════════════════════════════════════════════════════════

export class GMToolbar {

  // ─── State ──────────────────────────────────────────────────────────────

  /** @type {HTMLElement|null} */
  element = null;

  /** Currently open panel section. null = collapsed. */
  activeSection = null;

  /** Theater mode active. */
  theaterMode = false;

  /** Last Quick Roll configuration for Re-roll. */
  lastRoll = null;

  /** Which attribute's skills are expanded in Token Peek. null = collapsed. */
  peekExpandedAttr = null;

  /** Whether the spell list is expanded in Token Peek. */
  peekShowSpells = false;

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Create and inject the toolbar into the DOM. Called once from Hooks.once("ready"). */
  async init() {
    if (!game.user.isGM) return;
    if (document.getElementById(TOOLBAR_ID)) return; // Already injected

    // Pre-load the template
    await foundry.applications.handlebars.loadTemplates([TEMPLATE_PATH]);

    // Build initial HTML
    const html = await this._renderHTML();
    const container = document.createElement("div");
    container.id = TOOLBAR_ID;
    container.innerHTML = html;
    document.body.appendChild(container);
    this.element = container;

    this._bindEvents();
    this._registerHooks();

    console.log("WT GM Toolbar | Initialised.");
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  async _renderHTML() {
    const data = this._prepareContext();
    return await renderTemplate(TEMPLATE_PATH, data);
  }

  _prepareContext() {
    const combat = _getCombatSummary();
    const tokenHint = _getTokenPoolHint();
    const vitals = _getPartyVitals();
    const peek = this.activeSection === "tokenpeek" ? _getTokenPeekData(this.peekExpandedAttr, this.peekShowSpells) : null;
    return {
      worldMonth: _getWorldMonth(),
      combat,
      hasCombat: !!combat,
      activeSection: this.activeSection,
      theaterMode: this.theaterMode,
      lastRoll: this.lastRoll,
      hasLastRoll: !!this.lastRoll,
      tokenHint,
      hasTokenHint: !!tokenHint,
      vitals,
      hasVitals: vitals.length > 0,
      peek,
      hasPeek: !!peek,
      // Quick Roll defaults
      qr: {
        label:   this.lastRoll?.label || "",
        pool:    tokenHint?.pool || this.lastRoll?.pool || 4,
        bonus:   0,
        penalty: 0,
        hd:      0,
        wd:      0,
        difficulty: 0
      }
    };
  }

  /** Re-render the entire toolbar (cheap — it's a small template). */
  async refresh() {
    if (!this.element) return;
    const html = await this._renderHTML();
    this.element.innerHTML = html;
    this._bindEvents();
  }

  /** Re-render only the persistent bar (combat indicator, month). */
  async refreshBar() {
    if (!this.element) return;
    const barEl = this.element.querySelector(".gt-bar");
    if (!barEl) return this.refresh();
    // Lightweight: just update the dynamic badges
    const combat = _getCombatSummary();
    const combatEl = barEl.querySelector(".gt-combat-indicator");
    if (combatEl) {
      if (combat) {
        combatEl.classList.remove("gt-hidden");
        const phaseIcon = combat.isDeclaring ? "fa-eye" : "fa-bolt";
        const phaseLabel = combat.isDeclaring ? "Declare" : "Resolve";
        const declCount = combat.isDeclaring ? `${combat.declared}/${combat.total} ✓` : "";
        combatEl.innerHTML = `<i class="fas ${phaseIcon}"></i> R${combat.round} · ${phaseLabel} ${declCount}`;
      } else {
        combatEl.classList.add("gt-hidden");
        combatEl.innerHTML = "";
      }
    }
    // World month
    const monthEl = barEl.querySelector(".gt-month-value");
    if (monthEl) monthEl.textContent = _getWorldMonth();
  }

  // ─── Quick Roll Pool Preview ────────────────────────────────────────────

  _updatePoolPreview() {
    const panel = this.element?.querySelector(".gt-panel-quickroll");
    if (!panel) return;
    const preview = panel.querySelector(".gt-qr-preview-value");
    if (!preview) return;

    const poolSize = Math.max(1, parseInt(panel.querySelector('[name="qrPool"]')?.value) || 1);
    const bonus    = parseInt(panel.querySelector('[name="qrBonus"]')?.value) || 0;
    const penalty  = parseInt(panel.querySelector('[name="qrPenalty"]')?.value) || 0;
    const hdCount  = parseInt(panel.querySelector('[name="qrHd"]')?.value) || 0;
    const wdCount  = parseInt(panel.querySelector('[name="qrWd"]')?.value) || 0;

    const rawTotal = poolSize + bonus;
    const poolMath = calculateWTPool(rawTotal, 0, 0, 0, penalty, 1, true);

    if (poolMath.diceToRoll < 1) {
      preview.innerHTML = `<span class="gt-text-danger">Pool too low</span>`;
    } else {
      const normalCount = Math.max(poolMath.normalDiceCount - hdCount - wdCount, 0);
      let display = `${normalCount}d10`;
      if (hdCount > 0) display += ` + ${hdCount}hd`;
      if (wdCount > 0) display += ` + ${wdCount}wd`;
      if (poolMath.wasCapped) display += ` <span class="gt-text-muted">(capped)</span>`;
      preview.innerHTML = display;
    }
  }

  // ─── Event Binding ──────────────────────────────────────────────────────

  _bindEvents() {
    if (!this.element) return;
    const el = this.element;

    // Section toggles
    el.querySelectorAll("[data-gt-action]").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const action = btn.dataset.gtAction;
        this._handleAction(action, btn);
      });
    });

    // Quick Roll inputs — live preview
    el.querySelectorAll(".gt-panel-quickroll input").forEach(input => {
      input.addEventListener("input", () => this._updatePoolPreview());
      input.addEventListener("change", () => this._updatePoolPreview());
    });

    // Initial pool preview
    if (this.activeSection === "quickroll") {
      this._updatePoolPreview();
    }

    // Vitals portraits — right-click opens sheet
    el.querySelectorAll(".gt-vitals-portrait").forEach(portrait => {
      portrait.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        this._handleAction("vitals-open-sheet", portrait);
      });
    });
  }

  // ─── Action Router ──────────────────────────────────────────────────────

  async _handleAction(action, target) {
    switch (action) {

      // ── Section Toggles ──
      case "toggle-quickroll":
        this.activeSection = this.activeSection === "quickroll" ? null : "quickroll";
        await this.refresh();
        break;

      case "toggle-tokenpeek":
        this.activeSection = this.activeSection === "tokenpeek" ? null : "tokenpeek";
        await this.refresh();
        break;

      // ── Theater Mode ──
      case "theater-toggle":
        this.theaterMode = !this.theaterMode;
        document.body.classList.toggle("wt-theater-mode", this.theaterMode);
        target.classList.toggle("gt-active", this.theaterMode);
        break;

      // ── Shortcuts ──
      case "open-factions":
        console.warn("WT | Faction dashboard removed — no WT equivalent.");
        break;

      case "open-hazards":
        openHazardRoller();
        break;

      case "open-spell-tracker":
        console.warn("WT | Spell tracker removed — power tracker pending.");
        break;

      case "open-xp-awards":
        new XPAwardPanel().render(true);
        break;

      case "advance-month":
        await this._advanceMonth();
        break;

      case "retreat-month":
        await this._retreatMonth();
        break;

      case "open-combat-tracker":
        document.querySelector('#sidebar [data-tab="combat"]')?.click();
        break;

      // ── Quick Roll ──
      case "qr-roll":
        await this._executeQuickRoll();
        break;

      case "qr-reroll":
        await this._executeReroll();
        break;

      case "qr-populate-token":
        this._populateFromToken();
        break;

      // ── Party Vitals ──
      case "vitals-select":
        this._selectVitalsToken(target);
        break;

      case "vitals-open-sheet":
        this._openVitalsSheet(target);
        break;

      // ── Token Peek Actions ──
      case "peek-open-sheet":
        this._peekOpenSheet();
        break;

      case "peek-toggle-condition":
        await this._peekToggleCondition(target);
        break;

      case "peek-roll-character":
        await this._peekRollCharacter(target);
        break;

      case "peek-roll-threat":
        await this._peekRollThreat(target);
        break;

      case "peek-roll-morale":
        await this._peekRollMorale();
        break;

      case "peek-roll-quality":
        await this._peekRollQuality(target);
        break;

      case "peek-expand-attr":
        this._peekExpandAttr(target);
        break;

      case "peek-toggle-spells":
        this.peekShowSpells = !this.peekShowSpells;
        await this.refresh();
        break;

      case "peek-roll-skill":
        await this._peekRollSkill(target);
        break;

      case "peek-rest":
        await this._peekRest();
        break;

      case "peek-first-aid":
        await this._peekFirstAid();
        break;

      case "peek-wealth":
        await this._peekWealth();
        break;

      // ── Roll Requests & Contests ──
      case "request-roll":
        await this._openRequestRollDialog();
        break;

      // ── Willpower Damage (GM) ──
      case "peek-wp-damage":
        await this._peekWillpowerDamage();
        break;
    }
  }

  // ─── Quick Roll Execution ───────────────────────────────────────────────

  async _executeQuickRoll() {
    const panel = this.element?.querySelector(".gt-panel-quickroll");
    if (!panel) return;

    const label    = panel.querySelector('[name="qrLabel"]')?.value?.trim() || game.i18n.localize("WT.QRDefaultLabel");
    const poolSize = Math.max(1, parseInt(panel.querySelector('[name="qrPool"]')?.value) || 1);
    const bonus    = parseInt(panel.querySelector('[name="qrBonus"]')?.value) || 0;
    const penalty  = parseInt(panel.querySelector('[name="qrPenalty"]')?.value) || 0;
    const hd       = parseInt(panel.querySelector('[name="qrHd"]')?.value) || 0;
    const wd       = parseInt(panel.querySelector('[name="qrWd"]')?.value) || 0;
    const diff     = parseInt(panel.querySelector('[name="qrDiff"]')?.value) || 0;

    const rawTotal = poolSize + bonus;
    const poolMath = calculateWTPool(rawTotal, 0, 0, 0, penalty, 1, true);

    if (poolMath.diceToRoll < 1) {
      return ui.notifications.warn(game.i18n.localize("WT.QRPoolTooLow"));
    }

    // Store for Re-roll
    this.lastRoll = { label, pool: poolSize, bonus, penalty, hd, wd, diff };

    // Roll normal dice (exclude HD and WD from random pool)
    const specialCount = hd + wd;
    const normalPool = Math.max(poolMath.normalDiceCount - specialCount, 0);
    let results = [];
    let actualRoll = null;
    if (normalPool > 0) {
      actualRoll = new Roll(`${normalPool}d10`);
      await actualRoll.evaluate();
      results = actualRoll.dice[0]?.results.map(r => r.result) || [];
    }

    // Hard Dice: always 10 (📖 Ch1 p.9)
    for (let i = 0; i < hd; i++) results.push(10);

    // Wiggle Dice: prompt for assignment (📖 Ch1 p.10)
    if (wd > 0) {
      const wdFaces = await BaseORERoller.promptWiggleDice(
        results, wd,
        Array.from({ length: hd }, () => ({ face: 10 })),
        "Assign Wiggle Dice"
      );
      if (!wdFaces) return;
      results.push(...wdFaces);
    }

    // Speaker
    const speakerActor = canvas?.tokens?.controlled?.[0]?.actor || game.user.character || null;
    const speaker = speakerActor
      ? ChatMessage.getSpeaker({ actor: speakerActor })
      : ChatMessage.getSpeaker({ user: game.user });

    // Chat card
    const actorType = speakerActor?.type || "character";
    const flavor = await generateOREChatHTML(
      actorType,
      foundry.utils.escapeHTML(label),
      poolMath.diceToRoll,
      results,
      hd,    // hardDieCount
      wd,    // wiggleDieCount
      null,
      { difficulty: diff }
    );

    const messageData = { speaker, content: flavor };
    if (actualRoll) messageData.rolls = [actualRoll];
    await ChatMessage.create(messageData);

    // Refresh to show Re-roll button
    await this.refresh();
  }

  async _executeReroll() {
    if (!this.lastRoll) return;
    const lr = this.lastRoll;

    // Populate inputs with last roll values and execute
    const panel = this.element?.querySelector(".gt-panel-quickroll");
    if (panel) {
      const setVal = (name, val) => { const el = panel.querySelector(`[name="${name}"]`); if (el) el.value = val; };
      setVal("qrLabel", lr.label);
      setVal("qrPool", lr.pool);
      setVal("qrBonus", lr.bonus);
      setVal("qrPenalty", lr.penalty);
      setVal("qrHd", lr.hd);
      setVal("qrWd", lr.wd);
      setVal("qrDiff", lr.diff);
    }
    await this._executeQuickRoll();
  }

  _populateFromToken() {
    const hint = _getTokenPoolHint();
    if (!hint) return ui.notifications.info("Select a token to pre-populate the pool.");
    const panel = this.element?.querySelector(".gt-panel-quickroll");
    if (!panel) return;
    const poolInput = panel.querySelector('[name="qrPool"]');
    const labelInput = panel.querySelector('[name="qrLabel"]');
    if (poolInput) poolInput.value = hint.pool;
    if (labelInput) labelInput.value = hint.label;
    this._updatePoolPreview();
  }

  // ─── Party Vitals Actions ──────────────────────────────────────────────

  /** Click portrait: select and pan to the PC's token on canvas. */
  _selectVitalsToken(target) {
    const actorId = target.closest("[data-actor-id]")?.dataset.actorId;
    if (!actorId) return;
    const token = canvas?.tokens?.placeables.find(t => t.actor?.id === actorId);
    if (token) {
      token.control({ releaseOthers: true });
      canvas.animatePan({ x: token.center.x, y: token.center.y, duration: 250 });
    } else {
      // No token on canvas — open sheet instead
      game.actors.get(actorId)?.sheet?.render(true);
    }
  }

  /** Right-click / double-click portrait: open the character sheet. */
  _openVitalsSheet(target) {
    const actorId = target.closest("[data-actor-id]")?.dataset.actorId;
    if (!actorId) return;
    game.actors.get(actorId)?.sheet?.render(true);
  }

  // ─── Token Peek Actions ─────────────────────────────────────────────────

  /** Get the actor from the currently selected token (used by all peek actions). */
  _peekActor() {
    return canvas?.tokens?.controlled?.[0]?.actor || null;
  }

  _peekOpenSheet() {
    this._peekActor()?.sheet?.render(true);
  }

  async _peekToggleCondition(target) {
    const actor = this._peekActor();
    const condId = target.dataset.conditionId;
    if (!actor || !condId) return;
    await actor.toggleStatusEffect(condId);
  }

  async _peekRollCharacter(target) {
    const actor = this._peekActor();
    if (!actor || actor.type !== "character") return;
    const rollType = target.dataset.rollType; // "attack", "dodge", "parry", or a skill key
    const dataset = {};

    if (rollType === "attack") {
      // Roll with best equipped weapon
      const weapon = (actor.items || []).find(i => i.type === "weapon" && i.system.equipped);
      if (weapon) {
        dataset.type = "item";
        dataset.itemId = weapon.id;
      } else {
        dataset.type = "skill";
        dataset.key = "fight";
      }
    } else if (rollType === "dodge") {
      dataset.type = "skill";
      dataset.key = "dodge";
    } else if (rollType === "parry") {
      dataset.type = "skill";
      dataset.key = "parry";
    } else {
      dataset.type = "skill";
      dataset.key = rollType || "fight";
    }

    await CharacterRoller.rollCharacter(actor, dataset);
  }

  /** Click an attribute label → expand/collapse its skills dropdown. */
  _peekExpandAttr(target) {
    const attrKey = target.dataset.attrKey;
    this.peekExpandedAttr = this.peekExpandedAttr === attrKey ? null : attrKey;
    this.refresh();
  }

  /** Click a skill in the dropdown → roll it via CharacterRoller. */
  async _peekRollSkill(target) {
    const actor = this._peekActor();
    if (!actor || actor.type !== "character") return;
    const skillKey = target.dataset.skillKey;
    if (!skillKey) return;
    const dataset = { type: "skill", key: skillKey };
    await CharacterRoller.rollCharacter(actor, dataset);
  }

  async _peekRollThreat(target) {
    const actor = this._peekActor();
    if (!actor || actor.type !== "threat") return;
    await ThreatRoller.rollThreat(actor, {});
  }

  async _peekRollMorale() {
    const actor = this._peekActor();
    if (!actor || actor.type !== "threat") return;
    await ThreatRoller.rollMorale(actor);
  }

  async _peekRollQuality(target) {
    const actor = this._peekActor();
    if (!actor || actor.type !== "company") return;
    const qualityKey = target.dataset.quality;
    if (!qualityKey) return;

    const q = actor.system.qualities?.[qualityKey];
    const pool = Math.max(0, (q?.value || 0) - (q?.damage || 0) - (q?.uses || 0));
    const qLabel = QUALITY_LABELS[qualityKey];

    if (pool < 1) return ui.notifications.warn(`${actor.name}'s ${qLabel} has no effective dice.`);

    const roll = new Roll(`${pool}d10`);
    await roll.evaluate();
    const results = roll.dice[0]?.results.map(r => r.result) || [];

    const breakdown = [{ label: qLabel, value: `${q.value}`, isPenalty: false }];
    if (q.damage > 0) breakdown.push({ label: "Damage", value: `−${q.damage}`, isPenalty: true });
    if (q.uses > 0) breakdown.push({ label: "Actions Used", value: `−${q.uses}`, isPenalty: true });

    await postOREChat(actor, `${qLabel} (${actor.name})`, pool, results, 0, 0, null, {
      poolBreakdown: breakdown
    });
  }

  // ─── Character Utility Actions ──────────────────────────────────────────

  /** Rest & Recover — delegates to the character sheet's dialog workflow. */
  async _peekRest() {
    const actor = this._peekActor();
    if (!actor || actor.type !== "character") return;
    // The sheet's _onRestAndRecover method handles all dialogs, rolls, and chat output.
    // It only uses this.document internally, so calling it on the sheet instance works
    // even if the sheet isn't rendered.
    const sheet = actor.sheet;
    await sheet._onRestAndRecover({ preventDefault: () => {} }, null);
  }

  /** First Aid — opens the Knowledge + Healing roll dialog via CharacterRoller,
   *  which properly handles ED/MD assignment. The resulting chat card has the
   *  "Apply First Aid" button for applying healing to a targeted token. */
  async _peekFirstAid() {
    const actor = this._peekActor();
    if (!actor || actor.type !== "character") return;
    await CharacterRoller.rollCharacter(actor, { key: "healing", type: "skill", label: "Healing (First Aid)" });
  }

  /** Wealth Check — opens the purchase dialog for the selected character. */
  async _peekWealth() {
    const actor = this._peekActor();
    if (!actor || actor.type !== "character") return;
    console.warn("WT | Wealth roller removed — no WT equivalent.");
  }

  /**
   * GM Willpower Damage — dialog to apply WP loss to a targeted character.
   * 📖 WT Rulebook Ch3 p.51-53: Willpower loss from Trauma, Defeat, or GM fiat.
   */
  async _peekWillpowerDamage() {
    // Target selection: use targeted tokens, fall back to peek actor
    const targets = Array.from(game.user.targets).map(t => t.actor).filter(a => a?.type === "character");
    const peekActor = this._peekActor();
    const actors = targets.length > 0 ? targets : (peekActor?.type === "character" ? [peekActor] : []);

    if (actors.length === 0) return ui.notifications.warn("Target a character token or select one in Token Peek.");

    const actorName = actors.map(a => foundry.utils.escapeHTML(a.name)).join(", ");
    const firstWP = parseInt(actors[0].system.willpower?.current) || 0;

    const content = `<form class="wt-dialog-form">
      <p>Applying Willpower damage to: <strong>${actorName}</strong></p>
      <div class="form-group">
        <label>Damage Type:</label>
        <select name="wpType">
          <option value="flat">Flat Amount</option>
          <option value="half">Half Current WP (Trauma/Defeat)</option>
          <option value="all">All Remaining WP</option>
        </select>
      </div>
      <div class="form-group">
        <label>Amount (for Flat):</label>
        <input type="number" name="wpAmount" value="1" min="1"/>
      </div>
      <div class="form-group">
        <label>Reason:</label>
        <input type="text" name="wpReason" value="" placeholder="e.g. Trauma Check, Defeat, Power Cost"/>
      </div>
    </form>`;

    const result = await wtDialog("Apply Willpower Damage", content, (e, b, d) => {
      const f = d.element.querySelector("form");
      return {
        type: f.querySelector('[name="wpType"]').value,
        amount: parseInt(f.querySelector('[name="wpAmount"]').value) || 1,
        reason: f.querySelector('[name="wpReason"]').value || "GM"
      };
    }, { defaultLabel: "Apply" });

    if (!result) return;

    for (const actor of actors) {
      const currentWP = parseInt(actor.system.willpower?.current) || 0;
      let delta;
      if (result.type === "half") {
        delta = -Math.floor(currentWP / 2);
      } else if (result.type === "all") {
        delta = -currentWP;
      } else {
        delta = -result.amount;
      }

      if (delta === 0 && result.type !== "half") {
        ui.notifications.info(`${actor.name} has no WP to lose.`);
        continue;
      }

      await applyWillpowerChange(actor, delta, result.reason);
    }
  }

  // ─── Roll Requests & Contests ───────────────────────────────────────────

  async _openRequestRollDialog() {
    // Gather participants from selected tokens, vitals PCs, or all characters
    const selected = canvas?.tokens?.controlled?.map(t => t.actor).filter(a => a?.type === "character") || [];
    let participants = selected.length > 0 ? selected : game.actors.filter(a => a.type === "character");

    if (participants.length === 0) return ui.notifications.warn("No characters available for a roll request.");

    // Build skill dropdown from SUGGESTED_SKILLS
    const skillOpts = Object.entries(SUGGESTED_SKILLS)
      .map(([sk, attr]) => {
        const sLabel = sk.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        const aLabel = attr.charAt(0).toUpperCase() + attr.slice(1);
        return `<option value="${sk}" data-attr="${attr}">${sLabel} (${aLabel})</option>`;
      })
      .sort()
      .join("");

    // Build participant checkboxes
    const partChecks = participants.map(a => {
      const checked = selected.length > 0 ? selected.some(s => s.id === a.id) : true;
      return `<label class="gt-rr-part"><input type="checkbox" name="part_${a.id}" value="${a.id}" ${checked ? "checked" : ""}/> ${foundry.utils.escapeHTML(a.name)}</label>`;
    }).join("");

    const content = `
      <form class="wt-dialog-form">
        <div class="form-group">
          <label>Participants:</label>
          <div class="gt-rr-participants">${partChecks}</div>
        </div>
        <div class="form-group">
          <label>Skill:</label>
          <select name="skill">${skillOpts}</select>
        </div>
        <div class="dialog-grid dialog-grid-2">
          <div class="form-group">
            <label>Difficulty:</label>
            <input type="number" name="difficulty" value="0" min="0" max="10"/>
          </div>
          <div class="form-group">
            <label>Penalty:</label>
            <input type="number" name="penalty" value="0" min="0"/>
          </div>
        </div>
        <div class="form-group">
          <label>Mode:</label>
          <select name="mode">
            <option value="simple">Simple Request</option>
            <option value="dynamic">Dynamic Contest (compare results)</option>
            <option value="opposed">Opposed Contest (gobble dice)</option>
          </select>
        </div>
        <div class="form-group" id="rr-resolver-group" style="display:none">
          <label>Winner determined by:</label>
          <select name="resolver">
            <option value="width">Width (speed / power)</option>
            <option value="height">Height (precision / fortune)</option>
          </select>
        </div>
        <div class="form-group">
          <label>Context (optional):</label>
          <input type="text" name="context" placeholder="e.g. climbing the wall, footrace"/>
        </div>
      </form>
    `;

    const result = await wtDialog("Request Roll", content, (e, b, d) => {
      const f = d.element.querySelector("form");
      const skillSelect = f.querySelector('[name="skill"]');
      const selectedOpt = skillSelect.options[skillSelect.selectedIndex];
      const checkedParts = [...f.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
      return {
        actorIds: checkedParts,
        skill: skillSelect.value,
        attr: selectedOpt.dataset.attr,
        difficulty: parseInt(f.querySelector('[name="difficulty"]').value) || 0,
        penalty: parseInt(f.querySelector('[name="penalty"]').value) || 0,
        mode: f.querySelector('[name="mode"]').value,
        resolver: f.querySelector('[name="resolver"]').value,
        context: f.querySelector('[name="context"]').value.trim()
      };
    }, {
      defaultLabel: "Send Request",
      width: 420,
      render: (event) => {
        const el = event?.target?.element;
        if (!el) return;
        const modeSelect = el.querySelector('[name="mode"]');
        const resolverGroup = el.querySelector("#rr-resolver-group");
        if (modeSelect && resolverGroup) {
          const toggle = () => { resolverGroup.style.display = modeSelect.value === "dynamic" ? "" : "none"; };
          modeSelect.addEventListener("change", toggle);
          toggle();
        }
      }
    });

    if (!result || result.actorIds.length === 0) return;

    await this._postRollRequests(result);
  }

  async _postRollRequests(config) {
    const { actorIds, skill, attr, difficulty, penalty, mode, resolver, context } = config;
    const contestId = mode !== "simple" ? foundry.utils.randomID() : null;
    const skillLabel = skill.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const attrLabel = attr.charAt(0).toUpperCase() + attr.slice(1);
    const poolLabel = `${attrLabel} + ${skillLabel}`;

    // Mode labels
    const modeLabels = { simple: "Roll Request", dynamic: "Dynamic Contest", opposed: "Opposed Contest" };
    const modeLabel = modeLabels[mode] || "Roll Request";

    // Context line
    const contextLine = context ? `<p class="wt-text-muted wt-text-sm"><em>${foundry.utils.escapeHTML(context)}</em></p>` : "";

    // Difficulty/penalty description
    const modLines = [];
    if (difficulty > 0) modLines.push(`Difficulty ${difficulty}`);
    if (penalty > 0) modLines.push(`−${penalty}d penalty`);
    const modStr = modLines.length > 0 ? modLines.join(" · ") : "No modifiers";

    // For opposed: first actor is active, rest are blockers
    for (let i = 0; i < actorIds.length; i++) {
      const actorId = actorIds[i];
      const actor = game.actors.get(actorId);
      if (!actor) continue;

      const role = mode === "opposed" ? (i === 0 ? "active" : "blocker") : null;
      const roleLabel = role === "active" ? " (Active)" : role === "blocker" ? " (Blocker)" : "";
      const resolverNote = mode === "dynamic" ? `<p class="wt-text-sm"><i class="fas fa-balance-scale"></i> ${resolver === "width" ? "Width" : "Height"} determines the winner.</p>` : "";

      const cardHtml = `
        <div class="wt-chat-card wt-roll-request">
          <h3 class="wt-roll-request-title"><i class="fas fa-bullhorn"></i> ${modeLabel}</h3>
          ${contextLine}
          <p><strong>${foundry.utils.escapeHTML(actor.name)}${roleLabel}</strong> — roll <strong>${poolLabel}</strong></p>
          <p class="wt-text-sm">${modStr}</p>
          ${resolverNote}
          <button class="wt-btn-primary fulfil-request-btn"
                  data-actor-id="${actorId}"
                  data-attr="${attr}"
                  data-skill="${skill}"
                  data-difficulty="${difficulty}"
                  data-penalty="${penalty}"
                  data-contest-id="${contestId || ""}"
                  data-contest-type="${mode}"
                  data-contest-role="${role || ""}"
                  data-resolver="${resolver}"
                  data-pool-label="${poolLabel}"
                  data-contest-total="${actorIds.length}">
            <i class="fas fa-dice-d20"></i> Fulfil — Roll Now
          </button>
        </div>
      `;

      await ChatMessage.create({
        speaker: { alias: "GM" },
        content: cardHtml,
        flags: {
          "wild-talents-2e": {
            rollRequest: {
              actorId, attr, skill, difficulty, penalty,
              contestId, contestType: mode, contestRole: role, resolver,
              fulfilled: false, poolLabel
            }
          }
        }
      });
    }

    if (contestId) {
      ui.notifications.info(`${modeLabel} posted for ${actorIds.length} participant(s).`);
    }
  }

  // ─── World Month Management ──────────────────────────────────────────

  /**
   * Advance month — delegates to FactionDashboard._onAdvanceMonth so the
   * full RAW logic runs: heal 1 damage per quality, reset action uses,
   * chronicle entries, chat delta report, and journal export.
   */
  async _advanceMonth() {
    // FactionDashboard removed
    // _onAdvanceMonth expects an event with preventDefault; the target is unused.
    // TODO: Reign dashboard removed — re-implement if needed for WT
    await this.refresh();
  }

  /**
   * Retreat month — GM correction tool. Decrements the world month by
   * rewriting the most recent "advance" chronicle entry on each company.
   * Does NOT undo healing or action economy changes (those are irreversible).
   */
  async _retreatMonth() {
    const currentMonth = _getWorldMonth();
    if (currentMonth <= 1) return ui.notifications.warn("Cannot retreat below Month 1.");

    const confirm = await foundry.applications.api.DialogV2.confirm({
      classes: ["wt-dialog-window"],
      window: { title: "Retreat Month" },
      position: { height: "auto" },
      content: `<div class="wt-dialog-form">
        <p>Retreat the world clock from <strong>Month ${currentMonth}</strong> back to <strong>Month ${currentMonth - 1}</strong>?</p>
        <p class="wt-text-small wt-text-muted">This removes the latest advance chronicle entry from each company.
           It does <strong>not</strong> undo healing or action economy changes.</p>
      </div>`,
      rejectClose: false
    });
    if (!confirm) return;

    const companies = game.actors.filter(a => a.type === "company");
    for (const company of companies) {
      const chronicle = foundry.utils.deepClone(company.system.chronicle || []);
      // Find and remove the most recent "advance" entry at the current month
      const idx = chronicle.findLastIndex(e => e.type === "advance" && e.month === currentMonth);
      if (idx !== -1) {
        chronicle.splice(idx, 1);
        await company.update({ "system.chronicle": chronicle });
      }
    }

    ui.notifications.info(`World retreated to Month ${currentMonth - 1}.`);
    // FactionDashboard removed
    await this.refresh();
  }

  // ─── Theater Mode ───────────────────────────────────────────────────────

  exitTheaterMode() {
    if (!this.theaterMode) return;
    this.theaterMode = false;
    document.body.classList.remove("wt-theater-mode");
    const btn = this.element?.querySelector('[data-gt-action="theater-toggle"]');
    if (btn) btn.classList.remove("gt-active");
  }

  // ─── Hook Registration ──────────────────────────────────────────────────

  _registerHooks() {
    // Combat changes → full refresh (updates bar + vitals combat badges)
    Hooks.on("updateCombat", () => this.refresh());
    Hooks.on("deleteCombat", () => this.refresh());
    Hooks.on("createCombat", () => this.refresh());
    Hooks.on("combatStart", () => this.refresh());

    // Combatant declaration flags → full refresh (updates vitals badges)
    Hooks.on("updateCombatant", () => this.refresh());

    // Token selection → refresh if quickroll or tokenpeek is open
    Hooks.on("controlToken", () => {
      if (this.activeSection === "tokenpeek") {
        this.peekExpandedAttr = null; // Reset dropdowns on token change
        this.peekShowSpells = false;
      }
      if (this.activeSection === "quickroll" || this.activeSection === "tokenpeek") this.refresh();
    });

    // Actor updates → refresh for companies (month), characters (vitals), threats (vitals)
    Hooks.on("updateActor", (actor) => {
      if (actor.type === "company" || actor.type === "character" || actor.type === "threat") this.refresh();
    });

    // Actor created or deleted → refresh vitals strip
    Hooks.on("createActor", (actor) => {
      if (actor.type === "character") this.refresh();
    });
    Hooks.on("deleteActor", (actor) => {
      if (actor.type === "character" || actor.type === "threat") this.refresh();
    });

    // Token placed or removed from canvas → refresh vitals (threats appear/disappear)
    Hooks.on("createToken", () => this.refresh());
    Hooks.on("deleteToken", () => this.refresh());

    // Scene change → refresh vitals (different tokens on different scenes)
    Hooks.on("canvasReady", () => this.refresh());

    // Contest resolution — watch for fulfilled roll results tagged with a contestId
    Hooks.on("createChatMessage", (msg) => {
      const contestId = msg.flags?.["wild-talents-2e"]?.contestId;
      if (!contestId) return;
      // Defer to allow the message to fully render
      setTimeout(() => this._checkContestResolution(contestId), 200);
    });

    // Escape key exits theater mode
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this.theaterMode) {
        ev.preventDefault();
        this.exitTheaterMode();
      }
    });
  }

  // ─── Contest Resolution ─────────────────────────────────────────────────

  async _checkContestResolution(contestId) {
    // Find all request messages for this contest
    const requestMsgs = game.messages.filter(m =>
      m.flags?.["wild-talents-2e"]?.rollRequest?.contestId === contestId
    );
    if (requestMsgs.length === 0) return;

    const total = requestMsgs.length;
    const fulfilled = requestMsgs.filter(m => m.flags?.["wild-talents-2e"]?.rollRequest?.fulfilled);
    if (fulfilled.length < total) return; // Still waiting for rolls

    // All rolls are in — resolve
    const contestType = requestMsgs[0].flags?.["wild-talents-2e"].rollRequest.contestType;
    const resolver = requestMsgs[0].flags?.["wild-talents-2e"].rollRequest.resolver || "width";

    // Gather results: find each participant's roll result message
    const results = [];
    for (const req of requestMsgs) {
      const rr = req.flags?.["wild-talents-2e"].rollRequest;
      const resultMsgId = rr.rollMessageId;
      const resultMsg = resultMsgId ? game.messages.get(resultMsgId) : null;
      const rollFlags = resultMsg?.flags?.["wild-talents-2e"];
      const parsed = rollFlags?.results ? parseORE(rollFlags.results) : null;
      const bestSet = parsed?.sets?.[0] || null;
      const actor = game.actors.get(rr.actorId);

      results.push({
        name: actor?.name || "Unknown",
        role: rr.contestRole,
        bestSet,
        width: bestSet?.width || 0,
        height: bestSet?.height || 0,
        text: bestSet?.text || "No sets",
        hasSets: !!bestSet
      });
    }

    if (contestType === "dynamic") {
      await this._resolveDynamic(contestId, results, resolver);
    } else if (contestType === "opposed") {
      await this._resolveOpposed(contestId, results);
    }
  }

  async _resolveDynamic(contestId, results, resolver) {
    // Sort by the resolver metric
    const key = resolver === "width" ? "width" : "height";
    const sorted = [...results].sort((a, b) => b[key] - a[key]);
    const winner = sorted[0];
    const resolverLabel = resolver === "width" ? "Width" : "Height";

    let rows = sorted.map((r, i) => {
      const crown = i === 0 ? `<strong class="wt-text-success">★ Winner</strong>` : "";
      return `<div class="gt-contest-row">${crown} <strong>${foundry.utils.escapeHTML(r.name)}</strong>: ${r.text} (${resolverLabel} ${r[key]})</div>`;
    }).join("");

    if (!winner.hasSets && sorted.every(r => !r.hasSets)) {
      rows += `<p class="wt-text-muted">No participant rolled a set — contest is a draw.</p>`;
    }

    await ChatMessage.create({
      speaker: { alias: "Contest Resolution" },
      content: `<div class="wt-chat-card wt-contest-resolution">
        <h3 class="wt-msg-success"><i class="fas fa-trophy"></i> Dynamic Contest — Resolved</h3>
        <p class="wt-text-sm"><strong>${resolverLabel}</strong> determines the winner.</p>
        <div class="gt-contest-results">${rows}</div>
      </div>`
    });
  }

  async _resolveOpposed(contestId, results) {
    const active = results.find(r => r.role === "active");
    const blocker = results.find(r => r.role === "blocker");
    if (!active || !blocker) return;

    let outcome;
    if (!active.hasSets) {
      outcome = `<p class="wt-text-danger"><strong>${foundry.utils.escapeHTML(active.name)}</strong> failed to roll a set — action fails regardless of defense.</p>`;
    } else if (!blocker.hasSets) {
      outcome = `<p class="wt-text-success"><strong>${foundry.utils.escapeHTML(active.name)}</strong> succeeds unopposed — ${foundry.utils.escapeHTML(blocker.name)} rolled no sets.</p>`;
    } else {
      // Gobble logic: blocker's dice become Gobble Dice
      // Each Gobble Die (at the blocker's set Height) can remove one die from the active set
      // if the Gobble Die's face >= the active die's face (i.e. blocker Height >= active Height)
      const canGobble = blocker.height >= active.height;
      const gobbleWidth = Math.min(blocker.width, active.width);

      if (canGobble) {
        const remainingWidth = active.width - gobbleWidth;
        if (remainingWidth < 2) {
          outcome = `<p class="wt-text-danger"><strong>${foundry.utils.escapeHTML(blocker.name)}</strong>'s ${blocker.text} gobbles ${foundry.utils.escapeHTML(active.name)}'s ${active.text} — action <strong>blocked</strong>!</p>`;
        } else {
          outcome = `<p class="wt-text-success"><strong>${foundry.utils.escapeHTML(active.name)}</strong>'s ${active.text} partially gobbled (−${gobbleWidth}d) but still succeeds at Width ${remainingWidth}.</p>`;
        }
      } else {
        // Blocker's Height is too low — Gobble Dice can't reach
        outcome = `<p class="wt-text-success"><strong>${foundry.utils.escapeHTML(blocker.name)}</strong>'s ${blocker.text} is too slow (Height ${blocker.height}) to gobble ${foundry.utils.escapeHTML(active.name)}'s ${active.text} (Height ${active.height}). Action <strong>succeeds</strong>.</p>`;
      }
    }

    await ChatMessage.create({
      speaker: { alias: "Contest Resolution" },
      content: `<div class="wt-chat-card wt-contest-resolution">
        <h3 class="wt-msg-info"><i class="fas fa-gavel"></i> Opposed Contest — Resolved</h3>
        <div class="gt-contest-results">
          <div class="gt-contest-row"><strong>${foundry.utils.escapeHTML(active.name)}</strong> (Active): ${active.text}</div>
          <div class="gt-contest-row"><strong>${foundry.utils.escapeHTML(blocker.name)}</strong> (Blocker): ${blocker.text}</div>
        </div>
        ${outcome}
      </div>`
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  EXPORTED: Fulfil Roll Request — called from wild-talents-2e.mjs renderChatMessageHTML
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Executes a roll for a fulfilled request. Uses the actor's actual stats,
 * enforces the GM's difficulty/penalty, and handles ED/MD per RAW.
 * @param {ChatMessage} requestMsg - The request chat message containing the flags.
 */
export async function fulfillRollRequest(requestMsg) {
  const rr = requestMsg.flags?.["wild-talents-2e"]?.rollRequest;
  if (!rr) return;

  const actor = game.actors.get(rr.actorId);
  if (!actor) return ui.notifications.warn("Actor not found.");
  if (!actor.isOwner && !game.user.isGM) return ui.notifications.warn("Only the character's owner can fulfil this request.");

  const sys = actor.system;
  const attrVal = parseInt(sys.attributes?.[rr.attr]?.value) || 0;
  const skillVal = parseInt(sys.skills?.[rr.skill]?.value) || 0;
  // WT: HD/WD from skill dice composition
  const skillHD = parseInt(sys.skills?.[rr.skill]?.hard) || 0;
  const skillWD = parseInt(sys.skills?.[rr.skill]?.wiggle) || 0;
  const difficulty = parseInt(rr.difficulty) || 0;
  const penalty = parseInt(rr.penalty) || 0;

  let pool = attrVal + skillVal + skillHD + skillWD - penalty;
  if (pool < 1) return ui.notifications.warn("Pool too low to roll.");

  // Roll normal dice (pool minus HD/WD slots)
  const normalDice = Math.max(0, Math.min(10, pool) - skillHD - skillWD);
  let results = [];
  let rollInstance = null;
  if (normalDice > 0) {
    rollInstance = new Roll(`${normalDice}d10`);
    await rollInstance.evaluate();
    results = rollInstance.dice[0]?.results.map(r => r.result) || [];
  }

  // Append HD (always 10)
  for (let i = 0; i < skillHD; i++) results.push(10);

  // WD: prompt to assign after seeing the roll
  for (let i = 0; i < skillWD; i++) {
    const sortedDisplay = [...results].sort((a, b) => b - a).join(", ") || "(none)";
    const wdResult = await wtDialog(
      "Assign Wiggle Die",
      `<form class="wt-dialog-form">
        <p class="wt-text-large wt-mb-small"><strong>Roll so far:</strong> ${sortedDisplay}</p>
        <p class="wt-text-sm wt-text-muted wt-mb-medium">Assign Wiggle Die to any face (1–10).</p>
        <div class="form-group"><label>WD Face:</label><input type="number" id="rrWdFace" value="10" min="1" max="10"/></div>
      </form>`,
      (e, b, d) => parseInt(d.element.querySelector("#rrWdFace").value) || 10,
      { defaultLabel: "Confirm", width: 360 }
    );
    if (!wdResult) return;
    results.push(wdResult);
  }

  // Post the roll result via the standard ORE chat card
  const totalPool = results.length;
  const flavor = await generateOREChatHTML(
    "character",
    foundry.utils.escapeHTML(rr.poolLabel),
    totalPool, results,
    0, 0,  // WT: Legacy ED/MD params — always 0
    null,
    { difficulty, hardCount: skillHD, wiggleCount: skillWD }
  );

  const contestFlags = rr.contestId ? { contestId: rr.contestId, contestActorId: rr.actorId } : {};

  const resultMsg = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: flavor,
    rolls: rollInstance ? [rollInstance] : [],
    flags: { "wild-talents-2e": { ...contestFlags, results, label: rr.poolLabel, totalPool } }
  });

  // Mark the request as fulfilled
  await requestMsg.update({
    "flags.wild-talents-2e.rollRequest.fulfilled": true,
    "flags.wild-talents-2e.rollRequest.rollMessageId": resultMsg?.id || null
  });

  // Update the request card content to show "Fulfilled"
  const updatedContent = requestMsg.content.replace(
    /<button class="wt-btn-primary fulfil-request-btn"[^]*?<\/button>/,
    `<div class="wt-roll-fulfilled"><i class="fas fa-check-circle"></i> Fulfilled by ${foundry.utils.escapeHTML(actor.name)}</div>`
  );
  await requestMsg.update({ content: updatedContent });
}
