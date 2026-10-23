#!/usr/bin/env node
'use strict';

// Bitbucket -> GitHub migrator: a zero-dependency local web server that drives `git`.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 5178;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_WIN = process.platform === 'win32';
const PUSH_BATCH = 40; // refspecs per `git push`, keeps the command line well under Windows limits
const PRIORITY_BRANCHES = ['main', 'master', 'develop', 'dev'];

// Errors shown to the user. `key` is a message id translated by the browser (public/i18n.js).
class UserError extends Error {
  constructor(key, params = {}) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function maskUrl(s) {
  return String(s).replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1***@');
}

function run(cmd, args, { cwd, onLine, onSpawn, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C', ...env },
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err.message || err) });
      return;
    }
    if (onSpawn) onSpawn(child);
    const out = [];
    const errOut = [];
    const pipe = (stream, sink, kind) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        sink.push(chunk);
        if (!onLine) return;
        buf += chunk;
        const parts = buf.split(/\r\n|\r|\n/);
        buf = parts.pop();
        for (const line of parts) if (line.trim()) onLine(line, kind);
      });
      stream.on('end', () => {
        if (onLine && buf.trim()) onLine(buf, kind);
      });
    };
    pipe(child.stdout, out, 'out');
    pipe(child.stderr, errOut, 'err');
    child.on('error', (err) => errOut.push(String(err.message || err)));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: out.join(''), stderr: errOut.join('') }));
  });
}

function git(cwd, args, opts = {}) {
  return run('git', ['-c', 'core.quotepath=off', ...args], { cwd, ...opts });
}

async function gitOut(cwd, args) {
  const r = await git(cwd, args);
  return r.code === 0 ? r.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// Repository inspection
// ---------------------------------------------------------------------------

async function readRepo(dir) {
  if (!dir || typeof dir !== 'string') throw new UserError('noFolder');
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new UserError('folderNotFound', { path: abs });

  const bare = (await gitOut(abs, ['rev-parse', '--is-bare-repository'])) === 'true';
  let root = abs;
  if (!bare) {
    const top = await gitOut(abs, ['rev-parse', '--show-toplevel']);
    if (!top) throw new UserError('notGitRepo', { path: abs });
    root = path.resolve(top);
  }

  const remotes = new Map();
  for (const line of ((await gitOut(root, ['remote', '-v'])) || '').split('\n')) {
    const m = line.match(/^(\S+)\t(.+?) \((fetch|push)\)$/);
    if (!m) continue;
    const r = remotes.get(m[1]) || { name: m[1], fetchUrl: '', pushUrl: '' };
    r[m[3] === 'fetch' ? 'fetchUrl' : 'pushUrl'] = m[2];
    remotes.set(m[1], r);
  }

  const local = new Map();
  const remoteRefs = new Map();
  const tags = [];
  const refsRaw = (await gitOut(root, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags'])) || '';
  for (const line of refsRaw.split('\n')) {
    const [ref, sha] = line.split('\t');
    if (!ref || !sha) continue;
    if (ref.startsWith('refs/heads/')) {
      local.set(ref.slice(11), sha);
    } else if (ref.startsWith('refs/tags/')) {
      tags.push({ name: ref.slice(10), sha });
    } else if (ref.startsWith('refs/remotes/')) {
      const rest = ref.slice(13);
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const remote = rest.slice(0, slash);
      const name = rest.slice(slash + 1);
      if (name === 'HEAD') continue;
      if (!remoteRefs.has(remote)) remoteRefs.set(remote, new Map());
      remoteRefs.get(remote).set(name, sha);
    }
  }

  const dirtyOut = bare ? '' : (await gitOut(root, ['status', '--porcelain'])) || '';
  const attrs = path.join(root, '.gitattributes');
  return {
    root,
    bare,
    remotes,
    local,
    remoteRefs,
    tags,
    currentBranch: bare ? null : await gitOut(root, ['branch', '--show-current']),
    dirty: dirtyOut ? dirtyOut.split('\n').length : 0,
    shallow: (await gitOut(root, ['rev-parse', '--is-shallow-repository'])) === 'true',
    lfs: fs.existsSync(attrs) && /filter=lfs/.test(fs.readFileSync(attrs, 'utf8')),
  };
}

// Union of local branches and `<remote>/*` tracking branches, picking which ref to push for each name.
function computeBranches(repo, remote, prefer) {
  const tracking = repo.remoteRefs.get(remote) || new Map();
  const names = new Set([...repo.local.keys(), ...tracking.keys()]);
  const list = [];
  for (const name of names) {
    const localSha = repo.local.get(name) || null;
    const remoteSha = tracking.get(name) || null;
    const useLocal = localSha && (prefer === 'local' || !remoteSha);
    list.push({
      name,
      ref: useLocal ? `refs/heads/${name}` : `refs/remotes/${remote}/${name}`,
      sha: useLocal ? localSha : remoteSha,
      from: useLocal ? 'local' : 'remote',
      localSha,
      remoteSha,
      diverged: Boolean(localSha && remoteSha && localSha !== remoteSha),
    });
  }
  const rank = (n) => {
    const i = PRIORITY_BRANCHES.indexOf(n);
    return i < 0 ? PRIORITY_BRANCHES.length : i;
  };
  return list.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

function hostOf(url) {
  const m = String(url).match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)/i) || String(url).match(/^[^@\s]+@([^:]+):/);
  return m ? m[1].toLowerCase() : '';
}

function pickRemote(repo, wanted) {
  if (wanted && repo.remotes.has(wanted)) return wanted;
  if (repo.remotes.has('origin')) return 'origin';
  return repo.remotes.size ? repo.remotes.keys().next().value : null;
}

async function inspect({ path: dir, remote, prefer, role }) {
  const repo = await readRepo(dir);
  const remoteName = pickRemote(repo, remote);
  const r = remoteName ? repo.remotes.get(remoteName) : null;
  const url = r ? r.pushUrl || r.fetchUrl : '';
  const host = hostOf(url);

  const warnings = [];
  if (!repo.remotes.size) warnings.push({ key: 'noRemotes' });
  if (role === 'source' && host && !host.includes('bitbucket')) warnings.push({ key: 'notBitbucket', params: { remote: remoteName, host } });
  if (role === 'target' && host && !host.includes('github')) warnings.push({ key: 'notGithub', params: { remote: remoteName, host } });
  if (repo.shallow) warnings.push({ key: 'shallowWarn' });
  if (repo.dirty) warnings.push({ key: 'dirtyWarn', params: { count: repo.dirty } });

  return {
    root: repo.root,
    bare: repo.bare,
    currentBranch: repo.currentBranch,
    dirty: repo.dirty,
    shallow: repo.shallow,
    lfs: repo.lfs,
    remotes: [...repo.remotes.values()].map((x) => ({ name: x.name, url: maskUrl(x.pushUrl || x.fetchUrl) })),
    remote: remoteName,
    remoteUrl: maskUrl(url),
    host,
    branches: computeBranches(repo, remoteName, prefer),
    tagCount: repo.tags.length,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Migration jobs
// ---------------------------------------------------------------------------

const jobs = new Map();
let activeJob = null;

function createJob() {
  const job = { id: crypto.randomUUID(), logs: [], status: 'running', result: null, listeners: new Set(), child: null, cancelled: false };
  const push = (entry) => {
    job.logs.push(entry);
    for (const send of job.listeners) send('log', entry);
  };
  // Raw text (git output) is shown as is; messages are { key, params } translated by the browser.
  job.log = (level, text) => push({ t: Date.now(), level, text: maskUrl(text) });
  job.msg = (level, key, params = {}) => {
    const masked = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? maskUrl(v) : v]));
    push({ t: Date.now(), level, key, params: masked });
  };
  job.section = (key, params) => {
    job.log('info', '');
    job.msg('info', key, params);
  };
  job.finish = (status, result) => {
    job.status = status;
    job.result = result;
    job.child = null;
    for (const send of job.listeners) send('done', { status, result });
    if (activeJob === job) activeJob = null;
  };
  jobs.set(job.id, job);
  return job;
}

async function step(job, cwd, args, { quiet = false, onLine } = {}) {
  if (job.cancelled) throw new UserError('cancelled');
  job.log('cmd', `git ${args.join(' ')}`);
  const r = await git(cwd, args, {
    onSpawn: (c) => (job.child = c),
    onLine: (line, kind) => {
      if (onLine && onLine(line, kind)) return;
      if (!quiet) job.log(kind === 'err' ? 'muted' : 'out', line);
    },
  });
  job.child = null;
  if (job.cancelled) throw new UserError('cancelled');
  return r;
}

const PUSH_FLAGS = { ' ': 'fast-forward', '+': 'forced', '-': 'deleted', '*': 'new', '!': 'rejected', '=': 'up-to-date' };

// Parses `git push --porcelain` lines: "<flag>\t<from>:<to>\t<summary> (<reason>)".
function pushLineHandler(job, stats) {
  return (line, kind) => {
    if (kind !== 'out') return false;
    const m = line.match(/^(.)\t([^\t]*)\t(.*)$/);
    if (!m) return line === 'Done' || line.startsWith('To ');
    const flag = PUSH_FLAGS[m[1]] || 'other';
    const to = (m[2].split(':')[1] || m[2]).replace(/^refs\/(heads|tags)\//, '');
    stats[flag] = (stats[flag] || 0) + 1;
    if (flag === 'rejected') stats.rejectedRefs.push(`${to}: ${m[3]}`);
    job.msg(flag === 'rejected' ? 'err' : flag === 'up-to-date' ? 'muted' : 'ok', 'pushResult', { flag, ref: to, summary: m[3] });
    return true;
  };
}

async function migrate(job, opts) {
  const dryRun = Boolean(opts.dryRun);
  const force = Boolean(opts.force);
  job.msg('info', dryRun ? 'dryRunStart' : 'migrateStart');

  let src = await readRepo(opts.source);
  const tgt = await readRepo(opts.target);
  if (src.root === tgt.root) throw new UserError('sameRepo');

  const srcRemote = pickRemote(src, opts.sourceRemote);
  const tgtRemote = pickRemote(tgt, opts.targetRemote);
  if (!tgtRemote) throw new UserError('targetNoRemote');
  const tr = tgt.remotes.get(tgtRemote);
  const targetUrl = tr.pushUrl || tr.fetchUrl;
  job.msg('info', 'logSource', { path: src.root, extra: srcRemote ? ` (${srcRemote} → ${src.remotes.get(srcRemote).fetchUrl})` : '' });
  job.msg('info', 'logTarget', { path: tgt.root, extra: ` (${tgtRemote} → ${targetUrl})` });

  if (opts.fetch && srcRemote) {
    job.section('step1Fetch', { remote: srcRemote });
    const r = await step(job, src.root, ['fetch', srcRemote, '--prune', '--tags']);
    if (r.code !== 0) throw new UserError('fetchFailed', { code: r.code });
    src = await readRepo(src.root);
  } else {
    job.section('step1Skip');
  }
  if (src.shallow) throw new UserError('shallowSource');

  const all = computeBranches(src, srcRemote, opts.prefer);
  const wanted = Array.isArray(opts.branches) ? new Set(opts.branches) : null;
  const branches = wanted ? all.filter((b) => wanted.has(b.name)) : all;
  const missing = wanted ? [...wanted].filter((n) => !all.some((b) => b.name === n)) : [];
  for (const n of missing) job.msg('warn', 'skipMissingBranch', { name: n });
  if (!branches.length && !opts.tags) throw new UserError('nothingToPush');

  const stats = { rejectedRefs: [] };
  const pushBase = ['push', '--porcelain', ...(dryRun ? ['--dry-run'] : [])];

  job.section(force ? 'step2PushForce' : 'step2Push', { count: branches.length });
  for (let i = 0; i < branches.length; i += PUSH_BATCH) {
    const specs = branches.slice(i, i + PUSH_BATCH).map((b) => `${force ? '+' : ''}${b.ref}:refs/heads/${b.name}`);
    const r = await step(job, src.root, [...pushBase, targetUrl, ...specs], { onLine: pushLineHandler(job, stats) });
    if (r.code !== 0 && !stats.rejectedRefs.length) throw new UserError('pushFailed', { code: r.code });
  }

  if (opts.tags) {
    job.section('step3Tags', { count: src.tags.length });
    if (src.tags.length) {
      const r = await step(job, src.root, [...pushBase, targetUrl, `${force ? '+' : ''}refs/tags/*:refs/tags/*`], { onLine: pushLineHandler(job, stats) });
      if (r.code !== 0 && !stats.rejectedRefs.length) throw new UserError('pushTagsFailed', { code: r.code });
    }
  } else {
    job.section('step3Skip');
  }

  if (opts.lfs) {
    job.section('step4Lfs');
    const v = await git(src.root, ['lfs', 'version']);
    if (v.code !== 0) {
      job.msg('warn', 'lfsMissing');
    } else {
      if (srcRemote) {
        const f = await step(job, src.root, ['lfs', 'fetch', '--all', srcRemote]);
        if (f.code !== 0) job.msg('warn', 'lfsFetchFailed');
      }
      const p = await step(job, src.root, ['lfs', 'push', ...(dryRun ? ['--dry-run'] : []), '--all', targetUrl]);
      if (p.code !== 0) stats.rejectedRefs.push('git lfs push');
    }
  }

  const verify = { checked: 0, mismatched: [] };
  if (!dryRun) {
    job.section('step5Verify');
    const r = await step(job, src.root, ['ls-remote', '--heads', '--tags', targetUrl], { quiet: true });
    if (r.code === 0) {
      const remote = new Map(r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t').reverse()));
      const expect = branches.map((b) => [`refs/heads/${b.name}`, b.sha]);
      if (opts.tags) for (const t of src.tags) expect.push([`refs/tags/${t.name}`, t.sha]);
      for (const [ref, sha] of expect) {
        verify.checked++;
        if (remote.get(ref) !== sha) verify.mismatched.push(ref.replace(/^refs\/(heads|tags)\//, ''));
      }
      if (verify.mismatched.length) {
        job.msg('err', 'verifyMismatch', { bad: verify.mismatched.length, total: verify.checked, list: verify.mismatched.slice(0, 20).join(', ') });
      } else {
        job.msg('ok', 'verifyOk', { total: verify.checked });
      }
    } else {
      job.msg('warn', 'verifyUnavailable');
    }

    if (opts.syncTarget) {
      job.section('step6Sync', { remote: tgtRemote });
      await step(job, tgt.root, ['fetch', tgtRemote, '--prune', '--tags']);
    }
  }

  const ok = !stats.rejectedRefs.length && !verify.mismatched.length;
  return {
    ok,
    dryRun,
    branches: branches.length,
    tags: opts.tags ? src.tags.length : 0,
    stats,
    verify,
  };
}

async function startMigration(opts) {
  if (activeJob) throw new UserError('busy');
  const job = createJob();
  activeJob = job;
  migrate(job, opts).then(
    (result) => {
      job.log('info', '');
      job.msg(result.ok ? 'ok' : 'err', result.ok ? 'finishedOk' : 'finishedWithErrors');
      job.finish(result.ok ? 'success' : 'failed', result);
    },
    (err) => {
      job.log('err', '');
      if (err instanceof UserError) job.msg('err', err.key, err.params);
      else job.log('err', `✘ ${err.stack || err}`);
      job.finish(job.cancelled ? 'cancelled' : 'failed', null);
    },
  );
  return job.id;
}

// ---------------------------------------------------------------------------
// Folder browsing / native picker
// ---------------------------------------------------------------------------

function browse(dir) {
  if (!dir) {
    if (IS_WIN) {
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = `${String.fromCharCode(c)}:\\`;
        if (fs.existsSync(d)) drives.push({ name: d, path: d, isGit: false });
      }
      return { path: '', parent: null, entries: drives };
    }
    dir = '/';
  }
  const abs = path.resolve(dir);
  let dirents;
  try {
    dirents = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    throw new UserError('browseFailed', { path: abs, code: err.code });
  }
  const entries = dirents
    .filter((d) => d.isDirectory() && d.name !== '.git' && !d.name.startsWith('$'))
    .map((d) => {
      const p = path.join(abs, d.name);
      return { name: d.name, path: p, isGit: fs.existsSync(path.join(p, '.git')) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(abs);
  return {
    path: abs,
    isGit: fs.existsSync(path.join(abs, '.git')),
    parent: parent !== abs ? parent : IS_WIN ? '' : null,
    entries,
  };
}

async function nativePick(initial, title) {
  let r;
  if (IS_WIN) {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = $env:PICK_TITLE',
      '$d.ShowNewFolderButton = $false',
      'if ($env:PICK_INITIAL -and (Test-Path $env:PICK_INITIAL)) { $d.SelectedPath = $env:PICK_INITIAL }',
      '$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
      "if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
    ].join('; ');
    r = await run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], {
      env: { PICK_TITLE: title || 'Select a folder', PICK_INITIAL: initial || '' },
    });
  } else if (process.platform === 'darwin') {
    r = await run('osascript', ['-e', `POSIX path of (choose folder with prompt "${(title || 'Select a folder').replace(/"/g, '')}")`]);
  } else {
    r = await run('zenity', ['--file-selection', '--directory', `--title=${title || 'Select a folder'}`]);
  }
  const picked = r.stdout.trim();
  if (!picked && r.code !== 0 && r.code !== 1) throw new UserError('pickerFailed');
  return picked || null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new UserError('invalidJson'));
      }
    });
    req.on('error', reject);
  });
}

// Only accept requests addressed to this local server (blocks DNS rebinding / cross-site posts).
function isLocalRequest(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return false;
  if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('application/json')) return false;
  return true;
}

async function handle(req, res) {
  if (!isLocalRequest(req)) return send(res, 403, { error: 'Forbidden' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/info') {
    return send(res, 200, { platform: process.platform, home: os.homedir(), cwd: process.cwd() });
  }
  if (req.method === 'GET' && p === '/api/browse') {
    return send(res, 200, browse(url.searchParams.get('path') || ''));
  }
  if (req.method === 'POST' && p === '/api/pick-folder') {
    const body = await readJson(req);
    return send(res, 200, { path: await nativePick(body.initial, body.title) });
  }
  if (req.method === 'POST' && p === '/api/inspect') {
    return send(res, 200, await inspect(await readJson(req)));
  }
  if (req.method === 'POST' && p === '/api/migrate') {
    return send(res, 200, { jobId: await startMigration(await readJson(req)) });
  }
  const jm = p.match(/^\/api\/jobs\/([\w-]+)\/(events|cancel)$/);
  if (jm) {
    const job = jobs.get(jm[1]);
    if (!job) return send(res, 404, { error: 'Job not found', code: 'jobNotFound' });
    if (jm[2] === 'cancel' && req.method === 'POST') {
      job.cancelled = true;
      if (job.child) job.child.kill();
      job.msg('warn', 'cancelling');
      return send(res, 200, { ok: true });
    }
    if (jm[2] === 'events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      for (const entry of job.logs) sse('log', entry);
      if (job.status !== 'running') {
        sse('done', { status: job.status, result: job.result });
        return res.end();
      }
      job.listeners.add(sse);
      req.on('close', () => job.listeners.delete(sse));
      return;
    }
  }

  if (req.method === 'GET' && !p.startsWith('/api/')) {
    const file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!(err instanceof UserError)) console.error(err);
    if (res.headersSent) return;
    if (err instanceof UserError) send(res, 400, { error: err.key, code: err.key, params: err.params });
    else send(res, 500, { error: err.message || String(err) });
  });
});

server.listen(PORT, HOST, () => {
  const link = `http://localhost:${PORT}`;
  console.log(`Bitbucket → GitHub migrator running at ${link}  (Ctrl+C to stop)`);
  if (process.argv.includes('--no-open')) return;
  const opener = IS_WIN ? ['cmd', ['/c', 'start', '', link]] : process.platform === 'darwin' ? ['open', [link]] : ['xdg-open', [link]];
  try {
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch {}
});
