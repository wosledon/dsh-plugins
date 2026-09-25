/**
 * `~/.ssh/config` 解析。
 *
 * 主机列表**从本机已有的 ssh 配置读**，而不是让用户在本插件里再填一遍
 * （主机名、端口、用户、私钥路径）——那些信息 ssh 自己已经有一份权威副本，
 * 重填一份只会产生"面板里写的是 A、ssh 实际连的是 B"这类偏差。
 *
 * 于是 `hostId` 就是 ssh config 里的 **Host 别名**，工具与面板共用同一个标识。
 *
 * ## 支持的指令
 *
 * `Host` / `HostName` / `User` / `Port` / `IdentityFile` / `ProxyJump` / `Include`
 * 之外的指令一律忽略（`Compression`、`ServerAliveInterval` 之类不影响"有哪些主机、
 * 怎么连"这件事，而且它们由 ssh 自己在连接时应用）。
 *
 * ## 关于通配
 *
 * `Host *` 这类块是**默认值**，不是一台主机；`!negation` 同理。只有含具体名字的
 * 块才会产出主机条目，并且把 `*` 块的设置合并进去——这正是 ssh 自己的语义。
 */

/** 把一行拆成"第一个词 + 其余"。`Keyword=value` 与 `Keyword value` 都支持。 */
function splitDirective(line) {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const equals = trimmed.indexOf('=');
  const space = trimmed.search(/\s/);
  let key;
  let rest;
  if (equals >= 0 && (space < 0 || equals < space)) {
    key = trimmed.slice(0, equals);
    rest = trimmed.slice(equals + 1);
  } else if (space >= 0) {
    key = trimmed.slice(0, space);
    rest = trimmed.slice(space + 1);
  } else {
    key = trimmed;
    rest = '';
  }
  // 值里的引号去掉，其余原样（路径可能含空格）。
  return { key: key.trim().toLowerCase(), value: rest.trim().replace(/^"(.*)"$/, '$1') };
}

/** 去掉行尾注释。`#` 在引号内不算注释。 */
function stripComment(line) {
  let inQuote = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') inQuote = !inQuote;
    else if (char === '#' && !inQuote) return line.slice(0, index);
  }
  return line;
}

/** 是否是通配模式（含 `*` 或 `?`），或否定模式（`!` 开头）。 */
const isWildcard = (pattern) => pattern.includes('*') || pattern.includes('?');
const isNegated = (pattern) => pattern.startsWith('!');

/** 把一串 Host 模式规整成 `{ concrete, wildcard }` 两组。 */
function classifyPatterns(patterns) {
  const concrete = [];
  const wildcard = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern === '') continue;
    if (isNegated(pattern) || isWildcard(pattern)) wildcard.push(pattern);
    else concrete.push(pattern);
  }
  return { concrete, wildcard };
}

/**
 * ssh 的 `Host` 模式匹配：只支持 `*` 与 `?`（`[a-z]` 字符组在 ssh config 里
 * 极少见，不支持时按字面处理比"猜一个不完整的实现"更可预测）。
 */
function globToRegExp(pattern) {
  let out = '^';
  for (const char of pattern) {
    if (char === '*') out += '.*';
    else if (char === '?') out += '.';
    else out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$', 'i');
}

/**
 * 一个 Host 块是否适用于某个别名。
 *
 * ssh 的规则是：块里**任一**正向模式命中，且**没有任何**否定模式命中。
 *
 * 这里必须是真匹配而不是"没具体名字就当默认值"——后者会把 `Host *.internal`
 * 这种带通配但**非全局**的块也当成默认，于是每台主机都被套上它的 `User`。
 * 真机含义是"用错误的用户去登录"，比列错主机严重得多。
 */
function blockMatches(alias, patterns) {
  let positive = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = (negated ? raw.slice(1) : raw).trim();
    if (pattern === '') continue;
    const hit = globToRegExp(pattern).test(alias);
    if (negated) {
      if (hit) return false;
    } else if (hit) {
      positive = true;
    }
  }
  return positive;
}

/**
 * 解析 ssh config 文本。
 *
 * @param {string} text
 * @returns {{ hosts: Array<object>, warnings: string[] }}
 *   `hosts` 每项：`{ id, alias, host, user, port, identityFile, proxyJump }`
 *   `id` 就是别名，工具与界面都用它引用主机。
 */
export function parseSshConfig(text) {
  const source = typeof text === 'string' ? text : '';
  const warnings = [];
  const blocks = [];
  let currentBlock = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line.trim() === '') continue;
    const directive = splitDirective(line);
    if (directive === null) continue;
    const { key, value } = directive;
    if (value === '' && key !== 'host') continue;

    if (key === 'host') {
      currentBlock = { patterns: value.split(/\s+/).filter((x) => x !== ''), settings: {} };
      blocks.push(currentBlock);
      continue;
    }
    if (currentBlock === null) {
      // 文件开头的指令（没有 Host 块）按 ssh 的语义属于隐式 `Host *`。
      currentBlock = { patterns: ['*'], settings: {} };
      blocks.push(currentBlock);
    }
    if (key === 'include') {
      // 不做递归展开：包含的文件可能是相对路径、可能带通配，展开规则容易做错，
      // 而做错的代价是"列出了不存在的主机"或"漏掉了真实的主机"。
      // 明确告知而不是假装没看见。
      warnings.push(`发现 Include（${value}）：本插件不展开包含文件，其中的主机不会出现在列表里。`);
      continue;
    }
    if (key === 'hostname') currentBlock.settings.host = value;
    else if (key === 'user') currentBlock.settings.user = value;
    else if (key === 'port') currentBlock.settings.port = value;
    else if (key === 'identityfile') currentBlock.settings.identityFile = value;
    else if (key === 'proxyjump') currentBlock.settings.proxyJump = value;
    // 其余指令忽略：它们不影响"有哪些主机"，ssh 连接时会自己应用。
  }

  const aliases = [];
  const seen = new Set();
  for (const block of blocks) {
    const { concrete } = classifyPatterns(block.patterns);
    for (const alias of concrete) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      aliases.push(alias);
    }
  }

  const hosts = [];
  for (const alias of aliases) {
    // 按文件顺序合并**所有匹配该别名的块**：后面的覆盖前面的，
    // 于是 `Host *` 天然成为默认值，而 `Host *.internal` 只影响它该影响的那些。
    const merged = {};
    for (const block of blocks) {
      if (blockMatches(alias, block.patterns)) Object.assign(merged, block.settings);
    }
    const port = Number.parseInt(String(merged.port ?? ''), 10);
    hosts.push({
      id: alias,
      alias,
      // `HostName` 缺省时 ssh 用别名本身作为主机名。
      host: typeof merged.host === 'string' && merged.host !== '' ? merged.host : alias,
      user: typeof merged.user === 'string' ? merged.user : '',
      port: Number.isFinite(port) && port > 0 && port <= 65535 ? port : 22,
      identityFile: typeof merged.identityFile === 'string' ? merged.identityFile : '',
      proxyJump: typeof merged.proxyJump === 'string' ? merged.proxyJump : '',
    });
  }
  hosts.sort((left, right) => left.alias.localeCompare(right.alias));
  return { hosts, warnings: Array.from(new Set(warnings)) };
}

/**
 * 把 ssh config 主机归一化成面板与工具共用的形状。
 *
 * 与 `normaliseHosts`（用户手填的那套）保留同样的字段，这样工具侧不需要知道
 * 主机是从哪来的——**一处来源，一种形状**。
 */
export function configHostsToHosts(hosts) {
  if (!Array.isArray(hosts)) return [];
  return hosts.map((host) => ({
    id: String(host.id),
    label: '',
    host: String(host.host),
    port: Number.isFinite(host.port) ? host.port : 22,
    user: typeof host.user === 'string' ? host.user : '',
    identityFile: typeof host.identityFile === 'string' ? host.identityFile : '',
    sshOptions: [],
    note: typeof host.proxyJump === 'string' && host.proxyJump !== '' ? `ProxyJump ${host.proxyJump}` : '',
    tags: [],
    alias: String(host.alias ?? host.id),
  }));
}
