// scripts/system/models.js — Wild Talents 2e Data Models
//
// Increment 1 (Foundation): Minimal stubs for system loading.
// Increment 2 will flesh out WTCharacterData with full WT stat/skill schema.
//
// REMOVED from Reign: ReignCompanyData, ReignSpellData, ReignMagicData, ReignAssetData

const { StringField, NumberField, BooleanField, SchemaField, ObjectField, ArrayField } = foundry.data.fields;

import { getEffectiveShieldLocations } from "../helpers/config.js";

// ==========================================
// REUSABLE SCHEMAS (ORE-universal)
// ==========================================

const makeHealthLoc = () => new SchemaField({
    shock:   new NumberField({ initial: 0, min: 0, integer: true }),
    killing: new NumberField({ initial: 0, min: 0, integer: true })
});

// WT stats use Normal/Hard/Wiggle dice counts instead of a single value.
// TODO: Increment 2 — verify stat ranges against WT Rulebook Ch4
const makeStatDice = () => new SchemaField({
    normal: new NumberField({ initial: 0, min: 0, integer: true }),
    hard:   new NumberField({ initial: 0, min: 0, integer: true }),
    wiggle: new NumberField({ initial: 0, min: 0, integer: true })
});


// ==========================================
// ACTOR DATA MODELS
// ==========================================

/**
 * Wild Talents 2e Character Data Model.
 *
 * Increment 1: Minimal stub — system loads and creates actors.
 * Increment 2: Full schema with WT stat/skill/willpower/health model.
 *
 * Key differences from Reign:
 *   - Stats: { normal, hard, wiggle } per stat instead of { value }
 *   - Skills: freeform ObjectField instead of fixed 27-skill schema
 *   - Willpower: Base Will + current WP resource
 *   - No esoterica/sorcery
 *   - No wealth
 *   - Archetype/Source/Permission metadata
 *
 * 📖 WT Rulebook: Ch2 (Stats), Ch3 (Willpower), Ch4 (Character Creation)
 */
export class WTCharacterData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            creationMode: new BooleanField({ initial: false }),

            biography: new SchemaField({
                // WT Rulebook Ch3 p.54: Two motivations — Passion and Loyalty.
                // Each has a description and a numerical rating.
                // "Divide your Base Will score between them."
                // Passion rating + Loyalty rating should equal Base Will.
                passion: new SchemaField({
                    description: new StringField({ initial: "" }),
                    rating: new NumberField({ initial: 0, min: 0, integer: true })
                }),
                loyalty: new SchemaField({
                    description: new StringField({ initial: "" }),
                    rating: new NumberField({ initial: 0, min: 0, integer: true })
                }),
                background: new StringField({ initial: "" }),
                notes:      new StringField({ initial: "" })
            }),

            // WT Rulebook Ch2 — six stats, each with Normal/Hard/Wiggle dice
            attributes: new SchemaField({
                body:         makeStatDice(),
                coordination: makeStatDice(),
                sense:        makeStatDice(),
                mind:         makeStatDice(),
                charm:        makeStatDice(),
                command:      makeStatDice()
            }),

            // Freeform skills keyed by sanitised slug.
            // Each entry: { label, value (normal dice), hard, wiggle, attribute }
            // 📖 WT Rulebook Ch4 — verify skill structure
            skills: new ObjectField({ initial: {} }),

            // 📖 WT Rulebook Ch3 — Willpower
            willpower: new SchemaField({
                base:    new NumberField({ initial: 0, min: 0, integer: true }), // computed in prepareDerivedData
                current: new NumberField({ initial: 0, min: 0, integer: true }),
                max:     new NumberField({ initial: 0, min: 0, integer: true })
            }),

            // ── Character Creation Metadata ──
            // 📖 WT Rulebook Ch4 — Archetype, Source, Permission
            // Display-only summary strings (derived from archetypeData in prepareDerivedData)
            archetype:  new StringField({ initial: "" }),
            source:     new StringField({ initial: "" }),
            permission: new StringField({ initial: "" }),

            // ── Structured Archetype Data (Increment 6) ──
            // 📖 WT Rulebook Ch5 p.96–103 — Meta-Qualities
            // Stores the full Archetype composition for cost calculation.
            // The Crucible (character builder) writes here; the summary strings
            // above are derived for sheet display.
            archetypeData: new SchemaField({
                name: new StringField({ initial: "" }),
                metaQualities: new ArrayField(new SchemaField({
                    id:    new StringField({ initial: "" }),
                    name:  new StringField({ initial: "" }),
                    type:  new StringField({ initial: "source", choices: ["source", "permission", "intrinsic"] }),
                    cost:  new NumberField({ initial: 0, integer: true }),
                    notes: new StringField({ initial: "" }),
                    // For variable-cost intrinsics (Allergy, Inhuman Stats, Vulnerable, Custom)
                    parameters: new ObjectField({ initial: {} })
                }))
            }),

            // ── Health (ORE-universal hit locations) ──
            health: new SchemaField({
                head:  makeHealthLoc(), torso: makeHealthLoc(),
                armL:  makeHealthLoc(), armR:  makeHealthLoc(),
                legL:  makeHealthLoc(), legR:  makeHealthLoc()
            }),

            // ── XP ──
            xp: new SchemaField({
                value: new NumberField({ initial: 0, min: 0, integer: true }),
                spent: new NumberField({ initial: 0, min: 0, integer: true })
            }),

            // ── Active Effect Catch-Basins ──
            modifiers: new SchemaField({
                globalPool:  new NumberField({ initial: 0, integer: true }),
                globalSpeed: new NumberField({ initial: 0, integer: true }),
                bonusDamage: new NumberField({ initial: 0, integer: true }),
                skills:      new ObjectField({ initial: {} }),
                attributes:  new ObjectField({ initial: {} }),
                actionEconomy: new SchemaField({
                    ignoreMultiPenaltySkills: new StringField({ initial: "" }),
                    freeGobbleDice: new NumberField({ initial: 0, integer: true })
                }),
                healthMax: new SchemaField({
                    head: new NumberField({ initial: 0, integer: true }),
                    torso: new NumberField({ initial: 0, integer: true }),
                    armL: new NumberField({ initial: 0, integer: true }),
                    armR: new NumberField({ initial: 0, integer: true }),
                    legL: new NumberField({ initial: 0, integer: true }),
                    legR: new NumberField({ initial: 0, integer: true })
                }),
                // WT uses HAR (Heavy Armor) and LAR (Light Armor) per location
                // 📖 WT Rulebook Ch6 — verify armor model
                naturalHAR: new SchemaField({
                    head: new NumberField({ initial: 0, integer: true }),
                    torso: new NumberField({ initial: 0, integer: true }),
                    armL: new NumberField({ initial: 0, integer: true }),
                    armR: new NumberField({ initial: 0, integer: true }),
                    legL: new NumberField({ initial: 0, integer: true }),
                    legR: new NumberField({ initial: 0, integer: true })
                }),
                naturalLAR: new SchemaField({
                    head: new NumberField({ initial: 0, integer: true }),
                    torso: new NumberField({ initial: 0, integer: true }),
                    armL: new NumberField({ initial: 0, integer: true }),
                    armR: new NumberField({ initial: 0, integer: true }),
                    legL: new NumberField({ initial: 0, integer: true }),
                    legR: new NumberField({ initial: 0, integer: true })
                }),
                combat: new SchemaField({
                    bonusDamageShock:   new NumberField({ initial: 0, integer: true }),
                    bonusDamageKilling: new NumberField({ initial: 0, integer: true }),
                    ignoreArmorTarget:  new NumberField({ initial: 0, integer: true }),
                    forceHitLocation:   new NumberField({ initial: 0, integer: true }),
                    shiftHitLocationUp: new NumberField({ initial: 0, integer: true }),
                    combineGobbleDice:  new BooleanField({ initial: false }),
                    crossBlockActive:   new BooleanField({ initial: false }),
                    appendManeuvers:    new ArrayField(new StringField())
                }),
                hitRedirects: new ObjectField({ initial: {} }),
                systemFlags: new SchemaField({
                    ignoreFatiguePenalties: new BooleanField({ initial: false }),
                    cannotUseTwoHanded:     new BooleanField({ initial: false })
                })
            })
        };
    }

    prepareDerivedData() {
        const LOCATIONS = ["head", "torso", "armL", "armR", "legL", "legR"];
        const BASE_MAX = { head: 4, torso: 10, armL: 5, armR: 5, legL: 5, legR: 5 };

        this.effectiveMax = {};
        this.effectiveHAR = {};
        this.effectiveLAR = {};
        // Per-location flag: true if ANY equipped armor piece covering this
        // location has isHardened=true.  Hardened armor ignores Penetration.
        // 📖 WT Rulebook Ch4 p.65 — "hardened armor is not reduced by weapon Penetration"
        this.isHardenedAt = {};

        for (const loc of LOCATIONS) {
            this.effectiveMax[loc] = BASE_MAX[loc] + (this.modifiers?.healthMax?.[loc] || 0);

            // HAR from natural + equipped armor
            let totalHAR = this.modifiers?.naturalHAR?.[loc] || 0;
            let totalLAR = this.modifiers?.naturalLAR?.[loc] || 0;
            let hardened = false;
            const items = this.parent?.items || [];
            for (const item of items) {
                if (item.type === "armor" && item.system.equipped && item.system.protectedLocations?.[loc]) {
                    totalHAR += item.system.har || 0;
                    totalLAR += item.system.lar || 0;
                    if (item.system.isHardened) hardened = true;
                }
            }
            this.effectiveHAR[loc] = totalHAR;
            this.effectiveLAR[loc] = totalLAR;
            this.isHardenedAt[loc] = hardened;
        }

        // WT Rulebook Ch3 p.51: "Base Will starts equal to the sum of your
        // Charm and Command Stats." Sum of all dice (Normal + Hard + Wiggle).
        const cmdTotal = (this.attributes.command?.normal || 0) + (this.attributes.command?.hard || 0) + (this.attributes.command?.wiggle || 0);
        const chrTotal = (this.attributes.charm?.normal || 0) + (this.attributes.charm?.hard || 0) + (this.attributes.charm?.wiggle || 0);
        this.willpower.base = cmdTotal + chrTotal;
        if (this.willpower.max === 0) this.willpower.max = this.willpower.base;

        // 📖 WT Rulebook Ch3 p.53: "Zero Willpower Points"
        // All HD and WD become regular dice; all power pools halved.
        // 📖 WT Rulebook Ch3 p.52: "Zero Base Will Points"
        // Additionally, Charm and Command stat dice cannot be used at all.
        this.zeroWillpower = (this.willpower.current <= 0) && (this.willpower.base > 0 || this.willpower.max > 0);
        this.zeroBaseWill = this.willpower.base <= 0;

        // ── Archetype Cost & Summary Strings (Increment 6) ──
        // Derive display-only archetype/source/permission strings from structured data.
        // Cost computation uses the archetype-engine module at the app layer;
        // here we just derive the summary labels for sheet display.
        const mqs = this.archetypeData?.metaQualities || [];
        if (mqs.length > 0) {
            const sources = mqs.filter(mq => mq.type === "source").map(mq => mq.name).filter(Boolean);
            const perms   = mqs.filter(mq => mq.type === "permission").map(mq => mq.name).filter(Boolean);
            this.source     = sources.join(", ");
            this.permission = perms.join(", ");
            if (this.archetypeData.name) this.archetype = this.archetypeData.name;
        }
    }
}


/**
 * Threat/Mook data model.
 * Adapted from Reign — creature mode and mob mechanics are ORE-universal.
 *
 * Added: dice type fields for creature attributes.
 */
export class WTThreatData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            threatLevel:   new NumberField({ initial: 3, min: 0, integer: true }),
            damageFormula: new StringField({ initial: "Width Shock" }),
            magnitude: new SchemaField({
                value: new NumberField({ initial: 5, min: 0, integer: true }),
                max:   new NumberField({ initial: 5, min: 1, integer: true })
            }),
            morale: new SchemaField({
                value: new NumberField({ initial: 5, min: 0, integer: true }),
                max:   new NumberField({ initial: 5, min: 1, integer: true })
            }),
            description:   new StringField({ initial: "" }),

            // ── Creature Mode ──
            creatureMode: new BooleanField({ initial: false }),
            movement:     new StringField({ initial: "" }),
            specialRules: new StringField({ initial: "" }),

            customLocations: new ArrayField(new SchemaField({
                key:         new StringField({ initial: "" }),
                name:        new StringField({ initial: "" }),
                rollHeights: new ArrayField(new NumberField({ integer: true, min: 1, max: 10 })),
                woundBoxes:  new NumberField({ initial: 5, min: 1, integer: true }),
                ar:          new NumberField({ initial: 0, min: 0, integer: true }),
                shock:       new NumberField({ initial: 0, min: 0, integer: true }),
                killing:     new NumberField({ initial: 0, min: 0, integer: true })
            })),
            creatureAttributes: new SchemaField({
                body:         makeStatDice(),
                coordination: makeStatDice(),
                sense:        makeStatDice()
            }),
            creatureSkills:  new ObjectField({ initial: {} }),
            creatureAttacks: new ArrayField(new SchemaField({
                name:      new StringField({ initial: "Attack" }),
                attribute: new StringField({ initial: "body" }),
                skill:     new StringField({ initial: "fight" }),
                damage:    new StringField({ initial: "Width Shock" }),
                notes:     new StringField({ initial: "" }),
                isSlow:    new NumberField({ initial: 0, min: 0, integer: true })
            })),
            creatureFlags: new SchemaField({
                freeGobbleDicePerRound: new NumberField({ initial: 0, min: 0, integer: true }),
                chargeRunWidest:       new NumberField({ initial: 0, min: 0, integer: true }),
                venomPotency:          new NumberField({ initial: 0, min: 0, integer: true }),
                venomType:             new StringField({ initial: "" })
            })
        };
    }

    prepareDerivedData() {
        if (this.creatureMode && this.customLocations?.length > 0) {
            this.heightLocationMap = {};
            for (const loc of this.customLocations) {
                for (const h of (loc.rollHeights || [])) {
                    if (!this.heightLocationMap[h]) this.heightLocationMap[h] = [];
                    this.heightLocationMap[h].push(loc.key);
                }
            }
        } else {
            this.heightLocationMap = {};
        }
    }
}


// ==========================================
// ITEM DATA MODELS
// ==========================================

export class WTWeaponData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            damage:    new StringField({ initial: "Width Shock" }),
            pool:      new StringField({ initial: "" }),
            range:     new StringField({ initial: "" }),
            equipped:  new BooleanField({ initial: false }),
            equippedTimestamp: new NumberField({ initial: 0 }),
            qualities: new SchemaField({
                armorPiercing: new NumberField({ initial: 0, integer: true }),
                slow:          new NumberField({ initial: 0, integer: true }),
                twoHanded:     new BooleanField({ initial: false }),
                massive:       new BooleanField({ initial: false }),
                unarmed:       new BooleanField({ initial: false }),
                area:          new NumberField({ initial: 0, integer: true })
            }),
            notes:    new StringField({ initial: "" }),
            skillKey: new StringField({ initial: "" }),
            isPoisoned: new BooleanField({ initial: false }),
            poisonRef:  new StringField({ initial: "" })
        };
    }
}

/**
 * WT Armor — uses HAR (Heavy Armor Rating) and LAR (Light Armor Rating)
 * instead of Reign's single AR value.
 *
 * 📖 WT Rulebook Ch6 — HAR stops Killing + Shock; LAR stops Shock only
 */
export class WTArmorData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            har:       new NumberField({ initial: 0, min: 0, integer: true }),
            lar:       new NumberField({ initial: 0, min: 0, integer: true }),
            // 📖 WT Rulebook Ch4 p.65: "hardened armor is not reduced by weapon Penetration"
            isHardened: new BooleanField({ initial: false }),
            equipped:  new BooleanField({ initial: false }),
            equippedTimestamp: new NumberField({ initial: 0 }),
            protectedLocations: new SchemaField({
                head: new BooleanField({ initial: false }),
                torso: new BooleanField({ initial: false }),
                armL: new BooleanField({ initial: false }),
                armR: new BooleanField({ initial: false }),
                legL: new BooleanField({ initial: false }),
                legR: new BooleanField({ initial: false })
            }),
            notes: new StringField({ initial: "" })
        };
    }

    get derivedWeight() {
        const locs = this.protectedLocations || {};
        const covered = Object.values(locs).filter(v => v).length;
        const coversAllLimbs = locs.armL && locs.armR && locs.legL && locs.legR;
        if (coversAllLimbs && this.har >= 2) return "heavy";
        if (covered <= 2 && this.har <= 1) return "light";
        return "medium";
    }
}

export class WTShieldData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            shieldSize: new StringField({ initial: "small", choices: ["small", "large", "tower"] }),
            material:   new StringField({ initial: "wood", choices: ["wood", "metal"] }),
            shieldArm:  new StringField({ initial: "armL", choices: ["armL", "armR"] }),
            parryBonus: new NumberField({ initial: 1, integer: true }),
            coverAR:    new NumberField({ initial: 1, integer: true }),
            equipped:   new BooleanField({ initial: false }),
            equippedTimestamp: new NumberField({ initial: 0 }),
            isStationary: new BooleanField({ initial: true }),
            protectedLocations: new SchemaField({
                head: new BooleanField({ initial: false }), torso: new BooleanField({ initial: false }),
                armL: new BooleanField({ initial: false }), armR: new BooleanField({ initial: false }),
                legL: new BooleanField({ initial: false }), legR: new BooleanField({ initial: false })
            }),
            notes: new StringField({ initial: "" })
        };
    }

    get effectiveLocations() {
        if (this.shieldSize === "tower") {
            const locs = { head: false, torso: false, armL: false, armR: false, legL: false, legR: false };
            const carryingArm = this.shieldArm || "armL";
            const carryingLeg = carryingArm === "armL" ? "legL" : "legR";
            if (this.isStationary) {
                locs[carryingArm] = true; locs[carryingLeg] = true;
                const manual = Object.keys(this.protectedLocations || {}).filter(k =>
                    this.protectedLocations[k] && k !== carryingArm && k !== carryingLeg);
                manual.slice(0, 2).forEach(k => locs[k] = true);
            } else {
                locs[carryingArm] = true;
            }
            return locs;
        }
        return getEffectiveShieldLocations(this);
    }
}

export class WTGearData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            quantity: new NumberField({ initial: 1, min: 0, integer: true }),
            notes:   new StringField({ initial: "" })
        };
    }
}

export class WTAdvantageData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            cost:   new NumberField({ initial: 1, integer: true }),
            effect: new StringField({ initial: "" })
        };
    }
}

export class WTProblemData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            bonus:  new NumberField({ initial: 1, integer: true }),
            effect: new StringField({ initial: "" })
        };
    }
}

export class WTPoisonData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            potency:     new NumberField({ initial: 5, min: 1, max: 15, integer: true }),
            majorEffect: new StringField({ initial: "" }),
            minorEffect: new StringField({ initial: "" }),
            difficulty:  new NumberField({ initial: 0, min: 0, max: 10, integer: true }),
            retainedDelivery: new BooleanField({ initial: true }),
            notes:       new StringField({ initial: "" })
        };
    }
}

// TODO: Increment 4 — WTPowerData (point-buy powers with Extras/Flaws/Capacities)

/**
 * Wild Talents 2e Power Data Model.
 *
 * Powers are composed of Power Qualities (Attacks, Defends, Useful).
 * Each Quality can have Extras (+cost) and Flaws (-cost).
 * Dice come in Normal, Hard (2× cost), and Wiggle (4× cost).
 *
 * Three power types:
 *   - Miracle: standalone dice pool. Each Quality costs 2/die base.
 *   - Hyperstat: adds dice to a Stat. 4/die base, all three Qualities.
 *   - Hyperskill: adds dice to a Skill. 1/die base, one Quality.
 *
 * WT Rulebook Ch6 (Powers), Ch7 (Extras), Ch8 (Flaws), Reference Sheet
 */
export class WTPowerData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        const makeExtra = () => new SchemaField({
            id:         new StringField({ initial: "" }),
            name:       new StringField({ initial: "" }),
            costPerDie: new NumberField({ initial: 1, integer: true }),
            quantity:   new NumberField({ initial: 1, min: 1, integer: true }),
            notes:      new StringField({ initial: "" })
        });

        const makeFlaw = () => new SchemaField({
            id:              new StringField({ initial: "" }),
            name:            new StringField({ initial: "" }),
            discountPerDie:  new NumberField({ initial: 1, min: 0, integer: true }),
            notes:           new StringField({ initial: "" })
        });

        const makeQuality = () => new SchemaField({
            id:       new StringField({ initial: "" }),
            type:     new StringField({ initial: "attacks", choices: ["attacks", "defends", "useful"] }),
            level:    new NumberField({ initial: 0, min: 0, integer: true }),
            capacity: new StringField({ initial: "range", choices: ["mass", "range", "speed", "touch", "self"] }),
            extras:   new ArrayField(makeExtra()),
            flaws:    new ArrayField(makeFlaw())
        });

        return {
            // Power type determines base cost structure
            powerType: new StringField({ initial: "miracle", choices: ["miracle", "hyperstat", "hyperskill"] }),

            // For Hyperstats/Hyperskills — which stat or skill this enhances
            linkedStat:  new StringField({ initial: "" }),
            linkedSkill: new StringField({ initial: "" }),

            // Dice pool composition
            dice: new SchemaField({
                normal: new NumberField({ initial: 1, min: 0, max: 10, integer: true }),
                hard:   new NumberField({ initial: 0, min: 0, max: 10, integer: true }),
                wiggle: new NumberField({ initial: 0, min: 0, max: 10, integer: true })
            }),

            // Power Qualities — each with its own Extras, Flaws, and Capacity
            qualities: new ArrayField(makeQuality()),

            // Activation costs
            willpowerCost: new NumberField({ initial: 0, min: 0, integer: true }),
            baseWillCost:  new NumberField({ initial: 0, min: 0, integer: true }),

            // Descriptive fields
            notes:  new StringField({ initial: "" }),
            effect: new StringField({ initial: "" })
        };
    }

    prepareDerivedData() {
        // ── Cost Calculation ──
        // WT Rulebook Reference Sheet:
        //   Miracle Quality: 2/die base
        //   Hyperstat: 4/die base (includes A/D/U)
        //   Hyperskill: 1/die base (includes one quality)
        //   Each Extra adds +N/die to the quality
        //   Each Flaw subtracts -N/die (min 1/die per quality)
        //   HD = 2× normal cost, WD = 4× normal cost

        let totalCostPerDie = 0;
        this.qualityCosts = [];

        if (this.powerType === "hyperstat") {
            // Hyperstat: flat 4/die, extras/flaws modify
            let baseCost = 4;
            let extrasCost = 0;
            let flawsDiscount = 0;
            for (const q of (this.qualities || [])) {
                for (const e of (q.extras || [])) extrasCost += (e.costPerDie || 0) * (e.quantity || 1);
                for (const f of (q.flaws || []))  flawsDiscount += (f.discountPerDie || 0);
            }
            totalCostPerDie = Math.max(1, baseCost + extrasCost - flawsDiscount);
            this.qualityCosts.push({ label: "Hyperstat", costPerDie: totalCostPerDie });

        } else if (this.powerType === "hyperskill") {
            // Hyperskill: flat 1/die, extras/flaws modify
            let baseCost = 1;
            let extrasCost = 0;
            let flawsDiscount = 0;
            for (const q of (this.qualities || [])) {
                for (const e of (q.extras || [])) extrasCost += (e.costPerDie || 0) * (e.quantity || 1);
                for (const f of (q.flaws || []))  flawsDiscount += (f.discountPerDie || 0);
            }
            totalCostPerDie = Math.max(1, baseCost + extrasCost - flawsDiscount);
            this.qualityCosts.push({ label: "Hyperskill", costPerDie: totalCostPerDie });

        } else {
            // Miracle: each Quality costs 2/die base + level + extras - flaws (min 1)
            for (const q of (this.qualities || [])) {
                const baseCost = 2;
                const levelCost = q.level || 0;
                let extrasCost = 0;
                let flawsDiscount = 0;
                for (const e of (q.extras || [])) extrasCost += (e.costPerDie || 0) * (e.quantity || 1);
                for (const f of (q.flaws || []))  flawsDiscount += (f.discountPerDie || 0);
                const qualCost = Math.max(1, baseCost + levelCost + extrasCost - flawsDiscount);
                totalCostPerDie += qualCost;
                const typeLabel = (q.type || "useful").charAt(0).toUpperCase() + (q.type || "useful").slice(1);
                this.qualityCosts.push({ label: typeLabel, costPerDie: qualCost });
            }
        }

        // If no qualities defined, minimum 1/die
        if (totalCostPerDie < 1) totalCostPerDie = 1;

        this.costPerDie = totalCostPerDie;

        // Total cost: normal × cost + hard × cost×2 + wiggle × cost×4
        const d = this.dice || {};
        this.totalCost = ((d.normal || 0) * totalCostPerDie)
                       + ((d.hard || 0) * totalCostPerDie * 2)
                       + ((d.wiggle || 0) * totalCostPerDie * 4);
    }
}
