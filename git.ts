import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface GitRepo {
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  generation: number;
  defaultBranch: string;
}

export const FLUSH_PKT = Buffer.from('0000');
export const DELIM_PKT = Buffer.from('0001');
export const END_PKT = Buffer.from('0002');

const ZERO_OID = '0'.repeat(40);
const MAX_SIDEBAND_DATA = 65515;

const fetchPackCache = new WeakMap<GitRepo, Map<string, { generation: number; pack: Buffer; newShallows: string[]; unshallows: string[] }>>();

export function computeObjectId(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
} {
  const raw = data.toString('utf8');
  const sepIdx = raw.indexOf('\n\n');
  const headerText = sepIdx === -1 ? raw : raw.slice(0, sepIdx);
  const message = sepIdx === -1 ? '' : raw.slice(sepIdx + 2);

  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';

  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) {
      tree = line.slice(5);
    } else if (line.startsWith('parent ')) {
      parents.push(line.slice(7));
    } else if (line.startsWith('author ')) {
      author = line.slice(7);
    } else if (line.startsWith('committer ')) {
      committer = line.slice(10);
    }
  }

  return { tree, parents, author, committer, message };
}

export function buildCommit(input: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${input.author}`);
  lines.push(`committer ${input.committer}`);
  return Buffer.from(`${lines.join('\n')}

${input.message}`, 'utf8');
}

function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

export function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const spaceIdx = data.indexOf(0x20, offset);
    if (spaceIdx === -1) {
      throw new Error('Malformed tree entry: missing space');
    }
    const nulIdx = data.indexOf(0x00, spaceIdx + 1);
    if (nulIdx === -1) {
      throw new Error('Malformed tree entry: missing NUL');
    }
    if (nulIdx + 21 > data.length) {
      throw new Error('Malformed tree entry: truncated oid');
    }
    const mode = data.subarray(offset, spaceIdx).toString('ascii');
    const name = data.subarray(spaceIdx + 1, nulIdx).toString('utf8');
    const oid = data.subarray(nulIdx + 1, nulIdx + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nulIdx + 21;
  }
  return entries;
}

export function buildTree(entries: Array<{ mode: string; name: string; oid: string }>): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = Buffer.from(isTreeMode(a.mode) ? `${a.name}/` : a.name, 'utf8');
    const bKey = Buffer.from(isTreeMode(b.mode) ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(aKey, bKey);
  });

  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

export function parseTag(data: Buffer): {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
} {
  const raw = data.toString('utf8');
  const sepIdx = raw.indexOf('\n\n');
  const headerText = sepIdx === -1 ? raw : raw.slice(0, sepIdx);
  const message = sepIdx === -1 ? '' : raw.slice(sepIdx + 2);

  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';

  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) {
      object = line.slice(7);
    } else if (line.startsWith('type ')) {
      type = line.slice(5);
    } else if (line.startsWith('tag ')) {
      tag = line.slice(4);
    } else if (line.startsWith('tagger ')) {
      tagger = line.slice(7);
    }
  }

  return { object, type, tag, tagger, message };
}

export function buildTag(input: {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}): Buffer {
  const lines = [
    `object ${input.object}`,
    `type ${input.type}`,
    `tag ${input.tag}`,
    `tagger ${input.tagger}`,
  ];
  return Buffer.from(`${lines.join('\n')}

${input.message}`, 'utf8');
}

export function getTreeReachableObjects(repo: GitRepo, treeOid: string): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (!oid || visited.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    visited.add(oid);
    if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (const entry of entries) {
        if (!visited.has(entry.oid)) {
          stack.push(entry.oid);
        }
      }
    }
  }
  return visited;
}

export function getReachableObjects(repo: GitRepo, tips: string[]): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (!oid || visited.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    visited.add(oid);
    if (obj.type === 'commit') {
      const { tree, parents } = parseCommit(obj.data);
      if (tree && !visited.has(tree)) {
        stack.push(tree);
      }
      for (const parent of parents) {
        if (!visited.has(parent)) {
          stack.push(parent);
        }
      }
    } else if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (const entry of entries) {
        if (!visited.has(entry.oid)) {
          stack.push(entry.oid);
        }
      }
    } else if (obj.type === 'tag') {
      const { object } = parseTag(obj.data);
      if (object && !visited.has(object)) {
        stack.push(object);
      }
    }
  }
  return visited;
}

export function flattenTree(
  repo: GitRepo,
  treeOid: string,
  prefix: string,
): Array<{ path: string; oid: string; mode: string }> {
  const result: Array<{ path: string; oid: string; mode: string }> = [];
  const stack: Array<{ oid: string; prefix: string }> = [{ oid: treeOid, prefix }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const obj = repo.objects.get(current.oid);
    if (!obj || obj.type !== 'tree') continue;
    const base = current.prefix
      ? current.prefix.endsWith('/')
        ? current.prefix
        : `${current.prefix}/`
      : '';
    const entries = parseTree(obj.data);
    for (const entry of entries) {
      const fullPath = `${base}${entry.name}`;
      if (isTreeMode(entry.mode)) {
        stack.push({ oid: entry.oid, prefix: fullPath });
      } else {
        result.push({ path: fullPath, oid: entry.oid, mode: entry.mode });
      }
    }
  }

  result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function computeLineDiff(
  oldText: string,
  newText: string,
): { additions: number; deletions: number; lines: Array<{ type: 'add' | 'del' | 'same'; text: string }> } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const m = oldLines.length;
  const n = newLines.length;
  const cols = n + 1;
  const dp = new Uint32Array((m + 1) * cols);

  for (let i = m - 1; i >= 0; i--) {
    const rowOffset = i * cols;
    const nextRowOffset = (i + 1) * cols;
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[rowOffset + j] = dp[nextRowOffset + j + 1] + 1;
      } else {
        const down = dp[nextRowOffset + j];
        const right = dp[rowOffset + j + 1];
        dp[rowOffset + j] = down >= right ? down : right;
      }
    }
  }

  const lines: Array<{ type: 'add' | 'del' | 'same'; text: string }> = [];
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;

  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ type: 'same', text: oldLines[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
      lines.push({ type: 'del', text: oldLines[i] });
      deletions++;
      i++;
    } else {
      lines.push({ type: 'add', text: newLines[j] });
      additions++;
      j++;
    }
  }

  while (i < m) {
    lines.push({ type: 'del', text: oldLines[i++] });
    deletions++;
  }
  while (j < n) {
    lines.push({ type: 'add', text: newLines[j++] });
    additions++;
  }

  return { additions, deletions, lines };
}

export function findMergeBase(repo: GitRepo, a: string, b: string): string | null {
  const objA = repo.objects.get(a);
  const objB = repo.objects.get(b);
  if (!objA || objA.type !== 'commit' || !objB || objB.type !== 'commit') {
    return null;
  }
  if (a === b) return a;

  const seenA = new Set<string>([a]);
  const seenB = new Set<string>([b]);
  let frontA: string[] = [a];
  let frontB: string[] = [b];

  while (frontA.length > 0 || frontB.length > 0) {
    if (frontA.length > 0) {
      const nextA: string[] = [];
      for (const oid of frontA) {
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const { parents } = parseCommit(obj.data);
        for (const p of parents) {
          if (seenB.has(p)) return p;
          if (!seenA.has(p)) {
            seenA.add(p);
            nextA.push(p);
          }
        }
      }
      frontA = nextA;
    }

    if (frontB.length > 0) {
      const nextB: string[] = [];
      for (const oid of frontB) {
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const { parents } = parseCommit(obj.data);
        for (const p of parents) {
          if (seenA.has(p)) return p;
          if (!seenB.has(p)) {
            seenB.add(p);
            nextB.push(p);
          }
        }
      }
      frontB = nextB;
    }
  }

  return null;
}

function getCommitTreeMap(repo: GitRepo, commitOid: string): Map<string, string> {
  const map = new Map<string, string>();
  const commitObj = repo.objects.get(commitOid);
  if (!commitObj || commitObj.type !== 'commit') return map;
  const { tree } = parseCommit(commitObj.data);
  for (const entry of flattenTree(repo, tree, '')) {
    map.set(entry.path, entry.oid);
  }
  return map;
}

export function getPullFilesDiff(
  repo: GitRepo,
  baseOid: string,
  headOid: string,
): Array<{ path: string; additions: number; deletions: number; changeType: 'added' | 'removed' | 'modified' }> {
  const baseMap = getCommitTreeMap(repo, baseOid);
  const headMap = getCommitTreeMap(repo, headOid);
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  const sortedPaths = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const diffs: Array<{
    path: string;
    additions: number;
    deletions: number;
    changeType: 'added' | 'removed' | 'modified';
  }> = [];

  for (const filePath of sortedPaths) {
    const bOid = baseMap.get(filePath);
    const hOid = headMap.get(filePath);
    if (bOid === undefined && hOid !== undefined) {
      const text = repo.objects.get(hOid)?.data.toString('utf8') ?? '';
      diffs.push({
        path: filePath,
        additions: splitLines(text).length,
        deletions: 0,
        changeType: 'added',
      });
    } else if (bOid !== undefined && hOid === undefined) {
      const text = repo.objects.get(bOid)?.data.toString('utf8') ?? '';
      diffs.push({
        path: filePath,
        additions: 0,
        deletions: splitLines(text).length,
        changeType: 'removed',
      });
    } else if (bOid !== undefined && hOid !== undefined && bOid !== hOid) {
      const oldText = repo.objects.get(bOid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(hOid)?.data.toString('utf8') ?? '';
      const lineDiff = computeLineDiff(oldText, newText);
      diffs.push({
        path: filePath,
        additions: lineDiff.additions,
        deletions: lineDiff.deletions,
        changeType: 'modified',
      });
    }
  }

  return diffs;
}

export function checkPullConflicts(
  repo: GitRepo,
  mergeBaseOid: string,
  headOid: string,
  baseOid: string,
): boolean {
  const mergeBaseMap = getCommitTreeMap(repo, mergeBaseOid);
  const headMap = getCommitTreeMap(repo, headOid);
  const baseMap = getCommitTreeMap(repo, baseOid);

  const allPaths = new Set<string>([
    ...mergeBaseMap.keys(),
    ...headMap.keys(),
    ...baseMap.keys(),
  ]);

  for (const filePath of allPaths) {
    const mOid = mergeBaseMap.get(filePath);
    const hOid = headMap.get(filePath);
    const bOid = baseMap.get(filePath);

    const changedInHead = hOid !== mOid;
    const changedInBase = bOid !== mOid;
    if (!changedInHead || !changedInBase) continue;

    if (hOid === bOid) continue;
    if (hOid === undefined || bOid === undefined) return true;

    const hBlob = repo.objects.get(hOid);
    const bBlob = repo.objects.get(bOid);
    if (!hBlob || !bBlob || !hBlob.data.equals(bBlob.data)) {
      return true;
    }
  }

  return false;
}

export function squashMergeCommit(
  repo: GitRepo,
  baseRef: string,
  headOid: string,
  message: string,
  author: string,
): string {
  const headObj = repo.objects.get(headOid);
  if (!headObj || headObj.type !== 'commit') {
    throw new Error(`Invalid head commit: ${headOid}`);
  }
  const { tree } = parseCommit(headObj.data);
  const baseTip = repo.refs.get(baseRef);
  const parents = baseTip ? [baseTip] : [];
  const commitData = buildCommit({
    tree,
    parents,
    author,
    committer: author,
    message,
  });
  const newOid = computeObjectId('commit', commitData);
  repo.objects.set(newOid, { type: 'commit', data: commitData });
  repo.refs.set(baseRef, newOid);
  return newOid;
}

function upsertTreePath(
  repo: GitRepo,
  treeOid: string | null,
  segments: string[],
  index: number,
  blobOid: string,
): string {
  const existingObj = treeOid ? repo.objects.get(treeOid) : undefined;
  const entries =
    existingObj && existingObj.type === 'tree' ? parseTree(existingObj.data) : [];
  const name = segments[index];
  const existingIdx = entries.findIndex((e) => e.name === name);

  if (index === segments.length - 1) {
    const existingMode =
      existingIdx !== -1 && !isTreeMode(entries[existingIdx].mode)
        ? entries[existingIdx].mode
        : '100644';
    const filtered = entries.filter((e) => e.name !== name);
    filtered.push({ mode: existingMode, name, oid: blobOid });
    const treeData = buildTree(filtered);
    const newOid = computeObjectId('tree', treeData);
    repo.objects.set(newOid, { type: 'tree', data: treeData });
    return newOid;
  }

  const existingSubTreeOid =
    existingIdx !== -1 && isTreeMode(entries[existingIdx].mode)
      ? entries[existingIdx].oid
      : null;
  const subTreeOid = upsertTreePath(repo, existingSubTreeOid, segments, index + 1, blobOid);
  const filtered = entries.filter((e) => e.name !== name);
  filtered.push({ mode: '40000', name, oid: subTreeOid });
  const treeData = buildTree(filtered);
  const newOid = computeObjectId('tree', treeData);
  repo.objects.set(newOid, { type: 'tree', data: treeData });
  return newOid;
}

export function commitFile(
  repo: GitRepo,
  branch: string,
  filePath: string,
  content: Buffer,
  message: string,
  author: string,
): { commit: string; tree: string } {
  const segments = filePath.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error('File path must not be empty');
  }

  const blobOid = computeObjectId('blob', content);
  repo.objects.set(blobOid, { type: 'blob', data: content });

  const tipOid = repo.refs.get(branch);
  let rootTreeOid: string | null = null;
  if (tipOid) {
    const tipObj = repo.objects.get(tipOid);
    if (tipObj && tipObj.type === 'commit') {
      rootTreeOid = parseCommit(tipObj.data).tree;
    }
  }

  const newTreeOid = upsertTreePath(repo, rootTreeOid, segments, 0, blobOid);
  const commitData = buildCommit({
    tree: newTreeOid,
    parents: tipOid ? [tipOid] : [],
    author,
    committer: author,
    message,
  });
  const newCommitOid = computeObjectId('commit', commitData);
  repo.objects.set(newCommitOid, { type: 'commit', data: commitData });
  repo.refs.set(branch, newCommitOid);
  return { commit: newCommitOid, tree: newTreeOid };
}

function removeTreePath(
  repo: GitRepo,
  treeOid: string,
  segments: string[],
  index: number,
): { changed: boolean; treeOid: string | null } {
  const treeObj = repo.objects.get(treeOid);
  if (!treeObj || treeObj.type !== 'tree') {
    return { changed: false, treeOid };
  }
  const entries = parseTree(treeObj.data);
  const name = segments[index];
  const target = entries.find((e) => e.name === name);
  if (!target) {
    return { changed: false, treeOid };
  }

  if (index === segments.length - 1) {
    if (isTreeMode(target.mode)) {
      return { changed: false, treeOid };
    }
    const remaining = entries.filter((e) => e.name !== name);
    if (remaining.length === 0) {
      return { changed: true, treeOid: null };
    }
    const newData = buildTree(remaining);
    const newOid = computeObjectId('tree', newData);
    repo.objects.set(newOid, { type: 'tree', data: newData });
    return { changed: true, treeOid: newOid };
  }

  if (!isTreeMode(target.mode)) {
    return { changed: false, treeOid };
  }
  const subResult = removeTreePath(repo, target.oid, segments, index + 1);
  if (!subResult.changed) {
    return { changed: false, treeOid };
  }

  const remaining =
    subResult.treeOid === null
      ? entries.filter((e) => e.name !== name)
      : entries.map((e) => (e.name === name ? { ...e, oid: subResult.treeOid! } : e));

  if (remaining.length === 0) {
    return { changed: true, treeOid: null };
  }
  const newData = buildTree(remaining);
  const newOid = computeObjectId('tree', newData);
  repo.objects.set(newOid, { type: 'tree', data: newData });
  return { changed: true, treeOid: newOid };
}

export function deleteFile(
  repo: GitRepo,
  branch: string,
  filePath: string,
  message: string,
  author: string,
): { commit: string } | null {
  const segments = filePath.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const tipOid = repo.refs.get(branch);
  if (!tipOid) return null;
  const tipObj = repo.objects.get(tipOid);
  if (!tipObj || tipObj.type !== 'commit') return null;

  const { tree } = parseCommit(tipObj.data);
  const result = removeTreePath(repo, tree, segments, 0);
  if (!result.changed) return null;

  let newRootTreeOid = result.treeOid;
  if (newRootTreeOid === null) {
    const emptyTreeData = buildTree([]);
    newRootTreeOid = computeObjectId('tree', emptyTreeData);
    repo.objects.set(newRootTreeOid, { type: 'tree', data: emptyTreeData });
  }

  const commitData = buildCommit({
    tree: newRootTreeOid,
    parents: [tipOid],
    author,
    committer: author,
    message,
  });
  const newCommitOid = computeObjectId('commit', commitData);
  repo.objects.set(newCommitOid, { type: 'commit', data: commitData });
  repo.refs.set(branch, newCommitOid);
  return { commit: newCommitOid };
}

export function readFileAtRef(
  repo: GitRepo,
  ref: string,
  filePath: string,
): { oid: string; content: Buffer } | null {
  const segments = filePath.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  let oid = repo.refs.get(ref) ?? ref;
  let obj = repo.objects.get(oid);
  while (obj && obj.type === 'tag') {
    oid = parseTag(obj.data).object;
    obj = repo.objects.get(oid);
  }
  if (!obj || obj.type !== 'commit') return null;

  let currentTreeOid = parseCommit(obj.data).tree;
  for (let i = 0; i < segments.length; i++) {
    const treeObj = repo.objects.get(currentTreeOid);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entries = parseTree(treeObj.data);
    const entry = entries.find((e) => e.name === segments[i]);
    if (!entry) return null;

    if (i === segments.length - 1) {
      if (isTreeMode(entry.mode)) return null;
      const blobObj = repo.objects.get(entry.oid);
      if (!blobObj || blobObj.type !== 'blob') return null;
      return { oid: entry.oid, content: blobObj.data };
    }

    if (!isTreeMode(entry.mode)) return null;
    currentTreeOid = entry.oid;
  }

  return null;
}

export function getDirectoryListing(
  repo: GitRepo,
  commitOid: string,
  path: string,
): Array<{ name: string; path: string; sha: string; size: number; type: 'file' | 'dir' }> | null {
  const commitObj = repo.objects.get(commitOid);
  if (!commitObj || commitObj.type !== 'commit') return null;
  const segments = path.split('/').filter(Boolean);

  let treeOid = parseCommit(commitObj.data).tree;
  for (let i = 0; i < segments.length; i++) {
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entries = parseTree(treeObj.data);
    const entry = entries.find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (!isTreeMode(entry.mode)) return null;
    treeOid = entry.oid;
  }

  const treeObj = repo.objects.get(treeOid);
  if (!treeObj || treeObj.type !== 'tree') return null;
  const entries = parseTree(treeObj.data);
  const base = path.endsWith('/') ? path : `${path}/`;
  return entries.map((entry) => {
    const isDir = isTreeMode(entry.mode);
    const fullPath = `${base}${entry.name}`;
    if (isDir) {
      return { name: entry.name, path: fullPath, sha: entry.oid, size: 0, type: 'dir' };
    }
    const blob = repo.objects.get(entry.oid);
    return { name: entry.name, path: fullPath, sha: entry.oid, size: blob ? blob.data.length : 0, type: 'file' };
  });
}

export function isDescendant(repo: GitRepo, descendantOid: string, ancestorOid: string): boolean {
  if (descendantOid === ancestorOid) return true;
  const visited = new Set<string>();
  const stack: string[] = [descendantOid];

  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestorOid) return true;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const { parents } = parseCommit(obj.data);
    for (const parent of parents) {
      if (parent === ancestorOid) return true;
      if (!visited.has(parent)) {
        stack.push(parent);
      }
    }
  }

  return false;
}

export function encodePktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const lenHex = (payload.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(lenHex, 'ascii'), payload]);
}

export function parsePktLines(
  buf: Buffer,
): Array<{ kind: 'data' | 'flush' | 'delim' | 'end'; data: Buffer }> {
  const result: Array<{ kind: 'data' | 'flush' | 'delim' | 'end'; data: Buffer }> = [];
  let offset = 0;

  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new Error('Truncated pkt-line length header');
    }
    const lenStr = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenStr)) {
      throw new Error(`Malformed pkt-line length: ${lenStr}`);
    }
    const len = parseInt(lenStr, 16);
    if (len === 0) {
      result.push({ kind: 'flush', data: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      result.push({ kind: 'delim', data: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      result.push({ kind: 'end', data: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 3) {
      throw new Error('Malformed pkt-line length: 0003');
    } else {
      if (offset + len > buf.length) {
        throw new Error('Truncated pkt-line payload');
      }
      result.push({ kind: 'data', data: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }

  return result;
}

function typeCodeToName(code: number): GitObject['type'] {
  switch (code) {
    case 1:
      return 'commit';
    case 2:
      return 'tree';
    case 3:
      return 'blob';
    case 4:
      return 'tag';
    default:
      throw new Error(`Invalid git object type code: ${code}`);
  }
}

function typeNameToCode(type: GitObject['type']): number {
  switch (type) {
    case 'commit':
      return 1;
    case 'tree':
      return 2;
    case 'blob':
      return 3;
    case 'tag':
      return 4;
  }
}

function readDeltaVarint(buf: Buffer, state: { pos: number }): number {
  let size = 0;
  let shift = 0;
  while (true) {
    if (state.pos >= buf.length) {
      throw new Error('Truncated delta varint');
    }
    const b = buf[state.pos++];
    size += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return size;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const state = { pos: 0 };
  const baseSize = readDeltaVarint(delta, state);
  if (baseSize !== base.length) {
    throw new Error(`Delta base size mismatch: expected ${baseSize}, got ${base.length}`);
  }
  const resultSize = readDeltaVarint(delta, state);
  const result = Buffer.allocUnsafe(resultSize);
  let outPos = 0;

  while (state.pos < delta.length) {
    const cmd = delta[state.pos++];
    if ((cmd & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if (cmd & 0x01) copyOffset += delta[state.pos++];
      if (cmd & 0x02) copyOffset += delta[state.pos++] * 256;
      if (cmd & 0x04) copyOffset += delta[state.pos++] * 65536;
      if (cmd & 0x08) copyOffset += delta[state.pos++] * 16777216;
      if (cmd & 0x10) copySize += delta[state.pos++];
      if (cmd & 0x20) copySize += delta[state.pos++] * 256;
      if (cmd & 0x40) copySize += delta[state.pos++] * 65536;
      if (copySize === 0) copySize = 0x10000;
      if (state.pos > delta.length || copyOffset + copySize > base.length || outPos + copySize > resultSize) {
        throw new Error('Delta copy out of bounds');
      }
      base.copy(result, outPos, copyOffset, copyOffset + copySize);
      outPos += copySize;
    } else if (cmd > 0) {
      if (state.pos + cmd > delta.length || outPos + cmd > resultSize) {
        throw new Error('Delta insert out of bounds');
      }
      delta.copy(result, outPos, state.pos, state.pos + cmd);
      state.pos += cmd;
      outPos += cmd;
    } else {
      throw new Error('Invalid delta instruction 0');
    }
  }

  if (outPos !== resultSize) {
    throw new Error(`Delta result size mismatch: expected ${resultSize}, got ${outPos}`);
  }
  return result;
}

interface RawPackEntry {
  startOffset: number;
  typeCode: number;
  rawData: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

export function readPackfile(buf: Buffer): { objects: Map<string, GitObject>; checksum: string } {
  if (buf.length < 32) {
    throw new Error('Packfile too short');
  }
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('Invalid packfile magic');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`Unsupported packfile version: ${version}`);
  }

  const packEnd = buf.length - 20;
  const expectedTrailer = buf.subarray(packEnd);
  const actualTrailer = createHash('sha1').update(buf.subarray(0, packEnd)).digest();
  if (!actualTrailer.equals(expectedTrailer)) {
    throw new Error('Packfile checksum mismatch');
  }
  const checksum = expectedTrailer.toString('hex');

  const count = buf.readUInt32BE(8);
  const entries: RawPackEntry[] = [];
  const offsetToIndex = new Map<number, number>();
  let offset = 12;

  for (let i = 0; i < count; i++) {
    if (offset >= packEnd) {
      throw new Error('Unexpected end of packfile');
    }
    const startOffset = offset;
    offsetToIndex.set(startOffset, i);

    let b = buf[offset++];
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      if (offset >= packEnd) {
        throw new Error('Truncated packfile object header');
      }
      b = buf[offset++];
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
    }

    let baseOffset: number | undefined;
    let baseOid: string | undefined;

    if (typeCode === 6) {
      let ofsByte = buf[offset++];
      let relOffset = ofsByte & 0x7f;
      while ((ofsByte & 0x80) !== 0) {
        if (offset >= packEnd) {
          throw new Error('Truncated OFS_DELTA offset');
        }
        ofsByte = buf[offset++];
        relOffset = (relOffset + 1) * 128 + (ofsByte & 0x7f);
      }
      baseOffset = startOffset - relOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > packEnd) {
        throw new Error('Truncated REF_DELTA base oid');
      }
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeCode < 1 || typeCode > 4) {
      throw new Error(`Invalid packfile object type code: ${typeCode}`);
    }

    // Use `{ info: true }` so zlib reports exact compressed bytes consumed in one pass,
    // avoiding slow byte-by-byte or chunked inflate probing per pack entry.
    const inflated = inflateSync(buf.subarray(offset, packEnd), { info: true });
    const rawData = inflated.buffer;
    offset += inflated.engine.bytesWritten;

    if (rawData.length !== size) {
      throw new Error(`Packfile object size mismatch: expected ${size}, got ${rawData.length}`);
    }

    entries.push({ startOffset, typeCode, rawData, baseOffset, baseOid });
  }

  if (offset !== packEnd) {
    throw new Error('Trailing bytes in packfile');
  }

  const objects = new Map<string, GitObject>();
  const resolved: Array<GitObject | undefined> = new Array(count);
  const resolving = new Set<number>();

  const tryResolveEntry = (idx: number): GitObject | undefined => {
    if (resolved[idx]) return resolved[idx];
    if (resolving.has(idx)) {
      throw new Error('Cycle detected in packfile deltas');
    }
    const entry = entries[idx];
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      const obj: GitObject = { type: typeCodeToName(entry.typeCode), data: entry.rawData };
      const oid = computeObjectId(obj.type, obj.data);
      objects.set(oid, obj);
      resolved[idx] = obj;
      return obj;
    }

    resolving.add(idx);
    try {
      let baseObj: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseIdx = offsetToIndex.get(entry.baseOffset!);
        if (baseIdx === undefined) {
          throw new Error(`Missing OFS_DELTA base at offset ${entry.baseOffset}`);
        }
        baseObj = tryResolveEntry(baseIdx);
      } else if (entry.typeCode === 7) {
        baseObj = objects.get(entry.baseOid!);
      }

      if (!baseObj) return undefined;
      const reconstructed = applyDelta(baseObj.data, entry.rawData);
      const obj: GitObject = { type: baseObj.type, data: reconstructed };
      const oid = computeObjectId(obj.type, obj.data);
      objects.set(oid, obj);
      resolved[idx] = obj;
      return obj;
    } finally {
      resolving.delete(idx);
    }
  };

  for (let i = 0; i < count; i++) {
    const entry = entries[i];
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      tryResolveEntry(i);
    }
  }

  let remaining = count;
  while (remaining > 0) {
    let madeProgress = false;
    let unresolved = 0;
    for (let i = 0; i < count; i++) {
      if (resolved[i]) continue;
      const res = tryResolveEntry(i);
      if (res) {
        madeProgress = true;
      } else {
        unresolved++;
      }
    }
    if (unresolved === 0) break;
    if (!madeProgress) {
      throw new Error('Unresolved REF_DELTA base in packfile');
    }
    remaining = unresolved;
  }

  return { objects, checksum };
}

export function buildPack(
  objects: Map<string, GitObject> | Iterable<[string, GitObject]>,
): Buffer {
  const entries = [...objects].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);

  const chunks: Buffer[] = [header];
  for (const [, obj] of entries) {
    const typeCode = typeNameToCode(obj.type);
    let len = obj.data.length;
    const varint: number[] = [];
    let first = (typeCode << 4) | (len & 0x0f);
    len = Math.floor(len / 16);
    if (len > 0) first |= 0x80;
    varint.push(first);
    while (len > 0) {
      let byte = len & 0x7f;
      len = Math.floor(len / 128);
      if (len > 0) byte |= 0x80;
      varint.push(byte);
    }
    chunks.push(Buffer.from(varint));
    chunks.push(deflateSync(obj.data, { level: 1 }));
  }

  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function wrapSideband(data: Buffer): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += MAX_SIDEBAND_DATA) {
    const slice = data.subarray(offset, Math.min(offset + MAX_SIDEBAND_DATA, data.length));
    const payload = Buffer.allocUnsafe(slice.length + 1);
    payload[0] = 0x01;
    slice.copy(payload, 1);
    chunks.push(encodePktLine(payload));
  }
  return Buffer.concat(chunks);
}

export function handleInfoRefs(
  repo: GitRepo,
  service: string,
  gitProtocol: string | null,
): { status: number; headers: Record<string, string>; body: Buffer } {
  const headers = { 'Content-Type': `application/x-${service}-advertisement` };
  const isV2 =
    service === 'git-upload-pack' &&
    typeof gitProtocol === 'string' &&
    gitProtocol.split(':').includes('version=2');

  if (isV2) {
    const body = Buffer.concat([
      encodePktLine('version 2\n'),
      encodePktLine('ls-refs\n'),
      encodePktLine('fetch=shallow\n'),
      encodePktLine('server-option\n'),
      encodePktLine('object-format=sha1\n'),
      FLUSH_PKT,
    ]);
    return { status: 200, headers, body };
  }

  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(defaultRef) ?? ZERO_OID;
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k multi_ack ofs-delta shallow symref=HEAD:${defaultRef} agent=git/makefun`
      : 'report-status side-band-64k delete-refs';

  const lines: Buffer[] = [
    encodePktLine(`# service=${service}
`),
    FLUSH_PKT,
    encodePktLine(`${headOid} HEAD\0${caps}
`),
  ];

  const sortedRefs = [...repo.refs.entries()]
    .filter(([name]) => name !== 'HEAD')
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  for (const [refName, oid] of sortedRefs) {
    lines.push(encodePktLine(`${oid} ${refName}
`));
  }

  lines.push(FLUSH_PKT);
  return { status: 200, headers, body: Buffer.concat(lines) };
}

export function handleLsRefs(
  repo: GitRepo,
  body: Buffer,
): { status: number; headers: Record<string, string>; body: Buffer } {
  const pkts = parsePktLines(body);
  const delimIdx = pkts.findIndex((p) => p.kind === 'delim');
  const argPkts = delimIdx !== -1 ? pkts.slice(delimIdx + 1) : pkts;

  const prefixes: string[] = [];
  let peel = false;
  let unborn = false;
  let symrefs = false;

  for (const pkt of argPkts) {
    if (pkt.kind === 'flush') break;
    if (pkt.kind !== 'data') continue;
    const line = pkt.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('ref-prefix ')) {
      prefixes.push(line.slice('ref-prefix '.length));
    } else if (line === 'peel') {
      peel = true;
    } else if (line === 'unborn') {
      unborn = true;
    } else if (line === 'symrefs') {
      symrefs = true;
    }
  }

  const matchesPrefix = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const out: Buffer[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  if (matchesPrefix('HEAD')) {
    const headOid = repo.refs.get(defaultRef);
    const symAttr = symrefs ? ` symref-target:${defaultRef}` : '';
    if (headOid) {
      out.push(encodePktLine(`${headOid} HEAD${symAttr}
`));
    } else if (unborn) {
      out.push(encodePktLine(`unborn HEAD${symAttr}
`));
    }
  }

  const sortedRefs = [...repo.refs.entries()]
    .filter(([name]) => name !== 'HEAD' && matchesPrefix(name))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  for (const [refName, oid] of sortedRefs) {
    let line = `${oid} ${refName}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const t = parseTag(obj.data);
        if (t.object) {
          line += ` peeled:${t.object}`;
        }
      }
    }
    out.push(encodePktLine(`${line}
`));
  }

  out.push(FLUSH_PKT);
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(out),
  };
}

export function computeFetchPack(
  repo: GitRepo,
  wants: string[],
  haves: string[],
  depth: number,
  shallows: string[],
): { pack: Buffer; newShallows: string[]; unshallows: string[] } {
  const wantSet =
    depth === 0 || haves.length > 0 ? getReachableObjects(repo, wants) : new Set<string>();
  const haveSet = haves.length > 0 ? getReachableObjects(repo, haves) : new Set<string>();
  const toSend = new Map<string, GitObject>();

  if (depth === 0) {
    for (const oid of wantSet) {
      if (haveSet.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj) {
        toSend.set(oid, obj);
      }
    }
    return { pack: buildPack(toSend), newShallows: [], unshallows: [] };
  }

  // Shallow-aware send set: the client already holds each have commit and its
  // tree objects. Traversal must NOT stop at haves (a deepen walks THROUGH
  // the held tip to reach its parents); haves only suppress SENDING.
  const shallowHaveObjs = new Set<string>();
  for (const h of haves) {
    shallowHaveObjs.add(h);
    const hObj = repo.objects.get(h);
    if (hObj && hObj.type === 'commit') {
      const c = parseCommit(hObj.data);
      if (c.tree) {
        for (const tid of getTreeReachableObjects(repo, c.tree)) {
          shallowHaveObjs.add(tid);
        }
      }
    }
  }

  const keptCommits = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = wants.map((w) => ({ oid: w, dist: 1 }));
  while (queue.length > 0) {
    const { oid, dist } = queue.pop()!;
    if (dist > depth) continue;
    if (keptCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      keptCommits.add(oid);
      const { parents } = parseCommit(obj.data);
      for (const p of parents) {
        queue.push({ oid: p, dist: dist + 1 });
      }
    }
  }

  for (const commitId of keptCommits) {
    if (!shallowHaveObjs.has(commitId)) {
      const commitObj = repo.objects.get(commitId);
      if (commitObj) toSend.set(commitId, commitObj);
    }
    const commitObj = repo.objects.get(commitId);
    if (commitObj && commitObj.type === 'commit') {
      const { tree } = parseCommit(commitObj.data);
      if (tree) {
        for (const tid of getTreeReachableObjects(repo, tree)) {
          if (!shallowHaveObjs.has(tid) && !toSend.has(tid)) {
            const treeObj = repo.objects.get(tid);
            if (treeObj) toSend.set(tid, treeObj);
          }
        }
      }
    }
  }

  const shallowSet = new Set(shallows);
  const newShallows: string[] = [];
  const unshallows: string[] = [];
  for (const commitOid of keptCommits) {
    const commitObj = repo.objects.get(commitOid);
    if (!commitObj || commitObj.type !== 'commit') continue;
    const { parents } = parseCommit(commitObj.data);
    if (parents.length > 0) {
      const hasUnkeptParent = parents.some((p) => !keptCommits.has(p));
      if (hasUnkeptParent) {
        newShallows.push(commitOid);
      }
    }
    if (shallowSet.has(commitOid)) {
      const allParentsKept = parents.length > 0 && parents.every((p) => keptCommits.has(p));
      if (allParentsKept) {
        unshallows.push(commitOid);
      }
    }
  }

  return { pack: buildPack(toSend), newShallows, unshallows };
}

export function handleFetch(
  repo: GitRepo,
  body: Buffer,
): { status: number; headers: Record<string, string>; body: Buffer } {
  const pkts = parsePktLines(body);
  let isV2 = false;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth = 0;

  for (const pkt of pkts) {
    if (pkt.kind === 'delim') {
      isV2 = true;
      continue;
    }
    if (pkt.kind !== 'data') continue;
    const line = pkt.data.toString('utf8').replace(/\n$/, '');
    if (line === 'command=fetch') {
      isV2 = true;
    } else if (line.startsWith('want ')) {
      const oid = line.slice(5).trim().split(' ')[0];
      if (oid) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (oid) haves.push(oid);
    } else if (line.startsWith('depth ')) {
      depth = parseInt(line.slice(6).trim(), 10) || 0;
    } else if (line.startsWith('deepen ')) {
      depth = parseInt(line.slice(7).trim(), 10) || 0;
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (oid) shallows.push(oid);
    }
  }

  const cacheKey = `${wants.join(',')}|${haves.join(',')}|${depth}|${shallows.join(',')}`;
  let repoCache = fetchPackCache.get(repo);
  if (!repoCache) {
    repoCache = new Map();
    fetchPackCache.set(repo, repoCache);
  }
  const cached = repoCache.get(cacheKey);
  let packBuf: Buffer;
  let newShallows: string[] = [];
  let unshallows: string[] = [];
  if (cached && cached.generation === repo.generation) {
    packBuf = cached.pack;
    newShallows = cached.newShallows;
    unshallows = cached.unshallows;
  } else {
    const computed = computeFetchPack(repo, wants, haves, depth, shallows);
    packBuf = computed.pack;
    newShallows = computed.newShallows;
    unshallows = computed.unshallows;
    repoCache.set(cacheKey, { generation: repo.generation, pack: packBuf, newShallows, unshallows });
  }

  const chunks: Buffer[] = [];
  if (isV2) {
    chunks.push(encodePktLine('acknowledgments\n'));
    if (haves.length > 0 && haves.every((h) => repo.objects.has(h))) {
      for (const h of haves) {
        chunks.push(encodePktLine(`ACK ${h}
`));
      }
      chunks.push(encodePktLine('ready\n'));
    } else {
      chunks.push(encodePktLine('NAK\n'));
    }
    chunks.push(DELIM_PKT);
    if (depth > 0 || shallows.length > 0) {
      chunks.push(encodePktLine('shallow-info\n'));
      for (const sc of newShallows) {
        chunks.push(encodePktLine(`shallow ${sc}\n`));
      }
      for (const uc of unshallows) {
        chunks.push(encodePktLine(`unshallow ${uc}\n`));
      }
      chunks.push(DELIM_PKT);
    }
    chunks.push(encodePktLine('packfile\n'));
    chunks.push(wrapSideband(packBuf));
    chunks.push(FLUSH_PKT);
  } else {
    chunks.push(encodePktLine('NAK\n'));
    chunks.push(wrapSideband(packBuf));
    chunks.push(FLUSH_PKT);
  }

  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: Buffer.concat(chunks),
  };
}

export function handleReceivePack(
  repo: GitRepo,
  body: Buffer,
): { status: number; headers: Record<string, string>; body: Buffer } {
  const updates: Array<{ oldOid: string; newOid: string; refname: string }> = [];
  let offset = 0;

  while (offset < body.length) {
    if (offset + 4 > body.length) break;
    const lenHex = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > body.length) break;

    let lineBuf = body.subarray(offset + 4, offset + len);
    offset += len;
    const nulIdx = lineBuf.indexOf(0);
    if (nulIdx !== -1) {
      lineBuf = lineBuf.subarray(0, nulIdx);
    }
    const line = lineBuf.toString('utf8').replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3) {
      updates.push({
        oldOid: parts[0],
        newOid: parts[1],
        refname: parts.slice(2).join(' '),
      });
    }
  }

  let packBuf = body.subarray(offset);
  if (
    packBuf.length >= 5 &&
    /^[0-9a-fA-F]{4}$/.test(packBuf.subarray(0, 4).toString('ascii')) &&
    packBuf[4] === 0x01
  ) {
    try {
      const unwrapped: Buffer[] = [];
      for (const pkt of parsePktLines(packBuf)) {
        if (pkt.kind === 'data' && pkt.data.length > 0 && pkt.data[0] === 0x01) {
          unwrapped.push(pkt.data.subarray(1));
        }
      }
      packBuf = Buffer.concat(unwrapped);
    } catch {
      // Leave packBuf as-is so readPackfile reports unpack failure cleanly
    }
  }

  let unpackOk = true;
  if (packBuf.length > 0) {
    try {
      const parsed = readPackfile(packBuf);
      for (const [oid, obj] of parsed.objects) {
        repo.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
    }
  }

  const statusLines: string[] = [];
  if (!unpackOk) {
    for (const upd of updates) {
      statusLines.push(`ng ${upd.refname} unpack failed`);
    }
  } else {
    for (const upd of updates) {
      if (upd.oldOid === ZERO_OID) {
        if (upd.newOid !== ZERO_OID && !repo.refs.has(upd.refname) && repo.objects.has(upd.newOid)) {
          repo.refs.set(upd.refname, upd.newOid);
          statusLines.push(`ok ${upd.refname}`);
        } else if (repo.refs.has(upd.refname)) {
          statusLines.push(`ng ${upd.refname} old value does not match`);
        } else {
          statusLines.push(`ng ${upd.refname} missing object`);
        }
      } else if (upd.newOid === ZERO_OID) {
        repo.refs.delete(upd.refname);
        statusLines.push(`ok ${upd.refname}`);
      } else {
        const current = repo.refs.get(upd.refname);
        if (current !== upd.oldOid) {
          statusLines.push(`ng ${upd.refname} old value does not match`);
        } else if (!isDescendant(repo, upd.newOid, upd.oldOid)) {
          statusLines.push(`ng ${upd.refname} non-fast-forward`);
        } else {
          repo.refs.set(upd.refname, upd.newOid);
          statusLines.push(`ok ${upd.refname}`);
        }
      }
    }
  }

  repo.generation += 1;
  fetchPackCache.delete(repo);

  const reportPkts = Buffer.concat([
    encodePktLine(unpackOk ? 'unpack ok\n' : 'unpack failed\n'),
    ...statusLines.map((line) => encodePktLine(`${line}
`)),
    FLUSH_PKT,
  ]);
  const responseBody = Buffer.concat([wrapSideband(reportPkts), FLUSH_PKT]);

  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
    body: responseBody,
  };
}
