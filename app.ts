import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import * as git from './git.ts';

// Types
export interface GitObject { type: 'commit'|'tree'|'blob'|'tag', data: Buffer }
export interface Issue { number: number, title: string, body: string, state: 'open'|'closed', labels: string[], comments: Comment[], createdAt: string, updatedAt: string, cachedJsonBuffer: Buffer | null }
export interface Pull { number: number, title: string, body: string, state: 'open'|'closed', head: { ref: string, sha: string }, base: { ref: string, sha: string }, merged: boolean, merged_at: string | null, merge_commit_sha: string | null, createdAt: string, updatedAt: string }
export interface Label { name: string, color: string, description: string }
export interface Comment { id: number, body: string, user: { login: string, id: number, type: string }, created_at: string }
export interface Repo { id: number, owner: string, name: string, default_branch: string, defaultBranch: string, description: string, private: boolean, createdAt: string, updatedAt: string, objects: Map<string, GitObject>, refs: Map<string, string>, issues: Map<number, Issue>, prs: Map<number, Pull>, labels: Map<string, Label>, generation: number, nextIssueNumber: number, nextPrNumber: number }

// Constants
export const VIEWER_LOGIN = 'adaiversen';
export const FIXED_AUTHOR = 'Ada Iversen <ada@example.com> 1770000000 +0000';
export const repos = new Map<string, Repo>();
let requestIdCounter = 1;
let graphQLModule: any = null;
let mcpModule: any = null;

// Helpers
export function stripOwnerPrefix(ref: string): string {
    const idx = ref.indexOf(':');
    return idx !== -1 ? ref.substring(idx + 1) : ref;
}

export function resolveRef(repo: Repo, ref: string): string | null {
    if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    if (repo.objects.has(ref)) return ref;
    return null;
}

export function resolveTip(repo: Repo, ref: string, fallback: string): string {
    const name = stripOwnerPrefix(ref);
    const resolved = resolveRef(repo, name);
    return resolved ?? fallback;
}

function sendJson(res: ServerResponse, status: number, obj: any) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-GitHub-Request-Id', `req-${requestIdCounter++}`);
    res.writeHead(status);
    res.end(JSON.stringify(obj));
}

function sendError(res: ServerResponse, status: number, message: string) {
    sendJson(res, status, { message });
}

function sendGitResult(res: ServerResponse, out: { status: number; headers: Record<string, string>; body: Buffer }) {
    for (const [k, v] of Object.entries(out.headers)) {
        res.setHeader(k, v);
    }
    res.setHeader('X-GitHub-Request-Id', `req-${requestIdCounter++}`);
    res.writeHead(out.status);
    return res.end(out.body);
}

async function readBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
    if (!body) return {};
    try {
        return JSON.parse(body);
    } catch (e) {
        throw new Error('Invalid JSON');
    }
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export function parseQuery(rawQuery: string): URLSearchParams {
    return new URLSearchParams(rawQuery);
}

// Formatters
export function formatRepo(repo: Repo) {
    let openIssuesCount = 0;
    for (const issue of repo.issues.values()) if (issue.state === 'open') openIssuesCount++;
    return {
        id: repo.id,
        node_id: 'R_kgD' + repo.id,
        name: repo.name,
        full_name: repo.owner + '/' + repo.name,
        owner: { login: repo.owner, id: 1000, type: 'User' },
        private: repo.private,
        description: repo.description,
        default_branch: repo.default_branch,
        html_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}`,
        created_at: repo.createdAt,
        updated_at: repo.updatedAt,
        open_issues_count: openIssuesCount,
    };
}
export function formatIssue(issue: Issue) {
    const htmlUrl = `/api/v3/repos/issues/${issue.number}`;
    return {
        id: issue.number,
        node_id: 'I_kgD' + issue.number,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
        labels: issue.labels.map((name) => ({ name, color: '000000' })),
        comments: issue.comments.length,
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
        html_url: htmlUrl,
    };
}
export function formatPull(pull: Pull) {
    return {
        id: pull.number,
        node_id: 'PR_kgD' + pull.number,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        merged: pull.merged,
        merged_at: pull.merged_at,
        merge_commit_sha: pull.merge_commit_sha,
        head: pull.head,
        base: pull.base,
        html_url: '/api/v3/repos/',
        created_at: pull.createdAt,
        updated_at: pull.updatedAt,
    };
}
export function formatLabel(label: Label) {
    return { name: label.name, color: label.color, description: label.description };
}
export function formatComment(comment: Comment) {
    return { id: comment.id, body: comment.body, user: comment.user, created_at: comment.created_at };
}

function formatCommit(repo: Repo, sha: string) {
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') return null;
    const { author, committer, message } = git.parseCommit(obj.data);
    const authorParts = author.split(' <');
    const authorName = authorParts[0];
    const authorEmail = authorParts[1] ? authorParts[1].replace(/>.*$/, '') : '';
    const authorDate = author.split('> ')[1] ? author.split('> ')[1].split(' ')[0] : '';
    const committerParts = committer.split(' <');
    const committerName = committerParts[0];
    const committerEmail = committerParts[1] ? committerParts[1].replace(/>.*$/, '') : '';
    const committerDate = committer.split('> ')[1] ? committer.split('> ')[1].split(' ')[0] : '';
    const dateIso = (ts: string) => {
        const t = parseInt(ts, 10) * 1000;
        return Number.isNaN(t) ? ts : new Date(t).toISOString();
    };
    const authorObj = { name: authorName, email: authorEmail, date: dateIso(authorDate) };
    const committerObj = { name: committerName, email: committerEmail, date: dateIso(committerDate) };
    return {
        sha,
        commit: {
            message,
            author: authorObj,
            committer: committerObj,
        },
        author: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
        committer: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    };
}

function getRepo(key: string): Repo | null {
    return repos.get(key) ?? null;
}

function parsePage(rawQuery: string): { page: number; perPage: number } {
    const q = parseQuery(rawQuery);
    const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(q.get('per_page') ?? '30', 10) || 30));
    return { page, perPage };
}

let nextRepoId = 1;

function handleUserRepos(req: IncomingMessage, res: ServerResponse, rawQuery: string) {
    const { page, perPage } = parsePage(rawQuery);
    const userRepos = [...repos.values()]
        .filter((r) => r.owner === VIEWER_LOGIN)
        .sort((a, b) => a.id - b.id);
    const start = (page - 1) * perPage;
    const items = userRepos.slice(start, start + perPage);
    const total = userRepos.length;
    const host = req.headers.host ?? 'localhost';
    const base = `http://${host}/api/v3/user/repos`;
    const links: string[] = [];
    if (start + perPage < total) {
        links.push(`<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
    }
    if (page > 1) {
        links.push(`<${base}?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
    }
    if (links.length) {
        res.setHeader('Link', links.join(', '));
    }
    return sendJson(res, 200, items.map(formatRepo));
}

async function handleCreateRepo(req: IncomingMessage, res: ServerResponse) {
    const body = await readBody(req);
    const name = (body.name ?? '').toString().trim();
    if (!name) return sendError(res, 422, 'Repository creation failed. The name must not be empty.');
    const key = `${VIEWER_LOGIN}/${name}`;
    if (repos.has(key)) return sendError(res, 422, 'Repository creation failed. A repository with this name already exists.');
    const now = new Date().toISOString();
    const repo: Repo = {
        id: nextRepoId++,
        owner: VIEWER_LOGIN,
        name,
        default_branch: 'main',
        defaultBranch: 'main',
        description: body.description ?? '',
        private: !!body.private,
        createdAt: now,
        updatedAt: now,
        objects: new Map(),
        refs: new Map(),
        issues: new Map(),
        prs: new Map(),
        labels: new Map(),
        generation: 0,
        nextIssueNumber: 1,
        nextPrNumber: 1,
    };
    repos.set(key, repo);
    return sendJson(res, 201, formatRepo(repo));
}

async function handlePatchRepo(req: IncomingMessage, res: ServerResponse, repo: Repo | null) {
    if (!repo) return sendError(res, 404, 'Not Found');
    const body = await readBody(req);
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.private = body.private;
    if (typeof body.default_branch === 'string' && body.default_branch) {
        if (!repo.refs.has(`refs/heads/${body.default_branch}`)) {
            return sendError(res, 422, 'Validation Failed');
        }
        repo.default_branch = body.default_branch;
        repo.defaultBranch = body.default_branch;
    }
    repo.updatedAt = new Date().toISOString();
    return sendJson(res, 200, formatRepo(repo));
}

function handleCreateRef(req: IncomingMessage, res: ServerResponse, repo: Repo) {
    return (async () => {
        const body = await readBody(req);
        const ref = (body.ref ?? '').toString();
        const sha = (body.sha ?? '').toString();
        if (!ref.startsWith('refs/heads/')) return sendError(res, 422, 'Validation Failed');
        if (!repo.objects.has(sha)) return sendError(res, 422, 'Validation Failed');
        repo.refs.set(ref, sha);
        return sendJson(res, 201, {
            ref,
            node_id: 'R_kgD' + repo.id,
            url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`,
            object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
        });
    })();
}

function handleBranches(res: ServerResponse, repo: Repo) {
    const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return sendJson(res, 200, branches);
}

function handleCommits(res: ServerResponse, repo: Repo, rawQuery: string) {
    const q = parseQuery(rawQuery);
    const shaParam = q.get('sha');
    let tip: string | null = null;
    if (shaParam) {
        tip = resolveTip(repo, shaParam, shaParam);
    } else {
        tip = repo.refs.get(`refs/heads/${repo.default_branch}`) ?? null;
    }
    if (!tip || !repo.objects.has(tip)) return sendJson(res, 200, []);
    const commits: any[] = [];
    const visited = new Set<string>();
    let cur: string | null = tip;
    while (cur && commits.length < 200 && !visited.has(cur)) {
        visited.add(cur);
        const fc = formatCommit(repo, cur);
        if (fc) {
            commits.push(fc);
            const obj = repo.objects.get(cur);
            const { parents } = git.parseCommit(obj!.data);
            cur = parents[0] ?? null;
        } else {
            break;
        }
    }
    return sendJson(res, 200, commits);
}

function resolvePullRef(repo: Repo, ref: string): string | null {
    const name = stripOwnerPrefix(ref);
    return resolveRef(repo, name);
}

function findPullByNumber(repo: Repo, n: number): Pull | null {
    return repo.prs.get(n) ?? null;
}

async function handleCreatePull(req: IncomingMessage, res: ServerResponse, repo: Repo) {
    const body = await readBody(req);
    const rawHead = (body.head ?? '').toString();
    const rawBase = (body.base ?? '').toString();
    const title = (body.title ?? '').toString();
    const headSha = resolvePullRef(repo, rawHead);
    const baseSha = resolvePullRef(repo, rawBase);
    if (!headSha || !baseSha) return sendError(res, 422, 'Validation Failed');
    if (headSha === baseSha) return sendError(res, 422, 'Validation Failed');
    const n = repo.nextPrNumber++;
    const now = new Date().toISOString();
    const pull: Pull = {
        number: n,
        title,
        body: body.body ?? '',
        state: 'open',
        head: { ref: rawHead, sha: headSha },
        base: { ref: rawBase, sha: baseSha },
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        createdAt: now,
        updatedAt: now,
    };
    repo.prs.set(n, pull);
    return sendJson(res, 201, formatPull(pull));
}

function handleListPulls(res: ServerResponse, repo: Repo, rawQuery: string) {
    const { page, perPage } = parsePage(rawQuery);
    const q = parseQuery(rawQuery);
    const stateFilter = q.get('state') ?? 'open';
    const pulls = [...repo.prs.values()]
        .filter((p) => stateFilter === 'all' || p.state === stateFilter)
        .sort((a, b) => b.number - a.number);
    const start = (page - 1) * perPage;
    return sendJson(res, 200, pulls.slice(start, start + perPage).map(formatPull));
}

function handleGetPull(res: ServerResponse, repo: Repo, nStr: string) {
    const n = parseInt(nStr, 10);
    const pull = findPullByNumber(repo, n);
    if (!pull) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, formatPull(pull));
}

function handlePullFiles(res: ServerResponse, repo: Repo, nStr: string) {
    const n = parseInt(nStr, 10);
    const pull = findPullByNumber(repo, n);
    if (!pull) return sendError(res, 404, 'Not Found');
    const headTip = resolveTip(repo, pull.head.ref, pull.head.sha);
    const baseTip = resolveTip(repo, pull.base.ref, pull.base.sha);
    const mergeBase = git.findMergeBase(repo, headTip, baseTip) ?? baseTip;
    const diffs = git.getPullFilesDiff(repo, mergeBase, headTip);
    const files = diffs.map((d) => ({
        filename: d.path,
        status: d.changeType,
        additions: d.additions,
        deletions: d.deletions,
        changes: d.additions + d.deletions,
    }));
    return sendJson(res, 200, files);
}

async function handleMergePull(req: IncomingMessage, res: ServerResponse, repo: Repo, nStr: string) {
    const n = parseInt(nStr, 10);
    const pull = findPullByNumber(repo, n);
    if (!pull) return sendError(res, 404, 'Not Found');
    if (pull.state !== 'open' || pull.merged) {
        return sendError(res, 405, 'Pull request is not mergeable');
    }
    const body = await readBody(req);
    const mergeMethod = body.merge_method ?? 'squash';
    if (mergeMethod !== 'squash') return sendError(res, 405, 'Invalid merge method');
    const headTip = resolveTip(repo, pull.head.ref, pull.head.sha);
    const baseTip = resolveTip(repo, pull.base.ref, pull.base.sha);
    const baseRef = stripOwnerPrefix(pull.base.ref);
    const baseRefKey = `refs/heads/${baseRef}`;
    const mergeBase = git.findMergeBase(repo, headTip, baseTip) ?? baseTip;
    if (git.checkPullConflicts(repo, mergeBase, headTip, baseTip)) {
        return sendError(res, 405, 'Merge conflict');
    }
    const sha = git.squashMergeCommit(repo, baseRefKey, headTip, `${pull.title} (#${n})`, FIXED_AUTHOR);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = new Date().toISOString();
    pull.merge_commit_sha = sha;
    pull.updatedAt = pull.merged_at;
    repo.generation++;
    return sendJson(res, 200, { merged: true, message: 'Pull request successfully merged', sha });
}

function base64Decode(str: string): Buffer {
    const b64 = str.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        throw new Error('Invalid base64');
    }
    return Buffer.from(b64, 'base64');
}

function resolveBranch(repo: Repo, body: any, rawQuery: string): string {
    const q = parseQuery(rawQuery);
    const branch = body?.branch || q.get('branch') || q.get('ref') || repo.default_branch;
    return branch;
}

function getBranchRefKey(branch: string): string {
    return `refs/heads/${branch}`;
}

function findFileEntry(repo: Repo, branch: string, path: string): { oid: string; content: Buffer } | null {
    const tip = repo.refs.get(getBranchRefKey(branch));
    if (!tip) return null;
    return git.readFileAtRef(repo, tip, path);
}

function formatContentsEntry(path: string, oid: string, content: Buffer) {
    return {
        name: path.split('/').pop(),
        path,
        sha: oid,
        size: content.length,
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
    };
}

function formatContentsResponse(repo: Repo, path: string, oid: string, content: Buffer, commitSha: string, message: string) {
    const fc = formatCommit(repo, commitSha);
    const commit = fc ? { sha: fc.sha, ...fc.commit } : { sha: commitSha, message, author: {}, committer: {} };
    return {
        content: formatContentsEntry(path, oid, content),
        commit,
    };
}

async function handlePutContents(req: IncomingMessage, res: ServerResponse, repo: Repo, path: string, rawQuery: string) {
    const body = await readBody(req);
    const message = (body.message ?? '').toString();
    const contentStr = (body.content ?? '').toString();
    if (!message || !contentStr) {
        return sendError(res, 422, 'Validation Failed');
    }
    let content: Buffer;
    try {
        content = base64Decode(contentStr);
    } catch {
        return sendError(res, 400, 'Invalid content');
    }
    const branch = resolveBranch(repo, body, rawQuery);
    const branchRefKey = getBranchRefKey(branch);
    const existing = findFileEntry(repo, branch, path);
    if (body.sha) {
        if (!existing || existing.oid !== body.sha) {
            return sendError(res, 409, 'Conflict');
        }
    }
    const blobSha = git.computeObjectId('blob', content);
    const result = git.commitFile(repo, branchRefKey, path, content, message, FIXED_AUTHOR);
    repo.generation++;
    const isCreate = !existing;
    return sendJson(res, isCreate ? 201 : 200, formatContentsResponse(repo, path, blobSha, content, result.commit, message));
}

async function handleGetContents(res: ServerResponse, repo: Repo, path: string, rawQuery: string) {
    const q = parseQuery(rawQuery);
    const branch = q.get('ref') || repo.default_branch;
    const tip = repo.refs.get(getBranchRefKey(branch));
    if (!tip) return sendError(res, 404, 'Not Found');
    const read = git.readFileAtRef(repo, tip, path);
    if (read) {
        return sendJson(res, 200, formatContentsEntry(path, read.oid, read.content));
    }
    const directory = git.getDirectoryListing(repo, tip, path);
    if (directory) {
        return sendJson(res, 200, directory);
    }
    return sendError(res, 404, 'Not Found');
}

async function handleDeleteContents(req: IncomingMessage, res: ServerResponse, repo: Repo, path: string, rawQuery: string) {
    const body = await readBody(req);
    const message = (body.message ?? '').toString();
    const sha = (body.sha ?? '').toString();
    if (!message || !sha) {
        return sendError(res, 422, 'Validation Failed');
    }
    const branch = resolveBranch(repo, body, rawQuery);
    const existing = findFileEntry(repo, branch, path);
    if (!existing || existing.oid !== sha) {
        return sendError(res, 409, 'Conflict');
    }
    const result = git.deleteFile(repo, getBranchRefKey(branch), path, message, FIXED_AUTHOR);
    if (!result) return sendError(res, 404, 'Not Found');
    repo.generation++;
    return sendJson(res, 200, { commit: { sha: result.commit } });
}

async function handleCreateLabel(req: IncomingMessage, res: ServerResponse, repo: Repo) {
    const body = await readBody(req);
    const name = (body.name ?? '').toString();
    if (!name) return sendError(res, 422, 'Validation Failed');
    if (repo.labels.has(name)) return sendError(res, 422, 'Validation Failed');
    const label: Label = {
        name,
        color: (body.color ?? '000000').toString(),
        description: (body.description ?? '').toString(),
    };
    repo.labels.set(name, label);
    return sendJson(res, 201, formatLabel(label));
}

function handleListLabels(res: ServerResponse, repo: Repo) {
    return sendJson(res, 200, [...repo.labels.values()].map(formatLabel));
}

async function handleCreateIssue(req: IncomingMessage, res: ServerResponse, repo: Repo) {
    const body = await readBody(req);
    const title = (body.title ?? '').toString();
    if (!title) return sendError(res, 422, 'Validation Failed');
    const labelNames: string[] = Array.isArray(body.labels) ? body.labels.map(String) : [];
    for (const ln of labelNames) {
        if (!repo.labels.has(ln)) return sendError(res, 422, 'Validation Failed');
    }
    const now = new Date().toISOString();
    const issue: Issue = {
        number: repo.nextIssueNumber++,
        title,
        body: (body.body ?? '').toString(),
        state: 'open',
        labels: labelNames,
        comments: [],
        createdAt: now,
        updatedAt: now,
        cachedJsonBuffer: null,
    };
    repo.issues.set(issue.number, issue);
    issue.cachedJsonBuffer = Buffer.from(JSON.stringify(formatIssue(issue)), 'utf8');
    return sendJson(res, 201, formatIssue(issue));
}

function handleListIssues(res: ServerResponse, repo: Repo, rawQuery: string) {
    const q = parseQuery(rawQuery);
    const { page, perPage } = parsePage(rawQuery);
    const stateFilter = q.get('state') ?? 'open';
    const sort = q.get('sort') ?? 'created';
    const direction = q.get('direction') ?? 'desc';
    let issues = [...repo.issues.values()].filter((i) => stateFilter === 'all' || i.state === stateFilter);
    issues.sort((a, b) => {
        const key = sort === 'updated' ? 'updatedAt' : 'createdAt';
        const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
        return direction === 'asc' ? cmp : -cmp;
    });
    const start = (page - 1) * perPage;
    return sendJson(res, 200, issues.slice(start, start + perPage).map(formatIssue));
}

function findIssueByNumber(repo: Repo, n: number): Issue | null {
    return repo.issues.get(n) ?? null;
}

function handleGetIssue(res: ServerResponse, repo: Repo, nStr: string) {
    const n = parseInt(nStr, 10);
    const issue = findIssueByNumber(repo, n);
    if (!issue) return sendError(res, 404, 'Not Found');
    if (issue.cachedJsonBuffer) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-GitHub-Request-Id', `req-${requestIdCounter++}`);
        res.writeHead(200);
        return res.end(issue.cachedJsonBuffer);
    }
    return sendJson(res, 200, formatIssue(issue));
}

async function handlePatchIssue(req: IncomingMessage, res: ServerResponse, repo: Repo, nStr: string) {
    const n = parseInt(nStr, 10);
    const issue = findIssueByNumber(repo, n);
    if (!issue) return sendError(res, 404, 'Not Found');
    const body = await readBody(req);
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
    issue.updatedAt = new Date().toISOString();
    issue.cachedJsonBuffer = null;
    return sendJson(res, 200, formatIssue(issue));
}

function handleListIssueComments(res: ServerResponse, repo: Repo, nStr: string) {
    const n = parseInt(nStr, 10);
    const issue = findIssueByNumber(repo, n);
    if (!issue) return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, issue.comments.map(formatComment));
}

async function handleCreateIssueComment(req: IncomingMessage, res: ServerResponse, repo: Repo, nStr: string) {
    const n = parseInt(nStr, 10);
    const issue = findIssueByNumber(repo, n);
    if (!issue) return sendError(res, 404, 'Not Found');
    const body = await readBody(req);
    const commentBody = (body.body ?? '').toString();
    if (!commentBody) return sendError(res, 422, 'Validation Failed');
    const comment: Comment = {
        id: issue.comments.length + 1,
        body: commentBody,
        user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
        created_at: new Date().toISOString(),
    };
    issue.comments.push(comment);
    issue.updatedAt = new Date().toISOString();
    issue.cachedJsonBuffer = null;
    return sendJson(res, 201, formatComment(comment));
}

// App
export function createApp() {
    return createServer(async (req, res) => {
        try {
            await handleRequest(req, res);
        } catch (e) {
            console.error('[unhandled]', e instanceof Error ? e.stack : e);
            if (!res.headersSent) {
                try {
                    if (e instanceof Error && e.message === 'Invalid JSON') {
                        sendError(res, 400, 'Invalid JSON');
                    } else {
                        sendError(res, 500, 'Internal Server Error');
                    }
                } catch { /* ignore */ }
            } else {
                try { res.end(); } catch { /* ignore */ }
            }
        }
    });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const segments = url.pathname.split('/').filter(Boolean);
        const rawQuery = url.search.replace(/^\?/, '');
        const auth = req.headers.authorization;
        const shopToken = process.env.MAKEFUN_SHOP_TOKEN;

        // Auth: every route except GET /healthz requires Bearer token
        const requiresAuth = url.pathname !== '/healthz';
        if (requiresAuth && (!auth || auth !== `Bearer ${shopToken}`)) {
            return sendError(res, 401, 'Bad credentials');
        }

        // GET /healthz -> 200 {status:'ok'} (no auth)
        if (url.pathname === '/healthz' && req.method === 'GET') {
            return sendJson(res, 200, { status: 'ok' });
        }

        // GraphQL / MCP routing (BEFORE the /api/v3 gate)
        if (req.method === 'POST') {
            if (url.pathname === '/api/graphql' || url.pathname === '/api/v3/graphql') {
                if (!graphQLModule) {
                    graphQLModule = await import('./graphql.ts');
                }
                const handler = graphQLModule.createGraphQLHandler({ repos, viewerLogin: VIEWER_LOGIN });
                const rawBody = await readRawBody(req);
                const { status, json } = await handler(null, rawBody.toString());
                return sendJson(res, status, json);
            }

            if (url.pathname === '/mcp' || url.pathname === '/api/v3/mcp') {
                if (!mcpModule) {
                    mcpModule = await import('./mcp.ts');
                }
                const handler = mcpModule.createMcpHandler({ repos, viewerLogin: VIEWER_LOGIN });
                const rawBody = await readRawBody(req);
                const { status, json } = await handler(rawBody);
                if (json === null) {
                    res.setHeader('X-GitHub-Request-Id', `req-${requestIdCounter++}`);
                    res.writeHead(status);
                    return res.end();
                }
                return sendJson(res, status, json);
            }
        }

        // git smart HTTP (NOT under /api/v3): /{owner}/{repo}.git/...
        if (segments.length >= 3 && segments[1].endsWith('.git')) {
            const gitOwner = segments[0];
            const gitRepoName = segments[1].slice(0, -'.git'.length);
            const gitRepo = gitOwner === VIEWER_LOGIN ? repos.get(`${gitOwner}/${gitRepoName}`) : undefined;
            if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs' && req.method === 'GET') {
                if (!gitRepo) return sendError(res, 404, 'Not Found');
                const q = parseQuery(rawQuery);
                const service = q.get('service') ?? '';
                const gitProtocol = (req.headers['git-protocol'] as string | undefined) ?? null;
                const out = git.handleInfoRefs(gitRepo, service, gitProtocol);
                res.setHeader('Content-Type', out.headers['Content-Type']);
                res.setHeader('X-GitHub-Request-Id', `req-${requestIdCounter++}`);
                res.writeHead(out.status);
                return res.end(out.body);
            }
            if (segments.length === 3 && segments[2] === 'git-upload-pack' && req.method === 'POST') {
                if (!gitRepo) return sendError(res, 404, 'Not Found');
                const body = await readRawBody(req);
                if (body.length > 50 * 1024 * 1024) return sendError(res, 413, 'Payload Too Large');
                let rest = body;
                if (body.length >= 4) {
                    const head = body.subarray(0, 4).toString('ascii');
                    if (/^[0-9a-fA-F]{4}$/.test(head)) {
                        const len = parseInt(head, 16);
                        if (len >= 4 && len <= body.length) {
                            const first = body.subarray(4, len).toString('utf8');
                            if (first.startsWith('command=fetch')) {
                                rest = body.subarray(len);
                                return sendGitResult(res, git.handleFetch(gitRepo, rest));
                            }
                            if (first.startsWith('command=ls-refs')) {
                                rest = body.subarray(len);
                                return sendGitResult(res, git.handleLsRefs(gitRepo, rest));
                            }
                        }
                    }
                }
                return sendGitResult(res, git.handleFetch(gitRepo, rest));
            }
            if (segments.length === 3 && segments[2] === 'git-receive-pack' && req.method === 'POST') {
                if (!gitRepo) return sendError(res, 404, 'Not Found');
                const body = await readRawBody(req);
                if (body.length > 50 * 1024 * 1024) return sendError(res, 413, 'Payload Too Large');
                return sendGitResult(res, git.handleReceivePack(gitRepo, body));
            }
        }

        // /api/v3 gate: first two path segments must be api/v3
        if (segments[0] !== 'api' || segments[1] !== 'v3') {
            return sendError(res, 404, 'Not Found');
        }

        const resource = segments[2];

        // GET /api/v3/ -> 200 {}
        if (segments.length === 2 && req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('X-GitHub-Request-Id', `req-${requestIdCounter++}`);
            res.setHeader('X-OAuth-Scopes', 'repo, read:org');
            res.writeHead(200);
            return res.end(JSON.stringify({}));
        }

        // GET /api/v3/meta -> 200 {installed_version:'1.0.0'}
        if (segments.length === 3 && resource === 'meta' && req.method === 'GET') {
            return sendJson(res, 200, { installed_version: '1.0.0' });
        }

        // GET /api/v3/user -> 200 user object
        if (segments.length === 3 && resource === 'user' && req.method === 'GET') {
            return sendJson(res, 200, {
                login: VIEWER_LOGIN,
                id: 1000,
                type: 'User',
                name: 'Ada Iversen',
                email: 'ada@example.com'
            });
        }

        // ---- Step 3 & 4 routes ----

        // user/repos  (api, v3, user, repos)
        if (segments.length === 4 && resource === 'user' && segments[3] === 'repos' && req.method === 'GET') {
            return handleUserRepos(req, res, rawQuery);
        }
        if (segments.length === 4 && resource === 'user' && segments[3] === 'repos' && req.method === 'POST') {
            return handleCreateRepo(req, res);
        }

        // repos/{owner}/{name}
        if (resource === 'repos' && segments.length >= 4) {
            const owner = segments[3];
            if (owner !== VIEWER_LOGIN) {
                return sendError(res, 404, 'Not Found');
            }
            const repoName = segments[4];
            let lookupName = repoName;
            if (repoName.endsWith('.git')) {
                lookupName = repoName.slice(0, -'.git'.length);
            }
            const key = `${owner}/${lookupName}`;
            const repo = repos.get(key);

            if (segments.length === 5) {
                if (req.method === 'GET') {
                    if (!repo) return sendError(res, 404, 'Not Found');
                    return sendJson(res, 200, formatRepo(repo));
                }
                if (req.method === 'PATCH') {
                    return handlePatchRepo(req, res, repo);
                }
                if (req.method === 'DELETE') {
                    if (!repo) return sendError(res, 404, 'Not Found');
                    repos.delete(key);
                    res.setHeader('X-GitHub-Request-Id', `req-${requestIdCounter++}`);
                    res.writeHead(204);
                    return res.end();
                }
            }
            if (segments.length >= 5 && !repo) {
                return sendError(res, 404, 'Not Found');
            }
            if (repo && segments.length === 6 && segments[5] === 'branches' && req.method === 'GET') {
                return handleBranches(res, repo);
            }
            if (repo && segments.length === 6 && segments[5] === 'commits' && req.method === 'GET') {
                return handleCommits(res, repo, rawQuery);
            }
            // git/refs
            if (repo && segments.length === 7 && segments[5] === 'git' && segments[6] === 'refs' && req.method === 'POST') {
                return handleCreateRef(req, res, repo);
            }
            // pulls
            if (repo && segments.length === 6 && segments[5] === 'pulls' && req.method === 'POST') {
                return handleCreatePull(req, res, repo);
            }
            if (repo && segments.length === 6 && segments[5] === 'pulls' && req.method === 'GET') {
                return handleListPulls(res, repo, rawQuery);
            }
            if (repo && segments.length === 7 && segments[5] === 'pulls' && req.method === 'GET') {
                return handleGetPull(res, repo, segments[6]);
            }
            if (repo && segments.length === 8 && segments[5] === 'pulls' && segments[7] === 'files' && req.method === 'GET') {
                return handlePullFiles(res, repo, segments[6]);
            }
            if (repo && segments.length === 8 && segments[5] === 'pulls' && segments[7] === 'merge' && req.method === 'PUT') {
                return handleMergePull(req, res, repo, segments[6]);
            }
            // contents
            if (repo && segments[5] === 'contents' && segments.length >= 7) {
                const path = segments.slice(6).join('/');
                if (req.method === 'PUT') {
                    return handlePutContents(req, res, repo, path, rawQuery);
                }
                if (req.method === 'GET') {
                    return handleGetContents(res, repo, path, rawQuery);
                }
                if (req.method === 'DELETE') {
                    return handleDeleteContents(req, res, repo, path, rawQuery);
                }
            }
            // labels
            if (repo && segments.length === 6 && segments[5] === 'labels' && req.method === 'POST') {
                return handleCreateLabel(req, res, repo);
            }
            if (repo && segments.length === 6 && segments[5] === 'labels' && req.method === 'GET') {
                return handleListLabels(res, repo);
            }
            // issues
            if (repo && segments.length === 6 && segments[5] === 'issues' && req.method === 'POST') {
                return handleCreateIssue(req, res, repo);
            }
            if (repo && segments.length === 6 && segments[5] === 'issues' && req.method === 'GET') {
                return handleListIssues(res, repo, rawQuery);
            }
            if (repo && segments.length === 7 && segments[5] === 'issues' && req.method === 'GET') {
                return handleGetIssue(res, repo, segments[6]);
            }
            if (repo && segments.length === 7 && segments[5] === 'issues' && req.method === 'PATCH') {
                return handlePatchIssue(req, res, repo, segments[6]);
            }
            if (repo && segments.length === 8 && segments[5] === 'issues' && segments[7] === 'comments' && req.method === 'GET') {
                return handleListIssueComments(res, repo, segments[6]);
            }
            if (repo && segments.length === 8 && segments[5] === 'issues' && segments[7] === 'comments' && req.method === 'POST') {
                return handleCreateIssueComment(req, res, repo, segments[6]);
            }
        }

        // Unknown route
        return sendError(res, 404, 'Not Found');
}