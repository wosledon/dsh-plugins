/**
 * The agent-facing tool for `.github/` Copilot configuration.
 *
 * The definition is a plain object: the tool registry accepts a `ToolDefinition`
 * whose `parameters` and `output.schema` are already JSON Schema, so the plugin
 * needs no dependency on `@deepseek-ai/dsh-tools`.
 *
 * @module dsh-plugin-copilot-config/lib/tool
 */

/** Tool name the model calls. */
export const TOOL_NAME = 'copilot_config';

/** Static prompt section that points the model at the tool. */
export const SECTION_NAME = 'copilot-config';

/** Static prompt section text. */
export const SECTION_TEXT = [
  'This project may carry GitHub Copilot configuration under `.github/`:',
  '`.github/copilot-instructions.md` (repository-wide instructions),',
  '`.github/instructions/**/*.instructions.md` (path-scoped instructions with an `applyTo` frontmatter),',
  '`.github/prompts/*.prompt.md` (reusable prompts),',
  '`.github/skills/*/SKILL.md` (Agent Skills),',
  '`.github/chatmodes/*.chatmode.md` (custom chat modes), and `.github/agents/*.agent.md`.',
  'In the Web GUI the user can type `/` in the composer to bring one of the invocable entries',
  '(prompts, Agent Skills, chat modes, custom agents) into the conversation: a pick arrives as a',
  '`<copilot_skill name="…" path="…">…</copilot_skill>` or `<copilot_agent name="…" path="…">…</copilot_agent>`',
  'block carrying that file\'s content, and a bare `/name` the user typed names the same file.',
  `When the task touches code style, conventions, or a reusable prompt, call the \`${TOOL_NAME}\` tool`,
  'with `action: "list"` to see what exists and `action: "read"` with a `path` to read one file,',
  'then follow it. The project instructions loaded into your context already cover the main file;',
  'use the tool for the rest and for anything the context does not include.',
].join(' ');

/**
 * Build the tool definition.
 *
 * @param {ReturnType<import('./scan.js').createCopilotScanner>} scanner
 * @returns {Record<string, unknown>} a `ToolDefinition`
 */
export function createCopilotTool(scanner) {
  return {
    name: TOOL_NAME,
    description: 'Read the GitHub Copilot configuration of the current project from `.github/` '
      + '(repository instructions, path-scoped instructions, prompt files, Agent Skills, chat modes, and custom agents). '
      + 'Use action "list" to discover the files and action "read" with a repository-relative path to read one.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read'],
          description: '"list" returns every Copilot configuration file with its kind and applyTo scope; '
            + '"read" returns one file\'s content.',
        },
        path: {
          type: 'string',
          description: 'Repository-relative path of the file to read, for example ".github/instructions/typescript.instructions.md". Required for action "read".',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        description: 'The discovered files, or one file with its rendered content.',
      },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }];
      },
    },
    async execute(args, exec) {
      const reader = { agent: exec?.agent, signal: exec?.signal };
      if (args.action === 'list') {
        const snapshot = await scanner.scan(reader);
        return {
          root: snapshot.root,
          present: snapshot.present,
          files: snapshot.files.map((file) => ({
            path: file.path,
            kind: file.kind,
            title: file.title,
            ...(file.invoke === '' ? {} : { invoke: file.invoke }),
            ...(file.description === '' ? {} : { description: file.description }),
            ...(file.applyTo === '' ? {} : { applyTo: file.applyTo }),
            ...(file.mode === '' ? {} : { mode: file.mode }),
            bytes: file.bytes,
          })),
          invocable: scanner.catalogOf(snapshot),
          errors: snapshot.errors,
        };
      }
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      if (path === '') {
        const error = new Error('action "read" requires a repository-relative path');
        error.code = 'PATH_REQUIRED';
        throw error;
      }
      const file = await scanner.read(reader, path);
      return {
        path: file.path,
        kind: file.kind,
        title: file.title,
        ...(file.invoke === '' ? {} : { invoke: file.invoke }),
        ...(file.description === '' ? {} : { description: file.description }),
        ...(file.applyTo === '' ? {} : { applyTo: file.applyTo }),
        ...(file.mode === '' ? {} : { mode: file.mode }),
        bytes: file.bytes,
        text: file.text,
      };
    },
  };
}
