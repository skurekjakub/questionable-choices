import type {
  ConnectorConfig,
  Issue,
  Playbook,
  RepoConfig,
  SessionRecord,
  WorkspaceConfig,
} from '../../src/core/types.js';

/**
 * Builds an issue with sensible defaults for tests.
 *
 * @param overrides - Fields to replace on the default issue.
 * @returns The issue.
 */
export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    key: 'DOC-1',
    summary: 'Document the thing',
    type: 'Task',
    status: 'To Do',
    statusCategory: 'todo',
    labels: [],
    url: 'https://example.atlassian.net/browse/DOC-1',
    ...overrides,
  };
}

/**
 * Builds a session record with sensible defaults for tests.
 *
 * @param overrides - Fields to replace on the default record.
 * @returns The record.
 */
export function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'qc-DOC-1-implement',
    issueKey: 'DOC-1',
    playbookId: 'implement',
    repoId: 'app',
    cwd: '/repos/worktrees/DOC-1',
    branch: 'DOC-1-document-the-thing',
    model: 'claude-fable-5-1',
    effort: 'high',
    permissionMode: 'acceptEdits',
    prompt: 'do the thing',
    claudeSessionId: null,
    state: 'starting',
    stateSince: '2026-09-09T10:00:00.000Z',
    pending: null,
    lastAssistantMessage: null,
    cache: null,
    createdAt: '2026-09-09T10:00:00.000Z',
    endedAt: null,
    done: false,
    archived: false,
    runs: [{ startedAt: '2026-09-09T10:00:00.000Z', kind: 'start', exitCode: null }],
    ...overrides,
  };
}

/**
 * Builds a playbook with sensible defaults for tests.
 *
 * @param overrides - Fields to replace on the default playbook.
 * @returns The playbook.
 */
export function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: 'implement',
    label: 'Implement',
    description: 'Start the feature workflow.',
    isolation: 'worktree',
    primaryFor: ['backlog', 'working', 'needs-you'],
    promptTemplate: 'Work on {{key}}',
    ...overrides,
  };
}

/**
 * Builds a workspace configuration with sensible defaults for tests.
 *
 * @param overrides - Fields to replace on the default workspace.
 * @returns The workspace configuration.
 */
export function makeWorkspace(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    name: 'Docs',
    epic: 'DOC-100',
    connector: 'tracker',
    repo: 'app',
    reviewStatuses: ['Ready for review'],
    pollSeconds: 120,
    ...overrides,
  };
}

/**
 * Builds a repo configuration with sensible defaults for tests.
 *
 * @param overrides - Fields to replace on the default repo.
 * @returns The repo configuration.
 */
export function makeRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    path: '/repos/app',
    worktreeDir: '/repos/worktrees',
    baseRef: 'origin/main',
    branchPattern: '{{key}}-{{slug}}',
    playbooks: [
      makePlaybook(),
      makePlaybook({ id: 'test', label: 'Test', primaryFor: ['review'] }),
    ],
    ...overrides,
  };
}

/**
 * Builds a connector configuration with sensible defaults for tests.
 *
 * @param overrides - Fields to replace on the default connector.
 * @returns The connector configuration.
 */
export function makeConnector(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    type: 'jira',
    site: 'example.atlassian.net',
    emailEnv: 'JIRA_EMAIL',
    tokenEnv: 'JIRA_TOKEN',
    ...overrides,
  };
}
