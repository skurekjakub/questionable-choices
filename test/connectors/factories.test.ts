import { describe, expect, it } from 'vitest';
import { createIssueSource, createRepo, createRunner } from '../../src/connectors/index.js';
import { GitRepo } from '../../src/connectors/repos/git/index.js';
import { JiraIssueSource } from '../../src/connectors/issues/jira/index.js';
import type { RunnerConfig } from '../../src/core/types.js';
import { makeConnector, makeRepo, makeWorkspace } from '../core/helpers.js';

const RUNNER_CONFIG: RunnerConfig = {
  type: 'claude-tmux',
  claudeBin: 'claude',
  tmuxPrefix: 'qc',
  models: [{ id: 'claude-fable-5-1', label: 'Fable 5.1' }],
  defaultModel: 'claude-fable-5-1',
  defaultEffort: 'high',
  defaultPermissionMode: 'acceptEdits',
};

describe('the connector factories', () => {
  it('key an issue source to its workspace and a repo connector to its repo', () => {
    const issues = createIssueSource('docs-nextjs', makeConnector(), makeWorkspace(), {});
    const repo = createRepo('app', makeRepo());
    const runner = createRunner({
      config: RUNNER_CONFIG,
      port: 4400,
      dataDir: '/data',
      home: '/home/nobody',
    });

    expect(issues).toBeInstanceOf(JiraIssueSource);
    expect(repo).toBeInstanceOf(GitRepo);
    expect(issues.id).toBe('docs-nextjs');
    expect(repo.id).toBe('app');
    expect(runner.type).toBe('claude-tmux');
  });

  it('refuses a connector type it has no implementation for', () => {
    const connector = { ...makeConnector(), type: 'github' } as unknown as ReturnType<
      typeof makeConnector
    >;
    expect(() => createIssueSource('docs-nextjs', connector, makeWorkspace(), {})).toThrow(
      /unknown connector type/,
    );
  });
});
