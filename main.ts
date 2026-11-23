// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- section 5: matching lines at three tiers ----------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  return tier === 0 ? a === b : tier === 1 ? stripTrail(a) === stripTrail(b) : stripBoth(a) === stripBoth(b);
}

/** Every position at or after `from` where O's lines match the file's lines at `tier` (occurrences may overlap). */
function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs at or after `from`, with its positions; null when it occurs at no tier. */
function findTier(lines: string[], O: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const pos = occurrences(lines, O, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

type Entry = { k: ' ' | '-' | '+'; s: string; bs: boolean };

/**
 * Replace the O.length lines at `at` by the entries' new side, section 5's writing rules: a context line is
 * written as the file's own matched line; at tier 2 the other lines are re-indented from O's first line's
 * leading whitespace P to the file's first matched line's F.
 */
function applyEntries(lines: string[], entries: Entry[], tier: number, at: number): string[] {
  const O = entries.filter((e) => e.k !== '+').map((e) => e.s);
  const lead = (s: string): string => /^[ \t]*/.exec(s)![0]!;
  const F = tier === 2 && O.length > 0 ? lead(lines[at]!) : '';
  const P = tier === 2 && O.length > 0 ? lead(O[0]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const e of entries) {
    if (e.k === ' ') {
      out.push(lines[at + oi]!);
      oi++;
    } else if (e.k === '-') {
      oi++;
    } else {
      let s = e.s;
      if (tier === 2 && s.trim() !== '' && s.startsWith(P)) s = F + s.slice(P.length);
      out.push(s);
    }
  }
  return [...lines.slice(0, at), ...out, ...lines.slice(at + O.length)];
}

// ---------- section 3: a file as lines, its own break, and whether it ends with one ----------

interface FL {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FL {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}

function joinFile(f: FL): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number;
  entries: (Entry & { empty: boolean })[];
}

interface Section {
  oldRaw: string | null;
  newRaw: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@( .*)?$/;

function parseGitLine(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  const idx = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
  if (idx < 0 || rest.slice(idx + 3) === '') throw new Exit2(`error: parse ${lineNo}`);
  return [rest.slice(2, idx), rest.slice(idx + 3)];
}

function headerPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return (tab < 0 ? t : t.slice(0, tab)).trim();
}

function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunk: Hunk | null = null;
  const newSection = (): Section => ({
    oldRaw: null, newRaw: null, renameFrom: null, renameTo: null,
    gitOld: null, gitNew: null, newFile: false, deletedFile: false, hunks: [],
  });
  const closeHunk = () => {
    if (hunk !== null) {
      while (hunk.entries.length > 0 && hunk.entries[hunk.entries.length - 1]!.empty) hunk.entries.pop();
      sec!.hunks.push(hunk);
      hunk = null;
    }
  };
  const closeSection = () => {
    closeHunk();
    if (sec !== null) sections.push(sec);
    sec = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const no = i + 1;
    const next = lines[i + 1] ?? '';
    if (line.startsWith('diff --git ')) {
      const [x, y] = parseGitLine(line, no);
      closeSection();
      sec = newSection();
      sec.gitOld = x;
      sec.gitNew = y;
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      closeHunk();
      if (sec !== null && (sec.oldRaw !== null || sec.hunks.length > 0)) closeSection();
      if (sec === null) sec = newSection();
      sec.oldRaw = headerPath(line);
      sec.newRaw = headerPath(next);
      i++;
      continue;
    }
    if (sec === null) {
      if (HUNK_RE.test(line)) throw new Exit2(`error: parse ${no}`);
      continue;
    }
    if (hunk === null && sec.hunks.length === 0) {
      // the section's header, before its first hunk
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${no + 1}`);
      if (line.startsWith('rename from ')) { sec.renameFrom = line.slice('rename from '.length).trim(); continue; }
      if (line.startsWith('rename to ')) { sec.renameTo = line.slice('rename to '.length).trim(); continue; }
      if (line.startsWith('new file mode')) { sec.newFile = true; continue; }
      if (line.startsWith('deleted file mode')) { sec.deletedFile = true; continue; }
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${no}`);
        hunk = { a: Number(m[1]), entries: [] };
        continue;
      }
      continue; // index, modes, prose: ignored
    }
    // after the header: hunks and their bodies; other lines are ignored
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${no}`);
      closeHunk();
      hunk = { a: Number(m[1]), entries: [] };
      continue;
    }
    if (hunk !== null) {
      const c = line[0];
      if (c === ' ' || c === '-' || c === '+') {
        hunk.entries.push({ k: c, s: line.slice(1), bs: false, empty: false });
        continue;
      }
      if (c === '\\') {
        const prev = hunk.entries[hunk.entries.length - 1];
        if (prev !== undefined) prev.bs = true;
        continue;
      }
      if (line === '') {
        hunk.entries.push({ k: ' ', s: '', bs: false, empty: true });
        continue;
      }
      closeHunk(); // the body ends at the first other line; the line itself is ignored
    }
  }
  closeSection();
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line (its ending then has no line break). */
function noBreakAfter(h: Hunk): boolean {
  for (let i = h.entries.length - 1; i >= 0; i--) {
    const e = h.entries[i]!;
    if (e.k === ' ' || e.k === '+') return e.bs;
  }
  return false;
}

function applyHunks(f: FL, hunks: Hunk[], strict: boolean, path: string): FL {
  let lines = f.lines;
  let fin = f.final;
  let d = 0;
  for (const h of hunks) {
    const O = h.entries.filter((e) => e.k !== '+').map((e) => e.s);
    const N = h.entries.filter((e) => e.k !== '-').map((e) => e.s);
    if (O.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const touchesEnd = at === lines.length;
      lines = applyEntries(lines, h.entries, 0, at);
      if (touchesEnd) fin = !noBreakAfter(h);
    } else {
      const found = findTier(lines, O, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let at = found.pos[0]!;
      for (const p of found.pos) if (Math.abs(p - target) < Math.abs(at - target)) at = p;
      const touchesEnd = at + O.length === lines.length;
      lines = applyEntries(lines, h.entries, found.tier, at);
      if (touchesEnd) fin = !noBreakAfter(h);
    }
    d += N.length - O.length;
  }
  return { lines, br: f.br, final: fin };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  return unifiedSections(lines).map((sec) => {
    let oldP: string | null = null;
    let newP: string | null = null;
    let creation = sec.newFile;
    let deletion = sec.deletedFile;
    if (sec.oldRaw !== null) {
      if (sec.oldRaw === '/dev/null') creation = true;
      else oldP = stripAB(sec.oldRaw);
    }
    if (sec.newRaw !== null) {
      if (sec.newRaw === '/dev/null') deletion = true;
      else newP = stripAB(sec.newRaw);
    }
    if (oldP === null) oldP = sec.renameFrom ?? sec.gitOld;
    if (newP === null) newP = sec.renameTo ?? sec.gitNew;
    if (oldP === null) oldP = newP;
    if (newP === null) newP = oldP;
    const hunks = sec.hunks;
    return (tree: Tree): void => {
      if (creation) {
        const p = newP ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const out: string[] = [];
        let lastPlusBs = false;
        for (const h of hunks) {
          for (const e of h.entries) {
            if (e.k === '+') {
              out.push(e.s);
              lastPlusBs = e.bs;
            }
          }
        }
        tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (lastPlusBs ? '' : '\n'));
        return;
      }
      if (deletion) {
        const p = oldP ?? '';
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const o = oldP ?? '';
      const n = newP ?? '';
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (n !== o && tree.get(n) !== null) throw new Fail('exists', n);
      const after = applyHunks(splitFile(before), hunks, strict, o);
      tree.now.set(n, joinFile(after));
      if (n !== o) {
        tree.now.set(o, null);
        tree.moves.push([o, n]);
      }
    };
  });
}

// ---------- section 7: SEARCH/REPLACE blocks ----------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchAt = i;
    // the path: the nearest line before the SEARCH line, after the previous block, that is not blank
    // and does not start with three backticks once trimmed
    let path: string | null = null;
    for (let j = searchAt - 1; j >= (edits.length > 0 ? lastSrEnd : 0); j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchAt + 1}`);
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    const oldLines = lines.slice(searchAt + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p: string = path;
    prevPath = p;
    lastSrEnd = rep + 1;
    i = rep + 1;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const entries: Entry[] = [
        ...oldLines.map((s) => ({ k: '-' as const, s, bs: false })),
        ...newLines.map((s) => ({ k: '+' as const, s, bs: false })),
      ];
      const after = applyEntries(f.lines, entries, found.tier, found.pos[0]!);
      tree.now.set(p, joinFile({ lines: after, br: f.br, final: f.final }));
    });
  }
  return edits;
}

let lastSrEnd = 0;

// ---------- section 8: V4A patches ----------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  entries: Entry[];
}

function applyChunks(f: FL, chunks: Chunk[], strict: boolean, path: string): FL {
  let lines = f.lines;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null && ch.anchor !== '') {
      let foundAt = -1;
      for (const t of strict ? [0] : [0, 1, 2]) {
        for (let k = cursor; k < lines.length; k++) {
          if (lineEq(lines[k]!, ch.anchor, t)) {
            foundAt = k;
            break;
          }
        }
        if (foundAt >= 0) break;
      }
      if (foundAt < 0) throw new Fail('no-match', path);
      cursor = foundAt + 1;
    }
    const O = ch.entries.filter((e) => e.k !== '+').map((e) => e.s);
    if (O.length === 0) {
      const add = ch.entries.filter((e) => e.k === '+').map((e) => e.s);
      const at = ch.eof ? lines.length : cursor;
      lines = [...lines.slice(0, at), ...add, ...lines.slice(at)];
      cursor = at + add.length;
      continue;
    }
    let done = false;
    for (const t of strict ? [0] : [0, 1, 2]) {
      let pos = occurrences(lines, O, t, cursor);
      if (ch.eof) pos = pos.filter((p) => p + O.length === lines.length);
      if (pos.length > 0) {
        const at = pos[0]!;
        lines = applyEntries(lines, ch.entries, t, at);
        cursor = at + ch.entries.filter((e) => e.k !== '-').length;
        done = true;
        break;
      }
    }
    if (!done) throw new Fail('no-match', path);
  }
  return { lines, br: f.br, final: f.final };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      lastNB = i;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const kind = line.startsWith('*** Add File: ') ? 'add'
      : line.startsWith('*** Delete File: ') ? 'del'
      : line.startsWith('*** Update File: ') ? 'upd'
      : null;
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headAt = i;
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    // collect the section's raw lines, up to the next section or the End Patch line
    const raw: { s: string; no: number }[] = [];
    i++;
    while (i < lastNB) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ s: l, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.s)) raw.pop();
    if (kind === 'add') {
      const out: string[] = [];
      for (const r of raw) {
        if (r.s.startsWith('+')) out.push(r.s.slice(1));
        else if (r.s === '') out.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, out.length === 0 ? '' : out.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let at = 0;
      if (raw.length > 0 && raw[0]!.s.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.s.slice('*** Move to: '.length).trim();
        at = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let needStart = true; // the next body line must open a chunk (allowed bare only for the first chunk)
      for (; at < raw.length; at++) {
        const r = raw[at]!;
        const s = r.s;
        if (s.startsWith('@@')) {
          cur = { anchor: s.slice(2).trim() || null, eof: false, entries: [] };
          chunks.push(cur);
          needStart = false;
          continue;
        }
        if (s === '*** End of File') {
          if (cur === null || needStart) throw new Exit2(`error: parse ${r.no}`);
          cur.eof = true;
          cur = null;
          needStart = true;
          continue;
        }
        const c = s[0];
        if (c === ' ' || c === '-' || c === '+' || s === '') {
          if (cur === null) {
            if (!needStart || chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
            cur = { anchor: null, eof: false, entries: [] };
            chunks.push(cur);
            needStart = false;
          }
          cur.entries.push({ k: s === '' ? ' ' : (c as ' ' | '-' | '+'), s: s === '' ? '' : s.slice(1), bs: false });
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headAt + 1}`);
      const mv: string | null = moveTo;
      const chs = chunks;
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const after = applyChunks(splitFile(before), chs, strict, path);
        tree.now.set(mv ?? path, joinFile(after));
        if (mv !== null) {
          tree.now.set(path, null);
          tree.moves.push([path, mv]);
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? srEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const suppressed = new Set<string>();
  const keyed: [string, string][] = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(n) === null && finalOf(n) !== null) {
      suppressed.add(o);
      suppressed.add(n);
      keyed.push([n, `R ${o} -> ${n}`]);
    }
  }
  for (const p of tree.now.keys()) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    keyed.push([p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`]);
  }
  keyed.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  const rows = keyed.map(([, l]) => l);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
