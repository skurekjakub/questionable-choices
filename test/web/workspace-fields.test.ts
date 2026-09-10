import { describe, expect, it } from 'vitest';
import {
  NEW_CONNECTOR_FIELDS,
  placeIssue,
  withoutFields,
} from '../../src/web/src/workspace-fields.js';

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

describe('withoutFields', () => {
  const issues = [
    { path: 'epic', message: 'epic must be an issue key' },
    { path: 'name', message: 'name must not be empty' },
    { path: 'newConnector.site', message: 'site must not be empty' },
  ];

  it('retires the problem of the field being edited and no other', () => {
    expect(withoutFields(issues, ['epic']).map((issue) => issue.path)).toEqual([
      'name',
      'newConnector.site',
    ]);
  });

  it('retires a problem the field owns under a path of its own', () => {
    const indexed = [{ path: 'reviewStatuses[2]', message: 'review status must not be empty' }];
    expect(withoutFields(indexed, ['reviewStatuses'])).toEqual([]);
    // The workspace id is shown against the name, so editing the name clears it.
    expect(withoutFields([{ path: 'id', message: 'already exists' }], ['name'])).toEqual([]);
  });

  it('keeps a problem that names no field, which no edit can answer', () => {
    const unplaced = [{ path: 'jql', message: 'jql must not be empty' }];
    expect(withoutFields(unplaced, ['epic'])).toEqual(unplaced);
    expect(withoutFields(unplaced, ['name'])).toEqual(unplaced);
  });

  it('leaves the order of what remains alone', () => {
    expect(withoutFields(issues, ['name']).map((issue) => issue.path)).toEqual([
      'epic',
      'newConnector.site',
    ]);
  });

  it('retires every field it is given at once, not just the first', () => {
    expect(withoutFields(issues, ['epic', 'name']).map((issue) => issue.path)).toEqual([
      'newConnector.site',
    ]);
  });

  it('retires nothing when given nothing', () => {
    expect(withoutFields(issues, [])).toEqual(issues);
  });
});

describe('NEW_CONNECTOR_FIELDS', () => {
  it('names every field that leaves the screen when the picker leaves “add a new issue source”', () => {
    const hidden = [
      { path: 'newConnector.id', message: 'id must not be empty' },
      { path: 'newConnector.site', message: 'site must not be empty' },
      { path: 'newConnector.emailEnv', message: 'emailEnv must not be empty' },
      { path: 'newConnector.tokenEnv', message: 'tokenEnv must not be empty' },
      { path: 'epic', message: 'epic must be an issue key' },
    ];
    expect(withoutFields(hidden, NEW_CONNECTOR_FIELDS).map((issue) => issue.path)).toEqual([
      'epic',
    ]);
  });
});
