'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
app.disableHardwareAcceleration();
process.on('uncaughtException', (err) => {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'crystal-crash.log'), String(err && err.stack || err) + '\n'); } catch {}
});
app.commandLine.appendSwitch('enable-transparent-visuals');
app.commandLine.appendSwitch('enable-gpu-rasterization');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RESOURCES = 'https://resources.download.minecraft.net/';
const LIBRARIES = 'https://libraries.minecraft.net/';

const ROOT = path.join(app.getPath('appData'), 'CrystalLauncher');
const MC = path.join(ROOT, 'minecraft');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const DEFAULTS = {
  username: 'Player', ram: 4096, java: '', version: '',
  width: 1280, height: 720, customRes: false, effects: true
};

let win = null;
let child = null;
let running = false;
let manifestCache = null;

function readConfig() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
  catch { return Object.assign({}, DEFAULTS); }
}
function writeConfig(c) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1000, height: 700, minWidth: 860, minHeight: 600,
    frame: false, transparent: true, resizable: true,
    backgroundColor: '#00000000', hasShadow: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
    }
  });
    win.loadFile(path.join(__dirname, 'ui', 'index.html')).catch(e => {
    try { fs.appendFileSync(path.join(os.tmpdir(), 'crystal-crash.log'), 'loadFile failed: ' + e.message + '\n'); } catch {}
  });
  win.once('ready-to-show', () => win.show());
  setTimeout(() => { if (win && !win.isVisible()) win.show(); }, 3000);
}

ipcMain.on('win:min', () => win && win.minimize());
ipcMain.on('win:close', () => win && win.close());

const sha1File = (p) => new Promise((res, rej) => {
  const h = crypto.createHash('sha1');
  fs.createReadStream(p).on('data', d => h.update(d))
    .on('end', () => res(h.digest('hex'))).on('error', rej);
});

function fetchToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'CrystalLauncher/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchToFile(new URL(res.headers.location, url).href, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function download(url, dest, sha1, attempt = 0) {
  try {
    if (sha1 && fs.existsSync(dest) && await sha1File(dest) === sha1) return;
    if (!sha1 && fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = dest + '.part';
    await fetchToFile(url, tmp);
    if (sha1) {
      const got = await sha1File(tmp);
      if (got !== sha1) { fs.unlinkSync(tmp); throw new Error('sha1 mismatch'); }
    }
    await fsp.rename(tmp, dest);
  } catch (e) {
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
      return download(url, dest, sha1, attempt + 1);
    }
    throw e;
  }
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CrystalLauncher/1.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const osName = () => process.platform === 'win32' ? 'windows'
  : process.platform === 'darwin' ? 'osx' : 'linux';

function ruleAllows(rules, features) {
  if (!rules || !rules.length) return true;
  let allow = false;
  for (const r of rules) {
    const o = r.os || {};
    let match = true;
    if (o.name && o.name !== osName()) match = false;
    if (o.arch) {
      const a = process.arch === 'x64' ? 'x86_64' : process.arch === 'ia32' ? 'x86' : 'arm64';
      if (o.arch !== a) match = false;
    }
    if (o.version && !new RegExp(o.version).test(os.release())) match = false;
    if (r.features) for (const k in r.features)
      if (Boolean(features[k]) !== Boolean(r.features[k])) match = false;
    if (match) allow = r.action === 'allow';
  }
  return allow;
}

function mavenPath(name) {
  const p = name.split(':');
  const [group, artifact, version, classifier] = p;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? '-' + classifier : ''}.jar`;
}

function offlineUuid(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function extractNatives(jar, dir, excludes) {
  const zip = new AdmZip(jar);
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if ((excludes || ['META-INF/']).some(e => entry.entryName.startsWith(e))) continue;
    const out = path.join(dir, path.basename(entry.entryName));
    if (fs.existsSync(out)) continue;
    fs.writeFileSync(out, entry.getData());
  }
}

function javaMajor(p) {
  const r = spawnSync(p, ['-version'], { encoding: 'utf8' });
  const txt = (r.stderr || '') + (r.stdout || '');
  const m = txt.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  const major = parseInt(m[1], 10);
  return major === 1 ? parseInt(m[2] || '0', 10) : major;
}

function findJava() {
  const out = [];
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  const roots = [
    'C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft\\jdk', 'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft', '/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'
  ];
  for (const r of roots) {
    try {
      for (const d of fs.readdirSync(r)) {
        const p = path.join(r, d, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
        if (fs.existsSync(p)) candidates.push(p);
      }
    } catch {}
  }
  for (const c of candidates) {
    try { const m = javaMajor(c); if (m > 0) out.push({ path: c, major: m }); } catch {}
  }
  if (process.platform === 'win32') {
    const w = spawnSync('where', ['java'], { encoding: 'utf8' });
    for (const line of (w.stdout || '').split(/\r?\n/)) {
      const p = line.trim();
      if (p && fs.existsSync(p)) { try { out.push({ path: p, major: javaMajor(p) }); } catch {} }
    }
  }
  return out.sort((a, b) => b.major - a.major);
}

ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('config:set', (_e, c) => { writeConfig(Object.assign(readConfig(), c)); return true; });
ipcMain.handle('java:detect', () => findJava());
ipcMain.handle('pick:dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick:file', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('open:folder', (_e, p) => { shell.openPath(p || MC); });

ipcMain.handle('versions:list', async () => {
  if (!manifestCache) manifestCache = await fetchJson(MANIFEST_URL);
  return manifestCache.versions
    .filter(v => v.type === 'release' || v.type === 'snapshot')
    .slice(0, 400)
    .map(v => ({ id: v.id, type: v.type, url: v.url }));
});

ipcMain.handle('kill', () => {
  if (child) { try { child.kill(); } catch {} }
  running = false;
});

ipcMain.handle('launch', async (_e, opts) => {
  if (running) return { ok: false, error: 'Already running' };
  const send = (ch, d) => win && win.webContents.send(ch, d);
  const log = (t) => send('log', t);

  try {
    running = true;
    const cfg = Object.assign(readConfig(), opts || {});
    writeConfig(cfg);
    const username = (cfg.username || '').trim() || 'Player';

    log('Resolving version ' + cfg.version + '…');
    if (!manifestCache) manifestCache = await fetchJson(MANIFEST_URL);
    const entry = manifestCache.versions.find(v => v.id === cfg.version);
    if (!entry) throw new Error('Unknown version');

    const version = await fetchJson(entry.url);
    const gameDir = MC;
    const libDir = path.join(MC, 'libraries');
    const assetsDir = path.join(MC, 'assets');
    const nativesDir = path.join(MC, 'natives', cfg.version);
    const versionDir = path.join(MC, 'versions', cfg.version);
    fs.rmSync(nativesDir, { recursive: true, force: true });
    fs.mkdirSync(versionDir, { recursive: true });

    let javaPath = cfg.java;
    const need = (version.javaVersion && version.javaVersion.majorVersion) || 8;
    if (!javaPath) {
      const found = findJava().filter(j => j.major >= need);
      if (!found.length) throw new Error(`Java ${need}+ required. Install it and set the path in settings.`);
      javaPath = found[0].path;
    }
    log('Using Java: ' + javaPath);

    const clientJar = path.join(versionDir, cfg.version + '.jar');
    await download(version.downloads.client.url, clientJar, version.downloads.client.sha1);

    const classpath = [];
    const tasks = [];
    const nativeJars = [];
    for (const lib of version.libraries || []) {
      if (!ruleAllows(lib.rules, {})) continue;
      const dl = lib.downloads || {};
      const isNative = Boolean(lib.natives && lib.natives[osName()]) || /:natives-/.test(lib.name);
      if (isNative) {
        let art = null;
        if (lib.natives && lib.natives[osName()] && dl.classifiers)
          art = dl.classifiers[lib.natives[osName()].replace('${arch}', process.arch === 'ia32' ? '32' : '64')];
        if (!art) art = dl.artifact;
        if (art) {
          const dest = path.join(libDir, art.path || mavenPath(lib.name));
          tasks.push({ url: art.url, dest, sha1: art.sha1 });
          nativeJars.push({ dest, exclude: (lib.extract && lib.extract.exclude) || ['META-INF/'] });
        }
        continue;
      }
      if (dl.artifact) {
        const dest = path.join(libDir, dl.artifact.path || mavenPath(lib.name));
        tasks.push({ url: dl.artifact.url, dest, sha1: dl.artifact.sha1 });
        classpath.push(dest);
      } else if (lib.name) {
        const p = mavenPath(lib.name);
        const dest = path.join(libDir, p);
        tasks.push({ url: LIBRARIES + p, dest });
        classpath.push(dest);
      }
    }
    classpath.push(clientJar);

    const assetNames = [];
    if (version.assetIndex) {
      const idxPath = path.join(assetsDir, 'indexes', version.assetIndex.id + '.json');
      await download(version.assetIndex.url, idxPath, version.assetIndex.sha1);
      const objects = JSON.parse(fs.readFileSync(idxPath, 'utf8')).objects || {};
      for (const name in objects) {
        const o = objects[name];
        tasks.push({
          url: RESOURCES + o.hash.slice(0, 2) + '/' + o.hash,
          dest: path.join(assetsDir, 'objects', o.hash.slice(0, 2), o.hash),
          sha1: o.hash
        });
        assetNames.push(name);
      }
    }

    const total = tasks.length;
    let done = 0, failed = 0;
    send('progress', { done, total, phase: 'Downloading ' + total + ' files' });
    let cursor = 0;
    const worker = async () => {
      while (cursor < tasks.length) {
        const t = tasks[cursor++];
        try { await download(t.url, t.dest, t.sha1); }
        catch { failed++; }
        done++;
        if (done % 8 === 0 || done === total)
          send('progress', { done, total, phase: 'Downloading' + (failed ? ` (${failed} failed)` : '') });
      }
    };
    await Promise.all(Array.from({ length: Math.min(24, tasks.length) }, worker));

    for (const n of nativeJars) {
      if (fs.existsSync(n.dest)) { try { extractNatives(n.dest, nativesDir, n.exclude); } catch { log('native extract failed: ' + n.dest); } }
    }

    if (version.assetIndex && ['legacy', 'pre-1.6'].includes(version.assetIndex.id)) {
      const vdir = path.join(assetsDir, 'virtual', version.assetIndex.id);
      const idxPath = path.join(assetsDir, 'indexes', version.assetIndex.id + '.json');
      const objects = JSON.parse(fs.readFileSync(idxPath, 'utf8')).objects || {};
      for (const name of assetNames) {
        const h = objects[name].hash;
        const src = path.join(assetsDir, 'objects', h.slice(0, 2), h);
        const dst = path.join(vdir, name);
        if (fs.existsSync(src)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
      }
    }

    let logConfig = '';
    if (version.logging && version.logging.client && version.logging.client.file) {
      logConfig = path.join(versionDir, 'log4j.xml');
      await download(version.logging.client.file.url, logConfig, version.logging.client.file.sha1);
    }

    const cpSep = process.platform === 'win32' ? ';' : ':';
    const subs = {
      auth_player_name: username,
      version_name: cfg.version,
      game_directory: gameDir,
      assets_root: assetsDir,
      assets_index_name: version.assetIndex ? version.assetIndex.id : 'legacy',
      auth_uuid: offlineUuid(username),
      auth_access_token: crypto.randomBytes(16).toString('hex'),
      clientid: '0', auth_xuid: '0',
      user_type: 'legacy',
      version_type: version.type || 'release',
      natives_directory: nativesDir,
      launcher_name: 'CrystalLauncher',
      launcher_version: '1.0',
      classpath,
      classpath_separator: cpSep,
      library_directory: libDir,
      resolution_width: String(cfg.width || 1280),
      resolution_height: String(cfg.height || 720),
      path: logConfig
    };

        const features = { has_custom_resolution: !!cfg.customRes };
    const fill = (s) => String(s).replace(/\$\{([a-z_]+)\}/gi, (m, k) => {
      const v = subs[k];
      if (Array.isArray(v)) return v.join(subs.classpath_separator);
      return (k in subs ? v : '');
    });

    const args = [];
    const ram = Math.max(1024, Math.min(32768, Number(cfg.ram) || 4096));
    args.push(`-Xmx${ram}M`, `-Xms${Math.round(ram / 2)}M`);
    args.push('-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4', '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32', '-XX:MaxTenuringThreshold=1', '-Dusing.aikars.flags=https://mcflags.emc.gs');

        const jvm = (version.arguments && version.arguments.jvm) || [];
    for (const a of jvm) {
      if (typeof a === 'string') args.push(fill(a));
      else if (ruleAllows(a.rules, features)) {
        const vals = Array.isArray(a.value) ? a.value : [a.value];
        for (const v of vals) args.push(fill(v));
      }
    }

    args.push(version.mainClass);
    if (version.arguments && version.arguments.game) {
      for (const a of version.arguments.game) {
        if (typeof a === 'string') args.push(fill(a));
        else if (ruleAllows(a.rules, features)) {
          const vals = Array.isArray(a.value) ? a.value : [a.value];
          for (const v of vals) args.push(fill(v));
        }
      }
    } else if (version.minecraftArguments) {
      for (const a of version.minecraftArguments.split(' ')) args.push(fill(a));
    }

    fs.mkdirSync(gameDir, { recursive: true });
    log('Starting Minecraft…');
    send('progress', { done: total, total, phase: 'Launching' });

    child = spawn(javaPath, args, { cwd: gameDir, windowsHide: true });
    child.stdout.on('data', d => log(d.toString().trimEnd()));
    child.stderr.on('data', d => log(d.toString().trimEnd()));
    child.on('error', e => log('spawn error: ' + e.message));
    child.on('close', (code) => {
      running = false;
      log(`Game exited (code ${code}).`);
      send('done', { code });
    });

    return { ok: true };
  } catch (e) {
    running = false;
    send('done', { code: -1 });
    return { ok: false, error: e.message };
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
