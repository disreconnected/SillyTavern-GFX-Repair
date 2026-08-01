import { oai_settings } from '../../../openai.js';
import {
    discoverTemplates,
    repairMessage,
    TemplateRegistry,
} from './lib/repair-engine.js';

export default 'GfxDetailsRepair';

const EXTENSION_KEY = 'gfxDetailsRepair';
const EXTENSION_VERSION = '1.0.1';
const context = SillyTavern.getContext();

const defaultSettings = Object.freeze({
    enabled: true,
    persistRepairs: true,
    repairGfx: true,
    repairDetails: true,
    detectionMode: 'safe-hybrid',
    neutralFallback: true,
    learnedTemplates: [],
});

const registry = new TemplateRegistry();
const pendingMessageIds = new Set();
let pendingFullScan = false;
let scanTimer = null;
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

function isEligibleAssistantMessage(message) {
    return Boolean(message)
        && !message.is_user
        && !message.is_system
        && typeof message.mes === 'string';
}

function formatterRepairHook(message, formattingContext) {
    const settings = getSettings();
    if (!settings.enabled
        || formattingContext.isUser
        || formattingContext.isSystem
        || formattingContext.isReasoning) {
        return message;
    }

    return repairMessage(message, registry, currentRepairOptions()).text;
}

function isStructuredDetails(details) {
    const text = details.textContent || '';
    const rows = text.match(/(?:^|\n)\s*[-*]\s+[^:\n]{1,100}:/g) ?? [];
    return rows.length >= 3;
}

function annotateDetailsHook(html, formattingContext) {
    const settings = getSettings();
    if (!settings.enabled
        || !settings.neutralFallback
        || formattingContext.isUser
        || formattingContext.isSystem
        || formattingContext.isReasoning
        || !/<details\b/i.test(html)) {
        return html;
    }

    const template = document.createElement('template');
    template.innerHTML = html;
    for (const details of template.content.querySelectorAll('details')) {
        const summary = [...details.children].find((element) => element.tagName === 'SUMMARY');
        if (!summary) {
            continue;
        }

        if (registry.matchesLabel(summary.textContent || '') || isStructuredDetails(details)) {
            details.dataset.gfxRepairPanel = 'true';
            for (const nested of details.querySelectorAll('details')) {
                nested.dataset.gfxRepairPanel = 'true';
            }
        }
    }
    return template.innerHTML;
}

function repairStoredString(value) {
    if (typeof value !== 'string') {
        return null;
    }
    return repairMessage(value, registry, currentRepairOptions());
}

function repairStoredMessage(message, messageIndex, { mutate }) {
    if (!isEligibleAssistantMessage(message)) {
        return { changed: false, repairs: 0, warnings: 0 };
    }

    let changed = false;
    let repairs = 0;
    let warnings = 0;
    const actionTypes = new Set();

    const mainResult = repairStoredString(message.mes);
    if (mainResult?.changed) {
        changed = true;
        repairs += mainResult.actions.length;
        warnings += mainResult.warnings.length;
        mainResult.actions.forEach((action) => actionTypes.add(action.type));
        if (mutate) {
            message.mes = mainResult.text;
        }
    }

    if (Array.isArray(message.swipes)) {
        for (let index = 0; index < message.swipes.length; index++) {
            const result = repairStoredString(message.swipes[index]);
            if (!result?.changed) {
                continue;
            }
            changed = true;
            repairs += result.actions.length;
            warnings += result.warnings.length;
            result.actions.forEach((action) => actionTypes.add(action.type));
            if (mutate) {
                message.swipes[index] = result.text;
            }
        }
    }

    if (changed && mutate) {
        message.extra ??= {};
        message.extra.gfx_repair = {
            version: EXTENSION_VERSION,
            repaired_at: new Date().toISOString(),
            message_index: messageIndex,
            actions: [...actionTypes],
        };
    }

    return { changed, repairs, warnings };
}

async function scanMessages(messageIds, { mutate = false, save = false } = {}) {
    refreshTemplateRegistry();
    const chat = context.chat ?? [];
    const ids = messageIds === 'all'
        ? chat.map((_, index) => index)
        : [...new Set(messageIds)].filter((id) => Number.isInteger(id) && id >= 0 && id < chat.length);

    let changedMessages = 0;
    let repairs = 0;
    let warnings = 0;
    for (const messageId of ids) {
        const result = repairStoredMessage(chat[messageId], messageId, { mutate });
        changedMessages += Number(result.changed);
        repairs += result.repairs;
        warnings += result.warnings;
    }

    if (mutate && changedMessages > 0) {
        sessionRepairCount += changedMessages;
        refreshTemplateRegistry();
        if (save) {
            await context.saveChat();
        }
    }

    lastStatus = changedMessages
        ? `${mutate ? 'Repaired' : 'Found'} ${changedMessages} message(s), ${repairs} structural action(s), ${warnings} warning(s).`
        : `No repairable structures found in ${ids.length} checked message(s).`;
    updateSettingsStatus();
    return { changedMessages, repairs, warnings };
}

async function flushQueuedScan() {
    scanTimer = null;
    const ids = pendingFullScan ? 'all' : [...pendingMessageIds];
    pendingFullScan = false;
    pendingMessageIds.clear();
    if (!getSettings().enabled || !getSettings().persistRepairs) {
        return;
    }

    try {
        await scanMessages(ids, { mutate: true, save: true });
    } catch (error) {
        console.error('[GFX Repair] Failed to persist repairs:', error);
        lastStatus = `Repair failed: ${error?.message || error}`;
        updateSettingsStatus();
    }
}

function queueScan(messageId = null, { full = false } = {}) {
    if (full) {
        pendingFullScan = true;
    } else if (Number.isInteger(Number(messageId))) {
        pendingMessageIds.add(Number(messageId));
    }

    if (scanTimer !== null) {
        clearTimeout(scanTimer);
    }
    scanTimer = setTimeout(() => void flushQueuedScan(), 150);
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
        createCheckbox('gfx_repair_enabled', 'Enable global repair', 'enabled', async (enabled) => {
            if (enabled) {
                refreshTemplateRegistry();
                queueScan(null, { full: true });
            }
        }),
        createCheckbox('gfx_repair_persist', 'Save structural repairs into chats', 'persistRepairs'),
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

    const actions = document.createElement('div');
    actions.classList.add('gfx-repair-actions');
    actions.append(
        createButton('Preview current chat', async () => {
            const result = await scanMessages('all', { mutate: false, save: false });
            globalThis.toastr?.info(
                `${result.changedMessages} message(s) would be repaired.`,
                'GFX & Details Repair',
            );
        }),
        createButton('Repair current chat now', async () => {
            const result = await scanMessages('all', { mutate: true, save: true });
            if (result.changedMessages > 0) {
                await context.reloadCurrentChat();
            }
            globalThis.toastr?.success(
                `${result.changedMessages} message(s) repaired.`,
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

function registerFormatterHooks() {
    const formatter = context.messageFormatter;
    formatter.addHook(formatterRepairHook, {
        stage: formatter.stage.BEFORE_REGEX,
        order: formatter.order.EARLIEST,
    });
    formatter.addHook(annotateDetailsHook, {
        stage: formatter.stage.AFTER_MARKDOWN,
        order: formatter.order.LATEST,
    });
}

function registerEventHandlers() {
    const events = context.eventTypes;
    const source = context.eventSource;

    source.on(events.CHARACTER_MESSAGE_RENDERED, (messageId) => queueScan(messageId));
    source.on(events.MESSAGE_EDITED, (messageId) => queueScan(messageId));
    source.on(events.MESSAGE_UPDATED, (messageId) => queueScan(messageId));
    source.on(events.MESSAGE_SWIPED, (messageId) => queueScan(messageId));
    source.on(events.MORE_MESSAGES_LOADED, () => queueScan(null, { full: true }));
    source.on(events.CHAT_CHANGED, () => queueScan(null, { full: true }));
    source.on(events.CHAT_LOADED, () => queueScan(null, { full: true }));

    const refreshForPreset = () => {
        setTimeout(() => {
            refreshTemplateRegistry();
            queueScan(null, { full: true });
        }, 50);
    };
    source.on(events.PRESET_CHANGED, refreshForPreset);
    source.on(events.OAI_PRESET_CHANGED_AFTER, refreshForPreset);
    source.on(events.APP_READY, addSettingsUi);
}

function initializeExtension() {
    if (globalThis.__gfxDetailsRepairLoaded) {
        return;
    }
    globalThis.__gfxDetailsRepairLoaded = true;

    initializeSettings();
    refreshTemplateRegistry();
    registerFormatterHooks();
    registerEventHandlers();
    addSettingsUi();
    queueScan(null, { full: true });
    console.info(`[GFX Repair] Loaded v${EXTENSION_VERSION} with ${registry.roots.length} learned template(s).`);
}

initializeExtension();
