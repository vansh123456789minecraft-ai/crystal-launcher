const $ = (id) => document.getElementById(id);
let versions = [];
let selected = '';
let cfg = {};

const setStatus = (t) => { $('status').textContent = t; };
const pushLog = (t) => {
  const el = $('log');
  el.textContent += t + '\n';
  el.scrollTop = el.scrollHeight;
};

async function boot() {
  cfg = await window.api.getConfig();
  $('username').value = cfg.username || '';
  $('ram').value = Math.min(Math.max(cfg.ram || 6144, 1024), 16384);
  $('ramVal').textContent = Math.round($('ram').value / 1024) + ' GB';
  $('w').value = cfg.width || 1280;
  $('h').value = cfg.height || 720;
  $('customRes').checked = !!cfg.customRes;
  $('effects').checked = cfg.effects !== false;
  document.body.classList.toggle('reduced', cfg.effects === false);
  if (cfg.java) $('javaInfo').textContent = cfg.java.split(/[\\/]/).pop();
  if (cfg.width) $('resInfo').textContent = `${cfg.width} × ${cfg.height}`;

  versions = await window.api.versions();
  renderVersions('');
  const preferred = cfg.version || (versions[0] && versions[0].id);
  select(preferred);
}

function renderVersions(q) {
  const list = $('versionList');
  list.innerHTML = '';
  const needle = q.toLowerCase();
  versions
    .filter(v => !needle || v.id.toLowerCase().includes(needle))
    .slice(0, 120)
    .forEach(v => {
      const el = document.createElement('div');
      el.className = 'vitem' + (v.id === selected ? ' on' : '');
      el.innerHTML = `<span>${v.id}</span>${v.type === 'release' ? '' : '<small>snap</small>'}`;
      el.onclick = () => select(v.id);
      list.appendChild(el);
    });
}

function select(id) {
  if (!id) return;
  selected = id;
  document.querySelectorAll('.vitem').forEach(n => n.classList.remove('on'));
  const node = [...document.querySelectorAll('.vitem')].find(n => n.firstChild.textContent === id);
  if (node) node.classList.add('on');
}

$('search').oninput = (e) => renderVersions(e.target.value);

$('ram').oninput = (e) => { $('ramVal').textContent = Math.round(e.target.value / 1024) + ' GB'; };

$('play').onclick = async () => {
  if (!selected) return setStatus('Pick a version first');
  const username = $('username').value.trim();
  if (!username) return setStatus('Enter a username');

  $('play').disabled = true;
  $('barFill').style.width = '0%';
  setStatus('Preparing…');

  const res = await window.api.launch({
    username,
    version: selected,
    ram: Number($('ram').value),
    java: cfg.java || '',
    width: Number($('w').value) || 1280,
    height: Number($('h').value) || 720,
    customRes: $('customRes').checked
  });

  if (!res.ok) {
    setStatus('Failed: ' + res.error);
    pushLog('ERROR: ' + res.error);
    $('play').disabled = false;
  } else {
    setStatus('Running…');
  }
};

window.api.onProgress(({ done, total, phase }) => {
  $('barFill').style.width = total ? (done / total * 100).toFixed(1) + '%' : '0%';
  setStatus(`${phase} — ${done} / ${total}`);
});
window.api.onLog(pushLog);
window.api.onDone(({ code }) => {
  $('play').disabled = false;
  $('barFill').style.width = '0%';
  setStatus(code === 0 ? 'Closed' : 'Stopped');
});

/* settings */
$('btnSettings').onclick = async () => {
  $('settings').classList.add('open');
  const found = await window.api.detectJava();
  $('javaFound').textContent = found.length
    ? 'Found: ' + found.map(f => f.path + ' (Java ' + f.major + ')').join(' · ')
    : 'No Java found — install Java 21 from adoptium.net';
};
$('btnCloseSettings').onclick = () => $('settings').classList.remove('open');
$('btnJava').onclick = async () => {
  const p = await window.api.pickFile();
  if (p) { cfg.java = p; $('javaPath').value = p; $('javaInfo').textContent = p.split(/[\\/]/).pop(); }
};
$('btnFolder').onclick = () => window.api.openFolder('');
$('effects').onchange = (e) => {
  document.body.classList.toggle('reduced', !e.target.checked);
  cfg.effects = e.target.checked;
};

['w', 'h'].forEach(id => $(id).oninput = () => { $('resInfo').textContent = `${$('w').value} × ${$('h').value}`; });
$('customRes').onchange = () => { cfg.customRes = $('customRes').checked; };

async function persist() {
  await window.api.saveConfig({
    username: $('username').value.trim(),
    ram: Number($('ram').value),
    java: cfg.java || '',
    version: selected,
    width: Number($('w').value) || 1280,
    height: Number($('h').value) || 720,
    customRes: $('customRes').checked,
    effects: $('effects').checked
  });
}
setInterval(persist, 2500);

$('btnMin').onclick = () => window.api.min();
$('btnClose').onclick = () => window.api.close();
$('btnClear').onclick = () => { $('log').textContent = ''; };

boot();
