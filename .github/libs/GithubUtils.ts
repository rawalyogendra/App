import * as core from '@actions/core';
import {getOctokitOptions, GitHub} from '@actions/github/lib/utils';
import type {Octokit as OctokitCore} from '@octokit/core';
import type {PaginateInterface} from '@octokit/plugin-paginate-rest';
import {paginateRest} from '@octokit/plugin-paginate-rest';
import {throttling} from '@octokit/plugin-throttling';
import _ from 'underscore';
import {isEmptyObject} from '@src/types/utils/EmptyObject';
import type {Constructor} from '@octokit/core/dist-types/types'
import type {Api} from '@octokit/plugin-rest-endpoint-methods/dist-types/types'
import type {RestEndpointMethods} from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/method-types'
import type {graphql} from '@octokit/graphql/dist-types/types'
import type {RestEndpointMethodTypes} from '@octokit/plugin-rest-endpoint-methods/dist-types/generated/parameters-and-response-types'
import CONST from './CONST';

const GITHUB_BASE_URL_REGEX = new RegExp('https?://(?:github\\.com|api\\.github\\.com)');
const PULL_REQUEST_REGEX = new RegExp(`${GITHUB_BASE_URL_REGEX.source}/.*/.*/pull/([0-9]+).*`);
const ISSUE_REGEX = new RegExp(`${GITHUB_BASE_URL_REGEX.source}/.*/.*/issues/([0-9]+).*`);
const ISSUE_OR_PULL_REQUEST_REGEX = new RegExp(`${GITHUB_BASE_URL_REGEX.source}/.*/.*/(?:pull|issues)/([0-9]+).*`);

/**
 * The standard rate in ms at which we'll poll the GitHub API to check for status changes.
 * It's 10 seconds :)
 */
const POLL_RATE = 10000;

type OctokitOptions = {method: string; url: string; request: {retryCount: number}};

// (params?: RestEndpointMethodTypes["issues"]["listForRepo"]["parameters"]): Promise<RestEndpointMethodTypes["issues"]["listForRepo"]["response"]>;
type ListForRepoResult = RestEndpointMethodTypes["issues"]["listForRepo"]["response"]
type Unpacked<T> = T extends Array<infer U> ? U : T;
type ListForRepoDataItem = Unpacked<Pick<ListForRepoResult, 'data'>>

class GithubUtils {
    // static internalOctokit: OctokitCore & {paginate: PaginateInterface};
    // static internalOctokit: OctokitCore & {paginate: PaginateInterface} & import("@octokit/core/dist-types/types").Constructor<import("@octokit/plugin-rest-endpoint-methods/dist-types/types").Api & {
    //     paginate: import("@octokit/plugin-paginate-rest").PaginateInterface;
    // }>;
    // static internalOctokit: OctokitCore & Constructor<Api & {paginate: PaginateInterface}>
    static internalOctokit: OctokitCore & Api & {paginate: PaginateInterface}

    /**
     * Initialize internal octokit
     *
     * @private
     */
    static initOctokit() {
        const Octokit = GitHub.plugin(throttling, paginateRest);
        const token = core.getInput('GITHUB_TOKEN', {required: true});

        // Save a copy of octokit used in this class
        this.internalOctokit = new Octokit(
            getOctokitOptions(token, {
                throttle: {
                    retryAfterBaseValue: 2000,
                    onRateLimit: (retryAfter: number, options: OctokitOptions) => {
                        console.warn(`Request quota exhausted for request ${options.method} ${options.url}`);

                        // Retry five times when hitting a rate limit error, then give up
                        if (options.request.retryCount <= 5) {
                            console.log(`Retrying after ${retryAfter} seconds!`);
                            return true;
                        }
                    },
                    onAbuseLimit: (retryAfter: number, options: OctokitOptions) => {
                        // does not retry, only logs a warning
                        console.warn(`Abuse detected for request ${options.method} ${options.url}`);
                    },
                },
            }),
        );
    }

    /**
     * Either give an existing instance of Octokit rest or create a new one
     *
     * @readonly
     * @static
     * @memberof GithubUtils
     */
    static get octokit(): RestEndpointMethods {
        if (this.internalOctokit) {
            return this.internalOctokit.rest;
        }
        this.initOctokit();
        // @ts-expect-error -- TODO: Fix this
        return this.internalOctokit.rest as RestEndpointMethods;
    }

    /**
     * Get the graphql instance from internal octokit.
     * @readonly
     * @static
     * @memberof GithubUtils
     */
    static get graphql() {
        if (this.internalOctokit) {
            return this.internalOctokit.graphql;
        }
        this.initOctokit();
        // @ts-expect-error -- TODO: Fix this
        return this.internalOctokit.graphql as graphql;
    }

    /**
     * Either give an existing instance of Octokit paginate or create a new one
     *
     * @readonly
     * @static
     * @memberof GithubUtils
     */
    static get paginate() {
        if (this.internalOctokit) {
            return this.internalOctokit.paginate;
        }
        this.initOctokit();
        // @ts-expect-error -- TODO: Fix this
        return this.internalOctokit.paginate as PaginateInterface;
    }

    /**
     * Finds one open `StagingDeployCash` issue via GitHub octokit library.
     *
     * @returns
     */
    static getStagingDeployCash() {
        return this.octokit.issues
            .listForRepo({
                owner: CONST.GITHUB_OWNER,
                repo: CONST.APP_REPO,
                labels: CONST.LABELS.STAGING_DEPLOY,
                state: 'open',
            })
            .then(({data}: ListForRepoResult) => {
                if (!data.length) {
                    const error = new Error(`Unable to find ${CONST.LABELS.STAGING_DEPLOY} issue.`);
                    error.code = 404;
                    throw error;
                }

                if (data.length > 1) {
                    const error = new Error(`Found more than one ${CONST.LABELS.STAGING_DEPLOY} issue.`);
                    error.code = 500;
                    throw error;
                }

                return this.getStagingDeployCashData(data[0]);
            });
    }

    /**
     * Takes in a GitHub issue object and returns the data we want.
     *
     * @param issue
     * @returns
     */
    static getStagingDeployCashData(issue) {
        try {
            const versionRegex = new RegExp('([0-9]+)\\.([0-9]+)\\.([0-9]+)(?:-([0-9]+))?', 'g');
            const tag = issue.body.match(versionRegex)[0].replace(/`/g, '');
            return {
                title: issue.title,
                url: issue.url,
                number: this.getIssueOrPullRequestNumberFromURL(issue.url),
                labels: issue.labels,
                PRList: this.getStagingDeployCashPRList(issue),
                deployBlockers: this.getStagingDeployCashDeployBlockers(issue),
                internalQAPRList: this.getStagingDeployCashInternalQA(issue),
                isTimingDashboardChecked: /-\s\[x]\sI checked the \[App Timing Dashboard]/.test(issue.body),
                isFirebaseChecked: /-\s\[x]\sI checked \[Firebase Crashlytics]/.test(issue.body),
                isGHStatusChecked: /-\s\[x]\sI checked \[GitHub Status]/.test(issue.body),
                tag,
            };
        } catch (exception) {
            throw new Error(`Unable to find ${CONST.LABELS.STAGING_DEPLOY} issue with correct data.`);
        }
    }

    /**
     * Parse the PRList and Internal QA section of the StagingDeployCash issue body.
     *
     * @private
     *
     * @param issue
     * @returns - [{url: String, number: Number, isVerified: Boolean}]
     */
    static getStagingDeployCashPRList(issue) {
        let PRListSection = issue.body.match(/pull requests:\*\*\r?\n((?:-.*\r?\n)+)\r?\n\r?\n?/) || [];
        if (PRListSection.length !== 2) {
            // No PRs, return an empty array
            console.log('Hmmm...The open StagingDeployCash does not list any pull requests, continuing...');
            return [];
        }
        PRListSection = PRListSection[1];
        const PRList = [...PRListSection.matchAll(new RegExp(`- \\[([ x])] (${PULL_REQUEST_REGEX.source})`, 'g'))].map((match) => ({
            url: match[2],
            number: Number.parseInt(match[3], 10),
            isVerified: match[1] === 'x',
        }));
        // eslint-disable-next-line no-nested-ternary
        return PRList.sort((a, b) => (a.number > b.number) ? 1 : ((b.number > a.number) ? -1 : 0))
    }

    /**
     * Parse DeployBlocker section of the StagingDeployCash issue body.
     *
     * @private
     *
     * @param issue
     * @returns - [{URL: String, number: Number, isResolved: Boolean}]
     */
    static getStagingDeployCashDeployBlockers(issue) {
        let deployBlockerSection = issue.body.match(/Deploy Blockers:\*\*\r?\n((?:-.*\r?\n)+)/) || [];
        if (deployBlockerSection.length !== 2) {
            return [];
        }
        deployBlockerSection = deployBlockerSection[1];
        const deployBlockers = [...deployBlockerSection.matchAll(new RegExp(`- \\[([ x])]\\s(${ISSUE_OR_PULL_REQUEST_REGEX.source})`, 'g'))].map((match) => ({
            url: match[2],
            number: Number.parseInt(match[3], 10),
            isResolved: match[1] === 'x',
        }));
        // eslint-disable-next-line no-nested-ternary
        return deployBlockers.sort((a, b) => (a.number > b.number) ? 1 : ((b.number > a.number) ? -1 : 0));
    }

    /**
     * Parse InternalQA section of the StagingDeployCash issue body.
     *
     * @private
     *
     * @param issue
     * @returns - [{URL: String, number: Number, isResolved: Boolean}]
     */
    static getStagingDeployCashInternalQA(issue) {
        let internalQASection = issue.body.match(/Internal QA:\*\*\r?\n((?:- \[[ x]].*\r?\n)+)/) || [];
        if (internalQASection.length !== 2) {
            return [];
        }
        internalQASection = internalQASection[1];
        const internalQAPRs = [...internalQASection.matchAll(new RegExp(`- \\[([ x])]\\s(${PULL_REQUEST_REGEX.source})`, 'g'))].map((match) => ({
            url: match[2].split('-')[0].trim(),
            number: Number.parseInt(match[3], 10),
            isResolved: match[1] === 'x',
        }));
        // eslint-disable-next-line no-nested-ternary
        return internalQAPRs.sort((a, b) => (a.number > b.number) ? 1 : ((b.number > a.number) ? -1 : 0));
    }

    /**
     * Generate the issue body for a StagingDeployCash.
     *
     * @param tag
     * @param PRList - The list of PR URLs which are included in this StagingDeployCash
     * @param [verifiedPRList] - The list of PR URLs which have passed QA.
     * @param [deployBlockers] - The list of DeployBlocker URLs.
     * @param [resolvedDeployBlockers] - The list of DeployBlockers URLs which have been resolved.
     * @param [resolvedInternalQAPRs] - The list of Internal QA PR URLs which have been resolved.
     * @param [isTimingDashboardChecked]
     * @param [isFirebaseChecked]
     * @param [isGHStatusChecked]
     * @returns
     */
    static generateStagingDeployCashBody(
        tag: string,
        PRList: string[],
        verifiedPRList: string[] = [],
        deployBlockers: string[] = [],
        resolvedDeployBlockers: string[] = [],
        resolvedInternalQAPRs: string[] = [],
        isTimingDashboardChecked = false,
        isFirebaseChecked = false,
        isGHStatusChecked = false,
    ) {
        return this.fetchAllPullRequests(PRList.map(this.getPullRequestNumberFromURL))
            .then((data) => {
                // The format of this map is following:
                // {
                //    'https://github.com/Expensify/App/pull/9641': 'PauloGasparSv',
                //    'https://github.com/Expensify/App/pull/9642': 'mountiny'
                // }
                const internalQAPRMap = data
                    .filter((pr) => !isEmptyObject(_.findWhere(pr.labels, {name: CONST.LABELS.INTERNAL_QA})))
                    .reduce((map, pr) => {
                        // eslint-disable-next-line no-param-reassign
                        map[pr.html_url] = pr.merged_by.login;
                        return map;
                    }, {});
                console.log('Found the following Internal QA PRs:', internalQAPRMap);

                const noQAPRs = _.pluck(
                    data.filter((PR) => /\[No\s?QA]/i.test(PR.title)),
                    'html_url',
                );
                console.log('Found the following NO QA PRs:', noQAPRs);
                const verifiedOrNoQAPRs = _.union(verifiedPRList, noQAPRs);

                const sortedPRList = _.chain(PRList).difference(Object.keys(internalQAPRMap)).unique().sortBy(GithubUtils.getPullRequestNumberFromURL).value();
                const sortedDeployBlockers = [...new Set(deployBlockers)].sort(GithubUtils.getIssueOrPullRequestNumberFromURL);

                // Tag version and comparison URL
                // eslint-disable-next-line max-len
                let issueBody = `**Release Version:** \`${tag}\`\r\n**Compare Changes:** https://github.com/Expensify/App/compare/production...staging\r\n`;

                // PR list
                if (!isEmptyObject(sortedPRList)) {
                    issueBody += '\r\n**This release contains changes from the following pull requests:**\r\n';
                    sortedPRList.forEach((URL) => {
                        issueBody += verifiedOrNoQAPRs.includes(URL) ? '- [x]' : '- [ ]';
                        issueBody += ` ${URL}\r\n`;
                    });
                    issueBody += '\r\n\r\n';
                }

                // Internal QA PR list
                if (!isEmptyObject(internalQAPRMap)) {
                    console.log('Found the following verified Internal QA PRs:', resolvedInternalQAPRs);
                    issueBody += '**Internal QA:**\r\n';
                    internalQAPRMap.each((merger, URL) => {
                        const mergerMention = `@${merger}`;
                        issueBody += `${resolvedInternalQAPRs.includes(URL) ? '- [x]' : '- [ ]'} `;
                        issueBody += `${URL}`;
                        issueBody += ` - ${mergerMention}`;
                        issueBody += '\r\n';
                    });
                    issueBody += '\r\n\r\n';
                }

                // Deploy blockers
                if (!isEmptyObject(deployBlockers)) {
                    issueBody += '**Deploy Blockers:**\r\n';
                    sortedDeployBlockers.forEach((URL) => {
                        issueBody += resolvedDeployBlockers.includes(URL) ? '- [x] ' : '- [ ] ';
                        issueBody += URL;
                        issueBody += '\r\n';
                    });
                    issueBody += '\r\n\r\n';
                }

                issueBody += '**Deployer verifications:**';
                // eslint-disable-next-line max-len
                issueBody += `\r\n- [${
                    isTimingDashboardChecked ? 'x' : ' '
                }] I checked the [App Timing Dashboard](https://graphs.expensify.com/grafana/d/yj2EobAGz/app-timing?orgId=1) and verified this release does not cause a noticeable performance regression.`;
                // eslint-disable-next-line max-len
                issueBody += `\r\n- [${
                    isFirebaseChecked ? 'x' : ' '
                }] I checked [Firebase Crashlytics](https://console.firebase.google.com/u/0/project/expensify-chat/crashlytics/app/android:com.expensify.chat/issues?state=open&time=last-seven-days&tag=all) and verified that this release does not introduce any new crashes. More detailed instructions on this verification can be found [here](https://stackoverflowteams.com/c/expensify/questions/15095/15096).`;
                // eslint-disable-next-line max-len
                issueBody += `\r\n- [${isGHStatusChecked ? 'x' : ' '}] I checked [GitHub Status](https://www.githubstatus.com/) and verified there is no reported incident with Actions.`;

                issueBody += '\r\n\r\ncc @Expensify/applauseleads\r\n';
                const issueAssignees = Object.values(internalQAPRMap);
                const issue = {issueBody, issueAssignees};
                return issue;
            })
            .catch((err) => console.warn('Error generating StagingDeployCash issue body! Continuing...', err));
    }

    /**
     * Fetch all pull requests given a list of PR numbers.
     */
    static fetchAllPullRequests(pullRequestNumbers: number[]) {
        const oldestPR = pullRequestNumbers.sort()[0];
        return this.paginate(
            this.octokit.pulls.list,
            {
                owner: CONST.GITHUB_OWNER,
                repo: CONST.APP_REPO,
                state: 'all',
                sort: 'created',
                direction: 'desc',
                per_page: 100,
            },
            ({data}, done) => {
                if (data.find((pr) => pr.number === oldestPR)) {
                    done();
                }
                return data;
            },
        )
            .then((prList) => prList.filter((pr) => pullRequestNumbers.includes(pr.number)))
            .catch((err) => console.error('Failed to get PR list', err));
    }

    /**
     * @param pullRequestNumber
     * @returns
     */
    static getPullRequestBody(pullRequestNumber) {
        return this.octokit.pulls
            .get({
                owner: CONST.GITHUB_OWNER,
                repo: CONST.APP_REPO,
                pull_number: pullRequestNumber,
            })
            .then(({data: pullRequestComment}) => pullRequestComment.body);
    }

    /**
     * @param pullRequestNumber
     * @returns
     */
    static getAllReviewComments(pullRequestNumber) {
        return this.paginate(
            this.octokit.pulls.listReviews,
            {
                owner: CONST.GITHUB_OWNER,
                repo: CONST.APP_REPO,
                pull_number: pullRequestNumber,
                per_page: 100,
            },
            (response) => response.data.map((review) => review.body),
        );
    }

    /**
     * @param issueNumber
     * @returns
     */
    static getAllComments(issueNumber) {
        return this.paginate(
            this.octokit.issues.listComments,
            {
                owner: CONST.GITHUB_OWNER,
                repo: CONST.APP_REPO,
                issue_number: issueNumber,
                per_page: 100,
            },
            (response) => response.data.map((comment) => comment.body),
        );
    }

    /**
     * Create comment on pull request
     *
     * @param repo - The repo to search for a matching pull request or issue number
     * @param number - The pull request or issue number
     * @param messageBody - The comment message
     * @returns
     */
    static createComment(repo, number, messageBody) {
        console.log(`Writing comment on #${number}`);
        return this.octokit.issues.createComment({
            owner: CONST.GITHUB_OWNER,
            repo,
            issue_number: number,
            body: messageBody,
        });
    }

    /**
     * Get the most recent workflow run for the given New Expensify workflow.
     *
     * @param workflow
     * @returns
     */
    static getLatestWorkflowRunID(workflow) {
        console.log(`Fetching New Expensify workflow runs for ${workflow}...`);
        return (
            this.octokit.actions
                .listWorkflowRuns({
                    owner: CONST.GITHUB_OWNER,
                    repo: CONST.APP_REPO,
                    workflow_id: workflow,
                })
                // .then((response) => lodashGet(response, 'data.workflow_runs[0].id'));
                .then((response) => response.data.workflow_runs[0].id)
        );
    }

    /**
     * Generate the well-formatted body of a production release.
     *
     * @param pullRequests
     * @returns
     */
    static getReleaseBody(pullRequests) {
        return pullRequests.map((number) => `- ${this.getPullRequestURLFromNumber(number)}`).join('\r\n');
    }

    /**
     * Generate the URL of an New Expensify pull request given the PR number.
     *
     * @param number
     * @returns
     */
    static getPullRequestURLFromNumber(value: number): string {
        return `${CONST.APP_REPO_URL}/pull/${value}`;
    }

    /**
     * Parse the pull request number from a URL.
     *
     * @param URL
     * @returns
     * @throws {Error} If the URL is not a valid Github Pull Request.
     */
    static getPullRequestNumberFromURL(URL: string): number {
        const matches = URL.match(PULL_REQUEST_REGEX);
        if (!Array.isArray(matches) || matches.length !== 2) {
            throw new Error(`Provided URL ${URL} is not a Github Pull Request!`);
        }
        return Number.parseInt(matches[1], 10);
    }

    /**
     * Parse the issue number from a URL.
     *
     * @param URL
     * @returns
     * @throws {Error} If the URL is not a valid Github Issue.
     */
    static getIssueNumberFromURL(URL) {
        const matches = URL.match(ISSUE_REGEX);
        if (!Array.isArray(matches) || matches.length !== 2) {
            throw new Error(`Provided URL ${URL} is not a Github Issue!`);
        }
        return Number.parseInt(matches[1], 10);
    }

    /**
     * Parse the issue or pull request number from a URL.
     *
     * @param URL
     * @returns
     * @throws {Error} If the URL is not a valid Github Issue or Pull Request.
     */
    static getIssueOrPullRequestNumberFromURL(URL) {
        const matches = URL.match(ISSUE_OR_PULL_REQUEST_REGEX);
        if (!Array.isArray(matches) || matches.length !== 2) {
            throw new Error(`Provided URL ${URL} is not a valid Github Issue or Pull Request!`);
        }
        return Number.parseInt(matches[1], 10);
    }

    /**
     * Return the login of the actor who closed an issue or PR. If the issue is not closed, return an empty string.
     *
     * @param issueNumber
     * @returns
     */
    static getActorWhoClosedIssue(issueNumber) {
        return (
            this.paginate(this.octokit.issues.listEvents, {
                owner: CONST.GITHUB_OWNER,
                repo: CONST.APP_REPO,
                issue_number: issueNumber,
                per_page: 100,
            })
                .then((events) => events.filter((event) => event.event === 'closed'))
                // .then((closedEvents) => lodashGet(_.last(closedEvents), 'actor.login', ''));
                .then((closedEvents) => _.last(closedEvents).actor.login ?? '')
        );
    }

    static getArtifactByName(artefactName) {
        return this.paginate(this.octokit.actions.listArtifactsForRepo, {
            owner: CONST.GITHUB_OWNER,
            repo: CONST.APP_REPO,
            per_page: 100,
        }).then((artifacts) => _.findWhere(artifacts, {name: artefactName}));
    }
}

export default GithubUtils;
export {ISSUE_OR_PULL_REQUEST_REGEX, POLL_RATE};
