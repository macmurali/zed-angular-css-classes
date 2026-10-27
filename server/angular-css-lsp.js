#!/usr/bin/env node
/*
 * angular-css-lsp — a tiny, dependency-free language server that connects
 * CSS class usages in Angular templates to the stylesheets that define them.
 *
 *   HTML / Angular templates:  go to definition, hover, completion, references
 *   CSS / SCSS / Less files:   find references (selector -> template usages)
 *
 * Recognised template syntax:
 *   class="a b {{ cond ? 'c' : 'd' }}"
 *   [class.foo]="expr"           -> foo
 *   [class]="'a b'"  [className]="..."  [attr.class]="..."
 *   [ngClass]="{ 'a b': x, c: y }"  [ngClass]="['a', 'b']"  ngClass="a b"
 *
 * Definition ranking (only the best non-empty tier is returned unless
 * `showAllDefinitions` is true):
 *   0. the component's own styles (sibling *.component.(s)css / styleUrl(s)) and their @use/@import graph
 *   1. global styles listed in angular.json (+ their imports) and `extraStylePaths`
 *   2. any other stylesheet in the workspace
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  styleExtensions: ['.css', '.scss', '.less'],
  templateExtensions: ['.html'],
  exclude: ['node_modules', '.git', 'dist', 'out-tsc', '.angular', 'coverage', 'tmp', '.nx', 'build', 'bazel-out', '.cache'],
  extraStylePaths: [], // e.g. ["node_modules/bootstrap/dist/css/bootstrap.css"]
  showAllDefinitions: false,
  maxFiles: 20000,
};

let config = { ...DEFAULT_CONFIG };
let roots = [];
let clientLinkSupport = false;

function applyConfig(opts) {
  if (!opts || typeof opts !== 'object') return;
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (opts[key] !== undefined && opts[key] !== null) config[key] = opts[key];
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

let inbox = Buffer.alloc(0);

function startStdio() {
process.stdin.on('data', (chunk) => {
  inbox = Buffer.concat([inbox, chunk]);
  for (;;) {
    const headerEnd = inbox.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = inbox.slice(0, headerEnd).toString('ascii');
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { inbox = inbox.slice(headerEnd + 4); continue; }
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (inbox.length < start + len) return;
    const body = inbox.slice(start, start + len).toString('utf8');
    inbox = inbox.slice(start + len);
    let msg;
    try { msg = JSON.parse(body); } catch (e) { log('bad json: ' + e.message); continue; }
    Promise.resolve(dispatch(msg)).catch((err) => {
      log('handler error: ' + (err && err.stack || err));
      if (msg.id !== undefined) reply(msg.id, null, { code: -32603, message: String(err && err.message || err) });
    });
  }
});
process.stdin.on('end', () => process.exit(0));
}

function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}
function reply(id, result, error) {
  if (error) send({ jsonrpc: '2.0', id, error });
  else send({ jsonrpc: '2.0', id, result });
}
function log(message) {
  send({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message: '[angular-css] ' + message } });
}

let shuttingDown = false;

async function dispatch(msg) {
  const { id, method, params } = msg;
  if (method === undefined) return; // a response to something we sent
  const handler = handlers[method];
  if (!handler) {
    if (id !== undefined) reply(id, null, { code: -32601, message: 'Method not found: ' + method });
    return;
  }
  const result = await handler(params || {});
  if (id !== undefined) reply(id, result === undefined ? null : result);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}
function offsetToPos(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo] };
}
function posToOffset(starts, pos, textLength) {
  const line = Math.min(pos.line, starts.length - 1);
  return Math.min(starts[line] + pos.character, textLength);
}
function uriToPath(uri) {
  try { return fileURLToPath(uri); } catch { return null; }
}
function pathToUri(p) { return pathToFileURL(p).href; }

const STYLE_LANG = { '.css': 'css', '.scss': 'scss', '.less': 'less', '.sass': 'sass' };
const isStyle = (p) => config.styleExtensions.includes(path.extname(p).toLowerCase());
const isTemplate = (p) => config.templateExtensions.includes(path.extname(p).toLowerCase());

function unescapeCss(name) {
  if (!name.includes('\\')) return name;
  return name.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|(.))/g, (_, hex, ch) => {
    if (hex) {
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
    }
    return ch;
  });
}

// ---------------------------------------------------------------------------
// Stylesheet parsing
// ---------------------------------------------------------------------------

/**
 * Replace comments and string contents with spaces (preserving offsets) so the
 * structural scan below can't be confused by them. `#{...}` interpolation is
 * kept but its braces are neutralised.
 */
function blankNoise(text, ext) {
  const out = text.split('');
  const lineComments = ext === '.scss' || ext === '.less' || ext === '.sass';
  let i = 0;
  const n = text.length;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop); i = stop; continue;
    }
    if (lineComments && c === '/' && next === '/' && text[i - 1] !== ':') {
      // `//` inside url(...) is guarded by the ':' check (http://) and the url skip below
      let end = text.indexOf('\n', i);
      if (end < 0) end = n;
      blank(i, end); i = end; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
      blank(i + 1, Math.min(j, n)); i = j + 1; continue;
    }
    if ((c === 'u' || c === 'U') && /^url\(/i.test(text.slice(i, i + 4))) {
      const end = text.indexOf(')', i);
      const stop = end < 0 ? n : end;
      blank(i + 4, stop); i = stop + 1; continue;
    }
    if (c === '#' && next === '{') {
      // SCSS interpolation: keep content, hide braces from the block scanner
      let depth = 0, j = i + 1;
      for (; j < n; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') { depth--; if (depth === 0) break; }
      }
      out[i + 1] = ' ';
      if (j < n) out[j] = ' ';
      i = j + 1; continue;
    }
    if (c === '@' && ext === '.less' && next === '{') { // Less @{var}
      const end = text.indexOf('}', i);
      if (end > 0) { out[i + 1] = ' '; out[end] = ' '; i = end + 1; continue; }
    }
    i++;
  }
  return out.join('');
}

function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0, last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === sep && depth === 0) { parts.push({ text: s.slice(last, i), offset: last }); last = i + 1; }
  }
  parts.push({ text: s.slice(last), offset: last });
  return parts;
}

const CLASS_IN_SELECTOR = /\.((?:-?(?:[_a-zA-Z -￿]|\\.)(?:[\w -￿-]|\\.)*))/g;
const AMP_SUFFIX = /&((?:[\w-]|\\.)+)/g;

function lastClassOf(selector) {
  // trailing class of the last compound selector, ignoring pseudo parts
  const trimmed = selector.replace(/(::?[\w-]+(\([^)]*\))?)+\s*$/, '').trimEnd();
  const m = /\.((?:[\w-]|\\.)+)$/.exec(trimmed);
  return m ? unescapeCss(m[1]) : null;
}

/**
 * Returns { defs: [{name, start, end, ruleStart, ruleEnd}], imports: [string] }
 */
function parseStylesheet(text, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const clean = blankNoise(text, ext);
  const defs = [];
  const imports = [];

  // @use / @import / @forward targets (taken from the raw text)
  const importRe = /@(?:use|import|forward)\s+([^;]+);/g;
  let im;
  while ((im = importRe.exec(text))) {
    const strRe = /(['"])([^'"]+)\1/g;
    let s;
    while ((s = strRe.exec(im[1]))) {
      const target = s[2];
      if (/^(https?:)?\/\//.test(target) || target.startsWith('sass:')) continue;
      imports.push(target);
    }
  }

  // block scan with a stack of resolved parent selectors
  const stack = []; // { selectors: string[] | null (transparent), openIndex, defIndexes: number[] }
  const currentParents = () => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].selectors) return stack[k].selectors;
    return null;
  };
  let segStart = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === ';') { segStart = i + 1; continue; }
    if (c === '}') {
      const frame = stack.pop();
      if (frame) for (const di of frame.defIndexes) defs[di].ruleEnd = i + 1;
      segStart = i + 1;
      continue;
    }
    if (c !== '{') continue;

    const rawPrelude = clean.slice(segStart, i);
    const lead = rawPrelude.length - rawPrelude.trimStart().length;
    const prelude = rawPrelude.trim();
    const preludeStart = segStart + lead;
    segStart = i + 1;
    const frame = { selectors: null, defIndexes: [] };
    stack.push(frame);

    if (!prelude || prelude.startsWith('@')) continue; // at-rules are transparent for nesting
    if (/^[\w-]+\s*:\s*$/.test(prelude) && ext !== '.css') continue; // SCSS nested properties `font: {`
    if (/^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/.test(prelude)) continue; // keyframes

    const parents = currentParents();
    const resolved = [];
    for (const part of splitTopLevel(prelude, ',')) {
      const sel = part.text.trim();
      if (!sel) continue;
      const partStart = preludeStart + part.offset + (part.text.length - part.text.trimStart().length);

      // classes written literally in this selector
      CLASS_IN_SELECTOR.lastIndex = 0;
      let m;
      while ((m = CLASS_IN_SELECTOR.exec(sel))) {
        const s = partStart + m.index + 1;
        defs.push({ name: unescapeCss(m[1]), start: s, end: s + m[1].length, ruleStart: preludeStart, ruleEnd: -1 });
        frame.defIndexes.push(defs.length - 1);
      }
      // SCSS/Less parent-suffix classes:  .card { &__title { } }
      if (parents) {
        AMP_SUFFIX.lastIndex = 0;
        while ((m = AMP_SUFFIX.exec(sel))) {
          if (m.index > 0 && !/[\s>+~(]/.test(sel[m.index - 1])) continue;
          const seen = new Set();
          for (const parent of parents) {
            const base = lastClassOf(parent);
            if (!base) continue;
            const name = base + unescapeCss(m[1]);
            if (seen.has(name)) continue;
            seen.add(name);
            const s = partStart + m.index;
            defs.push({ name, start: s, end: s + m[0].length, ruleStart: preludeStart, ruleEnd: -1 });
            frame.defIndexes.push(defs.length - 1);
          }
        }
      }
      // resolved selector(s) for children
      if (parents) {
        for (const parent of parents) resolved.push(sel.includes('&') ? sel.replace(/&/g, parent) : parent + ' ' + sel);
      } else {
        resolved.push(sel);
      }
    }
    frame.selectors = resolved.length ? resolved : null;
  }
  for (const d of defs) if (d.ruleEnd < 0) d.ruleEnd = Math.min(text.length, d.ruleStart + 400);
  return { defs, imports };
}

// ---------------------------------------------------------------------------
// Template parsing
// ---------------------------------------------------------------------------

const ATTR_RE = /(?<=[\s<"'])(\[class\.([^\]\s=]+)\]|\[(?:class|ngClass|className|attr\.class)\]|class|ngClass)\s*=\s*(["'])/g;
const STRING_LITERAL_RE = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const OBJECT_KEY_RE = /([{,]\s*)([A-Za-z_$][\w$-]*)(?=\s*:)/g;
const WORD_RE = /[^\s]+/g;

function pushWords(tokens, str, base, kind) {
  WORD_RE.lastIndex = 0;
  let w;
  while ((w = WORD_RE.exec(str))) tokens.push({ name: w[0], start: base + w.index, end: base + w.index + w[0].length, kind });
}

function expressionTokens(tokens, expr, base) {
  STRING_LITERAL_RE.lastIndex = 0;
  let m;
  while ((m = STRING_LITERAL_RE.exec(expr))) {
    if (m[2].includes('${')) continue;
    pushWords(tokens, m[2], base + m.index + 1, 'literal');
  }
  OBJECT_KEY_RE.lastIndex = 0;
  while ((m = OBJECT_KEY_RE.exec(expr))) {
    const s = base + m.index + m[1].length;
    tokens.push({ name: m[2], start: s, end: s + m[2].length, kind: 'key' });
  }
}

/**
 * Finds class-bearing attributes. Returns
 *   { attrs: [{bound, valueStart, valueEnd}], tokens: [{name,start,end}] }
 */
function parseTemplate(text) {
  // blank HTML comments so commented-out markup doesn't count
  const src = text.replace(/<!--[\s\S]*?-->/g, (s) => s.replace(/[^\n]/g, ' '));
  const attrs = [];
  const tokens = [];
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(src))) {
    const quote = m[3];
    const valueStart = m.index + m[0].length;
    let valueEnd = src.indexOf(quote, valueStart);
    if (valueEnd < 0) valueEnd = src.length;
    const value = src.slice(valueStart, valueEnd);

    if (m[2]) {
      // [class.foo]
      const s = m.index + '[class.'.length;
      tokens.push({ name: m[2], start: s, end: s + m[2].length, kind: 'binding' });
      // value is a boolean expression — no class names in it
      ATTR_RE.lastIndex = valueEnd + 1;
      continue;
    }
    const bound = m[1].startsWith('[');
    attrs.push({ bound, valueStart, valueEnd });
    if (bound) {
      expressionTokens(tokens, value, valueStart);
    } else {
      // static value, possibly with {{ interpolation }}
      let i = 0;
      while (i < value.length) {
        const open = value.indexOf('{{', i);
        const plainEnd = open < 0 ? value.length : open;
        pushWords(tokens, value.slice(i, plainEnd), valueStart + i, 'static');
        if (open < 0) break;
        const close = value.indexOf('}}', open + 2);
        const exprEnd = close < 0 ? value.length : close;
        expressionTokens(tokens, value.slice(open + 2, exprEnd), valueStart + open + 2);
        i = close < 0 ? value.length : close + 2;
      }
    }
    ATTR_RE.lastIndex = valueEnd + 1;
  }
  return { attrs, tokens: tokens.filter((t) => !t.name.includes('{') && !t.name.includes('}')) };
}

// ---------------------------------------------------------------------------
// Workspace index
// ---------------------------------------------------------------------------

const openDocs = new Map(); // path -> { text, version }
const styleIndex = new Map(); // path -> { mtime, defs, imports, starts }
const templateIndex = new Map(); // path -> { mtime, tokens, starts }
let byName = null; // Map<name, [{path, def}]>
let scanPromise = null;
let lastFullScan = 0;

function readText(p) {
  const doc = openDocs.get(p);
  if (doc) return doc.text;
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function mtimeOf(p) {
  if (openDocs.has(p)) return 'open:' + openDocs.get(p).version;
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

function indexStyle(p, force) {
  const mtime = mtimeOf(p);
  if (mtime === null) {
    if (styleIndex.delete(p)) byName = null;
    return null;
  }
  const cur = styleIndex.get(p);
  if (cur && cur.mtime === mtime && !force) return cur;
  const text = readText(p);
  if (text === null) return null;
  const { defs, imports } = parseStylesheet(text, p);
  const entry = { mtime, defs, imports, starts: lineStarts(text) };
  styleIndex.set(p, entry);
  byName = null;
  return entry;
}

function indexTemplate(p) {
  const mtime = mtimeOf(p);
  if (mtime === null) { templateIndex.delete(p); return null; }
  const cur = templateIndex.get(p);
  if (cur && cur.mtime === mtime) return cur;
  const text = readText(p);
  if (text === null) return null;
  const entry = { mtime, tokens: parseTemplate(text).tokens, starts: lineStarts(text) };
  templateIndex.set(p, entry);
  return entry;
}

async function walk(dir, onFile, budget) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (budget.count >= config.maxFiles) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (config.exclude.includes(e.name)) continue;
      await walk(full, onFile, budget);
    } else if (e.isFile()) {
      budget.count++;
      onFile(full);
    }
  }
}

async function fullScan() {
  const seenStyles = new Set();
  const seenTemplates = new Set();
  const budget = { count: 0 };
  for (const root of roots) {
    await walk(root, (f) => {
      if (isStyle(f)) seenStyles.add(f);
      else if (isTemplate(f)) seenTemplates.add(f);
    }, budget);
  }
  for (const extra of config.extraStylePaths || []) {
    for (const root of roots) {
      const p = path.resolve(root, extra);
      if (fs.existsSync(p)) seenStyles.add(p);
    }
  }
  for (const p of [...styleIndex.keys()]) if (!seenStyles.has(p) && !openDocs.has(p)) { styleIndex.delete(p); byName = null; }
  for (const p of [...templateIndex.keys()]) if (!seenTemplates.has(p) && !openDocs.has(p)) templateIndex.delete(p);
  for (const p of seenStyles) indexStyle(p);
  for (const p of seenTemplates) templateIndex.has(p) || templateIndex.set(p, { mtime: -1, tokens: [], starts: [0] });
  lastFullScan = Date.now();
  log(`indexed ${styleIndex.size} stylesheets, ${seenTemplates.size} templates` + (budget.count >= config.maxFiles ? ' (file limit reached)' : ''));
}

function ensureScanned() {
  if (!scanPromise) scanPromise = fullScan();
  return scanPromise;
}
async function rescanIfStale(minAgeMs) {
  await ensureScanned();
  if (Date.now() - lastFullScan > minAgeMs) {
    scanPromise = fullScan();
    await scanPromise;
  }
}

function getByName() {
  if (byName) return byName;
  byName = new Map();
  for (const [p, entry] of styleIndex) {
    for (const def of entry.defs) {
      let list = byName.get(def.name);
      if (!list) byName.set(def.name, (list = []));
      list.push({ path: p, def });
    }
  }
  return byName;
}

// keep the index fresh when files change on disk
let watchers = [];
let dirtyTimer = null;
const dirty = new Set();
function startWatching() {
  for (const root of roots) {
    try {
      const w = fs.watch(root, { recursive: true }, (_event, rel) => {
        if (!rel) return;
        const p = path.join(root, rel.toString());
        if (p.split(path.sep).some((seg) => config.exclude.includes(seg))) return;
        if (!isStyle(p) && !isTemplate(p)) return;
        dirty.add(p);
        clearTimeout(dirtyTimer);
        dirtyTimer = setTimeout(flushDirty, 150);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch (e) {
      log('file watching unavailable (' + e.message + '); falling back to periodic rescans');
    }
  }
}
function flushDirty() {
  for (const p of dirty) {
    if (openDocs.has(p)) continue;
    if (isStyle(p)) indexStyle(p);
    else if (isTemplate(p)) {
      if (fs.existsSync(p)) templateIndex.set(p, { mtime: -1, tokens: [], starts: [0] });
      else templateIndex.delete(p);
    }
  }
  dirty.clear();
}

// ---------------------------------------------------------------------------
// Component / global style resolution
// ---------------------------------------------------------------------------

function resolveImport(fromFile, target) {
  const candidates = [];
  const bases = [path.dirname(fromFile), ...roots, ...roots.map((r) => path.join(r, 'src'))];
  const clean = target.replace(/^~/, '');
  const exts = ['', '.scss', '.css', '.less', '.sass'];
  for (const base of bases) {
    const full = path.resolve(base, clean);
    const dir = path.dirname(full);
    const name = path.basename(full);
    for (const ext of exts) {
      candidates.push(path.join(dir, name + ext));
      candidates.push(path.join(dir, '_' + name + ext));
      candidates.push(path.join(full, 'index' + ext));
      candidates.push(path.join(full, '_index' + ext));
    }
  }
  if (target.startsWith('~')) for (const r of roots) candidates.push(path.join(r, 'node_modules', clean));
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

function withImports(files) {
  const out = new Set();
  const queue = [...files];
  while (queue.length) {
    const f = queue.shift();
    if (out.has(f) || out.size > 200) continue;
    out.add(f);
    const entry = indexStyle(f);
    if (!entry) continue;
    for (const imp of entry.imports) {
      const r = resolveImport(f, imp);
      if (r && !out.has(r)) queue.push(r);
    }
  }
  return out;
}

function componentStyleFiles(templatePath) {
  const dir = path.dirname(templatePath);
  const base = path.basename(templatePath, path.extname(templatePath));
  const files = new Set();
  for (const ext of config.styleExtensions) {
    const p = path.join(dir, base + ext);
    if (fs.existsSync(p)) files.add(p);
  }
  // any .ts in the same folder whose templateUrl points at this template
  let siblings = [];
  try { siblings = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')); } catch {}
  const tplName = path.basename(templatePath);
  for (const tsFile of siblings) {
    let src;
    try { src = fs.readFileSync(path.join(dir, tsFile), 'utf8'); } catch { continue; }
    const tu = /templateUrl\s*:\s*['"`]([^'"`]+)['"`]/.exec(src);
    if (!tu || path.resolve(dir, tu[1]) !== templatePath && path.basename(tu[1]) !== tplName) continue;
    const single = /styleUrl\s*:\s*['"`]([^'"`]+)['"`]/.exec(src);
    if (single) files.add(path.resolve(dir, single[1]));
    const multi = /styleUrls\s*:\s*\[([^\]]*)\]/.exec(src);
    if (multi) {
      const re = /['"`]([^'"`]+)['"`]/g;
      let s;
      while ((s = re.exec(multi[1]))) files.add(path.resolve(dir, s[1]));
    }
  }
  return withImports([...files].filter((f) => fs.existsSync(f)));
}

let globalStylesCache = null;
function globalStyleFiles() {
  if (globalStylesCache) return globalStylesCache;
  const files = [];
  for (const root of roots) {
    for (const cfgName of ['angular.json', 'project.json', 'workspace.json']) {
      let json;
      try { json = JSON.parse(fs.readFileSync(path.join(root, cfgName), 'utf8')); } catch { continue; }
      // collect every "styles" array anywhere in the config
      const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node.styles)) {
          for (const s of node.styles) {
            const rel = typeof s === 'string' ? s : s && s.input;
            if (rel) files.push(path.resolve(root, rel));
          }
        }
        for (const v of Object.values(node)) visit(v);
      };
      visit(json);
    }
    for (const extra of config.extraStylePaths || []) files.push(path.resolve(root, extra));
  }
  globalStylesCache = withImports(files.filter((f) => fs.existsSync(f)));
  return globalStylesCache;
}

function rankedDefinitions(name, templatePath) {
  const all = getByName().get(name) || [];
  if (!all.length) return [];
  const local = templatePath ? componentStyleFiles(templatePath) : new Set();
  const global = globalStyleFiles();
  const tiers = [[], [], []];
  for (const hit of all) {
    const tier = local.has(hit.path) ? 0 : global.has(hit.path) ? 1 : 2;
    tiers[tier].push(hit);
  }
  if (config.showAllDefinitions) return tiers.flat();
  return tiers.find((t) => t.length) || [];
}

// ---------------------------------------------------------------------------
// LSP features
// ---------------------------------------------------------------------------

function defToLocation(hit) {
  const entry = styleIndex.get(hit.path);
  return {
    uri: pathToUri(hit.path),
    range: { start: offsetToPos(entry.starts, hit.def.start), end: offsetToPos(entry.starts, hit.def.end) },
  };
}

function templateContext(uri, position) {
  const p = uriToPath(uri);
  if (!p) return null;
  const text = readText(p);
  if (text === null) return null;
  const starts = lineStarts(text);
  const offset = posToOffset(starts, position, text.length);
  return { path: p, text, starts, offset, parsed: parseTemplate(text) };
}

function tokenAt(tokens, offset) {
  return tokens.find((t) => offset >= t.start && offset <= t.end) || null;
}

function styleDefAt(p, offset) {
  const entry = indexStyle(p);
  if (!entry) return null;
  return entry.defs.find((d) => offset >= d.start && offset <= d.end) || null;
}

function ruleSnippet(hit) {
  const text = readText(hit.path);
  if (text === null) return '';
  let snippet = text.slice(hit.def.ruleStart, hit.def.ruleEnd);
  const lines = snippet.split('\n');
  if (lines.length > 15) snippet = lines.slice(0, 15).join('\n') + '\n  …';
  // re-indent nested rules
  const indent = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length), Infinity);
  if (Number.isFinite(indent) && indent > 2) {
    snippet = snippet.split('\n').map((l, i) => (i === 0 ? l : l.slice(Math.min(indent - 2, l.match(/^\s*/)[0].length)))).join('\n');
  }
  return snippet;
}

function relPath(p) {
  for (const r of roots) if (p.startsWith(r + path.sep)) return path.relative(r, p);
  return p;
}

const handlers = {
  initialize(params) {
    applyConfig(params.initializationOptions);
    const folders = params.workspaceFolders && params.workspaceFolders.length
      ? params.workspaceFolders.map((f) => uriToPath(f.uri))
      : [params.rootUri ? uriToPath(params.rootUri) : params.rootPath];
    roots = folders.filter(Boolean);
    const caps = params.capabilities || {};
    clientLinkSupport = !!(caps.textDocument && caps.textDocument.definition && caps.textDocument.definition.linkSupport);
    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
        definitionProvider: true,
        hoverProvider: true,
        referencesProvider: true,
        completionProvider: { triggerCharacters: ['"', "'", ' ', '.'], resolveProvider: false },
      },
      serverInfo: { name: 'angular-css-lsp', version: '0.1.1' },
    };
  },

  initialized() {
    ensureScanned().then(startWatching);
    return undefined;
  },

  shutdown() { shuttingDown = true; for (const w of watchers) w.close(); return null; },
  exit() { process.exit(shuttingDown ? 0 : 1); },

  'workspace/didChangeConfiguration'(params) {
    const s = params.settings;
    if (s && typeof s === 'object') {
      applyConfig(s['angular-css'] || s);
      globalStylesCache = null;
      scanPromise = null;
      ensureScanned();
    }
  },

  'textDocument/didOpen'({ textDocument }) {
    const p = uriToPath(textDocument.uri);
    if (!p) return;
    openDocs.set(p, { text: textDocument.text, version: textDocument.version });
    if (isStyle(p)) indexStyle(p, true);
  },
  'textDocument/didChange'({ textDocument, contentChanges }) {
    const p = uriToPath(textDocument.uri);
    if (!p || !contentChanges.length) return;
    openDocs.set(p, { text: contentChanges[contentChanges.length - 1].text, version: textDocument.version });
    if (isStyle(p)) indexStyle(p, true);
  },
  'textDocument/didSave'({ textDocument }) {
    const p = uriToPath(textDocument.uri);
    if (p && isStyle(p)) { globalStylesCache = null; indexStyle(p, true); }
  },
  'textDocument/didClose'({ textDocument }) {
    const p = uriToPath(textDocument.uri);
    if (!p) return;
    openDocs.delete(p);
    if (isStyle(p)) indexStyle(p, true);
  },

  async 'textDocument/definition'({ textDocument, position }) {
    await ensureScanned();
    const ctx = templateContext(textDocument.uri, position);
    if (!ctx || isStyle(ctx.path)) return null;
    const tok = tokenAt(ctx.parsed.tokens, ctx.offset);
    if (!tok) return null;
    let hits = rankedDefinitions(tok.name, ctx.path);
    if (!hits.length) {
      await rescanIfStale(2000); // a stylesheet may have been created since the last scan
      hits = rankedDefinitions(tok.name, ctx.path);
    }
    if (!hits.length) return null;
    if (!clientLinkSupport) return hits.map(defToLocation);
    // A LocationLink tells the editor exactly which span is the link, so the
    // cmd-hover underline covers the whole class (e.g. "fa-arrow-right") rather
    // than the editor's own idea of a word, which stops at "-".
    const origin = { start: offsetToPos(ctx.starts, tok.start), end: offsetToPos(ctx.starts, tok.end) };
    return hits.map((hit) => {
      const loc = defToLocation(hit);
      const entry = styleIndex.get(hit.path);
      const ruleEnd = Math.max(hit.def.end, hit.def.ruleEnd);
      return {
        originSelectionRange: origin,
        targetUri: loc.uri,
        targetRange: { start: offsetToPos(entry.starts, hit.def.ruleStart), end: offsetToPos(entry.starts, ruleEnd) },
        targetSelectionRange: loc.range,
      };
    });
  },

  async 'textDocument/hover'({ textDocument, position }) {
    await ensureScanned();
    const ctx = templateContext(textDocument.uri, position);
    if (!ctx || isStyle(ctx.path)) return null;
    const tok = tokenAt(ctx.parsed.tokens, ctx.offset);
    if (!tok) return null;
    const hits = rankedDefinitions(tok.name, ctx.path);
    const range = { start: offsetToPos(ctx.starts, tok.start), end: offsetToPos(ctx.starts, tok.end) };
    if (!hits.length) {
      return { range, contents: { kind: 'markdown', value: `\`.${tok.name}\` — no definition found in workspace stylesheets` } };
    }
    const shown = hits.slice(0, 3).map((hit) => {
      const entry = styleIndex.get(hit.path);
      const line = offsetToPos(entry.starts, hit.def.start).line + 1;
      const lang = STYLE_LANG[path.extname(hit.path).toLowerCase()] || 'css';
      return `**${relPath(hit.path)}:${line}**\n\`\`\`${lang}\n${ruleSnippet(hit)}\n\`\`\``;
    });
    if (hits.length > 3) shown.push(`_…and ${hits.length - 3} more_`);
    return { range, contents: { kind: 'markdown', value: shown.join('\n\n') } };
  },

  async 'textDocument/completion'({ textDocument, position }) {
    await ensureScanned();
    const ctx = templateContext(textDocument.uri, position);
    if (!ctx || isStyle(ctx.path)) return null;
    const { text, offset, parsed } = ctx;
    const attr = parsed.attrs.find((a) => offset >= a.valueStart && offset <= a.valueEnd);
    if (!attr) return null;

    if (attr.bound) {
      // only complete inside a string literal, or at an object-key position
      const before = text.slice(attr.valueStart, offset);
      const quotes = (before.match(/(?<!\\)['"`]/g) || []).length;
      const atKey = /[{,]\s*[\w-]*$/.test(before);
      if (quotes % 2 === 0 && !atKey) return null;
    } else {
      const before = text.slice(attr.valueStart, offset);
      const opens = before.split('{{').length - 1;
      const closes = before.split('}}').length - 1;
      if (opens > closes) {
        const inner = before.slice(before.lastIndexOf('{{'));
        if (((inner.match(/(?<!\\)['"`]/g) || []).length) % 2 === 0) return null;
      }
    }

    let s = offset;
    while (s > attr.valueStart && /[^\s'"`{},\[\]]/.test(text[s - 1])) s--;
    let e = offset;
    while (e < attr.valueEnd && /[^\s'"`{},:\[\]]/.test(text[e])) e++;
    const range = { start: offsetToPos(ctx.starts, s), end: offsetToPos(ctx.starts, e) };
    // Filter here on the full typed prefix, hyphens included. Zed's own filter
    // word stops at "-" in Angular templates, so "fa-arr" would otherwise be
    // matched as just "arr". isIncomplete makes Zed re-ask on every keystroke.
    const prefix = text.slice(s, offset).toLowerCase();
    const MAX_ITEMS = 500;

    const local = componentStyleFiles(ctx.path);
    const global = globalStyleFiles();
    const items = [];
    for (const [name, hits] of getByName()) {
      const lower = name.toLowerCase();
      let match = 0; // 0 = starts with prefix, 1 = a "-"/"_" segment starts with it, 2 = contains it
      if (prefix) {
        if (lower.startsWith(prefix)) match = 0;
        else if (lower.includes('-' + prefix) || lower.includes('_' + prefix)) match = 1;
        else if (lower.includes(prefix)) match = 2;
        else continue;
      }
      const tier = hits.some((h) => local.has(h.path)) ? 0 : hits.some((h) => global.has(h.path)) ? 1 : 2;
      const first = hits.find((h) => (tier === 0 ? local.has(h.path) : tier === 1 ? global.has(h.path) : true));
      items.push({
        label: name,
        kind: 7, // Class
        detail: relPath(first.path) + (hits.length > 1 ? ` (+${hits.length - 1})` : ''),
        sortText: `${match}${tier}${name}`,
        filterText: name,
        textEdit: { range, newText: name },
      });
    }
    items.sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0));
    return { isIncomplete: true, items: items.slice(0, MAX_ITEMS) };
  },

  async 'textDocument/references'({ textDocument, position, context }) {
    await ensureScanned();
    const p = uriToPath(textDocument.uri);
    if (!p) return null;
    const text = readText(p);
    if (text === null) return null;
    const starts = lineStarts(text);
    const offset = posToOffset(starts, position, text.length);

    let name = null;
    if (isStyle(p)) {
      const def = styleDefAt(p, offset);
      name = def && def.name;
    } else {
      const tok = tokenAt(parseTemplate(text).tokens, offset);
      name = tok && tok.name;
    }
    if (!name) return null;

    const out = [];
    for (const tplPath of templateIndex.keys()) {
      const entry = indexTemplate(tplPath);
      if (!entry) continue;
      for (const t of entry.tokens) {
        if (t.name !== name) continue;
        out.push({ uri: pathToUri(tplPath), range: { start: offsetToPos(entry.starts, t.start), end: offsetToPos(entry.starts, t.end) } });
      }
    }
    if (context && context.includeDeclaration) {
      for (const hit of getByName().get(name) || []) out.push(defToLocation(hit));
    }
    return out;
  },

  '$/cancelRequest'() {},
  '$/setTrace'() {},
};

if (require.main === module) {
  startStdio();
} else {
  // exported for unit tests
  module.exports = { parseStylesheet, parseTemplate };
}
