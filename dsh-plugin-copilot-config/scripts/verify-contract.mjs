/**
 * Zero-dependency self-check for the Copilot configuration plugin.
 *
 * Covers the pure Copilot helpers, the filesystem scanner against an in-memory
 * `ctx.fs`, the HTTP API contract, the agent tool, the Host wiring through a
 * fake Cordis context, and the Client module — its static contract, its pure
 * reference helpers, and its `/` trigger source against a stubbed fetch.
 *
 *   node scripts/verify-contract.mjs
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  COPILOT_KINDS,
  INVOCABLE_KINDS,
  MAX_REFERENCE_BYTES,
  buildCopilotReference,
  buildFileAddress,
  classifyCopilotPath,
  copilotReferenceTag,
  deriveSlug,
  deriveTitle,
  describeEntry,
  extractFileLinks,
  isExternalTarget,
  isSkillResource,
  markdownToBlocks,
  parseFrontmatter,
  parseInline,
  renderPlainText,
  resolveLinkPath,
  splitTarget,
  spanText,
} from '../lib/copilot.js';
import { createCopilotScanner } from '../lib/scan.js';
import { API_PREFIX, TOKEN_HEADER, createCopilotApi } from '../lib/server.js';
import { SECTION_NAME, SECTION_TEXT, TOOL_NAME, createCopilotTool } from '../lib/tool.js';

/** Resolve a path inside this package, independent of the working directory. */
const pkgUrl = (relative) => new URL('../' + relative, import.meta.url);

let checks = 0;

function ok(condition, label) {
  assert.ok(condition, label);
  checks += 1;
}

function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks += 1;
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ *
 * lib/copilot.js
 * ------------------------------------------------------------------ */

equal(classifyCopilotPath('.github/copilot-instructions.md'), 'instructions', 'the repository instructions file is classified');
equal(classifyCopilotPath('.github/instructions/typescript.instructions.md'), 'instruction', 'a path-scoped instruction is classified');
equal(classifyCopilotPath('.github/prompts/review.prompt.md'), 'prompt', 'a prompt file is classified');
equal(classifyCopilotPath('.github/chatmodes/plan.chatmode.md'), 'chatmode', 'a chat mode is classified');
equal(classifyCopilotPath('.github/skills/webapp-testing/SKILL.md'), 'skill', 'an Agent Skill is classified');
equal(classifyCopilotPath('.github/skills/webapp-testing/skill.md'), 'skill', 'the Agent Skill file name is case-insensitive');
equal(classifyCopilotPath('README.md'), undefined, 'a repository root readme is not Copilot configuration');
equal(classifyCopilotPath('docs/style.md'), undefined, 'a file outside .github is not Copilot configuration');
equal(classifyCopilotPath('.github/dependabot.yml'), undefined, 'non-markdown files are not configuration');
equal(classifyCopilotPath('.github/PULL_REQUEST_TEMPLATE.md'), 'other', 'other .github markdown is kept as other');
equal(classifyCopilotPath('.github/instructions/deep/nested/file.instructions.md'), 'instruction', 'nested instruction files are classified');
equal(classifyCopilotPath('.github/skills/webapp-testing/references/api.md'), 'other', 'a skill resource file is not a skill entry');
equal(COPILOT_KINDS.indexOf('instructions') < COPILOT_KINDS.indexOf('other'), true, 'the repository instructions sort first');
equal(COPILOT_KINDS.indexOf('prompt') < COPILOT_KINDS.indexOf('skill'), true, 'prompts sort before Agent Skills');
equal(INVOCABLE_KINDS, ['prompt', 'skill', 'chatmode', 'agent'], 'the invocable kinds are the prompt, skill, chat mode, and agent kinds');

equal(isSkillResource('.github/skills/webapp-testing/SKILL.md'), false, 'the SKILL.md itself is not a skill resource');
equal(isSkillResource('.github/skills/webapp-testing/references/api.md'), true, 'a skill reference file is a skill resource');
equal(isSkillResource('.github/skills/webapp-testing/scripts/build.py'), true, 'a skill script is a skill resource');
equal(isSkillResource('.github/prompts/review.prompt.md'), false, 'a prompt file is never a skill resource');
equal(isSkillResource('README.md'), false, 'a file outside .github is never a skill resource');

const frontmatter = parseFrontmatter('---\ndescription: "Repo rules"\napplyTo: \'**/*.ts\'\nmode: edit\n---\n\n# Title\n\nBody text.\n');
equal(frontmatter.data.description, 'Repo rules', 'double-quoted frontmatter values are unquoted');
equal(frontmatter.data.applyTo, '**/*.ts', 'single-quoted frontmatter values are unquoted');
equal(frontmatter.data.mode, 'edit', 'plain frontmatter values are kept');
ok(frontmatter.body.startsWith('\n# Title'), 'the body starts after the closing marker');

const noFrontmatter = parseFrontmatter('# Only a heading\n');
equal(noFrontmatter.data, {}, 'content without frontmatter yields empty data');
equal(noFrontmatter.body, '# Only a heading\n', 'content without frontmatter is the body');

equal(deriveTitle('.github/prompts/review.prompt.md', { name: 'Review' }, 'x'), 'Review', 'the frontmatter name wins the title');
equal(deriveTitle('.github/prompts/review.prompt.md', {}, '# Heading\n'), 'Heading', 'the first heading is the fallback title');
equal(deriveTitle('.github/prompts/review.prompt.md', {}, 'no heading'), 'review', 'the file name is the last title fallback');

equal(splitTarget('docs/style.md#section'), { path: 'docs/style.md', anchor: '#section' }, 'anchors split from the path');
equal(splitTarget('https://example.com/a?b=c'), { path: 'https://example.com/a', anchor: '' }, 'queries split from the path');
equal(isExternalTarget('https://example.com'), true, 'http links are external');
equal(isExternalTarget('mailto:a@b.c'), true, 'mail links are external');
equal(isExternalTarget('#anchor'), true, 'anchor-only targets are not file links');
equal(isExternalTarget('docs/style.md'), false, 'relative paths are file links');
equal(isExternalTarget('/docs/style.md'), false, 'absolute workspace paths are file links');

equal(resolveLinkPath('.github/copilot-instructions.md', 'docs/style.md'), '.github/docs/style.md', 'a relative link resolves against the file directory');
equal(resolveLinkPath('.github/instructions/a.instructions.md', '../prompts/review.prompt.md'), '.github/prompts/review.prompt.md', 'parent links resolve');
equal(resolveLinkPath('.github/copilot-instructions.md', '/docs/style.md'), 'docs/style.md', 'absolute links are workspace-relative');
equal(resolveLinkPath('.github/a.md', './b.md'), '.github/b.md', 'explicit current-directory links resolve');

equal(
  buildFileAddress('session-1', '.github/copilot-instructions.md'),
  'dsh-resource://file/session/session-1/.github/copilot-instructions.md',
  'file addresses match the Files tab scheme',
);
equal(
  buildFileAddress('sess:1', 'docs/a b.md'),
  'dsh-resource://file/session/sess:1/docs/a%20b.md',
  'file addresses encode path segments',
);

const inline = parseInline('Use `pnpm` and see [the guide](docs/guide.md) plus **bold** and *em*.');
equal(inline.map((span) => span.type), ['text', 'code', 'text', 'link', 'text', 'strong', 'text', 'em', 'text'], 'inline spans are parsed in order');
equal(inline[3].href, 'docs/guide.md', 'inline links keep their target');
equal(spanText(inline), 'Use pnpm and see the guide (docs/guide.md) plus bold and em.', 'spans flatten to text');

const blocks = markdownToBlocks([
  '# Title',
  '',
  'A paragraph with a [link](docs/style.md).',
  '',
  '- one',
  '- two',
  '',
  '```ts',
  'const notALink = "[x](y.md)"',
  '```',
  '',
  '> quoted',
  '',
  '---',
].join('\n'));
equal(blocks.map((block) => block.type), ['heading', 'paragraph', 'list', 'code', 'quote', 'hr'], 'block types are recognized');
equal(blocks[0].level, 1, 'heading levels are kept');
equal(blocks[2].ordered, false, 'bullet lists are unordered');
equal(blocks[3].text, 'const notALink = "[x](y.md)"', 'fenced code keeps its raw text');

const links = extractFileLinks(blocks, '.github/copilot-instructions.md');
equal(links.length, 1, 'links inside fenced code are not collected');
equal(links[0].path, '.github/docs/style.md', 'the collected link is resolved');
equal(links[0].external, false, 'a relative link is a file link');

const withExternal = extractFileLinks(markdownToBlocks('[site](https://example.com) and [again](https://example.com)'), '.github/a.md');
equal(withExternal.length, 1, 'duplicate external links collapse');
equal(withExternal[0].external, true, 'external links are marked');

const plain = renderPlainText(markdownToBlocks('# H\n\n- a\n- b\n\n```js\nx\n```\n'), 1024);
ok(plain.includes('# H') && plain.includes('- a') && plain.includes('```js'), 'plain text keeps the document shape');
const truncated = renderPlainText(markdownToBlocks('x'.repeat(500)), 20);
ok(Buffer.byteLength(truncated, 'utf8') <= 40 && truncated.includes('[truncated]'), 'plain text honors the byte bound');

const described = describeEntry('.github/instructions/ts.instructions.md', 'instruction', { description: 'TS rules', applyTo: '**/*.ts' }, '# TS');
equal(described.title, 'TS', 'describeEntry derives a title');
equal(described.applyTo, '**/*.ts', 'describeEntry keeps applyTo');
equal(described.invoke, '', 'a path instruction is not invocable');

const describedPrompt = describeEntry('.github/prompts/review.prompt.md', 'prompt', {}, '# Review');
equal(describedPrompt.invoke, 'review', 'a prompt is invocable by its file name');

equal(deriveSlug('.github/prompts/review.prompt.md', 'prompt', {}), 'review', 'a prompt slug drops its suffix');
equal(deriveSlug('.github/chatmodes/plan.chatmode.md', 'chatmode', {}), 'plan', 'a chat mode slug drops its suffix');
equal(deriveSlug('.github/agents/reviewer.agent.md', 'agent', {}), 'reviewer', 'a custom agent slug drops its suffix');
equal(deriveSlug('.github/skills/webapp-testing/SKILL.md', 'skill', {}), 'webapp-testing', 'a skill slug is its directory name');
equal(deriveSlug('.github/skills/webapp-testing/SKILL.md', 'skill', { name: 'webapp-testing' }), 'webapp-testing', 'a declared skill name wins');
equal(deriveSlug('.github/prompts/team/review.prompt.md', 'prompt', { name: 'review' }), 'review', 'a declared prompt name wins');
equal(deriveSlug('.github/prompts/review.prompt.md', 'prompt', { name: 'two words' }), 'review', 'a multi-word name falls back to the file name');
equal(deriveSlug('.github/prompts/review.prompt.md', 'prompt', { name: 'a/b' }), 'review', 'a name with a separator falls back to the file name');
equal(deriveSlug('.github/copilot-instructions.md', 'instructions', {}), 'copilot-instructions', 'the repository instructions derive a slug too');

equal(copilotReferenceTag('prompt'), 'copilot_skill', 'a prompt is a skill-shaped reference');
equal(copilotReferenceTag('skill'), 'copilot_skill', 'an Agent Skill is a skill-shaped reference');
equal(copilotReferenceTag('chatmode'), 'copilot_agent', 'a chat mode is an agent-shaped reference');
equal(copilotReferenceTag('agent'), 'copilot_agent', 'a custom agent is an agent-shaped reference');
equal(copilotReferenceTag('instructions'), 'copilot_skill', 'anything else falls back to the skill shape');

equal(
  buildCopilotReference({ kind: 'prompt', name: 'review', path: '.github/prompts/review.prompt.md', text: '# Review\n\nList risks.' }),
  '<copilot_skill name="review" path=".github/prompts/review.prompt.md">\n# Review\n\nList risks.\n</copilot_skill>',
  'a reference block wraps the file body',
);
equal(
  buildCopilotReference({ kind: 'chatmode', name: 'plan', path: '.github/chatmodes/plan.chatmode.md', text: 'Ask first.' }),
  '<copilot_agent name="plan" path=".github/chatmodes/plan.chatmode.md">\nAsk first.\n</copilot_agent>',
  'an agent reference uses the agent tag',
);
equal(
  buildCopilotReference({ kind: 'prompt', name: 'q"uote', path: '.github/p/a&b<c.prompt.md', text: 'x' }),
  '<copilot_skill name="q&quot;uote" path=".github/p/a&amp;b&lt;c.prompt.md">\nx\n</copilot_skill>',
  'reference attributes are escaped',
);
equal(
  buildCopilotReference({ kind: 'prompt', name: 'review', path: 'p.md', text: '\n\n  body  \n\n' }),
  '<copilot_skill name="review" path="p.md">\n  body\n</copilot_skill>',
  'a reference body drops padding but keeps its indentation',
);
equal(buildCopilotReference({ kind: 'prompt', name: 'review', path: 'p.md', text: '' }),
  '<copilot_skill name="review" path="p.md">\n</copilot_skill>',
  'an empty body still renders a well-formed block');
const truncatedReference = buildCopilotReference({ kind: 'prompt', name: 'review', path: 'p.md', text: 'x'.repeat(500), maxBytes: 20 });
ok(truncatedReference.includes('[truncated'), 'an oversized body is marked as truncated');
ok(Buffer.byteLength(truncatedReference, 'utf8') < 500, 'an oversized body is cut');
ok(MAX_REFERENCE_BYTES === 64 * 1024, 'the reference byte bound is 64 KiB');

/* ------------------------------------------------------------------ *
 * lib/scan.js — in-memory filesystem
 * ------------------------------------------------------------------ */

const temp = await mkdtemp(path.join(tmpdir(), 'copilot-config-'));

function createMemoryFs(tree) {
  const posix = (value) => String(value).replace(/\\/g, '/');
  const join = (cwd, target) => {
    const base = posix(cwd).replace(/\/+$/, '');
    const rel = posix(target).replace(/^(?:\.\/)+/, '');
    return rel.startsWith('/') ? rel : `${base}/${rel}`;
  };
  const entryOf = (target) => tree.get(posix(target.displayPath));
  return {
    async resolve(target, options = {}) {
      const displayPath = join(options.cwd ?? '/', target);
      return { targetKey: displayPath, displayPath };
    },
    async stat(target) {
      const entry = entryOf(target);
      if (entry === undefined) return undefined;
      return { type: entry.type, ...(entry.type === 'file' ? { size: Buffer.byteLength(entry.content ?? '', 'utf8') } : {}) };
    },
    async readText(target) {
      const entry = entryOf(target);
      if (entry === undefined || entry.type !== 'file') throw new Error(`not a file: ${target.displayPath}`);
      return entry.content;
    },
    async listDir(target) {
      const prefix = `${posix(target.displayPath).replace(/\/+$/, '')}/`;
      const seen = new Map();
      for (const [filePath, entry] of tree) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        if (rest === '') continue;
        const name = rest.split('/')[0];
        if (seen.has(name)) continue;
        const childPath = `${prefix}${name}`;
        const child = tree.get(childPath);
        const isDirectory = child?.type === 'directory' || rest.includes('/');
        seen.set(name, {
          name,
          type: isDirectory ? 'directory' : 'file',
          target: { targetKey: childPath, displayPath: childPath },
          ...(isDirectory ? {} : { size: Buffer.byteLength(child?.content ?? '', 'utf8') }),
        });
      }
      return [...seen.values()];
    },
  };
}

const MAIN_CONTENT = [
  '---',
  'description: Repository-wide Copilot style',
  '---',
  '',
  '# Project style',
  '',
  'Follow [the TypeScript guide](instructions/typescript.instructions.md) and',
  'the [external site](https://example.com/style).',
  '',
  '```sh',
  'echo "[not](a-link.md)"',
  '```',
].join('\n');

const TS_CONTENT = [
  '---',
  'applyTo: "**/*.ts"',
  'description: TypeScript rules',
  '---',
  '',
  '# TypeScript',
  '',
  '- Prefer `const`.',
  '- See [the shared config](../shared/eslint.md).',
].join('\n');

const REVIEW_CONTENT = [
  '---',
  'description: Review a change',
  'mode: edit',
  '---',
  '',
  '# Review prompt',
  '',
  'Summarize the diff and list risks.',
].join('\n');

const PLAN_CONTENT = [
  '---',
  'description: Plan mode',
  '---',
  '',
  '# Plan mode',
  '',
  'Ask before editing.',
].join('\n');

const SKILL_CONTENT = [
  '---',
  'name: webapp-testing',
  'description: Toolkit for testing local web applications',
  '---',
  '',
  '# Webapp testing',
  '',
  'Open the app and drive it.',
].join('\n');

const AGENT_CONTENT = [
  '---',
  'description: Review a change as a custom agent',
  '---',
  '',
  '# Reviewer',
  '',
  'Read the diff, then comment.',
].join('\n');

const TREE = new Map([
  ['/work/.github', { type: 'directory' }],
  ['/work/.github/copilot-instructions.md', { type: 'file', content: MAIN_CONTENT }],
  ['/work/.github/instructions', { type: 'directory' }],
  ['/work/.github/instructions/typescript.instructions.md', { type: 'file', content: TS_CONTENT }],
  ['/work/.github/prompts', { type: 'directory' }],
  ['/work/.github/prompts/review.prompt.md', { type: 'file', content: REVIEW_CONTENT }],
  ['/work/.github/chatmodes', { type: 'directory' }],
  ['/work/.github/chatmodes/plan.chatmode.md', { type: 'file', content: PLAN_CONTENT }],
  ['/work/.github/agents', { type: 'directory' }],
  ['/work/.github/agents/reviewer.agent.md', { type: 'file', content: AGENT_CONTENT }],
  ['/work/.github/skills', { type: 'directory' }],
  ['/work/.github/skills/webapp-testing', { type: 'directory' }],
  ['/work/.github/skills/webapp-testing/SKILL.md', { type: 'file', content: SKILL_CONTENT }],
  ['/work/.github/skills/webapp-testing/references', { type: 'directory' }],
  ['/work/.github/skills/webapp-testing/references/api.md', { type: 'file', content: '# API\n\nReference payload.' }],
  ['/work/.github/skills/webapp-testing/scripts', { type: 'directory' }],
  ['/work/.github/skills/webapp-testing/scripts/build.py', { type: 'file', content: 'print("payload")' }],
  ['/work/.github/shared', { type: 'directory' }],
  ['/work/.github/shared/eslint.md', { type: 'file', content: '# Shared\n\nShared eslint notes.' }],
  ['/work/.github/PULL_REQUEST_TEMPLATE.md', { type: 'file', content: '# PR\n\nTemplate.' }],
]);

const memoryFs = createMemoryFs(TREE);
const scanLogs = [];
const scanner = createCopilotScanner({
  fs: memoryFs,
  sessions: { get: () => undefined },
  workingDirectory: { defaultDirectory: '/work', get: () => '/work' },
  log: (message) => scanLogs.push(message),
});

const scanned = await scanner.scan({ sessionId: 'session-9' });
equal(scanned.root, '/work', 'the scanner reports the project root');
equal(scanned.present, true, 'the scanner finds .github');
equal(scanned.files.map((file) => file.path), [
  '.github/copilot-instructions.md',
  '.github/instructions/typescript.instructions.md',
  '.github/prompts/review.prompt.md',
  '.github/skills/webapp-testing/SKILL.md',
  '.github/chatmodes/plan.chatmode.md',
  '.github/agents/reviewer.agent.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/shared/eslint.md',
], 'the scan lists every Copilot markdown file in kind order and skips skill payloads');
equal(scanned.files[0].title, 'Project style', 'the main instructions title comes from its heading');
equal(scanned.files[1].applyTo, '**/*.ts', 'applyTo frontmatter is exposed');
equal(scanned.files[1].description, 'TypeScript rules', 'descriptions are exposed');
equal(scanned.files[2].mode, 'edit', 'chat-mode metadata is exposed');
equal(scanned.files[2].invoke, 'review', 'the prompt carries its invocation name');
equal(scanned.files[3].kind, 'skill', 'the Agent Skill is classified');
equal(scanned.files[3].invoke, 'webapp-testing', 'the skill carries its declared name');
equal(scanned.files[0].invoke, '', 'the repository instructions carry no invocation name');
equal(scanned.files[6].invoke, '', 'an unclassified markdown file carries no invocation name');
ok(scanned.errors.length === 0, 'a clean scan reports no errors');
equal(scanLogs.length, 0, 'a clean scan logs nothing');

const catalog = scanner.catalogOf(scanned);
equal(catalog.map((entry) => entry.name), ['review', 'webapp-testing', 'plan', 'reviewer'], 'the catalog names every invocable entry');
equal(catalog.map((entry) => entry.kind), ['prompt', 'skill', 'chatmode', 'agent'], 'the catalog keeps the kind of every entry');
equal(catalog[1].path, '.github/skills/webapp-testing/SKILL.md', 'the catalog carries the path of every entry');
equal(catalog[1].description, 'Toolkit for testing local web applications', 'the catalog carries the description of every entry');

const invocables = await scanner.invocables({ sessionId: 'session-9' });
equal(invocables.root, '/work', 'invocables reports the project root');
equal(invocables.present, true, 'invocables reports presence');
equal(invocables.entries, catalog, 'invocables projects the same catalog');

const readMain = await scanner.read({ sessionId: 'session-9' }, '.github/copilot-instructions.md');
equal(readMain.kind, 'instructions', 'read reports the kind');
equal(readMain.links.map((link) => link.path), ['.github/instructions/typescript.instructions.md', ''], 'resolved links come back with external targets unresolved');
equal(readMain.links.map((link) => link.external), [false, true], 'file links and external links are distinguished');
equal(readMain.links[0].address, 'dsh-resource://file/session/session-9/.github/instructions/typescript.instructions.md', 'file links carry a sidebar address');
equal(readMain.address, 'dsh-resource://file/session/session-9/.github/copilot-instructions.md', 'the file itself carries an address');
ok(readMain.blocks.some((block) => block.type === 'code'), 'code fences survive the read');
equal(readMain.reference, undefined, 'the repository instructions carry no reference block');

const readTs = await scanner.read({ sessionId: 'session-9' }, '.github/instructions/typescript.instructions.md');
equal(readTs.links.map((link) => link.path), ['.github/shared/eslint.md'], 'parent links resolve against the file directory');
equal(readTs.invoke, '', 'a path instruction carries no invocation name');

const readReview = await scanner.read({ sessionId: 'session-9' }, '.github/prompts/review.prompt.md');
equal(readReview.invoke, 'review', 'read reports the invocation name');
equal(readReview.reference, '<copilot_skill name="review" path=".github/prompts/review.prompt.md">\n# Review prompt\n\nSummarize the diff and list risks.\n</copilot_skill>', 'read builds the reference block of an invocable entry');

const readSkill = await scanner.read({ sessionId: 'session-9' }, '.github/skills/webapp-testing/SKILL.md');
equal(readSkill.kind, 'skill', 'read classifies an Agent Skill');
equal(readSkill.reference.startsWith('<copilot_skill name="webapp-testing" path=".github/skills/webapp-testing/SKILL.md">'), true, 'an Agent Skill reference names the skill');

const readAgent = await scanner.read({ sessionId: 'session-9' }, '.github/agents/reviewer.agent.md');
equal(readAgent.reference.startsWith('<copilot_agent name="reviewer"'), true, 'a custom agent reference uses the agent tag');

const contextText = scanner.renderContext(scanned);
ok(contextText.includes('# Project style'), 'the prompt context renders the main instructions');
ok(contextText.includes('## Other Copilot configuration files'), 'the prompt context indexes the other files');
ok(contextText.includes('.github/instructions/typescript.instructions.md'), 'the index names each file');
ok(contextText.includes('applies to **/*.ts'), 'the index carries applyTo scopes');
ok(contextText.includes('copilot_config'), 'the prompt context points at the tool');
ok(contextText.includes('## Copilot entries the user can bring in with `/`'), 'the prompt context indexes the invocable entries');
ok(contextText.includes('- /review → .github/prompts/review.prompt.md'), 'the invocable index names each entry');
ok(contextText.includes('- /webapp-testing → .github/skills/webapp-testing/SKILL.md'), 'the invocable index names the Agent Skill');
ok(contextText.includes('copilot_agent'), 'the invocable index explains the agent wrapper');
equal(scanner.renderContext({ present: false, files: [] }), '', 'no configuration renders no context');
equal(scanner.renderContext({ present: true, files: [{ path: '.github/copilot-instructions.md', kind: 'instructions', invoke: '' }] }).includes('bring in with'), false, 'a project without invocable entries omits the index');

const missing = await createCopilotScanner({
  fs: memoryFs,
  workingDirectory: { defaultDirectory: '/empty', get: () => '/empty' },
  log: () => {},
}).scan({});
equal(missing.present, false, 'a project without .github reports absent');
equal(missing.files.length, 0, 'a project without .github lists no files');

let notConfigError;
try {
  await scanner.read({ sessionId: 's' }, 'README.md');
} catch (error) {
  notConfigError = error;
}
equal(notConfigError?.code, 'NOT_COPILOT_CONFIG', 'reading a non-config file is rejected');

/* ------------------------------------------------------------------ *
 * lib/server.js
 * ------------------------------------------------------------------ */

const api = createCopilotApi({ scanner, token: 'token-1', log: () => {} });
equal(api.prefix, '/plugin-copilot-config/api', 'the API prefix has no trailing slash');

function fakeRequest(method, url, headers = {}) {
  return { method, url, headers };
}

async function fakeResponse(request) {
  const chunks = [];
  let head;
  const res = {
    writeHead(status, headers) {
      head = { status, headers };
    },
    end(body) {
      chunks.push(Buffer.from(body ?? ''));
    },
  };
  await api.handler(request, res);
  return { status: head?.status ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
}

const boot = await fakeResponse(fakeRequest('GET', '/plugin-copilot-config/api/bootstrap'));
equal(boot.status, 200, 'bootstrap answers 200');
equal(boot.body.token, 'token-1', 'bootstrap returns the token');

const denied = await fakeResponse(fakeRequest('GET', '/plugin-copilot-config/api/config'));
equal(denied.status, 401, 'requests without the token are rejected');

const config = await fakeResponse(fakeRequest('GET', '/plugin-copilot-config/api/config?session=session-9', { [TOKEN_HEADER]: 'token-1' }));
equal(config.status, 200, 'config answers 200');
equal(config.body.files.length, scanned.files.length, 'config returns the scanned files');
equal(config.body.present, true, 'config reports presence');

const file = await fakeResponse(fakeRequest('GET', '/plugin-copilot-config/api/file?session=session-9&path=.github%2Fcopilot-instructions.md', { [TOKEN_HEADER]: 'token-1' }));
equal(file.status, 200, 'file answers 200');
equal(file.body.file.links.length, 2, 'file returns its links');
ok(Array.isArray(file.body.file.blocks), 'file returns rendered blocks');

const badFile = await fakeResponse(fakeRequest('GET', '/plugin-copilot-config/api/file?session=session-9&path=README.md', { [TOKEN_HEADER]: 'token-1' }));
equal(badFile.status, 400, 'a non-config path is a client error');
equal(badFile.body.error.code, 'NOT_COPILOT_CONFIG', 'the error carries its code');

const catalogRoute = await fakeResponse(fakeRequest('GET', '/plugin-copilot-config/api/catalog?session=session-9', { [TOKEN_HEADER]: 'token-1' }));
equal(catalogRoute.status, 200, 'catalog answers 200');
equal(catalogRoute.body.entries.map((entry) => entry.name), ['review', 'webapp-testing', 'plan', 'reviewer'], 'catalog returns the invocable entries');
equal(catalogRoute.body.present, true, 'catalog reports presence');

const catalogDenied = await fakeResponse(fakeRequest('GET', '/plugin-copilot-config/api/catalog'));
equal(catalogDenied.status, 401, 'catalog without the token is rejected');

const missingRoute = await fakeResponse(fakeRequest('GET', '/plugin-copilot-config/api/nope', { [TOKEN_HEADER]: 'token-1' }));
equal(missingRoute.status, 404, 'unknown routes answer 404');

const wrongPrefix = await fakeResponse(fakeRequest('GET', '/other/bootstrap'));
equal(wrongPrefix.status, 404, 'foreign prefixes answer 404');

/* ------------------------------------------------------------------ *
 * lib/tool.js
 * ------------------------------------------------------------------ */

const tool = createCopilotTool(scanner);
equal(tool.name, TOOL_NAME, 'the tool is named copilot_config');
equal(tool.parameters.type, 'object', 'tool parameters are object-rooted');
equal(tool.parameters.required, ['action'], 'action is required');
ok(typeof tool.output.render === 'function', 'the tool declares an output renderer');

const listed = await tool.execute({ action: 'list' }, { agent: undefined, signal: undefined });
equal(listed.files.length, scanned.files.length, 'the tool lists every configuration file');
equal(listed.present, true, 'the tool reports presence');
equal(listed.files.find((entry) => entry.path === '.github/prompts/review.prompt.md').invoke, 'review', 'the tool list carries the invocation name');
equal(listed.files.find((entry) => entry.path === '.github/copilot-instructions.md').invoke, undefined, 'the tool list omits the invocation name of a non-invocable file');
equal(listed.invocable.map((entry) => entry.name), ['review', 'webapp-testing', 'plan', 'reviewer'], 'the tool list carries the invocable catalog');

const readViaTool = await tool.execute({ action: 'read', path: '.github/prompts/review.prompt.md' }, { agent: undefined });
equal(readViaTool.path, '.github/prompts/review.prompt.md', 'the tool reads one file');
equal(readViaTool.invoke, 'review', 'the tool read carries the invocation name');
ok(readViaTool.text.includes('# Review prompt'), 'the tool returns rendered text');

const rendered = tool.output.render({ action: 'list' }, listed);
equal(rendered[0].type, 'text', 'the output renders as text');
ok(rendered[0].text.includes('copilot-instructions.md'), 'the rendered text names the files');

let pathError;
try {
  await tool.execute({ action: 'read' }, { agent: undefined });
} catch (error) {
  pathError = error;
}
equal(pathError?.code, 'PATH_REQUIRED', 'read without a path is rejected');

ok(SECTION_TEXT.includes(TOOL_NAME), 'the static prompt section names the tool');
ok(SECTION_NAME === 'copilot-config', 'the static section has a stable name');
ok(SECTION_TEXT.includes('.github/skills/*/SKILL.md'), 'the static prompt section names the Agent Skills path');
ok(SECTION_TEXT.includes('copilot_skill'), 'the static prompt section names the skill wrapper');
ok(SECTION_TEXT.includes('copilot_agent'), 'the static prompt section names the agent wrapper');

/* ------------------------------------------------------------------ *
 * index.js — Host wiring through a fake context
 * ------------------------------------------------------------------ */

const hostModule = await import(pkgUrl('index.js').href);
ok(Array.isArray(hostModule.inject), 'the Host plugin declares inject');
for (const service of ['fs', 'sessions', 'workingDirectory', 'tools', 'systemPrompt']) {
  ok(hostModule.inject.includes(service), `the Host plugin injects ${service}`);
}

const sections = [];
const tools = [];
const listeners = new Map();
const injected = [];
const agentSections = [];

function createFakeAgent(cwd) {
  const agent = {
    session: { id: 'session-1' },
    ctx: {
      effect(factory) {
        const dispose = factory();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      systemPrompt: {
        section(section) {
          agentSections.push(section);
          return () => {};
        },
      },
    },
  };
  return agent;
}

const fakeCtx = {
  logger: { warn: () => {} },
  fs: memoryFs,
  sessions: { get: () => undefined },
  workingDirectory: { defaultDirectory: '/work', get: () => '/work' },
  tools: { register: (definition) => { tools.push(definition); return () => {}; } },
  systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
  effect(factory) {
    const dispose = factory();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  on(name, listener) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(listener);
    return () => {};
  },
  inject(names, setup) {
    injected.push(names);
    const webCtx = {
      effect(factory) {
        const dispose = factory();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      webServer: { register: (route) => { routes.push(route); return () => {}; } },
    };
    setup(webCtx);
    return () => {};
  },
};

const routes = [];
hostModule.apply(fakeCtx);

ok(sections.some((section) => section.name === SECTION_NAME), 'the Host registers the static prompt section');
ok(tools.some((definition) => definition.name === TOOL_NAME), 'the Host registers the agent tool');
ok(listeners.has('agent/created'), 'the Host listens for agent creation');
ok(listeners.has('agent/disposed'), 'the Host listens for agent disposal');
equal(routes.length, 1, 'the Host registers one web route');
equal(routes[0].path, '/plugin-copilot-config/api', 'the route prefix has no trailing slash');
equal(routes[0].kind, 'prefix', 'the route is a prefix route');
ok(injected.some((names) => names.includes('webServer')), 'the web server is injected optionally');

const created = listeners.get('agent/created');
equal(created.length, 1, 'one agent/created listener is registered');
await created[0]({ agent: createFakeAgent('/work'), source: 'user' });
ok(agentSections.some((section) => section.name === 'copilot-config:project'), 'the per-agent project section is registered');
ok(agentSections[0].text.includes('Project style'), 'the per-agent section carries the project instructions');

/* ------------------------------------------------------------------ *
 * client.js — static contract
 * ------------------------------------------------------------------ */

let definition;
globalThis.window = { __ModuleLoader__: { load(value) { definition = value; } } };
await import(pkgUrl('client.js').href + '?contract=1');
equal(definition.id, 'dsh-plugin-copilot-config', 'the client factory id matches the package name');

const client = definition.factory((name) => {
  if (name !== 'react') throw new Error(`unexpected require ${name}`);
  return {};
});
ok(Array.isArray(client.inject) && client.inject.includes('slots'), 'the client declares the slots dependency');
ok(client.inject.includes('locale'), 'the client declares the locale dependency');
ok(client.inject.includes('sidebarRight'), 'the client declares the right-Sidebar dependency for file links');
ok(!client.inject.includes('inputTriggers'), 'the input-trigger service is injected at runtime, not statically');
ok(!client.inject.includes('uiConversation'), 'the conversation service is injected at runtime, not statically');

const css = client.__internals.CSS;
ok(typeof css === 'string' && css.includes('.rdc-root'), 'the client stylesheet is present');
ok(css.includes('.rdc-link-chip'), 'the client styles file-link chips');
ok(css.includes('--dsw-alias-label-primary'), 'the client stylesheet uses host theme tokens');
ok(css.includes('.rdc-chip'), 'the client styles the reference chip');
ok(css.includes('.rdc-badge--invoke'), 'the client styles the invocation badge');

const zhDict = client.__internals.zh;
const enDict = client.__internals.en;
equal(zhDict.menu, 'Copilot 配置', 'the Chinese menu label is localized');
equal(enDict.menu, 'Copilot config', 'the English menu label is localized');
for (const key of ['title', 'subtitle', 'openInSidebar', 'fileLinks', 'missingHint', 'kindInstructions', 'kindSkill', 'sectionAgents', 'sectionSkills', 'invokeTitle', 'chipTitle', 'referenceFailed']) {
  ok(typeof zhDict[key] === 'string' && zhDict[key] !== '', `zh dictionary defines ${key}`);
  ok(typeof enDict[key] === 'string' && enDict[key] !== '', `en dictionary defines ${key}`);
}
ok(Object.keys(zhDict).every((key) => key in enDict), 'the English dictionary covers every Chinese key');

/* ------------------------------------------------------------------ *
 * client.js — pure reference helpers
 * ------------------------------------------------------------------ */

const { rankRows, slugFromPath, encodeRef, decodeRef, sessionFileAddress, copilotReferenceRule } = client.__internals;

equal(slugFromPath('.github/prompts/review.prompt.md'), 'review', 'a prompt path yields its slug');
equal(slugFromPath('.github/chatmodes/plan.chatmode.md'), 'plan', 'a chat mode path yields its slug');
equal(slugFromPath('.github/agents/reviewer.agent.md'), 'reviewer', 'a custom agent path yields its slug');
equal(slugFromPath('.github/skills/webapp-testing/SKILL.md'), 'webapp-testing', 'a skill path yields its directory');
equal(slugFromPath('.github/instructions/ts.instructions.md'), 'ts', 'an instruction path still yields a slug');

equal(encodeRef('session-9', '.github/prompts/review.prompt.md'), 'session-9::.github/prompts/review.prompt.md', 'a reference id packs the session and the path');
equal(decodeRef('session-9::.github/prompts/review.prompt.md'), { sessionId: 'session-9', path: '.github/prompts/review.prompt.md' }, 'a reference id splits back');
equal(decodeRef('session-9::.github/prompts/a::b.prompt.md'), { sessionId: 'session-9', path: '.github/prompts/a::b.prompt.md' }, 'a path with the separator survives the split');
equal(decodeRef('.github/prompts/review.prompt.md'), { sessionId: '', path: '.github/prompts/review.prompt.md' }, 'a bare path decodes with no session');
equal(decodeRef(undefined), { sessionId: '', path: '' }, 'an absent reference decodes to nothing');

equal(
  sessionFileAddress('session-9', '.github/prompts/review.prompt.md'),
  'dsh-resource://file/session/session-9/.github/prompts/review.prompt.md',
  'the client builds the same file address the Host does',
);

const menuRows = [
  { name: 'review', label: 'Review prompt', description: 'Review a change', section: 'Copilot skills' },
  { name: 'plan', label: 'Plan mode', description: 'Plan mode', section: 'Copilot agents' },
  { name: 'webapp-testing', label: 'Webapp testing', description: 'Drive the app', section: 'Copilot skills' },
];
equal(rankRows(menuRows, '').map((row) => row.name), ['review', 'plan', 'webapp-testing'], 'an empty query keeps the catalog order');
equal(rankRows(menuRows, 'rev').map((row) => row.name), ['review'], 'a query filters to matching rows');
equal(rankRows(menuRows, 'REVIEW').map((row) => row.name), ['review'], 'a query is case-insensitive');
equal(rankRows(menuRows, 'plan mode').map((row) => row.name), ['plan'], 'a label match ranks too');
equal(rankRows(menuRows, 'zzz'), [], 'a query without a match yields nothing');
equal(rankRows(menuRows, 'e').map((row) => row.name), ['review', 'webapp-testing', 'plan'], 'a ranked query keeps each section adjacent');

const blockText = [
  'Please do this.',
  '',
  '<copilot_skill name="review" path=".github/prompts/review.prompt.md">',
  '# Review prompt',
  '',
  'Summarize the diff.',
  '</copilot_skill>',
  '',
  'And also <copilot_agent name="plan" path=".github/chatmodes/plan.chatmode.md">Ask first.</copilot_agent>.',
].join('\n');
const firstNode = copilotReferenceRule.match(blockText, 0);
equal(firstNode.id, 'copilot', 'the rule names its node');
equal(firstNode.data, { kind: 'skill', name: 'review', path: '.github/prompts/review.prompt.md' }, 'the rule extracts the skill reference');
equal(blockText.slice(firstNode.start, firstNode.end).startsWith('<copilot_skill name="review"'), true, 'the node covers the whole block');
const secondNode = copilotReferenceRule.match(blockText, firstNode.end);
equal(secondNode.data, { kind: 'agent', name: 'plan', path: '.github/chatmodes/plan.chatmode.md' }, 'the rule finds the agent reference after the first');
equal(copilotReferenceRule.match(blockText, secondNode.end), undefined, 'the rule stops after the last reference');
equal(copilotReferenceRule.match('just a plain message', 0), undefined, 'plain text carries no reference');
equal(copilotReferenceRule.match('<copilot_skill name="x" path="p">body', 0), undefined, 'an unterminated block is not a reference');
equal(copilotReferenceRule.order, 25, 'the rule carries a finite order');

const hostBlock = buildCopilotReference({ kind: 'skill', name: 'webapp-testing', path: '.github/skills/webapp-testing/SKILL.md', text: '# Webapp testing\n\nDrive it.' });
const hostNode = copilotReferenceRule.match(`done\n${hostBlock}`, 0);
equal(hostNode.data, { kind: 'skill', name: 'webapp-testing', path: '.github/skills/webapp-testing/SKILL.md' }, 'the rule parses the block the Host builds');
const quotedBlock = buildCopilotReference({ kind: 'prompt', name: 'q"uote', path: '.github/p/a&b<c.prompt.md', text: 'x' });
equal(copilotReferenceRule.match(quotedBlock, 0)?.data.name, 'q"uote', 'the rule reads an escaped name back');

/* ------------------------------------------------------------------ *
 * client.js — the `/` trigger source against a stubbed API
 * ------------------------------------------------------------------ */

const catalogEntries = [
  { name: 'review', kind: 'prompt', path: '.github/prompts/review.prompt.md', title: 'Review prompt', description: 'Review a change' },
  { name: 'webapp-testing', kind: 'skill', path: '.github/skills/webapp-testing/SKILL.md', title: 'Webapp testing', description: 'Drive the app' },
  { name: 'plan', kind: 'chatmode', path: '.github/chatmodes/plan.chatmode.md', title: 'Plan mode', description: '' },
];
const reviewReference = buildCopilotReference({ kind: 'prompt', name: 'review', path: '.github/prompts/review.prompt.md', text: '# Review prompt\n\nSummarize the diff.' });

const apiCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(String(url), 'http://copilot-config.local');
  apiCalls.push({ path: parsed.pathname, query: parsed.searchParams.get('session') ?? '', token: init?.headers?.['x-copilot-config-token'] ?? '' });
  if (parsed.pathname.endsWith('/bootstrap')) return { ok: true, json: async () => ({ token: 'token-1', prefix: API_PREFIX }) };
  if (parsed.pathname.endsWith('/catalog')) {
    return { ok: true, json: async () => ({ root: '/work', present: true, entries: catalogEntries }) };
  }
  if (parsed.pathname.endsWith('/file')) {
    return { ok: true, json: async () => ({ file: { path: '.github/prompts/review.prompt.md', kind: 'prompt', invoke: 'review', reference: reviewReference } }) };
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'not found' } }) };
};

const openedResources = [];
const fakeClientCtx = {
  sidebarRight: { openResource: (address) => { openedResources.push(address); } },
  get(name) {
    if (name === 'sidebarRight') return this.sidebarRight;
    return undefined;
  },
};

// A React stub good enough to render the plugin's components: hooks resolve
// without a reconciler, deps-aware effects run once, and state writes are
// inert (no re-render loop).
let stubHooks = [];
let stubHookIndex = 0;
const sameDeps = (prev, deps) => Array.isArray(prev) && Array.isArray(deps)
  && prev.length === deps.length && prev.every((value, index) => Object.is(value, deps[index]));
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useMemo: (factory) => factory(),
  useState(init) {
    const index = stubHookIndex++;
    if (!(index in stubHooks)) stubHooks[index] = typeof init === 'function' ? init() : init;
    return [stubHooks[index], () => {}];
  },
  useCallback(factory, deps) {
    const index = stubHookIndex++;
    if (!sameDeps(stubHooks[index], deps)) stubHooks[index] = deps;
    return factory;
  },
  useEffect(factory, deps) {
    const index = stubHookIndex++;
    const seen = sameDeps(stubHooks[index], deps);
    stubHooks[index] = deps;
    if (seen) return;
    queueMicrotask(() => { try { factory(); } catch (error) { console.error('stub effect failed', error); } });
  },
};

/** Render one element tree the way the slot system does: call what it returns. */
function renderTree(element) {
  let current = element;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object' && typeof current.type === 'function'; depth += 1) {
    stubHookIndex = 0;
    current = current.type(current.props ?? {});
  }
  return current;
}

let referenceDefinition;
globalThis.window = { __ModuleLoader__: { load(value) { referenceDefinition = value; } } };
await import(pkgUrl('client.js').href + '?reference=1');
const referenceClient = referenceDefinition.factory((name) => {
  if (name !== 'react') throw new Error(`unexpected require ${name}`);
  return reactStub;
});
const internals = referenceClient.__internals;
const t = (key) => (internals.zh[key] === undefined ? key : internals.zh[key]);
const layer = internals.createReferenceLayer(fakeClientCtx, t);
const source = layer.source;

equal(source.trigger, '/', 'the source binds the slash trigger');
equal(source.name, 'copilot', 'the source registers under its own name');
equal(source.showGroupTitle, false, 'the source hides the raw group title row');

const abortController = new AbortController();
const candidates = await source.candidates({ sessionId: 'session-9' }, { query: '', signal: abortController.signal, position: 'leading', drilled: false });
equal(candidates.map((row) => row.name), ['review', 'webapp-testing', 'plan'], 'the menu lists every invocable entry');
equal(candidates.map((row) => row.section), ['Copilot 技能', 'Copilot 技能', 'Copilot 代理'], 'the menu groups entries into skill and agent sections');
equal(candidates[0].label, 'Review prompt', 'the menu shows the entry title as the label');
equal(candidates[0].value, '.github/prompts/review.prompt.md', 'the menu carries the path as the pick payload');
equal(candidates[2].description, '', 'an empty description stays empty');

const ranked = await source.candidates({ sessionId: 'session-9' }, { query: 'plan', signal: abortController.signal, position: 'leading', drilled: false });
equal(ranked.map((row) => row.name), ['plan'], 'the menu ranks a typed query');
equal(apiCalls.filter((call) => call.path.endsWith('/catalog')).length, 1, 'the catalog is fetched once per session');

const pick = source.onPick({
  candidate: candidates[0],
  session: { sessionId: 'session-9' },
  position: 'leading',
  via: 'menu',
  action: 'pick',
  span: { start: 0, end: 7, draftRev: 1 },
});
equal(pick.insert.source, 'copilot', 'a pick inserts a copilot reference');
equal(pick.insert.ref, 'session-9::.github/prompts/review.prompt.md', 'a pick packs the session and the path into the reference');
equal(pick.insert.label, '/review', 'a pick labels the chip with its slug');
equal(pick.insert.appearance, 'file', 'a pick marks the chip as a file reference');
equal(pick.insert.clipboardText, '/review', 'a pick keeps the slug as the clipboard projection');
equal(source.onPick({ candidate: { name: '', value: '' }, session: { sessionId: 's' } }), undefined, 'a pick without a name is refused');

const serialized = await source.codec.serialize('session-9::.github/prompts/review.prompt.md', abortController.signal);
equal(serialized, reviewReference, 'the codec serializes the Host-built reference block');
equal(source.codec.clipboardText('session-9::.github/prompts/review.prompt.md'), '/review', 'the codec projects the slug for the clipboard');
equal(source.codec.clipboardText('session-9::.github/skills/webapp-testing/SKILL.md'), '/webapp-testing', 'the codec projects a skill directory for the clipboard');
const fileCall = apiCalls.find((call) => call.path.endsWith('/file'));
equal(fileCall.token, 'token-1', 'the codec call carries the API token');
equal(fileCall.query, 'session-9', 'the codec call carries the picked session');

const sessionless = await source.codec.serialize('::.github/prompts/review.prompt.md', abortController.signal);
equal(sessionless, reviewReference, 'a reference without a session still reads the file');
const fileCallNoSession = apiCalls[apiCalls.length - 1];
equal(fileCallNoSession.query, '', 'a sessionless reference reads the default directory');

let missingRefError;
try {
  await source.codec.serialize('', abortController.signal);
} catch (error) {
  missingRefError = error;
}
ok(missingRefError instanceof Error && missingRefError.message.includes('lost its path'), 'serializing an empty reference is rejected');

source.warm({ sessionId: 'session-9' });
await new Promise((resolve) => setImmediate(resolve));
equal(source.openReference({ sessionId: 'session-9' }, { ref: 'session-9::.github/prompts/review.prompt.md' }), true, 'a chip opens its file in the right sidebar');
equal(openedResources, ['dsh-resource://file/session/session-9/.github/prompts/review.prompt.md'], 'a chip opens the address of the file it came from');
equal(source.openReference({ sessionId: 'session-9' }, { ref: '::' }), false, 'a reference without a path is refused');
layer.invalidate('session-9');
await source.candidates({ sessionId: 'session-9' }, { query: '', signal: abortController.signal, position: 'leading', drilled: false });
equal(apiCalls.filter((call) => call.path.endsWith('/catalog')).length, 2, 'an invalidated catalog is fetched again');
layer.invalidateAll();
await source.candidates({ sessionId: 'session-9' }, { query: '', signal: abortController.signal, position: 'leading', drilled: false });
equal(apiCalls.filter((call) => call.path.endsWith('/catalog')).length, 3, 'clearing every cache refetches the catalog');

globalThis.fetch = realFetch;

/* ------------------------------------------------------------------ *
 * end to end — the real Host API behind the client's fetch
 * ------------------------------------------------------------------ */

const integrationApi = createCopilotApi({ scanner, token: 'token-1', log: () => {} });
globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(String(url), 'http://copilot-config.local');
  const chunks = [];
  let head;
  const res = {
    writeHead(status, headers) { head = { status, headers }; },
    end(body) { chunks.push(Buffer.from(body ?? '')); },
  };
  await integrationApi.handler({
    method: 'GET',
    url: `${parsed.pathname}${parsed.search}`,
    headers: init?.headers ?? {},
  }, res);
  const text = Buffer.concat(chunks).toString('utf8');
  return {
    ok: (head?.status ?? 500) < 400,
    status: head?.status ?? 500,
    json: async () => JSON.parse(text || '{}'),
  };
};

const integrationLayer = internals.createReferenceLayer(fakeClientCtx, t);
const integrationSource = integrationLayer.source;
const liveCandidates = await integrationSource.candidates({ sessionId: 'session-9' }, { query: '', signal: abortController.signal, position: 'leading', drilled: false });
equal(liveCandidates.map((row) => row.name), ['review', 'webapp-testing', 'plan', 'reviewer'], 'the menu lists what the real scanner finds');
const livePick = integrationSource.onPick({
  candidate: liveCandidates[0],
  session: { sessionId: 'session-9' },
  position: 'leading',
  via: 'menu',
  action: 'pick',
  span: { start: 0, end: 7, draftRev: 1 },
});
const liveText = await integrationSource.codec.serialize(livePick.insert.ref, abortController.signal);
ok(liveText.startsWith('<copilot_skill name="review" path=".github/prompts/review.prompt.md">'), 'the serialized message carries the picked prompt');
ok(liveText.includes('# Review prompt'), 'the serialized message carries the prompt body');
const liveNode = copilotReferenceRule.match(liveText, 0);
equal(liveNode.data, { kind: 'skill', name: 'review', path: '.github/prompts/review.prompt.md' }, 'the sent block parses back into a chip');

const agentPick = integrationSource.onPick({
  candidate: liveCandidates[3],
  session: { sessionId: 'session-9' },
  position: 'leading',
  via: 'menu',
  action: 'pick',
  span: { start: 0, end: 10, draftRev: 1 },
});
const agentText = await integrationSource.codec.serialize(agentPick.insert.ref, abortController.signal);
ok(agentText.startsWith('<copilot_agent name="reviewer" path=".github/agents/reviewer.agent.md">'), 'a custom agent serializes under the agent tag');

const skillPick = integrationSource.onPick({
  candidate: liveCandidates[1],
  session: { sessionId: 'session-9' },
  position: 'leading',
  via: 'menu',
  action: 'pick',
  span: { start: 0, end: 15, draftRev: 1 },
});
const skillText = await integrationSource.codec.serialize(skillPick.insert.ref, abortController.signal);
ok(skillText.includes('# Webapp testing'), 'an Agent Skill serializes its body');
equal(integrationSource.codec.clipboardText(skillPick.insert.ref), '/webapp-testing', 'an Agent Skill projects its directory name');

const chip = integrationLayer.CopilotReference({ node: liveNode, raw: liveText, interactive: true, openCopilot: () => {} });
equal(chip.children[0].children[1].children[0], '/review', 'the rendered chip shows the picked slug');

globalThis.fetch = realFetch;

const interactiveChip = layer.CopilotReference({
  node: { id: 'copilot', start: 0, end: 10, data: { kind: 'skill', name: 'review', path: '.github/prompts/review.prompt.md' } },
  raw: '<copilot_skill name="review" path=".github/prompts/review.prompt.md">x</copilot_skill>',
  interactive: true,
  openCopilot: (path) => { openedResources.push(`opened:${path}`); },
});
equal(interactiveChip.type, 'button', 'an interactive reference renders as a button');
equal(interactiveChip.props.className, 'rdc-chip rdc-chip--button', 'the button carries the chip classes');
interactiveChip.props.onClick();
equal(openedResources[openedResources.length - 1], 'opened:.github/prompts/review.prompt.md', 'clicking the chip opens the file');

const plainChip = layer.CopilotReference({
  node: { id: 'copilot', start: 0, end: 10, data: { kind: 'agent', name: 'plan', path: '.github/chatmodes/plan.chatmode.md' } },
  raw: 'x',
  interactive: false,
});
equal(plainChip.type, 'span', 'a non-interactive reference renders as a span');
equal(plainChip.props.className, 'rdc-chip', 'the span carries the chip class');
equal(plainChip.children[0].children[1].children[0], '/plan', 'the chip shows the agent slug');

const namelessChip = layer.CopilotReference({
  node: { id: 'copilot', start: 0, end: 10, data: { kind: 'skill', name: '', path: '.github/prompts/review.prompt.md' } },
  raw: 'x',
  interactive: true,
});
equal(namelessChip.children[0].children[1].children[0], '.github/prompts/review.prompt.md', 'a reference without a name falls back to its path');

/* ------------------------------------------------------------------ *
 * client.js — runtime wiring through a fake context
 * ------------------------------------------------------------------ */

const registeredSources = [];
const registeredRules = [];
const registeredTabs = [];
const registeredShortcuts = [];
const slotRegistrations = [];
const effects = [];
const runtimeInjected = [];
const openedTabs = [];
let failConversationSlot = false;
const fakeRuntimeCtx = {
  sidebarRight: {
    openResource: () => {},
    commandTarget: (element) => (element === null || element === undefined ? undefined : { paneId: 'p1' }),
    openTabFromTarget: (kind) => { openedTabs.push(kind); },
  },
  slots: {
    inject(owner, factory) {
      const offs = [];
      const iterator = factory();
      for (const registration of iterator) {
        if (typeof registration === 'function') offs.push(registration);
      }
      return () => { for (const off of offs) off(); };
    },
    register(options, Component) {
      if (options.name === 'conversation.user.text.node' && failConversationSlot === true) {
        throw new Error('slot "conversation.user.text.node" is not declared');
      }
      slotRegistrations.push({ options, Component });
      return () => {};
    },
  },
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
  },
  effect(factory, label) {
    const dispose = factory();
    effects.push(label);
    return typeof dispose === 'function' ? dispose : () => {};
  },
  inject(names, setup) {
    runtimeInjected.push(names);
    const sub = {
      effect: fakeRuntimeCtx.effect,
      sidebarRight: fakeRuntimeCtx.sidebarRight,
      sidebarRightTabs: { register: (definition) => { registeredTabs.push(definition); return () => {}; } },
      shortcuts: { register: (command) => { registeredShortcuts.push(command); return () => {}; } },
      inputTriggers: { registerSource: (source) => { registeredSources.push(source); return () => {}; } },
      uiConversation: { userText: { register: (rule) => { registeredRules.push(rule); return () => {}; } } },
    };
    setup(sub);
    return () => {};
  },
};

let wiringDefinition;
globalThis.window = { __ModuleLoader__: { load(value) { wiringDefinition = value; } } };
globalThis.document = undefined;
await import(pkgUrl('client.js').href + '?wiring=1');
const wiringClient = wiringDefinition.factory((name) => {
  if (name !== 'react') throw new Error(`unexpected require ${name}`);
  return reactStub;
});
wiringClient.apply(fakeRuntimeCtx);

equal(runtimeInjected, [['sidebarRightTabs'], ['shortcuts', 'sidebarRight'], ['inputTriggers'], ['uiConversation']], 'every optional service is injected at runtime');
equal(registeredTabs.length, 1, 'the tab type registers once');
equal(registeredTabs[0].id, 'dsh-plugin-copilot-config', 'the tab type names the package as its implementation identity');
equal(registeredTabs[0].kind, 'copilot-config', 'the tab type owns the copilot-config kind');
equal(registeredTabs[0].priority, 'extension', 'the tab type registers in the extension band');
equal(registeredTabs[0].patterns, undefined, 'the tab type is a page type, opened by kind');
equal(typeof registeredTabs[0].title(''), 'string', 'the tab type carries a title');
equal(registeredTabs[0].guide.length, 1, 'the tab type offers one guide entry');
equal(registeredTabs[0].guide[0].id, 'config', 'the guide entry is the configuration one');
equal(registeredTabs[0].guide[0].commandId, 'copilot-config.open', 'the guide entry names the opening command');
equal(typeof registeredTabs[0].guide[0].icon, 'function', 'the guide entry carries the plugin mark');

equal(registeredShortcuts.length, 1, 'the shortcut registers once');
equal(registeredShortcuts[0].id, 'copilot-config.open', 'the shortcut opens the configuration tab');
equal(registeredShortcuts[0].defaults, {}, 'the shortcut claims no default binding');
equal(registeredShortcuts[0].regions, ['page', 'editable', 'terminal'], 'the shortcut runs in every input region');
const blockedShortcut = registeredShortcuts[0].resolve({ region: 'page', modal: null, target: null });
equal(blockedShortcut.status, 'blocked', 'the shortcut is blocked without a session target');
const handledShortcut = registeredShortcuts[0].resolve({ region: 'page', modal: null, target: {} });
equal(handledShortcut.status, 'handled', 'the shortcut resolves against a session target');
handledShortcut.run();
equal(openedTabs, ['copilot-config'], 'the shortcut opens the configuration tab');

equal(registeredSources.length, 1, 'the slash source registers once');
equal(registeredSources[0].name, 'copilot', 'the registered source is the Copilot one');
equal(registeredRules.length, 1, 'the user-text rule registers once');
equal(registeredRules[0].id, 'copilot', 'the registered rule is the Copilot one');
const tabEntry = slotRegistrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab');
ok(tabEntry !== undefined, 'the right-sidebar tab body registers');
equal(tabEntry.options.key, 'dsh-plugin-copilot-config', 'the tab body registers under the tab type id');
ok(slotRegistrations.some((entry) => entry.options.key === 'copilot' && entry.options.name === 'conversation.user.text.node'), 'the conversation chip slot registers under the copilot key');
ok(!slotRegistrations.some((entry) => entry.options.name === 'sidebar.panellist'), 'no left-sidebar menu row registers');
ok(!slotRegistrations.some((entry) => entry.options.name === 'main'), 'no standalone main page registers');
ok(slotRegistrations.every((entry) => typeof entry.Component === 'function'), 'every slot registration carries a component');
ok(effects.includes('copilot-config: slash source'), 'the slash source rides an effect');
ok(effects.includes('copilot-config: user text'), 'the user-text rule rides an effect');
ok(effects.includes('copilot-config: tab type'), 'the tab type rides an effect');
ok(effects.includes('copilot-config: shortcut'), 'the shortcut rides an effect');

// A host without the conversation chip slot keeps the tab and the rest.
const beforeFailure = slotRegistrations.length;
failConversationSlot = true;
let wiringWithoutSlot;
globalThis.window = { __ModuleLoader__: { load(value) { wiringWithoutSlot = value; } } };
await import(pkgUrl('client.js').href + '?wiring-missing-slot=1');
const missingSlotClient = wiringWithoutSlot.factory((name) => {
  if (name !== 'react') throw new Error(`unexpected require ${name}`);
  return reactStub;
});
missingSlotClient.apply(fakeRuntimeCtx);
equal(slotRegistrations.length, beforeFailure + 1, 'a missing conversation slot costs only the chip registration');
ok(slotRegistrations.some((entry) => entry.options.name === 'sidebar.right.pane.tab'), 'the tab body still registers without the conversation slot');
equal(registeredSources.length, 2, 'the slash source still registers without the conversation slot');
equal(registeredRules.length, 2, 'the user-text rule still registers without the conversation slot');
failConversationSlot = false;

/* ------------------------------------------------------------------ *
 * client.js — the right-sidebar tab body
 * ------------------------------------------------------------------ */

const configSessions = [];
const realFetchForTab = globalThis.fetch;
globalThis.fetch = async (url) => {
  const parsed = new URL(String(url), 'http://copilot-config.local');
  if (parsed.pathname.endsWith('/bootstrap')) return { ok: true, json: async () => ({ token: 'token-1' }) };
  if (parsed.pathname.endsWith('/config')) {
    configSessions.push(parsed.searchParams.get('session') ?? '');
    return { ok: true, json: async () => ({ root: '/work', present: true, files: [], errors: [] }) };
  }
  return { ok: false, json: async () => ({}) };
};
const tabBody = tabEntry.Component;
const tabElement = tabBody({
  sessionId: 'session-tab',
  useSessions: (selector) => selector({ byId: { 'session-main': { retainedBy: { mainView: 1 } } }, ids: ['session-main'] }),
});
// The slot system renders what a component returns; resolve it the same way.
const resolved = renderTree(tabElement);
await new Promise((resolve) => setImmediate(resolve));
const tabJson = JSON.stringify(resolved, (key, value) => (typeof value === 'function' ? '[fn]' : value));
ok(tabJson.includes('"data-surface":"tab"'), 'the tab body marks the page as a tab surface');
equal(configSessions, ['session-tab'], 'the tab body reads the Session it belongs to, not the main one');
globalThis.fetch = realFetchForTab;

/* ------------------------------------------------------------------ *
 * manifest and display metadata
 * ------------------------------------------------------------------ */

const manifest = await import(pkgUrl('package.json').href, { with: { type: 'json' } });
equal(manifest.default.name, 'dsh-plugin-copilot-config', 'the package name matches the patch row');
equal(manifest.default.dsh.bundle.patch, './cordis.patch.yml', 'the manifest declares the bundle patch');
equal(manifest.default.dsh.client.platform, 'web', 'the client half targets the web platform');
ok(manifest.default.exports['./client'] === './client.js', 'the client module is exported');
ok(manifest.default.files.includes('lib/**/*.js'), 'library modules are packed');

for (const localeFile of ['en', 'zh']) {
  const locale = await import(pkgUrl(`locale/${localeFile}.json`).href, { with: { type: 'json' } });
  ok(typeof locale.default.meta.title === 'string' && locale.default.meta.title !== '', `locale/${localeFile}.json has a title`);
  ok(typeof locale.default.meta.description === 'string' && locale.default.meta.description !== '', `locale/${localeFile}.json has a description`);
}

const icon = await import('node:fs/promises').then((fs) => fs.readFile(fileURLToPath(pkgUrl('icon.svg')), 'utf8'));
ok(icon.includes('<svg') && icon.includes('</svg>'), 'the icon is an SVG document');
ok(!icon.includes('http://www.w3.org/2000/svg" width="0"'), 'the icon declares a viewport');

await rm(temp, { recursive: true, force: true });

console.log(`verify-contract: ${checks} assertions passed`);