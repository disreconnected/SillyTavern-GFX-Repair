const debugPort = Number(process.argv[2] || 9223);
const appUrl = process.argv[3] || 'http://127.0.0.1:8000';

const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === 'page');
if (!page) {
    throw new Error(`No page target found on Chrome debugging port ${debugPort}.`);
}

const events = [];
const pending = new Map();
let sequence = 0;
const socket = new WebSocket(page.webSocketDebuggerUrl);

await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});

socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
        const operation = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
            operation.reject(new Error(message.error.message));
        } else {
            operation.resolve(message.result);
        }
        return;
    }
    if (message.method) {
        events.push(message);
    }
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.navigate', { url: appUrl });
await new Promise((resolve) => setTimeout(resolve, 12_000));

const evaluation = await send('Runtime.evaluate', {
    expression: `(() => {
        const sample = [
            'Narrative.',
            '<!-- GFX_START -->',
            '🎬 INTERNAL STATES (Turn: 99)👤 NPC AGENDAS - Test NPC | Agenda: Verify repair',
            '📜 QUESTS - Main | Objective: Complete smoke test',
            "📓 GM'S NOTEBOOK - [D] Live formatter assertion",
            '🎲 DND TASK SIM - Task: Toggle panels',
            '🌌 PHYSICS, ENGINE & WORLD - Env: Browser',
            '- Physics: Synthetic message',
            '<!-- GFX_END -->',
        ].join('\\n');
        const formatter = globalThis.SillyTavern?.getContext()?.messageFormatter;
        const formatted = formatter?.format(sample, 'GFX Repair Test', false, false, -1) || '';
        const host = document.createElement('div');
        host.hidden = true;
        host.innerHTML = formatted;
        document.body.append(host);
        const panels = [...host.querySelectorAll('details')];
        const outer = panels[0];
        const outerSummary = outer ? [...outer.children].find((element) => element.tagName === 'SUMMARY') : null;
        const initiallyClosed = outer ? !outer.open : false;
        outerSummary?.click();
        const openedAfterClick = Boolean(outer?.open);
        outerSummary?.click();
        const closedAfterSecondClick = outer ? !outer.open : false;
        const formatterSmoke = {
            panelCount: panels.length,
            styledPanelCount: panels.filter((panel) => panel.hasAttribute('style')).length,
            annotatedPanelCount: panels.filter((panel) => panel.dataset.gfxRepairPanel === 'true').length,
            labels: panels.map((panel) => [...panel.children].find((element) => element.tagName === 'SUMMARY')?.textContent?.trim()),
            initiallyClosed,
            openedAfterClick,
            closedAfterSecondClick,
        };
        host.remove();
        return {
            title: document.title,
            readyState: document.readyState,
            url: location.href,
            extensionLoaded: Boolean(globalThis.__gfxDetailsRepairLoaded),
            drawerPresent: Boolean(document.getElementById('gfx_repair_status')),
            status: document.getElementById('gfx_repair_status')?.textContent || null,
            detectedTemplates: document.getElementById('gfx_repair_templates')?.value || null,
            extensionScript: [...document.scripts].some((script) => script.src.includes('SillyTavern-GFX-Repair/index.js')),
            chatMessages: document.querySelectorAll('#chat .mes').length,
            detailsPanels: document.querySelectorAll('#chat details').length,
            repairedPanels: document.querySelectorAll('#chat details[data-gfx-repair-panel="true"]').length,
            formatterSmoke,
        };
    })()`,
    returnByValue: true,
    awaitPromise: true,
});

const browserErrors = events
    .filter((event) => event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error')
    .map((event) => ({
        source: event.params.entry.source,
        text: event.params.entry.text,
    }));
const runtimeExceptions = events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params?.exceptionDetails?.text || 'Unknown runtime exception');

const report = {
    page: evaluation.result.value,
    browserErrors,
    runtimeExceptions,
};
console.log(JSON.stringify(report, null, 2));
socket.close();

const extensionErrors = browserErrors.filter((error) => /GFX Repair|SillyTavern-GFX-Repair|repair-engine/i.test(error.text));
const formatterFailed = report.page.formatterSmoke.panelCount !== 6
    || !report.page.formatterSmoke.initiallyClosed
    || !report.page.formatterSmoke.openedAfterClick
    || !report.page.formatterSmoke.closedAfterSecondClick;
if (!report.page.extensionLoaded
    || !report.page.drawerPresent
    || formatterFailed
    || extensionErrors.length
    || runtimeExceptions.length) {
    process.exitCode = 1;
}
