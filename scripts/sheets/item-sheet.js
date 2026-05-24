// scripts/sheets/item-sheet.js
const { HandlebarsApplicationMixin } = foundry.applications.api;
import { wtDialog } from "../helpers/dialog-util.js";
import { SUGGESTED_SKILLS, getEffectDictionary, getItemEffectExtras } from "../helpers/config.js";
import { ScrollPreserveMixin } from "../helpers/scroll-mixin.js";

// WT: Human-readable labels for suggested skill keys.
// Generated from SUGGESTED_SKILLS keys with camelCase → Title Case conversion.
// Used in the weapon skill binding selector.
const SKILL_LABELS = Object.freeze(
  Object.fromEntries(
    Object.keys(SUGGESTED_SKILLS).map(key => [
      key,
      key.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()).trim()
    ])
  )
);

export class WTItemSheet extends ScrollPreserveMixin(HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2)) {
  
  static get DEFAULT_OPTIONS() {
    return { 
      tag: "form", 
      classes: ["wt", "sheet", "item"], 
      position: { width: 450, height: "auto" },
      window: {
        resizable: true,
        minimizable: true
      },
      form: { submitOnChange: true, closeOnSubmit: false },
      actions: {
        changeTab: this.prototype._onChangeTab,
        editImage: this.prototype._onEditImage,
        createEffect: this.prototype._onCreateEffect,
        editEffect: this.prototype._onEditEffect,
        deleteEffect: this.prototype._onDeleteEffect,
        toggleEffect: this.prototype._onToggleEffect,
        advancedEditEffect: this.prototype._onAdvancedEditEffect,
        // Power Quality/Extra/Flaw CRUD
        addQuality: this.prototype._onAddQuality,
        removeQuality: this.prototype._onRemoveQuality,
        addExtra: this.prototype._onAddExtra,
        removeExtra: this.prototype._onRemoveExtra,
        addFlaw: this.prototype._onAddFlaw,
        removeFlaw: this.prototype._onRemoveFlaw
      }
    };
  }

  static get PARTS() {
    return { sheet: { template: "systems/wild-talents-2e/templates/item/item-sheet.hbs" } };
  }

  // ==========================================
  // ACTION HANDLERS (V14 Standard)
  // ==========================================

  async _onChangeTab(event, target) {
    event.preventDefault();
    this._activeTab = target.dataset.tab;
    this.render();
  }
  
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

  // ==========================================
  // POWER QUALITY / EXTRA / FLAW HANDLERS
  // ==========================================

  async _onAddQuality(event, target) {
    event.preventDefault();
    const qualities = foundry.utils.deepClone(this.document.system.qualities || []);
    qualities.push({
      id: foundry.utils.randomID(),
      type: "attacks",
      level: 0,
      capacity: "range",
      extras: [],
      flaws: []
    });
    await this.document.update({ "system.qualities": qualities });
  }

  async _onRemoveQuality(event, target) {
    event.preventDefault();
    const index = parseInt(target.dataset.qualityIndex);
    if (isNaN(index)) return;
    const qualities = foundry.utils.deepClone(this.document.system.qualities || []);
    qualities.splice(index, 1);
    await this.document.update({ "system.qualities": qualities });
  }

  async _onAddExtra(event, target) {
    event.preventDefault();
    const qIdx = parseInt(target.dataset.qualityIndex);
    if (isNaN(qIdx)) return;
    const qualities = foundry.utils.deepClone(this.document.system.qualities || []);
    if (!qualities[qIdx]) return;
    qualities[qIdx].extras.push({
      id: foundry.utils.randomID(),
      name: "New Extra",
      costPerDie: 1,
      quantity: 1,
      notes: ""
    });
    await this.document.update({ "system.qualities": qualities });
  }

  async _onRemoveExtra(event, target) {
    event.preventDefault();
    const qIdx = parseInt(target.dataset.qualityIndex);
    const eIdx = parseInt(target.dataset.extraIndex);
    if (isNaN(qIdx) || isNaN(eIdx)) return;
    const qualities = foundry.utils.deepClone(this.document.system.qualities || []);
    if (!qualities[qIdx]?.extras) return;
    qualities[qIdx].extras.splice(eIdx, 1);
    await this.document.update({ "system.qualities": qualities });
  }

  async _onAddFlaw(event, target) {
    event.preventDefault();
    const qIdx = parseInt(target.dataset.qualityIndex);
    if (isNaN(qIdx)) return;
    const qualities = foundry.utils.deepClone(this.document.system.qualities || []);
    if (!qualities[qIdx]) return;
    qualities[qIdx].flaws.push({
      id: foundry.utils.randomID(),
      name: "New Flaw",
      discountPerDie: 1,
      notes: ""
    });
    await this.document.update({ "system.qualities": qualities });
  }

  async _onRemoveFlaw(event, target) {
    event.preventDefault();
    const qIdx = parseInt(target.dataset.qualityIndex);
    const fIdx = parseInt(target.dataset.flawIndex);
    if (isNaN(qIdx) || isNaN(fIdx)) return;
    const qualities = foundry.utils.deepClone(this.document.system.qualities || []);
    if (!qualities[qIdx]?.flaws) return;
    qualities[qIdx].flaws.splice(fIdx, 1);
    await this.document.update({ "system.qualities": qualities });
  }

  /**
   * The Master Dictionary that bridges the UI dropdowns to the `models.js` catch-basins.
   */
  _getEffectDictionary() {
    return [...getEffectDictionary(), ...getItemEffectExtras()];
  }

  async _handleEffectBuilder(effectId = null) {
      const effect = effectId ? this.document.effects.get(effectId) : null;
      
      if (effect && effect.changes.length > 1) {
          ui.notifications.warn(game.i18n.localize("WT.EffectMultiWarning"));
          return effect.sheet.render(true);
      }

      const change = effect && effect.changes.length > 0 ? effect.changes[0] : { key: "system.modifiers.globalPool", value: "1", mode: 2 };
      const effectName = effect ? effect.name : `${this.document.name} Modifier`;

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
                      <option value="custom" ${!dict.find(d => d.value === change.key) ? "selected" : ""}>— Custom Key —</option>
                      ${optionsHtml}
                  </select>
              </div>
              <div class="form-group wt-hidden" id="customKeyGroup">
                  <label>Custom Key Path:</label>
                  <input type="text" name="customKey" value="${!dict.find(d => d.value === change.key) ? change.key : ""}" placeholder="system.modifiers.globalPool"/>
              </div>
              <div class="form-group">
                  <label>Value:</label>
                  <input type="text" name="effValue" value="${change.value}" placeholder="1 or -1"/>
                  <p class="wt-text-small wt-text-muted" id="effValueHint">Type a number (e.g., 1 or -1).</p>
              </div>
              <p class="wt-text-small wt-text-center">
                  <a id="advancedEditBtn" class="wt-cursor-help"><i class="fas fa-wrench"></i> Open Advanced Editor</a>
              </p>
          </form>
      `;

      const result = await wtDialog(
          effectId ? "Edit Modifier" : "Create Modifier",
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
                          const startDisabled = this.document.system.equipped !== undefined ? !this.document.system.equipped : false;
                          this.document.createEmbeddedDocuments("ActiveEffect", [{
                              name: "New Advanced Effect",
                              img: this.document.img || "icons/svg/aura.svg",
                              transfer: true,
                              disabled: startDisabled
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
              const startDisabled = this.document.system.equipped !== undefined ? !this.document.system.equipped : false;
              await this.document.createEmbeddedDocuments("ActiveEffect", [{
                  name: result.name,
                  img: this.document.img || "icons/svg/aura.svg",
                  origin: this.document.uuid,
                  transfer: true,
                  disabled: startDisabled,
                  changes: changes
              }]);
          }
      }
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.item = this.document;
    context.system = this.document.system;
    
    context.effects = Array.from(this.document.effects);

    context.isWeapon = this.document.type === "weapon";
    context.isArmor = this.document.type === "armor";
    context.isShield = this.document.type === "shield";
    context.isPower = this.document.type === "power";
    context.isGear = this.document.type === "gear";
    context.isAdvantage = this.document.type === "advantage";
    context.isProblem = this.document.type === "problem";
    // G2: Poison item type
    context.isPoison = this.document.type === "poison";

    context.armorWeightOptions = { light: "WT.ArmorLight", medium: "WT.ArmorMedium", heavy: "WT.ArmorHeavy" };
    context.shieldSizeOptions = { small: "WT.ShieldSmall", large: "WT.ShieldLarge", tower: "WT.ShieldTower" };
    context.shieldMaterialOptions = { wood: "WT.MaterialWood", metal: "WT.MaterialMetal" };
    context.shieldArmOptions = { armL: "WT.ArmL", armR: "WT.ArmR" };
    context.attributeOptions = { body: "WT.AttrBody", coordination: "WT.AttrCoordination", sense: "WT.AttrSense", mind: "WT.AttrMind", command: "WT.AttrCommand", charm: "WT.AttrCharm" };

    // ISSUE-037: Expose derivedWeight
    if (context.isArmor) {
        context.derivedWeight = this.document.system.derivedWeight;
        context.armorWeightMismatch = context.derivedWeight !== this.document.system.armorWeight;
    }

    // ITEM-9: Weapon skill binding selector options.
    // First option (empty string) means "use Attack Pool text as before".
    // Remaining options are static skills + any custom skills from the owning actor.
    // When the item is viewed from the world items sidebar (no parent actor) only
    // static skills are offered — the GM can assign an actor-specific custom skill
    // after embedding the weapon.
    if (context.isWeapon) {
        const skillOptions = { "": "— (use Attack Pool text) —" };
        // WT: All skills are freeform in system.skills
        for (const key of Object.keys(SUGGESTED_SKILLS)) {
            skillOptions[key] = SKILL_LABELS[key] || key;
        }
        // Also add any actor-specific skills not in SUGGESTED_SKILLS
        const ownerActor = this.document.parent;
        if (ownerActor?.system?.skills) {
            for (const [key, skData] of Object.entries(ownerActor.system.skills)) {
                if (!skillOptions[key]) {
                    skillOptions[key] = skData?.label || key;
                }
            }
        }
        context.weaponSkillOptions = skillOptions;
    }

    // Spell: compute detection radius from intensity for display
    if (context.isSpell) {
        const DETECTION_RADIUS = ["—", "—", "5 ft", "10 ft", "50 ft", "1,000 ft", "1 mile", "10 miles", "25 miles", "50 miles", "100 miles"];
        const intensity = Math.min(10, Math.max(1, parseInt(this.document.system.intensity) || 1));
        context.detectionRadius = DETECTION_RADIUS[intensity];
    }

    this._activeTab = this._activeTab || "details";
    context.tabs = {
      details: this._activeTab === "details" ? "active" : "",
      effects: this._activeTab === "effects" ? "active" : ""
    };

    return context;
  }

  _processSubmitData(event, form, formData) {
    const submitData = super._processSubmitData(event, form, formData);
    if (this.document.type === "shield") {
        const newMaterial = foundry.utils.getProperty(submitData, "system.material");
        if (newMaterial && newMaterial !== this.document.system.material) {
            foundry.utils.setProperty(submitData, "system.coverAR", newMaterial === "metal" ? 3 : 1);
        }
    }
    // Coerce numeric spell fields to integers (empty string → 0)
    if (this.document.type === "spell") {
        const numericFields = ["system.intensity", "system.slow", "system.castingTime"];
        const flat = foundry.utils.flattenObject(submitData);
        let changed = false;
        for (const field of numericFields) {
            if (field in flat) {
                const parsed = parseInt(flat[field]);
                flat[field] = isNaN(parsed) ? 0 : Math.max(0, parsed);
                changed = true;
            }
        }
        return changed ? foundry.utils.expandObject(flat) : submitData;
    }

    // G2: Coerce numeric poison fields to integers
    if (this.document.type === "poison") {
        const numericFields = ["system.potency", "system.difficulty"];
        const flat = foundry.utils.flattenObject(submitData);
        let changed = false;
        for (const field of numericFields) {
            if (field in flat) {
                const parsed = parseInt(flat[field]);
                flat[field] = isNaN(parsed) ? 0 : Math.max(0, parsed);
                changed = true;
            }
        }
        return changed ? foundry.utils.expandObject(flat) : submitData;
    }

    // Enforce massive requires two-handed: clear massive if twoHanded is being unset
    if (this.document.type === "weapon") {
        const flat = foundry.utils.flattenObject(submitData);
        const twoHanded = flat["system.qualities.twoHanded"] ?? this.document.system.qualities?.twoHanded;
        if (!twoHanded && flat["system.qualities.massive"]) {
            flat["system.qualities.massive"] = false;
            return foundry.utils.expandObject(flat);
        }
    }

    return submitData;
  }
}