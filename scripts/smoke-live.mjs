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
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
});

socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
        pending.get(message.id).resolve(message.result);
        pending.delete(message.id);
        return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
        events.push({ type: 'exception', text: message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text });
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        events.push({ type: 'consoleError', text: message.params.entry.text, url: message.params.entry.url });
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
        const ctx = globalThis.SillyTavern?.getContext?.() ?? null;
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        // Count panels currently rendered in the chat DOM.
        const panels = [...document.querySelectorAll('#chat .mes_text details')];
        const repairedPanels = [...document.querySelectorAll('#chat .mes_text details[data-gfx-repair-panel="true"]')];
        // Live toggle check on the first panel if present.
        const outer = panels[0] ?? null;
        const outerSummary = outer ? [...outer.children].find((el) => el.tagName === 'SUMMARY') : null;
        const initiallyClosed = outer ? !outer.open : false;
        outerSummary?.click();
        const openedAfterClick = Boolean(outer?.open);
        outerSummary?.click();
        const closedAfterSecondClick = outer ? !outer.open : false;
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
            chatArrayLength: chat.length,
            detailsPanels: panels.length,
            repairedPanels: repairedPanels.length,
            toggleSmoke: { initiallyClosed, openedAfterClick, closedAfterSecondClick },
        };
    })()`,
    returnByValue: true,
    awaitPromise: true,
});

const browserErrors = events
    .filter((event) => event.type === 'consoleError')
    .map((event) => ({ text: event.text, url: event.url }));
const runtimeExceptions = events
    .filter((event) => event.type === 'exception')
    .map((event) => event.text);

const report = {
    page: evaluation.result.value,
    browserErrors,
    runtimeExceptions,
};
console.log(JSON.stringify(report, null, 2));
socket.close();

const extensionErrors = browserErrors.filter((error) => /GFX Repair|SillyTavern-GFX-Repair|repair-engine/i.test(error.text));
const toggleFailed = !report.page.toggleSmoke.initiallyClosed
    || !report.page.toggleSmoke.openedAfterClick
    || !report.page.toggleSmoke.closedAfterSecondClick;
if (!report.page.extensionLoaded
    || !report.page.drawerPresent
    || toggleFailed
    || extensionErrors.length
    || runtimeExceptions.length) {
    process.exitCode = 1;
}
