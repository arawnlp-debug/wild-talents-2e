// scripts/combat/hazards.js
//
// G1 + G2: Unified Hazard Roller — Falling, Fire, Poison
// Accessed from a single GM-only button in Token Controls.
// All three hazards route through existing damage infrastructure.

import { parseORE } from "../helpers/ore-engine.js";
import { applyDamageToTarget } from "./damage.js";
import { wtDialog } from "../helpers/dialog-util.js";
import { CharacterRoller } from "../helpers/character-roller.js";

// ==========================================
// PUBLIC API — called from wild-talents-2e.mjs hook
// ==========================================

/**
 * Opens the unified Hazard Roller dialog with three tabs: Falling, Fire, Poison.
 * GM-only. Targets come from game.user.targets at apply time.
 */
export async function openHazardRoller() {
  if (!game.user.isGM) return ui.notifications.warn("Only the GM can use the Hazard Roller.");

  // Gather world + compendium poison items for the dropdown
  const worldPoisons = game.items.filter(i => i.type === "poison");
  const poisonOptions = worldPoisons.map(p => ({
    uuid: p.uuid,
    name: p.name,
    potency: p.system.potency || 0,
    majorEffect: p.system.majorEffect || "",
    minorEffect: p.system.minorEffect || "",
    difficulty: p.system.difficulty || 0,
    retainedDelivery: p.system.retainedDelivery ?? true
  }));

  const content = await foundry.applications.handlebars.renderTemplate("systems/wild-talents-2e/templates/dialogs/hazard-roller.hbs", { poisonOptions });

  await wtDialog(
    "Hazard Roller",
    content,
    () => null, // No default confirm — each tab has its own Apply button
    {
      width: 460,
      defaultLabel: "Close",
      render: (event, html) => {
        const el = event?.target?.element ?? (event instanceof HTMLElement ? event : html);
        if (!el) return;

        // ── Tab switching ──
        el.querySelectorAll(".hazard-tab-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            el.querySelectorAll(".hazard-tab-btn").forEach(b => b.classList.remove("active"));
            el.querySelectorAll(".hazard-tab-panel").forEach(p => p.classList.remove("active"));
            btn.classList.add("active");
            const panel = el.querySelector(`.hazard-tab-panel[data-tab="${btn.dataset.tab}"]`);
            if (panel) panel.classList.add("active");
          });
        });

        // ── Falling: live pool preview ──
        const updateFallPreview = () => {
          const feet = parseInt(el.querySelector('[name="fall-height"]')?.value) || 0;
          const controlled = el.querySelector('[name="fall-controlled"]')?.checked || false;
          const brutal = parseInt(el.querySelector('[name="fall-brutal"]')?.value) || 0;
          const pool = computeFallingPool(feet, controlled, brutal);
          const preview = el.querySelector(".fall-pool-preview");
          if (preview) preview.textContent = `${pool}d10`;
        };
        el.querySelectorAll('[name="fall-height"], [name="fall-controlled"], [name="fall-brutal"]').forEach(inp => {
          inp.addEventListener("input", updateFallPreview);
          inp.addEventListener("change", updateFallPreview);
        });
        updateFallPreview();

        // ── Apply Buttons ──
        el.querySelector(".apply-falling-btn")?.addEventListener("click", async (ev) => {
          ev.preventDefault();
          const feet = parseInt(el.querySelector('[name="fall-height"]')?.value) || 0;
          const surface = el.querySelector('[name="fall-surface"]')?.value || "shock";
          const controlled = el.querySelector('[name="fall-controlled"]')?.checked || false;
          const brutal = parseInt(el.querySelector('[name="fall-brutal"]')?.value) || 0;
          await applyFalling(feet, surface, controlled, brutal);
        });

        el.querySelector(".apply-fire-btn")?.addEventListener("click", async (ev) => {
          ev.preventDefault();
          const intensity = el.querySelector('[name="fire-intensity"]')?.value || "shock";
          const area = parseInt(el.querySelector('[name="fire-area"]')?.value) || 1;
          await applyFire(intensity, area);
        });

        el.querySelector(".apply-poison-btn")?.addEventListener("click", async (ev) => {
          ev.preventDefault();
          const mode = el.querySelector('[name="poison-mode"]')?.value || "manual";
          let poisonData;

          if (mode === "item") {
            const uuid = el.querySelector('[name="poison-select"]')?.value || "";
            const match = poisonOptions.find(p => p.uuid === uuid);
            if (!match) return ui.notifications.warn("Select a poison item first.");
            poisonData = { ...match };
          } else {
            poisonData = {
              name: el.querySelector('[name="poison-name"]')?.value || "Unknown Poison",
              potency: parseInt(el.querySelector('[name="poison-potency"]')?.value) || 1,
              majorEffect: el.querySelector('[name="poison-major"]')?.value || "",
              minorEffect: el.querySelector('[name="poison-minor"]')?.value || "",
              difficulty: parseInt(el.querySelector('[name="poison-difficulty"]')?.value) || 0,
              retainedDelivery: el.querySelector('[name="poison-retained"]')?.checked ?? true
            };
          }

          const retained = el.querySelector('[name="poison-retained-override"]')?.checked ?? poisonData.retainedDelivery;
          await applyPoison(poisonData, retained);
        });

        // ── Poison mode toggle ──
        const modeSelect = el.querySelector('[name="poison-mode"]');
        const updatePoisonMode = () => {
          const mode = modeSelect?.value || "manual";
          const itemPanel = el.querySelector(".poison-item-panel");
          const manualPanel = el.querySelector(".poison-manual-panel");
          if (itemPanel) itemPanel.style.display = mode === "item" ? "block" : "none";
          if (manualPanel) manualPanel.style.display = mode === "manual" ? "block" : "none";
        };
        modeSelect?.addEventListener("change", updatePoisonMode);
        updatePoisonMode();

        // ── Area: live pool preview ──
        const updateAreaPreview = () => {
          const dice = parseInt(el.querySelector('[name="area-dice"]')?.value) || 1;
          const type = el.querySelector('[name="area-type"]')?.value || "shock";
          const typeLabel = type === "killing" ? "Killing" : "Shock";
          const preview = el.querySelector(".area-pool-preview");
          if (preview) preview.textContent = `${dice}d10 ${typeLabel}`;
        };
        el.querySelectorAll('[name="area-dice"], [name="area-type"]').forEach(inp => {
          inp.addEventListener("input", updateAreaPreview);
          inp.addEventListener("change", updateAreaPreview);
        });
        updateAreaPreview();

        el.querySelector(".apply-area-btn")?.addEventListener("click", async (ev) => {
          ev.preventDefault();
          const dice = parseInt(el.querySelector('[name="area-dice"]')?.value) || 1;
          const type = el.querySelector('[name="area-type"]')?.value || "shock";
          const source = el.querySelector('[name="area-source"]')?.value || "Area Attack";
          await applyAreaDamage(source, dice, type);
        });
      }
    }
  );
}


// ==========================================
// FALLING
// ==========================================

/**
 * RAW Ch13: 1d per 5 feet, cap 30d (terminal velocity at 150ft).
 * Controlled drop subtracts 2d. Brutal surface adds GM bonus dice (RAW: max ~10).
 */
function computeFallingPool(feet, controlled, brutalBonus) {
  const base = Math.min(30, Math.floor(feet / 5));
  return Math.max(0, base + (brutalBonus || 0) - (controlled ? 2 : 0));
}

async function applyFalling(feet, surface, controlled, brutalBonus) {
  const targets = Array.from(game.user.targets);
  if (targets.length === 0) return ui.notifications.warn("Target one or more tokens first.");

  const pool = computeFallingPool(feet, controlled, brutalBonus);
  if (pool <= 0) return ui.notifications.info("Falling pool is 0 or less — no damage.");

  const dmgType = surface === "killing" ? "1 Killing" : "1 Shock";
  const surfaceLabel = surface === "killing" ? "Hard Surface (Killing)" : "Yielding Surface (Shock)";

  // Post a narration card before applying damage
  const targetNames = targets.map(t => foundry.utils.escapeHTML(t.name)).join(", ");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: "Hazard: Falling" }),
    content: `<div class="wt-chat-card wt-card-danger">
      <h3><i class="fas fa-arrow-down"></i> Falling — ${feet} feet</h3>
      <p><strong>Surface:</strong> ${surfaceLabel}</p>
      <p><strong>Pool:</strong> ${pool}d10${controlled ? " (controlled –2d)" : ""}${brutalBonus > 0 ? ` (+${brutalBonus}d brutal)` : ""}</p>
      <p><strong>Targets:</strong> ${targetNames}</p>
      <p class="wt-text-small wt-text-muted"><i class="fas fa-info-circle"></i> Area damage — mundane armour does not apply.</p>
    </div>`
  });

  // Route through area damage applicator.
  // areaDice = pool, dmgString = "1 Shock" or "1 Killing" per die.
  // The area pipeline rolls the pool and maps each result to a hit location.
  await applyDamageToTarget(1, 1, dmgType, 0, false, pool);
}


// ==========================================
// FIRE
// ==========================================

async function applyFire(intensity, areaRating) {
  const targets = Array.from(game.user.targets);
  if (targets.length === 0) return ui.notifications.warn("Target one or more tokens first.");

  const dmgType = intensity === "killing" ? "1 Killing" : "1 Shock";
  const intensityLabel = intensity === "killing" ? "Intense (Killing)" : "Small (Shock)";

  const targetNames = targets.map(t => foundry.utils.escapeHTML(t.name)).join(", ");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: "Hazard: Fire" }),
    content: `<div class="wt-chat-card wt-card-danger">
      <h3><i class="fas fa-fire"></i> Fire — Area ${areaRating} ${intensityLabel}</h3>
      <p><strong>Targets:</strong> ${targetNames}</p>
      <p class="wt-text-small wt-text-muted"><i class="fas fa-info-circle"></i> Area damage — mundane armour does not apply. Repeats every round while in the fire.</p>
    </div>`
  });

  await applyDamageToTarget(1, 1, dmgType, 0, false, areaRating);
}


// ==========================================
// AREA DAMAGE (generic)
// ==========================================

/**
 * Generic Area Damage roller for spells, creature abilities, traps, etc.
 * RAW Ch1 p.10: Roll N dice, each die hits the location matching its face.
 * If a location comes up twice, apply two points. Armour does not apply.
 *
 * Routes through applyDamageToTarget with areaDice parameter, which
 * handles both character and creature-mode targets.
 */
async function applyAreaDamage(sourceName, areaDice, damageType) {
  const targets = Array.from(game.user.targets);
  if (targets.length === 0) return ui.notifications.warn("Target one or more tokens first.");

  const isKilling = damageType === "killing";
  const dmgType = isKilling ? "1 Killing" : "1 Shock";
  const typeLabel = isKilling ? "Killing" : "Shock";
  const safeName = foundry.utils.escapeHTML(sourceName || "Area Attack");

  const targetNames = targets.map(t => foundry.utils.escapeHTML(t.name)).join(", ");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: safeName }),
    content: `<div class="wt-chat-card wt-card-danger">
      <h3><i class="fas fa-crosshairs"></i> ${safeName} — Area ${areaDice} ${typeLabel}</h3>
      <p><strong>Targets:</strong> ${targetNames}</p>
      <p class="wt-text-small wt-text-muted"><i class="fas fa-info-circle"></i> Area damage — armour does not apply (RAW Ch1).</p>
    </div>`
  });

  await applyDamageToTarget(1, 1, dmgType, 0, false, areaDice);
}


// ==========================================
// POISON
// ==========================================

/**
 * Rolls a Potency pool, evaluates for sets, and posts a poison result chat card
 * with Major/Minor effects and resist buttons.
 *
 * Pattern derived from applyCreatureVenom() in damage.js.
 */
async function applyPoison(poisonData, retainedDelivery) {
  const targets = Array.from(game.user.targets);

  // Effective potency — non-retained weapons (swords, crossbow bolts) lose 4
  const effectivePotency = Math.max(0, (poisonData.potency || 0) - (retainedDelivery ? 0 : 4));
  if (effectivePotency <= 0) return ui.notifications.info("Effective Potency is 0 — poison has no effect.");

  const safeName = foundry.utils.escapeHTML(poisonData.name || "Poison");
  const safeMajor = foundry.utils.escapeHTML(poisonData.majorEffect || "None specified");
  const safeMinor = foundry.utils.escapeHTML(poisonData.minorEffect || "None specified");
  const difficulty = poisonData.difficulty || 0;

  // Roll the Potency pool
  const roll = new Roll(`${effectivePotency}d10`);
  await roll.evaluate();
  const results = roll.dice[0].results.map(r => r.result);
  const parsed = parseORE(results);
  const hasSet = parsed.sets.length > 0;

  const diceDisplay = results.map(r => `<span class="wt-die wt-die-plain">${r}</span>`).join(" ");

  const resultText = hasSet
    ? `<span class="wt-text-danger wt-text-bold">SET ${parsed.sets[0].width}×${parsed.sets[0].height} — POISON TAKES HOLD</span>`
    : `<span class="wt-text-muted">No set — only Minor Effect applies</span>`;

  // Build target list for resist buttons
  const targetIds = targets.map(t => t.actor?.id).filter(Boolean);
  const targetNames = targets.length > 0
    ? targets.map(t => foundry.utils.escapeHTML(t.name)).join(", ")
    : "<em>No tokens targeted</em>";

  const difficultyNote = difficulty > 0
    ? `<br><span class="wt-text-danger">Resist Difficulty: ${difficulty}</span>`
    : "";

  // Resist buttons — always shown (Minor always applies; resist removes effects)
  const resistButtons = `
    <hr>
    <p class="wt-text-small wt-text-muted">
      ${hasSet ? "<strong>Major Effect</strong> applies unless resisted." : "No Major Effect (no set)."}
      <strong>Minor Effect</strong> always applies unless resisted.${difficultyNote}<br>
      Each successful resist removes one effect.
    </p>
    <div class="wt-action-buttons">
      <button class="wt-btn-primary poison-resist-btn"
        data-target-ids="${targetIds.join(",")}"
        data-resist-type="vigor"
        data-difficulty="${difficulty}">
        <i class="fas fa-fist-raised"></i> Roll Body + Vigor (Target Resists)
      </button>
      <button class="wt-btn-primary poison-resist-btn"
        data-target-ids="${targetIds.join(",")}"
        data-resist-type="healing"
        data-difficulty="${difficulty}">
        <i class="fas fa-briefcase-medical"></i> Roll Knowledge + Healing (Healer Aids)
      </button>
    </div>`;

  const retainedNote = !retainedDelivery
    ? `<p class="wt-text-small wt-text-muted"><i class="fas fa-syringe"></i> Non-retained delivery: Potency reduced by 4 (${poisonData.potency} → ${effectivePotency})</p>`
    : "";

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: "Hazard: Poison" }),
    content: `<div class="wt-chat-card wt-card-danger">
      <h3><i class="fas fa-skull-crossbones"></i> ${safeName} (Potency ${effectivePotency})</h3>
      <p><strong>Targets:</strong> ${targetNames}</p>
      ${retainedNote}
      <div class="dice-tray wrap">${diceDisplay}</div>
      <p>${resultText}</p>
      <div class="wt-poison-effects">
        ${hasSet ? `<p><strong class="wt-text-danger">Major Effect:</strong> ${safeMajor}</p>` : ""}
        <p><strong>Minor Effect:</strong> ${safeMinor}</p>
      </div>
      ${resistButtons}
    </div>`
  });
}


// ==========================================
// POISON RESIST — called from renderChatMessageHTML
// ==========================================

/**
 * Handles a poison resist button click. Opens the standard roller for the
 * target actor with the appropriate stat+skill pre-selected.
 *
 * @param {string} resistType - "vigor" or "healing"
 * @param {string} targetIds - Comma-separated actor IDs
 * @param {number} difficulty - Resist difficulty penalty
 */
export async function handlePoisonResist(resistType, targetIds, difficulty) {
  const ids = targetIds.split(",").filter(Boolean);
  const actor = ids.length > 0 ? game.actors.get(ids[0]) : game.user.character;
  if (!actor) return ui.notifications.warn("No target actor found for the resist roll.");

  const attr = resistType === "healing" ? "knowledge" : "body";
  const skill = resistType === "healing" ? "healing" : "vigor";
  const label = resistType === "healing" ? "Knowledge + Healing (Poison Resist)" : "Body + Vigor (Poison Resist)";

  await CharacterRoller.rollCharacter(actor, {
    type: "skill",
    key: skill,
    label,
    defaultAttr: attr,
    autoDifficulty: difficulty || 0
  });
}