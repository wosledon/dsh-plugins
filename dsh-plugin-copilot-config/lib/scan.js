/**
 * Filesystem-backed scanner for `.github/` Copilot configuration.
 *
 * The scanner owns every I/O: it resolves the Session working directory, walks
 * the `.github` tree through `ctx.fs`, and returns plain JSON the HTTP API, the
 * agent tool, and the prompt preload all share.
 *
 * @module dsh-plugin-copilot-config/lib/scan
 */

import {
  COPILOT_KINDS,
  INVOCABLE_KINDS,
  MAX_FILE_BYTES,
  buildCopilotReference,
  classifyCopilotPath,
  describeEntry,
  extractFileLinks,
  buildFileAddress,
  isSkillResource,
  markdownToBlocks,
  parseFrontmatter,
  renderPlainText,
} from './copilot.js';

/** Default scan bounds; every one of them is a hard stop, not a hint. */
const DEFAULT_LIMITS = {
  maxFiles: 300,
  maxDepth: 4,
  maxDirEntries: 500,
  maxContextBytes: 16 * 1024,
  maxReferenceBytes: 64 * 1024,
};

/** Directory names never worth walking inside a configuration tree. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.svn', '.hg']);

/**
 * Create the scanner.
 *
 * @param {object} options
 * @param {import('@deepseek-ai/dsh-fs').FileSystem} options.fs - filesystem service
 * @param {import('@deepseek-ai/dsh-session').Sessions} [options.sessions] - session store
 * @param {import('@deepseek-ai/dsh-session/working-directory').WorkingDirectory} [options.workingDirectory]
 * @param {(message: string, error?: unknown) => void} [options.log]
 * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits]
 */
export function createCopilotScanner(options) {
  const fs = options.fs;
  const sessions = options.sessions;
  const workingDirectory = options.workingDirectory;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };

  /**
   * Resolve the project root for one reader.
   *
   * @param {{ sessionId?: string, agent?: { session?: unknown }, signal?: AbortSignal }} reader
   * @returns {Promise<string>}
   */
  async function resolveRoot(reader = {}) {
    const signal = reader.signal;
    if (reader.agent !== undefined && workingDirectory?.ensure !== undefined) {
      try {
        const cwd = await workingDirectory.ensure(reader.agent, signal);
        if (typeof cwd === 'string' && cwd !== '') return cwd;
      } catch (error) {
        log('copilot-config: workingDirectory.ensure failed', error);
      }
    }
    if (reader.sessionId !== undefined && sessions?.get !== undefined) {
      const session = sessions.get(reader.sessionId);
      if (session !== undefined && workingDirectory?.get !== undefined) {
        try {
          const cwd = workingDirectory.get(session);
          if (typeof cwd === 'string' && cwd !== '') return cwd;
        } catch (error) {
          log('copilot-config: workingDirectory.get failed', error);
        }
      }
    }
    return workingDirectory?.defaultDirectory ?? process.cwd();
  }

  /**
   * Read one text file through the filesystem service, bounded by size.
   *
   * @param {{ targetKey: string, displayPath: string }} target - resolved target
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ text: string, bytes: number } | undefined>} `undefined` when
   *   the file is missing, not a regular file, or larger than the byte bound
   */
  async function readBounded(target, signal) {
    let info;
    try {
      info = await fs.stat(target, signal);
    } catch (error) {
      log(`copilot-config: stat failed for ${target.displayPath}`, error);
      return undefined;
    }
    if (info === undefined || info.type !== 'file') return undefined;
    if (typeof info.size === 'number' && info.size > MAX_FILE_BYTES) return undefined;
    try {
      const text = await fs.readText(target, signal);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_FILE_BYTES) return undefined;
      return { text, bytes };
    } catch (error) {
      log(`copilot-config: read failed for ${target.displayPath}`, error);
      return undefined;
    }
  }

  /**
   * Walk `.github` and collect every Copilot markdown file.
   *
   * @param {{ targetKey: string, displayPath: string }} dirTarget - resolved `.github` target
   * @param {string} prefix - repository-relative prefix of `dirTarget`
   * @param {number} depth - current depth
   * @param {{ files: unknown[], errors: string[], main?: unknown }} out
   * @param {AbortSignal} [signal]
   */
  async function walk(dirTarget, prefix, depth, out, signal) {
    if (depth > limits.maxDepth || out.files.length >= limits.maxFiles) return;
    let entries;
    try {
      entries = await fs.listDir(dirTarget, signal);
    } catch (error) {
      out.errors.push(`${prefix || '.'}: ${errorMessage(error)}`);
      return;
    }
    const sorted = [...entries].sort((left, right) => String(left.name).localeCompare(String(right.name)));
    for (const entry of sorted.slice(0, limits.maxDirEntries)) {
      if (out.files.length >= limits.maxFiles) return;
      const name = String(entry.name ?? '');
      if (name === '') continue;
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      if (entry.type === 'directory') {
        if (SKIPPED_DIRECTORIES.has(name) || name.startsWith('.')) continue;
        await walk(entry.target, relative, depth + 1, out, signal);
        continue;
      }
      if (entry.type !== 'file') continue;
      if (isSkillResource(relative)) continue;
      const kind = classifyCopilotPath(relative);
      if (kind === undefined) continue;
      const loaded = await readBounded(entry.target, signal);
      if (loaded === undefined) continue;
      const { data, body } = parseFrontmatter(loaded.text);
      const described = describeEntry(relative, kind, data, body);
      const file = {
        path: relative,
        kind,
        title: described.title,
        description: described.description,
        applyTo: described.applyTo,
        mode: described.mode,
        invoke: described.invoke,
        bytes: loaded.bytes,
      };
      out.files.push(file);
      if (kind === 'instructions' && out.main === undefined) {
        out.main = { path: relative, title: described.title, body };
      }
    }
  }

  /**
   * Scan one project.
   *
   * @param {{ sessionId?: string, agent?: unknown, signal?: AbortSignal }} [reader]
   * @returns {Promise<{ root: string, present: boolean, files: unknown[], errors: string[], main?: unknown }>}
   */
  async function scan(reader = {}) {
    const root = await resolveRoot(reader);
    const errors = [];
    const out = { files: [], errors, main: undefined };
    let githubTarget;
    try {
      githubTarget = await fs.resolve('.github', { cwd: root, signal: reader.signal });
    } catch (error) {
      log('copilot-config: resolve .github failed', error);
      return { root, present: false, files: [], errors: [...errors, errorMessage(error)] };
    }
    let info;
    try {
      info = await fs.stat(githubTarget, reader.signal);
    } catch (error) {
      log('copilot-config: stat .github failed', error);
      return { root, present: false, files: [], errors: [...errors, errorMessage(error)] };
    }
    if (info === undefined || info.type !== 'directory') {
      return { root, present: false, files: [], errors };
    }
    await walk(githubTarget, '.github', 0, out, reader.signal);
    const files = [...out.files].sort((left, right) => {
      const leftRank = COPILOT_KINDS.indexOf(left.kind);
      const rightRank = COPILOT_KINDS.indexOf(right.kind);
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.path.localeCompare(right.path);
    });
    return {
      root,
      present: true,
      files,
      errors: out.errors,
      ...(out.main === undefined ? {} : { main: out.main }),
    };
  }

  /**
   * Read one configuration file with resolved blocks and file links.
   *
   * @param {{ sessionId?: string, agent?: unknown, signal?: AbortSignal }} reader
   * @param {string} relativePath - repository-relative path under `.github/`
   */
  async function read(reader, relativePath) {
    const root = await resolveRoot(reader);
    const kind = classifyCopilotPath(relativePath);
    if (kind === undefined) {
      const error = new Error(`not a Copilot configuration file: ${relativePath}`);
      error.code = 'NOT_COPILOT_CONFIG';
      throw error;
    }
    const target = await fs.resolve(relativePath, { cwd: root, signal: reader.signal });
    const loaded = await readBounded(target, reader.signal);
    if (loaded === undefined) {
      const error = new Error(`cannot read ${relativePath}`);
      error.code = 'FS_NOT_FOUND';
      throw error;
    }
    const { data, body } = parseFrontmatter(loaded.text);
    const described = describeEntry(relativePath, kind, data, body);
    const blocks = markdownToBlocks(body);
    const sessionId = typeof reader.sessionId === 'string' ? reader.sessionId : '';
    const links = extractFileLinks(blocks, relativePath).map((link) => ({
      ...link,
      ...(link.external || sessionId === '' ? {} : { address: buildFileAddress(sessionId, link.path) }),
    }));
    const text = renderPlainText(blocks);
    return {
      root,
      path: relativePath,
      kind,
      title: described.title,
      description: described.description,
      applyTo: described.applyTo,
      mode: described.mode,
      invoke: described.invoke,
      bytes: loaded.bytes,
      blocks,
      links,
      text,
      ...(described.invoke === ''
        ? {}
        : {
          reference: buildCopilotReference({
            kind,
            name: described.invoke,
            path: relativePath,
            text,
            maxBytes: limits.maxReferenceBytes,
          }),
        }),
      ...(sessionId === '' ? {} : { address: buildFileAddress(sessionId, relativePath) }),
    };
  }

  /**
   * Project one scan into the entries a user can bring in with `/`.
   *
   * @param {Awaited<ReturnType<typeof scan>>} snapshot
   * @returns {unknown[]} invocable entries in scan order
   */
  function catalogOf(snapshot) {
    const entries = [];
    for (const file of snapshot?.files ?? []) {
      if (!INVOCABLE_KINDS.includes(file.kind) || file.invoke === '') continue;
      entries.push({
        name: file.invoke,
        kind: file.kind,
        path: file.path,
        title: file.title,
        description: file.description,
      });
    }
    return entries;
  }

  /**
   * List the entries a user can bring into a conversation with `/`.
   *
   * Prompts, Agent Skills, chat modes, and custom agents are invocable; the
   * repository and path-scoped instructions are context, not commands, so they
   * stay out of the catalog.
   *
   * @param {{ sessionId?: string, agent?: unknown, signal?: AbortSignal }} [reader]
   * @returns {Promise<{ root: string, present: boolean, entries: unknown[] }>}
   */
  async function invocables(reader = {}) {
    const snapshot = await scan(reader);
    return { root: snapshot.root, present: snapshot.present, entries: catalogOf(snapshot) };
  }

  /**
   * Render the prompt text for one scan.
   *
   * @param {Awaited<ReturnType<typeof scan>>} snapshot
   * @returns {string} `''` when the project carries no Copilot configuration
   */
  function renderContext(snapshot) {
    if (snapshot?.present !== true || snapshot.files.length === 0) return '';
    const lines = [
      'Project GitHub Copilot configuration (.github/) — follow this style and these instructions:',
      '',
    ];
    if (snapshot.main !== undefined) {
      lines.push(`## ${snapshot.main.path}`);
      lines.push(renderPlainText(markdownToBlocks(snapshot.main.body), limits.maxContextBytes));
      lines.push('');
    }
    const others = snapshot.files.filter((file) => file.path !== snapshot.main?.path);
    if (others.length > 0) {
      lines.push('## Other Copilot configuration files');
      for (const file of others) {
        const details = [
          file.kind,
          ...(file.applyTo === '' ? [] : [`applies to ${file.applyTo}`]),
          ...(file.description === '' ? [] : [file.description]),
        ].join(' · ');
        lines.push(`- ${file.path} — ${details}`);
      }
      lines.push('');
    }
    const invocable = snapshot.files.filter((file) => INVOCABLE_KINDS.includes(file.kind) && file.invoke !== '');
    if (invocable.length > 0) {
      lines.push('## Copilot entries the user can bring in with `/`');
      for (const file of invocable) {
        const details = [
          file.kind,
          ...(file.description === '' ? [] : [file.description]),
        ].join(' · ');
        lines.push(`- /${file.invoke} → ${file.path} — ${details}`);
      }
      lines.push('');
      lines.push('A pick arrives as a `<copilot_skill name="…" path="…">` or `<copilot_agent name="…" path="…">` '
        + 'block carrying that file\'s content; a bare `/name` the user typed names the same file — '
        + 'read it with the `copilot_config` tool (action: "read", path: "<path>") and follow it.');
    }
    lines.push('Read any of these files in full with the `copilot_config` tool (action: "read", path: "<path>").');
    return lines.join('\n');
  }

  return { limits, resolveRoot, scan, read, catalogOf, invocables, renderContext };
}

/**
 * Extract a message from an unknown error.
 *
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}
