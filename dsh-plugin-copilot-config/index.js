/**
 * Host half of the Copilot configuration plugin.
 *
 * The plugin reads the GitHub Copilot style configuration a project carries in
 * `.github/` and makes it available to three readers:
 *
 * - the agent, through a `copilot_config` tool and a per-Session prompt section
 *   built from the project's own instructions;
 * - the Web UI, through a token-protected local HTTP API;
 * - nothing else — there is no polling, cache, or background watcher. Every read
 *   is triggered by an agent, a tool call, or a page load.
 *
 * @module dsh-plugin-copilot-config
 */

import { randomBytes } from 'node:crypto';

import { createCopilotScanner } from './lib/scan.js';
import { createCopilotApi } from './lib/server.js';
import { createCopilotTool, SECTION_NAME, SECTION_TEXT } from './lib/tool.js';

/** Prompt-section order for the static pointer section. */
const STATIC_SECTION_ORDER = 900;

/** Prompt-section order for the per-project instructions section. */
const PROJECT_SECTION_ORDER = 880;

export const inject = ['fs', 'sessions', 'workingDirectory', 'tools', 'systemPrompt'];

/**
 * Activate the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const log = (message, error) => {
    try {
      const logger = ctx.logger;
      if (logger !== undefined && logger !== null && typeof logger.warn === 'function') {
        logger.warn(message, error);
      }
    } catch {
      /* keep quiet when the logger is unavailable */
    }
  };

  const scanner = createCopilotScanner({
    fs: ctx.fs,
    sessions: ctx.sessions,
    workingDirectory: ctx.workingDirectory,
    log,
  });

  // Agent tool: the model reads the configuration on demand.
  ctx.effect(() => ctx.tools.register(createCopilotTool(scanner)), 'copilot-config: tool');

  // Static section: tells the model the configuration exists and how to read it.
  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: STATIC_SECTION_ORDER,
    text: SECTION_TEXT,
  }), 'copilot-config: prompt section');

  // Per-Session section: the project's own instructions, loaded once per agent.
  const projectSections = new Map();
  ctx.effect(() => {
    const offCreated = ctx.on('agent/created', async (payload) => {
      const agent = payload?.agent;
      if (agent === undefined || agent.ctx === undefined) return;
      try {
        const snapshot = await scanner.scan({ agent });
        const text = scanner.renderContext(snapshot);
        if (text === '') return;
        const dispose = agent.ctx.effect(() => agent.ctx.systemPrompt.section({
          name: `${SECTION_NAME}:project`,
          order: PROJECT_SECTION_ORDER,
          text,
        }), 'copilot-config: project instructions');
        const previous = projectSections.get(agent);
        if (typeof previous === 'function') previous();
        projectSections.set(agent, dispose);
      } catch (error) {
        log('copilot-config: project instructions unavailable', error);
      }
    });
    const offDisposed = ctx.on('agent/disposed', (payload) => {
      const agent = payload?.agent;
      const dispose = projectSections.get(agent);
      if (typeof dispose === 'function') dispose();
      projectSections.delete(agent);
    });
    return () => {
      offCreated();
      offDisposed();
      for (const dispose of projectSections.values()) dispose();
      projectSections.clear();
    };
  }, 'copilot-config: agents');

  // Web UI API: registered only where a web server exists.
  const token = randomBytes(24).toString('hex');
  const api = createCopilotApi({ scanner, token, log });
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'prefix',
        path: api.prefix,
        handler: api.handler,
      }),
      'copilot-config: api route',
    );
  });
}
