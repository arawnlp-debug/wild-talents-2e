# Wild Talents 2nd Edition — Foundry VTT System

An unofficial fan-made system for playing **Wild Talents 2nd Edition** on [Foundry VTT](https://foundryvtt.com/), fully automating the One-Roll Engine (ORE).

> **Status: Closed Beta (v0.9.0-beta.1)**
> This system is in active development. Core mechanics are functional but some features are incomplete. Bug reports and feedback are welcome.

## Disclaimer

This is an **unofficial, fan-made** project and is not affiliated with, endorsed by, or associated with Arc Dream Publishing or Greg Stolze. Wild Talents is © Arc Dream Publishing. You need a copy of the Wild Talents 2nd Edition rulebook to use this system.

No copyrighted rules text is reproduced in this system. All rulebook references are by page and section number.

## Requirements

- **Foundry VTT v14** or later
- A copy of the **Wild Talents 2nd Edition** rulebook

## Installation

1. In Foundry VTT, go to **Game Systems** → **Install System**
2. Paste the manifest URL into the **Manifest URL** field:
   ```
   https://raw.githubusercontent.com/arawnlp-debug/foundry-wild-talents-2e/main/system.json
   ```
3. Click **Install**

Or download the latest release ZIP from GitHub and extract it into your Foundry `Data/systems/` directory.

## Features

### Character Creation
- **The Crucible** — A 7-step character builder wizard:
  1. Campaign power level (point budget from world settings)
  2. Stats — six attributes with Normal/Hard/Wiggle dice
  3. Skills — 24 suggested skills with freeform custom skill support
  4. Archetype — Source, Permission, and Intrinsic Meta-Qualities from the full Ch5 catalog
  5. Powers — inline Miracle, Hyperstat, and Hyperskill creation
  6. Willpower — Base Will, extra WP, Passion and Loyalty motivations
  7. Review — validation, cost breakdown, and one-click character forging
- **Point cost tracking** on the character sheet header with budget comparison

### Dice Rolling (ORE)
- Full One-Roll Engine implementation with Width×Height set resolution
- **Hard Dice** (HD) — always show as 10, visually distinct in chat
- **Wiggle Dice** (WD) — post-roll assignment dialog with set preview
- Penalty order enforced: HD removed first, then Normal, WD last
- 10-die pool cap with overflow absorption
- Called shots (free with HD/WD, −1d without)
- Multiple actions (−1d per extra action)
- Special maneuvers: Expert Action, Determined Action, Fast Action

### Powers
- **Three power types**: Miracle (standalone pool), Hyperstat (adds to stat), Hyperskill (adds to skill)
- Quality construction: Attacks, Defends, Useful with level and capacity
- Extras and Flaws with per-die cost modification
- Automatic cost calculation matching the Reference Sheet (HD ×2, WD ×4 multipliers)
- **Roll directly from the Powers tab** — opens the roll dialog with the power's dice pool
- Zero Willpower enforcement: power HD/WD become Normal, pools halved
- Native Power immunity to Zero WP effects

### Combat
- **Declare → Roll → Resolve** phase structure with phase toggle in the combat tracker
- **Combat Dashboard** — dedicated ApplicationV2 panel showing declarations, resolution order, spotlight tracking, gobble dice, and damage preview
- Declaration sorting by Sense (ascending), GMC before PC
- Resolution sorting by Width.Height (descending)
- Gobble dice from defense rolls with per-set targeting
- Dive for Cover option on dodge rolls
- **Advanced Maneuvers** — full Ch7 catalog (Charge, Disarm, Knockout, Pin, Strangle, Submission Hold, Trip, Slam, and more) with tiered automation

### Damage & Armor
- Hit location by Height (1-2 Legs, 3-4 Arms, 5-9 Torso, 10 Head)
- **LAR** (Light Armor): reduces Shock to 1, converts Killing to Shock
- **HAR** (Heavy Armor): reduces attack Width; blocked if Width drops to 1
- Penetration reduces both HAR and LAR (hardened armor immune)
- Killing overflow from destroyed limbs to Torso
- Status effects auto-applied: Dead, Unconscious, Dazed, Maimed, Bleeding

### Willpower
- Base Will derived from Charm + Command (purchasable extra)
- Willpower gain/loss with cascade to Base Will at zero
- **Combat actions**: Shake It Off (reduce damage for WP), Stay Alive (survive lethal for 1 round), Wake Up (risk half WP to regain consciousness)
- Zero Willpower and Zero Base Will status effects with mechanical enforcement
- Natural 10s (non-HD) grant +1 WP automatically
- Motivation-based WP tracking (Passion and Loyalty with ratings)

### Archetypes (Ch5)
- Full Meta-Quality catalog: all Sources, Permissions, and Intrinsics
- Variable-cost calculation for Allergy, Inhuman Stats, Vulnerable
- Archetype validation (Source required for powers, Permission gates power types)
- First Source is free; minimum archetype cost clamped to 0
- Sample archetypes verified against rulebook examples

### Threats & Creatures
- **Mob mode** — binary elimination with magnitude/morale
- **Creature mode** — custom hit locations, wound boxes, creature skills with HD/WD
- Special ability automation: Elephant (trumpet, trunk grab), Boa (constrict), Rhino (charge accumulation), Venom
- Creature skills use the same HD/WD mechanics as PC skills

### GM Tools
- **GM Toolbar** — persistent HUD with quick roll, token peek, party vitals
- **XP Award Panel** — end-of-session XP distribution with base + per-character bonuses
- **Hazard Roller** — environmental and poison hazard automation
- Roll requests and contested rolls

### Additional Features
- Dice So Nice integration (distinct HD/WD colors when module is active)
- Colorblind mode with shape-based indicators
- XP spending for stat/skill/BW/WP advancement on the character sheet
- Migration framework for safe world updates
- Full localization support (English)

## World Settings

Found under **Settings → Configure Settings → System Settings**:

| Setting | Description |
|---------|-------------|
| Campaign Power Level | Sets the point budget for new characters (Normal Human through Universal Entity, or Custom) |
| Custom Point Total | Manual point budget when Power Level is set to Custom |
| Stat/Skill/Power Budgets | Optional sub-category limits (0 = unlimited) |
| Post-Combat Recovery | Full or half Shock recovery after combat ends |
| Declaration Mode | Simple (checkbox) or Advanced (structured declaration dialog) |
| Colorblind Mode | High-contrast palette with shape indicators |

## Creating a Character

1. Create a new Actor (type: Character)
2. The Crucible opens automatically — follow the 7 steps
3. Or open it later via the "The Crucible" button in the sheet header
4. The character sheet displays your total point cost in the header

## Running Combat

1. Create a combat encounter and add combatants
2. Start combat — enters Declaration phase
3. Players confirm declarations (checkbox or structured dialog)
4. GM advances to Resolution phase (or it auto-advances when all declare)
5. Players roll actions — sets appear in the Combat Dashboard
6. GM resolves sets in Width.Height order using the spotlight system
7. Damage is applied via chat card buttons with full armor pipeline
8. End combat to trigger post-combat Shock recovery

## Known Limitations

- Power activation duration tracking (scene-level) is not yet implemented
- Extras/Flaws use freeform text entry (suggested dropdown pending)
- Optional damage variants (Die Hard, Nothing But Shock, Four-Color Recovery) are not yet available as world settings
- Wound Shift (WP spend to change hit location) is not yet automated
- Compendium packs are empty templates — GMs populate their own content

## License

This system code is released under the MIT License.

Wild Talents is © Arc Dream Publishing. This system does not include any copyrighted game content.

## Credits

- **System Author**: Llew ap Hywel
- **Based on**: The One-Roll Engine by Greg Stolze
- **Foundry VTT**: [foundryvtt.com](https://foundryvtt.com/)
"# wild-talents-2e" 
