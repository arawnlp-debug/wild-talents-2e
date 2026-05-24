// scripts/apps/crucible.js — The Crucible: Wild Talents 2e Character Builder
//
// ApplicationV2 wizard that walks players through WT character creation.
// Uses a draft state pattern — nothing writes to the actor until "Forge".
//
// Increment 6, Sprint 6.2–6.3
//
// Steps:
//   1. Point Total (campaign info from world settings)
//   2. Stats (N/HD/WD per stat with limit enforcement)
//   3. Skills (suggested + custom, stat binding)
//   4. Archetype (Source + Permission + Intrinsic Meta-Qualities)
//   5. Powers (create inline, gated by Permission)
//   6. Willpower (Base Will + extra + motivations)
//   7. Review & Forge

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;
import { ScrollPreserveMixin } from "../helpers/scroll-mixin.js";
import { SUGGESTED_SKILLS } from "../helpers/config.js";
import {
  POWER_LEVEL_PRESETS,
  CHARACTER_COSTS,
  META_QUALITY_CATALOG,
  calculateArchetypeCost,
  calculateAllergyCost,
  calculateInhumanStatsCost,
  calculateVulnerableCost,
  validateArchetype
} from "../helpers/archetype-engine.js";

const SYSTEM_ID = "wild-talents-2e";
const TOTAL_STEPS = 7;

const STAT_KEYS = ["body", "coordination", "sense", "mind", "charm", "command"];
const STAT_LABELS = {
  body: "Body", coordination: "Coordination", sense: "Sense",
  mind: "Mind", charm: "Charm", command: "Command"
};

function skillKeyToLabel(key) {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()).trim();
}

export class WTCrucible extends ScrollPreserveMixin(HandlebarsApplicationMixin(ApplicationV2)) {

  actor = null;
  currentStep = 1;
  draft = null;

  constructor(options = {}) {
    super(options);
    this.actor = options.actor;
    if (!this.actor) throw new Error("WTCrucible requires an actor.");
    this._initDraft();
  }

  static DEFAULT_OPTIONS = {
    id: "wt-crucible",
    classes: ["wt", "crucible", "app-v2"],
    tag: "div",
    window: { title: "The Crucible — Character Builder", icon: "fas fa-fire", resizable: true },
    position: { width: 880, height: 740 },
    actions: {
      nextStep:          WTCrucible.prototype._onNextStep,
      prevStep:          WTCrucible.prototype._onPrevStep,
      adjustStat:        WTCrucible.prototype._onAdjustStat,
      adjustSkill:       WTCrucible.prototype._onAdjustSkill,
      addSkill:          WTCrucible.prototype._onAddSkill,
      removeSkill:       WTCrucible.prototype._onRemoveSkill,
      addMetaQuality:    WTCrucible.prototype._onAddMetaQuality,
      removeMetaQuality: WTCrucible.prototype._onRemoveMetaQuality,
      addPower:          WTCrucible.prototype._onAddPower,
      removePower:       WTCrucible.prototype._onRemovePower,
      adjustPowerDice:   WTCrucible.prototype._onAdjustPowerDice,
      adjustExtraBW:     WTCrucible.prototype._onAdjustExtraBW,
      forgeCharacter:    WTCrucible.prototype._onForgeCharacter
    }
  };

  static PARTS = {
    crucible: { template: `systems/${SYSTEM_ID}/templates/apps/crucible.hbs` }
  };

  _initDraft() {
    const sys = this.actor.system;
    const stats = {};
    for (const key of STAT_KEYS) {
      const a = sys.attributes?.[key] || {};
      stats[key] = { normal: parseInt(a.normal) || 0, hard: parseInt(a.hard) || 0, wiggle: parseInt(a.wiggle) || 0 };
    }

    const skills = {};
    const existingSkills = sys.skills || {};
    if (Object.keys(existingSkills).length > 0) {
      for (const [key, sk] of Object.entries(existingSkills)) {
        skills[key] = {
          label: sk.label || skillKeyToLabel(key), attribute: sk.attribute || SUGGESTED_SKILLS[key] || "body",
          normal: parseInt(sk.value) || parseInt(sk.normal) || 0, hard: parseInt(sk.hard) || 0, wiggle: parseInt(sk.wiggle) || 0
        };
      }
    } else {
      for (const [key, attr] of Object.entries(SUGGESTED_SKILLS)) {
        skills[key] = { label: skillKeyToLabel(key), attribute: attr, normal: 0, hard: 0, wiggle: 0 };
      }
    }

    const existingArch = sys.archetypeData;
    const archetypeData = (existingArch && Array.isArray(existingArch.metaQualities))
      ? foundry.utils.deepClone(existingArch) : { name: "", metaQualities: [] };

    const powers = [];
    for (const item of (this.actor.items || [])) {
      if (item.type === "power") {
        powers.push({
          _draftId: foundry.utils.randomID(), name: item.name, powerType: item.system.powerType || "miracle",
          dice: foundry.utils.deepClone(item.system.dice || { normal: 1, hard: 0, wiggle: 0 }),
          totalCost: item.system.totalCost || 0, existingItemId: item.id
        });
      }
    }

    this.draft = {
      stats, skills, archetypeData, powers, extraBaseWill: 0,
      passion: { description: sys.biography?.passion?.description || "", rating: sys.biography?.passion?.rating || 0 },
      loyalty: { description: sys.biography?.loyalty?.description || "", rating: sys.biography?.loyalty?.rating || 0 }
    };
  }

  // ── Permission Helpers ──

  _getStatLimit(statKey) {
    const mqs = this.draft.archetypeData.metaQualities || [];
    const inh = mqs.find(mq => mq.id === "inhumanStats");
    if (inh?.parameters?.statMaximums?.[statKey]) return parseInt(inh.parameters.statMaximums[statKey]) || 5;
    return 5;
  }

  _hasSpecialDicePermission() {
    const permIds = new Set((this.draft.archetypeData.metaQualities || []).filter(mq => mq.type === "permission").map(mq => mq.id));
    return permIds.has("peakPerformer") || permIds.has("inhumanStats") || permIds.has("super");
  }

  // ── Cost Computation ──

  _getPointTotal() {
    const preset = game.settings.get(SYSTEM_ID, "powerLevel") || "powerful";
    if (preset === "custom") return parseInt(game.settings.get(SYSTEM_ID, "powerLevelCustom")) || 250;
    return POWER_LEVEL_PRESETS[preset]?.points || 250;
  }

  _sumStatDice(key) {
    const s = this.draft.stats[key] || {};
    return (s.normal || 0) + (s.hard || 0) + (s.wiggle || 0);
  }

  _computePowerCost(power) {
    const type = power.powerType || "miracle";
    const costPerDie = type === "hyperstat" ? 4 : type === "hyperskill" ? 1 : 2;
    const d = power.dice || {};
    return ((d.normal || 0) * costPerDie) + ((d.hard || 0) * costPerDie * 2) + ((d.wiggle || 0) * costPerDie * 4);
  }

  _calculateCosts() {
    const costs = CHARACTER_COSTS;
    let statsCost = 0, skillsCost = 0;

    for (const stat of Object.values(this.draft.stats)) {
      statsCost += (stat.normal || 0) * costs.stat.normal + (stat.hard || 0) * costs.stat.hard + (stat.wiggle || 0) * costs.stat.wiggle;
    }
    for (const skill of Object.values(this.draft.skills)) {
      skillsCost += (skill.normal || 0) * costs.skill.normal + (skill.hard || 0) * costs.skill.hard + (skill.wiggle || 0) * costs.skill.wiggle;
    }

    const archResult = calculateArchetypeCost(this.draft.archetypeData.metaQualities);
    let powersCost = 0;
    for (const p of this.draft.powers) powersCost += parseInt(p.totalCost) || 0;

    const computedBW = this._sumStatDice("charm") + this._sumStatDice("command");
    const extraBW = Math.max(0, this.draft.extraBaseWill || 0);
    const baseWillCost = extraBW * costs.baseWill;
    const total = statsCost + skillsCost + archResult.totalCost + powersCost + baseWillCost;
    const pointTotal = this._getPointTotal();

    const budgetWarnings = [];
    const sb = parseInt(game.settings.get(SYSTEM_ID, "statBudget")) || 0;
    const kb = parseInt(game.settings.get(SYSTEM_ID, "skillBudget")) || 0;
    const pb = parseInt(game.settings.get(SYSTEM_ID, "powerBudget")) || 0;
    if (sb > 0 && statsCost > sb) budgetWarnings.push(`Stats (${statsCost}) exceed budget (${sb})`);
    if (kb > 0 && skillsCost > kb) budgetWarnings.push(`Skills (${skillsCost}) exceed budget (${kb})`);
    if (pb > 0 && powersCost > pb) budgetWarnings.push(`Powers (${powersCost}) exceed budget (${pb})`);

    return {
      total, pointTotal, pointsRemaining: pointTotal - total,
      breakdown: { stats: statsCost, skills: skillsCost, archetype: archResult.totalCost, powers: powersCost, baseWill: baseWillCost },
      computedBW, extraBW, totalBW: computedBW + extraBW,
      budgetWarnings, archetypeWarnings: archResult.warnings, archetypeBreakdown: archResult.breakdown
    };
  }

  _getPermissionNote(permIds) {
    if (permIds.has("super")) return "Super: All power types allowed.";
    const n = [];
    if (permIds.has("hypertrained")) n.push("Hyperskills");
    if (permIds.has("primeSpecimen")) n.push("Hyperstats");
    if (permIds.has("powerTheme")) n.push("All types (must fit theme)");
    if (permIds.has("onePower")) n.push("One power only (any type)");
    if (permIds.has("inventor")) n.push("Gadgeteering + foci only");
    if (permIds.has("peakPerformer")) n.push("HD/WD on Stats/Skills (no powers)");
    if (permIds.has("superEquipment")) n.push("Foci only (creation only)");
    return n.length > 0 ? `Allowed: ${n.join("; ")}` : "No Permission — no powers allowed.";
  }

  // ── Context Preparation ──

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const cd = this._calculateCosts();

    context.currentStep = this.currentStep;
    context.totalSteps = TOTAL_STEPS;
    context.actorName = this.actor.name;
    context.pointTotal = cd.pointTotal;
    context.pointsRemaining = cd.pointsRemaining;
    context.pointsSpent = cd.total;
    context.breakdown = cd.breakdown;
    context.overBudget = cd.pointsRemaining < 0;
    context.budgetWarnings = cd.budgetWarnings;

    const stepLabels = ["Points", "Stats", "Skills", "Archetype", "Powers", "Willpower", "Review"];
    context.steps = [];
    for (let i = 1; i <= TOTAL_STEPS; i++) {
      context.steps.push({ number: i, label: stepLabels[i - 1], active: i === this.currentStep, completed: i < this.currentStep });
    }
    context.canGoBack = this.currentStep > 1;
    context.canGoForward = this.currentStep < TOTAL_STEPS;
    context.isLastStep = this.currentStep === TOTAL_STEPS;

    // Step 1
    if (this.currentStep === 1) {
      const preset = game.settings.get(SYSTEM_ID, "powerLevel") || "powerful";
      context.presetLabel = POWER_LEVEL_PRESETS[preset]?.label || "Custom";
      context.statBudget = parseInt(game.settings.get(SYSTEM_ID, "statBudget")) || 0;
      context.skillBudget = parseInt(game.settings.get(SYSTEM_ID, "skillBudget")) || 0;
      context.powerBudget = parseInt(game.settings.get(SYSTEM_ID, "powerBudget")) || 0;
    }

    // Step 2
    if (this.currentStep === 2) {
      context.stats = STAT_KEYS.map(key => {
        const s = this.draft.stats[key];
        const total = (s.normal || 0) + (s.hard || 0) + (s.wiggle || 0);
        const limit = this._getStatLimit(key);
        return {
          key, label: STAT_LABELS[key], normal: s.normal, hard: s.hard, wiggle: s.wiggle, total, limit,
          cost: s.normal * CHARACTER_COSTS.stat.normal + s.hard * CHARACTER_COSTS.stat.hard + s.wiggle * CHARACTER_COSTS.stat.wiggle,
          atMax: total >= limit, canDecNormal: s.normal > 0, canDecHard: s.hard > 0, canDecWiggle: s.wiggle > 0
        };
      });
    }

    // Step 3
    if (this.currentStep === 3) {
      const sorted = Object.keys(this.draft.skills).sort((a, b) => (this.draft.skills[a].label || a).localeCompare(this.draft.skills[b].label || b));
      context.skills = sorted.map(key => {
        const sk = this.draft.skills[key];
        const total = (sk.normal || 0) + (sk.hard || 0) + (sk.wiggle || 0);
        const isSuggested = key in SUGGESTED_SKILLS;
        return {
          key, label: sk.label || skillKeyToLabel(key), attribute: sk.attribute, attributeLabel: STAT_LABELS[sk.attribute] || sk.attribute,
          normal: sk.normal, hard: sk.hard, wiggle: sk.wiggle, total,
          cost: sk.normal * CHARACTER_COSTS.skill.normal + sk.hard * CHARACTER_COSTS.skill.hard + sk.wiggle * CHARACTER_COSTS.skill.wiggle,
          isSuggested, isCustom: !isSuggested, atMax: total >= 5,
          canDecNormal: sk.normal > 0, canDecHard: sk.hard > 0, canDecWiggle: sk.wiggle > 0
        };
      });
      context.attrOptions = STAT_KEYS.map(k => ({ value: k, label: STAT_LABELS[k] }));
    }

    // Step 4: Archetype
    if (this.currentStep === 4) {
      context.archetypeName = this.draft.archetypeData.name;
      const cat = Object.values(META_QUALITY_CATALOG);
      context.sourceCatalog = cat.filter(e => e.type === "source");
      context.permissionCatalog = cat.filter(e => e.type === "permission");
      context.intrinsicCatalog = cat.filter(e => e.type === "intrinsic");

      let srcCount = 0;
      context.selectedMQs = (this.draft.archetypeData.metaQualities || []).map((mq, idx) => {
        let displayCost = parseInt(mq.cost) || 0;
        if (mq.id === "allergy") displayCost = calculateAllergyCost(mq.parameters || {});
        else if (mq.id === "inhumanStats") displayCost = calculateInhumanStatsCost(mq.parameters || {});
        else if (mq.id === "vulnerable") displayCost = calculateVulnerableCost(mq.parameters || {});
        else if (mq.id !== "custom") displayCost = META_QUALITY_CATALOG[mq.id]?.cost ?? displayCost;
        const isFirst = mq.type === "source" && srcCount === 0;
        if (mq.type === "source") srcCount++;
        return {
          index: idx, id: mq.id, name: mq.name, type: mq.type,
          typeLabel: mq.type.charAt(0).toUpperCase() + mq.type.slice(1),
          cost: isFirst ? 0 : displayCost, isFirstSource: isFirst,
          ref: META_QUALITY_CATALOG[mq.id]?.ref || "GM-defined"
        };
      });
      context.archetypeCost = cd.breakdown.archetype;
      context.archetypeWarnings = cd.archetypeWarnings;
    }

    // Step 5: Powers
    if (this.currentStep === 5) {
      context.powers = this.draft.powers.map((p, idx) => {
        const cost = this._computePowerCost(p);
        p.totalCost = cost;
        return {
          index: idx, _draftId: p._draftId, name: p.name, powerType: p.powerType,
          typeLabel: p.powerType === "hyperstat" ? "Hyperstat" : p.powerType === "hyperskill" ? "Hyperskill" : "Miracle",
          dice: p.dice, totalCost: cost
        };
      });
      const permIds = new Set((this.draft.archetypeData.metaQualities || []).filter(mq => mq.type === "permission").map(mq => mq.id));
      context.hasPermission = permIds.size > 0;
      context.permissionNote = this._getPermissionNote(permIds);
    }

    // Step 6: Willpower
    if (this.currentStep === 6) {
      context.computedBW = cd.computedBW;
      context.extraBW = cd.extraBW;
      context.totalBW = cd.totalBW;
      context.extraBWCost = cd.extraBW * CHARACTER_COSTS.baseWill;
      context.remainingToWP = Math.max(0, cd.pointsRemaining);
      context.startingWP = cd.totalBW + Math.max(0, cd.pointsRemaining);
      context.passion = this.draft.passion;
      context.loyalty = this.draft.loyalty;
    }

    // Step 7: Review
    if (this.currentStep === 7) {
      context.reviewStats = STAT_KEYS.map(key => {
        const s = this.draft.stats[key];
        let d = `${s.normal || 0}d`; if (s.hard > 0) d += `+${s.hard}hd`; if (s.wiggle > 0) d += `+${s.wiggle}wd`;
        return { label: STAT_LABELS[key], display: d };
      });
      context.reviewSkills = Object.entries(this.draft.skills)
        .filter(([, sk]) => (sk.normal || 0) + (sk.hard || 0) + (sk.wiggle || 0) > 0)
        .sort(([, a], [, b]) => (a.label || "").localeCompare(b.label || ""))
        .map(([key, sk]) => {
          let d = `${sk.normal || 0}d`; if (sk.hard > 0) d += `+${sk.hard}hd`; if (sk.wiggle > 0) d += `+${sk.wiggle}wd`;
          return { label: sk.label || skillKeyToLabel(key), display: d, attribute: STAT_LABELS[sk.attribute] };
        });
      context.reviewArchetype = this.draft.archetypeData.name || "(None)";
      context.reviewMQs = (this.draft.archetypeData.metaQualities || []).map(mq => mq.name).join(", ") || "(None)";
      context.reviewPowers = this.draft.powers.map(p => {
        let d = `${p.dice?.normal || 0}d`; if (p.dice?.hard > 0) d += `+${p.dice.hard}hd`; if (p.dice?.wiggle > 0) d += `+${p.dice.wiggle}wd`;
        return { name: p.name, typeLabel: p.powerType, display: d, cost: p.totalCost };
      });
      context.reviewBW = cd.totalBW;
      context.reviewWP = cd.totalBW + Math.max(0, cd.pointsRemaining);
      context.reviewPassion = this.draft.passion.description || "(Not set)";
      context.reviewLoyalty = this.draft.loyalty.description || "(Not set)";

      const val = validateArchetype(this.draft.archetypeData.metaQualities, this.draft.powers.map(p => ({ powerType: p.powerType })));
      context.validationErrors = val.errors;
      context.validationWarnings = [...val.warnings, ...cd.archetypeWarnings, ...cd.budgetWarnings];
      if (cd.pointsRemaining < 0) context.validationWarnings.push(`Over budget by ${Math.abs(cd.pointsRemaining)} points.`);
      context.isValid = val.valid && cd.pointsRemaining >= 0;
    }

    return context;
  }

  // ── Navigation ──
  async _onNextStep(event, _target) { event.preventDefault(); if (this.currentStep < TOTAL_STEPS) { this.currentStep++; this.render(); } }
  async _onPrevStep(event, _target) { event.preventDefault(); if (this.currentStep > 1) { this.currentStep--; this.render(); } }

  // ── Step 2: Stats ──
  async _onAdjustStat(event, target) {
    event.preventDefault();
    const { stat, diceType, dir } = target.dataset;
    if (!stat || !this.draft.stats[stat]) return;
    const s = this.draft.stats[stat];
    const total = (s.normal || 0) + (s.hard || 0) + (s.wiggle || 0);
    if (dir === "up") {
      if (total >= this._getStatLimit(stat)) return ui.notifications.warn(`Stat cannot exceed ${this._getStatLimit(stat)} dice.`);
      if ((diceType === "hard" || diceType === "wiggle") && !this._hasSpecialDicePermission())
        return ui.notifications.warn("HD/WD on Stats require Peak Performer, Inhuman Stats, or Super.");
      s[diceType] = (s[diceType] || 0) + 1;
    } else { if ((s[diceType] || 0) <= 0) return; s[diceType]--; }
    this.render();
  }

  // ── Step 3: Skills ──
  async _onAdjustSkill(event, target) {
    event.preventDefault();
    const { skill: skillKey, diceType, dir } = target.dataset;
    const sk = this.draft.skills[skillKey];
    if (!sk) return;
    const total = (sk.normal || 0) + (sk.hard || 0) + (sk.wiggle || 0);
    if (dir === "up") {
      if (total >= 5) return ui.notifications.warn("Skills cannot exceed 5 dice.");
      if ((diceType === "hard" || diceType === "wiggle") && !this._hasSpecialDicePermission())
        return ui.notifications.warn("HD/WD on Skills require Peak Performer, Inhuman Stats, or Super.");
      sk[diceType] = (sk[diceType] || 0) + 1;
    } else { if ((sk[diceType] || 0) <= 0) return; sk[diceType]--; }
    this.render();
  }

  async _onAddSkill(event, target) {
    event.preventDefault();
    const input = this.element.querySelector("#cr-new-skill-name");
    const attrSel = this.element.querySelector("#cr-new-skill-attr");
    const raw = (input?.value || "").trim();
    if (!raw) return ui.notifications.warn("Enter a skill name.");
    const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!key) return ui.notifications.warn("Invalid skill name.");
    if (this.draft.skills[key]) return ui.notifications.warn(`Skill "${raw}" already exists.`);
    this.draft.skills[key] = { label: raw, attribute: attrSel?.value || "body", normal: 0, hard: 0, wiggle: 0 };
    if (input) input.value = "";
    this.render();
  }

  async _onRemoveSkill(event, target) {
    event.preventDefault();
    const key = target.dataset.skill;
    if (key && this.draft.skills[key]) { delete this.draft.skills[key]; this.render(); }
  }

  // ── Step 4: Archetype ──
  async _onAddMetaQuality(event, target) {
    event.preventDefault();
    const mqType = target.dataset.mqType;
    const select = this.element.querySelector(`#cr-mq-select-${mqType}`);
    if (!select?.value) return;
    const cat = META_QUALITY_CATALOG[select.value];
    if (!cat) return;
    this.draft.archetypeData.metaQualities.push({ id: cat.id, name: cat.name, type: cat.type, cost: cat.cost, notes: "", parameters: {} });
    select.value = "";
    this.render();
  }

  async _onRemoveMetaQuality(event, target) {
    event.preventDefault();
    const idx = parseInt(target.dataset.index);
    if (!isNaN(idx)) { this.draft.archetypeData.metaQualities.splice(idx, 1); this.render(); }
  }

  // ── Step 5: Powers ──
  async _onAddPower(event, target) {
    event.preventDefault();
    const nameIn = this.element.querySelector("#cr-power-name");
    const typeSel = this.element.querySelector("#cr-power-type");
    const power = { _draftId: foundry.utils.randomID(), name: (nameIn?.value || "").trim() || "New Power", powerType: typeSel?.value || "miracle", dice: { normal: 1, hard: 0, wiggle: 0 }, totalCost: 0 };
    power.totalCost = this._computePowerCost(power);
    this.draft.powers.push(power);
    if (nameIn) nameIn.value = "";
    this.render();
  }

  async _onRemovePower(event, target) {
    event.preventDefault();
    const idx = parseInt(target.dataset.index);
    if (!isNaN(idx)) { this.draft.powers.splice(idx, 1); this.render(); }
  }

  async _onAdjustPowerDice(event, target) {
    event.preventDefault();
    const { index, diceType, dir } = target.dataset;
    const power = this.draft.powers[parseInt(index)];
    if (!power) return;
    const d = power.dice;
    const total = (d.normal || 0) + (d.hard || 0) + (d.wiggle || 0);
    if (dir === "up") { if (total >= 10) return; d[diceType] = (d[diceType] || 0) + 1; }
    else { if ((d[diceType] || 0) <= 0) return; d[diceType]--; }
    power.totalCost = this._computePowerCost(power);
    this.render();
  }

  // ── Step 6: Willpower ──
  async _onAdjustExtraBW(event, target) {
    event.preventDefault();
    if (target.dataset.dir === "up") this.draft.extraBaseWill = (this.draft.extraBaseWill || 0) + 1;
    else if ((this.draft.extraBaseWill || 0) > 0) this.draft.extraBaseWill--;
    this.render();
  }

  // ── Forge ──
  async _onForgeCharacter(event, target) {
    event.preventDefault();
    const cd = this._calculateCosts();
    const val = validateArchetype(this.draft.archetypeData.metaQualities, this.draft.powers.map(p => ({ powerType: p.powerType })));
    if (!val.valid) { ui.notifications.error(`Cannot forge: ${val.errors.join(" ")}`); return; }

    if (cd.pointsRemaining < 0) {
      const proceed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Over Budget" },
        content: `<p>You are <strong>${Math.abs(cd.pointsRemaining)} points over budget</strong>. Forge anyway?</p>`,
        yes: { label: "Forge Anyway" }, no: { label: "Go Back" }
      });
      if (!proceed) return;
    }

    const upd = { "system.creationMode": false };

    for (const key of STAT_KEYS) {
      const s = this.draft.stats[key];
      upd[`system.attributes.${key}.normal`] = s.normal || 0;
      upd[`system.attributes.${key}.hard`] = s.hard || 0;
      upd[`system.attributes.${key}.wiggle`] = s.wiggle || 0;
    }

    const skillsObj = {};
    for (const [key, sk] of Object.entries(this.draft.skills)) {
      const total = (sk.normal || 0) + (sk.hard || 0) + (sk.wiggle || 0);
      if (total > 0 || !(key in SUGGESTED_SKILLS)) {
        skillsObj[key] = { label: sk.label || skillKeyToLabel(key), value: sk.normal || 0, hard: sk.hard || 0, wiggle: sk.wiggle || 0, attribute: sk.attribute || "body" };
      }
    }
    upd["system.skills"] = skillsObj;

    upd["system.archetypeData"] = foundry.utils.deepClone(this.draft.archetypeData);
    const mqs = this.draft.archetypeData.metaQualities || [];
    upd["system.archetype"] = this.draft.archetypeData.name;
    upd["system.source"] = mqs.filter(mq => mq.type === "source").map(mq => mq.name).join(", ");
    upd["system.permission"] = mqs.filter(mq => mq.type === "permission").map(mq => mq.name).join(", ");

    const remainingAsWP = Math.max(0, cd.pointsRemaining);
    upd["system.willpower.max"] = cd.totalBW;
    upd["system.willpower.current"] = cd.totalBW + remainingAsWP;

    upd["system.biography.passion.description"] = this.draft.passion.description;
    upd["system.biography.passion.rating"] = this.draft.passion.rating || 0;
    upd["system.biography.loyalty.description"] = this.draft.loyalty.description;
    upd["system.biography.loyalty.rating"] = this.draft.loyalty.rating || 0;

    try {
      await this.actor.update(upd);
      const newPowers = this.draft.powers.filter(p => !p.existingItemId);
      if (newPowers.length > 0) {
        await this.actor.createEmbeddedDocuments("Item", newPowers.map(p => ({
          name: p.name, type: "power",
          system: { powerType: p.powerType, dice: { normal: p.dice.normal || 0, hard: p.dice.hard || 0, wiggle: p.dice.wiggle || 0 }, qualities: [], notes: "Created in The Crucible" }
        })));
      }
      ui.notifications.info(`${this.actor.name} has been forged in The Crucible.`);
      this.close();
    } catch (err) {
      console.error("WT Crucible | Forge failed:", err);
      ui.notifications.error(`Forge failed: ${err.message}`);
    }
  }

  // ── Render Hooks ──
  _onRender(context, options) {
    super._onRender(context, options);

    if (this.currentStep === 3) {
      this.element.querySelectorAll(".cr-skill-attr-select").forEach(sel => {
        sel.addEventListener("change", (e) => { const k = e.target.dataset.skill; if (k && this.draft.skills[k]) this.draft.skills[k].attribute = e.target.value; });
      });
    }

    if (this.currentStep === 4) {
      const nameIn = this.element.querySelector("#cr-archetype-name");
      if (nameIn) nameIn.addEventListener("change", (e) => { this.draft.archetypeData.name = e.target.value.trim(); });
    }

    if (this.currentStep === 6) {
      const pDesc = this.element.querySelector("#cr-passion-desc");
      const lDesc = this.element.querySelector("#cr-loyalty-desc");
      const pRate = this.element.querySelector("#cr-passion-rating");
      const lRate = this.element.querySelector("#cr-loyalty-rating");
      if (pDesc) pDesc.addEventListener("change", (e) => { this.draft.passion.description = e.target.value; });
      if (lDesc) lDesc.addEventListener("change", (e) => { this.draft.loyalty.description = e.target.value; });
      if (pRate) pRate.addEventListener("change", (e) => { this.draft.passion.rating = parseInt(e.target.value) || 0; });
      if (lRate) lRate.addEventListener("change", (e) => { this.draft.loyalty.rating = parseInt(e.target.value) || 0; });
    }
  }
}
