// scripts/helpers/base-roller.js
//
// Wild Talents 2e: Shared roller lifecycle utilities.
//
// Three patterns extracted from the roller classes:
//   1. Dice rolling (Roll Nd10 → evaluate → extract results)
//   2. Wiggle Die assignment dialog (show results, prompt face values)
//   3. Roll-then-append-HD-then-prompt-WD-then-finalize orchestration
//
// WT Key Changes from Reign:
//   - Hard Dice are appended to results at their locked face BEFORE rolling
//   - Wiggle Dice are prompted AFTER rolling (like Master Dice, but potentially multiple)
//   - No Expert Die concept (HD replaces it)

import { wtDialog } from "./dialog-util.js";

export class BaseORERoller {

  /* ───────────────────────────────────────────────────────────────────────
   * rollDice(count)
   *
   * Rolls `count` d10s via Foundry's Roll API and returns both the Roll
   * instance (for Dice So Nice / audit trail) and the flat results array.
   * ─────────────────────────────────────────────────────────────────────── */
  static async rollDice(count) {
    if (count < 1) return { roll: null, results: [] };
    const roll = new Roll(`${count}d10`);
    await roll.evaluate();
    const results = roll.dice[0]?.results.map(r => r.result) || [];
    return { roll, results };
  }

  /* ───────────────────────────────────────────────────────────────────────
   * promptWiggleDice(existingResults, wiggleCount, title?)
   *
   * Opens a dialog showing the dice rolled so far (including Hard Dice)
   * and prompts the player to assign face values (1-10) for each Wiggle Die.
   *
   * Returns an array of chosen face values, or null if the player cancels.
   *
   * 📖 WT Rulebook Ch2 — verify WD assignment rules
   * ─────────────────────────────────────────────────────────────────────── */
  static async promptWiggleDice(existingResults, wiggleCount, hardDice = [], title = "Assign Wiggle Dice") {
    const sorted = [...existingResults].sort((a, b) => b - a);

    // Show existing results with HD highlighted
    let resultDisplay = "";
    if (sorted.length > 0) {
      resultDisplay = sorted.map(r => {
        const isHD = hardDice.some(hd => hd.face === r);
        return isHD
          ? `<span class="wt-die-hard-inline">${r}</span>`
          : `${r}`;
      }).join(", ");
    } else {
      resultDisplay = "None";
    }

    let wdHtml = `<form class="wt-dialog-form">
      <p class="wt-text-large wt-mb-small wt-mt-0">
        <strong>Your Roll:</strong> ${resultDisplay}
      </p>
      <p class="wt-text-small wt-text-muted wt-mb-medium">
        Assign a face value (1–10) to each Wiggle Die. 
        Choose values that create or strengthen sets.
      </p>
      <div class="dialog-grid dialog-grid-2">`;

    for (let i = 0; i < wiggleCount; i++) {
      wdHtml += `
        <div class="form-group">
          <label>
            <span class="wt-dice-badge wt-dice-wiggle">WD</span> Wiggle Die ${i + 1}:
          </label>
          <input type="number" id="wdFace${i}" value="10" min="1" max="10"/>
        </div>`;
    }
    wdHtml += `</div></form>`;

    return wtDialog(
      title,
      wdHtml,
      (e, b, d) => {
        const faces = [];
        for (let i = 0; i < wiggleCount; i++) {
          const val = parseInt(d.element.querySelector(`#wdFace${i}`)?.value) || 10;
          faces.push(Math.max(1, Math.min(10, val)));
        }
        return faces;
      },
      { defaultLabel: "Finalize Sets" }
    );
  }

  /* ───────────────────────────────────────────────────────────────────────
   * finalizeWithSpecialDice(poolMath, finalizer, wdTitle?)
   *
   * Orchestrates the complete post-dialog roll sequence for WT:
   *   1. Roll normalDiceCount d10s (only normal dice are random)
   *   2. Append Hard Dice at their locked face values
   *   3. If Wiggle Dice are present, prompt for face assignment
   *   4. Call the finalizer callback with the complete results
   *
   * The finalizer signature:
   *   async (results, poolMath, rollInstance) => void
   *
   * @param {object} poolMath - Output of calculateWTPool.
   *   Required: normalDiceCount, hardDice[], wiggleDiceCount
   * @param {Function} finalizer - Async callback with final results.
   * @param {string} [wdTitle] - Dialog title for WD prompt.
   * ─────────────────────────────────────────────────────────────────────── */
  static async finalizeWithSpecialDice(poolMath, finalizer, wdTitle = "Assign Wiggle Dice") {
    // 1. Roll the normal dice
    const { roll, results } = await this.rollDice(poolMath.normalDiceCount);

    // 2. Append Hard Dice at their locked faces
    for (const hd of (poolMath.hardDice || [])) {
      results.push(hd.face);
    }

    // 3. Append called shot die if applicable (non-free called shot)
    if (poolMath.finalCalledShot > 0 && !poolMath.calledShotFree) {
      results.push(poolMath.finalCalledShot);
    }

    // 4. If Wiggle Dice present, prompt for assignment
    if (poolMath.wiggleDiceCount > 0) {
      const wdFaces = await this.promptWiggleDice(
        results,
        poolMath.wiggleDiceCount,
        poolMath.hardDice || [],
        wdTitle
      );
      if (!wdFaces) return; // Player cancelled
      results.push(...wdFaces);
      await finalizer(results, poolMath, roll);
    } else {
      await finalizer(results, poolMath, roll);
    }
  }

  /* ───────────────────────────────────────────────────────────────────────
   * Legacy compatibility: finalizeWithMasterDice
   * Wraps finalizeWithSpecialDice for code that hasn't been migrated yet.
   * TODO: Remove once all rollers are updated to use finalizeWithSpecialDice.
   * ─────────────────────────────────────────────────────────────────────── */
  static async finalizeWithMasterDice(poolMath, finalizer, mdTitle = "Assign Master Dice") {
    // Convert legacy poolMath shape to WT shape
    const wtPoolMath = {
      normalDiceCount: poolMath.normalDiceCount,
      hardDice: [],
      wiggleDiceCount: poolMath.actualMd || 0,
      finalCalledShot: poolMath.finalCalledShot || 0,
      calledShotFree: false
    };

    // Append ED as a hard die if present
    if (poolMath.actualEd > 0) {
      wtPoolMath.hardDice.push({ face: poolMath.finalEdFace });
    }
    if (poolMath.actualCs > 0) {
      wtPoolMath.hardDice.push({ face: poolMath.finalCalledShot });
      wtPoolMath.finalCalledShot = 0; // Already handled
    }

    await this.finalizeWithSpecialDice(wtPoolMath, async (results, pm, roll) => {
      await finalizer(results, poolMath.actualMd, poolMath.actualEd, poolMath.finalEdFace, roll);
    }, mdTitle);
  }

  /* ───────────────────────────────────────────────────────────────────────
   * Legacy compatibility: promptMasterDice
   * Wraps promptWiggleDice for code that hasn't been migrated yet.
   * ─────────────────────────────────────────────────────────────────────── */
  static async promptMasterDice(existingResults, mdCount, title = "Assign Master Dice") {
    return this.promptWiggleDice(existingResults, mdCount, [], title);
  }
}
