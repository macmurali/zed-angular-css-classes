// End-to-end test: spawns the server over stdio and exercises it like an editor would.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const assert = require('assert');

const root = path.join(__dirname, 'fixture');
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'angular-css-lsp.js'), '--stdio']);
let buf = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
server.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const h = buf.indexOf('\r\n\r\n');
    if (h < 0) return;
    const len = +/Content-Length: (\d+)/.exec(buf.slice(0, h).toString())[1];
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.slice(h + 4, h + 4 + len).toString());
    buf = buf.slice(h + 4 + len);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method === 'window/logMessage') console.log('   log:', msg.params.message);
  }
});
server.stderr.on('data', (d) => process.stderr.write(d));
const write = (o) => { const s = JSON.stringify(o); server.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); };
const request = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); write({ jsonrpc: '2.0', id, method, params }); });
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

const uri = (rel) => pathToFileURL(path.join(root, rel)).href;
const tpl = 'src/app/card/card.component.html';
const tplText = fs.readFileSync(path.join(root, tpl), 'utf8');
const posOf = (text, needle, delta = 1) => {
  const i = text.indexOf(needle) + delta;
  const before = text.slice(0, i).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
};
const where = (loc) => `${path.relative(root, new URL(loc.uri).pathname)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;

(async () => {
  const init = await request('initialize', { rootUri: pathToFileURL(root).href, capabilities: {}, initializationOptions: {} });
  assert(init.result.capabilities.definitionProvider);
  notify('initialized', {});
  notify('textDocument/didOpen', { textDocument: { uri: uri(tpl), languageId: 'html', version: 1, text: tplText } });

  const def = async (needle, delta) => (await request('textDocument/definition', { textDocument: { uri: uri(tpl) }, position: posOf(tplText, needle, delta) })).result;

  const cases = [
    ['class="card ', 8, ['src/app/card/card.component.scss:3:2']],             // local wins over global .card
    ['card__title page', 3, ['src/app/card/card.component.scss:5:3', 'src/app/card/card.component.scss:11:4']],
    ['page-title', 2, ['src/styles.scss:2:2']],                               // falls back to global
    ["'card__body'", 3, ['src/app/card/card.component.scss:6:3']],            // ngClass quoted key
    ['card__footer:', 3, ['src/app/card/card.component.scss:6:12']],          // ngClass bare key
    ["'btn--primary'", 3, ['src/styles/_buttons.scss:4:3']],                  // interpolation + @use import
    ['is-active', 2, ['src/app/card/card.component.scss:7:5']],
    ['md:flex"', 2, ['src/app/card/card.component.scss:8:4']],               // escaped selector
  ];
  for (const [needle, delta, expected] of cases) {
    const res = await def(needle, delta);
    const got = (res || []).map(where);
    assert.deepStrictEqual(got, expected, `definition for ${needle}: got ${JSON.stringify(got)}`);
    console.log('ok  definition', needle.padEnd(18), '->', got.join(', '));
  }
  assert.strictEqual(await def('[class.card--active]', 9), null);
  console.log('ok  undefined class returns null');

  const hover = (await request('textDocument/hover', { textDocument: { uri: uri(tpl) }, position: posOf(tplText, 'card__title page', 3) })).result;
  assert(hover.contents.value.includes('&__title { font-weight: 600; }'));
  console.log('ok  hover shows rule:', JSON.stringify(hover.contents.value.split('\n')[0]));

  const comp = (await request('textDocument/completion', { textDocument: { uri: uri(tpl) }, position: posOf(tplText, '<p class=""', 10) })).result;
  const labels = comp.items.sort((a, b) => a.sortText.localeCompare(b.sortText)).map((i) => i.label);
  assert(labels[0].startsWith('card'), 'component classes sorted first');
  assert(labels.includes('btn--primary') && labels.includes('page-title'));
  console.log('ok  completion', labels.length, 'items, first:', labels.slice(0, 4).join(' '));

  const noComp = (await request('textDocument/completion', { textDocument: { uri: uri(tpl) }, position: posOf(tplText, '<h2 ', 1) })).result;
  assert.strictEqual(noComp, null);
  console.log('ok  no completion outside class attributes');

  const scss = 'src/app/card/card.component.scss';
  const scssText = fs.readFileSync(path.join(root, scss), 'utf8');
  const refs = (await request('textDocument/references', { textDocument: { uri: uri(scss) }, position: posOf(scssText, '.card {', 2), context: { includeDeclaration: false } })).result;
  const refLocs = refs.map(where).sort();
  assert.deepStrictEqual(refLocs, ['src/app/card/card.component.html:1:13', 'src/app/other.component.html:1:17']);
  console.log('ok  references from .card in scss ->', refLocs.join(', '));

  // live edit of a stylesheet on disk is picked up by the watcher
  const newFile = path.join(root, 'src/app/card/extra.component.css');
  fs.writeFileSync(newFile, '.brand-new { color: red; }\n');
  await new Promise((r) => setTimeout(r, 2500));
  const edited = tplText.replace('class=""', 'class="brand-new"');
  notify('textDocument/didChange', { textDocument: { uri: uri(tpl), version: 2 }, contentChanges: [{ text: edited }] });
  const res = (await request('textDocument/definition', { textDocument: { uri: uri(tpl) }, position: posOf(edited, 'brand-new', 2) })).result;
  fs.unlinkSync(newFile);
  assert.deepStrictEqual(res.map(where), ['src/app/card/extra.component.css:1:2']);
  console.log('ok  new stylesheet picked up without restart');

  await request('shutdown', null);
  notify('exit', null);
  console.log('\nall tests passed');
})().catch((e) => { console.error('FAIL', e.message); server.kill(); process.exit(1); });
