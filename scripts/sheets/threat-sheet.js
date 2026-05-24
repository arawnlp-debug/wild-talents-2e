// scripts/sheets/threat-sheet.js
const { HandlebarsApplicationMixin } = foundry.applications.api;
import { ThreatRoller } from "../helpers/threat-roller.js";
import { ScrollPreserveMixin } from "../helpers/scroll-mixin.js";
import { wtDialog } from "../helpers/dialog-util.js";
import { HIT_LOCATIONS_SET } from "../helpers/config.js";
import { postOREChat } from "../helpers/chat.js";
import { parseORE } from "../helpers/ore-engine.js";
// Static imports — no dynamic imports needed
import { applyCreatureVenom, applyOffensiveMoraleAttack, applyScatteredDamageToTarget } from "../combat/damage.js";
import { BaseORERoller } from "../helpers/base-roller.js";

// Creature pool cap (RAW: creatures not subject to PC 10d cap; use mob cap of 15)
const CREATURE_POOL_CAP = 15;

// Skills that pair with Sense (not Body or Coordination)
const SENSE_SKILLS = new Set(["hearing","sight","scrutinize","stealth","smell"]);
// Skills that pair with Coordination
const COORD_SKILLS = new Set(["dodge","climb","swim","coordination","acrobatics"]);

/**
 * Normalise a creature skill value to the WT structured format.
 *
 * WT uses Hard Dice (HD) and Wiggle Dice (WD) — not Expert/Master Dice.
 * This function handles:
 *   - Current format: { value, hard, wiggle }
 *   - Legacy Reign format: { value, expert, master } → maps expert→hard, master→wiggle
 *   - Legacy shorthand: "ED" → { value: 0, hard: 1, wiggle: 0 }
 *   - Legacy shorthand: "MD" → { value: 0, hard: 0, wiggle: 1 }
 *   - Flat number: n → { value: n, hard: 0, wiggle: 0 }
 *
 * 📖 WT Rulebook Ch1 p.9-10: Only Normal, Hard, and Wiggle Dice exist.
 */
function normalizeCreatureSkill(val) {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    // Already structured — check if it's the old {expert, master} shape
    if ("expert" in val || "master" in val) {
      return {
        value: parseInt(val.value) || 0,
        hard:  val.expert ? 1 : (parseInt(val.hard) || 0),
        wiggle: val.master ? 1 : (parseInt(val.wiggle) || 0)
      };
    }
    // Current WT format
    return {
      value: parseInt(val.value) || 0,
      hard: parseInt(val.hard) || 0,
      wiggle: parseInt(val.wiggle) || 0
    };
  }
  // Legacy shorthand strings
  if (val === "ED") return { value: 0, hard: 1, wiggle: 0 };
  if (val === "MD") return { value: 0, hard: 0, wiggle: 1 };
  // Flat number
  return { value: typeof val === "number" ? val : (parseInt(val) || 0), hard: 0, wiggle: 0 };
}

export class WTThreatSheet extends ScrollPreserveMixin(HandlebarsApplicationMixin(foundry.applications.sheets.ActorSheetV2)) {
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["wt", "sheet", "actor", "threat"],
    position: { width: 540, height: "auto" },
    window: { resizable: true, minimizable: true },
    form: { submitOnChange: true, closeOnSubmit: false },
    actions: {
      // Mob
      rollThreat:             this.prototype._onRollThreat,
      rollMorale:             this.prototype._onRollMorale,
      receiveMoraleAttack:    this.prototype._onReceiveMoraleAttack,
      eliminateMinions:       this.prototype._onEliminateMinions,
      // Creature mode toggle
      toggleCreatureMode:     this.prototype._onToggleCreatureMode,
      // Locations
      addCreatureLocation:    this.prototype._onAddCreatureLocation,
      removeCreatureLocation: this.prototype._onRemoveCreatureLocation,
      // Attacks
      addCreatureAttack:      this.prototype._onAddCreatureAttack,
      removeCreatureAttack:   this.prototype._onRemoveCreatureAttack,
      // Skills
      addCreatureSkill:       this.prototype._onAddCreatureSkill,
      removeCreatureSkill:    this.prototype._onRemoveCreatureSkill,
      editCreatureSkill:      this.prototype._onEditCreatureSkill,
      // Creature rolling
      rollCreatureSkill:      this.prototype._onRollCreatureSkill,
      rollCreatureAttack:     this.prototype._onRollCreatureAttack,
      // G4.2 Elephant
      elephantTrumpet:        this.prototype._onElephantTrumpet,
      elephantTrunkGrab:      this.prototype._onElephantTrunkGrab,
      // G4.3 Boa
      boaDropAndGrab:         this.prototype._onBoaDropAndGrab,
      boaConstrict:           this.prototype._onBoaConstrict,
      boaReleaseTarget:       this.prototype._onBoaReleaseTarget,
      // G4.4 Rhino
      rhinoBuildCharge:       this.prototype._onRhinoBuildCharge,
      rhinoGoreCharge:        this.prototype._onRhinoGoreCharge,
      // G4.5 Venom
      rollVenom:              this.prototype._onRollVenom,
      // Portrait
      editImage:              this.prototype._onEditImage
    }
  };

  static PARTS = {
    sheet: { template: "systems/wild-talents-2e/templates/actor/threat-sheet.hbs" }
  };

  // =====================================================
  // PORTRAIT
  // =====================================================

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

  // =====================================================
  // LIFECYCLE
  // =====================================================

  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    const html = this.element;

    // ── Wound boxes: event delegation from the root element. The root persists across
    // re-renders, so this binds once and survives. Same pattern as character sheet.
    html.addEventListener("contextmenu", ev => {
      if (ev.target.closest(".cs-wound-box")) ev.preventDefault();
    });
    html.addEventListener("mousedown", ev => {
      const box = ev.target.closest(".cs-wound-box");
      if (!box) return;
      ev.preventDefault();
      this._handleCreatureHealthClick(ev, box);
    });

    // ── Edit-row toggle (config cog button) — Hit Locations
    html.addEventListener("click", ev => {
      const btn = ev.target.closest("[data-action-local='toggleEdit']");
      if (!btn) return;
      const idx = btn.dataset.index;
      const row = html.querySelector(`[data-edit-index="${idx}"]`);
      if (!row) return;
      const open = !row.hidden;
      row.hidden = open;
      btn.querySelector("i").className = open ? "fas fa-cog" : "fas fa-times";
      btn.title = open ? "Configure location" : "Close";
    });

    // ── Edit-row toggle (config cog button) — Attacks
    html.addEventListener("click", ev => {
      const btn = ev.target.closest("[data-action-local='toggleAttackEdit']");
      if (!btn) return;
      const idx = btn.dataset.attackIndex;
      const row = html.querySelector(`[data-attack-edit-index="${idx}"]`);
      if (!row) return;
      const open = !row.hidden;
      row.hidden = open;
      btn.querySelector("i").className = open ? "fas fa-cog" : "fas fa-times";
      btn.title = open ? "Configure attack" : "Close";
    });

    // ── Location config: save field changes directly (no name attributes in form)
    //    Uses {render: false} so the config panel stays open while editing.
    //    DOM is patched manually so the header (name, AR, wound track) stays in sync.
    html.addEventListener("change", ev => {
      const input = ev.target.closest("[data-loc-field]");
      if (!input) return;
      const idx = parseInt(input.dataset.locIndex);
      const field = input.dataset.locField;
      if (isNaN(idx) || !field) return;

      const locs = foundry.utils.deepClone(this.document.system.customLocations || []);
      if (idx >= locs.length) return;

      let val = input.value;
      if (input.type === "number") val = parseInt(val) || 0;
      locs[idx][field] = val;
      this.document.update({ "system.customLocations": locs }, { render: false });

      // ── Patch the visible header so changes show immediately ──
      const locRow = html.querySelector(`.cs-loc-row[data-loc-index="${idx}"]`);
      if (!locRow) return;

      if (field === "name") {
        const nameEl = locRow.querySelector(".cs-loc-name");
        if (nameEl) nameEl.textContent = val;

      } else if (field === "ar") {
        const header = locRow.querySelector(".cs-loc-header");
        let arTag = locRow.querySelector(".cs-ar-tag");
        if (val > 0) {
          if (arTag) { arTag.textContent = `AR${val}`; }
          else {
            arTag = document.createElement("span");
            arTag.className = "cs-ar-tag";
            arTag.textContent = `AR${val}`;
            // Insert before .cs-loc-right
            const right = header?.querySelector(".cs-loc-right");
            right ? header.insertBefore(arTag, right) : header?.appendChild(arTag);
          }
        } else {
          arTag?.remove();
        }

      } else if (field === "woundBoxes") {
        const track = locRow.querySelector(".cs-wound-track");
        if (track) {
          const loc  = locs[idx];
          const killing = loc.killing || 0;
          const shock   = loc.shock   || 0;
          const max     = val; // already parseInt'd above
          track.innerHTML = Array.from({ length: max }, (_, i) => {
            const state = i < killing ? "killing" : (i < killing + shock ? "shock" : "");
            return `<div class="cs-wound-box" data-state="${state}" data-loc-index="${idx}" data-box-index="${i}" title="L: Shock  R: Killing  Shift: Remove"></div>`;
          }).join("");
        }
      }
    });

    // ── Attack config: save field changes directly (no name attributes in form)
    //    Uses {render: false} so the config panel stays open while editing.
    //    Uses "input" (not "change") so saves fire on every keystroke rather than
    //    on blur — this prevents data loss when the config panel is closed before
    //    the text field is explicitly blurred (hiding a parent suppresses "change"
    //    in some browsers but never suppresses "input").
    //    DOM-patches the visible attack name span for immediate feedback, mirroring
    //    the same pattern used by the location config handler.
    html.addEventListener("input", ev => {
      const input = ev.target.closest("[data-atk-field]");
      if (!input) return;
      const idx = parseInt(input.dataset.atkIndex);
      const field = input.dataset.atkField;
      if (isNaN(idx) || !field) return;

      const attacks = foundry.utils.deepClone(this.document.system.creatureAttacks || []);
      if (idx >= attacks.length) return;

      let val = input.value;
      if (input.type === "number") val = parseInt(val) || 0;
      attacks[idx][field] = val;
      this.document.update({ "system.creatureAttacks": attacks }, { render: false });

      // ── Patch the visible attack name span so it updates without a re-render ──
      if (field === "name") {
        const wrap = html.querySelector(`.cs-attack-row-wrap[data-attack-index="${idx}"]`);
        const nameEl = wrap?.querySelector(".cs-attack-name");
        if (nameEl) nameEl.textContent = val;
      }
    });

    // ── Height picker: toggle face buttons to assign/remove heights per location
    //    Uses {render: false} so the sheet stays open — no re-render per click.
    //    Button visuals are toggled manually for instant feedback.
    html.addEventListener("click", ev => {
      const btn = ev.target.closest("[data-action-local='toggleHeight']");
      if (!btn) return;
      const face = parseInt(btn.dataset.face);
      const idx  = parseInt(btn.dataset.locIndex);
      if (isNaN(face) || isNaN(idx)) return;

      const locs = foundry.utils.deepClone(this.document.system.customLocations || []);
      if (idx >= locs.length) return;

      const heights = locs[idx].rollHeights || [];
      const pos = heights.indexOf(face);
      if (pos >= 0) {
        heights.splice(pos, 1);
        btn.classList.remove("cs-face-btn-active");
        // Remove all location color classes
        btn.className = btn.className.replace(/cs-face-loc-\S+/g, "").trim();
      } else {
        heights.push(face);
        btn.classList.add("cs-face-btn-active");
        // Find the location colour from a sibling that has it
        const picker = btn.closest(".cs-height-picker");
        const activeSibling = picker?.querySelector(".cs-face-btn-active[class*='cs-face-loc-']");
        if (activeSibling) {
          const colorMatch = activeSibling.className.match(/cs-face-loc-(\S+)/);
          if (colorMatch) btn.classList.add(`cs-face-loc-${colorMatch[1]}`);
        } else {
          // Fallback: get colour from the location dot in the header
          const locRow = html.querySelector(`[data-loc-index="${idx}"]`);
          const dot = locRow?.querySelector(".cs-loc-dot[class*='cs-face-loc-']");
          if (dot) {
            const colorMatch = dot.className.match(/cs-face-loc-(\S+)/);
            if (colorMatch) btn.classList.add(`cs-face-loc-${colorMatch[1]}`);
          }
        }
      }
      heights.sort((a, b) => a - b);
      locs[idx].rollHeights = heights;

      // Update the header height pips display too
      const locRow = html.querySelector(`.cs-loc-row[data-loc-index="${idx}"]`);
      const pipsContainer = locRow?.querySelector(".cs-loc-heights");
      if (pipsContainer) {
        const dot = locRow.querySelector(".cs-loc-dot[class*='cs-face-loc-']");
        const colorMatch = dot?.className.match(/cs-face-loc-(\S+)/);
        const color = colorMatch ? colorMatch[1] : "brass";
        if (heights.length > 0) {
          pipsContainer.innerHTML = heights.map(h =>
            `<span class="cs-height-badge cs-face-loc-${color}">${h}</span>`
          ).join("");
        } else {
          pipsContainer.innerHTML = `<span class="cs-loc-redir">↪ redirect</span>`;
        }
      }

      // Save without re-rendering — panel stays open for more clicks
      this.document.update({ "system.customLocations": locs }, { render: false });
    });
  }

  // FIX: ArrayField form submissions lose fields that aren't named form inputs.
  // When submitOnChange fires, hidden config panel inputs still get collected by
  // FormData. The expanded data only contains named fields (name, woundBoxes, ar)
  // but NOT rollHeights, shock, killing — so the whole array gets replaced with
  // partial objects, wiping those fields to schema defaults.
  //
  // Two-layer fix:
  // 1. Hidden config panel inputs are disabled (see _onFirstRender) so they don't
  //    appear in FormData at all when closed.
  // 2. When ANY array element IS in the data (open config panel), merge missing
  //    sub-fields from the current document to preserve non-form fields.
  _prepareSubmitData(event, form, formData) {
    const data = super._prepareSubmitData(event, form, formData);

    // ── Merge customLocations: preserve rollHeights, shock, killing ──
    this._mergeExpandedArrayData(data, ["system", "customLocations"],
      this.document.system.customLocations || []);

    // ── Merge creatureAttacks: preserve fields not in config panel ──
    this._mergeExpandedArrayData(data, ["system", "creatureAttacks"],
      this.document.system.creatureAttacks || []);

    // ── Parse rollHeights: if any location data came through, convert
    //    the comma-string (or array) back to a clean number array ──
    const locsInData = data?.system?.customLocations;
    if (locsInData) {
      for (const [idx, loc] of Object.entries(locsInData)) {
        if (loc && "rollHeights" in loc) {
          const raw = loc.rollHeights;
          if (typeof raw === "string") {
            loc.rollHeights = (raw === "redirect only" || raw.trim() === "")
              ? []
              : raw.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= 1 && n <= 10);
          }
          // If it's already an array (from merge), leave it
        }
      }
    }

    return data;
  }

  /**
   * For an expanded ArrayField object at the given path, ensure that when ANY
   * element is in the form data, ALL elements are present with full data.
   * This prevents Foundry from replacing the full array with a partial set.
   *
   * Works on the expanded (nested) object that super._prepareSubmitData returns.
   */
  _mergeExpandedArrayData(data, pathParts, currentArray) {
    // Navigate to the array-like object in the expanded data
    let node = data;
    for (const part of pathParts) {
      if (!node || typeof node !== "object") return;
      node = node[part];
    }
    if (!node || typeof node !== "object") return;

    // Check if any numeric-keyed element is present
    const hasAnyElement = Object.keys(node).some(k => !isNaN(parseInt(k)));
    if (!hasAnyElement) return;

    // Ensure ALL elements are present — if an element is missing entirely,
    // add a full copy from the document. If partially present, fill gaps.
    for (let idx = 0; idx < currentArray.length; idx++) {
      const current = currentArray[idx];
      if (!current) continue;
      const src = current.toObject ? current.toObject() : foundry.utils.deepClone(current);

      if (!(String(idx) in node)) {
        // Element not in form data at all — add full copy from document
        node[String(idx)] = src;
      } else {
        // Element partially in form data — fill in missing fields
        const formElement = node[String(idx)];
        for (const [field, val] of Object.entries(src)) {
          if (!(field in formElement)) {
            formElement[field] = val;
          }
        }
      }
    }
  }

  // =====================================================
  // WOUND BOX CLICK
  // =====================================================

  async _handleCreatureHealthClick(event, box) {
    // FIX: read data-loc-index directly from the box element (no closest() ambiguity)
    const idx    = parseInt(box.dataset.locIndex);
    const boxIdx = parseInt(box.dataset.boxIndex);
    if (isNaN(idx) || isNaN(boxIdx)) return;

    const locs = foundry.utils.deepClone(this.document.system.customLocations || []);
    if (idx >= locs.length) return;
    const loc = locs[idx];

    const max     = loc.woundBoxes || 5;
    let shock     = loc.shock   || 0;
    let killing   = loc.killing || 0;

    if (event.shiftKey) {
      // Triage: remove damage right-to-left (killing first, then shock)
      if (killing > 0) killing--;
      else if (shock > 0) shock--;
    } else if (event.button === 2) {
      // Right-click: add Killing directly
      if (killing < max) {
        if (shock + killing >= max && shock > 0) shock--;
        killing++;
      }
    } else {
      // Left-click: add Shock; if full, convert oldest Shock to Killing
      if (shock + killing < max) {
        shock++;
      } else if (shock > 0 && killing < max) {
        shock--;
        killing++;
      }
    }

    loc.shock   = shock;
    loc.killing = killing;
    await this.document.update({ "system.customLocations": locs });
  }

  // =====================================================
  // MOB ACTION HANDLERS (existing — unchanged)
  // =====================================================

  async _onRollThreat(event, target) {
    event.preventDefault();
    try { await ThreatRoller.rollThreat(this.document, target.dataset); }
    catch (err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onRollMorale(event, target) {
    event.preventDefault();
    try { await ThreatRoller.rollMorale(this.document); }
    catch (err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onReceiveMoraleAttack(event, target) {
    event.preventDefault();
    try {
      const content = `<form class="wt-dialog-form">
        <div class="form-group">
          <label>Morale Attack Value:</label>
          <input type="number" name="maValue" value="3" min="1" max="10" />
        </div>
        <div class="form-group">
          <label>Source:</label>
          <input type="text" name="maSource" value="Morale Attack" />
        </div>
      </form>`;
      const result = await wtDialog("Receive Morale Attack", content,
        (e, b, d) => {
          const f = d.element.querySelector("form") || d.element;
          return { maValue: parseInt(f.querySelector('[name="maValue"]')?.value) || 0,
                   maSource: f.querySelector('[name="maSource"]')?.value || "Morale Attack" };
        }, { defaultLabel: "Apply" });
      if (!result || result.maValue < 1) return;
      await ThreatRoller.receiveMoraleAttack(this.document, result.maValue, result.maSource);
    } catch (err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onEliminateMinions(event, target) {
    event.preventDefault();
    try {
      const actor = this.document;
      const currentGroup = actor.system.magnitude?.value || 0;
      if (currentGroup <= 0) return ui.notifications.warn(`${actor.name} has no active fighters remaining.`);
      const content = `<form class="wt-dialog-form">
        <p>Currently <strong>${currentGroup}</strong> / ${actor.system.magnitude?.max || currentGroup} active.</p>
        <div class="form-group">
          <label>Fighters to Remove:</label>
          <input type="number" name="removeCount" value="1" min="1" max="${currentGroup}" />
        </div>
        <div class="form-group">
          <label>Reason:</label>
          <input type="text" name="reason" value="Manual Removal" />
        </div>
      </form>`;
      const result = await wtDialog("Eliminate Fighters", content,
        (e, b, d) => {
          const f = d.element.querySelector("form") || d.element;
          return { count: parseInt(f.querySelector('[name="removeCount"]')?.value) || 0,
                   reason: f.querySelector('[name="reason"]')?.value || "Manual Removal" };
        }, { defaultLabel: "Remove" });
      if (!result || result.count < 1) return;
      await ThreatRoller.eliminateMinions(actor, result.count, result.reason);
    } catch (err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  // =====================================================
  // CREATURE MODE TOGGLE
  // =====================================================

  async _onToggleCreatureMode(event, target) {
    event.preventDefault();
    const newMode = !this.document.system.creatureMode;
    await this.document.update({ "system.creatureMode": newMode });
  }

  // =====================================================
  // LOCATION MANAGEMENT
  // =====================================================

  async _onAddCreatureLocation(event, target) {
    event.preventDefault();
    const locs = foundry.utils.deepClone(this.document.system.customLocations || []);
    locs.push({ key: `loc${locs.length}`, name: "New Location", rollHeights: [], woundBoxes: 5, ar: 0, shock: 0, killing: 0 });
    await this.document.update({ "system.customLocations": locs });
  }

  async _onRemoveCreatureLocation(event, target) {
    event.preventDefault();
    const idx = parseInt(target.dataset.index);
    const locs = foundry.utils.deepClone(this.document.system.customLocations || []);
    if (isNaN(idx) || idx < 0 || idx >= locs.length) return;
    locs.splice(idx, 1);
    await this.document.update({ "system.customLocations": locs });
  }

  // =====================================================
  // ATTACK MANAGEMENT
  // =====================================================

  async _onAddCreatureAttack(event, target) {
    event.preventDefault();
    const attacks = foundry.utils.deepClone(this.document.system.creatureAttacks || []);
    attacks.push({ name: "New Attack", attribute: "body", skill: "", damage: "Width Shock", notes: "", isSlow: 0 });
    await this.document.update({ "system.creatureAttacks": attacks });
  }

  async _onRemoveCreatureAttack(event, target) {
    event.preventDefault();
    const idx = parseInt(target.dataset.attackIndex);
    const attacks = foundry.utils.deepClone(this.document.system.creatureAttacks || []);
    if (isNaN(idx) || idx < 0 || idx >= attacks.length) return;
    attacks.splice(idx, 1);
    await this.document.update({ "system.creatureAttacks": attacks });
  }

  // =====================================================
  // SKILL MANAGEMENT
  // =====================================================

  async _onAddCreatureSkill(event, target) {
    event.preventDefault();
    const existingSkills = this.document.system.creatureSkills || {};

    // Build option lists excluding already-added skills
    const COMBAT_SKILLS = ["fight","bite","claw","kick","ram","constrict","trample","grapple","dodge","parry","athletics","climb","swim","run","stealth"];
    const PERCEPTION_SKILLS = ["hearing","sight","scrutinize","smell"];
    const allPredefined = [...COMBAT_SKILLS, ...PERCEPTION_SKILLS];
    const available = allPredefined.filter(k => !(k in existingSkills));

    const optionsHtml = available.map(k => {
      const label = k.charAt(0).toUpperCase() + k.slice(1);
      return `<option value="${k}">${label}</option>`;
    }).join("");

    const content = `
      <form class="wt-dialog-form">
        <div class="form-group">
          <label>Skill</label>
          <select name="skillKey" id="cs-add-skill-select">
            ${optionsHtml}
            <option value="__custom__">— Custom —</option>
          </select>
        </div>
        <div class="form-group" id="cs-custom-skill-group" style="display:none;">
          <label>Custom Skill Name</label>
          <input type="text" name="customKey" placeholder="e.g. tailSwipe"/>
        </div>
        <div class="form-group">
          <label>Normal Dice</label>
          <input type="number" name="skillValue" value="2" min="0" max="10" style="width:60px;"/>
        </div>
        <div class="wt-grid-2col wt-gap-small">
          <div class="form-group">
            <label>Hard Dice (HD)</label>
            <input type="number" name="hardDice" value="0" min="0" max="5" style="width:60px;"/>
          </div>
          <div class="form-group">
            <label>Wiggle Dice (WD)</label>
            <input type="number" name="wiggleDice" value="0" min="0" max="5" style="width:60px;"/>
          </div>
        </div>
        <p class="wt-text-small wt-text-muted">📖 HD always show as 10. WD are assigned a face (1–10) after rolling.</p>
      </form>`;

    const result = await wtDialog("Add Creature Skill", content,
      (e, b, d) => {
        const f = d.element.querySelector("form");
        let key = f.querySelector('[name="skillKey"]')?.value;
        if (key === "__custom__") key = f.querySelector('[name="customKey"]')?.value?.trim().replace(/\s+/g, "");
        const numVal = parseInt(f.querySelector('[name="skillValue"]')?.value) || 0;
        const hardVal = parseInt(f.querySelector('[name="hardDice"]')?.value) || 0;
        const wiggleVal = parseInt(f.querySelector('[name="wiggleDice"]')?.value) || 0;
        return {
          key,
          value: { value: numVal, hard: hardVal, wiggle: wiggleVal }
        };
      },
      {
        defaultLabel: "Add Skill",
        render: (context, el) => {
          const select = el.querySelector("#cs-add-skill-select");
          const customGroup = el.querySelector("#cs-custom-skill-group");
          select?.addEventListener("change", () => {
            customGroup.style.display = select.value === "__custom__" ? "" : "none";
          });
        }
      }
    );

    if (!result || !result.key) return;
    if (result.key in existingSkills) return ui.notifications.warn(`Skill "${result.key}" already exists.`);

    const update = { [`system.creatureSkills.${result.key}`]: result.value };
    await this.document.update(update);
  }

  async _onRemoveCreatureSkill(event, target) {
    event.preventDefault();
    const key = target.dataset.skillKey;
    if (!key) return;
    try {
      // V14+ operator-based deletion (same pattern as character sheet)
      const del = globalThis._del ?? foundry?.data?.operators?.ForcedDeletion?.create?.();
      if (del) {
        await this.document.update({ [`system.creatureSkills.${key}`]: del });
      } else {
        // Fallback for older cores / edge builds
        await this.document.update({ [`system.creatureSkills.-=${key}`]: null });
      }
    } catch(err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onEditCreatureSkill(event, target) {
    event.preventDefault();
    const key = target.dataset.skillKey;
    if (!key) return;
    const rawVal = this.document.system.creatureSkills?.[key];
    const sk = normalizeCreatureSkill(rawVal);
    const label = key.replace(/([A-Z])/g, " $1").trim();
    const labelCap = label.charAt(0).toUpperCase() + label.slice(1);

    const content = `
      <form class="wt-dialog-form">
        <div class="wt-dialog-callout">
          <strong>${labelCap}</strong>
        </div>
        <div class="form-group">
          <label>Normal Dice</label>
          <input type="number" name="skillValue" value="${sk.value}" min="0" max="10" style="width:60px;" autofocus/>
        </div>
        <div class="wt-grid-2col wt-gap-small">
          <div class="form-group">
            <label>Hard Dice (HD)</label>
            <input type="number" name="hardDice" value="${sk.hard}" min="0" max="5" style="width:60px;"/>
          </div>
          <div class="form-group">
            <label>Wiggle Dice (WD)</label>
            <input type="number" name="wiggleDice" value="${sk.wiggle}" min="0" max="5" style="width:60px;"/>
          </div>
        </div>
        <p class="wt-text-small wt-text-muted">📖 HD always show as 10. WD are assigned a face (1–10) after rolling.</p>
      </form>`;

    const result = await wtDialog(`Edit Skill — ${labelCap}`, content,
      (e, b, d) => {
        const f = d.element.querySelector("form");
        const numVal = parseInt(f.querySelector('[name="skillValue"]')?.value) || 0;
        const hardVal = parseInt(f.querySelector('[name="hardDice"]')?.value) || 0;
        const wiggleVal = parseInt(f.querySelector('[name="wiggleDice"]')?.value) || 0;
        return { value: numVal, hard: hardVal, wiggle: wiggleVal };
      },
      { defaultLabel: "Save" }
    );

    if (result === null || result === undefined) return;
    await this.document.update({ [`system.creatureSkills.${key}`]: result });
  }

  // =====================================================
  // CREATURE ROLLING — WT HD/WD Mechanics
  // =====================================================

  /**
   * Silent roll helper — no dialog. Used by special-ability handlers (Boa, Rhino)
   * that have their own scripted flow with custom chat cards.
   * Returns { results, parsed, pool, roll }.
   *
   * 📖 WT Rulebook Ch1 p.9-10: HD always 10, WD assigned post-roll.
   */
  async _rollCreaturePoolSilent(actor, attrKey, skillKey) {
    const attrs    = actor.system.creatureAttributes || {};
    const skills   = actor.system.creatureSkills     || {};
    const sk       = normalizeCreatureSkill(skills[skillKey]);
    const numVal   = sk.value;
    const hdCount  = sk.hard;
    const wdCount  = sk.wiggle;
    // Creature attributes also use N/HD/WD via makeStatDice()
    const attrData = attrs[attrKey] || {};
    const attrN    = parseInt(attrData.normal) || parseInt(attrData) || 0;
    const attrHD   = parseInt(attrData.hard) || 0;
    const attrWD   = parseInt(attrData.wiggle) || 0;

    const totalHD = hdCount + attrHD;
    const totalWD = wdCount + attrWD;
    const specialCount = totalHD + totalWD;
    const pool       = Math.min(attrN + numVal + specialCount, CREATURE_POOL_CAP);
    const normalPool = Math.max(pool - specialCount, 0);

    const roll = normalPool > 0 ? new Roll(`${normalPool}d10`) : null;
    if (roll) await roll.evaluate();
    let results = roll ? roll.dice[0].results.map(r => r.result) : [];

    // HD: always 10 (📖 Ch1 p.9)
    for (let i = 0; i < totalHD; i++) results.push(10);

    // WD: prompt for face assignment (📖 Ch1 p.10)
    if (totalWD > 0) {
      const wdFaces = await BaseORERoller.promptWiggleDice(
        results, totalWD,
        Array.from({ length: totalHD }, () => ({ face: 10 })),
        "Assign Wiggle Dice"
      );
      if (wdFaces) results.push(...wdFaces);
      else return { results, parsed: parseORE(results), pool, roll }; // Cancelled
    }

    return { results, parsed: parseORE(results), pool, roll };
  }

  /**
   * Opens a roll dialog for a creature pool, builds the breakdown,
   * rolls the dice using WT HD/WD mechanics, and posts via postOREChat.
   *
   * The dialog allows GMs to adjust bonus/penalty, override HD/WD counts,
   * set multi-actions, and add a difficulty target.
   *
   * 📖 WT Rulebook Ch1 p.9-10: HD always 10, WD assigned post-roll.
   */
  async _rollCreaturePool(actor, attrKey, skillKey, labelOverride = null, itemData = null) {
    const attrs    = actor.system.creatureAttributes || {};
    const skills   = actor.system.creatureSkills     || {};
    const sk       = normalizeCreatureSkill(skills[skillKey]);
    const numVal   = sk.value;
    const baseHD   = sk.hard;
    const baseWD   = sk.wiggle;
    // Creature attributes use makeStatDice() — extract N/HD/WD
    const attrData = attrs[attrKey] || {};
    const attrN    = parseInt(attrData.normal) || parseInt(attrData) || 0;
    const attrHD   = parseInt(attrData.hard) || 0;
    const attrWD   = parseInt(attrData.wiggle) || 0;

    const attrLabel  = attrKey.charAt(0).toUpperCase() + attrKey.slice(1);
    const skillLabel = skillKey ? (skillKey.charAt(0).toUpperCase() + skillKey.slice(1).replace(/([A-Z])/g, " $1").trim()) : "";

    // Build display string for the base pool breakdown
    const totalBaseHD = baseHD + attrHD;
    const totalBaseWD = baseWD + attrWD;
    const skillParts = [];
    if (skillKey) {
      const parts = [];
      if (numVal > 0) parts.push(`${numVal}d`);
      if (baseHD > 0) parts.push(`${baseHD}hd`);
      if (baseWD > 0) parts.push(`${baseWD}wd`);
      skillParts.push(`${skillLabel} ${parts.join("+") || "0"}`);
    }
    const attrParts = [];
    if (attrN > 0) attrParts.push(`${attrN}d`);
    if (attrHD > 0) attrParts.push(`${attrHD}hd`);
    if (attrWD > 0) attrParts.push(`${attrWD}wd`);
    const poolDesc = `${attrLabel} ${attrParts.join("+") || "0"}${skillParts.length ? ` + ${skillParts.join(" + ")}` : ""}`;

    // Roll dialog content — HD/WD override instead of ED/MD
    const content = `
      <form class="wt-dialog-form">
        <div class="wt-dialog-callout">
          <strong>${labelOverride || skillLabel}</strong>
          <div class="wt-text-muted wt-text-small">
            Base pool: ${poolDesc}
          </div>
        </div>
        <div class="wt-grid-2col wt-gap-small">
          <div class="form-group">
            <label>Bonus dice (+)</label>
            <input type="number" name="bonus" value="0" min="0" max="10"/>
          </div>
          <div class="form-group">
            <label>Penalty dice (−)</label>
            <input type="number" name="penalty" value="0" min="0" max="10"/>
          </div>
          <div class="form-group">
            <label>Multi-actions</label>
            <input type="number" name="multiActions" value="1" min="1" max="5"/>
          </div>
          <div class="form-group">
            <label>Difficulty (Height ≥)</label>
            <input type="number" name="difficulty" value="0" min="0" max="10"/>
          </div>
          <div class="form-group">
            <label>Hard Dice (HD)</label>
            <input type="number" name="hardDice" value="${totalBaseHD}" min="0" max="5"/>
          </div>
          <div class="form-group">
            <label>Wiggle Dice (WD)</label>
            <input type="number" name="wiggleDice" value="${totalBaseWD}" min="0" max="5"/>
          </div>
        </div>
      </form>`;

    const opts = await wtDialog(
      `Roll ${labelOverride || skillLabel}`,
      content,
      (e, b, d) => {
        const f = d.element.querySelector("form");
        return {
          bonus:        parseInt(f.querySelector('[name="bonus"]')?.value)        || 0,
          penalty:      parseInt(f.querySelector('[name="penalty"]')?.value)      || 0,
          multiActions: Math.max(parseInt(f.querySelector('[name="multiActions"]')?.value) || 1, 1),
          difficulty:   parseInt(f.querySelector('[name="difficulty"]')?.value)   || 0,
          hardDice:     parseInt(f.querySelector('[name="hardDice"]')?.value)     || 0,
          wiggleDice:   parseInt(f.querySelector('[name="wiggleDice"]')?.value)   || 0,
        };
      },
      { defaultLabel: "Roll" }
    );

    if (!opts) return; // cancelled

    const useHD = opts.hardDice;
    const useWD = opts.wiggleDice;
    const specialCount = useHD + useWD;

    // Pool calculation — track each modifier for the breakdown display
    const breakdown = [];
    let pool = 0;
    breakdown.push({ label: attrLabel,                  value: `+${attrN}`,  isPenalty: false });
    pool += attrN;
    if (skillKey && numVal > 0) {
      breakdown.push({ label: skillLabel,               value: `+${numVal}`,   isPenalty: false });
      pool += numVal;
    }
    if (useHD > 0) breakdown.push({ label: `Hard Dice`,  value: `+${useHD} (always 10)`, isPenalty: false });
    if (useWD > 0) breakdown.push({ label: `Wiggle Dice`, value: `+${useWD} (assigned)`, isPenalty: false });
    pool += specialCount;
    if (opts.bonus > 0) {
      breakdown.push({ label: "Bonus",                   value: `+${opts.bonus}`, isPenalty: false });
      pool += opts.bonus;
    }
    if (opts.penalty > 0) {
      breakdown.push({ label: "Penalty",                 value: `−${opts.penalty}`, isPenalty: true });
      pool -= opts.penalty;
    }
    if (opts.multiActions > 1) {
      const maPenalty = opts.multiActions - 1;
      breakdown.push({ label: `Multi-action (${opts.multiActions})`, value: `−${maPenalty}`, isPenalty: true });
      pool -= maPenalty;
    }

    // Apply creature pool cap
    const wasCapped = pool > CREATURE_POOL_CAP;
    if (wasCapped) {
      breakdown.push({ label: "Capped",                  value: `→${CREATURE_POOL_CAP}d`, isPenalty: true });
      pool = CREATURE_POOL_CAP;
    }
    pool = Math.max(pool, 0);

    // Roll: normal pool minus special dice (HD/WD are injected separately)
    const normalPool = Math.max(pool - specialCount, 0);
    const roll = normalPool > 0 ? new Roll(`${normalPool}d10`) : null;
    if (roll) await roll.evaluate();
    let results = roll ? roll.dice[0].results.map(r => r.result) : [];

    // HD: always 10 (📖 Ch1 p.9)
    for (let i = 0; i < useHD; i++) results.push(10);

    // WD: prompt for face assignment after seeing the roll (📖 Ch1 p.10)
    if (useWD > 0) {
      const wdFaces = await BaseORERoller.promptWiggleDice(
        results, useWD,
        Array.from({ length: useHD }, () => ({ face: 10 })),
        "Assign Wiggle Dice"
      );
      if (!wdFaces) return; // Cancelled
      results.push(...wdFaces);
    }

    // Clean label for title — just the action name
    const cleanLabel = labelOverride || skillLabel;

    await postOREChat(
      actor, cleanLabel, pool, results,
      useHD,   // hardDieCount
      useWD,   // wiggleDieCount
      itemData,
      {
        multiActions: opts.multiActions,
        difficulty:   opts.difficulty,
        wasCapped,
        poolBreakdown: breakdown,
        isAttack:  !!itemData,
        isDefense: false
      },
      roll
    );
  }

  async _onRollCreatureSkill(event, target) {
    event.preventDefault();
    try {
      const actor    = this.document;
      const skillKey = target.dataset.skillKey;
      const attrKey  = SENSE_SKILLS.has(skillKey) ? "sense"
                     : COORD_SKILLS.has(skillKey) ? "coordination" : "body";
      await this._rollCreaturePool(actor, attrKey, skillKey);
    } catch (err) {
      ui.notifications.error(`Roll failed: ${err.message}`); console.error(err);
    }
  }

  async _onRollCreatureAttack(event, target) {
    event.preventDefault();
    try {
      const actor = this.document;
      const idx   = parseInt(target.dataset.attackIndex);
      const atk   = actor.system.creatureAttacks?.[idx];
      if (!atk) return ui.notifications.warn("Attack definition not found.");

      const itemData = {
        name: atk.name, type: "weapon",
        system: {
          damage:    atk.damage,
          pool: "", range: "",
          qualities: { armorPiercing: 0, slow: atk.isSlow || 0, area: 0, massive: false }
        }
      };

      await this._rollCreaturePool(
        actor, atk.attribute || "body", atk.skill || "", atk.name, itemData
      );
      // No auto-venom — explicit Roll Venom button only.
    } catch (err) {
      ui.notifications.error(`Attack roll failed: ${err.message}`); console.error(err);
    }
  }

  // =====================================================
  // G4.2: ELEPHANT
  // =====================================================

  async _onElephantTrumpet(event, target) {
    event.preventDefault();
    try {
      if (this.document.getFlag("wild-talents-2e", "elephantTrumpetUsed"))
        return ui.notifications.warn("Already used this combat.");

      const content = `<form class="wt-dialog-form">
        <p class="wt-text-small wt-text-muted">RAW Ch13: Once per combat. MA 4 vs familiar opponents; MA 10 vs those who have never seen an elephant.</p>
        <div class="form-group">
          <label>Morale Attack Strength:</label>
          <select name="maValue">
            <option value="4">4 — Familiar opponents</option>
            <option value="10">10 — Never seen an elephant</option>
          </select>
        </div>
      </form>`;
      const maValue = await wtDialog("Elephant Rears and Trumpets!", content,
        (e, b, d) => parseInt(d.element.querySelector('[name="maValue"]')?.value) || 4,
        { defaultLabel: "Apply Morale Attack" });
      if (!maValue) return;
      await applyOffensiveMoraleAttack(maValue, "Elephant Rears and Trumpets!");
      await this.document.setFlag("wild-talents-2e", "elephantTrumpetUsed", true);
    } catch (err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onElephantTrunkGrab(event, target) {
    event.preventDefault();
    try {
      const targets = game.user.targets;
      if (!targets.size) return ui.notifications.warn("Select a target token first.");
      const targetNames = [...targets].map(t => foundry.utils.escapeHTML(t.name)).join(", ");
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this.document }),
        content: `<div class="wt-chat-card">
          <h3>🐘 Trunk Grab — ${foundry.utils.escapeHTML(this.document.name)}</h3>
          <p><strong>Target:</strong> ${targetNames}</p>
          <p>Roll <strong>Body + Grapple</strong>. On a hit: target is <strong>Pinned</strong>. Apply Pinned status manually.</p>
          <p class="wt-text-small">Each subsequent round: 3 Shock to Torso automatically while held.<br>
          Escape: <strong>Body + Fight or Coordination + Grapple</strong> vs elephant's <strong>Body + Fight</strong> (contested). (RAW Ch13.)</p>
        </div>`
      });
    } catch (err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  // =====================================================
  // G4.3: BOA CONSTRICTOR
  // =====================================================

  async _onBoaDropAndGrab(event, target) {
    event.preventDefault();
    try {
      const actor   = this.document;
      const targets = game.user.targets;
      if (!targets.size) return ui.notifications.warn("Select a target token first.");

      const { results, parsed, pool, roll } = await this._rollCreaturePoolSilent(actor, "body", "constrict");
      const hasSet = parsed.sets.length > 0;
      const targetList = [...targets];

      if (hasSet) {
        await actor.update({
          "system.creatureFlags.constrictActive":   true,
          "system.creatureFlags.constrictTargetId": targetList[0]?.actor?.id || ""
        });
        for (const t of targetList) {
          if (t.actor) await t.actor.toggleStatusEffect("restrained", { active: true });
        }
      }

      const diceDisplay = results.map(r => `<span class="wt-die wt-die-plain">${r}</span>`).join(" ");
      const targetNames = targetList.map(t => foundry.utils.escapeHTML(t.name)).join(", ");
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="wt-chat-card">
          <h3>🐍 Drop & Grab — ${foundry.utils.escapeHTML(actor.name)}</h3>
          <p><strong>Target:</strong> ${targetNames}</p>
          <div class="dice-tray wrap">${diceDisplay}</div>
          <p>${hasSet
            ? `<strong class="wt-text-danger">Set ${parsed.sets[0].width}×${parsed.sets[0].height} — TARGET IS PINNED!</strong>`
            : `<span class="wt-text-muted">No set — grab fails.</span>`}</p>
          ${hasSet ? `<p class="wt-text-small">Each round: roll <em>Constrict</em> from the Special Abilities panel.</p>` : ""}
        </div>`
      });
    } catch (err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onBoaConstrict(event, target) {
    event.preventDefault();
    try {
      const actor = this.document;
      if (!actor.system.creatureFlags?.constrictActive)
        return ui.notifications.warn("Constrict not active. Use Drop & Grab first.");

      // FIX BUG-003: use stored constrictTargetId, not game.user.targets
      const targetId    = actor.system.creatureFlags.constrictTargetId;
      const targetActor = targetId ? game.actors.get(targetId) : null;

      const { results, parsed, pool } = await this._rollCreaturePoolSilent(actor, "body", "constrict");
      const hasSet = parsed.sets.length > 0;
      const dmgWidth = hasSet ? parsed.sets[0].width : 0;

      if (hasSet && targetActor) {
        await applyScatteredDamageToTarget(
          parsed.sets[0].width, parsed.sets[0].height,
          `${dmgWidth} Shock`, 0, false, dmgWidth, actor,
          { ignoreFlexibleArmor: true, targetActorId: targetId }
        );
      }

      const diceDisplay = results.map(r => `<span class="wt-die wt-die-plain">${r}</span>`).join(" ");
      const bodyVal     = actor.system.creatureAttributes?.body || "?";
      const constSkill  = normalizeCreatureSkill(actor.system.creatureSkills?.constrict);
      const constVal    = constSkill.value || "?";
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="wt-chat-card">
          <h3>🐍 Constrict — ${foundry.utils.escapeHTML(actor.name)}</h3>
          <div class="dice-tray wrap">${diceDisplay}</div>
          <p>${hasSet
            ? `<strong class="wt-text-danger">Area Shock ×${dmgWidth}</strong> applied (ignores chain/leather AR).`
            : `<span class="wt-text-muted">No set — no effect this round.</span>`}</p>
          <p class="wt-text-small">Escape: <strong>Body+Fight or Coordination+Grapple</strong> vs Difficulty equal to the boa's Body (${bodyVal}) or Constrict (${constVal}), whichever is higher. (RAW Ch6 — Pin escape.)</p>
        </div>`
      });
    } catch (err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onBoaReleaseTarget(event, target) {
    event.preventDefault();
    try {
      const actor     = this.document;
      const targetId  = actor.system.creatureFlags?.constrictTargetId;
      const targetActor = targetId ? game.actors.get(targetId) : null;
      await actor.update({
        "system.creatureFlags.constrictActive":   false,
        "system.creatureFlags.constrictTargetId": ""
      });
      if (targetActor) await targetActor.toggleStatusEffect("restrained", { active: false });
    } catch (err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  // =====================================================
  // G4.4: RHINO CHARGE
  // =====================================================

  async _onRhinoBuildCharge(event, target) {
    event.preventDefault();
    try {
      const actor = this.document;
      const { results, parsed, pool } = await this._rollCreaturePoolSilent(actor, "body", "run");
      const newWidth = parsed.sets.length > 0 ? parsed.sets[0].width : 0;
      const prevWidest = actor.system.creatureFlags?.chargeRunWidest || 0;
      const bestWidth  = Math.max(prevWidest, newWidth);
      if (newWidth > prevWidest) await actor.update({ "system.creatureFlags.chargeRunWidest": bestWidth });

      const BONUS = { 2: "+1 Killing", 3: "+2 Shock, +1 Killing", 4: "+3 Shock, +2 Killing" };
      const bonusLabel = bestWidth >= 4 ? BONUS[4] : (BONUS[bestWidth] || "No bonus yet (need Width 2+)");
      const diceDisplay = results.map(r => `<span class="wt-die wt-die-plain">${r}</span>`).join(" ");

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="wt-chat-card">
          <h3>🦏 Building Charge — ${foundry.utils.escapeHTML(actor.name)}</h3>
          <div class="dice-tray wrap">${diceDisplay}</div>
          <p>Run roll: <strong>${newWidth > 0 ? `${newWidth}×${parsed.sets[0].height}` : "No set"}</strong>
             | Best Width: <strong>${bestWidth}</strong></p>
          <p>Current bonus: <strong>${bonusLabel}</strong></p>
        </div>`
      });
    } catch (err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  async _onRhinoGoreCharge(event, target) {
    event.preventDefault();
    try {
      const actor       = this.document;
      const chargeWidth = actor.system.creatureFlags?.chargeRunWidest || 0;
      const { results, parsed, pool } = await this._rollCreaturePoolSilent(actor, "body", "fight");
      await actor.update({ "system.creatureFlags.chargeRunWidest": 0 });

      const diceDisplay = results.map(r => `<span class="wt-die wt-die-plain">${r}</span>`).join(" ");
      if (!parsed.sets.length) {
        return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }),
          content: `<div class="wt-chat-card"><h3>🦏 Gore — Missed!</h3><div class="dice-tray wrap">${diceDisplay}</div><p>No set. Charge is spent.</p></div>` });
      }

      const hit = parsed.sets[0];
      let bonusShock = 0, bonusKilling = 0;
      if      (chargeWidth >= 4) { bonusShock = 3; bonusKilling = 2; }
      else if (chargeWidth >= 3) { bonusShock = 2; bonusKilling = 1; }
      else if (chargeWidth >= 2) { bonusKilling = 1; }

      const baseKilling  = hit.width + 1;
      const totalKilling = baseKilling + bonusKilling;
      const dmgStr       = `${totalKilling} Killing${bonusShock > 0 ? ` + ${bonusShock} Shock` : ""}`;
      const chargeStr    = chargeWidth > 0 ? ` + Charge (Width ${chargeWidth})` : "";

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div class="wt-chat-card">
          <h3>🦏 Gore with Charge — ${foundry.utils.escapeHTML(actor.name)}</h3>
          <div class="dice-tray wrap">${diceDisplay}</div>
          <p>Hit: <strong>${hit.width}×${hit.height}</strong>${chargeStr}</p>
          <p>Damage: <strong>${dmgStr}</strong></p>
          <div class="wt-action-buttons">
            <button class="wt-btn-primary apply-dmg-btn"
              data-width="${hit.width}" data-height="${hit.height}"
              data-dmg-string="${totalKilling} Killing"
              data-ap="0" data-massive="false" data-area-dice="0">Apply Damage</button>
          </div>
        </div>`
      });
    } catch (err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  // =====================================================
  // G4.5: VENOM — explicit manual trigger only (not auto)
  // =====================================================

  async _onRollVenom(event, target) {
    event.preventDefault();
    try {
      const targets     = game.user.targets;
      const targetActor = targets.size > 0 ? [...targets][0].actor : null;
      await applyCreatureVenom(this.document, targetActor);
    } catch (err) { ui.notifications.error(`Action failed: ${err.message}`); console.error(err); }
  }

  // =====================================================
  // DATA PREPARATION
  // =====================================================

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.actor  = this.document;
    context.system = this.document.system;

    // Mob context
    const companyList = {};
    game.actors.filter(a => a.type === "company").sort((a,b) => a.name.localeCompare(b.name))
      .forEach(c => { companyList[c.id] = c.name; });
    context.companies    = companyList;
    context.groupSize    = this.document.system.magnitude?.value || 0;
    context.maxGroup     = this.document.system.magnitude?.max   || 0;
    context.threatRating = this.document.system.threatLevel || 1;
    context.isDestroyed  = context.groupSize <= 0;
    context.effectivePool = Math.min(context.groupSize, 15);
    context.poolCapped    = context.groupSize > 15;
    context.groupPercent  = context.maxGroup > 0
      ? Math.round((context.groupSize / context.maxGroup) * 100) : 0;

    context.isCreatureMode = !!this.document.system.creatureMode;
    if (!context.isCreatureMode) return context;

    const locs  = this.document.system.customLocations || [];
    const attrs = this.document.system.creatureAttributes || {};

    // ── Location colour palette
    const LOC_COLORS = ["blood","brass","emerald","blue","purple","teal","ash","amber"];

    // ── Die-face heat map
    const faceMapRaw = {};
    for (let f = 1; f <= 10; f++) faceMapRaw[f] = null;

    // ── Enriched location data
    context.creatureLocations = locs.map((loc, idx) => {
      const shock   = loc.shock   || 0;
      const killing = loc.killing || 0;
      const max     = loc.woundBoxes || 5;
      const color   = LOC_COLORS[idx % LOC_COLORS.length];

      for (const h of (loc.rollHeights || [])) {
        faceMapRaw[h] = faceMapRaw[h] === null
          ? { key: loc.key, name: loc.name, color }
          : { key: "shared", name: "↔ overlap", color: "ash" };
      }

      // Status — use RAW-adjacent terms
      let statusLabel = "—", statusClass = "status-healthy";
      if (killing >= max && max > 0)                           { statusLabel = "Destroyed"; statusClass = "status-destroyed"; }
      else if (killing > 0 && killing >= Math.floor(max / 2))  { statusLabel = "Critical";  statusClass = "status-killing"; }
      else if (killing > 0)                                    { statusLabel = "Wounded";   statusClass = "status-killing"; }
      else if (shock >= max && max > 0)                        { statusLabel = "Full";      statusClass = "status-shock"; }
      else if (shock > 0)                                      { statusLabel = "Shocked";   statusClass = "status-shock"; }

      // Wound boxes — killing fills from LEFT, shock from right of killing
      const boxes = Array.from({ length: max }, (_, i) => ({
        index: i,
        state: i < killing ? "killing" : (i < killing + shock ? "shock" : "")
      }));

      const heights = (loc.rollHeights || []).slice().sort((a,b) => a-b);
      const heightsSet = new Set(heights);

      // Face picker: 10 buttons for the height config UI
      const facePicker = Array.from({ length: 10 }, (_, i) => ({
        face: i + 1,
        active: heightsSet.has(i + 1)
      }));

      return {
        ...loc, index: idx, color,
        heightPips: heights,
        heightLabel: heights.length > 0 ? heights.join(", ") : "redirect only",
        isRedirectOnly: heights.length === 0,
        boxes, statusLabel, statusClass,
        facePicker,
        isDestroyed: killing >= max && max > 0
      };
    });

    context.faceMap = Array.from({ length: 10 }, (_, i) => {
      const face = i + 1;
      const hit  = faceMapRaw[face];
      return { face, locName: hit?.name || "—", color: hit?.color || "empty", hasLoc: !!hit };
    });

    // ── Special mechanics
    const flags = this.document.system.creatureFlags || {};
    context.hasFreeGobble      = (flags.freeGobbleDicePerRound || 0) > 0;
    context.hasVenom           = (flags.venomPotency || 0) > 0;
    context.moraleAttackUsed   = !!this.document.getFlag("wild-talents-2e", "elephantTrumpetUsed");
    context.constrictActive    = !!flags.constrictActive;
    context.hasConstrict       = !!flags.hasConstrict;
    context.constrictTargetName = flags.constrictTargetId
      ? (game.actors.get(flags.constrictTargetId)?.name || "Unknown") : null;
    // FIX BUG-004: charge only for creatures with explicit flag, not all 'run' creatures
    context.hasCharge          = !!flags.hasChargeAccumulation;
    context.chargeWidth        = flags.chargeRunWidest || 0;
    context.isHumanoidCreature = locs.length === 6 && locs.every(l => HIT_LOCATIONS_SET.has(l.key));

    // ── Skill display — FIX UX-007/008/011: sort, correct attr pairing, camelCase labels
    const COMBAT_SKILL_ORDER = ["fight","bite","claw","kick","ram","constrict","trample","grapple","dodge","parry","athletics","climb","swim","run","stealth"];
    const rawSkills = this.document.system.creatureSkills || {};

    const buildSkillEntry = (key, rawVal) => {
      const sk    = normalizeCreatureSkill(rawVal);
      const numVal = sk.value;
      const hdCount = sk.hard;
      const wdCount = sk.wiggle;
      const attrKey = SENSE_SKILLS.has(key) ? "sense"
                    : COORD_SKILLS.has(key) ? "coordination" : "body";
      const attrData = attrs[attrKey] || {};
      const attrN = parseInt(attrData.normal) || parseInt(attrData) || 0;
      const attrHD = parseInt(attrData.hard) || 0;
      const attrWD = parseInt(attrData.wiggle) || 0;
      // FIX UX-011: convert camelCase keys to spaced labels
      const label = key.replace(/([A-Z])/g, " $1").trim();

      // Build display value: show dice composition (e.g. "2d+1hd", "3d+1wd")
      const parts = [];
      if (numVal > 0) parts.push(`${numVal}d`);
      if (hdCount > 0) parts.push(`${hdCount}hd`);
      if (wdCount > 0) parts.push(`${wdCount}wd`);
      const displayVal = parts.length > 0 ? parts.join("+") : "0";

      return {
        key, label: label.charAt(0).toUpperCase() + label.slice(1),
        value: displayVal,
        numVal, hdCount, wdCount,
        badge: wdCount > 0 ? "wt-badge-wd" : hdCount > 0 ? "wt-badge-hd" : "",
        isSense: SENSE_SKILLS.has(key),
        attrKey, attrLabel: attrKey.charAt(0).toUpperCase() + attrKey.slice(1),
        attrVal: attrN + attrHD + attrWD,
        totalPool: attrN + attrHD + attrWD + numVal + hdCount + wdCount,
        sortOrder: COMBAT_SKILL_ORDER.indexOf(key) >= 0
          ? COMBAT_SKILL_ORDER.indexOf(key) : 999
      };
    };

    context.creatureSkillDisplay = Object.entries(rawSkills)
      .map(([key, val]) => buildSkillEntry(key, val))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));

    // Pre-split into combat and perception arrays — robust against any HBS template
    // scoping issues with boolean iteration filters.
    context.combatSkills     = context.creatureSkillDisplay.filter(s => !s.isSense);
    context.perceptionSkills = context.creatureSkillDisplay.filter(s =>  s.isSense);

    return context;
  }
}