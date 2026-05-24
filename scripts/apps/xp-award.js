// scripts/apps/xp-award.js
// ════════════════════════════════════════════════════════════════════════════
//  SESSION XP AWARD PANEL — End-of-Session Experience Distribution
//  Wild Talents 2nd Edition (Foundry VTT V14)
//
//  GM-only panel for awarding XP to all PCs at session end.
//
//  RAW Ch3 p.38 — XP sources (1–5 per session, typically 2–3):
//    • Attendance (1 XP) — showing up
//    • Thespianism (1 XP) — compelling roleplay
//    • Out of Character Enhancement (1 XP) — art, journals, pizza
//    • Problems (1 XP) — self-inflicted troubles came into play (max 1)
//    • Dramatic Plot Alteration (1 XP) — climactic event driven by PCs
//
//  The panel provides a "Base Award" (applies to all PCs equally — typically
//  Attendance + Dramatic Plot) and a per-character "Individual Bonus" (for
//  Thespianism, OOC, Problems). One click applies all awards, updates actors,
//  and posts a summary chat card.
// ════════════════════════════════════════════════════════════════════════════

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;
import { ScrollPreserveMixin } from "../helpers/scroll-mixin.js";

// ═════════════════════════════════════════════════════════════════════════════
//  XPAwardPanel — ApplicationV2
// ═════════════════════════════════════════════════════════════════════════════

export class XPAwardPanel extends ScrollPreserveMixin(HandlebarsApplicationMixin(ApplicationV2)) {

  // ─── Transient state (lives only while the app is open) ──────────────────

  /** Base award applied to every PC. Default 1 for Attendance. */
  baseAward = 1;

  /** Per-actor individual bonuses. Keyed by actor ID. */
  bonuses = {};

  /** Set of actor IDs excluded from the award. */
  excluded = new Set();

  static DEFAULT_OPTIONS = {
    id: "wt-xp-award",
    classes: ["wt", "xp-award", "app-v2"],
    tag: "div",
    window: {
      title:     "Session XP Awards",
      icon:      "fas fa-award",
      resizable: true,
      width:     520,
      height:    460,
    },
    actions: {
      applyAwards:   XPAwardPanel.prototype._onApplyAwards,
      toggleExclude: XPAwardPanel.prototype._onToggleExclude,
      resetAll:      XPAwardPanel.prototype._onResetAll,
    }
  };

  static PARTS = {
    main: { template: "systems/wild-talents-2e/templates/apps/xp-award.hbs" }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  //  DATA PREPARATION
  // ═══════════════════════════════════════════════════════════════════════════

  _getCharacters() {
    // Only PCs — characters where system.isGMC is false.
    // The isGMC flag is the authoritative marker set on the character sheet header.
    const pcs = game.actors.filter(a => a.type === "character" && !a.system.isGMC);
    return pcs.sort((a, b) => a.name.localeCompare(b.name));
  }

  async _prepareContext(options) {
    const context   = await super._prepareContext(options);
    const pcs       = this._getCharacters();
    const base      = this.baseAward;

    context.characters = pcs.map(actor => {
      const bonus    = this.bonuses[actor.id] || 0;
      const excluded = this.excluded.has(actor.id);
      const total    = excluded ? 0 : base + bonus;
      const unspent  = parseInt(actor.system.xp?.value)  || 0;
      const spent    = parseInt(actor.system.xp?.spent)   || 0;

      return {
        id:        actor.id,
        name:      actor.name,
        img:       actor.img || "icons/svg/mystery-man.svg",
        unspent,
        spent,
        earned:    unspent + spent,
        bonus,
        total,
        excluded,
        afterAward: unspent + total,
      };
    });

    context.baseAward  = base;
    context.totalChars = context.characters.length;
    context.activeChars = context.characters.filter(c => !c.excluded).length;
    context.grandTotal = context.characters.reduce((sum, c) => sum + c.total, 0);
    context.isEmpty    = pcs.length === 0;
    context.isGM       = game.user.isGM;
    return context;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  POST-RENDER: Wire up inputs
  // ═══════════════════════════════════════════════════════════════════════════

  _onRender(context, options) {
    super._onRender(context, options);
    const el = this.element;

    // Base award input
    const baseInput = el.querySelector(".xa-base-input");
    if (baseInput) {
      baseInput.addEventListener("change", () => {
        this.baseAward = Math.max(0, parseInt(baseInput.value) || 0);
        this.render(false);
      });
    }

    // Per-character bonus inputs
    el.querySelectorAll(".xa-bonus-input").forEach(input => {
      input.addEventListener("change", () => {
        const actorId = input.closest("[data-actor-id]")?.dataset.actorId;
        if (!actorId) return;
        this.bonuses[actorId] = Math.max(0, parseInt(input.value) || 0);
        this.render(false);
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Toggle a character's exclusion ──────────────────────────────────────

  async _onToggleExclude(event, target) {
    event.preventDefault();
    const actorId = target.closest("[data-actor-id]")?.dataset.actorId;
    if (!actorId) return;

    if (this.excluded.has(actorId)) {
      this.excluded.delete(actorId);
    } else {
      this.excluded.add(actorId);
    }
    this.render(false);
  }

  // ─── Reset all bonuses and exclusions ────────────────────────────────────

  async _onResetAll(event, target) {
    event.preventDefault();
    this.baseAward = 1;
    this.bonuses   = {};
    this.excluded  = new Set();
    this.render(false);
  }

  // ─── Apply awards to all characters ──────────────────────────────────────

  async _onApplyAwards(event, target) {
    event.preventDefault();
    if (!game.user.isGM) return;

    const pcs  = this._getCharacters();
    const base = this.baseAward;

    // Collect awards
    const awards = [];
    for (const actor of pcs) {
      if (this.excluded.has(actor.id)) continue;
      const bonus = this.bonuses[actor.id] || 0;
      const total = base + bonus;
      if (total <= 0) continue;
      awards.push({ actor, total, bonus });
    }

    if (awards.length === 0) {
      return ui.notifications.warn("No XP to award — all characters are excluded or totals are zero.");
    }

    // Confirm
    const totalXP    = awards.reduce((sum, a) => sum + a.total, 0);
    const confirmed  = await foundry.applications.api.DialogV2.confirm({
      window:   { title: "Confirm XP Awards", classes: ["wt-dialog-window"] },
      position: { height: "auto" },
      content: `<div class="wt-dialog-form">
        <p>Award a total of <strong>${totalXP} XP</strong> across <strong>${awards.length}</strong> character${awards.length !== 1 ? "s" : ""}?</p>
        <p class="wt-text-small wt-text-muted">Each character's unspent XP will increase by their individual total. This cannot be undone automatically.</p>
      </div>`,
      rejectClose: false,
    });
    if (!confirmed) return;

    // Apply
    const updates = awards.map(({ actor, total }) => ({
      _id: actor.id,
      "system.xp.value": (parseInt(actor.system.xp?.value) || 0) + total,
    }));

    await Actor.updateDocuments(updates);

    // Build chat card
    const rows = awards.map(({ actor, total, bonus }) => {
      const safeName = foundry.utils.escapeHTML(actor.name);
      const breakdown = bonus > 0 ? `(${base} base + ${bonus} bonus)` : `(${base} base)`;
      return `<div class="xa-chat-row">
        <img src="${actor.img || "icons/svg/mystery-man.svg"}" class="xa-chat-portrait" />
        <span class="xa-chat-name">${safeName}</span>
        <span class="xa-chat-total">+${total} XP</span>
        <span class="xa-chat-breakdown">${breakdown}</span>
      </div>`;
    }).join("");

    await ChatMessage.create({
      speaker: { alias: "Session Awards" },
      content: `<div class="wt-chat-card wt-card-success">
        <h3 class="wt-msg-success"><i class="fas fa-award"></i> Session XP Awarded</h3>
        <div class="xa-chat-list">${rows}</div>
        <p class="wt-text-small wt-text-muted wt-text-center">${totalXP} XP distributed to ${awards.length} character${awards.length !== 1 ? "s" : ""}.</p>
      </div>`,
    });

    ui.notifications.success(`${totalXP} XP awarded to ${awards.length} character(s).`);

    // Reset bonuses and re-render with updated totals
    this.bonuses  = {};
    this.excluded = new Set();
    this.render(false);
  }
}
