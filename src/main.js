import { detector, localModel, cloudModel, ENTITY_TYPES, deviceStatus, wakeDevice, fromDevice, loadConfig } from './firebase.js';
import { detectRules, mergeEntities, expandAliases, buildMap, splitParts, mask, unmask, suggest } from './shield.js';

const $ = (id) => document.getElementById(id);
const SAMPLES = [
  'Draft a firm but polite email to my manager Rohit Sharma at Infosys. My PAN is ABCDE1234F and my salary is 28 LPA. Ask about the Project Nandini bonus.',
  'Compare these two vendor quotes for our Bhopal warehouse and tell me which to pick, with a step by step risk analysis. Vendor A is Kavya Logistics, contact Priya Nair at priya.k@kavyalog.in or 98765 43210, quote 18 lakh. Vendor B is Orbit Freight, quote 21 lakh, UPI orbit@okhdfcbank. Consider delivery time, penalties, insurance, and what happens if either vendor fails during the festive season.',
  'Why does this fail with a 403? const key = "AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"; fetch(url + key). My Aadhaar for the test account is 2345 6789 0123.',
];

let mode = 'auto';
let deviceReady = false;
let busy = false;
let cfg = { routerWords: 60, cloudEnabled: true }; // overwritten from Remote Config
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- leak report ----------
const KEY = 'airlock.stats.v1';
const blank = () => ({ runs: 0, secrets: 0, chars: 0, local: 0, cloud: 0, byType: {} });
const loadStats = () => { try { return { ...blank(), ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return blank(); } };
const saveStats = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } };
let stats = loadStats();
const BADGES = [
  { name: 'Aadhaar dodger', hint: 'Mask an Aadhaar number', ok: (s) => s.byType.AADHAAR >= 1 },
  { name: 'PAN protected', hint: 'Mask a PAN', ok: (s) => s.byType.PAN >= 1 },
  { name: 'Key keeper', hint: 'Catch an API key', ok: (s) => s.byType.SECRET >= 1 },
  { name: 'Name dropper, caught', hint: 'Mask 3 names', ok: (s) => s.byType.PERSON >= 3 },
  { name: 'Ghost mode', hint: 'Get 3 answers fully on-device', ok: (s) => s.local >= 3 },
  { name: 'Ten secrets stopped', hint: 'Mask 10 secrets', ok: (s) => s.secrets >= 10 },
];
function renderReport() {
  $('repLine').textContent = stats.runs
    ? `${plural(stats.secrets, 'secret', 'secrets')} masked across ${plural(stats.runs, 'message', 'messages')}. ${plural(stats.chars, 'character', 'characters')} of private text never left this device. ${stats.local} answered fully on-device, ${stats.cloud} sent masked to the cloud.`
    : 'Send a message to start your report. It is stored only in this browser.';
  $('badges').replaceChildren(...BADGES.map((b) => {
    const li = document.createElement('li');
    const on = b.ok(stats);
    li.textContent = b.name; li.className = on ? 'on' : 'off'; li.title = on ? 'Earned' : b.hint;
    return li;
  }));
}

// ---------- vault: words you always want masked ----------
const VKEY = 'airlock.vault.v1';
const loadVault = () => { try { return JSON.parse(localStorage.getItem(VKEY)) || []; } catch { return []; } };
function vaultHits(raw) {
  const out = [];
  for (const term of loadVault()) {
    for (const m of raw.matchAll(new RegExp(escapeRe(term), 'gi'))) {
      if (!out.some((e) => e.text === m[0])) out.push({ text: m[0], type: 'VAULT', src: 'vault' });
    }
  }
  return out;
}

// ---------- ui helpers ----------
function note(msg) { const n = $('note'); n.textContent = msg || ''; n.hidden = !msg; }
function setChip(text, state) { const c = $('deviceChip'); c.textContent = text; c.dataset.state = state; }
const SRC_LABEL = { rule: 'a rule', ai: 'the on-device model', you: 'you', vault: 'your vault' };

function markFor(p, as) {
  const s = document.createElement('mark');
  s.dataset.src = p.e.src;
  s.textContent = as === 'token' ? p.e.token : p.t;
  s.title = `Masked by ${SRC_LABEL[p.e.src] || 'Airlock'} (${p.e.type})`;
  if (as === 'token') s.className = 'token';
  return s;
}
function renderParts(el, parts, as) {
  el.classList.remove('muted');
  el.replaceChildren(...parts.map((p) => (p.e ? markFor(p, as) : document.createTextNode(p.t))));
}

function renderMarkdown(el, text, map) {
  el.classList.remove('muted');
  el.replaceChildren();
  const inline = (parent, s) => {
    s.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g).forEach((seg, i) => {
      if (!seg) return;
      let node = parent, body = seg;
      if (i % 2) {
        const strong = seg.startsWith('**');
        node = parent.appendChild(document.createElement(strong ? 'strong' : 'em'));
        body = seg.slice(strong ? 2 : 1, strong ? -2 : -1);
      }
      for (const p of splitParts(body, map)) node.append(p.e ? markFor({ ...p, t: p.t }, 'plain') : p.t);
    });
  };
  let list = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) { list = null; continue; }
    if (/^-{3,}$/.test(t)) { el.append(document.createElement('hr')); list = null; continue; }
    const h = t.match(/^#{1,6}\s+(.*)/);
    if (h) { inline(el.appendChild(document.createElement('h4')), h[1]); list = null; continue; }
    const li = t.match(/^([*-]|\d+\.)\s+(.*)/);
    if (li) {
      const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = el.appendChild(document.createElement(tag));
        if (tag === 'ol') list.start = parseInt(li[1], 10);
      }
      inline(list.appendChild(document.createElement('li')), li[2]);
      continue;
    }
    list = null;
    inline(el.appendChild(document.createElement('p')), t);
  }
}

// ---------- door lamp and token transit ----------
function setDoor(state, text) { $('door').dataset.state = state; $('doorText').textContent = text; }
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Each highlighted word on the left slides across the door and lands as a token on the right.
function flyTokens() {
  if (reduceMotion) return;
  const from = [...$('typedBody').querySelectorAll('mark')];
  const to = [...$('outBody').querySelectorAll('mark.token')];
  const n = Math.min(from.length, to.length, 10);
  to.forEach((el, i) => { if (i < n) el.style.visibility = 'hidden'; });
  for (let i = 0; i < n; i++) {
    const a = from[i].getBoundingClientRect();
    const b = to[i].getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'fly';
    f.textContent = from[i].textContent;
    f.style.left = `${a.left}px`;
    f.style.top = `${a.top}px`;
    document.body.append(f);
    const dx = b.left - a.left, dy = b.top - a.top;
    const anim = f.animate([
      { transform: 'translate(0, 0)' },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 22}px)` },
      { transform: `translate(${dx}px, ${dy}px)` },
    ], { duration: 800, delay: i * 80, easing: 'cubic-bezier(.5, 0, .2, 1)', fill: 'both' });
    setTimeout(() => { f.textContent = to[i].textContent; f.classList.add('masked'); }, i * 80 + 380);
    anim.finished.then(() => { to[i].style.visibility = ''; f.remove(); }).catch(() => { to[i].style.visibility = ''; f.remove(); });
  }
}

// ---------- inference log ----------
let log = [];
function addLog(step, how, where, t0) {
  log.push({ step, how, where, ms: Math.round(performance.now() - t0) });
  $('logBody').replaceChildren(...log.map((r) => {
    const tr = document.createElement('tr');
    [r.step, r.how, r.where, `${r.ms} ms`].forEach((v) => { const td = document.createElement('td'); td.textContent = v; tr.append(td); });
    return tr;
  }));
  $('log').hidden = false;
}

// ---------- device ----------
async function refreshDevice() {
  const s = await deviceStatus();
  deviceReady = s === 'available';
  const label = {
    available: ['On-device AI: ready', 'ok'],
    downloadable: ['On-device AI: tap to download', 'warn'],
    downloading: ['On-device AI: downloading', 'warn'],
    unavailable: ['On-device AI: not on this device', 'bad'],
    unsupported: ['On-device AI: needs desktop Chrome', 'bad'],
  }[s] || ['On-device AI: unknown', 'bad'];
  setChip(...label);
}
async function wake() {
  try {
    setChip('On-device AI: starting', 'warn');
    await wakeDevice((v) => setChip(`On-device AI: downloading ${Math.round(v * 100)}%`, 'warn'));
    deviceReady = true; setChip('On-device AI: ready', 'ok');
  } catch (err) {
    console.warn('On-device model unavailable', err);
    deviceReady = false; setChip('On-device AI: not on this device', 'bad');
  }
}

// ---------- review step (human in the loop) ----------
function review(raw, base, why) {
  return new Promise((resolve) => {
    let ents = base.map((e) => ({ ...e }));
    let confirming = false;
    $('review').hidden = false;
    $('reviewWhy').textContent = why;
    const clickable = (el, fn) => {
      el.tabIndex = 0; el.setAttribute('role', 'button'); el.onclick = fn;
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
    };
    const add = (word) => {
      const right = ents.find((e) => e.src === 'you' && raw.includes(`${e.text} ${word}`));
      const left = ents.find((e) => e.src === 'you' && raw.includes(`${word} ${e.text}`));
      if (right) { ents = ents.filter((e) => e !== right); ents.push({ text: `${right.text} ${word}`, type: 'OTHER', src: 'you' }); }
      else if (left) { ents = ents.filter((e) => e !== left); ents.push({ text: `${word} ${left.text}`, type: 'OTHER', src: 'you' }); }
      else ents.push({ text: word, type: 'OTHER', src: 'you' });
      draw();
    };
    const draw = () => {
      const map = buildMap(ents);
      const root = $('reviewText');
      root.replaceChildren();
      for (const p of splitParts(raw, map)) {
        if (p.e) {
          const m = markFor(p, 'plain');
          m.title = 'Click to stop masking this';
          clickable(m, () => { ents = ents.filter((x) => x.text !== p.e.text); draw(); });
          root.append(m);
          continue;
        }
        p.t.split(/(\s+)/).forEach((w) => {
          if (!w) return;
          const parts = /^\s+$/.test(w) ? null : w.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su);
          if (!parts || !parts[2]) { root.append(w); return; }
          root.append(parts[1]);
          const s = document.createElement('span');
          s.className = 'word'; s.textContent = parts[2];
          clickable(s, () => add(parts[2]));
          root.append(s, parts[3]);
        });
      }
      const hints = suggest(raw, ents);
      $('suggest').hidden = !hints.length;
      confirming = false;
      $('reviewGo').textContent = hints.length ? `Send masked version (${hints.length} unchecked)` : 'Send masked version';
      $('hintList').replaceChildren(...hints.map((h) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'hint'; b.textContent = h; b.onclick = () => add(h);
        return b;
      }));
      $('hintAll').onclick = () => hints.forEach((h) => { if (!ents.some((e) => e.text === h)) ents.push({ text: h, type: 'OTHER', src: 'you' }); draw(); });
    };
    const close = (value) => { $('review').hidden = true; resolve(value); };
    $('reviewGo').onclick = () => {
      const left = suggest(raw, ents).length;
      if (left && !confirming) {
        confirming = true;
        $('reviewGo').textContent = `Yes, send with ${left} word${left > 1 ? 's' : ''} unmasked`;
        return;
      }
      close(ents);
    };
    $('reviewCancel').onclick = () => close(null);
    draw();
    $('review').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

// ---------- pipeline ----------
// Long text is read in chunks so one big paste does not overflow the small on-device model.
function chunkText(text, size = 1800, max = 8) {
  const out = [];
  let cur = '';
  for (const part of text.split(/(?<=[.!?\n])\s+/)) {
    if (cur && cur.length + part.length + 1 > size) { out.push(cur); cur = part; }
    else cur = cur ? `${cur} ${part}` : part;
  }
  if (cur) out.push(cur);
  return { list: out.slice(0, max), cut: out.length > max };
}
const GENERIC = /^(vendor|supplier|client|customer|company|team|manager|option|quote)\s*[a-z0-9]?$/i;
const SEASON = /^(the\s+)?(festive|holiday|summer|winter|monsoon)\s+(season|period)$/i;
async function detectChunk(chunk, full) {
  const prompt = `You protect privacy. List only real-world identifiers in the text below: actual people's names, real company names, specific places or addresses, salary or price figures, and confidential project or client names. Do NOT list labels like "Vendor A", generic roles, seasons, dates or common words. Copy each one EXACTLY as written. Answer as JSON.\n\nTEXT:\n"""\n${chunk}\n"""`;
  const res = await detector.generateContent(prompt);
  if (!fromDevice(res)) throw new Error('detector ran off-device');
  const list = JSON.parse(res.response.text()).entities || [];
  return list.filter((e) => ENTITY_TYPES.includes(e.type) && typeof e.text === 'string'
    && e.text.trim().length > 2 && full.includes(e.text)
    && !GENERIC.test(e.text.trim()) && !SEASON.test(e.text.trim()));
}
// complete is false when the text was too long to read in full.
async function deepDetect(raw) {
  const { list, cut } = chunkText(raw);
  const hits = [];
  for (const c of list) {
    for (const e of await detectChunk(c, raw)) if (!hits.some((h) => h.text === e.text)) hits.push(e);
  }
  return { hits, complete: !cut };
}

function chooseRoute(masked, words) {
  const viaCloud = (why) => cfg.cloudEnabled
    ? { where: 'cloud', why }
    : deviceReady
      ? { where: 'local', why: 'Cloud is switched off in Remote Config, so this stayed on your device.' }
      : { where: 'blocked', why: 'Cloud is switched off in Remote Config and this browser has no on-device AI, so nothing can answer right now.' };
  if (mode === 'cloud') return viaCloud('You chose cloud. Only the masked text is sent.');
  if (mode === 'local') return deviceReady
    ? { where: 'local', why: 'You chose this device. Nothing is sent.' }
    : viaCloud('On-device AI is unavailable, so the masked text went to the cloud.');
  if (words > cfg.routerWords) return viaCloud(`Auto: ${words} words, over the ${cfg.routerWords}-word limit. Cloud gets masked text only.`);
  if (/\b(compare|analy[sz]e|step by step|strategy|debug|essay|detailed)\b/i.test(masked)) return viaCloud('Auto: this looks like a harder task. Cloud gets masked text only.');
  return deviceReady
    ? { where: 'local', why: 'Auto: short, simple prompt. Free and private, so it stays here.' }
    : viaCloud('Auto: on-device AI unavailable, so masked text went to the cloud.');
}

// Streams if it can, falls back to one-shot if the model or mode does not support streaming.
async function ask(model, prompt, onText) {
  let acc = '';
  try {
    const res = await model.generateContentStream(prompt);
    for await (const chunk of res.stream) { acc += chunk.text(); onText(acc); }
    const final = await res.response;
    return { text: acc, onDevice: final.inferenceSource ? String(final.inferenceSource).includes('device') : null };
  } catch (err) {
    if (acc) throw err;
    const r = await model.generateContent(prompt);
    return { text: r.response.text(), onDevice: r.response.inferenceSource ? fromDevice(r) : null };
  }
}

async function run() {
  const raw = $('prompt').value.trim();
  if (!raw || busy) return;
  busy = true; $('send').disabled = true; note(''); log = []; $('log').hidden = true;
  $('answer').hidden = true; $('review').hidden = true;
  setDoor('scan', 'Scanning');
  try {
    if (!deviceReady) await wake(); // needs the click gesture, so it comes first

    let t = performance.now();
    const rules = [...detectRules(raw), ...vaultHits(raw)];
    addLog('Pattern rules', 'local code', 'This device', t);

    let aiHits = [];
    let scanned = false; // true only if the on-device model read all of the text
    if (deviceReady) {
      $('send').textContent = 'Reading on your device';
      t = performance.now();
      try {
        const r = await deepDetect(raw);
        aiHits = r.hits; scanned = r.complete;
        addLog('Find names, companies, amounts', 'ONLY_ON_DEVICE', 'This device', t);
      } catch (err) { console.warn('on-device detection failed for this message', err); }
    }

    let found = expandAliases(raw, mergeEntities(rules, aiHits));
    if ($('keepMoney').checked) found = found.filter((e) => e.type !== 'MONEY');
    let map = buildMap(found);
    const words = raw.split(/\s+/).length;
    let route = chooseRoute(mask(raw, map), words);

    // Nothing leaves unreviewed when the on-device model could not read the text, or when asked.
    if (route.where === 'blocked') { note(route.why); setDoor('fault', 'Cloud paused'); return; }

    if (route.where === 'cloud' && (!scanned || $('reviewToggle').checked)) {
      $('send').textContent = 'Waiting for your review';
      setDoor('hold', 'Hold: review needed');
      let start = found;
      let why = 'You asked to check before anything is sent.';
      if (!scanned) {
        // No reliable name detection, so pre-select likely names and amounts for the person to confirm.
        const guess = suggest(raw, found)
          .filter((g) => !($('keepMoney').checked && /LPA|lakh|crore|₹|Rs/i.test(g)))
          .map((g) => ({ text: g, type: 'OTHER', src: 'you' }));
        start = [...found, ...guess];
        why = deviceReady
          ? 'The on-device model could not read all of this text. Airlock pre-selected likely names and amounts. Fix anything wrong, then send.'
          : 'The on-device model is not available in this browser, so Airlock matched patterns (PAN, phone, email) and guessed at names and amounts. Fix anything wrong, then send.';
      }
      const approved = await review(raw, start, why);
      if (!approved) { note('Cancelled. Nothing was sent.'); setDoor('idle', 'Standby'); return; }
      setDoor('scan', 'Scanning');
      found = approved; map = buildMap(found); route = chooseRoute(mask(raw, map), words);
    }
    const masked = mask(raw, map);

    $('typed').hidden = false;
    renderParts($('typedBody'), splitParts(raw, map), 'plain');
    renderParts($('outBody'), splitParts(raw, map), 'token');

    const showAnswer = (txt) => { $('answer').hidden = false; renderMarkdown($('answerBody'), txt, map); };
    const hideTail = (s) => s.replace(/\[[A-Z_0-9]{0,12}$/, '');
    let text = null, by = '', bytes = 0, usedLocal = false;

    $('send').textContent = route.where === 'local' ? 'Answering on your device' : 'Asking the cloud';
    if (route.where === 'cloud') { setDoor('transit', 'In transit, masked'); flyTokens(); }
    if (route.where === 'local') {
      try {
        t = performance.now();
        // Raw text is safe here: ONLY_ON_DEVICE can never leave the machine.
        const r = await ask(localModel, `Answer helpfully and concisely.\n\n${raw}`, (s) => showAnswer(s));
        text = r.text; by = 'This device'; usedLocal = true;
        addLog('Answer', 'ONLY_ON_DEVICE', 'This device', t);
        $('outBody').textContent = 'Nothing. This answer never left your device.';
        $('outBody').classList.add('muted');
      } catch (err) { console.warn('local answer failed, using masked cloud path', err); route.why += ' (On-device answer failed, so it used the cloud.)'; }
    }
    if (!usedLocal) {
      const tokens = [...map.values()].map((e) => e.token);
      const hint = tokens.length
        ? `These tokens stand for private details: ${tokens.join(', ')}. Keep them exactly as written, in square brackets. Never invent other tokens.`
        : '';
      const payload = `Answer helpfully and concisely. ${hint}\n\n${masked}`;
      bytes = new TextEncoder().encode(payload).length;
      t = performance.now();
      const r = await ask(cloudModel, payload, (s) => showAnswer(unmask(hideTail(s), map)));
      text = unmask(r.text, map);
      if (r.onDevice) {
        bytes = 0; by = 'This device (offline fallback)';
        route.why = 'The cloud was unreachable, so the on-device model answered. Nothing left this device.';
        $('outBody').textContent = 'Nothing. You were offline, so this device answered.';
        $('outBody').classList.add('muted');
        addLog('Answer', 'PREFER_IN_CLOUD', 'This device (fallback)', t);
      } else {
        by = 'Gemini in the cloud';
        addLog('Answer', 'PREFER_IN_CLOUD', 'Cloud', t);
      }
    }

    showAnswer(text);
    const vals = [...map.values()];
    $('mMasked').textContent = map.size;
    $('mSplit').textContent = `${vals.filter((e) => e.src === 'rule' || e.src === 'vault').length} by rules, ${vals.filter((e) => e.src === 'ai').length} by on-device AI, ${vals.filter((e) => e.src === 'you').length} by you`;
    $('mBytes').textContent = bytes;
    $('mBytesCard').dataset.tone = bytes === 0 ? 'safe' : 'out';
    $('mBy').textContent = by;
    $('mWhy').textContent = route.why;
    $('meter').hidden = false;
    if (bytes === 0) setDoor('sealed', 'Sealed: 0 bytes out');
    else setDoor('out', `Masked out: ${bytes} bytes`);

    stats.runs++; stats.secrets += map.size;
    stats.chars += [...map.keys()].reduce((n, k) => n + k.length, 0);
    by.startsWith('This device') ? stats.local++ : stats.cloud++;
    for (const e of map.values()) stats.byType[e.type] = (stats.byType[e.type] || 0) + 1;
    saveStats(stats); renderReport();
  } catch (err) {
    console.error(err);
    const msg = String(err.message || err);
    note(/429|quota|RESOURCE_EXHAUSTED/i.test(msg)
      ? 'The shared cloud quota for this demo is used up for now. Try "This device" mode, or come back in a few minutes.'
      : /App Check|401|403/i.test(msg)
        ? 'The cloud did not accept this browser (App Check). Your private details were not sent. Try again, or use "This device" mode if your browser supports it.'
        : `Something went wrong: ${msg}`);
    setDoor('fault', 'Stopped');
  } finally {
    busy = false; $('send').disabled = false; $('send').textContent = 'Send through Airlock';
  }
}

// ---------- wiring ----------
$('send').addEventListener('click', run);
$('prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run(); });
$('deviceChip').addEventListener('click', () => { if (!deviceReady) wake(); });
document.querySelectorAll('[data-sample]').forEach((b) => b.addEventListener('click', () => { $('prompt').value = SAMPLES[+b.dataset.sample]; $('prompt').focus(); }));
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
}));
$('vaultInput').value = loadVault().join(', ');
$('vaultInput').addEventListener('input', () => {
  const terms = $('vaultInput').value.split(',').map((s) => s.trim()).filter((s) => s.length > 1);
  try { localStorage.setItem(VKEY, JSON.stringify(terms)); } catch { /* private mode */ }
});
$('reset').addEventListener('click', () => { stats = blank(); saveStats(stats); renderReport(); });
window.addEventListener('online', refreshDevice);

// Load the model into memory in the background so the first message is not slow.
async function warmUp() {
  if (!deviceReady) return;
  try {
    setChip('On-device AI: warming up', 'warn');
    await detector.initializeDeviceModel();
    await detector.generateContent('Reply with {"entities":[]}.');
  } catch (err) { console.warn('warm-up skipped', err); }
  setChip('On-device AI: ready', 'ok');
}

renderReport();
refreshDevice().then(warmUp);
loadConfig().then((c) => { cfg = c; });
