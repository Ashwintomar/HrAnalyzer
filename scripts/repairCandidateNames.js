// Repair script: fix wrong/generic candidate names using resume content heuristics
// Usage: node scripts/repairCandidateNames.js [--dry]

const Database = require('better-sqlite3');
const path = require('path');

function isGenericName(name) {
  if (!name) return true;
  const n = String(name).trim();
  if (!n) return true;
  if (/^candidate\b/i.test(n)) return true;
  if (/^unknown$/i.test(n)) return true;
  if (n.length < 3) return true;
  // Filenames often leak into names, e.g., "resume" or long hashes
  if (/resume|cv|document|file/i.test(n)) return true;
  return false;
}

function extractNameFromContent(text) {
  if (!text) return null;
  try {
    const firstChunk = text.split(/\n|\r/).slice(0, 10).join(' ');
    // Heuristic: take leading capitalized words before email
    const emailMatch = firstChunk.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const span = emailMatch ? firstChunk.slice(0, emailMatch.index) : firstChunk;
    // Look for 1-3 capitalized words
    const nameMatch = span.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/);
    if (nameMatch) {
      let n = nameMatch[1].trim();
      n = n.replace(/\s+/g, ' ').replace(/[^A-Za-z\s.'-]/g, '').trim();
      if (n && n.length >= 3 && n.length <= 80) return n;
    }
  } catch (_) {}
  return null;
}

function main() {
  const dryRun = process.argv.includes('--dry');
  const db = new Database(path.join(__dirname, '..', 'analyzer.db'));

  const rows = db.prepare(`
    WITH latest_resumes AS (
      SELECT r1.* FROM Resumes r1
      JOIN (
        SELECT candidate_id, MAX(id) AS max_id
        FROM Resumes
        GROUP BY candidate_id
      ) mr ON r1.id = mr.max_id
    )
    SELECT c.id AS candidate_id, c.name AS current_name, c.email, c.phone,
           lr.content AS content
    FROM Candidates c
    LEFT JOIN latest_resumes lr ON lr.candidate_id = c.id
  `).all();

  let examined = 0, updated = 0;
  const updateStmt = db.prepare(`UPDATE Candidates SET name = ? WHERE id = ?`);

  for (const r of rows) {
    examined++;
    if (!isGenericName(r.current_name)) continue;
    const suggested = extractNameFromContent(r.content);
    if (suggested && suggested !== r.current_name) {
      if (!dryRun) {
        try { updateStmt.run(suggested, r.candidate_id); updated++; }
        catch (e) { console.warn('Update failed for', r.candidate_id, e.message); }
      } else {
        console.log(`[DRY] Would update candidate ${r.candidate_id}: "${r.current_name}" -> "${suggested}"`);
        updated++;
      }
    }
  }

  console.log(`Checked ${examined} candidates; ${updated} ${dryRun ? 'eligible' : 'updated'}.`);
  db.close();
}

if (require.main === module) {
  main();
}
