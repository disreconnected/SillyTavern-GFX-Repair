const GFX_START_RE = /<!--\s*GFX_START\s*-->/gi;
const GFX_END_RE = /<!--\s*GFX_END\s*-->/gi;
const STRUCTURAL_FENCE_RE = /```(?:html|xml)?[ \t]*\r?\n?([\s\S]*?)```/gi;
const DETAILS_TOKEN_RE = /<\/?details\b[^>]*>|<\/?summary\b[^>]*>|<!--\s*GFX_END\s*-->/gi;
const TEMPLATE_SCAN_RE = /<details\b[^>]*>|<\/details\s*>|<summary\b[^>]*>[\s\S]*?<\/summary\s*>/gi;
const PLACEHOLDER_RE = /\{\{[^{}]+\}\}|\[[^\[\]\r\n]+\]/g;
const FIELD_ROW_RE = /^\s*[-*]\s+(?:<b[^>]*>)?[\p{L}\p{N}_][^:\r\n]{0,100}:/u;
const FOOTER_RE = /^\s*(?:\[COLORS\s*:|<!--\s*GFX_END\s*-->|<\/(?!details\b|summary\b)[\w:-]*(?:module|state|tracker|tracking)[\w:-]*\s*>)/i;

const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * @typedef {Object} TemplateNode
 * @property {string} label
 * @property {TemplateNode[]} children
 */

/**
 * @typedef {Object} TemplateDefinition
 * @property {string} fingerprint
 * @property {TemplateNode} root
 * @property {string} source
 */

/**
 * @typedef {Object} RepairAction
 * @property {string} type
 * @property {'high'|'medium'|'low'} confidence
 * @property {string} [label]
 * @property {string} [detail]
 */

/**
 * @typedef {Object} RepairResult
 * @property {string} text
 * @property {boolean} changed
 * @property {RepairAction[]} actions
 * @property {string[]} warnings
 * @property {string[]} templatesUsed
 */

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtmlText(value) {
    return value
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function decodeBasicEntities(value) {
    return value
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;/gi, "'");
}

function visibleText(value) {
    return decodeBasicEntities(String(value ?? '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim());
}

function cleanHeading(value) {
    let heading = visibleText(value)
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*>\s*/, '')
        .trim();

    if ((heading.startsWith('**') && heading.endsWith('**'))
        || (heading.startsWith('__') && heading.endsWith('__'))) {
        heading = heading.slice(2, -2).trim();
    }

    return heading;
}

function stripDecorativePrefix(value) {
    const match = String(value).match(/[\p{L}\p{N}]/u);
    return match ? value.slice(match.index) : value;
}

function normalizedLabel(value) {
    return stripDecorativePrefix(cleanHeading(value))
        .replace(PLACEHOLDER_RE, '*')
        .replace(/\d+/g, '*')
        .replace(/\s+/g, ' ')
        .replace(/\s*:\s*$/, '')
        .trim()
        .toLocaleLowerCase();
}

function isUsableLabel(value) {
    const label = cleanHeading(value);
    if (!label || label.length > 140 || !/[\p{L}\p{N}]/u.test(label)) {
        return false;
    }

    // Regex replacement summaries such as "$1$2$3" are styles, not templates.
    if (/^(?:\$\d+\s*)+$/.test(label)) {
        return false;
    }

    return true;
}

function cloneTemplateNode(node) {
    return {
        label: String(node.label),
        children: Array.isArray(node.children) ? node.children.map(cloneTemplateNode) : [],
    };
}

function nodeFingerprint(node) {
    return `${normalizedLabel(node.label)}(${node.children.map(nodeFingerprint).join('|')})`;
}

function countDescendants(node) {
    return node.children.reduce((total, child) => total + 1 + countDescendants(child), 0);
}

function normalizeTemplateTree(node) {
    const children = (node.children ?? [])
        .map(normalizeTemplateTree)
        .flat()
        .filter(Boolean);

    if (!isUsableLabel(node.label)) {
        return children;
    }

    return [{
        label: cleanHeading(node.label),
        children,
    }];
}

function parseDetailTrees(source) {
    /** @type {TemplateNode[]} */
    const roots = [];
    /** @type {TemplateNode[]} */
    const stack = [];
    const regex = new RegExp(TEMPLATE_SCAN_RE.source, TEMPLATE_SCAN_RE.flags);
    let match;

    while ((match = regex.exec(source)) !== null) {
        const token = match[0];
        if (/^<details\b/i.test(token)) {
            const node = { label: '', children: [] };
            if (stack.length) {
                stack.at(-1).children.push(node);
            } else {
                roots.push(node);
            }
            stack.push(node);
            continue;
        }

        if (/^<summary\b/i.test(token)) {
            if (!stack.length) {
                continue;
            }
            const content = token
                .replace(/^<summary\b[^>]*>/i, '')
                .replace(/<\/summary\s*>$/i, '');
            if (!stack.at(-1).label) {
                stack.at(-1).label = visibleText(content);
            }
            continue;
        }

        if (/^<\/details/i.test(token) && stack.length) {
            stack.pop();
        }
    }

    return roots.flatMap(normalizeTemplateTree);
}

function removeCodeExamples(source) {
    return String(source)
        .replace(/```[\s\S]*?```/g, '')
        .replace(/(`{1,2})([^\r\n]*?)\1/g, '');
}

/**
 * Extracts collapsible templates from preset prompts or valid chat messages.
 * @param {string} source
 * @param {string} [sourceName='runtime']
 * @returns {TemplateDefinition[]}
 */
export function discoverTemplates(source, sourceName = 'runtime') {
    if (typeof source !== 'string') {
        return [];
    }

    const discoverable = removeCodeExamples(source);
    if (!/<details\b/i.test(discoverable) || !/<summary\b/i.test(discoverable)) {
        return [];
    }

    const seen = new Set();
    const definitions = [];
    for (const root of parseDetailTrees(discoverable)) {
        const fingerprint = nodeFingerprint(root);
        if (!fingerprint || seen.has(fingerprint)) {
            continue;
        }
        seen.add(fingerprint);
        definitions.push({
            fingerprint,
            root,
            source: sourceName,
        });
    }
    return definitions;
}

function buildLabelRegex(label) {
    let core = stripDecorativePrefix(cleanHeading(label));
    core = core.replace(PLACEHOLDER_RE, '\uE000');

    let pattern = escapeRegExp(core)
        .replace(/\d+/g, '\\d+')
        .replaceAll('\uE000', '[^\\r\\n<>]{1,100}')
        .replace(/ +/g, '\\s+');
    return new RegExp(`^${pattern}\\s*:?\\s*$`, 'iu');
}

function matchesTemplateLabel(candidate, label) {
    const value = stripDecorativePrefix(cleanHeading(candidate));
    return buildLabelRegex(label).test(value);
}

/**
 * Deduplicated in-memory template registry.
 */
export class TemplateRegistry {
    constructor(definitions = []) {
        /** @type {Map<string, TemplateDefinition>} */
        this.definitions = new Map();
        this.addMany(definitions);
    }

    add(definition) {
        if (!definition?.root?.label) {
            return false;
        }

        const root = cloneTemplateNode(definition.root);
        const fingerprint = definition.fingerprint || nodeFingerprint(root);
        if (!fingerprint || this.definitions.has(fingerprint)) {
            return false;
        }

        this.definitions.set(fingerprint, {
            fingerprint,
            root,
            source: String(definition.source || 'runtime'),
        });
        return true;
    }

    addMany(definitions) {
        let added = 0;
        for (const definition of definitions ?? []) {
            added += Number(this.add(definition));
        }
        return added;
    }

    addFromText(source, sourceName = 'runtime') {
        return this.addMany(discoverTemplates(source, sourceName));
    }

    clear() {
        this.definitions.clear();
    }

    get roots() {
        return [...this.definitions.values()]
            .sort((a, b) => countDescendants(b.root) - countDescendants(a.root));
    }

    matchesLabel(label) {
        const visit = (node) => matchesTemplateLabel(label, node.label)
            || node.children.some(visit);
        return this.roots.some(({ root }) => visit(root));
    }

    serialize(limit = 128) {
        return this.roots.slice(0, limit).map((definition) => ({
            fingerprint: definition.fingerprint,
            root: cloneTemplateNode(definition.root),
            source: definition.source,
        }));
    }
}

function splitLines(source) {
    const lines = [];
    const regex = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
    let match;
    let offset = 0;

    while ((match = regex.exec(source)) !== null) {
        const raw = match[0];
        if (!raw) {
            break;
        }
        const content = raw.replace(/(?:\r\n|\n|\r)$/, '');
        lines.push({
            raw,
            content,
            start: offset,
            end: offset + raw.length,
        });
        offset += raw.length;
    }

    return lines;
}

function detailsDepthAt(source, offset) {
    const prefix = source.slice(0, offset);
    const tokens = prefix.match(/<\/?details\b[^>]*>/gi) ?? [];
    let depth = 0;
    for (const token of tokens) {
        depth += /^<details\b/i.test(token) ? 1 : -1;
        depth = Math.max(0, depth);
    }
    return depth;
}

function isStandaloneHeadingLine(line) {
    if (!line || /<(?:details|summary)\b/i.test(line.content)) {
        return false;
    }
    const heading = cleanHeading(line.content);
    if (!heading || heading.length < 2 || heading.length > 140) {
        return false;
    }
    return !/^\s*[-*]\s+/.test(line.content);
}

function findPanelEnd(source, lines, headingIndex) {
    const headingOffset = lines[headingIndex].start;
    const starts = [...source.matchAll(new RegExp(GFX_START_RE.source, GFX_START_RE.flags))]
        .filter((match) => match.index < headingOffset);
    const endsBefore = [...source.matchAll(new RegExp(GFX_END_RE.source, GFX_END_RE.flags))]
        .filter((match) => match.index < headingOffset);
    const lastStart = starts.at(-1)?.index ?? -1;
    const lastEnd = endsBefore.at(-1)?.index ?? -1;

    if (lastStart > lastEnd) {
        const endMatch = new RegExp(GFX_END_RE.source, GFX_END_RE.flags);
        endMatch.lastIndex = headingOffset;
        const found = endMatch.exec(source);
        if (found) {
            return found.index;
        }
    }

    for (let index = headingIndex + 1; index < lines.length; index++) {
        if (FOOTER_RE.test(lines[index].content)) {
            return lines[index].start;
        }
    }

    return source.length;
}

function directChildMatches(node, registry, source, lines, bodyStart, bodyEnd) {
    const matches = [];
    if (!node.children.length) {
        return matches;
    }

    const candidates = [...node.children];
    const candidateLabels = new Set(candidates.map((candidate) => normalizedLabel(candidate.label)));
    // Presets commonly inject optional details templates through variables.
    // Those nodes are separate roots during discovery, but are still children
    // when their standalone heading appears inside a learned hierarchical panel.
    for (const { root } of registry.roots) {
        const key = normalizedLabel(root.label);
        if (key !== normalizedLabel(node.label) && !candidateLabels.has(key)) {
            candidates.push(root);
            candidateLabels.add(key);
        }
    }

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line.start < bodyStart || line.start >= bodyEnd || !isStandaloneHeadingLine(line)) {
            continue;
        }
        if (detailsDepthAt(source, line.start) > 0) {
            continue;
        }

        const child = candidates.find((candidate) => matchesTemplateLabel(line.content, candidate.label));
        if (child) {
            matches.push({ child, line });
        }
    }
    return matches;
}

function renderTemplateNode(node, headingLine, registry, source, lines, bodyEnd) {
    const heading = cleanHeading(headingLine.content);
    const bodyStart = headingLine.end;
    const children = directChildMatches(node, registry, source, lines, bodyStart, bodyEnd);
    let cursor = bodyStart;
    let body = '';

    for (let index = 0; index < children.length; index++) {
        const current = children[index];
        const nextStart = children[index + 1]?.line.start ?? bodyEnd;
        body += source.slice(cursor, current.line.start);
        body += renderTemplateNode(current.child, current.line, registry, source, lines, nextStart);
        cursor = nextStart;
    }
    body += source.slice(cursor, bodyEnd);

    return `<details>\n<summary>${escapeHtmlText(heading)}</summary>${body}\n</details>`;
}

function findTemplateCandidate(source, registry) {
    const lines = splitLines(source);
    for (const definition of registry.roots) {
        for (let index = lines.length - 1; index >= 0; index--) {
            const line = lines[index];
            if (!isStandaloneHeadingLine(line)
                || detailsDepthAt(source, line.start) > 0
                || !matchesTemplateLabel(line.content, definition.root.label)) {
                continue;
            }

            const end = findPanelEnd(source, lines, index);
            if (end <= line.end) {
                continue;
            }

            return {
                definition,
                headingLine: line,
                lines,
                end,
            };
        }
    }
    return null;
}

function repairLearnedPanels(source, registry, actions, templatesUsed) {
    let text = source;
    for (let attempt = 0; attempt < 16; attempt++) {
        const candidate = findTemplateCandidate(text, registry);
        if (!candidate) {
            break;
        }

        const replacement = renderTemplateNode(
            candidate.definition.root,
            candidate.headingLine,
            registry,
            text,
            candidate.lines,
            candidate.end,
        );

        text = text.slice(0, candidate.headingLine.start)
            + replacement
            + text.slice(candidate.end);
        actions.push({
            type: 'restore-learned-details',
            confidence: 'high',
            label: cleanHeading(candidate.headingLine.content),
        });
        templatesUsed.add(candidate.definition.fingerprint);
    }
    return text;
}

function hasStrongBlockContext(source, lines, headingIndex, fieldCount, mode) {
    const line = lines[headingIndex];
    const position = line.start / Math.max(source.length, 1);
    const separator = lines
        .slice(Math.max(0, headingIndex - 3), headingIndex)
        .some((candidate) => /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(candidate.content));
    const prefix = source.slice(0, line.start);
    const insideGfx = (prefix.match(GFX_START_RE) ?? []).length > (prefix.match(GFX_END_RE) ?? []).length;
    const insideCustomWrapper = /<[\w:-]*(?:module|state|tracker|tracking)[\w:-]*\b[^>]*>[\s\S]*$/i.test(prefix);

    if (mode === 'aggressive') {
        return fieldCount >= 2 && (position >= 0.35 || separator || insideGfx || insideCustomWrapper);
    }

    return fieldCount >= 3 && (position >= 0.55 || separator || insideGfx || insideCustomWrapper);
}

function repairHeuristicPanel(source, actions, mode) {
    if (mode === 'template-only') {
        return source;
    }

    const lines = splitLines(source);
    for (let headingIndex = 0; headingIndex < lines.length; headingIndex++) {
        const line = lines[headingIndex];
        if (!isStandaloneHeadingLine(line) || detailsDepthAt(source, line.start) > 0) {
            continue;
        }

        const heading = cleanHeading(line.content);
        if (!heading || /[.!?]$/.test(heading)) {
            continue;
        }

        const end = findPanelEnd(source, lines, headingIndex);
        let fieldCount = 0;
        let firstContentIsField = false;
        let foundFirstContent = false;
        for (let index = headingIndex + 1; index < lines.length && lines[index].start < end; index++) {
            const content = lines[index].content.trim();
            if (!content) {
                continue;
            }
            const isField = FIELD_ROW_RE.test(lines[index].content);
            if (!foundFirstContent) {
                firstContentIsField = isField;
                foundFirstContent = true;
            }
            fieldCount += Number(isField);
        }

        if (mode !== 'aggressive' && !firstContentIsField) {
            continue;
        }
        if (!hasStrongBlockContext(source, lines, headingIndex, fieldCount, mode)) {
            continue;
        }

        const body = source.slice(line.end, end);
        const replacement = `<details>\n<summary>${escapeHtmlText(heading)}</summary>${body}\n</details>`;
        actions.push({
            type: 'restore-heuristic-details',
            confidence: mode === 'aggressive' ? 'low' : 'medium',
            label: heading,
            detail: `${fieldCount} structured rows`,
        });
        return source.slice(0, line.start) + replacement + source.slice(end);
    }

    return source;
}

function stripStructuralCodeFences(source, actions) {
    return source.replace(STRUCTURAL_FENCE_RE, (full, inner) => {
        if (!/(?:<!--\s*GFX_(?:START|END)\s*-->|<\/?(?:details|summary)\b)/i.test(inner)) {
            return full;
        }
        actions.push({
            type: 'remove-structural-code-fence',
            confidence: 'high',
        });
        return inner.trim();
    });
}

function protectRemainingCode(source) {
    const values = [];
    const protect = (value) => {
        const token = `\uE100${values.length}\uE101`;
        values.push(value);
        return token;
    };

    let text = source.replace(/```[\s\S]*?```/g, protect);
    text = text.replace(/(`{1,2})([^\r\n]*?)\1/g, protect);
    return {
        text,
        restore(value) {
            return value.replace(/\uE100(\d+)\uE101/g, (full, index) => values[Number(index)] ?? full);
        },
    };
}

function closeSummaryAtLineBreak(source, actions) {
    return source.replace(/<summary\b([^>]*)>([^<\r\n]*)(?=\r?\n)/gi, (full, attributes, title) => {
        if (!title.trim()) {
            return full;
        }
        actions.push({
            type: 'close-unclosed-summary',
            confidence: 'high',
            label: visibleText(title),
        });
        return `<summary${attributes}>${title}</summary>`;
    });
}

function balanceDetails(source, actions) {
    const text = closeSummaryAtLineBreak(source, actions);
    const regex = new RegExp(DETAILS_TOKEN_RE.source, DETAILS_TOKEN_RE.flags);
    let output = '';
    let cursor = 0;
    let detailsDepth = 0;
    let summaryOpen = false;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const token = match[0];
        output += text.slice(cursor, match.index);

        if (/^<!--\s*GFX_END/i.test(token)) {
            if (summaryOpen) {
                output += '</summary>';
                summaryOpen = false;
                actions.push({ type: 'close-summary-before-gfx-end', confidence: 'high' });
            }
            while (detailsDepth > 0) {
                output += '</details>';
                detailsDepth--;
                actions.push({ type: 'close-details-before-gfx-end', confidence: 'high' });
            }
            output += token;
        } else if (/^<details\b/i.test(token)) {
            if (summaryOpen) {
                output += '</summary>';
                summaryOpen = false;
                actions.push({ type: 'close-summary-before-details', confidence: 'high' });
            }
            output += token;
            detailsDepth++;
        } else if (/^<\/details/i.test(token)) {
            if (summaryOpen) {
                output += '</summary>';
                summaryOpen = false;
                actions.push({ type: 'close-summary-before-details-end', confidence: 'high' });
            }
            if (detailsDepth > 0) {
                output += token;
                detailsDepth--;
            } else {
                actions.push({ type: 'remove-orphan-details-end', confidence: 'high' });
            }
        } else if (/^<summary\b/i.test(token)) {
            if (detailsDepth === 0) {
                output += '<details>';
                detailsDepth++;
                actions.push({ type: 'wrap-orphan-summary', confidence: 'high' });
            }
            if (summaryOpen) {
                output += '</summary>';
                actions.push({ type: 'close-previous-summary', confidence: 'high' });
            }
            output += token;
            summaryOpen = true;
        } else if (/^<\/summary/i.test(token)) {
            if (summaryOpen) {
                output += token;
                summaryOpen = false;
            } else {
                actions.push({ type: 'remove-orphan-summary-end', confidence: 'high' });
            }
        }

        cursor = match.index + token.length;
    }

    output += text.slice(cursor);
    if (summaryOpen) {
        output += '</summary>';
        actions.push({ type: 'close-summary-at-end', confidence: 'high' });
    }
    while (detailsDepth > 0) {
        output += '</details>';
        detailsDepth--;
        actions.push({ type: 'close-details-at-end', confidence: 'high' });
    }
    return output;
}

function findBalancedElementEnd(source, startOffset) {
    const opening = /<([a-z][\w-]*)\b[^>]*>/gi;
    opening.lastIndex = startOffset;
    let openMatch;
    while ((openMatch = opening.exec(source)) !== null) {
        const tag = openMatch[1].toLowerCase();
        if (!VOID_ELEMENTS.has(tag)
            && !openMatch[0].endsWith('/>')
            && !['details', 'summary'].includes(tag)) {
            const tags = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi');
            tags.lastIndex = openMatch.index;
            let depth = 0;
            let match;
            while ((match = tags.exec(source)) !== null) {
                depth += new RegExp(`^<${tag}\\b`, 'i').test(match[0]) ? 1 : -1;
                if (depth === 0) {
                    return match.index + match[0].length;
                }
            }
            return -1;
        }
    }
    return -1;
}

function balanceGfxMarkers(source, actions, warnings) {
    const tokens = [...source.matchAll(/<!--\s*GFX_(START|END)\s*-->/gi)];
    let openStart = null;
    for (const token of tokens) {
        if (token[1].toUpperCase() === 'START') {
            openStart = token.index;
        } else if (openStart === null) {
            warnings.push('Found GFX_END without a preceding GFX_START; left unchanged.');
        } else {
            openStart = null;
        }
    }

    if (openStart === null) {
        return source;
    }

    const elementEnd = findBalancedElementEnd(source, openStart);
    if (elementEnd > openStart) {
        actions.push({ type: 'insert-gfx-end-after-html', confidence: 'high' });
        return `${source.slice(0, elementEnd)}\n<!-- GFX_END -->${source.slice(elementEnd)}`;
    }

    if (openStart / Math.max(source.length, 1) >= 0.55) {
        actions.push({ type: 'append-gfx-end', confidence: 'medium' });
        return `${source}\n<!-- GFX_END -->`;
    }

    warnings.push('Unclosed GFX_START was not repaired because its boundary was ambiguous.');
    return source;
}

function uniqueActions(actions) {
    const seen = new Set();
    return actions.filter((action) => {
        const key = JSON.stringify(action);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

/**
 * Repairs GFX and collapsible structure without changing narrative content.
 * @param {string} source
 * @param {TemplateRegistry} registry
 * @param {{repairGfx?: boolean, repairDetails?: boolean, detectionMode?: 'template-only'|'safe-hybrid'|'aggressive'}} [options]
 * @returns {RepairResult}
 */
export function repairMessage(source, registry = new TemplateRegistry(), options = {}) {
    const original = String(source ?? '');
    const settings = {
        repairGfx: options.repairGfx !== false,
        repairDetails: options.repairDetails !== false,
        detectionMode: options.detectionMode || 'safe-hybrid',
    };
    /** @type {RepairAction[]} */
    const actions = [];
    const warnings = [];
    const templatesUsed = new Set();
    let text = original;

    if (settings.repairGfx || settings.repairDetails) {
        text = stripStructuralCodeFences(text, actions);
    }

    const protectedCode = protectRemainingCode(text);
    text = protectedCode.text;

    if (settings.repairDetails) {
        text = repairLearnedPanels(text, registry, actions, templatesUsed);
        text = repairHeuristicPanel(text, actions, settings.detectionMode);
        text = balanceDetails(text, actions);
    }

    if (settings.repairGfx) {
        text = balanceGfxMarkers(text, actions, warnings);
    }

    text = protectedCode.restore(text);

    return {
        text,
        changed: text !== original,
        actions: uniqueActions(actions),
        warnings: [...new Set(warnings)],
        templatesUsed: [...templatesUsed],
    };
}
