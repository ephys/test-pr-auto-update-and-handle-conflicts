import core from '@actions/core';
import github from '@actions/github';
import type { PullRequestEvent, PushEvent } from '@octokit/webhooks-types';
import { isString } from '@sequelize/utils';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFile = promisify(childProcess.execFile);

isString.assert(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN env must be provided');

/**
 * The default token is used for any action that does not require special permissions
 * that the GITHUB_TOKEN cannot provide, and for any action that does not require
 * triggering subsequent workflows.
 */
const githubBot = github.getOctokit(process.env.GITHUB_TOKEN);

/**
 * Used to update branches on pull requests that are owned by the repository.
 *
 * Can be any pat other than the GITHUB_TOKEN, as the GITHUB_TOKEN does not trigger
 * subsequent workflows.
 */
const updateBranchBot = process.env.UPDATE_BRANCH_PAT
  ? github.getOctokit(process.env.UPDATE_BRANCH_PAT)
  : githubBot;

/**
 * Used to update branches on pull requests that are not owned by the repository.
 *
 * We recommend using a user PAT for this, as:
 * - Using the GITHUB_TOKEN will not trigger subsequent workflows.
 * - Using a bot PAT will cause an error if the branch update includes a workflow file.
 *
 * This will need the following permissions:
 * - contents (read & write)
 * - workflows (read & write)
 */
const updateForkPat = process.env.UPDATE_FORK_PAT || process.env.GITHUB_TOKEN;
const updateForkUsername = process.env.UPDATE_FORK_USERNAME || 'x-access-token';

function getCommaSeparatedInput(name: string) {
  return core
    .getInput(name)
    .split(',')
    .map(label => label.trim())
    .filter(value => value.length > 0);
}

function getEnumInput<T extends string>(name: string, values: readonly T[]): T {
  const value = core.getInput(name);
  if (!values.includes(value as T)) {
    throw new Error(`${name} must be one of ${values.join(', ')}.`);
  }

  return value as T;
}

const READY_STATES = ['all', 'draft', 'ready_for_review'] as const;

const dryRun = core.getBooleanInput('dry-run');

const conflictLabel = core.getInput('conflict-label');
const conflictMarksAsDraft = core.getBooleanInput('conflict-marks-as-draft');
const conflictRequiresReadyState = getEnumInput('conflict-requires-ready-state', READY_STATES);
const conflictRequiresLabels = getCommaSeparatedInput('conflict-requires-labels');
const conflictExcludedLabels = getCommaSeparatedInput('conflict-excluded-labels');
const conflictExcludedAuthors = getCommaSeparatedInput('conflict-excluded-authors');

const updatePrBranches = core.getBooleanInput('update-pr-branches');
const updateRequiresAutoMerge = core.getBooleanInput('update-requires-auto-merge');
const updateRequiresReadyState = getEnumInput('update-requires-ready-state', READY_STATES);
const updateRequiresLabels = getCommaSeparatedInput('update-requires-labels');
const updateExcludedLabels = getCommaSeparatedInput('update-excluded-labels');
const updateExcludedAuthors = getCommaSeparatedInput('update-excluded-authors');
const updateRequiresSource = getEnumInput('update-requires-source', [
  'all',
  'fork',
  'branch',
] as const);

interface RepositoryId {
  owner: string;
  repo: string;
}

interface PullRequest {
  author: {
    __typename: 'Bot' | 'User' | string;
    login: string;
  };
  autoMergeRequest: null | {
    enabledAt: string;
  };
  baseRef: { name: string };
  baseRepository: {
    nameWithOwner: string;
  };
  headRef: { name: string };
  headRepository: {
    nameWithOwner: string;
  };
  isDraft: boolean;
  labels: {
    nodes: [
      {
        name: string;
      },
    ];
  };
  maintainerCanModify: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  number: number;
  viewerCanUpdateBranch: boolean;
}

const pullRequestFragment = `
fragment PR on PullRequest {
  author {
    __typename
    login
  }
  number
  mergeable
  isDraft
  autoMergeRequest {
    enabledAt
  }
  labels(first: 100) {
    nodes {
      name
    }
  }
  baseRef { name }
  headRef { name }
  headRepository {
    nameWithOwner
  }
  baseRepository {
    nameWithOwner
  }
  maintainerCanModify
  viewerCanUpdateBranch
}
`;

const updatedPrs: number[] = [];
const conflictedPrs: number[] = [];

switch (process.env.GITHUB_EVENT_NAME) {
  case 'push':
  case 'workflow_dispatch':
    await processPushEvent();
    break;

  case 'pull_request':
  case 'pull_request_target':
    await processPullRequestEvent();
    break;

  default:
    throw new Error(
      `Event ${process.env.GITHUB_EVENT_NAME} is not supported. Only push, workflow_dispatch, pull_request, and pull_request_target are supported.`,
    );
}

core.setOutput('updated-prs', updatedPrs.join(','));
core.setOutput('conflicted-prs', conflictedPrs.join(','));

async function processPushEvent() {
  isString.assert(process.env.GITHUB_EVENT_PATH);

  const { ref, repository } = JSON.parse(
    // @ts-expect-error -- JSON.parse accepts Buffers
    await fs.readFile(process.env.GITHUB_EVENT_PATH),
  ) as unknown as PushEvent;

  const HEADS_PREFIX = 'refs/heads/';
  if (!ref.startsWith(HEADS_PREFIX)) {
    return;
  }

  const targetBranch = ref.slice(HEADS_PREFIX.length);
  const repositoryId = {
    repo: repository.name,
    owner: repository.owner.name ?? repository.owner.login,
  } as const;

  const search = `repo:${repositoryId.owner}/${repositoryId.repo} is:open is:pr base:${targetBranch}`;
  for await (const pullRequest of iteratePullRequests({ search })) {
    console.info(`Handling PRs ${pullRequest.map(pr => pr.number).join(', ')}`);

    await Promise.all(pullRequest.map(async pr => processPr(repositoryId, pr)));
  }
}

async function processPullRequestEvent() {
  isString.assert(process.env.GITHUB_EVENT_PATH);

  const { number, repository } = JSON.parse(
    // @ts-expect-error -- JSON.parse accepts Buffers
    await fs.readFile(process.env.GITHUB_EVENT_PATH),
  ) as unknown as PullRequestEvent;

  const repositoryId = {
    repo: repository.name,
    owner: repository.owner.name ?? repository.owner.login,
  } as const;

  const pullRequest = await getPullRequest({ ...repositoryId, number });

  await processPr(repositoryId, pullRequest);
}

async function processPr(repositoryId: RepositoryId, pullRequest: PullRequest) {
  switch (pullRequest.mergeable) {
    case 'CONFLICTING':
      await handleConflict(repositoryId, pullRequest);
      break;

    case 'MERGEABLE': {
      const promises: Array<Promise<any>> = [
        removeConflictLabel(repositoryId, pullRequest),
        updatePrBranch(repositoryId, pullRequest),
      ];

      await Promise.all(promises);

      break;
    }

    case 'UNKNOWN': {
      console.info(`[PR ${pullRequest.number}] Conflict state is not yet known. Retrying.`);
      // Conflicting state has not been computed yet. Try again in one second
      await setTimeout(5000);

      const updatedPr = await getPullRequest({ ...repositoryId, number: pullRequest.number });
      await processPr(repositoryId, updatedPr);

      break;
    }
  }
}

function prHasAnyLabel(pullRequest: PullRequest, labels: string[]) {
  return pullRequest.labels.nodes.some(label => labels.includes(label.name));
}

async function updatePrBranch(repositoryId: RepositoryId, pullRequest: PullRequest) {
  if (!updatePrBranches) {
    return;
  }

  if (updateRequiresAutoMerge && !pullRequest.autoMergeRequest) {
    console.info(`[PR ${pullRequest.number}] Auto-merge is not enabled, skipping update.`);

    return;
  }

  if (updateRequiresLabels.length > 0 && !prHasAnyLabel(pullRequest, updateRequiresLabels)) {
    console.info(
      `[PR ${pullRequest.number}] Does not have any of the required labels (${updateRequiresLabels}), skipping update.`,
    );

    return;
  }

  if (updateExcludedLabels.length > 0 && prHasAnyLabel(pullRequest, updateExcludedLabels)) {
    console.info(
      `[PR ${pullRequest.number}] Has one of the excluded (${updateExcludedLabels}), skipping update.`,
    );

    return;
  }

  if (updateExcludedAuthors.includes(getUserIdentity(pullRequest.author))) {
    console.info(`[PR ${pullRequest.number}] Was created by an excluded author, skipping update.`);

    return;
  }

  if (!prMatchesReadyState(pullRequest, updateRequiresReadyState)) {
    console.info(`[PR ${pullRequest.number}] Not in the expected ready state, skipping update.`);

    return;
  }

  if (!prMatchesSource(pullRequest, updateRequiresSource)) {
    console.info(`[PR ${pullRequest.number}] Not from the expected source, skipping update.`);

    return;
  }

  if (isForkPr(pullRequest) && !pullRequest.maintainerCanModify) {
    console.info(
      `[PR ${pullRequest.number}] Fork PR refuses updates from maintainers, skipping update.`,
    );

    return;
  }

  // used to detect if branch is outdated. If the branch is up-to-date, this will be false.
  if (!pullRequest.viewerCanUpdateBranch) {
    console.info(`[PR ${pullRequest.number}] Viewer cannot update branch, skipping update.`);

    return;
  }

  updatedPrs.push(pullRequest.number);

  if (dryRun) {
    return;
  }

  // The "update-branch" endpoint does not allow modifying pull requests from repositories we do not own,
  // even if the "allow maintainers to modify" setting is enabled on the PR.
  if (!isForkPr(pullRequest)) {
    console.info(`[PR ${pullRequest.number}] ✅ Updating branch via API.`);

    // This operation cannot be done with GITHUB_TOKEN, as the GITHUB_TOKEN does not trigger subsequent workflows.
    return updateBranchBot.rest.pulls.updateBranch({
      ...repositoryId,
      pull_number: pullRequest.number,
    });
  }

  console.info(`[PR ${pullRequest.number}] ✅ Updating fork via git.`);

  // For fork PRs, we use git directly instead:
  // - Clone the repository in a new directory
  // - Merge the base branch into the PR branch
  // - Push the changes to the PR branch

  const targetDirectoryName = `pr-${pullRequest.number}`;
  const targetDirectoryPath = path.join(process.cwd(), targetDirectoryName);

  const forkRepositoryUrl = `https://${updateForkUsername}:${updateForkPat}@github.com/${pullRequest.headRepository.nameWithOwner}.git`;
  const parentRepositoryUrl = `https://${updateForkUsername}:${updateForkPat}@github.com/${pullRequest.baseRepository.nameWithOwner}.git`;

  // clone fork repository in the correct branch
  {
    const { stdout, stderr } = await execFile('git', [
      'clone',
      '--quiet',
      forkRepositoryUrl,
      targetDirectoryName,
      '--branch',
      pullRequest.headRef.name,
    ]);

    stdout && console.info(`[PR ${pullRequest.number}] ${stdout}`);
    stderr && console.error(`[PR ${pullRequest.number}] ${stderr}`);
  }

  // add parent repository as remote
  {
    const { stdout, stderr } = await execFile(
      'git',
      ['remote', 'add', 'parent', parentRepositoryUrl],
      {
        cwd: targetDirectoryPath,
      },
    );

    stdout && console.info(`[PR ${pullRequest.number}] ${stdout}`);
    stderr && console.error(`[PR ${pullRequest.number}] ${stderr}`);
  }

  // merge parent branch in local branch
  {
    const { stdout, stderr } = await execFile(
      'git',
      ['pull', '--quiet', 'parent', pullRequest.baseRef.name, '--no-edit', '--no-rebase'],
      {
        cwd: targetDirectoryPath,
      },
    );

    stdout && console.info(`[PR ${pullRequest.number}] ${stdout}`);
    stderr && console.error(`[PR ${pullRequest.number}] ${stderr}`);
  }

  {
    const { stdout, stderr } = await execFile(
      'git',
      ['push', '--quiet', 'origin', pullRequest.headRef.name],
      {
        cwd: targetDirectoryPath,
      },
    );

    stdout && console.info(`[PR ${pullRequest.number}] ${stdout}`);
    stderr && console.error(`[PR ${pullRequest.number}] ${stderr}`);
  }
}

async function handleConflict(repositoryId: RepositoryId, pullRequest: PullRequest): Promise<void> {
  if (!conflictLabel && !conflictMarksAsDraft) {
    return;
  }

  if (!isConflictManagementEnabledForPr(pullRequest)) {
    return;
  }

  conflictedPrs.push(pullRequest.number);

  const promises: Array<Promise<any>> = [];
  if (conflictLabel && !pullRequest.labels.nodes.some(label => label.name === conflictLabel)) {
    console.info(`[PR ${pullRequest.number}] ✅ Adding conflict label.`);

    if (!dryRun) {
      promises.push(
        githubBot.rest.issues.addLabels({
          ...repositoryId,
          issue_number: pullRequest.number,
          labels: [conflictLabel],
        }),
      );
    }
  }

  if (conflictMarksAsDraft) {
    console.info(`[PR ${pullRequest.number}] ✅ Marking as draft due to conflicts.`);

    if (!dryRun) {
      promises.push(
        githubBot.rest.pulls.update({
          ...repositoryId,
          pull_number: pullRequest.number,
          draft: true,
        }),
      );
    }
  }

  await Promise.all(promises);
}

async function removeConflictLabel(
  repositoryId: RepositoryId,
  pullRequest: PullRequest,
): Promise<void> {
  if (!conflictLabel) {
    return;
  }

  if (!pullRequest.labels.nodes.some(label => label.name === conflictLabel)) {
    return;
  }

  if (!isConflictManagementEnabledForPr(pullRequest)) {
    return;
  }

  console.info(`[PR ${pullRequest.number}] ✅ No conflict, removing conflict label.`);
  if (!dryRun) {
    await githubBot.rest.issues.removeLabel({
      ...repositoryId,
      issue_number: pullRequest.number,
      name: conflictLabel,
    });
  }
}

interface GetPrResponse {
  repository: {
    pullRequest: PullRequest;
  };
}

async function getPullRequest(params: { number: number; owner: string; repo: string }) {
  const response: GetPrResponse = await githubBot.graphql(
    `
      ${pullRequestFragment}

      query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            ...PR
          }
        }
      }
    `,
    params,
  );

  return response.repository.pullRequest;
}

interface IterateResponse {
  search: {
    nodes: [PullRequest];
    pageInfo: {
      endCursor: string;
      hasNextPage: boolean;
    };
  };
}

async function* iteratePullRequests(params: { search: string }) {
  let cursor = null;

  while (true) {
    // eslint-disable-next-line no-await-in-loop -- fine in async iterators
    const response: IterateResponse = await githubBot.graphql(
      `
        ${pullRequestFragment}

        query ($search: String!) {
          search(
            first: 100
            type: ISSUE
            query: $search
          ) {
            nodes {
              ...PR
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      `,
      {
        ...params,
        cursor,
      },
    );

    yield response.search.nodes;

    if (!response.search.pageInfo.hasNextPage) {
      break;
    }

    cursor = response.search.pageInfo.endCursor;
  }
}

function getUserIdentity(author: PullRequest['author']) {
  if (author.__typename === 'Bot') {
    return `app/${author.login}`;
  }

  return author.login;
}

function prMatchesReadyState(pullRequest: PullRequest, readyState: (typeof READY_STATES)[number]) {
  switch (readyState) {
    case 'all':
      return true;

    case 'draft':
      return pullRequest.isDraft;

    case 'ready_for_review':
      return !pullRequest.isDraft;
  }
}

function prMatchesSource(pullRequest: PullRequest, source: typeof updateRequiresSource) {
  switch (source) {
    case 'all':
      return true;

    case 'fork':
      return isForkPr(pullRequest);

    case 'branch':
      return !isForkPr(pullRequest);
  }
}

function isConflictManagementEnabledForPr(pullRequest: PullRequest) {
  if (!prMatchesReadyState(pullRequest, conflictRequiresReadyState)) {
    console.info(
      `[PR ${pullRequest.number}] Not in the expected ready state, skipping conflict handling.`,
    );

    return false;
  }

  if (conflictRequiresLabels.length > 0 && !prHasAnyLabel(pullRequest, conflictRequiresLabels)) {
    console.info(
      `[PR ${pullRequest.number}] Does not have any of the required labels (${conflictRequiresLabels}), skipping conflict handling.`,
    );

    return false;
  }

  if (conflictExcludedLabels.length > 0 && prHasAnyLabel(pullRequest, conflictExcludedLabels)) {
    console.info(
      `[PR ${pullRequest.number}] Has one of the excluded (${conflictExcludedLabels}), skipping conflict handling.`,
    );

    return false;
  }

  if (conflictExcludedAuthors.includes(getUserIdentity(pullRequest.author))) {
    console.info(
      `[PR ${pullRequest.number}] Was created by an excluded author, skipping conflict handling.`,
    );

    return false;
  }

  return true;
}

function isForkPr(pullRequest: PullRequest) {
  return pullRequest.baseRepository.nameWithOwner !== pullRequest.headRepository.nameWithOwner;
}
