/**
 * Pure helpers for GitHub Copilot style configuration under `.github/`.
 *
 * No Harness imports live here: this module is the single source of truth for
 * classification, frontmatter parsing, markdown block/inline parsing, link
 * resolution, and `dsh-resource://` file addresses. The Host scanner, the HTTP
 * API, the agent tool, and the self-check all build on it.
 *
 * @module dsh-plugin-copilot-config/lib/copilot
 */

/** Directory that carries the Copilot configuration. */
export const GITHUB_DIR = '.github';

/** Repository-wide instructions file VS Code Copilot reads. */
export const MAIN_INSTRUCTIONS_FILE = 'copilot-instructions.md';

/** Directory that carries Copilot Agent Skills. */
export const SKILLS_DIR = 'skills';

/** File every Agent Skill directory must carry. */
export const SKILL_FILE = 'skill.md';

/** The `SKILL.md` of one Agent Skill, relative to `.github/`. */
const SKILL_FILE_PATTERN = new RegExp(`^${SKILLS_DIR}/[^/]+/${SKILL_FILE.replace(/\./g, '\\.')}$`, 'i');

/** Everything else an Agent Skill directory may carry. */
const SKILLS_PREFIX_PATTERN = new RegExp(`^${SKILLS_DIR}/`, 'i');

/** Recognized Copilot configuration kinds, in display order. */
export const COPILOT_KINDS = ['instructions', 'instruction', 'prompt', 'skill', 'chatmode', 'agent', 'other'];

/** Kinds a user can bring into a conversation with `/` in the Web GUI. */
export const INVOCABLE_KINDS = ['prompt', 'skill', 'chatmode', 'agent'];

/** Maximum bytes read from one configuration file. */
export const MAX_FILE_BYTES = 256 * 1024;

/** Maximum bytes of one configuration body inlined into a conversation. */
export const MAX_REFERENCE_BYTES = 64 * 1024;

/**
 * Classify one repository-relative path.
 *
 * @param {string} relativePath - path using `/` separators, relative to the project root
 * @returns {'instructions'|'instruction'|'prompt'|'skill'|'chatmode'|'agent'|'other'|undefined}
 *   the kind, or `undefined` when the path is not Copilot markdown configuration
 */
export function classifyCopilotPath(relativePath) {
  const normalized = String(relativePath ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (!normalized.startsWith(`${GITHUB_DIR}/`)) return undefined;
  const rest = normalized.slice(GITHUB_DIR.length + 1);
  if (rest === '') return undefined;
  const lower = rest.toLowerCase();
  if (lower === MAIN_INSTRUCTIONS_FILE) return 'instructions';
  if (lower.endsWith('.instructions.md')) return 'instruction';
  if (lower.endsWith('.prompt.md')) return 'prompt';
  if (isSkillFilePath(rest)) return 'skill';
  if (lower.endsWith('.chatmode.md')) return 'chatmode';
  if (lower.endsWith('.agent.md')) return 'agent';
  if (lower.endsWith('.md')) return 'other';
  return undefined;
}

/**
 * Whether a `.github`-relative path is the `SKILL.md` of an Agent Skill.
 *
 * @param {string} rest - path relative to `.github/`, original spelling
 * @returns {boolean}
 */
function isSkillFilePath(rest) {
  return SKILL_FILE_PATTERN.test(rest);
}

/**
 * Whether a `.github`-relative path is bundled payload of an Agent Skill
 * (`scripts/`, `references/`, `assets/`, `templates/`, licenses) rather than
 * Copilot configuration of its own.
 *
 * @param {string} relativePath - path using `/` separators, relative to the project root
 * @returns {boolean}
 */
export function isSkillResource(relativePath) {
  const normalized = String(relativePath ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (!normalized.startsWith(`${GITHUB_DIR}/`)) return false;
  const rest = normalized.slice(GITHUB_DIR.length + 1);
  if (!SKILLS_PREFIX_PATTERN.test(rest)) return false;
  return !isSkillFilePath(rest);
}

/**
 * Parse a leading YAML-ish frontmatter block.
 *
 * Copilot files use a flat `key: value` block; this parser stays deliberately
 * small and never evaluates YAML.
 *
 * @param {string} text - raw file content
 * @returns {{ data: Record<string, string>, body: string }}
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '');
  if (!/^---\r?\n/.test(source)) return { data: {}, body: source };
  const closing = source.indexOf('\n---');
  if (closing === -1) return { data: {}, body: source };
  const raw = source.slice(source.indexOf('\n') + 1, closing);
  const after = source.indexOf('\n', closing + 1);
  const body = after === -1 ? '' : source.slice(after + 1);
  const data = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2].trim();
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    data[match[1]] = value;
  }
  return { data, body };
}

/**
 * Derive a display title for one configuration file.
 *
 * @param {string} relativePath - repository-relative path
 * @param {Record<string, string>} data - parsed frontmatter
 * @param {string} body - content after the frontmatter
 * @returns {string}
 */
export function deriveTitle(relativePath, data, body) {
  const name = typeof data?.name === 'string' ? data.name.trim() : '';
  if (name !== '') return name;
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(String(body ?? ''));
  if (heading !== null && heading[1].trim() !== '') return heading[1].trim();
  const base = String(relativePath).split('/').pop() ?? relativePath;
  return base.replace(/\.md$/i, '').replace(/\.(prompt|chatmode|instructions|agent)$/i, '');
}

/**
 * Split a link target into its path and anchor parts.
 *
 * @param {string} target - raw markdown link target
 * @returns {{ path: string, anchor: string }}
 */
export function splitTarget(target) {
  const raw = String(target ?? '');
  let cut = raw.length;
  const hash = raw.indexOf('#');
  const query = raw.indexOf('?');
  if (hash !== -1) cut = Math.min(cut, hash);
  if (query !== -1) cut = Math.min(cut, query);
  return { path: raw.slice(0, cut), anchor: hash === -1 ? '' : raw.slice(hash) };
}

/**
 * Whether a link target leaves the workspace.
 *
 * @param {string} target - raw markdown link target
 * @returns {boolean}
 */
export function isExternalTarget(target) {
  const raw = String(target ?? '').trim();
  if (raw === '' || raw.startsWith('#')) return true;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) || raw.startsWith('//');
}

/**
 * Resolve a link target against the file that contains it.
 *
 * @param {string} fromFile - repository-relative path of the containing file
 * @param {string} targetPath - link target with anchor/query already removed
 * @returns {string} normalized repository-relative path
 */
export function resolveLinkPath(fromFile, targetPath) {
  const raw = String(targetPath ?? '').replace(/\\/g, '/');
  if (raw.startsWith('/')) return raw.replace(/^\/+/, '');
  const segments = String(fromFile ?? '').replace(/\\/g, '/').split('/');
  segments.pop();
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Build the `dsh-resource://` address of a workspace file.
 *
 * Mirrors `sessionFileAddress` from `@deepseek-ai/dsh-client-ui-sidebar-files`
 * so a link opened by this plugin lands in the same Document preview the Files
 * tab uses.
 *
 * @param {string} sessionId - Session the path is read in
 * @param {string} path - absolute or workspace-relative path
 * @returns {string}
 */
export function buildFileAddress(sessionId, path) {
  const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':');
  const encodePath = (value) => value.split('/').map(encodeSegment).join('/');
  const normalized = String(path ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  return `dsh-resource://file/session/${encodeSegment(String(sessionId ?? ''))}/${encodePath(normalized)}`;
}

/**
 * Parse inline markdown into spans.
 *
 * @param {string} text - one line or paragraph of markdown
 * @returns {Array<Record<string, string>>} spans of `text`, `code`, `strong`,
 *   `em`, `link`, or `image`
 */
export function parseInline(text) {
  const source = String(text ?? '');
  const spans = [];
  let buffer = '';
  let index = 0;
  const flush = () => {
    if (buffer !== '') {
      spans.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };
  const patterns = [
    [/^`([^`]+)`/, (match) => ({ type: 'code', text: match[1] })],
    [/^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/, (match) => ({ type: 'image', text: match[1], href: match[2] })],
    [/^\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/, (match) => ({ type: 'link', text: match[1] === '' ? match[2] : match[1], href: match[2] })],
    [/^<((?:https?|mailto):[^>\s]+)>/, (match) => ({ type: 'link', text: match[1], href: match[1] })],
    [/^(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/, (match) => ({ type: 'link', text: match[1], href: match[1] })],
    [/^\*\*([^*]+)\*\*/, (match) => ({ type: 'strong', text: match[1] })],
    [/^__([^_]+)__/, (match) => ({ type: 'strong', text: match[1] })],
    [/^\*([^*\n]+)\*/, (match) => ({ type: 'em', text: match[1] })],
    [/^_([^_\n]+)_/, (match) => ({ type: 'em', text: match[1] })],
  ];
  while (index < source.length) {
    const rest = source.slice(index);
    let matched = false;
    for (const [pattern, build] of patterns) {
      const match = pattern.exec(rest);
      if (match === null) continue;
      flush();
      spans.push(build(match));
      index += match[0].length;
      matched = true;
      break;
    }
    if (matched) continue;
    buffer += source[index];
    index += 1;
  }
  flush();
  return spans;
}

/**
 * Parse markdown into renderable blocks.
 *
 * @param {string} text - markdown source
 * @returns {Array<Record<string, unknown>>} `heading`, `paragraph`, `list`,
 *   `code`, `quote`, or `hr` blocks
 */
export function markdownToBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', spans: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const flushList = () => {
    if (list === null) return;
    blocks.push(list);
    list = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#-]*)\s*$/.exec(line);
    if (fence !== null) {
      flushParagraph();
      flushList();
      const closer = new RegExp(`^\\s{0,3}${fence[1][0] === '`' ? '`' : '~'}{3,}\\s*$`);
      const body = [];
      index += 1;
      while (index < lines.length && !closer.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: heading[1].length, spans: parseInline(heading[2]) });
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'hr' });
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote !== null) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'quote', spans: parseInline(quote[1]) });
      continue;
    }
    const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line);
    if (bullet !== null || ordered !== null) {
      flushParagraph();
      const item = (bullet ?? ordered)[1];
      if (list === null || list.ordered !== (ordered !== null)) {
        flushList();
        list = { type: 'list', ordered: ordered !== null, items: [] };
      }
      list.items.push({ spans: parseInline(item) });
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/**
 * Collect the file links of rendered blocks.
 *
 * @param {Array<Record<string, unknown>>} blocks - blocks from {@link markdownToBlocks}
 * @param {string} fromFile - repository-relative path of the containing file
 * @returns {Array<{ text: string, target: string, path: string, anchor: string, external: boolean }>}
 */
export function extractFileLinks(blocks, fromFile) {
  const links = [];
  const seen = new Set();
  const visit = (spans) => {
    if (!Array.isArray(spans)) return;
    for (const span of spans) {
      if (span?.type !== 'link' && span?.type !== 'image') continue;
      const target = String(span.href ?? '');
      if (target === '') continue;
      const { path, anchor } = splitTarget(target);
      const external = isExternalTarget(target);
      const resolved = external ? '' : resolveLinkPath(fromFile, path);
      const key = external ? `external:${target}` : `file:${resolved}${anchor}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        text: String(span.text ?? target),
        target,
        path: resolved,
        anchor,
        external,
      });
    }
  };
  for (const block of blocks ?? []) {
    if (block?.type === 'list') {
      for (const item of block.items ?? []) visit(item.spans);
      continue;
    }
    visit(block?.spans);
  }
  return links;
}

/**
 * Render blocks back to plain text for a prompt section.
 *
 * @param {Array<Record<string, unknown>>} blocks - blocks from {@link markdownToBlocks}
 * @param {number} [maxBytes] - truncate the rendered text to this many bytes
 * @returns {string}
 */
export function renderPlainText(blocks, maxBytes) {
  const parts = [];
  for (const block of blocks ?? []) {
    switch (block?.type) {
      case 'heading':
        parts.push(`${'#'.repeat(Number(block.level) || 1)} ${spanText(block.spans)}`);
        break;
      case 'paragraph':
        parts.push(spanText(block.spans));
        break;
      case 'quote':
        parts.push(`> ${spanText(block.spans)}`);
        break;
      case 'list': {
        const items = (block.items ?? []).map((item, position) => {
          const marker = block.ordered === true ? `${position + 1}.` : '-';
          return `${marker} ${spanText(item.spans)}`;
        });
        parts.push(items.join('\n'));
        break;
      }
      case 'code':
        parts.push(`\`\`\`${String(block.lang ?? '')}\n${String(block.text ?? '')}\n\`\`\``);
        break;
      case 'hr':
        parts.push('---');
        break;
      default:
        break;
    }
  }
  let text = parts.join('\n\n');
  const limit = Number(maxBytes);
  if (Number.isFinite(limit) && limit > 0 && Buffer.byteLength(text, 'utf8') > limit) {
    const raw = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8');
    text = `${raw}\n… [truncated]`;
  }
  return text;
}

/**
 * Flatten spans to text.
 *
 * @param {Array<Record<string, string>>} spans - inline spans
 * @returns {string}
 */
export function spanText(spans) {
  if (!Array.isArray(spans)) return '';
  return spans.map((span) => {
    if (span?.type === 'image') return span.text ?? '';
    if (span?.type === 'link') return `${span.text ?? ''} (${span.href ?? ''})`;
    return span?.text ?? '';
  }).join('');
}

/**
 * Describe one configuration entry for lists and prompts.
 *
 * @param {string} relativePath - repository-relative path
 * @param {string} kind - kind from {@link classifyCopilotPath}
 * @param {Record<string, string>} data - parsed frontmatter
 * @param {string} body - content after the frontmatter
 * @returns {{ title: string, description: string, applyTo: string, mode: string, invoke: string }}
 */
export function describeEntry(relativePath, kind, data, body) {
  const title = deriveTitle(relativePath, data, body);
  const description = typeof data?.description === 'string' ? data.description.trim() : '';
  const applyTo = typeof data?.applyTo === 'string' ? data.applyTo.trim() : '';
  const mode = typeof data?.mode === 'string' ? data.mode.trim() : '';
  const invoke = INVOCABLE_KINDS.includes(kind) ? deriveSlug(relativePath, kind, data) : '';
  return { title, description, applyTo, mode, invoke };
}

/**
 * Derive the name a user types after `/` to bring one entry into a conversation.
 *
 * The frontmatter `name` wins when it is a single token — an Agent Skill
 * declares it — and the file name carries the rest: `review.prompt.md` is
 * `/review`, `plan.chatmode.md` is `/plan`, `skills/webapp-testing/SKILL.md`
 * is `/webapp-testing`.
 *
 * @param {string} relativePath - repository-relative path
 * @param {string} kind - kind from {@link classifyCopilotPath}
 * @param {Record<string, string>} data - parsed frontmatter
 * @returns {string} the invocation name, or `''` when none can be derived
 */
export function deriveSlug(relativePath, kind, data) {
  const named = typeof data?.name === 'string' ? data.name.trim() : '';
  if (named !== '' && !/[\s/\\]/.test(named)) return named;
  const segments = String(relativePath ?? '').replace(/\\/g, '/').split('/');
  const base = segments.pop() ?? '';
  if (kind === 'skill') {
    const directory = segments.pop() ?? '';
    if (directory !== '') return directory;
  }
  return base.replace(/\.md$/i, '').replace(/\.(prompt|chatmode|instructions|agent)$/i, '');
}

/**
 * The model-facing wrapper tag of one invocable entry.
 *
 * Prompts and Agent Skills are instruction bundles; chat modes and custom
 * agents are personas. Both shapes carry the same `name` and `path`
 * attributes, so the model can always name the file it is following.
 *
 * @param {string} kind - kind from {@link classifyCopilotPath}
 * @returns {'copilot_skill'|'copilot_agent'}
 */
export function copilotReferenceTag(kind) {
  return kind === 'chatmode' || kind === 'agent' ? 'copilot_agent' : 'copilot_skill';
}

/**
 * Escape one attribute value for the model-facing wrapper.
 *
 * @param {string} value - raw attribute value
 * @returns {string}
 */
function escapeAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render one invocable entry as the block a conversation message carries.
 *
 * The body is the file's own markdown, so the model reads the instructions it
 * was handed instead of guessing a path. An oversized body is cut at
 * {@link MAX_REFERENCE_BYTES} with a visible marker that names the tool that
 * reads the rest — never a silent downgrade.
 *
 * @param {object} entry
 * @param {string} entry.kind - kind from {@link classifyCopilotPath}
 * @param {string} entry.name - invocation name
 * @param {string} entry.path - repository-relative path
 * @param {string} entry.text - file body as plain text
 * @param {number} [entry.maxBytes] - body byte bound
 * @returns {string} the complete `<copilot_skill>` / `<copilot_agent>` block
 */
export function buildCopilotReference(entry) {
  const tag = copilotReferenceTag(entry.kind);
  const limit = Number(entry.maxBytes);
  const bound = Number.isFinite(limit) && limit > 0 ? limit : MAX_REFERENCE_BYTES;
  let body = String(entry.text ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  let truncated = false;
  if (Buffer.byteLength(body, 'utf8') > bound) {
    body = Buffer.from(body, 'utf8').subarray(0, bound).toString('utf8');
    truncated = true;
  }
  const lines = [`<${tag} name="${escapeAttribute(entry.name)}" path="${escapeAttribute(entry.path)}">`];
  if (body !== '') lines.push(body);
  if (truncated) lines.push('… [truncated — read the rest with the `copilot_config` tool]');
  lines.push(`</${tag}>`);
  return lines.join('\n');
}
