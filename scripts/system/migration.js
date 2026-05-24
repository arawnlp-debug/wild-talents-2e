// scripts/system/migration.js — Wild Talents 2e Migration Engine
//
// Framework preserved from Reign. All Reign-specific migration functions removed.
// Version-gated migration pattern: each function checks the world's last version
// and applies only the transformations needed.
//
// INVARIANT: No silent data loss. All field removals use explicit `.-=field` syntax.

const SYSTEM_ID = "wild-talents-2e";

/**
 * Main entry point — triggered when system version exceeds world's last migration version.
 */
export async function migrateWorld() {
  ui.notifications.info("Wild Talents 2e migration started. Please do not close your game...", { permanent: true });
  console.log("WT | Beginning world migration...");

  const report = { successes: [], failures: [], warnings: [] };

  // 1. World Actors
  for (const actor of game.actors) {
    try {
      const updateData = migrateActorData(actor);
      if (!foundry.utils.isEmpty(updateData)) {
        console.log(`WT | Migrating Actor ${actor.name}`);
        await actor.update(updateData);
        report.successes.push({ name: actor.name, type: actor.type });
      }
    } catch (err) {
      console.error(`WT | Failed to migrate Actor ${actor.name}:`, err);
      report.failures.push({ name: actor.name, type: actor.type, error: err.message || String(err) });
    }
  }

  // 2. World Items
  for (const item of game.items) {
    try {
      const updateData = migrateItemData(item);
      if (!foundry.utils.isEmpty(updateData)) {
        console.log(`WT | Migrating Item ${item.name}`);
        await item.update(updateData);
        report.successes.push({ name: item.name, type: item.type });
      }
    } catch (err) {
      console.error(`WT | Failed to migrate Item ${item.name}:`, err);
      report.failures.push({ name: item.name, type: item.type, error: err.message || String(err) });
    }
  }

  // 3. Unlinked Token Actors
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      if (token.actor && !token.actorLink) {
        try {
          const updateData = migrateActorData(token.actor);
          if (!foundry.utils.isEmpty(updateData)) {
            console.log(`WT | Migrating Token Actor ${token.name} on ${scene.name}`);
            await token.actor.update(updateData);
            report.successes.push({ name: `${token.name} [token]`, type: token.actor.type });
          }
        } catch (err) {
          console.error(`WT | Failed to migrate Token Actor ${token.name}:`, err);
          report.failures.push({ name: `${token.name} [token]`, type: token.actor?.type || "unknown", error: err.message || String(err) });
        }
      }
    }
  }

  // 4. System Compendium Packs
  for (const pack of game.packs) {
    if (pack.metadata.packageType !== "system" || pack.metadata.id.indexOf(`${SYSTEM_ID}.`) !== 0) continue;
    if (!["Actor", "Item"].includes(pack.documentName)) continue;
    const wasLocked = pack.locked;
    await pack.configure({ locked: false });
    const documents = await pack.getDocuments();
    for (const doc of documents) {
      try {
        const updateData = doc.documentName === "Actor" ? migrateActorData(doc) : migrateItemData(doc);
        if (!foundry.utils.isEmpty(updateData)) {
          console.log(`WT | Migrating Compendium ${doc.name}`);
          await doc.update(updateData);
          report.successes.push({ name: doc.name, type: doc.type });
        }
      } catch (err) {
        console.error(`WT | Failed to migrate Compendium ${doc.name}:`, err);
        report.failures.push({ name: doc.name, type: doc.type, error: err.message || String(err) });
      }
    }
    await pack.configure({ locked: wasLocked });
  }

  // Summary
  const migrationCount = report.successes.length;
  const failureCount = report.failures.length;
  if (failureCount > 0) {
    ui.notifications.error(`WT migration: ${failureCount} failure(s). Check console.`, { permanent: true });
  } else if (migrationCount > 0) {
    ui.notifications.info(`WT migration complete: ${migrationCount} documents updated.`);
  } else {
    ui.notifications.info("WT migration complete. No documents required changes.");
  }
  console.log("WT | World migration complete.");
  return { migrationCount, failureCount };
}

function migrateActorData(actor) {
  const updateData = {};

  // ── Increment 6: Add archetypeData field to existing characters ──
  // Migrates existing archetype/source/permission string fields into
  // the new structured archetypeData schema.  No data loss — old strings
  // are preserved and the new field is populated alongside them.
  if (actor.type === "character") {
    const sys = actor.system || {};
    const hasArchetypeData = sys.archetypeData && Array.isArray(sys.archetypeData.metaQualities);

    if (!hasArchetypeData) {
      const metaQualities = [];

      // Migrate existing source string → Source MQ entry
      if (sys.source && typeof sys.source === "string" && sys.source.trim()) {
        metaQualities.push({
          id: "custom",
          name: sys.source.trim(),
          type: "source",
          cost: 0,
          notes: "Migrated from legacy source field",
          parameters: {}
        });
      }

      // Migrate existing permission string → Permission MQ entry
      if (sys.permission && typeof sys.permission === "string" && sys.permission.trim()) {
        metaQualities.push({
          id: "custom",
          name: sys.permission.trim(),
          type: "permission",
          cost: 0,
          notes: "Migrated from legacy permission field",
          parameters: {}
        });
      }

      updateData["system.archetypeData"] = {
        name: sys.archetype || "",
        metaQualities
      };
    }
  }

  // ── Increment 7: Migrate creature skills from Reign ED/MD to WT HD/WD ──
  // Converts { value, expert, master } → { value, hard, wiggle } on threat actors.
  // Also handles legacy shorthand values ("ED", "MD", flat numbers).
  // 📖 WT Rulebook Ch1 p.9-10: Only Normal, Hard, and Wiggle Dice exist.
  if (actor.type === "threat") {
    const rawSkills = actor.system?.creatureSkills;
    if (rawSkills && typeof rawSkills === "object") {
      const updatedSkills = {};
      let needsMigration = false;

      for (const [key, val] of Object.entries(rawSkills)) {
        if (val && typeof val === "object" && ("expert" in val || "master" in val)) {
          updatedSkills[key] = {
            value: parseInt(val.value) || 0,
            hard: val.expert ? 1 : 0,
            wiggle: val.master ? 1 : 0
          };
          needsMigration = true;
        } else if (val === "ED") {
          updatedSkills[key] = { value: 0, hard: 1, wiggle: 0 };
          needsMigration = true;
        } else if (val === "MD") {
          updatedSkills[key] = { value: 0, hard: 0, wiggle: 1 };
          needsMigration = true;
        } else if (typeof val === "number" || typeof val === "string") {
          updatedSkills[key] = { value: parseInt(val) || 0, hard: 0, wiggle: 0 };
          needsMigration = true;
        } else {
          updatedSkills[key] = val;
        }
      }

      if (needsMigration) {
        updateData["system.creatureSkills"] = updatedSkills;
      }
    }
  }

  return updateData;
}

function migrateItemData(item) {
  const updateData = {};
  // Future version-gated migrations go here.
  return updateData;
}
