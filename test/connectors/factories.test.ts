import { describe, expect, it } from 'vitest';
import { createIssueSource, createRunner, createWorkspace } from '../../src/connectors/index.js';
import { GitWorkspace } from '../../src/connectors/workspaces/git/index.js';
import { JiraIssueSource } from '../../src/connectors/issues/jira/index.js';
import type { RunnerConfig } from '../../src/core/types.js';
import { makeWorkspace } from '../core/helpers.js';

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
  it('build one connector per family, all keyed to the same workspace id', () => {
    const config = makeWorkspace();

    const issues = createIssueSource('docs', config.issues, {});
    const workspace = createWorkspace('docs', config);
    const runner = createRunner({
      config: RUNNER_CONFIG,
      port: 4400,
      dataDir: '/data',
      home: '/home/nobody',
    });

    expect(issues).toBeInstanceOf(JiraIssueSource);
    expect(workspace).toBeInstanceOf(GitWorkspace);
    expect(issues.id).toBe('docs');
    expect(workspace.id).toBe('docs');
    expect(runner.type).toBe('claude-tmux');
  });
});
