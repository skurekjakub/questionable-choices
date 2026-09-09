import type {
  BoardView,
  Card,
  CardSession,
  ConfigIssue,
  ConnectorSummary,
  EventFrame,
  IssueDetailResponse,
  PrefillResponse,
  PublicConfigResponse,
  RepoSummary,
  WorkspaceSummary,
} from '../../core/api.js';
import type { SessionRecord } from './model.js';

/**
 * Builds an ISO timestamp a number of seconds in the past.
 *
 * @param secondsAgo - How far back the timestamp should sit.
 * @returns The timestamp in ISO form.
 */
function ago(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

/**
 * Builds a prompt-cache state expiring a number of seconds from now.
 *
 * @param secondsLeft - Seconds until the cached prefix goes cold.
 * @param ttlSeconds - Cache lifetime in seconds.
 * @returns A warm cache state.
 */
function warmCache(secondsLeft: number, ttlSeconds: number): CardSession['cache'] {
  return {
    expiresAt: Math.floor(Date.now() / 1000) + secondsLeft,
    ttlSeconds,
    warm: true,
    source: 'statusline',
  };
}

/**
 * A cache that has already gone cold.
 */
const COLD_CACHE: CardSession['cache'] = {
  expiresAt: Math.floor(Date.now() / 1000) - 120,
  ttlSeconds: 300,
  warm: false,
  source: 'statusline',
};

/**
 * Builds a card session with the fields the board renders.
 *
 * @param overrides - Fields that differ from a plain working session.
 * @returns The session.
 */
function session(overrides: Partial<CardSession> & Pick<CardSession, 'id' | 'state'>): CardSession {
  const needsYou = ['waiting-permission', 'waiting-question', 'idle'].includes(overrides.state);
  const live = !['exited', 'failed'].includes(overrides.state);
  return {
    playbookId: 'implement',
    stateSince: ago(90),
    pending: null,
    cache: null,
    done: false,
    live,
    needsYou,
    branch: 'DOC-0000-mock',
    attachCommand: `tmux attach -t ${overrides.id}`,
    ...overrides,
  };
}

/**
 * Builds a card with plausible issue fields.
 *
 * @param key - Tracker key of the issue.
 * @param summary - One-line title.
 * @param overrides - Fields that differ from a plain backlog card.
 * @returns The card.
 */
function card(key: string, summary: string, overrides: Partial<Card> & Pick<Card, 'column'>): Card {
  const sessions = overrides.sessions ?? [];
  return {
    issue: {
      key,
      summary,
      type: 'Task',
      status: 'To Do',
      statusCategory: 'todo',
      labels: [],
      url: `https://kentico.atlassian.net/browse/${key}`,
      ...overrides.issue,
    },
    sessions,
    primaryPlaybookId: 'implement',
    worktreePath: null,
    flags: {},
    needsYou: sessions.some((entry) => entry.needsYou),
    ...overrides,
  };
}

/**
 * Cards for the primary mock workspace, one per interesting board state.
 *
 * @returns The cards, grouped by the lane they belong in.
 */
function docsCards(): Card[] {
  return [
    card('DOC-3847', 'Remove the duplicated frontmatter parser from the MDX loader', {
      column: 'needs-you',
      issue: {
        key: 'DOC-3847',
        summary: 'Remove the duplicated frontmatter parser from the MDX loader',
        type: 'Bug',
        status: 'In Progress',
        statusCategory: 'inprogress',
        labels: ['content-pipeline', 'tech-debt', 'next16', 'p2'],
        url: 'https://kentico.atlassian.net/browse/DOC-3847',
      },
      worktreePath: '/home/jakubs/repositories/worktrees/DOC-3847',
      sessions: [
        session({
          id: 'qc-DOC-3847-implement',
          state: 'waiting-permission',
          stateSince: ago(214),
          pending: { kind: 'permission', summary: 'Bash: rm -rf .next/cache' },
          cache: warmCache(168, 3600),
          branch: 'DOC-3847-remove-duplicated-frontmatter-parser',
        }),
      ],
    }),
    card('DOC-3852', 'Decide the cache policy for docsassets images', {
      column: 'needs-you',
      issue: {
        key: 'DOC-3852',
        summary: 'Decide the cache policy for docsassets images',
        type: 'Story',
        status: 'In Progress',
        statusCategory: 'inprogress',
        labels: ['caching', 'assets'],
        url: 'https://kentico.atlassian.net/browse/DOC-3852',
      },
      worktreePath: '/home/jakubs/repositories/worktrees/DOC-3852',
      sessions: [
        session({
          id: 'qc-DOC-3852-implement',
          state: 'waiting-question',
          stateSince: ago(96),
          pending: {
            kind: 'question',
            summary: 'Should immutable stay off for content-hashed image URLs?',
          },
          cache: warmCache(58, 300),
          branch: 'DOC-3852-cache-policy',
        }),
      ],
    }),
    card('DOC-3860', 'Document the unknown-path gate for new routes', {
      column: 'needs-you',
      issue: {
        key: 'DOC-3860',
        summary: 'Document the unknown-path gate for new routes',
        type: 'Task',
        status: 'In Progress',
        statusCategory: 'inprogress',
        labels: ['docs'],
        url: 'https://kentico.atlassian.net/browse/DOC-3860',
      },
      worktreePath: '/home/jakubs/repositories/worktrees/DOC-3860',
      sessions: [
        session({
          id: 'qc-DOC-3860-implement',
          state: 'idle',
          stateSince: ago(1420),
          cache: COLD_CACHE,
          branch: 'DOC-3860-unknown-path-gate',
        }),
      ],
    }),
    card('DOC-3841', 'Build the content indexes once per verify run', {
      column: 'working',
      issue: {
        key: 'DOC-3841',
        summary: 'Build the content indexes once per verify run',
        type: 'Task',
        status: 'In Progress',
        statusCategory: 'inprogress',
        labels: ['build', 'perf'],
        url: 'https://kentico.atlassian.net/browse/DOC-3841',
      },
      worktreePath: '/home/jakubs/repositories/worktrees/DOC-3841',
      sessions: [
        session({
          id: 'qc-DOC-3841-implement',
          state: 'working',
          stateSince: ago(38),
          cache: warmCache(2840, 3600),
          branch: 'DOC-3841-verify-indexes',
        }),
        session({
          id: 'qc-DOC-3841-test',
          playbookId: 'test',
          state: 'exited',
          stateSince: ago(5400),
          branch: 'DOC-3841-verify-indexes',
          done: true,
        }),
      ],
    }),
    card('DOC-3855', 'Surface unknown MDX tags in the dev issue badge', {
      column: 'working',
      issue: {
        key: 'DOC-3855',
        summary: 'Surface unknown MDX tags in the dev issue badge',
        type: 'Story',
        status: 'In Progress',
        statusCategory: 'inprogress',
        labels: ['dx'],
        url: 'https://kentico.atlassian.net/browse/DOC-3855',
      },
      sessions: [
        session({ id: 'qc-DOC-3855-implement', state: 'bootstrapping', stateSince: ago(12) }),
      ],
    }),
    card('DOC-3858', 'Add a regression test for the PPR 404 status', {
      column: 'working',
      issue: {
        key: 'DOC-3858',
        summary: 'Add a regression test for the PPR 404 status',
        type: 'Bug',
        status: 'In Progress',
        statusCategory: 'inprogress',
        labels: ['e2e'],
        url: 'https://kentico.atlassian.net/browse/DOC-3858',
      },
      sessions: [
        session({
          id: 'qc-DOC-3858-test',
          playbookId: 'test',
          state: 'starting',
          stateSince: ago(4),
        }),
      ],
    }),
    card('DOC-3862', 'Collapse the two icon hosts into one resolver', {
      column: 'backlog',
      issue: {
        key: 'DOC-3862',
        summary: 'Collapse the two icon hosts into one resolver',
        type: 'Task',
        status: 'To Do',
        statusCategory: 'todo',
        labels: ['icons', 'tech-debt'],
        url: 'https://kentico.atlassian.net/browse/DOC-3862',
      },
      sessions: [
        session({
          id: 'qc-DOC-3862-implement',
          state: 'failed',
          stateSince: ago(7200),
          branch: null,
        }),
      ],
    }),
    card('DOC-3871', 'Give the pipeline test-impact lists their own unit tests', {
      column: 'backlog',
      issue: {
        key: 'DOC-3871',
        summary: 'Give the pipeline test-impact lists their own unit tests',
        type: 'Task',
        status: 'To Do',
        statusCategory: 'todo',
        labels: ['pipeline'],
        url: 'https://kentico.atlassian.net/browse/DOC-3871',
      },
    }),
    card('DOC-3874', 'Retire the legacy redirect map now that nothing reads it', {
      column: 'backlog',
      issue: {
        key: 'DOC-3874',
        summary: 'Retire the legacy redirect map now that nothing reads it',
        type: 'Sub-task',
        status: 'To Do',
        statusCategory: 'todo',
        labels: ['redirects', 'cleanup', 'p3', 'sweep'],
        url: 'https://kentico.atlassian.net/browse/DOC-3874',
      },
    }),
    card('DOC-3833', 'Consolidate content-validation reporting', {
      column: 'review',
      issue: {
        key: 'DOC-3833',
        summary: 'Consolidate content-validation reporting',
        type: 'Story',
        status: 'Ready for review',
        statusCategory: 'inprogress',
        labels: ['validation'],
        url: 'https://kentico.atlassian.net/browse/DOC-3833',
      },
      primaryPlaybookId: 'test',
      worktreePath: '/home/jakubs/repositories/worktrees/DOC-3833',
      sessions: [
        session({
          id: 'qc-DOC-3833-implement',
          state: 'exited',
          stateSince: ago(9000),
          done: true,
          branch: 'DOC-3833-validation-reporting',
        }),
      ],
    }),
    card('DOC-3829', 'Fix the KentiCopilot migration-skills link', {
      column: 'review',
      issue: {
        key: 'DOC-3829',
        summary: 'Fix the KentiCopilot migration-skills link',
        type: 'Bug',
        status: 'In Progress',
        statusCategory: 'inprogress',
        labels: ['links'],
        url: 'https://kentico.atlassian.net/browse/DOC-3829',
      },
      primaryPlaybookId: 'test',
      flags: { review: true },
    }),
    card('DOC-3812', 'Add the dev-model variant containers to the MDX catalog', {
      column: 'done',
      issue: {
        key: 'DOC-3812',
        summary: 'Add the dev-model variant containers to the MDX catalog',
        type: 'Story',
        status: 'Done',
        statusCategory: 'done',
        labels: ['mdx'],
        url: 'https://kentico.atlassian.net/browse/DOC-3812',
      },
      primaryPlaybookId: null,
    }),
    card('DOC-3807', 'Turn on partial prefetching behind a flag', {
      column: 'done',
      issue: {
        key: 'DOC-3807',
        summary: 'Turn on partial prefetching behind a flag',
        type: 'Task',
        status: 'In Progress',
        statusCategory: 'inprogress',
        labels: ['next16'],
        url: 'https://kentico.atlassian.net/browse/DOC-3807',
      },
      primaryPlaybookId: null,
      flags: { done: true },
    }),
  ];
}

/**
 * Cards for the second mock workspace, so the switcher has somewhere to go.
 *
 * @returns The cards.
 */
function migrationCards(): Card[] {
  return [
    card('DOC-2791', 'Port the Jekyll includes that the MDX loader still shims', {
      column: 'backlog',
      issue: {
        key: 'DOC-2791',
        summary: 'Port the Jekyll includes that the MDX loader still shims',
        type: 'Story',
        status: 'To Do',
        statusCategory: 'todo',
        labels: ['migration'],
        url: 'https://kentico.atlassian.net/browse/DOC-2791',
      },
    }),
  ];
}

/**
 * Assembles a board view out of a flat list of cards.
 *
 * @param workspaceId - Id of the workspace the board belongs to.
 * @param name - Name shown in the switcher.
 * @param cards - Cards to lay out, each carrying the lane it belongs in.
 * @param sourceError - Message from the last failed refresh, or null.
 * @returns The board view.
 */
function buildBoard(
  workspaceId: string,
  name: string,
  cards: Card[],
  sourceError: string | null,
): BoardView {
  const lanes: { id: BoardView['columns'][number]['id']; name: string }[] = [
    { id: 'backlog', name: 'Backlog' },
    { id: 'working', name: 'Working' },
    { id: 'needs-you', name: 'Needs you' },
    { id: 'review', name: 'Review' },
    { id: 'done', name: 'Done' },
  ];
  const columns = lanes.map((lane) => {
    const laneCards = cards.filter((entry) => entry.column === lane.id);
    return { id: lane.id, name: lane.name, cards: laneCards, count: laneCards.length };
  });
  return {
    workspaceId,
    name,
    playbooks: [
      {
        id: 'implement',
        label: 'Implement',
        description: 'Works the issue on its own branch and opens a pull request.',
        isolation: 'worktree',
      },
      {
        id: 'test',
        label: 'Verify',
        description: 'Runs the QA flow against the branch the fix landed on.',
        isolation: 'issue-worktree',
      },
      {
        id: 'triage',
        label: 'Triage',
        description: 'Reads the issue and reports what it would take, changing nothing.',
        isolation: 'shared',
      },
    ],
    columns,
    sourceError,
    fetchedAt: ago(14),
    needsYouCount: cards.filter((entry) => entry.needsYou).length,
  };
}

/**
 * The mock's mutable board state, keyed by workspace id.
 */
const boards = new Map<string, BoardView>([
  [
    'docs-nextjs',
    buildBoard('docs-nextjs', 'Docs · Next.js', docsCards(), 'Jira returned 503 at 14:02.'),
  ],
  [
    'docs-migration',
    buildBoard('docs-migration', 'Docs · Next.js migration', migrationCards(), null),
  ],
]);

/**
 * The mock's mutable workspace list, in switcher order.
 */
const workspaces: WorkspaceSummary[] = [
  {
    id: 'docs-nextjs',
    name: 'Docs · Next.js',
    epic: 'DOC-3807',
    repo: 'docs-workspace',
    connector: 'kentico-jira',
  },
  {
    id: 'docs-migration',
    name: 'Docs · Next.js migration',
    epic: 'DOC-2778',
    repo: 'docs-workspace',
    connector: 'kentico-jira',
  },
];

/**
 * Repos the mock offers; the UI cannot add to these.
 */
const repos: RepoSummary[] = [
  { id: 'docs-workspace', path: '/home/jakubs/repositories/docs-workspace' },
];

/**
 * The mock's mutable connector list.
 */
const connectors: ConnectorSummary[] = [{ id: 'kentico-jira', site: 'kentico.atlassian.net' }];

/**
 * Open event sockets, so a scripted change can be pushed to every viewer.
 */
const eventSockets = new Set<MockSocket>();

/**
 * Pushes a frame to every open event socket.
 *
 * @param frame - Frame to deliver.
 * @returns Nothing.
 */
function broadcast(frame: EventFrame): void {
  for (const socket of eventSockets) socket.deliver(JSON.stringify(frame));
}

/**
 * A stand-in for a WebSocket that a script drives instead of a server.
 */
class MockSocket {
  /** Ready state constant for an open socket. */
  static readonly OPEN = 1;
  /** Ready state constant for a closed socket. */
  static readonly CLOSED = 3;
  /** Current ready state. */
  readyState = MockSocket.OPEN;
  /** Frame encoding the consumer asked for. */
  binaryType: 'arraybuffer' | 'blob' = 'blob';
  /** Called once the socket is considered open. */
  onopen: (() => void) | null = null;
  /** Called with each frame the mock delivers. */
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  /** Called when the socket closes. */
  onclose: (() => void) | null = null;
  /** Called when the socket errors; the mock never does. */
  onerror: (() => void) | null = null;
  /** Handler invoked with frames the consumer sends. */
  onSend: ((data: unknown) => void) | null = null;
  /** Handler invoked when the consumer closes the socket. */
  onDispose: (() => void) | null = null;

  /**
   * Delivers a frame to the consumer.
   *
   * @param data - Frame payload, as a string or an ArrayBuffer.
   * @returns Nothing.
   */
  deliver(data: string | ArrayBuffer): void {
    if (this.readyState !== MockSocket.OPEN) return;
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /**
   * Accepts a frame from the consumer.
   *
   * @param data - Frame payload the consumer sent.
   * @returns Nothing.
   */
  send(data: unknown): void {
    this.onSend?.(data);
  }

  /**
   * Closes the socket and notifies the consumer.
   *
   * @returns Nothing.
   */
  close(): void {
    if (this.readyState === MockSocket.CLOSED) return;
    this.readyState = MockSocket.CLOSED;
    this.onDispose?.();
    this.onclose?.();
  }
}

/**
 * Inner width of the permission dialog the terminal script draws.
 */
const BOX_WIDTH = 62;

/**
 * Frames one line inside the permission dialog's box.
 *
 * Padding is measured on the plain text, so escape sequences must be added by
 * this helper rather than baked into the argument.
 *
 * @param text - Plain text of the line, without any escape sequences.
 * @returns The line with its borders and padding.
 */
function boxLine(text: string): string {
  return `\x1b[33m│\x1b[0m${text.padEnd(BOX_WIDTH, ' ')}\x1b[33m│\x1b[0m`;
}

/**
 * Terminal output the mock replays on attach, standing in for a live TUI.
 */
const TERMINAL_SCRIPT = [
  '\x1b[90m$ claude --settings ~/.local/share/questionable-choices/sessions/qc-DOC-3847-implement/settings.json\x1b[0m',
  '',
  '\x1b[36m✻\x1b[0m Working on \x1b[1mDOC-3847\x1b[0m — remove the duplicated frontmatter parser',
  '',
  '  \x1b[32m✓\x1b[0m Read lib/content/loader/mdx-loader.tsx (412 lines)',
  '  \x1b[32m✓\x1b[0m Read lib/content/schema/parse.ts (88 lines)',
  '  \x1b[32m✓\x1b[0m Grep "matter(" across lib/ — 3 matches',
  '',
  '  Both call sites split the fence themselves. Collapsing them onto parse.ts',
  '  keeps one engine and one fence rule, which is what the convention asks for.',
  '',
  `\x1b[33m╭${'─'.repeat(BOX_WIDTH)}╮\x1b[0m`,
  boxLine('  Claude needs your permission to run:'),
  boxLine(''),
  boxLine('    rm -rf .next/cache'),
  boxLine(''),
  boxLine('   1. Yes     2. Yes, and do not ask again     3. No'),
  `\x1b[33m╰${'─'.repeat(BOX_WIDTH)}╯\x1b[0m`,
  '',
  '\x1b[90m  esc to interrupt · ctrl+r to expand\x1b[0m',
  '',
];

/**
 * Assembles the public configuration from the mock's mutable lists.
 *
 * @returns The configuration as `GET /api/config/public` reports it.
 */
function publicConfig(): PublicConfigResponse {
  return {
    workspaces: [...workspaces],
    repos: [...repos],
    connectors: [...connectors],
    runner: {
      models: [
        { id: 'claude-fable-5-1', label: 'Fable 5.1' },
        { id: 'claude-opus-5', label: 'Opus 5' },
        { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      ],
      defaults: { model: 'claude-fable-5-1', effort: 'high', permissionMode: 'acceptEdits' },
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      permissionModes: [
        'acceptEdits',
        'auto',
        'bypassPermissions',
        'manual',
        'dontAsk',
        'plan',
        'default',
      ],
    },
  };
}

/**
 * Issue keys the epic field accepts, matching the configuration schema.
 */
const EPIC_PATTERN = /^([A-Za-z][A-Za-z0-9]*-\d+|\d+)$/;

/**
 * Adds a workspace, and its connector when the request carries a new one.
 *
 * Refusals carry `issues` with the paths the server uses: bare field names for
 * the request's own checks, and dotted locators into the configuration
 * document for anything the schema rejects.
 *
 * @param body - Parsed request body.
 * @returns The 201 summary, or the 400 / 409 refusal the server would send.
 */
function createWorkspace(body: Record<string, unknown>): { status: number; body: unknown } {
  const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
  const epic = typeof body['epic'] === 'string' ? body['epic'].trim().toUpperCase() : '';
  const repo = typeof body['repo'] === 'string' ? body['repo'] : '';
  const newConnector = body['newConnector'] as Record<string, string> | undefined;
  const connector = typeof body['connector'] === 'string' ? body['connector'] : '';
  const id =
    typeof body['id'] === 'string' && body['id'].length > 0
      ? body['id']
      : name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
  const issues: ConfigIssue[] = [];
  if (name === '')
    issues.push({ path: `workspaces.${id}.name`, message: 'name must not be empty' });
  if (!EPIC_PATTERN.test(epic)) {
    issues.push({
      path: `workspaces.${id}.epic`,
      message: 'epic must be an issue key such as DOC-3807, or a numeric issue id',
    });
  }
  if (!repos.some((entry) => entry.id === repo)) {
    issues.push({ path: `workspaces.${id}.repo`, message: `no repo has id '${repo}'` });
  }
  if (workspaces.some((entry) => entry.id === id)) {
    issues.push({ path: 'id', message: `a workspace with id '${id}' already exists` });
  }
  if (newConnector !== undefined && connectors.some((entry) => entry.id === newConnector['id'])) {
    issues.push({
      path: 'newConnector.id',
      message: `a connector with id '${newConnector['id'] ?? ''}' already exists`,
    });
  }
  if (newConnector !== undefined && (newConnector['site'] ?? '') === '') {
    issues.push({
      path: `connectors.${newConnector['id'] ?? ''}.site`,
      message: 'site must not be empty',
    });
  }
  if (issues.length > 0) {
    return { status: 400, body: { error: 'Invalid workspace request', issues } };
  }
  let connectorId = connector;
  if (newConnector !== undefined) {
    connectorId = newConnector['id'] ?? '';
    connectors.push({ id: connectorId, site: newConnector['site'] ?? '' });
  }
  if (!connectors.some((entry) => entry.id === connectorId)) {
    return {
      status: 400,
      body: {
        error: 'Invalid workspace request',
        issues: [{ path: 'connector', message: `no connector has id '${connectorId}'` }],
      },
    };
  }
  const entry: WorkspaceSummary = { id, name, epic, repo, connector: connectorId };
  workspaces.push(entry);
  boards.set(id, buildBoard(id, name, [], null));
  broadcast({ type: 'config', config: publicConfig() });
  return { status: 201, body: entry };
}

/**
 * Removes the worktree a session ran in, refusing the way the server does.
 *
 * The server has three refusals and only one of them is forceable, so the mock
 * carries all three: a live session in the checkout and a missing worktree are
 * refused whatever `force` says, and only git's dirty-tree refusal names the
 * flag that gets past it.
 *
 * @param sessionId - Session naming the issue whose checkout should go.
 * @param force - Whether the owner asked to discard a dirty tree.
 * @returns The response body and status.
 */
function removeWorktree(sessionId: string, force: boolean): { status: number; body: unknown } {
  for (const board of boards.values()) {
    for (const card of board.columns.flatMap((column) => column.cards)) {
      const session = card.sessions.find((candidate) => candidate.id === sessionId);
      if (session === undefined) continue;
      if (card.worktreePath === null) {
        return { status: 409, body: { error: `${card.issue.key} has no worktree.` } };
      }
      const blocking = card.sessions.find((other) => other.live);
      if (blocking !== undefined) {
        return {
          status: 409,
          body: {
            error: `${blocking.id} is still ${blocking.state} in ${card.worktreePath}`,
            detail: 'kill the session before removing its worktree',
          },
        };
      }
      if (!force) {
        return {
          status: 409,
          body: {
            error: 'cannot remove the worktree.',
            detail: `fatal: '${card.worktreePath}' contains modified or untracked files, use --force to delete it`,
          },
        };
      }
      const path = card.worktreePath;
      card.worktreePath = null;
      broadcast({ type: 'board', workspaceId: board.workspaceId, view: board });
      return { status: 200, body: { path, removed: true } };
    }
  }
  return { status: 404, body: { error: `No session ${sessionId}` } };
}

/**
 * Answers a mock REST request.
 *
 * @param path - Path of the request, without the origin.
 * @param method - HTTP method.
 * @param body - Parsed request body, when the request carried one.
 * @returns The response body and status.
 */
function route(
  path: string,
  method: string,
  body: Record<string, unknown> | null,
): { status: number; body: unknown } {
  const [pathname, search = ''] = path.split('?');
  const parts = (pathname ?? '').split('/').filter((part) => part.length > 0);

  if (pathname === '/api/config/public') {
    return { status: 200, body: publicConfig() };
  }

  if (pathname === '/api/workspaces' && method === 'POST') {
    return createWorkspace(body ?? {});
  }

  if (
    parts[0] === 'api' &&
    parts[1] === 'workspaces' &&
    parts.length === 3 &&
    method === 'DELETE'
  ) {
    const workspaceId = decodeURIComponent(parts[2] ?? '');
    const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
    if (index < 0) return { status: 404, body: { error: `No workspace ${workspaceId}` } };
    workspaces.splice(index, 1);
    boards.delete(workspaceId);
    broadcast({ type: 'config', config: publicConfig() });
    return { status: 204, body: undefined };
  }

  if (parts[0] === 'api' && parts[1] === 'workspaces') {
    const workspaceId = parts[2] ?? '';
    const board = boards.get(workspaceId);
    if (board === undefined) return { status: 404, body: { error: `No workspace ${workspaceId}` } };

    if (parts[3] === 'board' || parts[3] === 'refresh') {
      return { status: 200, body: { ...board, fetchedAt: new Date().toISOString() } };
    }

    if (parts[3] === 'issues') {
      const key = decodeURIComponent(parts[4] ?? '');
      const found = board.columns
        .flatMap((column) => column.cards)
        .find((entry) => entry.issue.key === key);
      if (found === undefined) return { status: 404, body: { error: `No issue ${key}` } };

      if (parts[5] === undefined) {
        const detail: IssueDetailResponse = {
          issue: {
            ...found.issue,
            description: `As an owner I want ${found.issue.summary.toLowerCase()} so that the board\nstays honest about what is left to do.\n\nAcceptance criteria\n- The duplicated code path is gone and nothing imports it.\n- npm run verify is green.\n- The change is covered by a test that names the behaviour.\n\nReferences\n- ${found.issue.url}\n- docs/conventions/frontmatter-parsing.md`,
            assignee: 'Jakub Skurek',
            priority: 'Medium',
            updated: ago(3600),
          },
          sessions: found.sessions.map((entry) => mockRecord(workspaceId, found.issue.key, entry)),
          worktreePath: found.worktreePath,
          flags: found.flags,
        };
        return { status: 200, body: detail };
      }

      if (parts[5] === 'prefill') {
        const playbook = new URLSearchParams(search).get('playbook') ?? 'implement';
        const prefill: PrefillResponse = {
          prompt: `You are working on ${found.issue.key} — ${found.issue.summary}.\n\nRepository: kentico-docs-next\nBranch: ${found.issue.key}-${found.issue.summary.toLowerCase().split(' ').slice(0, 4).join('-')}\nWorktree: ${found.worktreePath ?? '(created on start)'}\n\nDescription\n${found.issue.summary}\n\nWhen you are done, add a Jira comment describing how to test the change.`,
          model: 'claude-opus-5',
          effort: playbook === 'triage' ? 'medium' : 'high',
          permissionMode: playbook === 'triage' ? 'plan' : 'acceptEdits',
          isolation: playbook === 'triage' ? 'shared' : 'worktree',
          warnings:
            board.sourceError === null
              ? []
              : ['Jira was unreachable at the last poll, so the issue text may be stale.'],
        };
        return { status: 200, body: prefill };
      }

      if (parts[5] === 'flags' && method === 'POST') {
        found.flags = { ...found.flags, ...(body ?? {}) };
        broadcast({ type: 'board', workspaceId, view: board });
        return { status: 200, body: found.flags };
      }

      if (parts[5] === 'open-editor' && method === 'POST') {
        if (found.worktreePath === null) {
          return { status: 409, body: { error: `${found.issue.key} has no worktree to open.` } };
        }
        return { status: 204, body: undefined };
      }

      if (parts[5] === 'sessions' && method === 'POST') {
        const id = `qc-${found.issue.key}-${String(body?.['playbookId'] ?? 'implement')}`;
        const started = session({
          id,
          state: 'bootstrapping',
          stateSince: new Date().toISOString(),
          playbookId: String(body?.['playbookId'] ?? 'implement'),
          branch: `${found.issue.key}-mock`,
        });
        found.sessions = [started, ...found.sessions.filter((entry) => entry.id !== id)];
        broadcast({ type: 'board', workspaceId, view: board });
        return { status: 200, body: mockRecord(workspaceId, found.issue.key, started) };
      }
    }
  }

  if (parts[0] === 'api' && parts[1] === 'sessions' && method === 'POST') {
    const sessionId = decodeURIComponent(parts[2] ?? '');
    const action = parts[3] ?? '';
    if (action === 'remove-worktree') return removeWorktree(sessionId, body?.['force'] === true);
    for (const board of boards.values()) {
      for (const entry of board.columns.flatMap((column) => column.cards)) {
        const found = entry.sessions.find((candidate) => candidate.id === sessionId);
        if (found === undefined) continue;
        const record = mockRecord(board.workspaceId, entry.issue.key, found);
        if (action === 'interrupt') record.state = 'idle';
        if (action === 'kill') record.state = 'exited';
        if (action === 'resume') record.state = 'starting';
        if (action === 'mark-done') record.done = true;
        if (action === 'unmark-done') record.done = false;
        found.state = record.state;
        found.stateSince = new Date().toISOString();
        found.done = record.done;
        // The board's own flags are derived from the state, so an action that
        // changes the state has to re-derive them or the card contradicts itself.
        found.live = !['exited', 'failed'].includes(found.state);
        found.needsYou = ['waiting-permission', 'waiting-question', 'idle'].includes(found.state);
        if (!found.needsYou) found.pending = null;
        entry.needsYou = entry.sessions.some((candidate) => candidate.needsYou);
        broadcast({ type: 'session', record });
        broadcast({ type: 'board', workspaceId: board.workspaceId, view: board });
        return { status: 200, body: record };
      }
    }
    return { status: 404, body: { error: `No session ${sessionId}` } };
  }

  return { status: 404, body: { error: `The mock has no route for ${method} ${path}` } };
}

/**
 * Reports which repo a workspace's sessions run in.
 *
 * @param workspaceId - Id of the workspace to look up.
 * @returns The repo id, falling back to the first configured repo.
 */
function repoFor(workspaceId: string): string {
  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  return workspace?.repo ?? repos[0]?.id ?? '';
}

/**
 * Expands a card session into the full record the detail routes return.
 *
 * @param workspaceId - Workspace whose board the session appears on.
 * @param issueKey - Issue the session works on.
 * @param entry - The card session to expand.
 * @returns A plausible session record.
 */
function mockRecord(workspaceId: string, issueKey: string, entry: CardSession): SessionRecord {
  return {
    id: entry.id,
    issueKey,
    playbookId: entry.playbookId,
    repoId: repoFor(workspaceId),
    cwd: `/home/jakubs/repositories/worktrees/${issueKey}`,
    branch: entry.branch,
    model: 'claude-opus-5',
    effort: 'high',
    permissionMode: 'acceptEdits',
    prompt: `You are working on ${issueKey}.`,
    claudeSessionId: entry.state === 'failed' ? null : '0f2a9c31-6f4d-4a19-9a4e-6c2f0f1c9a44',
    state: entry.state,
    stateSince: entry.stateSince,
    pending: entry.pending,
    lastAssistantMessage:
      entry.state === 'idle' ? 'Done. The duplicated parser is gone and verify is green.' : null,
    cache: entry.cache,
    createdAt: ago(9600),
    endedAt: entry.live ? null : ago(600),
    done: entry.done,
    archived: false,
    runs: [{ startedAt: ago(9600), kind: 'start', exitCode: entry.live ? null : 0 }],
  };
}

/**
 * Installs the offline mock: every `/api` request and both WebSocket endpoints
 * are answered from sample data instead of a server.
 *
 * Only paths under `/api` and `/ws` are intercepted, so the Vite dev client's
 * own socket and module requests keep working.
 *
 * @returns Nothing.
 */
export function installMock(): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  const RealSocket = globalThis.WebSocket;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
    if (!path.startsWith('/api')) return realFetch(input, init);
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : null;
    const parsed = raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    const answer = route(path, method, parsed);
    if (answer.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  /**
   * Stands in for the global WebSocket, mocking only the app's own endpoints.
   */
  class InterceptedSocket extends MockSocket {
    /**
     * Opens a mock socket, or a real one for any URL the mock does not own.
     *
     * @param url - URL the caller asked to connect to.
     */
    constructor(url: string | URL) {
      super();
      const href = typeof url === 'string' ? url : url.href;
      const path = new URL(href, window.location.href).pathname;
      if (!path.startsWith('/ws/')) return new RealSocket(href) as unknown as InterceptedSocket;
      if (path === '/ws/events') attachEvents(this);
      else attachTerminal(this);
    }
  }

  globalThis.WebSocket = InterceptedSocket as unknown as typeof WebSocket;

  // The scripted transition arrives after the first board has been rendered, so
  // the needs-you diff has a baseline and fires exactly one notification.
  window.setTimeout(() => {
    const board = boards.get('docs-nextjs');
    if (board === undefined) return;
    const working = board.columns.find((column) => column.id === 'working');
    const needsYou = board.columns.find((column) => column.id === 'needs-you');
    const moved = working?.cards.find((entry) => entry.issue.key === 'DOC-3841');
    const entry = moved?.sessions[0];
    if (
      working === undefined ||
      needsYou === undefined ||
      moved === undefined ||
      entry === undefined
    ) {
      return;
    }
    entry.state = 'waiting-permission';
    entry.stateSince = new Date().toISOString();
    entry.needsYou = true;
    entry.pending = { kind: 'permission', summary: 'Edit: scripts/verify.mjs' };
    moved.needsYou = true;
    moved.column = 'needs-you';
    working.cards = working.cards.filter((existing) => existing !== moved);
    working.count = working.cards.length;
    needsYou.cards = [moved, ...needsYou.cards];
    needsYou.count = needsYou.cards.length;
    board.needsYouCount = needsYou.count;
    board.fetchedAt = new Date().toISOString();
    broadcast({ type: 'board', workspaceId: 'docs-nextjs', view: board });
  }, 9000);
}

/**
 * Wires an event socket: it opens, registers for broadcasts, and unregisters on
 * close.
 *
 * @param socket - The socket to wire.
 * @returns Nothing.
 */
function attachEvents(socket: MockSocket): void {
  eventSockets.add(socket);
  socket.onDispose = () => eventSockets.delete(socket);
  window.setTimeout(() => socket.onopen?.(), 30);
}

/**
 * Wires a terminal socket: it replays a scripted TUI and echoes typed bytes.
 *
 * @param socket - The socket to wire.
 * @returns Nothing.
 */
function attachTerminal(socket: MockSocket): void {
  const encoder = new TextEncoder();
  const write = (text: string): void => {
    const bytes = encoder.encode(text);
    socket.deliver(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  socket.onSend = (data: unknown) => {
    if (typeof data === 'string') return;
    if (data instanceof Uint8Array) socket.deliver(data.buffer.slice(0) as ArrayBuffer);
  };
  window.setTimeout(() => {
    socket.onopen?.();
    write('\x1b[2J\x1b[H');
    for (const [index, line] of TERMINAL_SCRIPT.entries()) {
      window.setTimeout(() => write(`${line}\r\n`), 60 + index * 45);
    }
  }, 40);
}
