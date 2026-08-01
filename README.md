# SillyTavern GFX & Details Repair

Global, preset-agnostic repair for SillyTavern panels that sometimes arrive
without their clickable `<details>/<summary>` markup, GFX markers, or HTML
wrappers.

This extension is designed for presets that use internal state panels,
summaries, details, trackers, or other structured GFX output. It works across
presets; it is not tied to Freaky Frankenstein 4, Freaky Frankenstein 5, or a
particular character.

## The problem it solves

Many SillyTavern presets ask the model to emit a structure such as:

```html
<!-- GFX_START -->
<details>
  <summary>Internal States</summary>
  ...state rows...
</details>
<!-- GFX_END -->
```

Models can occasionally output the same panel as plain headings, omit a
closing tag, put the HTML inside a Markdown code fence, or leave a GFX block
open. When that happens, SillyTavern cannot render the expected hide/show
button or panel styling. This extension repairs the structure before the
normal SillyTavern regex and Markdown pipeline runs.

## What it repairs

- Missing `<details>` and `<summary>` wrappers for learned preset panels.
- Nested panels, including internal-state sections and optional panels.
- Optional learned panels that were emitted inside the wrong parent are moved
  back to sibling panels (for example BONDS, CHEKHOV'S GUN, and INTERNAL
  THOUGHTS beside the main Internal States hierarchy).
- Concatenated headings such as `INTERNAL STATES (Turn: 18)NPC AGENDAS`
  when the model omits line breaks.
- Orphan, duplicated, or unclosed `details`/`summary` tags.
- A `<summary>` that runs into the next line without a closing tag.
- HTML/GFX structures accidentally wrapped in ```html Markdown fences.
- Clearly unclosed `<!-- GFX_START -->` markers.
- GFX blocks that need their closing marker after a balanced HTML element.
- Unknown structured trackers when safe-hybrid detection can identify them.

The repair is structural only: it does not rewrite narrative prose or the
values inside state rows. Existing attributes, inline styles, and preset
markup are preserved whenever possible.

## How detection works

The extension builds a template registry from:

1. Enabled prompts in the active preset that contain `<details>` and
   `<summary>`.
2. Active-preset regex replacement strings containing those tags.
3. Valid assistant panels already present in the current chat and swipes.
4. A small persistent cache in SillyTavern extension settings.

Template labels support dynamic values such as turn numbers and placeholders.
For example, a learned `INTERNAL STATES (Turn: [ct])` panel can match
`INTERNAL STATES (Turn: 17)` without hard-coding that turn number.

The default **Safe hybrid** mode first prefers learned templates, then repairs
an unknown heading only when it has strong tracker-like context (structured
field rows, a clear block boundary, or a GFX marker). Inline code and fenced
examples are protected so documentation such as `` `<details>` `` is not
changed.

## Installation

### Manual installation (no GitHub required)

Copy the complete `SillyTavern-GFX-Repair` folder into your SillyTavern
installation:

```text
<SillyTavern>/public/scripts/extensions/third-party/SillyTavern-GFX-Repair/
```

The folder must contain `manifest.json`, `index.js`, `lib/repair-engine.js`,
and `style.css` directly inside it. Restart SillyTavern, or force-refresh the
browser with **Ctrl+F5**, then open **Extensions** and enable **GFX & Details
Repair**.

### Install from a Git URL

The public repository is:

<https://github.com/disreconnected/SillyTavern-GFX-Repair>

Use that repository URL in SillyTavern's third-party extension installer, or
clone/download it and copy the folder manually. GitHub is not required for the
extension itself; it is a convenient distribution and update source.

## Settings

The extension adds a **GFX & Details Repair** drawer under SillyTavern's
Extensions panel.

- **Enable global repair** — master switch for all presets and chats.
- **Save structural repairs into chats** — enabled by default. Repaired text is
  written back to the assistant message and chat saves include a small
  `extra.gfx_repair` record. Disable this for render-only repairs.
- **Repair GFX fences and markers** — repairs `GFX_START`/`GFX_END` and
  structural Markdown fences.
- **Repair details and summary panels** — repairs learned and heuristic
  collapsible panels.
- **Use neutral fallback styling when needed** — adds restrained styling to
  recognized panels when a preset does not provide its own style.
- **Detection mode**:
  - **Template only**: only structures learned from the active preset/chat are
    repaired.
  - **Safe hybrid (recommended)**: learned templates plus conservative tracker
    detection.
  - **Aggressive headings**: also accepts weaker heading evidence and may wrap
    more unknown headings.

The drawer also provides **Preview current chat**, **Repair current chat now**,
and **Clear learned cache**. The detected template list and the latest scan
status are shown there.

## When repairs run

Repairs are registered at the earliest formatter stage before SillyTavern's
regex scripts. The extension refreshes its template registry and queues a scan
when chats, messages, swipes, or presets change. A short debounce prevents
repeated events from causing repeated saves. Repairs are idempotent: rendering
already-valid markup does not keep changing it. **Repair current chat now**
also runs the same repair pass over stored assistant messages; it is not limited
to newly generated replies.

When a model joins a learned heading directly to the next heading or its first
row, the repair engine restores those missing boundaries before applying the
usual learned template. This path is shared by new message rendering and the
**Repair current chat now** action.

## Safety and limitations

- The extension only targets assistant messages; user, system, and reasoning
  messages are left alone.
- Safe-hybrid mode intentionally favors false negatives over changing ordinary
  prose. Use Template only for maximum conservatism or Aggressive headings if a
  preset relies on unusual headings.
- A lone `GFX_END` or an ambiguous early `GFX_START` is reported as a warning
  instead of being guessed at.
- Templates are learned from the currently active preset and chat. Switching
  presets refreshes the registry; the persistent cache can be cleared from the
  settings drawer.
- This extension cannot fix a preset whose regex script removes the panel after
  rendering. In that case, inspect the preset's regex scripts and disable the
  conflicting replacement.
- It requires SillyTavern 1.18 or newer and a browser with standard DOM APIs.

## Development

The repair engine has no runtime dependencies. Node.js 20 or newer is used for
the test and syntax-check commands.

```powershell
npm test
npm run check
```

The tests cover nested template discovery, FF4-style Plot Momentum, FF5-style
Internal States, optional panels, code-fence repair, tag balancing, GFX marker
repair, false-positive protection, and idempotence.

### Project layout

```text
manifest.json                 SillyTavern extension metadata
index.js                      Settings UI, hooks, event handling, persistence
lib/repair-engine.js          Template discovery and pure repair functions
style.css                     Settings and neutral fallback panel styles
test/repair-engine.test.js    Node test suite
```

## Troubleshooting

1. Confirm the folder is under `public/scripts/extensions/third-party/` and
   that `manifest.json` is not one directory too deep.
2. Force-refresh with **Ctrl+F5** after copying or updating files.
3. Check the browser console for `[GFX Repair] Loaded`.
4. Open the extension drawer and use **Preview current chat** to see whether a
   message is recognized.
5. If a panel is still plain text, temporarily switch to **Aggressive headings**
   or add one valid example of the panel to the chat so it can be learned.
6. If styling is missing but markup is present, enable **Use neutral fallback
   styling** and check whether a preset CSS or regex script is overriding it.

## License

No license has been selected yet. If you redistribute or modify this project,
add the license terms you intend to use.
