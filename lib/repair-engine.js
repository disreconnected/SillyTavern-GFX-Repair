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

function buildLabelPattern(label, { stripPrefix = true, lazyPlaceholders = false } = {}) {
    let core = cleanHeading(label);
    if (stripPrefix) {
        core = stripDecorativePrefix(core);
    }
    core = core.replace(PLACEHOLDER_RE, '\uE000');

    let pattern = escapeRegExp(core)
        .replace(/\d+/g, '\\d+')
        .replaceAll('\uE000', lazyPlaceholders ? '[^\\r\\n<>]{1,100}?' : '[^\\r\\n<>]{1,100}')
        .replace(/ +/g, '\\s+');
    return pattern;
}

function buildLabelRegex(label) {
    const pattern = buildLabelPattern(label);
    return new RegExp(`^${pattern}\\s*:?\\s*$`, 'iu');
}

function matchesTemplateLabel(candidate, label) {
    const value = stripDecorativePrefix(cleanHeading(candidate));
    return buildLabelRegex(label).test(value);
}

function buildLabelSearchRegexes(label) {
    const variants = [cleanHeading(label), stripDecorativePrefix(cleanHeading(label))]
        .filter((value, index, values) => value && values.indexOf(value) === index);
    return variants.map((variant) => new RegExp(
        `${buildLabelPattern(variant, { stripPrefix: false, lazyPlaceholders: true })}[ \\t]*:?(?=$|[^\\p{L}\\p{N}])`,
        'giu',
    ));
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
    // Optional templates are often discovered as separate roots even when the
    // preset places their headings inside a larger hierarchical panel.
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

function collectTemplateLabels(registry) {
    const labels = [];
    const seen = new Set();
    const visit = (node) => {
        const label = cleanHeading(node.label);
        const key = normalizedLabel(label);
        if (label && !seen.has(key)) {
            seen.add(key);
            labels.push(label);
        }
        for (const child of node.children ?? []) {
            visit(child);
        }
    };

    for (const { root } of registry.roots) {
        visit(root);
    }
    return labels.sort((a, b) => b.length - a.length);
}

function findTemplateLabelMatches(source, labels, rangeStart = 0, rangeEnd = source.length) {
    const matches = [];
    for (const label of labels) {
        for (const regex of buildLabelSearchRegexes(label)) {
            regex.lastIndex = rangeStart;
            let match;
            while ((match = regex.exec(source)) !== null) {
                if (match.index >= rangeEnd) {
                    break;
                }
                const end = match.index + match[0].length;
                if (end <= rangeEnd) {
                    matches.push({
                        start: match.index,
                        end,
                        label,
                    });
                }
                if (match[0].length === 0) {
                    regex.lastIndex++;
                }
            }
        }
    }

    matches.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
    const accepted = [];
    for (const match of matches) {
        if (accepted.at(-1)?.end > match.start) {
            continue;
        }
        accepted.push(match);
    }
    return accepted;
}

function findGfxRegionAt(source, offset) {
    const regex = new RegExp(`${GFX_START_RE.source}|${GFX_END_RE.source}`, 'gi');
    let open = null;
    let match;
    while ((match = regex.exec(source)) !== null) {
        if (/GFX_START/i.test(match[0])) {
            if (open === null) {
                open = {
                    start: match.index + match[0].length,
                    end: source.length,
                };
            }
            continue;
        }

        if (open !== null) {
            if (offset >= open.start && offset <= match.index) {
                return { ...open, end: match.index };
            }
            open = null;
        }
    }

    return open !== null && offset >= open.start ? open : null;
}

function findRecoveryRegionEnd(source, start) {
    const tail = source.slice(start);
    const footer = tail.search(/(?:\r?\n)\s*(?:\[COLORS\s*:|<!--\s*GFX_END\s*-->|<\/(?!details\b|summary\b)[\w:-]*(?:module|state|tracker|tracking)[\w:-]*\s*>)/i);
    return footer < 0 ? source.length : start + footer;
}

function hasRecoveryContext(source, match, labels) {
    const regionEnd = findRecoveryRegionEnd(source, match.end);
    const tail = source.slice(match.end, regionEnd);
    const rowCount = tail.match(/(?:^|[\r\n]|[ \t])[-*]\s*[^<>\r\n]{2,100}(?::|\|)/g)?.length ?? 0;
    const childCount = findTemplateLabelMatches(tail, labels)
        .filter((candidate) => normalizedLabel(candidate.label) !== normalizedLabel(match.label)).length;
    const prefix = source.slice(Math.max(0, match.start - 300), match.start);
    const separator = /(?:^|[\r\n])\s*(?:---+|\*\*\*+|___+)\s*$/.test(prefix);
    const nearTail = match.start / Math.max(source.length, 1) >= 0.55;
    return (rowCount >= 2 || childCount > 0) && (separator || nearTail);
}

function separateLearnedHeadingBoundaries(source, registry) {
    const labels = collectTemplateLabels(registry);
    if (!labels.length) {
        return { text: source, changed: false };
    }

    const rootLabels = registry.roots.map(({ root }) => cleanHeading(root.label));
    const regions = [];
    for (const match of findTemplateLabelMatches(source, rootLabels)) {
        if (detailsDepthAt(source, match.start) > 0) {
            continue;
        }

        const gfxRegion = findGfxRegionAt(source, match.start);
        if (gfxRegion) {
            regions.push(gfxRegion);
        } else if (hasRecoveryContext(source, match, labels)) {
            regions.push({
                start: match.start,
                end: findRecoveryRegionEnd(source, match.end),
            });
        }
    }

    if (!regions.length) {
        return { text: source, changed: false };
    }

    regions.sort((a, b) => a.start - b.start || a.end - b.end);
    const mergedRegions = [];
    for (const region of regions) {
        const previous = mergedRegions.at(-1);
        if (previous && region.start <= previous.end) {
            previous.end = Math.max(previous.end, region.end);
        } else {
            mergedRegions.push({ ...region });
        }
    }

    const insertions = new Set();
    for (const region of mergedRegions) {
        for (const match of findTemplateLabelMatches(source, labels, region.start, region.end)) {
            if (detailsDepthAt(source, match.start) > 0) {
                continue;
            }
            if (match.start > region.start && !/[\r\n]/.test(source[match.start - 1])) {
                insertions.add(match.start);
            }
            if (match.end < region.end && !/[\r\n]/.test(source[match.end])) {
                insertions.add(match.end);
            }
        }
    }

    if (!insertions.size) {
        return { text: source, changed: false };
    }

    let text = source;
    for (const offset of [...insertions].sort((a, b) => b - a)) {
        text = `${text.slice(0, offset)}\n${text.slice(offset)}`;
    }
    return { text, changed: true };
}

function findDetailsRanges(source) {
    const regex = /<details\b[^>]*>|<\/details\s*>/gi;
    const stack = [];
    const ranges = [];
    let match;

    while ((match = regex.exec(source)) !== null) {
        if (/^<details/i.test(match[0])) {
            const range = {
                start: match.index,
                end: null,
                closeStart: null,
                parent: stack.at(-1) ?? null,
                summaryLabel: '',
                bodyStart: match.index + match[0].length,
            };
            stack.push(range);
            ranges.push(range);
            continue;
        }

        const range = stack.pop();
        if (range) {
            range.closeStart = match.index;
            range.end = match.index + match[0].length;
        }
    }

    for (const range of ranges) {
        if (range.closeStart === null) {
            continue;
        }
        const openingEnd = source.indexOf('>', range.start) + 1;
        const content = source.slice(openingEnd, range.closeStart);
        const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(content);
        if (summary) {
            range.summaryLabel = visibleText(summary[1]);
            range.bodyStart = openingEnd + summary.index + summary[0].length;
        } else {
            range.bodyStart = openingEnd;
        }
    }

    return ranges.filter((range) => range.closeStart !== null);
}

function findContainingElementRange(source, offset, rangeStart, rangeEnd) {
    const regex = /<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)(?:\s[^<>]*?)?>/gi;
    const stack = [];
    let target = null;
    let match;

    while ((match = regex.exec(source)) !== null) {
        if (match.index < rangeStart) {
            continue;
        }
        if (match.index >= rangeEnd) {
            break;
        }
        if (match[0].startsWith('<!--')) {
            continue;
        }

        const tag = match[1].toLowerCase();
        const closing = /^<\//.test(match[0]);
        if (match.index <= offset) {
            if (closing) {
                const index = stack.findLastIndex((element) => element.tag === tag);
                if (index >= 0) {
                    stack.splice(index, 1);
                }
            } else if (!VOID_ELEMENTS.has(tag) && !/\/\s*>$/.test(match[0])) {
                stack.push({ tag, start: match.index });
            }
            target = [...stack].reverse().find((element) => !['details', 'summary'].includes(element.tag)) ?? null;
            continue;
        }

        if (!closing) {
            if (!VOID_ELEMENTS.has(tag) && !/\/\s*>$/.test(match[0])) {
                stack.push({ tag, start: match.index });
            }
            continue;
        }

        const index = stack.findLastIndex((element) => element.tag === tag);
        if (index < 0) {
            continue;
        }
        const element = stack[index];
        stack.splice(index, 1);
        if (element === target) {
            return {
                start: element.start,
                end: match.index + match[0].length,
            };
        }
    }

    return null;
}

function findNearestDetailsRange(ranges, offset) {
    return ranges
        .filter((range) => range.start < offset && offset < range.closeStart)
        .sort((a, b) => b.start - a.start)[0] ?? null;
}

function findTemplateNode(registry, label) {
    const visit = (node) => {
        if (matchesTemplateLabel(label, node.label)) {
            return node;
        }
        for (const child of node.children ?? []) {
            const found = visit(child);
            if (found) {
                return found;
            }
        }
        return null;
    };

    for (const { root } of registry.roots) {
        const found = visit(root);
        if (found) {
            return found;
        }
    }
    return null;
}

function flattenUnexpectedNestedDetails(source, registry, actions) {
    let text = source;
    for (let attempt = 0; attempt < 8; attempt++) {
        const ranges = findDetailsRanges(text);
        const replacements = [];

        for (const parent of ranges) {
            const node = findTemplateNode(registry, parent.summaryLabel);
            if (!node || node.children.length) {
                continue;
            }

            for (const nested of ranges) {
                if (nested.parent !== parent) {
                    continue;
                }
                const body = text.slice(nested.bodyStart, nested.closeStart);
                const separator = body && !/^[\r\n]/.test(body) ? '\n' : '';
                replacements.push({
                    start: nested.start,
                    end: nested.end,
                    text: `${escapeHtmlText(nested.summaryLabel)}${separator}${body}`,
                    label: nested.summaryLabel,
                });
            }
        }

        if (!replacements.length) {
            return text;
        }

        for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
            text = text.slice(0, replacement.start)
                + replacement.text
                + text.slice(replacement.end);
            actions.push({
                type: 'flatten-unexpected-nested-details',
                confidence: 'high',
                label: replacement.label,
            });
        }
    }
    return text;
}

function isStructuralGap(value) {
    return value
        .replace(/<!--[^]*?-->|<\/?[a-z][^>]*>/gi, '')
        .trim() === '';
}

function isDetailsDescendant(range, ancestor) {
    let parent = range.parent;
    while (parent) {
        if (parent === ancestor) {
            return true;
        }
        parent = parent.parent;
    }
    return false;
}

function mergeContinuationDetails(source, registry, actions) {
    let text = source;
    for (let attempt = 0; attempt < 8; attempt++) {
        const ranges = findDetailsRanges(text);
        const roots = ranges.filter((range) => !range.parent);
        const replacements = [];

        for (let index = 1; index < roots.length; index++) {
            const previousRoot = roots[index - 1];
            const continuation = roots[index];
            if (!isStructuralGap(text.slice(previousRoot.end, continuation.start))) {
                continue;
            }

            const continuationNode = findTemplateNode(registry, continuation.summaryLabel);
            if (!continuationNode || continuationNode.children.length) {
                continue;
            }

            const leaves = ranges
                .filter((range) => isDetailsDescendant(range, previousRoot))
                .filter((range) => {
                    const node = findTemplateNode(registry, range.summaryLabel);
                    return node
                        && !node.children.length
                        && matchesTemplateLabel(continuation.summaryLabel, range.summaryLabel);
                })
                .sort((a, b) => b.start - a.start);
            const leaf = leaves[0];
            if (!leaf) {
                continue;
            }

            const body = text.slice(continuation.bodyStart, continuation.closeStart);
            const leadingSeparator = !/[\r\n]$/.test(text.slice(0, leaf.closeStart)) ? '\n' : '';
            const separator = body && !/^[\r\n]/.test(body) ? '\n' : '';
            replacements.push({
                start: leaf.closeStart,
                end: leaf.closeStart,
                text: `${leadingSeparator}${escapeHtmlText(continuation.summaryLabel)}${separator}${body}`,
                label: continuation.summaryLabel,
            });
            replacements.push({
                start: continuation.start,
                end: continuation.end,
                text: '',
                label: continuation.summaryLabel,
            });
        }

        if (!replacements.length) {
            return text;
        }

        for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
            text = text.slice(0, replacement.start)
                + replacement.text
                + text.slice(replacement.end);
            if (replacement.text) {
                actions.push({
                    type: 'merge-continuation-detail',
                    confidence: 'high',
                    label: replacement.label,
                });
            }
        }
    }
    return text;
}

function promoteLearnedSiblingPanels(source, registry, actions) {
    const ranges = findDetailsRanges(source);
    const rootLabels = registry.roots.map(({ root }) => cleanHeading(root.label));
    const groups = new Map();

    for (const match of findTemplateLabelMatches(source, rootLabels)) {
        const owner = findNearestDetailsRange(ranges, match.start);
        if (!owner) {
            continue;
        }

        let container = owner;
        let segmentStart = null;
        let segmentEnd = null;
        let existingDetails = false;
        const isOwnerSummary = normalizedLabel(owner.summaryLabel) === normalizedLabel(match.label);
        if (isOwnerSummary) {
            container = owner.parent;
            segmentStart = owner.start;
            segmentEnd = owner.end;
            existingDetails = true;
        } else {
            if (match.start < owner.bodyStart) {
                continue;
            }
            const lineStart = source.lastIndexOf('\n', match.start - 1) + 1;
            const element = findContainingElementRange(source, match.start, owner.bodyStart, owner.closeStart);
            if (element) {
                segmentStart = element.start;
                segmentEnd = element.end;
            } else if (!source.slice(lineStart, match.start).trim()) {
                segmentStart = lineStart;
            }
        }

        if (!container || segmentStart === null || segmentStart <= container.bodyStart) {
            continue;
        }

        const containerNode = findTemplateNode(registry, container.summaryLabel);
        if (!containerNode
            || normalizedLabel(container.summaryLabel) === normalizedLabel(match.label)
            || containerNode.children.some((child) => matchesTemplateLabel(match.label, child.label))) {
            continue;
        }

        let root = container;
        while (root.parent) {
            root = root.parent;
        }
        if (existingDetails && container === root) {
            continue;
        }
        const candidate = {
            match,
            container,
            root,
            segmentStart,
            segmentEnd,
            existingDetails,
            heading: visibleText(source.slice(match.start, match.end)).replace(/[ \t]*:[ \t]*$/, ''),
        };
        const candidates = groups.get(root) ?? [];
        if (!candidates.some((item) => item.segmentStart === candidate.segmentStart)) {
            candidates.push(candidate);
            groups.set(root, candidates);
        }
    }

    const replacements = [];
    for (const [root, candidates] of groups) {
        candidates.sort((a, b) => a.segmentStart - b.segmentStart);
        const selected = [];
        for (let index = 0; index < candidates.length; index++) {
            const candidate = candidates[index];
            if (candidate.segmentEnd === null) {
                candidate.segmentEnd = candidates
                    .slice(index + 1)
                    .find((next) => next.container === candidate.container)
                    ?.segmentStart ?? candidate.container.closeStart;
            }
            if (candidate.segmentEnd <= candidate.segmentStart
                || candidate.segmentStart < root.start
                || candidate.segmentEnd > root.end
                || (selected.length && candidate.segmentStart < selected.at(-1).segmentEnd)) {
                continue;
            }
            selected.push(candidate);
        }
        if (!selected.length) {
            continue;
        }

        const removals = selected.map((candidate) => ({
            start: candidate.segmentStart,
            end: candidate.segmentEnd,
        }));
        const insertions = new Map();
        for (const candidate of selected) {
            let body = source.slice(candidate.segmentStart, candidate.segmentEnd);
            if (!candidate.existingDetails) {
                const localStart = candidate.match.start - candidate.segmentStart;
                const localEnd = candidate.match.end - candidate.segmentStart;
                body = body.slice(0, localStart) + body.slice(localEnd);
                body = `<details>\n<summary>${escapeHtmlText(candidate.heading)}</summary>${body}\n</details>`;
            }
            const insertionPoint = candidate.container === root
                ? root.closeStart
                : candidate.container.end;
            const panels = insertions.get(insertionPoint) ?? [];
            panels.push({ start: candidate.segmentStart, text: body });
            insertions.set(insertionPoint, panels);
            actions.push({
                type: 'promote-learned-sibling-panel',
                confidence: 'high',
                label: candidate.heading,
            });
        }
        const positions = new Set([
            ...removals.map(({ start }) => start),
            ...insertions.keys(),
        ]);
        let replacement = '';
        let cursor = root.start;
        for (const position of [...positions].sort((a, b) => a - b)) {
            if (position < cursor || position < root.start || position > root.end) {
                continue;
            }
            replacement += source.slice(cursor, position);
            cursor = position;

            for (const removal of removals.filter(({ start }) => start === position)) {
                cursor = Math.max(cursor, removal.end);
            }

            const panels = insertions.get(position);
            if (panels?.length) {
                panels.sort((a, b) => a.start - b.start);
                if (replacement && !/[\r\n]$/.test(replacement)) {
                    replacement += '\n';
                }
                replacement += panels.map(({ text }) => text).join('\n');
                if (!/^[\r\n]/.test(source.slice(position, root.end))) {
                    replacement += '\n';
                }
            }
        }
        replacement += source.slice(cursor, root.end);
        replacements.push({
            start: root.start,
            end: root.end,
            text: replacement,
        });
    }

    if (!replacements.length) {
        return { text: source, changed: false };
    }

    let text = source;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
        text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
    }
    return { text, changed: true };
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

        const suffix = text.slice(candidate.end);
        const separator = suffix && !/^[\r\n]/.test(suffix) ? '\n' : '';
        text = text.slice(0, candidate.headingLine.start)
            + replacement
            + separator
            + suffix;
        actions.push({
            type: 'restore-learned-details',
            confidence: 'high',
            label: cleanHeading(candidate.headingLine.content),
        });
        templatesUsed.add(candidate.definition.fingerprint);
    }
    return text;
}

function repairLearnedPanelsWithBoundaryRecovery(source, registry, actions, templatesUsed) {
    const promoted = promoteLearnedSiblingPanels(source, registry, actions);
    const recovered = separateLearnedHeadingBoundaries(promoted.text, registry);
    const repaired = repairLearnedPanels(recovered.text, registry, actions, templatesUsed);
    const postPromoted = promoteLearnedSiblingPanels(repaired, registry, actions);

    if (recovered.changed) {
        actions.push({
            type: 'separate-learned-heading-boundaries',
            confidence: 'high',
        });
    }
    return postPromoted.text;
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
        text = repairLearnedPanelsWithBoundaryRecovery(text, registry, actions, templatesUsed);
        text = repairHeuristicPanel(text, actions, settings.detectionMode);
        text = balanceDetails(text, actions);
        text = promoteLearnedSiblingPanels(text, registry, actions).text;
        text = mergeContinuationDetails(text, registry, actions);
        text = flattenUnexpectedNestedDetails(text, registry, actions);
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
