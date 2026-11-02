/**
 * Zero-dependency self-check for the Copilot configuration plugin.
 *
 * Covers the pure Copilot helpers, the filesystem scanner against an in-memory
 * `ctx.fs`, the HTTP API contract, the agent tool, the Host wiring through a
 * fake Cordis context, and the Client module's static contract.
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
  buildFileAddress,
  classifyCopilotPath,
  deriveTitle,
  describeEntry,
  extractFileLinks,
  isExternalTarget,
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
equal(classifyCopilotPath('README.md'), undefined, 'a repository root readme is not Copilot configuration');
equal(classifyCopilotPath('docs/style.md'), undefined, 'a file outside .github is not Copilot configuration');
equal(classifyCopilotPath('.github/dependabot.yml'), undefined, 'non-markdown files are not configuration');
equal(classifyCopilotPath('.github/PULL_REQUEST_TEMPLATE.md'), 'other', 'other .github markdown is kept as other');
equal(classifyCopilotPath('.github/instructions/deep/nested/file.instructions.md'), 'instruction', 'nested instruction files are classified');
equal(COPILOT_KINDS.indexOf('instructions') < COPILOT_KINDS.indexOf('other'), true, 'the repository instructions sort first');

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

const TREE = new Map([
  ['/work/.github', { type: 'directory' }],
  ['/work/.github/copilot-instructions.md', { type: 'file', content: MAIN_CONTENT }],
  ['/work/.github/instructions', { type: 'directory' }],
  ['/work/.github/instructions/typescript.instructions.md', { type: 'file', content: TS_CONTENT }],
  ['/work/.github/prompts', { type: 'directory' }],
  ['/work/.github/prompts/review.prompt.md', { type: 'file', content: REVIEW_CONTENT }],
  ['/work/.github/chatmodes', { type: 'directory' }],
  ['/work/.github/chatmodes/plan.chatmode.md', { type: 'file', content: PLAN_CONTENT }],
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
  '.github/chatmodes/plan.chatmode.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/shared/eslint.md',
], 'the scan lists every Copilot markdown file in kind order');
equal(scanned.files[0].title, 'Project style', 'the main instructions title comes from its heading');
equal(scanned.files[1].applyTo, '**/*.ts', 'applyTo frontmatter is exposed');
equal(scanned.files[1].description, 'TypeScript rules', 'descriptions are exposed');
equal(scanned.files[2].mode, 'edit', 'chat-mode metadata is exposed');
ok(scanned.errors.length === 0, 'a clean scan reports no errors');
equal(scanLogs.length, 0, 'a clean scan logs nothing');

const readMain = await scanner.read({ sessionId: 'session-9' }, '.github/copilot-instructions.md');
equal(readMain.kind, 'instructions', 'read reports the kind');
equal(readMain.links.map((link) => link.path), ['.github/instructions/typescript.instructions.md', ''], 'resolved links come back with external targets unresolved');
equal(readMain.links.map((link) => link.external), [false, true], 'file links and external links are distinguished');
equal(readMain.links[0].address, 'dsh-resource://file/session/session-9/.github/instructions/typescript.instructions.md', 'file links carry a sidebar address');
equal(readMain.address, 'dsh-resource://file/session/session-9/.github/copilot-instructions.md', 'the file itself carries an address');
ok(readMain.blocks.some((block) => block.type === 'code'), 'code fences survive the read');

const readTs = await scanner.read({ sessionId: 'session-9' }, '.github/instructions/typescript.instructions.md');
equal(readTs.links.map((link) => link.path), ['.github/shared/eslint.md'], 'parent links resolve against the file directory');

const contextText = scanner.renderContext(scanned);
ok(contextText.includes('# Project style'), 'the prompt context renders the main instructions');
ok(contextText.includes('## Other Copilot configuration files'), 'the prompt context indexes the other files');
ok(contextText.includes('.github/instructions/typescript.instructions.md'), 'the index names each file');
ok(contextText.includes('applies to **/*.ts'), 'the index carries applyTo scopes');
ok(contextText.includes('copilot_config'), 'the prompt context points at the tool');
equal(scanner.renderContext({ present: false, files: [] }), '', 'no configuration renders no context');

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

const readViaTool = await tool.execute({ action: 'read', path: '.github/prompts/review.prompt.md' }, { agent: undefined });
equal(readViaTool.path, '.github/prompts/review.prompt.md', 'the tool reads one file');
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

const css = client.__internals.CSS;
ok(typeof css === 'string' && css.includes('.rdc-root'), 'the client stylesheet is present');
ok(css.includes('.rdc-link-chip'), 'the client styles file-link chips');
ok(css.includes('--dsw-alias-label-primary'), 'the client stylesheet uses host theme tokens');

const zhDict = client.__internals.zh;
const enDict = client.__internals.en;
equal(zhDict.menu, 'Copilot 配置', 'the Chinese menu label is localized');
equal(enDict.menu, 'Copilot config', 'the English menu label is localized');
for (const key of ['title', 'subtitle', 'openInSidebar', 'fileLinks', 'missingHint', 'kindInstructions']) {
  ok(typeof zhDict[key] === 'string' && zhDict[key] !== '', `zh dictionary defines ${key}`);
  ok(typeof enDict[key] === 'string' && enDict[key] !== '', `en dictionary defines ${key}`);
}
ok(Object.keys(zhDict).every((key) => key in enDict), 'the English dictionary covers every Chinese key');

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