// Contact Parser: robust email and phone extraction and normalization
// No external dependencies; heuristic-based.

function cleanObfuscations(text) {
  if (!text || typeof text !== 'string') return '';
  let t = text;
  // Safe replacements for common obfuscations like "name at domain dot com"
  t = t.replace(/\s+(?:\[?at\]?|\(at\))\s+/gi, '@');
  t = t.replace(/\s+(?:\[?dot\]?|\(dot\))\s+/gi, '.');
  return t;
}

function normalizeEmail(email) {
  if (!email) return null;
  let e = String(email).trim();
  // strip trailing punctuation
  e = e.replace(/[\.,;:]+$/g, '');
  // Basic validation
  const parts = e.split('@');
  if (parts.length !== 2) return null;
  const local = parts[0];
  const domain = parts[1].toLowerCase();
  if (!local || !domain || domain.startsWith('-') || domain.endsWith('-')) return null;
  if (domain.includes('..')) return null;
  return `${local}@${domain}`;
}

function isValidEmail(email) {
  if (!email) return false;
  const re = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?:\.[A-Z]{2,})?\b/i;
  return re.test(email);
}

function extractEmails(text, max = 5) {
  const t = cleanObfuscations(text);
  const re = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?:\.[A-Z]{2,})?\b/gi;
  const found = new Set();
  let m;
  while ((m = re.exec(t)) && found.size < max) {
    const n = normalizeEmail(m[0]);
    if (n && isValidEmail(n)) found.add(n);
  }
  return Array.from(found);
}

function pickBestEmail(emails) {
  if (!Array.isArray(emails) || emails.length === 0) return null;
  // Prefer longer domains (likely more specific) and presence of dot in subdomain
  return emails.slice().sort((a, b) => {
    const da = a.split('@')[1] || '';
    const db = b.split('@')[1] || '';
    const score = (d) => (d.split('.').length) * 10 + d.length; // heuristic
    return score(db) - score(da);
  })[0];
}

function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // Keep leading + if present, strip everything else not a digit
  const hasPlus = s.trim().startsWith('+');
  s = s.replace(/[^0-9]/g, '');
  if (hasPlus) s = `+${s}`;
  // Remove multiple leading plus signs if any
  s = s.replace(/^\++/, '+');
  // Validate plausible length (E.164 permits max 15 digits without '+')
  const digits = s.startsWith('+') ? s.slice(1) : s;
  if (digits.length < 10 || digits.length > 15) return null;
  return s;
}

function isValidPhone(phone) {
  const n = normalizePhone(phone);
  return n !== null;
}

function extractPhones(text, max = 5) {
  if (!text || typeof text !== 'string') return [];
  // Find sequences that look like phone numbers
  const re = /(?:\+)?\d[\d\-\.\s\(\)]{6,}\d/g;
  const set = new Set();
  let m;
  while ((m = re.exec(text)) && set.size < max) {
    const normalized = normalizePhone(m[0]);
    if (normalized) set.add(normalized);
  }
  return Array.from(set);
}

function pickBestPhone(phones) {
  if (!Array.isArray(phones) || phones.length === 0) return null;
  return phones.slice().sort((a, b) => {
    const da = (a.startsWith('+') ? 1 : 0);
    const db = (b.startsWith('+') ? 1 : 0);
    if (db !== da) return db - da; // prefer E.164-like with +
    const la = (a.startsWith('+') ? a.length - 1 : a.length);
    const lb = (b.startsWith('+') ? b.length - 1 : b.length);
    return lb - la; // longer digits preferred
  })[0];
}

module.exports = {
  cleanObfuscations,
  extractEmails,
  extractPhones,
  pickBestEmail,
  pickBestPhone,
  normalizeEmail,
  normalizePhone,
  isValidEmail,
  isValidPhone
};