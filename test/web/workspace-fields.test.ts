import { describe, expect, it } from 'vitest';
import { placeIssue } from '../../src/web/src/workspace-fields.js';

describe('placeIssue', () => {
  it('places every field the add-workspace request names', () => {
    expect(placeIssue('name')).toBe('name');
    expect(placeIssue('epic')).toBe('epic');
    expect(placeIssue('repo')).toBe('repo');
    expect(placeIssue('connector')).toBe('connector');
    expect(placeIssue('newConnector.id')).toBe('newConnector.id');
    expect(placeIssue('newConnector.site')).toBe('newConnector.site');
    expect(placeIssue('newConnector.emailEnv')).toBe('newConnector.emailEnv');
    expect(placeIssue('newConnector.tokenEnv')).toBe('newConnector.tokenEnv');
    expect(placeIssue('reviewStatuses')).toBe('reviewStatuses');
  });

  it('faults the whole list when one review status is refused', () => {
    expect(placeIssue('reviewStatuses[0]')).toBe('reviewStatuses');
    expect(placeIssue('reviewStatuses[11]')).toBe('reviewStatuses');
  });

  it('places a workspace-id clash on the name it is derived from', () => {
    expect(placeIssue('id')).toBe('name');
  });

  it('leaves a path that names no field for the dialog-wide note', () => {
    expect(placeIssue('jql')).toBeNull();
    expect(placeIssue('pollSeconds')).toBeNull();
    expect(placeIssue('workspaces')).toBeNull();
    expect(placeIssue('')).toBeNull();
  });

  it('does not resurrect the document locators the route stopped sending', () => {
    expect(placeIssue('workspaces.docs.epic')).toBeNull();
    expect(placeIssue('connectors.kentico-jira.site')).toBeNull();
  });
});
