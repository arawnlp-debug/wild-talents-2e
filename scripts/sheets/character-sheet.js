// scripts/sheets/character-sheet.js
const { HandlebarsApplicationMixin } = foundry.applications.api;

import { parseORE } from "../helpers/ore-engine.js";
import { postOREChat } from "../helpers/chat.js";
import { CharacterRoller } from "../helpers/character-roller.js";
import { syncCharacterStatusEffects, performPostCombatRecovery, applyWillpowerChange } from "../combat/damage.js";
import { SUGGESTED_SKILLS, HIT_LOCATIONS, HIT_LOCATION_LABELS, getEffectDictionary } from "../helpers/config.js";

// Import the extracted dialog utilities
import { wtDialog, wtConfirm } from "../helpers/dialog-util.js";
import { ScrollPreserveMixin } from "../helpers/scroll-mixin.js";
import { sanitiseItemDescription } from "../helpers/html-util.js";
import { calculateTotalCharacterCost } from "../helpers/archetype-engine.js";

// WT: Skills are freeform — labels come from the skill data itself, not a fixed map.
// SUGGESTED_SKILLS in config.js provides defaults for new characters.

/**
 * Main application class for rendering Character Actor sheets.
 */
export class WTActorSheet extends ScrollPreserveMixin(HandlebarsApplicationMixin(foundry.applications.sheets.ActorSheetV2)) {
  static DEFAULT_OPTIONS = {
    tag: "form", 
    classes: ["wt", "sheet", "actor"], 
    position: { width: 920, height: 780 }, 
    window: { resizable: true, minimizable: true },
    form: { submitOnChange: true, closeOnSubmit: false },
    // V14 ARCHITECTURE FIX: All actions strictly bound to the prototype
    actions: {
      recoverShock: this.prototype._onRecoverShock,
      restAndRecover: this.prototype._onRestAndRecover,
      toggleProgression: this.prototype._onToggleProgression,
      upgradeStat: this.prototype._onUpgradeStat,
      rollStat: this.prototype._onRollStat,
      changeTab: this.prototype._onChangeTab,
      itemCreate: this.prototype._onItemCreate,
      itemEdit: this.prototype._onItemEdit,
      itemDelete: this.prototype._onItemDelete,
      toggleEquip: this.prototype._onToggleEquip,
      toggleStationary: this.prototype._onToggleStationary,
      addSkill: this.prototype._onAddSkill,
      deleteSkill: this.prototype._onDeleteSkill,
      itemToChat: this.prototype._onItemToChat,
      toggleShieldLocation: this.prototype._onToggleShieldLocation,
      assignShield: this.prototype._onAssignShield,
      declareAim: this.prototype._onDeclareAim,
      createEffect: this.prototype._onCreateEffect,
      editEffect: this.prototype._onEditEffect,
      deleteEffect: this.prototype._onDeleteEffect,
      toggleEffect: this.prototype._onToggleEffect,
      advancedEditEffect: this.prototype._onAdvancedEditEffect,
      editImage: this.prototype._onEditImage,
      toggleGMC: this.prototype._onToggleGMC,
      toggleHideLocked: this.prototype._onToggleHideLocked,
      openCrucible: this.prototype._onOpenCrucible,
      toggleView: this.prototype._onToggleView,
      editFavouriteSkills: this.prototype._onEditFavouriteSkills,
      toggleSkillPopover: this.prototype._onToggleSkillPopover
    }
  };

  static PARTS = { sheet: { template: "systems/wild-talents-2e/templates/actor/character-sheet.hbs" } };

  // ==========================================
  // ACTION HANDLERS (V14 Standard)
  // ==========================================

  async _onEditImage(event, target) {
      event.preventDefault();
      try {
          const fp = new foundry.applications.apps.FilePicker.implementation({
              type: "image",
              current: this.document.img,
              callback: path => this.document.update({ img: path })
          });
          return fp.browse();
      } catch(err) { 
          ui.notifications.error(`Action failed: ${err.message}`); 
          console.error(err); 
      }
  }

  async _onToggleGMC(event, target) {
      event.preventDefault();
      try {
          await this.document.update({ "system.isGMC": !this.document.system.isGMC });
      } catch(err) {
          ui.notifications.error(`Action failed: ${err.message}`);
          console.error(err);
      }
  }

  async _onRecoverShock(event, target) {
      event.preventDefault();
      try {
          await performPostCombatRecovery(this.document);
      } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onRestAndRecover(event, target) {
      event.preventDefault();
      try {
          const content = `
            <div class="wt-dialog-form">
              <p class="wt-dialog-intro">Select the type of rest.</p>
              <div class="form-group">
                <label>Rest Type:</label>
                <select name="restType">
                  <option value="vigor">Vigorous Recovery (Roll Body + Vigor to heal Shock)</option>
                  <option value="day">Rest for 1 Full Day (Heals 1 Shock per location)</option>
                  <option value="week">Rest for 1 Full Week (Heals 1 Killing per location)</option>
                </select>
              </div>
            </div>
          `;

          const restType = await wtDialog("Rest & Recover", content, (e, b, d) => d.element.querySelector('[name="restType"]').value, { defaultLabel: "Rest" });

          if (!restType) return;
          const system = this.document.system;

          // RAW p.111: Daily Vigor self-recovery — roll Body + Vigor.
          // "If it succeeds, you may remove a number of Shock points equal to
          //  the Width of the roll."
          // Only the best set is used. Shock removal only — no Killing conversion.
          // NOTE: Killing→Shock conversion is a separate mechanic requiring a healer
          // (RAW p.111: "a healer can attempt a roll... one point of Killing damage
          //  is turned into Shock"). That is handled via the First Aid workflow.
          if (restType === "vigor") {
              const body = parseInt(system.attributes.body?.value) || 0;
              const vigor = parseInt(system.skills.vigor?.value) || 0;
              let pool = Math.min(body + vigor, 10);
              
              if (pool < 1) return ui.notifications.warn("Pool too low to roll for Vigorous Recovery.");

              const roll = new Roll(`${pool}d10`);
              await roll.evaluate();
              const results = roll.dice[0]?.results.map(r => r.result) || [];
              const parsed = parseORE(results);

              if (parsed.sets.length === 0) {
                  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({actor: this.document}), content: `<div class="wt-chat-card"><h3 class="wt-msg-fail">Vigorous Recovery Failed</h3><p>Rolled ${pool}d10 (Body + Vigor) and found no matches. No recovery.</p></div>` });
                  return;
              }

              const bestSet = parsed.sets[0];
              const width = bestSet.width;

              // Distribute Shock removal across locations
              const distContent = `
                <form class="wt-dialog-form">
                  <p class="wt-dialog-callout">Roll succeeded! Best set: <strong>${bestSet.text}</strong>.<br>Remove up to <strong>${width} Shock</strong> across any locations.</p>
                  <div class="form-group"><label>Head (Shock: ${system.health.head.shock}):</label><input type="number" name="head" value="0" min="0" max="${Math.min(width, system.health.head.shock)}"></div>
                  <div class="form-group"><label>Torso (Shock: ${system.health.torso.shock}):</label><input type="number" name="torso" value="0" min="0" max="${Math.min(width, system.health.torso.shock)}"></div>
                  <div class="form-group"><label>R. Arm (Shock: ${system.health.armR.shock}):</label><input type="number" name="armR" value="0" min="0" max="${Math.min(width, system.health.armR.shock)}"></div>
                  <div class="form-group"><label>L. Arm (Shock: ${system.health.armL.shock}):</label><input type="number" name="armL" value="0" min="0" max="${Math.min(width, system.health.armL.shock)}"></div>
                  <div class="form-group"><label>R. Leg (Shock: ${system.health.legR.shock}):</label><input type="number" name="legR" value="0" min="0" max="${Math.min(width, system.health.legR.shock)}"></div>
                  <div class="form-group"><label>L. Leg (Shock: ${system.health.legL.shock}):</label><input type="number" name="legL" value="0" min="0" max="${Math.min(width, system.health.legL.shock)}"></div>
                </form>
              `;

              const dist = await wtDialog("Vigorous Recovery — Distribute Shock Removal", distContent, (e,b,d) => {
                      const f = d.element.querySelector("form");
                      return { head: parseInt(f.head.value)||0, torso: parseInt(f.torso.value)||0, armR: parseInt(f.armR.value)||0, armL: parseInt(f.armL.value)||0, legR: parseInt(f.legR.value)||0, legL: parseInt(f.legL.value)||0 };
                  }, { defaultLabel: "Apply Healing" }
              );

              if (!dist) return;

              const totalAllocated = dist.head + dist.torso + dist.armR + dist.armL + dist.legR + dist.legL;
              if (totalAllocated > width) return ui.notifications.error(`You allocated ${totalAllocated} but only generated ${width}. Rest cancelled.`);

              const updates = {};
              for (const [k, v] of Object.entries(dist)) { if (v > 0) updates[`system.health.${k}.shock`] = Math.max(0, system.health[k].shock - v); }
              
              if (Object.keys(updates).length > 0) {
                  await this.document.update(updates);
                  await syncCharacterStatusEffects(this.document);
              }

              await ChatMessage.create({ speaker: ChatMessage.getSpeaker({actor: this.document}), content: `<div class="wt-chat-card"><h3 class="wt-msg-success">Vigorous Recovery</h3><p>Rolled ${pool}d10 (Body+Vigor). Set: ${bestSet.text}.<br>Removed <strong>${totalAllocated} Shock</strong> total.</p></div>` });
              return;
          }

          const updates = {};
          let totalHealed = 0;

          if (restType === "day") {
              // RAW: Daily natural Shock recovery — 1 Shock from every location that has any.
              HIT_LOCATIONS.forEach(loc => {
                  const currentShock = parseInt(system.health[loc].shock) || 0;
                  if (currentShock > 0) { updates[`system.health.${loc}.shock`] = currentShock - 1; totalHealed++; }
              });
          } else if (restType === "week") {
              // RAW: After a full week without new damage, 1 Killing on each LIMB converts to Shock.
              // Head and Torso are NOT included — limbs only (armR, armL, legR, legL).
              const LIMB_LOCATIONS = ["armR", "armL", "legR", "legL"];
              LIMB_LOCATIONS.forEach(loc => {
                  const currentKilling = parseInt(system.health[loc].killing) || 0;
                  if (currentKilling > 0) {
                      const effectiveMax = this.document.system.effectiveMax?.[loc] || 5;
                      const currentShock  = parseInt(system.health[loc].shock) || 0;
                      updates[`system.health.${loc}.killing`] = currentKilling - 1;
                      // Killing converts to Shock — cap at the location max.
                      updates[`system.health.${loc}.shock`] = Math.min(currentShock + 1, effectiveMax);
                      totalHealed++;
                  }
              });
          }

          if (totalHealed > 0) {
              await this.document.update(updates);
              await syncCharacterStatusEffects(this.document);
              const timeStr = restType === "day" ? "a full day" : "a full week";
              const healDesc = restType === "day"
                  ? `naturally recovering <strong>1 Shock</strong> from ${totalHealed} location(s)`
                  : `converting <strong>1 Killing → Shock</strong> on ${totalHealed} limb(s)`;
              await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: this.document }), content: `<div class="wt-chat-card"><h3 class="wt-msg-info"><i class="fas fa-campground"></i> Natural Healing</h3><p>${foundry.utils.escapeHTML(this.document.name)} rests for <strong>${timeStr}</strong>, ${healDesc}.</p></div>` });
          } else {
              const noHealMsg = restType === "day" ? "no Shock damage to heal" : "no Killing damage on any limb to convert";
              ui.notifications.info(`${this.document.name} has ${noHealMsg} via passive resting.`);
          }

          // 📖 WT Rulebook Ch3 p.52: "Rest: If you get a good night's sleep and
          //     your Willpower is lower than your Base Will, you gain a Willpower point."
          if (restType === "day" || restType === "week") {
              const wpSys = this.document.system.willpower;
              const currentWP = parseInt(wpSys?.current) || 0;
              const baseWill = parseInt(wpSys?.base) || 0;
              if (currentWP < baseWill) {
                  await applyWillpowerChange(this.document, 1, "Good night's rest");
              }
          }
      } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  // NOTE: Reign _onPurchaseHelper and _onAcquireLoot removed — WT has no wealth system.

  async _onToggleProgression(event, target) {
      event.preventDefault();
      try { await this.document.setFlag("wild-talents-2e", "progressionMode", !(this.document.getFlag("wild-talents-2e", "progressionMode") || false)); } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onUpgradeStat(event, target) {
      event.preventDefault();
      try {
          const type = target.dataset.type;
          const key = target.dataset.key;
          const label = target.dataset.label;
          const system = this.document.system;
          let cost = 0, newPath = "", newVal = 0, upgradeText = "";

          // WT Rulebook Reference Sheet — Character Costs:
          //   Stat: 5 per die | Skill: 2 per die | Base Will: 3 per point | Willpower: 1 per point
          if (type === "attribute") {
              const attrData = system.attributes[key] || {};
              const currentNormal = attrData.normal || 0;
              const totalDice = currentNormal + (attrData.hard || 0) + (attrData.wiggle || 0);
              if (totalDice >= 10) return ui.notifications.warn("Stats cannot exceed 10 dice total.");
              cost = 5;
              newPath = `system.attributes.${key}.normal`;
              newVal = currentNormal + 1;
              upgradeText = `${label} to ${newVal}d (Normal)`;

          } else if (type === "skill") {
              const skillData = system.skills?.[key];
              if (!skillData) return ui.notifications.warn("Skill not found.");
              const currentNormal = skillData.value || 0;
              const totalDice = currentNormal + (skillData.hard || 0) + (skillData.wiggle || 0);
              if (totalDice >= 10) return ui.notifications.warn("Skills cannot exceed 10 dice total.");
              cost = 2;
              newPath = `system.skills.${key}.value`;
              newVal = currentNormal + 1;
              upgradeText = `${label} to ${newVal}d (Normal)`;

          } else if (type === "basewill") {
              const currentBW = system.willpower?.max || system.willpower?.base || 0;
              cost = 3;
              newPath = "system.willpower.max";
              newVal = currentBW + 1;
              upgradeText = `Base Will to ${newVal}`;

          } else if (type === "willpower") {
              const currentWP = system.willpower?.current || 0;
              const maxWP = system.willpower?.max || system.willpower?.base || 0;
              if (currentWP >= maxWP) return ui.notifications.warn("Willpower is already at maximum.");
              cost = 1;
              newPath = "system.willpower.current";
              newVal = currentWP + 1;
              upgradeText = `Willpower to ${newVal}`;

          } else {
              return ui.notifications.warn(`Unknown upgrade type: ${type}`);
          }

          const unspent = system.xp?.value || 0;
          if (cost > unspent) return ui.notifications.error(`Insufficient XP. ${upgradeText} requires ${cost} XP (have ${unspent}).`);

          const confirm = await wtConfirm("Confirm Advancement", `<p>Spend <strong>${cost} XP</strong> to acquire <strong>${upgradeText}</strong>?</p>`);
          if (!confirm) return;

          await this.document.update({
              "system.xp.value": unspent - cost,
              "system.xp.spent": (system.xp?.spent || 0) + cost,
              [newPath]: newVal
          });
          ui.notifications.info(`Spent ${cost} XP: ${upgradeText}.`);
      } catch(err) { ui.notifications.error(`Upgrade failed: ${err.message}`); console.error(err); }
  }

  async _onRollStat(event, target) {
      event.preventDefault();
      try {
          const dataset = target.dataset;
          if (this.document.system.hasTowerShieldPenalty && (dataset.key?.toLowerCase() === "stealth" || dataset.key?.toLowerCase() === "climb")) {
              return ui.notifications.error("Cannot make Stealth or Climb rolls while dragging a massive Tower Shield!");
          }
          await CharacterRoller.rollCharacter(this.document, dataset);
      } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  /**
   * PACKAGE C Item 6: Declare the Aim maneuver for this round.
   * Increments aim bonus (+1d per round, max +2d). Consumed on next attack roll.
   */
  async _onDeclareAim(event, target) {
      event.preventDefault();
      try {
          await CharacterRoller.declareAim(this.document);
      } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  /**
   * PACKAGE C Item 4: Open the per-round shield coverage assignment dialog.
   * Lets the player choose which locations each equipped shield protects this round.
   */
  async _onAssignShield(event, target) {
      event.preventDefault();
      try {
          await CharacterRoller.assignShieldCoverage(this.document);
      } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onChangeTab(event, target) { 
      event.preventDefault();
      try { this._activeTab = target.dataset.tab; this.render(); } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  /**
   * Toggle between the dashboard play-surface view and the detail
   * editor view. The chosen view persists per-user via a client flag
   * on the User document so it survives reloads and is unique per
   * person logged into the world.
   *
   * @param {Event} event
   * @param {HTMLElement} target
   */
  async _onToggleView(event, target) {
    event.preventDefault();
    try {
      const next = this._view === "dashboard" ? "detail" : "dashboard";
      this._view = next;
      try {
        await game.user.setFlag("wild-talents-2e", "defaultSheetView", next);
      } catch (err) {
        console.warn("WT | Could not persist view preference:", err);
      }
      this.render();
    } catch (err) {
      ui.notifications.error(`Action failed: ${err.message}`);
      console.error(err);
    }
  }

  /**
   * Open a small picker dialog for the quick-skill row on the dashboard.
   * Selection is stored as an array of skill keys in an actor flag so
   * it travels with the character, not the user.
   *
   * @param {Event} event
   * @param {HTMLElement} target
   */
  async _onEditFavouriteSkills(event, target) {
    event.preventDefault();
    try {
      const actor = this.document;
      const sys = actor.system || {};
      const candidates = Object.entries(sys.skills || {})
        .map(([key, sk]) => ({ key, label: sk.label || key }))
        .sort((a, b) => a.label.localeCompare(b.label));
      if (candidates.length === 0) {
        return ui.notifications.warn("Add skills before choosing favourites.");
      }
      const current = actor.getFlag("wild-talents-2e", "favouriteSkills") || [];
      const checkboxes = candidates.map(c => {
        const checked = current.includes(c.key) ? "checked" : "";
        const safeLabel = foundry.utils.escapeHTML(c.label);
        return `<label style="display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer;">
          <input type="checkbox" name="fav" value="${c.key}" ${checked}/>
          <span>${safeLabel}</span>
        </label>`;
      }).join("");
      const content = `
        <p style="margin:0 0 8px 0;font-size:0.9em;">
          Pick up to 5 favourite skills for the dashboard quick-roll row.
        </p>
        <div style="max-height:240px;overflow-y:auto;border:1px solid var(--wt-border-light,#999);padding:6px;">
          ${checkboxes}
        </div>`;

      const result = await wtDialog(
        "Favourite Skills",
        content,
        (event, button) => {
          const form = button.form;
          if (!form) return null;
          const inputs = form.querySelectorAll('input[name="fav"]');
          return Array.from(inputs).filter(i => i.checked).map(i => i.value).slice(0, 5);
        },
        { defaultLabel: "Save", width: 360 }
      );
      if (result === null || result === undefined) return;
      await actor.setFlag("wild-talents-2e", "favouriteSkills", result);
      this.render();
    } catch (err) {
      ui.notifications.error(`Action failed: ${err.message}`);
      console.error(err);
    }
  }

  /**
   * Toggle a popover beneath a "+N MORE" button showing all the hidden
   * skills for a stat. The popover is a sibling element in the same
   * stat row; opening one closes any other currently-open popover.
   * Outside-click handler is installed once per render in _onRender.
   *
   * @param {Event} event
   * @param {HTMLElement} target  the +N MORE button
   */
  async _onToggleSkillPopover(event, target) {
    event.preventDefault();
    event.stopPropagation();
    try {
      const row = target.closest("[data-stat-key]");
      if (!row) return;
      const wasOpen = row.classList.contains("wt-dash-stat-row--expanded");
      // Close any currently-open popover on this sheet AND clear their
      // aria-expanded state on the trigger button.
      this.element?.querySelectorAll(".wt-dash-stat-row--expanded")
        .forEach(r => {
          r.classList.remove("wt-dash-stat-row--expanded");
          const trig = r.querySelector(".wt-dash-skill-more");
          if (trig) trig.setAttribute("aria-expanded", "false");
        });
      if (!wasOpen) {
        row.classList.add("wt-dash-stat-row--expanded");
        const trigger = row.querySelector(".wt-dash-skill-more");
        if (trigger) trigger.setAttribute("aria-expanded", "true");
        // Move focus to the first focusable element inside the popover for keyboard users
        const firstFocus = row.querySelector(".wt-dash-skill-popover a.rollable");
        if (firstFocus) firstFocus.focus();
      } else if (target instanceof HTMLElement) {
        // If we just closed via the inline "close" button, return focus to the trigger.
        const trigger = row.querySelector(".wt-dash-skill-more");
        if (trigger) trigger.focus();
      }
    } catch (err) {
      console.error("WT | toggleSkillPopover failed:", err);
    }
  }

  async _onItemCreate(event, target) { 
      event.preventDefault();
      try { await this.document.createEmbeddedDocuments("Item", [{name: `New ${target.dataset.type}`, type: target.dataset.type}]); } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onItemEdit(event, target) { 
      event.preventDefault();
      try { this.document.items.get(target.dataset.itemId)?.sheet.render(true); } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onItemDelete(event, target) { 
      event.preventDefault();
      try {
          const item = this.document.items.get(target.dataset.itemId);
          if (!item) return;
          const confirm = await wtConfirm(`Delete ${item.name}?`, `<p class="wt-dialog-intro">Are you sure you want to permanently delete <strong>${item.name}</strong>?<br>This action cannot be undone.</p>`);
          if (confirm) await item.delete(); 
      } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onToggleEquip(event, target) {
      event.preventDefault();
      try { const item = this.document.items.get(target.dataset.itemId); if (item) await item.update({ "system.equipped": !item.system.equipped }); } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onToggleStationary(event, target) {
      event.preventDefault();
      try { const item = this.document.items.get(target.dataset.itemId); if (item) await item.update({ "system.isStationary": !item.system.isStationary }); } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  // ==========================================
  // FREEFORM SKILLS (WT)
  // ==========================================

  async _onAddSkill(event, target) {
      event.preventDefault();
      try {
        const attr = target.dataset.attr || "body";
        const id = foundry.utils.randomID();
        await this.document.update({
          [`system.skills.${id}`]: {
            label: "New Skill",
            attribute: attr,
            value: 0,
            hard: 0,
            wiggle: 0
          }
        });
      } catch(err) {
        ui.notifications.error(`Failed to add skill: ${err.message}`);
        console.error(err);
      }
  }

  async _onDeleteSkill(event, target) {
      event.preventDefault();
      try {
        const el = target?.dataset?.skillId ? target : target?.closest?.("[data-skill-id]");
        const skillId = el?.dataset?.skillId;
        if (!skillId) return;

        const confirmed = await wtConfirm("Delete Skill", "Remove this skill permanently?");
        if (!confirmed) return;

        // V14+ operator-based deletion
        const del = globalThis._del ?? foundry?.data?.operators?.ForcedDeletion?.create?.();
        if (del) {
          await this.document.update({ [`system.skills.${skillId}`]: del });
        } else {
          await this.document.update({ [`system.skills.-=${skillId}`]: null });
        }
      } catch(err) {
        ui.notifications.error(`Failed to delete skill: ${err.message}`);
        console.error(err);
      }
  }

  async _onItemToChat(event, target) {
      event.preventDefault();
      try {
          const item = this.document.items.get(target.dataset.itemId);
          if (!item) return;
          const safeName = foundry.utils.escapeHTML(item.name);
          const rawDesc = sanitiseItemDescription(item.system.notes || item.system.effect || "");
          const safeDesc = await foundry.applications.ux.TextEditor.implementation.enrichHTML(rawDesc, { async: true, secrets: this.document.isOwner, relativeTo: this.document });
          
          // For spells, include intensity, school and duration in chat
          let spellMeta = "";
          if (item.type === "spell") {
              const sys = item.system;
              const metaParts = [];
              if (sys.school) metaParts.push(`<strong>School:</strong> ${foundry.utils.escapeHTML(sys.school)}`);
              if (sys.intensity) metaParts.push(`<strong>Intensity:</strong> ${sys.intensity}`);
              if (sys.pool) metaParts.push(`<strong>Pool:</strong> ${foundry.utils.escapeHTML(sys.pool)}`);
              if (sys.duration) metaParts.push(`<strong>Duration:</strong> ${foundry.utils.escapeHTML(sys.duration)}`);
              if (sys.slow > 0) metaParts.push(`<strong>Slow:</strong> ${sys.slow}`);
              if (sys.attunementRequired) metaParts.push(`<span class="wt-spell-chat-locked"><i class="fas fa-lock"></i> Attunement Required</span>`);
              if (metaParts.length) spellMeta = `<div class="wt-callout wt-spell-chat-meta">${metaParts.join(" &nbsp;|&nbsp; ")}</div>`;
          }
          
          await ChatMessage.create({ speaker: ChatMessage.getSpeaker({actor: this.document}), content: `<div class="wt-chat-card"><h3>${safeName}</h3><p>${item.type.toUpperCase()}</p>${spellMeta}<hr><div>${safeDesc}</div></div>` });
      } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  // Toggle the "hide locked" filter (reusable for powers in future)
  _onToggleHideLocked(event, target) {
      event.preventDefault();
      if (!this._spellFilter) this._spellFilter = { school: "all", hideLocked: false };
      this._spellFilter.hideLocked = !this._spellFilter.hideLocked;
      this.render(false);
  }

  async _onOpenCrucible(event, target) {
      event.preventDefault();
      try {
          const { WTCrucible } = await import("../apps/crucible.js");
          new WTCrucible({ actor: this.document }).render(true);
      } catch (err) {
          console.error("WT | Failed to open The Crucible:", err);
          ui.notifications.error(`Failed to open The Crucible: ${err.message}`);
      }
  }

  async _onToggleShieldLocation(event, target) {
      event.preventDefault();
      if (this._isTogglingShield) return; 
      this._isTogglingShield = true;
      
      try {
          const locKey = target.dataset.loc;
          const shieldId = target.dataset.shieldId;
          const shield = this.document.items.get(shieldId);
          if (!shield) return;

          const sys = shield.system;
          const currentLocs = foundry.utils.deepClone(sys.protectedLocations);
          
          if (sys.shieldSize === "tower") {
              if (!sys.isStationary) return ui.notifications.warn("Cannot adjust protection while moving. The shield only covers your arm.");
              const carryingArm = sys.shieldArm || "armL";
              const carryingLeg = carryingArm === "armL" ? "legL" : "legR";
              if (locKey === carryingArm || locKey === carryingLeg) return ui.notifications.warn("Tower Shields automatically protect the carrying arm and leg while stationary.");

              if (currentLocs[locKey]) currentLocs[locKey] = false;
              else {
                  const activeManual = Object.keys(currentLocs).filter(k => currentLocs[k] && k !== carryingArm && k !== carryingLeg);
                  if (activeManual.length >= 2) for (const k of activeManual) currentLocs[k] = false;
                  currentLocs[locKey] = true;
              }
          } else {
              const limits = { small: 1, large: 2 }; 
              const max = limits[sys.shieldSize] || 1;
              if (currentLocs[locKey]) currentLocs[locKey] = false;
              else {
                  const active = Object.keys(currentLocs).filter(k => currentLocs[k]);
                  if (active.length >= max) for (const k of active) currentLocs[k] = false;
                  currentLocs[locKey] = true;
              }
          }
          await shield.update({ "system.protectedLocations": currentLocs });
      } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); } finally { this._isTogglingShield = false; }
  }

  // NOTE: Reign _onPledgeEffort removed — WT has no company/faction system.

  // --- CHARACTER ACTIVE EFFECTS QUICK BUILDER ---
  async _onCreateEffect(event, target) {
      event.preventDefault();
      await this._handleEffectBuilder(null);
  }
  async _onEditEffect(event, target) {
      event.preventDefault();
      const effectId = target.closest(".effect-item")?.dataset?.effectId;
      await this._handleEffectBuilder(effectId);
  }
  async _onDeleteEffect(event, target) {
      event.preventDefault();
      const effectId = target.closest(".effect-item")?.dataset?.effectId;
      const effect = this.document.effects.get(effectId);
      if (effect) await effect.delete();
  }
  async _onToggleEffect(event, target) {
      event.preventDefault();
      const effectId = target.closest(".effect-item")?.dataset?.effectId;
      const effect = this.document.effects.get(effectId);
      if (effect) await effect.update({ disabled: !effect.disabled });
  }
  async _onAdvancedEditEffect(event, target) {
      event.preventDefault();
      const effectId = target.closest(".effect-item")?.dataset?.effectId;
      const effect = this.document.effects.get(effectId);
      if (effect) effect.sheet.render(true);
  }

  /**
   * The Master Dictionary that bridges the UI dropdowns to the `models.js` catch-basins.
   * Delegates to the centralized dictionary in config.js.
   */
  _getEffectDictionary() {
    return getEffectDictionary();
  }

  /**
   * The Wild Talents 2e Quick-Builder for Active Effects on Characters.
   */
  async _handleEffectBuilder(effectId = null) {
      const effect = effectId ? this.document.effects.get(effectId) : null;
      
      if (effect && effect.changes.length > 1) {
          ui.notifications.warn(game.i18n.localize("WT.EffectMultiWarning"));
          return effect.sheet.render(true);
      }

      const change = effect && effect.changes.length > 0 ? effect.changes[0] : { key: "system.modifiers.globalPool", value: "1", mode: 2 };
      const effectName = effect ? effect.name : `New Character Modifier`;

      const dict = this._getEffectDictionary();
      const grouped = {};
      dict.forEach(item => {
          if (!grouped[item.group]) grouped[item.group] = [];
          grouped[item.group].push(item);
      });

      let optionsHtml = "";
      for (const [group, items] of Object.entries(grouped)) {
          optionsHtml += `<optgroup label="${group}">`;
          for (const item of items) {
              const selected = item.value === change.key ? "selected" : "";
              optionsHtml += `<option value="${item.value}" ${selected}>${item.label}</option>`;
          }
          optionsHtml += `</optgroup>`;
      }

      const content = `
          <form class="wt-dialog-form">
              <div class="form-group">
                  <label>Effect Name:</label>
                  <input type="text" name="effName" value="${effectName}" required/>
              </div>
              <div class="form-group">
                  <label>What does this modify?</label>
                  <select name="effKey" id="effKeySelect">
                      <option value="custom" ${!dict.find(d => d.value === change.key) ? "selected" : ""}>-- Custom / Unlisted Database Path --</option>
                      ${optionsHtml}
                  </select>
              </div>
              <div class="form-group" id="customKeyGroup" class="wt-hidden">
                  <label>Custom Attribute Key:</label>
                  <input type="text" name="customKey" value="${change.key}"/>
              </div>
              <div class="form-group">
                  <label>Modifier Value:</label>
                  <input type="text" name="effValue" id="effValueInput" value="${change.value}" required/>
                  <small class="wt-text-muted wt-dialog-subtitle" id="effValueHint">Enter a numeric value (e.g., 1 or -1).</small>
              </div>
              <div class="form-group wt-text-center">
                  <a id="advancedEditBtn" class="wt-dialog-advanced-link">
                      <i class="fas fa-cogs"></i> Open Advanced Foundry AE Editor
                  </a>
              </div>
          </form>
      `;

      const result = await wtDialog(
          effect ? "Edit Modifier" : "Create Modifier",
          content,
          (e, b, d) => {
              const form = d.element.querySelector("form");
              let finalKey = form.effKey.value;
              if (finalKey === "custom") finalKey = form.customKey.value;
              const opt = dict.find(o => o.value === finalKey);
              return {
                  name: form.effName.value,
                  key: finalKey,
                  value: form.effValue.value,
                  mode: opt ? opt.mode : (!isNaN(Number(form.effValue.value)) ? 2 : 5)
              };
          },
          {
              defaultLabel: "Save Modifier",
              render: (context, el) => {
                  const select = el.querySelector("#effKeySelect");
                  const hint = el.querySelector("#effValueHint");
                  const customGroup = el.querySelector("#customKeyGroup");
                  const advBtn = el.querySelector("#advancedEditBtn");

                  const updateUI = () => {
                     const opt = dict.find(o => o.value === select.value);
                     if (select.value === "custom") {
                         customGroup.classList.remove("wt-hidden");
                         hint.textContent = "Enter value based on the targeted key.";
                     } else {
                         customGroup.classList.add("wt-hidden");
                         if (opt?.isBool) { hint.textContent = "Type 'true' to enable or 'false' to disable."; }
                         else if (opt?.isString) { hint.textContent = "Type a target location (e.g., 'torso')."; }
                         else { hint.textContent = "Type a number (e.g., 1 or -1)."; }
                     }
                  };
                  
                  select.addEventListener("change", updateUI);
                  updateUI();

                  advBtn.addEventListener("click", () => {
                      const closeBtn = el.querySelector('[data-action="close"]');
                      if (closeBtn) closeBtn.click(); 
                      
                      if (effect) {
                          effect.sheet.render(true);
                      } else {
                          this.document.createEmbeddedDocuments("ActiveEffect", [{
                              name: "New Advanced Effect",
                              img: "icons/svg/aura.svg",
                              disabled: false
                          }]).then(effs => effs[0].sheet.render(true));
                      }
                  });
              }
          }
      );

      if (result) {
          const changes = result.key ? [{ key: result.key, mode: result.mode, value: result.value }] : [];
          if (effect) {
              await effect.update({ name: result.name, changes });
          } else {
              await this.document.createEmbeddedDocuments("ActiveEffect", [{
                  name: result.name,
                  img: "icons/svg/aura.svg",
                  disabled: false,
                  changes: changes
              }]);
          }
      }
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.classList.toggle("wt-gmc", !!context.isGMC);

    // ── Skill-popover dismissal (Sprint 2.2 fix) ──────────────────
    // Clicking anywhere outside an open popover, or pressing Escape,
    // closes any currently-expanded stat row.
    // We attach the listeners to `this.element` so they live as long
    // as the sheet does and don't leak when the sheet is closed.
    if (!this._popoverListenersAttached) {
      this._popoverListenersAttached = true;
      const closeAllPopovers = () => {
        this.element.querySelectorAll(".wt-dash-stat-row--expanded")
          .forEach(r => {
            r.classList.remove("wt-dash-stat-row--expanded");
            const trig = r.querySelector(".wt-dash-skill-more");
            if (trig) trig.setAttribute("aria-expanded", "false");
          });
      };
      this.element.addEventListener("click", (evt) => {
        const insidePopover = evt.target.closest(".wt-dash-skill-popover");
        const onMoreButton  = evt.target.closest('[data-action="toggleSkillPopover"]');
        if (insidePopover || onMoreButton) return;
        closeAllPopovers();
      });
      this.element.addEventListener("keydown", (evt) => {
        if (evt.key !== "Escape") return;
        const open = this.element.querySelector(".wt-dash-stat-row--expanded");
        if (!open) return;
        const trigger = open.querySelector(".wt-dash-skill-more");
        closeAllPopovers();
        // Return focus to the trigger so keyboard users aren't lost
        if (trigger) trigger.focus();
        evt.stopPropagation();
      });
    }

    // Spell school filter — select is not a named form field so won't submit;
    // we wire it manually to update the ephemeral _spellFilter state and re-render.
    const schoolSelect = this.element.querySelector("[data-spell-filter-school]");
    if (schoolSelect) {
        schoolSelect.addEventListener("change", (ev) => {
            if (!this._spellFilter) this._spellFilter = { school: "all", hideLocked: false };
            this._spellFilter.school = ev.currentTarget.value;
            this.render(false);
        });
    }
  }

  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    const html = this.element;
    // Apply GMC border class on first render
    html.classList.toggle("wt-gmc", !!context.isGMC);

    html.addEventListener('contextmenu', (ev) => {
        if (ev.target.closest('.hit-zone') || ev.target.closest('.health-box')) ev.preventDefault();
    });

    html.addEventListener('mousedown', (ev) => {
        const zone = ev.target.closest('.hit-zone');
        if (zone) { ev.preventDefault(); this._handleSilhouetteClick(ev, zone); return; }
        const healthBox = ev.target.closest('.health-box');
        if (healthBox) { ev.preventDefault(); this._handleHealthBoxClick(ev, healthBox); }
    });
  }

  async _handleSilhouetteClick(event, target) {
      const locKey = target.dataset.loc || target.getAttribute('data-loc');
      if (!locKey) return;
      
      const actor = this.document;
      let shock = parseInt(actor.system.health[locKey]?.shock) || 0;
      let killing = parseInt(actor.system.health[locKey]?.killing) || 0;
      let max = parseInt(actor.system.effectiveMax?.[locKey]) || 5;

      if (event.shiftKey) {
          if (killing > 0) killing--;
          else if (shock > 0) shock--;
      } else if (event.button === 2) {
          if (killing < max) { killing++; if (shock + killing > max && shock > 0) shock--; }
      } else {
          if (shock + killing < max) shock++;
          else if (shock > 0 && killing < max) { shock--; killing++; } 
      }

      await actor.update({ [`system.health.${locKey}.shock`]: shock, [`system.health.${locKey}.killing`]: killing });
      await syncCharacterStatusEffects(actor);
  }

  async _handleHealthBoxClick(ev, box) {
      const locKey = box.closest(".health-track")?.dataset?.loc;
      if (!locKey) return;

      const actor = this.document;
      let shock = parseInt(actor.system.health[locKey]?.shock) || 0;
      let killing = parseInt(actor.system.health[locKey]?.killing) || 0;
      let max = parseInt(actor.system.effectiveMax?.[locKey]) || 5;
      
      if (ev.button === 0) { 
         if (shock + killing < max) shock++;
         else if (shock > 0) { shock--; killing++; }
      } else if (ev.button === 2) { 
         if (shock > 0) shock--;
         else if (killing > 0) killing--;
      }

      await actor.update({ [`system.health.${locKey}.shock`]: shock, [`system.health.${locKey}.killing`]: killing });
      await syncCharacterStatusEffects(actor);
  }

  _processSubmitData(event, form, formData) {
    let data = super._processSubmitData(event, form, formData);
    let flatData = foundry.utils.flattenObject(data);
    let changed = false;

    for (const key in flatData) {
        if (key.endsWith(".value") || key.endsWith(".sorcery") || key.endsWith(".spent") || key.endsWith(".modifier") || key.endsWith(".cost") || key.endsWith(".bonus") || key.endsWith(".quantity") || key.endsWith(".intensity") || key.endsWith(".slow") || key.endsWith(".castingTime") || key.endsWith(".parryBonus") || key.endsWith(".coverAR")) {
            if (flatData[key] === "" || flatData[key] === null) { flatData[key] = 0; changed = true; } 
            else if (typeof flatData[key] === "string" && !isNaN(parseInt(flatData[key]))) { flatData[key] = parseInt(flatData[key]) || 0; changed = true; }
        }
    }
    return changed ? foundry.utils.expandObject(flatData) : data;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const system = this.document.system;
    context.actor = this.document;
    context.system = system;
    context.appId = this.id; 

    const effMax = system.effectiveMax;
    const effHAR = system.effectiveHAR;
    const effLAR = system.effectiveLAR;

    context.creationMode = system.creationMode || false;
    context.isGMC = system.isGMC || false;
    context.progressionMode = this.document.getFlag("wild-talents-2e", "progressionMode") || false;
    // ── Dashboard vs Detail view (Sprint 1.2) ────────────────────────
    // Default to detail (existing behaviour). User preference persists
    // via a per-user flag namespaced to this system id.
    if (this._view === undefined) {
      const userPref = game.user?.getFlag?.("wild-talents-2e", "defaultSheetView");
      this._view = (userPref === "dashboard") ? "dashboard" : "detail";
    }
    context.view = this._view;
    context.isDashboardView = this._view === "dashboard";
    context.isDetailView    = this._view === "detail";

    this._activeTab = this._activeTab || "stats";
    context.tabs = { stats: this._activeTab === "stats" ? "active" : "", combat: this._activeTab === "combat" ? "active" : "", powers: this._activeTab === "powers" ? "active" : "", biography: this._activeTab === "biography" ? "active" : "", effects: this._activeTab === "effects" ? "active" : "" };

    // WP gauge percentage for the header bar
    const wpMax = parseInt(system.willpower?.max) || parseInt(system.willpower?.base) || 1;
    const wpCur = parseInt(system.willpower?.current) || 0;
    context.wpPercent = Math.min(100, Math.round((wpCur / Math.max(wpMax, 1)) * 100));

    // ── WT Stat Blocks: Normal / Hard / Wiggle per stat with freeform skills ──
    const STAT_KEYS = ["body", "coordination", "sense", "mind", "charm", "command"];

    // Group freeform skills by their bound attribute
    const skillsByAttr = {};
    for (const key of STAT_KEYS) skillsByAttr[key] = [];
    for (const [skillKey, skillData] of Object.entries(system.skills || {})) {
      const attr = skillData.attribute || "body";
      if (skillsByAttr[attr]) {
        skillsByAttr[attr].push({
          key: skillKey,
          label: skillData.label || skillKey,
          normal: skillData.value || 0,
          hard: skillData.hard || 0,
          wiggle: skillData.wiggle || 0
        });
      }
    }
    // Sort skills alphabetically within each attribute
    for (const attr of STAT_KEYS) skillsByAttr[attr].sort((a, b) => a.label.localeCompare(b.label));

    context.attributeOptions = { none: "None", body: "Body", coordination: "Coordination", sense: "Sense", mind: "Mind", charm: "Charm", command: "Command" };
    context.skillOptions = { none: "None" };
    for (const [attr, skills] of Object.entries(skillsByAttr)) {
      skills.forEach(s => context.skillOptions[s.key] = s.label);
    }

    // ── Hyperstat/Hyperskill index (Sprint 2.2) ──────────────────────
    // Walk the actor's powers and bucket them by which stat/skill they
    // enhance. The dashboard displays a small chip per enhancement so
    // players see at a glance what bonus dice they own.
    //   📖 WT Rulebook Ch6 p.104 — Hyperstat "adds dice to the Stat"
    //   📖 WT Rulebook Ch6 p.105 — Hyperskill "adds dice to the Skill"
    // The merge into actual roll pools is handled by character-roller.js
    // at roll time. This is presentation-only.
    const hyperstatByStat = {};
    const hyperskillBySkill = {};
    for (const it of this.document.items) {
      if (it.type !== "power") continue;
      const ps = it.system || {};
      const pd = ps.dice || {};
      const bonus = {
        powerId: it.id,
        name: it.name,
        normal: Number(pd.normal) || 0,
        hard:   Number(pd.hard)   || 0,
        wiggle: Number(pd.wiggle) || 0
      };
      bonus.total = bonus.normal + bonus.hard + bonus.wiggle;
      if (bonus.total === 0) continue;
      if (ps.powerType === "hyperstat" && ps.linkedStat) {
        // 📖 WT Rulebook Ch6 p.104 — Hyperstat linked to a stat.
        // The item sheet's "Linked Stat" field is free-text with a
        // placeholder like "Body", so users may store any of
        // "Body" / "body" / "BODY". Match case-insensitively against
        // the canonical STAT_KEYS (lower-case keys).
        const linkedLower = String(ps.linkedStat).trim().toLowerCase();
        const statKey = STAT_KEYS.includes(linkedLower) ? linkedLower : null;
        if (statKey) {
          (hyperstatByStat[statKey] ||= []).push(bonus);
        } else if (linkedLower) {
          // Unrecognised stat name — log once for the GM/dev to find typos
          console.warn(
            `WT | Power "${it.name}" linkedStat="${ps.linkedStat}" `
            + `does not match any stat. Expected one of: ${STAT_KEYS.join(", ")}.`
          );
        }
      } else if (ps.powerType === "hyperskill" && ps.linkedSkill) {
        // 📖 WT Rulebook Ch6 p.105 — Hyperskill linked to a skill.
        // Same free-text tolerance: match by key (case-insensitive)
        // or by label (case-insensitive).
        const linkedRaw = String(ps.linkedSkill).trim();
        const linkedLower = linkedRaw.toLowerCase();
        let skillKey = null;
        // Try exact key match first
        if (sys.skills?.[linkedRaw]) skillKey = linkedRaw;
        // Then case-insensitive key match
        if (!skillKey) {
          skillKey = Object.keys(sys.skills || {}).find(k =>
            k.toLowerCase() === linkedLower
          ) || null;
        }
        // Then case-insensitive label match
        if (!skillKey) {
          skillKey = Object.keys(sys.skills || {}).find(k =>
            (sys.skills[k].label || "").toLowerCase() === linkedLower
          ) || null;
        }
        if (skillKey) {
          (hyperskillBySkill[skillKey] ||= []).push(bonus);
        } else if (linkedRaw) {
          console.warn(
            `WT | Power "${it.name}" linkedSkill="${ps.linkedSkill}" `
            + `does not match any skill on this actor.`
          );
        }
      }
    }

    context.wtStatBlocks = STAT_KEYS.map(attrKey => {
      const attrData = system.attributes[attrKey] || {};
      const normal = attrData.normal || 0;
      const hard = attrData.hard || 0;
      const wiggle = attrData.wiggle || 0;
      const allSkills = skillsByAttr[attrKey] || [];
      // ── Dashboard shaping (Sprint 2.1 + 2.2) ─────────────────────
      // Pre-compute the truncated skill list, "more" count, and each
      // skill's hyperskill bonus chip (Sprint 2.2). The hyperstat
      // bonus chip for the stat itself is added on the parent block.
      const DASH_SKILL_LIMIT = 3;
      const shapeSkill = (s) => {
        const hs = hyperskillBySkill[s.key] || [];
        const hyperTotal = hs.reduce((sum, b) => sum + b.total, 0);
        return {
          key: s.key,
          label: s.label,
          normal: s.normal,
          hard: s.hard,
          wiggle: s.wiggle,
          total: (s.normal || 0) + (s.hard || 0) + (s.wiggle || 0),
          hyperBonus: hyperTotal,
          hyperLabel: hs.map(b => b.name).join(", ")
        };
      };
      const visibleSkills = allSkills.slice(0, DASH_SKILL_LIMIT).map(shapeSkill);
      // Hidden skills get the same shaping for the popover (Sprint 2.2 fix)
      const hiddenSkills = allSkills.slice(DASH_SKILL_LIMIT).map(shapeSkill);
      const moreSkillCount = hiddenSkills.length;
      // Hyperstat bonus for THIS attribute
      const statHyper = hyperstatByStat[attrKey] || [];
      const statHyperBonus = statHyper.reduce((sum, b) => sum + b.total, 0);
      const statHyperLabel = statHyper.map(b => b.name).join(", ");
      return {
        key: attrKey,
        label: attrKey.toUpperCase(),
        normal,
        hard,
        wiggle,
        total: normal + hard + wiggle,
        skills: allSkills,
        visibleSkills,
        hiddenSkills,
        moreSkillCount,
        hyperBonus: statHyperBonus,
        hyperLabel: statHyperLabel
      };
    });

    // ── Quick-Skill Row (Sprint 2.2) ─────────────────────────────────
    // Read favourites from actor flag, fall back to first 3 skills.
    // Each block shows skill name + bound-stat label + total dice
    // (stat dice + skill dice + any hyperskill dice).
    {
      const allSkillsFlat = [];
      for (const attr of STAT_KEYS) {
        for (const sk of (skillsByAttr[attr] || [])) {
          allSkillsFlat.push({ ...sk, attribute: attr });
        }
      }
      let favKeys = this.document.getFlag("wild-talents-2e", "favouriteSkills");
      if (!Array.isArray(favKeys) || favKeys.length === 0) {
        // Default: first 3 alphabetical skills the character actually has
        favKeys = allSkillsFlat.slice(0, 3).map(s => s.key);
      }
      const quickSkillBlocks = [];
      for (const key of favKeys) {
        const sk = allSkillsFlat.find(s => s.key === key);
        if (!sk) continue;
        const attr = sk.attribute;
        const attrData = system.attributes[attr] || {};
        const attrTotal = (attrData.normal || 0) + (attrData.hard || 0) + (attrData.wiggle || 0);
        const skillTotal = (sk.normal || 0) + (sk.hard || 0) + (sk.wiggle || 0);
        const hs = hyperskillBySkill[sk.key] || [];
        const skillHyperBonus = hs.reduce((sum, b) => sum + b.total, 0);
        const statHyper = hyperstatByStat[attr] || [];
        const statHyperBonus = statHyper.reduce((sum, b) => sum + b.total, 0);
        quickSkillBlocks.push({
          key: sk.key,
          label: sk.label,
          attribute: attr,
          attrLabel: attr.toUpperCase(),
          total: attrTotal + skillTotal + skillHyperBonus + statHyperBonus,
          breakdown: `${attr.toUpperCase()} ${attrTotal}d + ${sk.label} ${skillTotal}d`
            + (skillHyperBonus ? ` + Hyperskill ${skillHyperBonus}d` : "")
            + (statHyperBonus  ? ` + Hyperstat ${statHyperBonus}d`  : "")
        });
      }
      context.quickSkillBlocks = quickSkillBlocks;
      context.hasQuickSkills = quickSkillBlocks.length > 0;
    }

    // Point total (placeholder — full calculation in Increment 4)
    context.totalPoints = "—";

    // Aggregate stat totals for quick reference
    const bodyTotal = (system.attributes?.body?.normal || 0) + (system.attributes?.body?.hard || 0) + (system.attributes?.body?.wiggle || 0);
    const coordTotal = (system.attributes?.coordination?.normal || 0) + (system.attributes?.coordination?.hard || 0) + (system.attributes?.coordination?.wiggle || 0);

    const items = this.document.items;
    const buckets = { weapon: [], gear: [], advantage: [], problem: [], armor: [], shield: [], power: [], poison: [] };
    const equippedShields = [];
    
    for (const item of items) {
        if (buckets[item.type] !== undefined) {
            let tooltip = "";
            let showWarning = false;
            const sys = item.system;

            if (item.type === "weapon") {
                tooltip = `Damage: ${sys.damageFormula || sys.damage || 'None'}`;
                const q = [];
                if (sys.qualities?.armorPiercing) q.push(`AP ${sys.qualities.armorPiercing}`);
                if (sys.qualities?.slow) q.push(`Slow ${sys.qualities.slow}`);
                if (sys.qualities?.twoHanded) q.push("2H");
                if (sys.qualities?.massive) q.push("Massive");
                if (sys.qualities?.area) q.push(`Area ${sys.qualities.area}d`);
                if (q.length) tooltip += ` | ${q.join(", ")}`;

                // Resolve pool label from freeform skills
                const sk = sys.skillKey || "";
                if (sk) {
                    const skillData = system.skills?.[sk];
                    item.resolvedPoolLabel = skillData?.label || sys.pool || sk;
                } else {
                    item.resolvedPoolLabel = sys.pool || "";
                }
            } else if (item.type === "armor") {
                tooltip = `HAR: ${sys.har || 0} | LAR: ${sys.lar || 0}`;
            } else if (item.type === "shield") {
                tooltip = `Parry: +${sys.parryBonus || 0}d | Cover AR: ${sys.coverAR || 0}`;
            } else if (item.type === "power") {
                const d = sys.dice || {};
                tooltip = `Pool: ${d.normal || 0}d`;
                if (d.hard) tooltip += `+${d.hard}hd`;
                if (d.wiggle) tooltip += `+${d.wiggle}wd`;
                if (sys.quality) tooltip += ` | ${sys.quality}`;
            }

            item.uiTooltip = tooltip;
            item.uiWarning = showWarning;

            buckets[item.type].push(item);
        }
        
        if (item.type === "shield" && item.system.equipped) equippedShields.push(item);
    }
    
    Object.assign(context, {
        weapons: buckets.weapon, gear: buckets.gear, advantages: buckets.advantage,
        problems: buckets.problem, armors: buckets.armor, shields: buckets.shield,
        powers: buckets.power, poisons: buckets.poison,
        activeShields: equippedShields
    });

    // NOTE: Reign sorcery/spell system removed. Powers tab uses `context.powers` (set above).

    // ── Dashboard "Active Miracles" rail (Sprint 4.1) ─────────────────────
    // Shape the actor's powers into card-friendly data for the dashboard's
    // right column. Reuses the same roll wiring as the detail view
    // (data-action="rollStat" data-type="power"). No new roll path.
    //
    // 📖 WT Rulebook Ch6 — Powers are Miracles, Hyperstats, or Hyperskills.
    //   Miracle (p.106): rolled as a standalone dice pool.
    //   Hyperstat (p.104): adds dice to a linked Stat.
    //   Hyperskill (p.105): adds dice to a linked Skill.
    // Each card surfaces the pool, the power type, its qualities (A/D/U),
    // and a roll button. Hyperstats/Hyperskills show what they're linked to.
    context.dashMiracles = (buckets.power || []).map(p => {
      const sys = p.system || {};
      const d = sys.dice || {};
      const n = parseInt(d.normal) || 0;
      const h = parseInt(d.hard) || 0;
      const w = parseInt(d.wiggle) || 0;

      // Compact pool label, e.g. "4d", "3d+1hd", "2d+1hd+2wd"
      const poolParts = [];
      if (n) poolParts.push(`${n}d`);
      if (h) poolParts.push(`${h}hd`);
      if (w) poolParts.push(`${w}wd`);
      const poolLabel = poolParts.length ? poolParts.join("+") : "0d";

      // Power-type label + what it links to (for hypers).
      const pType = sys.powerType || "miracle";
      let typeLabel = "Miracle";
      let linkLabel = "";
      if (pType === "hyperstat") {
        typeLabel = "Hyperstat";
        linkLabel = (sys.linkedStat || "").trim();
      } else if (pType === "hyperskill") {
        typeLabel = "Hyperskill";
        linkLabel = (sys.linkedSkill || "").trim();
      }

      // Qualities → compact A/D/U chips with level. 📖 WT Ch6 — each
      // Quality is Attacks, Defends, or Useful, with a level (dice are
      // shared across qualities; level is the per-quality rating).
      const qualities = (sys.qualities || []).map(q => {
        const t = (q.type || "useful").toLowerCase();
        const short = t === "attacks" ? "A" : t === "defends" ? "D" : "U";
        return {
          type: t,
          short,
          level: parseInt(q.level) || 0,
          capacity: q.capacity || ""
        };
      });

      return {
        id: p.id,
        name: p.name,
        img: p.img,
        poolLabel,
        hasDice: (n + h + w) > 0,
        type: pType,
        typeLabel,
        linkLabel,
        isMiracle: pType === "miracle",
        isHyper: pType === "hyperstat" || pType === "hyperskill",
        qualities,
        hasQualities: qualities.length > 0,
        totalCost: sys.totalCost || 0,
        tooltip: p.uiTooltip || ""
      };
    });
    context.hasDashMiracles = context.dashMiracles.length > 0;


    let shieldBonus = 0;
    const parryShields = equippedShields.filter(s => s.system.shieldSize !== "tower");
    if (parryShields.length > 0) shieldBonus = Math.max(...parryShields.map(s => s.system.parryBonus || 0));

    // WT: Compute totals for preferred defensive moves
    const bodyAttrs = system.attributes?.body || {};
    const bodyVal = (bodyAttrs.normal || 0) + (bodyAttrs.hard || 0) + (bodyAttrs.wiggle || 0);
    const coordAttrs = system.attributes?.coordination || {};
    const coordVal = (coordAttrs.normal || 0) + (coordAttrs.hard || 0) + (coordAttrs.wiggle || 0);
    // Look up dodge and fight skills from freeform skills
    const dodgeSkill = Object.values(system.skills || {}).find(s => (s.label || "").toLowerCase() === "dodge");
    const fightSkill = Object.values(system.skills || {}).find(s => (s.label || "").toLowerCase() === "fight");
    const dodgeVal = dodgeSkill ? ((dodgeSkill.value || 0) + (dodgeSkill.hard || 0) + (dodgeSkill.wiggle || 0)) : 0;
    const parryVal = fightSkill ? ((fightSkill.value || 0) + (fightSkill.hard || 0) + (fightSkill.wiggle || 0)) : 0;
    context.preferredMoves = { body: bodyVal, coord: coordVal, parry: parryVal, dodge: dodgeVal, parryTotal: bodyVal + parryVal + shieldBonus, dodgeTotal: coordVal + dodgeVal, shieldBonus: shieldBonus };

    // PACKAGE C: Aim and Shield state for combat-moves template
    context.aimBonus = this.document.getFlag("wild-talents-2e", "aimBonus") || 0;
    context.hasShields = equippedShields.length > 0;
    context.shieldCoverageSet = !!this.document.getFlag("wild-talents-2e", "shieldCoverage");

    context.customMoves = [];
    if (system.customMoves) {
      for (const [id, move] of Object.entries(system.customMoves)) {
        const attrData = move.attrKey !== "none" ? (system.attributes[move.attrKey] || {}) : {};
        let aVal = (attrData.normal || 0) + (attrData.hard || 0) + (attrData.wiggle || 0);
        let sVal = 0;
        if (move.skillKey !== "none" && system.skills[move.skillKey]) {
          const sk = system.skills[move.skillKey];
          sVal = (sk.value || 0) + (sk.hard || 0) + (sk.wiggle || 0);
        }
        context.customMoves.push({ key: id, name: move.name || "", attrKey: move.attrKey, skillKey: move.skillKey, modifier: move.modifier, total: aVal + sVal + (move.modifier || 0) });
      }
    }

    // ── Per-limb geometry for the new runner silhouette (Sprint 3.2) ──
    // Used to generate procedural lightning paths inside each limb.
    // Coordinates are in the SVG's 200x360 viewBox. Each limb defines:
    //   top, bottom — the y-range the gradient spans (so we know where
    //                 the blue band sits given killPct/shockPct)
    //   originX     — x-coordinate of the lightning spark anchor
    //   armWidth    — approximate width at the top of the limb (for
    //                 branch length scaling). Wider limbs get longer
    //                 branches; thin limbs (arms) stay compact.
    // ── Per-limb geometry for the reference silhouette (Sprint 3.2 revised) ──
    // Coordinates are in the reference SVG's natural viewBox (60 0 87 207).
    // Used to: (a) generate procedural lightning per limb, (b) position
    // crack-pattern rects per limb. Values measured from the reference
    // path's bounding-band sampling.
    //   top, bottom — y-range the gradient spans
    //   originX     — x-coord of the lightning spark anchor
    //   armWidth    — approximate limb width for branch-length scaling
    const LIMB_GEOM = {
      head:  { top:   2, bottom:  40, originX: 104, armWidth: 30 },
      torso: { top:  40, bottom: 118, originX: 104, armWidth: 36 },
      armL:  { top:  40, bottom: 120, originX:  72, armWidth: 14 },
      armR:  { top:  40, bottom: 120, originX: 134, armWidth: 14 },
      legL:  { top: 118, bottom: 208, originX:  94, armWidth: 18 },
      legR:  { top: 118, bottom: 208, originX: 112, armWidth: 18 }
    };

    // Generate a stylised lightning bolt path for a limb's shock band.
    // The bolt always starts at the top of the blue (shock) band, has a
    // jagged trunk going down through the band, and branches off to the
    // sides. Branch count scales with shock damage proportion.
    //
    // Returns { trunk, branches, originX, originY } or null if no shock.
    // The returned path strings are inserted directly into the SVG by
    // the template — keep all values numeric, no user data interpolated.
    const buildLightning = (geom, shockFrac, killFrac) => {
      if (shockFrac <= 0) return null;
      const limbHeight = geom.bottom - geom.top;
      // Blue band sits ABOVE the red band — it starts where the red ends
      // and extends upward by (shockFrac × limbHeight). We measure from
      // the bottom of the limb.
      const killHeight = killFrac * limbHeight;
      const shockHeight = shockFrac * limbHeight;
      const bandBottomY = geom.bottom - killHeight;       // top of red = bottom of blue
      const bandTopY    = geom.bottom - (killHeight + shockHeight);
      // Lightning origin sits at the TOP of the blue band, centred
      const ox = geom.originX;
      const oy = bandTopY + 2; // tiny inset so the spark sits cleanly inside

      // Trunk: zig-zag down the centre of the band, 4-6 segments
      const segCount = Math.max(3, Math.round((bandBottomY - oy) / 14));
      let trunk = `M ${ox},${oy}`;
      const trunkPoints = [{ x: ox, y: oy }];
      let cx = ox, cy = oy;
      for (let i = 1; i <= segCount; i++) {
        const ny = oy + ((bandBottomY - oy) * i / segCount);
        // Alternate left/right with decreasing amplitude
        const amp = Math.min(6, geom.armWidth * 0.18);
        const nx = ox + ((i % 2 === 0 ? -1 : 1) * amp);
        trunk += ` L ${nx.toFixed(1)},${ny.toFixed(1)}`;
        trunkPoints.push({ x: nx, y: ny });
        cx = nx; cy = ny;
      }

      // Branches: scale count with shockFrac. 1 branch at 25%, 2 at 50%,
      // 3 at 75%, 4 at full. Each branch shoots out from a trunk anchor.
      const branchCount = Math.min(4, Math.max(0, Math.floor(shockFrac * 4)));
      const branches = [];
      for (let b = 0; b < branchCount; b++) {
        // Pick a trunk anchor (skip the very first point — branches look
        // better from mid-trunk)
        const anchorIdx = Math.min(trunkPoints.length - 1, 1 + Math.floor(b * (trunkPoints.length - 1) / Math.max(1, branchCount)));
        const a = trunkPoints[anchorIdx];
        const dirSign = (b % 2 === 0) ? -1 : 1;
        const reachX = dirSign * Math.min(geom.armWidth * 0.45, 18);
        const reachY = 6 + (b * 2);
        const midX = a.x + reachX * 0.45;
        const midY = a.y + reachY * 0.4;
        const tipX = a.x + reachX;
        const tipY = a.y + reachY;
        branches.push(`M ${a.x.toFixed(1)},${a.y.toFixed(1)} L ${midX.toFixed(1)},${midY.toFixed(1)} L ${tipX.toFixed(1)},${tipY.toFixed(1)}`);
      }

      return {
        trunk,
        branches: branches.join(" "),
        originX: ox,
        originY: oy,
        hasBranches: branches.length > 0
      };
    };

    context.health = {};
    context.wtHealth = [];

    for (let k of HIT_LOCATIONS) {
        const loc = foundry.utils.deepClone(system.health[k]);
        loc.max = parseInt(effMax?.[k]) || 5;
        loc.killing = parseInt(loc.killing) || 0;
        loc.shock = parseInt(loc.shock) || 0;
        loc.killPct = Math.min(100, Math.round((loc.killing / loc.max) * 100));
        loc.shockPct = Math.min(100, Math.round(((loc.killing + loc.shock) / loc.max) * 100));

        let status = "status-healthy";
        if (loc.killing >= loc.max) status = "status-destroyed";
        else if (loc.killing > 0) status = "status-killing";
        else if (loc.shock > 0) status = "status-shock";

        loc.status = status;

        // ── Sprint 3.2: tooltip + lightning data ──────────────────────
        // 📖 WT Rulebook Ch4 p.61 — damage is tracked per-location as
        // separate Shock and Killing counts.
        const locLabel = HIT_LOCATION_LABELS[k] || k;
        if (status === "status-destroyed") {
          loc.tooltip = `${locLabel} · DESTROYED (${loc.killing}k filled)`;
        } else {
          loc.tooltip = `${locLabel} · ${loc.shock}s / ${loc.killing}k (max ${loc.max})`;
        }

        // Lightning data only when shock is present and the limb isn't
        // fully killed (destroyed limbs render solid black, no overlay).
        const geom = LIMB_GEOM[k];
        if (status !== "status-destroyed" && loc.shock > 0 && geom) {
          const killFrac = Math.min(1, loc.killing / loc.max);
          const shockFrac = Math.min(1 - killFrac, loc.shock / loc.max);
          loc.lightning = buildLightning(geom, shockFrac, killFrac);
        }

        // ── Zone rect + damage band coordinates (Sprint 3.2 revised) ───
        // Computed in the reference SVG's coordinate space so the template
        // can drop them straight into <rect> elements. The damage rects
        // are clipped to the figure outline by the parent <g>'s clip-path.
        //
        // Zone widths/x-coords match the invisible click overlays so the
        // damage paints inside the visible figure where the user clicks.
        if (geom) {
          // Pad the damage band x-range slightly wider than the click
          // overlay so the colour fully covers the figure's edge near
          // the silhouette outline. The clip-path will trim any
          // overhang back to the figure shape.
          // Match the click-overlay bounds exactly. Each damage rect
          // is constrained to its own zone, so a damaged torso doesn't
          // bleed into the arms (which was the previous bug). The
          // whole-figure clip-path further trims to the silhouette edge.
          const ZONE_RECTS = {
            head:  { x: 88,  width: 30 },   // viewer-centered
            torso: { x: 85,  width: 37 },   // central trunk only
            armL:  { x: 60,  width: 25 },   // viewer's left arm
            armR:  { x: 122, width: 25 },   // viewer's right arm
            legL:  { x: 85,  width: 18 },   // viewer's left leg
            legR:  { x: 103, width: 18 }    // viewer's right leg
          };
          const rect = ZONE_RECTS[k];
          if (rect) {
            loc.zoneX = rect.x;
            loc.zoneWidth = rect.width;
            loc.zoneTop = geom.top;
            loc.zoneHeight = geom.bottom - geom.top;
          }
        }

        loc.isDestroyed = (status === "status-destroyed");

        // Killing band rect: where the red fills from the bottom up.
        if (!loc.isDestroyed && loc.killing > 0 && geom && loc.zoneX != null) {
          const limbHeight = geom.bottom - geom.top;
          const killHeight = (loc.killing / loc.max) * limbHeight;
          loc.killBandY = +(geom.bottom - killHeight).toFixed(1);
          loc.killBandHeight = +(killHeight).toFixed(1);
        }

        // Shock band rect: where the blue fills, above the killing band.
        if (!loc.isDestroyed && loc.shock > 0 && geom && loc.zoneX != null) {
          const limbHeight = geom.bottom - geom.top;
          const killHeight = (loc.killing / loc.max) * limbHeight;
          const shockHeight = (loc.shock / loc.max) * limbHeight;
          loc.shockBandY = +(geom.bottom - killHeight - shockHeight).toFixed(1);
          loc.shockBandHeight = +(shockHeight).toFixed(1);
        }

        // Convenience: true if any colour fill needs to be drawn for this zone.
        loc.dmgFill = (loc.killBandHeight > 0 || loc.shockBandHeight > 0);

        context.health[k] = loc;

        let boxes = Array.from({length: loc.max}).map((_, i) => {
            if (i < loc.killing) return { state: "killing", icon: "X" };
            if (i < loc.killing + loc.shock) return { state: "shock", icon: "/" };
            return { state: "empty", icon: "" };
        });

        // PACKAGE C: Shield indicator reads from per-round shieldCoverage flag (set by Combat Actions button).
        // When no round assignment exists, defaults to the carrying arm only.
        let isShielded = false;
        if (equippedShields.length > 0) {
            const roundCoverage = this.document.getFlag("wild-talents-2e", "shieldCoverage") || {};
            const hasRoundAssignment = !foundry.utils.isEmpty(roundCoverage);

            if (hasRoundAssignment) {
                isShielded = equippedShields.some(shield => !!roundCoverage[shield.id]?.[k]);
            } else {
                // No round assignment — default to carrying arm only.
                // The Shield Coverage button is the proper way to assign additional locations.
                isShielded = equippedShields.some(shield => {
                    const shieldArm = shield.system.shieldArm || "armL";
                    return k === shieldArm;
                });
            }
        }

        const locHAR = effHAR?.[k] || 0;
        const locLAR = effLAR?.[k] || 0;
        context.wtHealth.push({ key: k, label: HIT_LOCATION_LABELS[k], boxes: boxes, har: locHAR, lar: locLAR, hasHAR: locHAR > 0, hasLAR: locLAR > 0, isShielded: isShielded, hasArmor: locHAR > 0 || locLAR > 0 });
    }

    const autoStatuses = new Set(["dead", "unconscious", "dazed", "maimed", "prone", "bleeding"]);
    context.autoEffects = [];
    context.manualEffects = [];
    
    for (let e of this.document.effects) {
      if (Array.from(e.statuses).some(s => autoStatuses.has(s))) context.autoEffects.push(e);
      else context.manualEffects.push(e);
    }
    context.effects = Array.from(this.document.effects);

    // ── Character Point Cost Display ──
    // Calculate total character cost from archetype-engine for display on sheet.
    // Uses power items' computed totalCost from WTPowerData.prepareDerivedData().
    const powerItems = (this.document.items || []).filter(i => i.type === "power");
    const powerCostData = powerItems.map(p => ({ totalCost: p.system.totalCost || 0 }));
    const charCost = calculateTotalCharacterCost(system, powerCostData);
    context.characterCost = charCost;

    // Budget from world settings (powerLevel preset or custom)
    const preset = game.settings.get("wild-talents-2e", "powerLevel") || "powerful";
    let pointBudget = 0;
    if (preset === "custom") {
      pointBudget = parseInt(game.settings.get("wild-talents-2e", "powerLevelCustom")) || 0;
    } else {
      // Import would create a circular dep — read the preset points inline
      const PRESET_POINTS = { normalHuman: 100, exceptional: 200, powerful: 250, earthShaking: 500, galactic: 750, universal: 1000 };
      pointBudget = PRESET_POINTS[preset] || 250;
    }
    context.pointBudget = pointBudget;
    context.hasPointBudget = pointBudget > 0;
    context.pointsRemaining = pointBudget > 0 ? pointBudget - charCost.total : null;
    context.overBudget = pointBudget > 0 && charCost.total > pointBudget;

    return context;
  }
}