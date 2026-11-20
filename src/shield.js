// Airlock's masking engine: deterministic rules + helpers to mask and restore.
// Everything here runs locally. Nothing in this file touches the network.

const luhn = (digits) => {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = +digits[i];
    if (alt && (n *= 2) > 9) n -= 9;
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
};

// Order = priority. Earlier rules win when matches overlap.
const RULES = [
  { type: 'CARD', re: /\b(?:\d[ -]?){13,19}\b/g, ok: (s) => luhn(s.replace(/\D/g, '')) },
  { type: 'AADHAAR', re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  { type: 'PAN', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: 'EMAIL', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  { type: 'UPI', re: /\b[\w.-]{2,}@(?!\w+\.)[a-z]{2,}\b/gi },
  { type: 'PHONE', re: /(?:\+91[ -]?)?\b[6-9]\d{4}[ -]?\d{5}\b/g },
  { type: 'IFSC', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  { type: 'SECRET', re: /\b(?:AIza[\w-]{35}|sk-[\w-]{20,}|ghp_\w{36}|AKIA[0-9A-Z]{16})\b/g },
];

export function detectRules(text) {
  const taken = [];
  const out = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      const value = m[0].replace(/[ -]+$/, '');
      if (rule.ok && !rule.ok(value)) continue;
      const start = m.index, end = start + value.length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      out.push({ text: value, type: rule.type, src: 'rule' });
    }
  }
  return out;
}

export function mergeEntities(rules, ai) {
  const all = [...rules];
  for (const e of ai) {
    if (all.some((r) => r.text.includes(e.text) || e.text.includes(r.text))) continue;
    if (all.some((r) => r.text === e.text)) continue;
    all.push({ ...e, src: 'ai' });
  }
  return all;
}

// value -> { token, type, src, text }. Same value always gets the same token.
export function buildMap(entities) {
  const counts = {};
  const map = new Map();
  for (const e of entities) {
    if (map.has(e.text)) continue;
    counts[e.type] = (counts[e.type] || 0) + 1;
    map.set(e.text, { ...e, token: `[${e.type}_${counts[e.type]}]` });
  }
  return map;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Split text into plain and sensitive parts: [{t}, {t, e}, ...]
export function splitParts(text, map) {
  if (!map.size) return [{ t: text }];
  const alt = [...map.keys()].sort((a, b) => b.length - a.length).map(esc).join('|');
  return text.split(new RegExp(`(${alt})`, 'g'))
    .map((t, i) => (i % 2 ? { t, e: map.get(t) } : { t }))
    .filter((p) => p.t !== '');
}

export const mask = (text, map) => splitParts(text, map).map((p) => (p.e ? p.e.token : p.t)).join('');

// Put real values back. Tolerates the model dropping the square brackets.
export function unmask(text, map) {
  let out = text;
  for (const e of map.values()) {
    const inner = esc(e.token.slice(1, -1));
    out = out.replace(new RegExp(`\\[?${inner}\\]?(?!\\d)`, 'g'), () => e.text);
  }
  return out;
}

// Cheap, deterministic hints for things Airlock may have missed: capitalised words in the
// middle of a sentence, and money amounts. Used by the review step so a human can decide.
const AMOUNT = /(?:₹|Rs\.?\s?)\d[\d,]*(?:\.\d+)?|\b\d[\d,.]*\s?(?:LPA|lakhs?|crores?)\b/g;
const STARTERS = new Set(['dear', 'hello', 'hi', 'hey', 'thanks', 'thank', 'please', 'compare', 'draft', 'write', 'explain',
  'summarize', 'summarise', 'ask', 'consider', 'why', 'what', 'how', 'when', 'where', 'who', 'regards', 'sincerely', 'best']);
export function suggest(raw, ents) {
  const have = ents.map((e) => e.text.toLowerCase());
  const covered = (s) => have.some((h) => h.includes(s.toLowerCase()));
  const out = [];
  const add = (s) => { if (s && !covered(s) && !out.includes(s)) out.push(s); };
  // Runs of capitalised words ("Rohit Sharma"). A lone capitalised word at the start of a
  // sentence is probably just grammar, so it is skipped. Common greetings are trimmed off.
  for (const m of raw.matchAll(/([.!?]\s+|\n)?\b([A-Z][a-z]{2,}(?:[ ][A-Z][a-z]{2,})*)\b/g)) {
    const words = m[2].split(' ');
    if ((m[1] || m.index === 0) && words.length === 1) continue;
    while (words.length && STARTERS.has(words[0].toLowerCase())) words.shift();
    add(words.join(' '));
  }
  for (const m of raw.matchAll(AMOUNT)) add(m[0].trim());
  return out.slice(0, 14);
}
