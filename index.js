import { oai_settings } from '../../../openai.js';
import {
    discoverTemplates,
    repairMessage,
    TemplateRegistry,
} from './lib/repair-engine.js';

export default 'GfxDetailsRepair';

const EXTENSION_KEY = 'gfxDetailsRepair';
const EXTENSION_VERSION = '2.0.0';
const context = SillyTavern.getContext();

const defaultSettings = Object.freeze({
    enabled: true,
    repairGfx: true,
    repairDetails: true,
    detectionMode: 'safe-hybrid',
    neutralFallback: true,
    learnedTemplates: [],
});

const registry = new TemplateRegistry();
let settingsUiAdded = false;
let lastStatus = 'Waiting for a chat.';
let sessionRepairCount = 0;

function getSettings() {
    return context.extensionSettings[EXTENSION_KEY];
}

function initializeSettings() {
    if (!context.extensionSettings[EXTENSION_KEY]) {
        context.extensionSettings[EXTENSION_KEY] = structuredClone(defaultSettings);
    }

    const settings = getSettings();
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(value);
        }
    }
    // v1.x persisted automatic chat mutations; v2 is render-only unless explicitly triggered.
    delete settings.persistRepairs;
}

function collectPresetTemplateSources() {
    const sources = [];
    for (const [index, prompt] of (oai_settings?.prompts ?? []).entries()) {
        if (prompt?.enabled === false || typeof prompt?.content !== 'string') {
            continue;
        }
        if (/<details\b/i.test(prompt.content) && /<summary\b/i.test(prompt.content)) {
            sources.push({
                content: prompt.content,
                name: `active-preset:${prompt.name || prompt.identifier || index}`,
            });
        }
    }

    // Some presets keep display templates in extension regex replacements.
    for (const [index, script] of (oai_settings?.extensions?.regex_scripts ?? []).entries()) {
        const content = String(script?.replaceString ?? '');
        if (script?.disabled || !/<details\b/i.test(content) || !/<summary\b/i.test(content)) {
            continue;
        }
        sources.push({
            content,
            name: `active-regex:${script.scriptName || index}`,
        });
    }
    return sources;
}

function isEligibleAssistantMessage(message) {
    return Boolean(message)
        && !message.is_user
        && !message.is_system
        && typeof message.mes === 'string';
}

function collectChatTemplateSources() {
    const sources = [];
    for (const [messageIndex, message] of (context.chat ?? []).entries()) {
        if (!isEligibleAssistantMessage(message)) {
            continue;
        }

        const candidates = [
            ['mes', message.mes],
            ...(Array.isArray(message.swipes)
                ? message.swipes.map((swipe, index) => [`swipe-${index}`, swipe])
                : []),
        ];
        for (const [kind, content] of candidates) {
            if (typeof content === 'string' && /<details\b/i.test(content) && /<summary\b/i.test(content)) {
                sources.push({
                    content,
                    name: `chat:${messageIndex}:${kind}`,
                });
            }
        }
    }
    return sources;
}

function serializedFingerprintList(definitions) {
    return definitions.map((definition) => definition.fingerprint).sort().join('|');
}

function refreshTemplateRegistry({ persist = true } = {}) {
    const settings = getSettings();
    const previous = Array.isArray(settings.learnedTemplates) ? settings.learnedTemplates : [];
    registry.clear();
    registry.addMany(previous);

    for (const source of collectPresetTemplateSources()) {
        registry.addMany(discoverTemplates(source.content, source.name));
    }
    for (const source of collectChatTemplateSources()) {
        registry.addMany(discoverTemplates(source.content, source.name));
    }

    const serialized = registry.serialize();
    if (persist && serializedFingerprintList(serialized) !== serializedFingerprintList(previous)) {
        settings.learnedTemplates = serialized;
        context.saveSettingsDebounced();
    }
    updateSettingsStatus();
}

function currentRepairOptions() {
    const settings = getSettings();
    return {
        repairGfx: settings.repairGfx,
        repairDetails: settings.repairDetails,
        detectionMode: settings.detectionMode,
    };
}

/**
 * Render-time repair: computes repaired text and patches the DOM directly.
 * The chat message object is never touched, so no extension save can
 * ever persist a repair into the chat file on disk.
 */
function repairRenderedMessage(messageId) {
    const chat = context.chat ?? [];
    const id = Number(messageId);
    if (!getSettings().enabled || !Number.isInteger(id) || id < 0 || id >= chat.length) {
        return;
    }

    const message = chat[id];
    if (!isEligibleAssistantMessage(message)) {
        return;
    }

    const messageElement = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
    if (!messageElement) {
        return;
    }

    const result = repairMessage(message.mes, registry, currentRepairOptions());
    if (!result.changed) {
        return;
    }

    sessionRepairCount++;
    // Render the repaired text through ST's own formatter and swap the DOM node.
    // ponytail: string-DOM pairing by mesid is stable in ST 1.18; switch to
    // context.updateMessageBlock if messages ever stop carrying mesid.
    messageElement.innerHTML = context.messageFormatting(
        result.text,
        message.name,
        message.is_system,
        message.is_user,
        id,
        {},
        false,
    );
    lastStatus = `Repaired message ${id} for display (${result.actions.length} action(s)).`;
    updateSettingsStatus();
}

/**
 * DOM pass: tags recognized panels for neutral fallback styling.
 * Runs on the rendered chat element after messages exist.
 */
function annotateRenderedPanels() {
    const settings = getSettings();
    if (!settings.enabled || !settings.neutralFallback) {
        return;
    }

    for (const details of document.querySelectorAll('#chat .mes_text details')) {
        const summary = [...details.children].find((element) => element.tagName === 'SUMMARY');
        if (!summary || details.dataset.gfxRepairPanel === 'true') {
            continue;
        }
        if (registry.matchesDomLabel(summary.textContent || '') || isStructuredDetails(details)) {
            details.dataset.gfxRepairPanel = 'true';
            for (const nested of details.querySelectorAll('details')) {
                nested.dataset.gfxRepairPanel = 'true';
            }
        }
    }
}

/**
 * Sweeps the whole rendered chat: repairs each assistant message for display,
 * then annotates panels. Used when a chat loads or history streams in.
 */
function sweepRenderedChat() {
    refreshTemplateRegistry();
    for (let index = 0; index < (context.chat ?? []).length; index++) {
        repairRenderedMessage(index);
    }
    annotateRenderedPanels();
}

function isStructuredDetails(details) {
    const text = details.textContent || '';
    const rows = text.match(/(?:^|\n)\s*[-*]\s+[^:\n]{1,100}:/g) ?? [];
    return rows.length >= 3;
}

function flattenTemplateLabels(node, depth = 0, output = []) {
    output.push(`${'  '.repeat(depth)}• ${node.label}`);
    for (const child of node.children ?? []) {
        flattenTemplateLabels(child, depth + 1, output);
    }
    return output;
}

function updateSettingsStatus() {
    const status = document.getElementById('gfx_repair_status');
    if (status) {
        status.textContent = `${lastStatus}\nSession repairs: ${sessionRepairCount}. Learned templates: ${registry.roots.length}.`;
    }

    const templates = document.getElementById('gfx_repair_templates');
    if (templates instanceof HTMLTextAreaElement) {
        const labels = registry.roots.flatMap(({ root }) => flattenTemplateLabels(root));
        templates.value = labels.length ? labels.join('\n') : 'No templates learned yet.';
    }
}

function createCheckbox(id, labelText, settingKey, onChange = null) {
    const label = document.createElement('label');
    label.classList.add('checkbox_label', 'marginBot5');
    label.htmlFor = id;

    const input = document.createElement('input');
    input.id = id;
    input.type = 'checkbox';
    input.checked = Boolean(getSettings()[settingKey]);
    input.addEventListener('change', async () => {
        getSettings()[settingKey] = input.checked;
        context.saveSettingsDebounced();
        await onChange?.(input.checked);
    });

    const text = document.createElement('span');
    text.textContent = labelText;
    label.append(input, text);
    return label;
}

function createButton(label, clickHandler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('menu_button');
    button.textContent = label;
    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            await clickHandler();
        } finally {
            button.disabled = false;
        }
    });
    return button;
}

function addSettingsUi() {
    if (settingsUiAdded) {
        return;
    }
    const container = document.getElementById('extensions_settings');
    if (!container) {
        return;
    }
    settingsUiAdded = true;

    const drawer = document.createElement('div');
    drawer.classList.add('inline-drawer');

    const toggle = document.createElement('div');
    toggle.classList.add('inline-drawer-toggle', 'inline-drawer-header');
    const title = document.createElement('b');
    title.textContent = 'GFX & Details Repair';
    const icon = document.createElement('div');
    icon.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');
    toggle.append(title, icon);

    const content = document.createElement('div');
    content.classList.add('inline-drawer-content');
    content.append(
        createCheckbox('gfx_repair_enabled', 'Enable global repair', 'enabled'),
        createCheckbox('gfx_repair_gfx', 'Repair GFX fences and markers', 'repairGfx'),
        createCheckbox('gfx_repair_details', 'Repair details and summary panels', 'repairDetails'),
        createCheckbox('gfx_repair_fallback', 'Use neutral fallback styling when needed', 'neutralFallback'),
    );

    const modeLabel = document.createElement('label');
    modeLabel.htmlFor = 'gfx_repair_mode';
    modeLabel.textContent = 'Detection mode';
    const mode = document.createElement('select');
    mode.id = 'gfx_repair_mode';
    mode.classList.add('text_pole');
    for (const [value, text] of [
        ['template-only', 'Template only'],
        ['safe-hybrid', 'Safe hybrid (recommended)'],
        ['aggressive', 'Aggressive headings'],
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        option.selected = getSettings().detectionMode === value;
        mode.append(option);
    }
    mode.addEventListener('change', () => {
        getSettings().detectionMode = mode.value;
        context.saveSettingsDebounced();
    });
    content.append(modeLabel, mode);

    const note = document.createElement('div');
    note.classList.add('opacity70p');
    note.textContent = 'Repairs are render-only: stored messages are never rewritten or saved automatically.';
    content.append(note);

    const actions = document.createElement('div');
    actions.classList.add('gfx-repair-actions');
    actions.append(
        createButton('Preview current chat', async () => {
            refreshTemplateRegistry();
            let wouldRepair = 0;
            for (const [index, message] of (context.chat ?? []).entries()) {
                if (!isEligibleAssistantMessage(message)) continue;
                if (repairMessage(message.mes, registry, currentRepairOptions()).changed) {
                    wouldRepair++;
                }
            }
            lastStatus = wouldRepair
                ? `${wouldRepair} message(s) render-repaired this session.`
                : 'No repairable structures found in assistant messages.';
            updateSettingsStatus();
            globalThis.toastr?.info(
                `${wouldRepair} assistant message(s) need repair.`,
                'GFX & Details Repair',
            );
        }),
        createButton('Clear learned cache', async () => {
            getSettings().learnedTemplates = [];
            context.saveSettingsDebounced();
            refreshTemplateRegistry({ persist: false });
            lastStatus = 'Persistent template cache cleared; active preset/chat templates remain available.';
            updateSettingsStatus();
        }),
    );
    content.append(actions);

    const status = document.createElement('div');
    status.id = 'gfx_repair_status';
    status.classList.add('opacity70p');
    content.append(status);

    const templateLabel = document.createElement('label');
    templateLabel.htmlFor = 'gfx_repair_templates';
    templateLabel.textContent = 'Detected panel templates';
    const templates = document.createElement('textarea');
    templates.id = 'gfx_repair_templates';
    templates.classList.add('text_pole');
    templates.readOnly = true;
    content.append(templateLabel, templates);

    drawer.append(toggle, content);
    container.append(drawer);
    updateSettingsStatus();
}

function registerEventHandlers() {
    const events = context.eventTypes;
    const source = context.eventSource;

    const guarded = (label, handler) => (...args) => {
        try {
            handler(...args);
        } catch (error) {
            // A repair failure must never break chat rendering.
            console.error(`[GFX Repair] ${label} failed:`, error);
        }
    };

    source.on(events.CHARACTER_MESSAGE_RENDERED, guarded('render repair', (messageId) => {
        repairRenderedMessage(messageId);
        annotateRenderedPanels();
    }));
    source.on(events.MESSAGE_UPDATED, guarded('message update repair', (messageId) => {
        repairRenderedMessage(messageId);
        annotateRenderedPanels();
    }));
    source.on(events.MESSAGE_SWIPED, guarded('swipe repair', (messageId) => {
        repairRenderedMessage(messageId);
        annotateRenderedPanels();
    }));
    source.on(events.CHAT_CHANGED, guarded('chat change sweep', () => {
        sessionRepairCount = 0;
        // Messages may still be rendering; run after the current task.
        setTimeout(guarded('chat change sweep (deferred)', sweepRenderedChat), 100);
    }));
    source.on(events.CHAT_LOADED, guarded('chat load sweep', () => {
        setTimeout(guarded('chat load sweep (deferred)', sweepRenderedChat), 100);
    }));
    source.on(events.MORE_MESSAGES_LOADED, guarded('history sweep', () => {
        sweepRenderedChat();
    }));

    const refreshForPreset = guarded('preset refresh', () => {
        setTimeout(guarded('preset refresh (deferred)', refreshTemplateRegistry), 50);
    });
    source.on(events.MORE_MESSAGES_LOADED, guarded('history sweep', () => {
        sweepRenderedChat();
    }));

    source.on(events.PRESET_CHANGED, refreshForPreset);
    source.on(events.OAI_PRESET_CHANGED_AFTER, refreshForPreset);
    source.on(events.APP_READY, guarded('settings ui', addSettingsUi));
}

function initializeExtension() {
    if (globalThis.__gfxDetailsRepairLoaded) {
        return;
    }
    globalThis.__gfxDetailsRepairLoaded = true;

    initializeSettings();
    registerEventHandlers();
    addSettingsUi();
    refreshTemplateRegistry();
    console.info(`[GFX Repair] Loaded v${EXTENSION_VERSION} with ${registry.roots.length} learned template(s).`);
}

initializeExtension();
