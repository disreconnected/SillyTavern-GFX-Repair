import assert from 'node:assert/strict';
import test from 'node:test';

import {
    discoverTemplates,
    repairMessage,
    TemplateRegistry,
} from '../lib/repair-engine.js';

function registryFrom(...sources) {
    const registry = new TemplateRegistry();
    sources.forEach((source, index) => registry.addFromText(source, `fixture-${index}`));
    return registry;
}

function summaryDepths(source) {
    const depths = new Map();
    const tokens = /<details\b[^>]*>|<\/details\s*>|<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/gi;
    let depth = 0;
    let match;
    while ((match = tokens.exec(source)) !== null) {
        if (/^<details/i.test(match[0])) {
            depth++;
        } else if (/^<\/details/i.test(match[0])) {
            depth--;
        } else {
            depths.set(match[1], depth);
        }
    }
    return depths;
}

const plotMomentumTemplate = `
<details>
<summary>Plot Momentum</summary>
- NPC_Agenda: [goal]
- Physics: [positions]
- Scene_Pacing: [pace]
</details>`;

const internalStatesTemplate = `
<!-- GFX_START -->
<internal_states>
<details>
  <summary>🎬 INTERNAL STATES (Turn: [ct])</summary>
  <details>
    <summary>👤 NPC AGENDAS</summary>
    - <b>[NPC]</b> | Agenda: [task]
  </details>
  <details>
    <summary>🏳️ FACTIONS</summary>
    - <b>Hive</b> | Goal: [goal]
  </details>
  <details>
    <summary>📜 QUESTS</summary>
    - <b>Main</b> | Objective: [objective]
  </details>
  <details>
    <summary>🌌 PHYSICS, ENGINE & WORLD</summary>
    - Env: [environment]
    - Physics: [positions]
  </details>
</details>
</internal_states>
<!-- GFX_END -->`;

test('discovers nested templates and deduplicates fingerprints', () => {
    const definitions = discoverTemplates(`${internalStatesTemplate}\n${internalStatesTemplate}`, 'preset');
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].root.label, '🎬 INTERNAL STATES (Turn: [ct])');
    assert.deepEqual(
        definitions[0].root.children.map((child) => child.label),
        ['👤 NPC AGENDAS', '🏳️ FACTIONS', '📜 QUESTS', '🌌 PHYSICS, ENGINE & WORLD'],
    );
});

test('leaves already-valid details markup unchanged', () => {
    const registry = registryFrom(plotMomentumTemplate);
    const result = repairMessage(plotMomentumTemplate, registry);
    assert.equal(result.changed, false);
    assert.equal(result.text, plotMomentumTemplate);
});

test('restores a learned FF4 Plot Momentum panel and leaves COLORS outside', () => {
    const registry = registryFrom(plotMomentumTemplate);
    const malformed = `Narrative ending.

---

Plot Momentum
- NPC_Agenda: Advance the scene
- Physics: Character beside the door
- Scene_Pacing: Steady
- Selected_Path: A

[COLORS:Alex=#fff]`;
    const result = repairMessage(malformed, registry);

    assert.equal(result.changed, true);
    assert.match(result.text, /<details>\s*<summary>Plot Momentum<\/summary>/);
    assert.match(result.text, /<\/details>\s*\[COLORS:Alex=#fff\]$/);
    assert.ok(result.actions.some((action) => action.type === 'restore-learned-details'));
});

test('repairs a collapsed learned panel outside a GFX block', () => {
    const malformed = `Narrative ending.

---
Plot Momentum- NPC_Agenda: Advance the scene
 - Physics: Character beside the door
 - Scene_Pacing: Steady

[COLORS:Alex=#fff]`;
    const result = repairMessage(malformed, registryFrom(plotMomentumTemplate));

    assert.match(result.text, /<details>\s*<summary>Plot Momentum<\/summary>/);
    assert.match(result.text, /Scene_Pacing: Steady[\s\S]*<\/details>\s*\[COLORS:Alex=#fff\]/);
});

test('restores nested FF5 panels using a dynamic turn label', () => {
    const registry = registryFrom(internalStatesTemplate);
    const malformed = `Narrative.

<!-- GFX_START -->

🎬 INTERNAL STATES (Turn: 17)

👤 NPC AGENDAS
- Elara | Agenda: File report

📜 QUESTS
- Main | Objective: Wait

🌌 PHYSICS, ENGINE & WORLD
- Env: Tower
- Physics: Seated

<!-- GFX_END -->`;
    const result = repairMessage(malformed, registry);

    assert.equal((result.text.match(/<details>/g) ?? []).length, 4);
    assert.match(result.text, /<summary>🎬 INTERNAL STATES \(Turn: 17\)<\/summary>/);
    assert.match(result.text, /<summary>👤 NPC AGENDAS<\/summary>/);
    assert.match(result.text, /<summary>📜 QUESTS<\/summary>/);
    assert.match(result.text, /<summary>🌌 PHYSICS, ENGINE & WORLD<\/summary>/);
    assert.equal((result.text.match(/GFX_START/g) ?? []).length, 1);
    assert.equal((result.text.match(/GFX_END/g) ?? []).length, 1);
});

test('repairs learned panels when the model concatenates headings and rows', () => {
    const malformed = `<!-- GFX_START -->
🎬 INTERNAL STATES (Turn: 18)👤 NPC AGENDAS -Xyl (Overseer) | Agenda: Report to King | Aware: Structural weak points
 -Elara | Agenda: Deep Sleep | Aware: None

📜 QUESTS -Main | Objective: Establish dominance over the Hive / 100%

🌌 PHYSICS, ENGINE & WORLD - Env: Royal Nest, stabilized archway.
 - Physics: Structural load data.
<!-- GFX_END -->`;
    const result = repairMessage(malformed, registryFrom(internalStatesTemplate));

    assert.equal((result.text.match(/<details>/g) ?? []).length, 4);
    assert.match(result.text, /<summary>🎬 INTERNAL STATES \(Turn: 18\)<\/summary>/);
    assert.match(result.text, /<summary>👤 NPC AGENDAS<\/summary>[\s\S]*Xyl \(Overseer\)/);
    assert.match(result.text, /<summary>📜 QUESTS<\/summary>[\s\S]*Establish dominance/);
    assert.match(result.text, /<summary>🌌 PHYSICS, ENGINE & WORLD<\/summary>[\s\S]*Structural load data/);
    assert.equal((result.text.match(/GFX_START/g) ?? []).length, 1);
    assert.equal((result.text.match(/GFX_END/g) ?? []).length, 1);
    assert.equal(repairMessage(result.text, registryFrom(internalStatesTemplate)).changed, false);
});

test('repairs only the learned panel when another GFX block is present', () => {
    const registry = registryFrom(internalStatesTemplate);
    const terminal = `<!-- GFX_START -->
<div style="font-family:monospace">&gt; ACCESS GRANTED</div>
<!-- GFX_END -->`;
    const malformed = `${terminal}

Narrative.

<!-- GFX_START -->
🎬 INTERNAL STATES (Turn: 2)
👤 NPC AGENDAS
- NPC | Agenda: Move
📜 QUESTS
- Main | Objective: Follow
🌌 PHYSICS, ENGINE & WORLD
- Env: Hall
- Physics: Standing
<!-- GFX_END -->`;
    const result = repairMessage(malformed, registry);

    assert.ok(result.text.startsWith(terminal));
    assert.equal((result.text.match(/GFX_START/g) ?? []).length, 2);
    assert.equal((result.text.match(/<details>/g) ?? []).length, 4);
});

test('keeps separately learned optional panels as sibling panels', () => {
    const optionalTemplate = '<details><summary>📓 GM\'S NOTEBOOK</summary>- [R] Note</details>';
    const registry = registryFrom(internalStatesTemplate, optionalTemplate);
    const malformed = `<!-- GFX_START -->
🎬 INTERNAL STATES (Turn: 4)
👤 NPC AGENDAS
- NPC | Agenda: Move
📓 GM'S NOTEBOOK
- Reminder: Preserve this
📜 QUESTS
- Main | Objective: Continue
🌌 PHYSICS, ENGINE & WORLD
- Env: Room
- Physics: Seated
<!-- GFX_END -->`;
    const result = repairMessage(malformed, registry);

    assert.equal((result.text.match(/<details>/g) ?? []).length, 5);
    assert.match(result.text, /<summary>📓 GM'S NOTEBOOK<\/summary>/);
    assert.equal(repairMessage(result.text, registry).changed, false);
});

test('promotes optional learned panels out of the wrong parent details block', () => {
    const registry = registryFrom(
        internalStatesTemplate,
        '<details><summary>💚 BONDS</summary>- Hive | BOND: 4</details>',
        '<details><summary>🔫 CHEKHOV\'S GUN</summary>- Active: None</details>',
        '<details><summary>🧠 INTERNAL THOUGHTS</summary>- Xyl | Thought: Ready</details>',
    );
    const malformed = `<details>
<summary>🎬 INTERNAL STATES (Turn: 22)</summary>
<details>
<summary>🏳️ FACTIONS</summary>
-The Hive | Goal: Survive
💚 BONDS-The Hive | BOND: 4
</details>
<details>
<summary>📜 QUESTS</summary>
-Main | Objective: Continue
🔫 CHEKHOV'S GUN- Active: None
🧠 INTERNAL THOUGHTS-Xyl | Thought: Ready
</details>
</details>`;
    const result = repairMessage(malformed, registry);
    const summaries = [...result.text.matchAll(/<summary>([\s\S]*?)<\/summary>/gi)].map((match) => match[1]);

    assert.equal(result.changed, true);
    assert.deepEqual(summaries, [
        '🎬 INTERNAL STATES (Turn: 22)',
        '🏳️ FACTIONS',
        '💚 BONDS',
        '📜 QUESTS',
        "🔫 CHEKHOV'S GUN",
        '🧠 INTERNAL THOUGHTS',
    ]);
    assert.match(result.text, /<\/details>\s*<details>\s*<summary>💚 BONDS<\/summary>/);
    assert.match(result.text, /<\/details>\s*<details>\s*<summary>🔫 CHEKHOV'S GUN<\/summary>/);
    const depths = summaryDepths(result.text);
    assert.equal(depths.get('🏳️ FACTIONS'), 2);
    assert.equal(depths.get('💚 BONDS'), 2);
    assert.equal(depths.get("🔫 CHEKHOV'S GUN"), 2);
    assert.equal(depths.get('🧠 INTERNAL THOUGHTS'), 2);
    assert.equal(repairMessage(result.text, registry).changed, false);
});

test('promotes optional panels after balancing an unclosed parent', () => {
    const registry = registryFrom(
        internalStatesTemplate,
        '<details><summary>💚 BONDS</summary>- Hive | BOND: 4</details>',
    );
    const malformed = `<details>
<summary>🎬 INTERNAL STATES (Turn: 22)</summary>
<details>
<summary>🏳️ FACTIONS</summary>
-The Hive | Goal: Survive
</details>
💚 BONDS-The Hive | BOND: 4`;
    const result = repairMessage(malformed, registry, { detectionMode: 'template-only' });
    const depths = summaryDepths(result.text);

    assert.equal(depths.get('💚 BONDS'), 2);
    assert.equal(repairMessage(result.text, registry).changed, false);
});

test('flattens unexpected nested details inside learned leaf panels', () => {
    const registry = registryFrom(
        '<details><summary>🧠 INTERNAL THOUGHTS</summary>- [NPC] | Internal Thoughts: [thought]</details>',
        '<details><summary>🌎 WORLD SIM</summary>- Active Table: [table]<br>- Roll: [roll]</details>',
    );
    const malformed = `<details><summary>🧠 INTERNAL THOUGHTS</summary><br>-Xyl |
<details><summary>Internal Thoughts:</summary>The armor is tough. Tougher than ours.</details></details>
<details><summary>🌎 WORLD SIM</summary>-Active Table: Duo Table-
<details><summary>World Sim</summary>Roll: 9-Event: MEMORY_TRIGGER</details></details>`;
    const result = repairMessage(malformed, registry);

    assert.equal(result.changed, true);
    assert.equal((result.text.match(/<details>/g) ?? []).length, 2);
    assert.doesNotMatch(result.text, /<summary>Internal Thoughts:<\/summary>/);
    assert.doesNotMatch(result.text, /<summary>World Sim<\/summary>/);
    assert.match(result.text, /Internal Thoughts:\s*The armor is tough/);
    assert.match(result.text, /World Sim\s*Roll: 9-Event: MEMORY_TRIGGER/);
    assert.ok(result.actions.every((action) => action.type === 'flatten-unexpected-nested-details'));
    assert.equal(repairMessage(result.text, registry).changed, false);
});

test('merges matching continuation details after a hierarchical panel', () => {
    const registry = registryFrom(
        internalStatesTemplate,
        '<details><summary>🧠 INTERNAL THOUGHTS</summary>- [NPC] | Internal Thoughts: [thought]</details>',
        '<details><summary>🌎 WORLD SIM</summary>- Active Table: [table]<br>- Roll: [roll]</details>',
    );
    const malformed = `<details><summary>🎬 INTERNAL STATES (Turn: 24)</summary>
<details><summary>🧠 INTERNAL THOUGHTS</summary><br>-Xyl |</details>
<details><summary>🌎 WORLD SIM</summary>-Active Table: Duo Table-</details></details>
<details><summary>Internal Thoughts:</summary>The wall looks strong now.</details>
<details><summary>World Sim</summary>Roll: 5-Event: MOOD_SWING</details>`;
    const result = repairMessage(malformed, registry);

    assert.equal(result.changed, true);
    assert.equal((result.text.match(/<details>/g) ?? []).length, 3);
    assert.doesNotMatch(result.text, /<summary>Internal Thoughts:<\/summary>/);
    assert.doesNotMatch(result.text, /<summary>World Sim<\/summary>/);
    assert.match(result.text, /<summary>🧠 INTERNAL THOUGHTS<\/summary>[\s\S]*Internal Thoughts:\s*The wall looks strong/);
    assert.match(result.text, /<summary>🌎 WORLD SIM<\/summary>[\s\S]*World Sim\s*Roll: 5-Event: MOOD_SWING/);
    assert.ok(result.actions.some((action) => action.type === 'merge-continuation-detail'));
    assert.equal(repairMessage(result.text, registry).changed, false);
});

test('removes a Markdown fence around structural HTML', () => {
    const fenced = `Before

\`\`\`html
<details><summary>Tracker</summary>
- State: Ready
</details>
\`\`\``;
    const result = repairMessage(fenced, new TemplateRegistry());

    assert.equal(result.changed, true);
    assert.doesNotMatch(result.text, /```/);
    assert.match(result.text, /<details><summary>Tracker<\/summary>/);
});

test('wraps an orphan summary and closes it at the end', () => {
    const malformed = `<summary>Tracker</summary>
- State: Ready`;
    const result = repairMessage(malformed, new TemplateRegistry(), {
        detectionMode: 'template-only',
    });

    assert.equal(result.text, `<details><summary>Tracker</summary>
- State: Ready</details>`);
    assert.ok(result.actions.some((action) => action.type === 'wrap-orphan-summary'));
});

test('closes an unclosed summary at its first line break', () => {
    const malformed = `<details><summary>Tracker
- State: Ready
</details>`;
    const result = repairMessage(malformed, new TemplateRegistry(), {
        detectionMode: 'template-only',
    });

    assert.match(result.text, /<summary>Tracker<\/summary>\n- State: Ready/);
    assert.equal((result.text.match(/<details>/g) ?? []).length, 1);
    assert.equal((result.text.match(/<\/details>/g) ?? []).length, 1);
});

test('safe hybrid repairs an unknown structured tracker', () => {
    const malformed = `A long narrative paragraph that finishes the scene and establishes enough leading content.

---

Unknown Scene Tracker
- Agenda: Advance
- Physics: Standing
- Pacing: Steady
- Choice: A`;
    const result = repairMessage(malformed, new TemplateRegistry());

    assert.match(result.text, /<details>\s*<summary>Unknown Scene Tracker<\/summary>/);
    assert.ok(result.actions.some((action) => action.type === 'restore-heuristic-details'));
});

test('safe hybrid does not transform ordinary prose or headings', () => {
    const prose = `Internal States

This paragraph explains that details and summary tags are clickable in a browser.
It is ordinary prose, not a structured tracker.`;
    const result = repairMessage(prose, new TemplateRegistry());

    assert.equal(result.changed, false);
    assert.equal(result.text, prose);
});

test('does not balance details tags mentioned inside inline code', () => {
    const explanation = 'Use `<details>` with `<summary>` to make a native collapsible panel.';
    const result = repairMessage(explanation, new TemplateRegistry());

    assert.equal(result.changed, false);
    assert.equal(result.text, explanation);
    assert.equal(discoverTemplates(explanation).length, 0);
});

test('inserts a missing GFX_END after a balanced HTML element', () => {
    const malformed = `Narrative.
<!-- GFX_START -->
<div><div>STATUS</div></div>
After`;
    const result = repairMessage(malformed, new TemplateRegistry(), {
        repairDetails: false,
    });

    assert.match(result.text, /<\/div>\n<!-- GFX_END -->\nAfter$/);
    assert.ok(result.actions.some((action) => action.type === 'insert-gfx-end-after-html'));
});

test('preserves valid details attributes and inline styles', () => {
    const styled = `<details class="custom" style="color:red"><summary style="font-weight:bold">Menu</summary>Body</details>`;
    const result = repairMessage(styled, registryFrom(styled));

    assert.equal(result.changed, false);
    assert.equal(result.text, styled);
});

test('repair is idempotent', () => {
    const registry = registryFrom(plotMomentumTemplate);
    const malformed = `Narrative.

Plot Momentum
- NPC_Agenda: Advance
- Physics: Doorway
- Scene_Pacing: Steady`;
    const first = repairMessage(malformed, registry);
    const second = repairMessage(first.text, registry);

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(second.text, first.text);
});
