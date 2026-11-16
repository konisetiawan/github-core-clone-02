import type { Repo, Issue, Pull } from './app.ts';
import { findMergeBase, checkPullConflicts, squashMergeCommit } from './git.ts';

const VIEWER_LOGIN = 'adaiversen';

export function createMcpHandler(opts: { repos: Map<string, Repo>; viewerLogin: string }) {
  const { repos } = opts;

  const TOOLS = [
    {
      name: 'create_repo',
      description: 'Create a new repository',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } },
        required: ['name'],
      },
    },
    {
      name: 'get_repo',
      description: 'Get a repository',
      inputSchema: { type: 'object', properties: { full_name: { type: 'string' } }, required: ['full_name'] },
    },
    {
      name: 'create_issue',
      description: 'Create an issue',
      inputSchema: {
        type: 'object',
        properties: { full_name: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
        required: ['full_name', 'title'],
      },
    },
    {
      name: 'list_issues',
      description: 'List issues',
      inputSchema: {
        type: 'object',
        properties: { full_name: { type: 'string' }, state: { type: 'string' } },
        required: ['full_name'],
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request',
      inputSchema: {
        type: 'object',
        properties: {
          full_name: { type: 'string' },
          title: { type: 'string' },
          head: { type: 'string' },
          base: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['full_name', 'title', 'head', 'base'],
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request',
      inputSchema: {
        type: 'object',
        properties: {
          full_name: { type: 'string' },
          pull_number: { type: ['number', 'string'] },
          merge_method: { type: 'string' },
        },
        required: ['full_name', 'pull_number'],
      },
    },
  ];

  function resolveTip(repo: Repo, ref: string, fallback: string): string {
    const stripped = ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref;
    return repo.refs.get(`refs/heads/${stripped}`) ?? repo.refs.get(stripped) ?? (repo.objects.has(stripped) ? stripped : fallback);
  }

  function formatRepo(repo: Repo) {
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
      html_url: '/api/v3/repos/' + repo.owner + '/' + repo.name,
      url: '/api/v3/repos/' + repo.owner + '/' + repo.name,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      open_issues_count: openIssuesCount,
    };
  }

  function formatIssue(owner: string, repoName: string, issue: Issue) {
    const htmlUrl = '/api/v3/repos/' + owner + '/' + repoName + '/issues/' + issue.number;
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

  function formatPull(owner: string, repoName: string, pr: Pull) {
    const url = '/api/v3/repos/' + owner + '/' + repoName + '/pulls/' + pr.number;
    return {
      id: pr.number,
      node_id: 'PR_kgD' + pr.number,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      head: pr.head,
      base: pr.base,
      html_url: url,
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
    };
  }

  return async (body: Buffer) => {
    try {
      let json;
      try {
        json = JSON.parse(body.toString());
      } catch {
        return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
      }

      if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
      }

      const { jsonrpc, id, method, params } = json as any;
      if (jsonrpc !== '2.0') {
        return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
      }

      if (id === undefined) return { status: 202, json: null };

      if (method === 'server/discover') {
        const serverInfo = { name: 'github-core-clone', version: '1.0.0' };
        return {
          status: 200,
          json: {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2026-07-28',
              supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
              capabilities: { tools: {} },
              serverInfo,
              _meta: { serverInfo },
            },
          },
        };
      }

      if (method === 'initialize') {
        const protocolVersion = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(params?.protocolVersion)
          ? params.protocolVersion
          : '2025-11-25';
        return {
          status: 200,
          json: {
            jsonrpc: '2.0',
            id,
            result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone', version: '1.0.0' } },
          },
        };
      }

      if (method === 'tools/list') {
        return { status: 200, json: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
      }

      if (method === 'tools/call') {
        const { name, arguments: args } = params || {};
        const normalizedRequested = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        let tool = TOOLS.find((t) => t.name.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedRequested);
        if (!tool) {
          tool = TOOLS.find((t) => {
            const norm = t.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            return norm.endsWith(normalizedRequested);
          });
        }
        if (!tool) {
          tool = TOOLS.find((t) => {
            const norm = t.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            return normalizedRequested.endsWith(norm);
          });
        }

        if (!tool) {
          return { status: 200, json: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } } };
        }

        try {
          const { full_name } = args || {};
          let repo: Repo | undefined;
          if (tool.name !== 'create_repo') {
            repo = repos.get(full_name);
            if (!repo) {
              return {
                status: 200,
                json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true } },
              };
            }
          }

          if (tool.name === 'create_repo') {
            const { name, description, private: isPrivate } = args;
            const key = `${VIEWER_LOGIN}/${name}`;
            if (repos.has(key)) {
              return {
                status: 200,
                json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Repository already exists' }], isError: true } },
              };
            }
            let maxId = 0;
            for (const r of repos.values()) if (r.id > maxId) maxId = r.id;
            const now = new Date().toISOString();
            const repo: Repo = {
              owner: VIEWER_LOGIN,
              name,
              id: maxId + 1,
              private: !!isPrivate,
              description: description || '',
              default_branch: 'main',
              defaultBranch: 'main',
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
            return { status: 200, json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(formatRepo(repo)) }] } } };
          }

          if (tool.name === 'get_repo') {
            return { status: 200, json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(formatRepo(repo!)) }] } } };
          }

          if (tool.name === 'create_issue') {
            const { title, body } = args;
            const issue: Issue = {
              number: repo!.nextIssueNumber++,
              title,
              body: body || '',
              state: 'open',
              labels: [],
              comments: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              cachedJsonBuffer: null,
            };
            repo!.issues.set(issue.number, issue);
            return { status: 200, json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(formatIssue(repo!.owner, repo!.name, issue)) }] } } };
          }

          if (tool.name === 'list_issues') {
            const state = args.state || 'all';
            const issues = Array.from(repo!.issues.values()).filter((i) => state === 'all' || i.state === state);
            return { status: 200, json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ issues: issues.map(i => formatIssue(repo!.owner, repo!.name, i)) }) }] } } };
          }

          if (tool.name === 'create_pull_request') {
            const { title, head, base, body } = args;
            const headSha = repo!.refs.get(`refs/heads/${head}`) || repo!.refs.get(head) || head;
            const baseSha = repo!.refs.get(`refs/heads/${base}`) || repo!.refs.get(base) || base;
            if (headSha === baseSha || !repo!.objects.has(headSha) || !repo!.objects.has(baseSha)) {
              return {
                status: 200,
                json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Invalid refs' }], isError: true } },
              };
            }
            const pr: Pull = {
              number: repo!.nextPrNumber++,
              title,
              body: body || '',
              state: 'open',
              head: { ref: head, sha: headSha },
              base: { ref: base, sha: baseSha },
              merged: false,
              merged_at: null,
              merge_commit_sha: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            repo!.prs.set(pr.number, pr);
            return { status: 200, json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(formatPull(repo!.owner, repo!.name, pr)) }] } } };
          }

          if (tool.name === 'merge_pull_request') {
            const { pull_number, merge_method } = args;
            if (merge_method !== undefined && merge_method !== 'squash') {
              return {
                status: 200,
                json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Only squash merges supported' }], isError: true } },
              };
            }
            const pr = repo!.prs.get(Number(pull_number));
            if (!pr || pr.state === 'closed') {
              return {
                status: 200,
                json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'PR not found or already merged' }], isError: true } },
              };
            }
            const baseRefKey = `refs/heads/${pr.base.ref}`;
            const headTipSha = resolveTip(repo!, pr.head.ref, pr.head.sha);
            const baseTipSha = resolveTip(repo!, pr.base.ref, pr.base.sha);
            const mergeBase = findMergeBase(repo!, headTipSha, baseTipSha) ?? baseTipSha;
            if (checkPullConflicts(repo!, mergeBase, headTipSha, baseTipSha)) {
              return {
                status: 200,
                json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Conflict' }], isError: true } },
              };
            }
            const mergeCommitSha = squashMergeCommit(
              repo!,
              baseRefKey,
              headTipSha,
              `${pr.title} (#${pr.number})`,
              'Ada Iversen <ada@example.com> 1770000000 +0000'
            );
            pr.state = 'closed';
            pr.merged = true;
            pr.merged_at = new Date().toISOString();
            pr.merge_commit_sha = mergeCommitSha;
            repo!.generation++;
            return { status: 200, json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(formatPull(repo!.owner, repo!.name, pr)) }] } } };
          }
        } catch (e) {
          return {
            status: 200,
            json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e) }], isError: true } },
          };
        }
      }

      return { status: 200, json: { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } } };
    } catch (e) {
      return { status: 200, json: { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } } };
    }
  };
}
