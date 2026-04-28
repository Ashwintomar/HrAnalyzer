// Analysis Engine for Hr Analyzer
// Handles intelligent ingestion and ranking logic

const Database = require('better-sqlite3');
const { load } = require('sqlite-vec');
const path = require('path');
const modelCompatibilityChecker = require('../../core/embeddingAligner');
const contactParser = require('../../core/contactParser');
const { computeOutlierThresholds } = require('./analysisDiagnostics');
const { ensureRuntimeDirectories, getDatabasePath } = require('../../core/runtimePaths');

// Business rule: UI filters candidates with similarity >= 98%
const UI_OUTLIER_THRESHOLD = 0.98;

class AnalysisEngine {
    constructor() {
        // Database connection - point to the root analyzer.db that contains data
        ensureRuntimeDirectories();
        this.db = new Database(getDatabasePath());
        
        // Try to load sqlite-vec extension
        this.vectorExtensionAvailable = false;
        try {
            load(this.db);
            this.vectorExtensionAvailable = true;
            console.log('✅ sqlite-vec loaded in AnalysisEngine');
        } catch (error) {
            console.log('⚠️ sqlite-vec not available in AnalysisEngine, using fallback');
        }
        
        // Prepare SQL statements
        this.insertCandidateStmt = this.db.prepare(`
            INSERT INTO Candidates (name, email, phone, resume_url)
            VALUES (?, ?, ?, ?)
        `);
        this.insertSourceStmt = this.db.prepare(`
            INSERT INTO ResumeSources (candidate_id, original_url, canonical_key)
            VALUES (?, ?, ?)
        `);
        this.findSourceStmt = this.db.prepare(`
            SELECT rs.candidate_id, c.name FROM ResumeSources rs
            JOIN Candidates c ON rs.candidate_id = c.id
            WHERE rs.canonical_key = ?
        `);

        // Helpers for updating/enriching candidate metadata and checking resume presence
        this.updateCandidatePartialStmt = this.db.prepare(`UPDATE Candidates SET 
            name = COALESCE(@name, name),
            email = COALESCE(@email, email),
            phone = COALESCE(@phone, phone)
        WHERE id = @id`);
        this.countResumesForCandidateStmt = this.db.prepare(`SELECT COUNT(1) AS cnt FROM Resumes WHERE candidate_id = ?`);
        this.getCandidateByIdStmt = this.db.prepare(`SELECT id, name, email, phone FROM Candidates WHERE id = ?`);
        
        this.insertJobStmt = this.db.prepare(`
            INSERT INTO Jobs (title, description, requirements, embedding, embedding_json)
            VALUES (?, ?, ?, ?, ?)
        `);
        
        this.insertRankingStmt = this.db.prepare(`
            INSERT INTO Rankings (job_id, candidate_id, similarity_score, rank_position)
            VALUES (?, ?, ?, ?)
        `);
        
        this.getResumesStmt = this.db.prepare(`
            SELECT r.id, r.candidate_id, r.content, r.embedding, r.embedding_json, r.local_file_path, r.embedding_model,
                   c.name, c.email, c.phone, c.resume_url
            FROM Resumes r
            JOIN Candidates c ON r.candidate_id = c.id
        `);
        
        // Only log vector search readiness if extension is available
        if (this.vectorExtensionAvailable) {
            console.log('Vector search via sqlite-vec is available');
        }
    }
    
    // Find unique URLs from Excel data
    findUniqueResumeUrls(excelData) {
        console.log('Finding unique resume URLs from Excel data...');

        
        const seenUrls = new Set();
        const resumeData = [];
        
        // Common column patterns for URLs
        const urlPatterns = [
            'resume_url', 'resume url', 'url', 'resume', 'link', 'drive_link', 
            'google_drive', 'resume_link', 'resume link', 'cv_url', 'cv_link',
            'document_url', 'doc_url', 'file_url', 'resumeurl', 'resumelink',
            'portfolio link', 'portfolio_link'
        ];
        
        excelData.forEach((row, index) => {
            let resumeUrl = null;
            let candidateName = null;
            let email = null;
            let phone = null;
            

            
            // Find URL column (case-insensitive)
            for (const pattern of urlPatterns) {
                const variations = [pattern, pattern.toUpperCase(), pattern.toLowerCase()];
                for (const variation of variations) {
                    const value = row[variation];
                    if (value && typeof value === 'string') {
                        if (this.isValidUrl(value)) {
                            resumeUrl = value.trim();
                            break;
                        }
                    }
                }
                if (resumeUrl) break;
            }
            
            // If no URL found in standard patterns, check all columns for URLs
            if (!resumeUrl) {
                for (const [key, value] of Object.entries(row)) {
                    if (value && typeof value === 'string' && this.isValidUrl(value)) {
                        resumeUrl = value.trim();
                        break;
                    }
                }
            }
            
            // Enhanced fallback: if no resume URL found yet, try ANY URL in the row that might be a document
            if (!resumeUrl) {
                for (const [key, value] of Object.entries(row)) {
                    if (value && typeof value === 'string') {
                        // Check if it's a URL
                        if (/^https?:\/\//i.test(value)) {
                            // Prioritize links that look like documents
                            if (/\.(pdf|doc|docx)(\?|$)/i.test(value) || 
                                value.includes('drive.google.com') || 
                                value.includes('dropbox.com') || 
                                value.includes('onedrive.com') ||
                                value.includes('sharepoint.com')) {
                                resumeUrl = value.trim();
                                break;
                            }
                        }
                    }
                }
            }
            
            // Find candidate information
            const namePatterns = ['name','candidate','candidate_name','full_name','applicant','applicant_name','first_name','last_name','fname','lname'];
            const normalizedKey = (k) => k.toString().toLowerCase().replace(/[^a-z]/g,'');
            for (const [key,value] of Object.entries(row)) {
                if (!value) continue;
                const nk = normalizedKey(key);
                if (namePatterns.some(p => nk === p.replace(/[^a-z]/g,''))) {
                    candidateName = value.toString().trim();
                    break;
                }
                // Compound keys like "Candidate Name" -> candidate + name
                if (!candidateName && /candidate.*name|name.*candidate/.test(key.toLowerCase())) {
                    candidateName = value.toString().trim();
                }
            }
            
            // Find email (column hints), else scan entire row with robust parser
            const emailPatterns = ['email', 'email_address', 'mail', 'candidate_email', 'primary_email'];
            for (const pattern of emailPatterns) {
                const variations = [pattern, pattern.toUpperCase(), pattern.toLowerCase()];
                for (const variation of variations) {
                    const val = row?.[variation];
                    if (val) {
                        const emails = contactParser.extractEmails(String(val));
                        const best = contactParser.pickBestEmail(emails);
                        if (best) { email = best; break; }
                    }
                }
                if (email) break;
            }
            if (!email) {
                const rowJoined = Object.values(row).filter(v => v != null).join(' ');
                const emails = contactParser.extractEmails(rowJoined);
                email = contactParser.pickBestEmail(emails);
            }
            
            // Find phone (column hints), else scan entire row with robust parser
            const phonePatterns = ['phone', 'phone_number', 'mobile', 'contact', 'telephone', 'tel'];
            for (const pattern of phonePatterns) {
                const variations = [pattern, pattern.toUpperCase(), pattern.toLowerCase()];
                for (const variation of variations) {
                    const val = row?.[variation];
                    if (val) {
                        const phones = contactParser.extractPhones(String(val));
                        const best = contactParser.pickBestPhone(phones);
                        if (best) { phone = best; break; }
                    }
                }
                if (phone) break;
            }
            if (!phone) {
                const rowJoined = Object.values(row).filter(v => v != null).join(' ');
                const phones = contactParser.extractPhones(rowJoined);
                phone = contactParser.pickBestPhone(phones);
            }
            
            // Fallback derive name from email if still missing
            if (!candidateName && email) {
                const base = email.split('@')[0];
                const parts = base.split(/[._-]+/).filter(Boolean);
                if (parts.length) {
                    candidateName = parts.map(p => p.charAt(0).toUpperCase()+p.slice(1)).join(' ');
                }
            }
            // Fallback derive from URL filename
            if (!candidateName && resumeUrl) {
                try {
                    const pathname = new URL(resumeUrl).pathname;
                    const fileBase = path.basename(pathname).replace(/\.[a-z0-9]+$/i,'');
                    if (fileBase && fileBase.length < 80) {
                        const cleaned = fileBase.replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim();
                        if (/[a-z]/i.test(cleaned)) candidateName = cleaned.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
                    }
                } catch(e) { /* ignore */ }
            }
            // Add to results if URL is valid and unique
            if (resumeUrl) {
                const canonicalKey = this.canonicalizeResumeUrl(resumeUrl);
                // Check duplicates across historical sources
                const existing = this.findSourceStmt.get(canonicalKey);
                if (existing) {
                    // Existing candidate for this canonical URL
                    const existingId = existing.candidate_id;
                    // Try to enrich candidate fields if we have better info from this row
                    const current = this.getCandidateByIdStmt.get(existingId);
                    const updates = { id: existingId };
                    const betterName = this._chooseBetterName(current?.name, candidateName);
                    if (betterName) updates.name = betterName;
                    if (email && (!current?.email || current.email.length < 5)) updates.email = email;
                    if (phone && (!current?.phone || current.phone.length < 7)) updates.phone = phone;
                    if (updates.name || updates.email || updates.phone) {
                        try { this.updateCandidatePartialStmt.run(updates); } catch (e) { /* ignore */ }
                    }
                    // If no resume exists yet for this candidate, enqueue for processing using this URL
                    const hasResume = this.countResumesForCandidateStmt.get(existingId)?.cnt > 0;
                    if (!hasResume) {
                        resumeData.push({
                            candidateId: existingId,
                            resumeUrl,
                            name: updates.name || current?.name || candidateName || `Candidate ${index + 1}`,
                            email: updates.email || current?.email || email,
                            phone: updates.phone || current?.phone || phone
                        });
                    }
                    return; // handled existing
                }
                if (!seenUrls.has(canonicalKey)) {
                    seenUrls.add(canonicalKey);
                    const candidateResult = this.insertCandidateStmt.run(
                        candidateName || `Candidate ${index + 1}`,
                        email,
                        phone,
                        resumeUrl
                    );
                    // Track source mapping
                    this.insertSourceStmt.run(candidateResult.lastInsertRowid, resumeUrl, canonicalKey);
                    resumeData.push({
                        candidateId: candidateResult.lastInsertRowid,
                        resumeUrl: resumeUrl,
                        name: candidateName || `Candidate ${index + 1}`,
                        email: email,
                        phone: phone
                    });
                }
            }
        });
        
        console.log(`Found ${resumeData.length} unique resume URLs`);
        return resumeData;
    }

    /**
     * Enhanced variant returning detailed stats while reusing core logic.
     * This does NOT change external side-effects (still inserts candidates) but
     * supplies granular duplicate metrics for multi-file aggregation.
     * @param {Array<Object>} excelData
     * @returns {{candidates: Array, stats: {attempted:number, inserted:number, duplicate_existing:number, duplicate_in_file:number, invalid:number}}}
     */
    findUniqueResumeUrlsWithStats(excelData) {
        const seenInThisFile = new Set();
        const candidates = [];
        const stats = { attempted: 0, inserted: 0, duplicate_existing: 0, duplicate_in_file: 0, invalid: 0 };
        if (!Array.isArray(excelData) || excelData.length === 0) return { candidates, stats };

        const urlPatterns = [
            'resume_url', 'url', 'resume', 'link', 'drive_link',
            'google_drive', 'resume_link', 'cv_url', 'cv_link',
            'document_url', 'doc_url', 'file_url', 'resumeurl', 'resumelink'
        ];

        excelData.forEach((row, index) => {
            stats.attempted++;
            let resumeUrl = null;
            // Column scan similar to legacy method
            for (const pattern of urlPatterns) {
                const variations = [pattern, pattern.toUpperCase(), pattern.toLowerCase()];
                for (const variation of variations) {
                    const value = row?.[variation];
                    if (value && typeof value === 'string' && this.isValidUrl(value)) {
                        resumeUrl = value.trim();
                        break;
                    }
                }
                if (resumeUrl) break;
            }
            if (!resumeUrl) {
                for (const [k, v] of Object.entries(row)) {
                    if (v && typeof v === 'string' && this.isValidUrl(v)) { resumeUrl = v.trim(); break; }
                }
            }
            if (!resumeUrl) { stats.invalid++; return; }
            const canonicalKey = this.canonicalizeResumeUrl(resumeUrl);
            if (seenInThisFile.has(canonicalKey)) { stats.duplicate_in_file++; return; }
            const existing = this.findSourceStmt.get(canonicalKey);
            if (existing) { stats.duplicate_existing++; return; }
            // Re-run rich extraction using legacy method on a single row for consistency
            const inserted = this.findUniqueResumeUrls([row]);
            if (inserted.length) {
                candidates.push(...inserted);
                seenInThisFile.add(canonicalKey);
                stats.inserted++;
            }
        });
        return { candidates, stats };
    }

    // Add a candidate for a local PDF (bulk file ingestion)
    addLocalPdfCandidate({ fileName, email=null, phone=null, localFilePath }) {
        const displayName = fileName.replace(/\.[a-z0-9]+$/i,'').replace(/[_-]+/g,' ').replace(/\s+/g,' ').trim();
        const name = displayName.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
        const resumeUrl = 'local:'+fileName;
        const canonicalKey = 'local:'+fileName.toLowerCase();
        // Duplicate check
        const existing = this.findSourceStmt.get(canonicalKey);
        if (existing) {
            return { duplicate:true, candidateId: existing.candidate_id };
        }
        const candidateResult = this.insertCandidateStmt.run(name, email, phone, resumeUrl);
        this.insertSourceStmt.run(candidateResult.lastInsertRowid, resumeUrl, canonicalKey);
        return { duplicate:false, candidateId: candidateResult.lastInsertRowid, name, resumeUrl, localFilePath };
    }
    
    // Validate URL format
    isValidUrl(string) {
        try {
            const url = new URL(string);
            // Accept HTTP/HTTPS URLs that are likely to be resume/document links
            if (!string.includes('http')) return false;
            
            // Accept known document hosting domains
            if (string.includes('drive.google.com') ||
                string.includes('dropbox.com') ||
                string.includes('onedrive.com') ||
                string.includes('sharepoint.com')) {
                return true;
            }
            
            // Accept URLs with document file extensions
            if (string.includes('.pdf') ||
                string.includes('.doc') ||
                string.includes('.docx')) {
                return true;
            }
            
            // Accept resume hosting platforms (like vit.neopat.ai and similar)
            if (url.pathname.includes('resume') || 
                url.pathname.includes('cv') ||
                url.search.includes('resume') ||
                url.search.includes('cv') ||
                url.hostname.includes('neopat') ||
                url.hostname.includes('resume') ||
                url.hostname.includes('portfolio')) {
                return true;
            }
            
            // Accept GitHub raw URLs
            if (string.includes('github.com') || 
                string.includes('raw.githubusercontent.com')) {
                return true;
            }
            
            return false;
        } catch (_) {
            return false;
        }
    }

    // Produce a canonical key for duplicate detection across sources
    canonicalizeResumeUrl(url) {
        try {
            const u = new URL(url.trim());
            // Normalize host and path
            let host = u.host.toLowerCase();
            // Special handling for Google Drive: extract file id
            if (host.includes('drive.google.com')) {
                const id = (url.match(/[-\w]{25,}/) || [])[0];
                if (id) return `gdrive:${id}`;
            }
            // Dropbox: strip dl param and trailing query noise
            if (host.includes('dropbox.com')) {
                const pathPart = u.pathname.replace(/\/+$/,'');
                return `dropbox:${pathPart.toLowerCase()}`;
            }
            // OneDrive short links
            if (host.includes('1drv.ms')) {
                return `onedrive:${u.pathname.toLowerCase()}`;
            }
            // Strip query params known to differ per share link
            u.searchParams.delete('usp');
            u.searchParams.delete('pli');
            u.searchParams.delete('authuser');
            u.searchParams.delete('utm_source');
            u.searchParams.delete('utm_medium');
            u.searchParams.delete('utm_campaign');
            // Sort remaining params for stability
            const orderedParams = [...u.searchParams.entries()].sort((a,b)=> a[0].localeCompare(b[0]));
            const paramStr = orderedParams.length ? '?' + orderedParams.map(p=> `${p[0]}=${p[1]}`).join('&') : '';
            let path = u.pathname.replace(/\/+/g, '/').replace(/\/+$/,'');
            return `${host}${path}${paramStr}`;
        } catch (e) {
            return url.trim().toLowerCase();
        }
    }
    
    _sanitizeEmbeddingText(text, maxLength = 12000) {
        if (!text || typeof text !== 'string') {
            return 'Empty job content placeholder';
        }

        // Replace control characters that often break external APIs
        let cleaned = text.replace(/[\u0000-\u001F\u007F]/g, ' ');
        // Collapse whitespace to keep prompts compact
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        if (cleaned.length === 0) {
            return 'Empty job content placeholder';
        }

        if (cleaned.length > maxLength) {
            const headLen = Math.floor(maxLength * 0.7);
            const tailLen = maxLength - headLen;
            const head = cleaned.slice(0, headLen);
            const tail = cleaned.slice(-tailLen);
            cleaned = `${head}\n...\n${tail}`;
        }

        return cleaned;
    }

    // Analyze job description and rank candidates with algorithm selection
    async analyzeAndRank(jobData, pipeline, limit = 50, modelName = 'unknown') {
        console.log('Starting candidate analysis and ranking...');
        
        const { 
            jobTitle, 
            keySkills, 
            algorithm = 'cosine', 
            minkowskiP = 2,
            // Legacy support for existing format
            jobDescription, 
            jobRequirements 
        } = jobData;
        
        // Build job text - prioritize new simplified format, fallback to legacy
        // Validate job data to prevent null jobs
        if (!jobTitle || typeof jobTitle !== 'string' || jobTitle.trim().length === 0) {
            throw new Error('Job title is required and cannot be empty');
        }
        
        if (!keySkills && !jobDescription && !jobRequirements) {
            throw new Error('At least one of keySkills, jobDescription, or jobRequirements must be provided');
        }
        
        // Clean job title to prevent null entries
        const cleanJobTitle = jobTitle.trim();
        const cleanKeySkills = keySkills ? keySkills.trim() : '';
        
        let jobText;
        if (cleanKeySkills) {
            // New simplified format: role name + key skills
            // Wrap in query-style context to ensure proper embedding treatment
            jobText = `Find candidates for the following position:\n\nJob Title: ${cleanJobTitle}\n\nRequired Skills: ${cleanKeySkills}`;
        } else {
            // Legacy format for backward compatibility
            // Wrap in query-style context
            const legacyContent = [cleanJobTitle, jobDescription, jobRequirements]
                .filter(text => text && typeof text === 'string' && text.trim().length > 0)
                .join('\n\n');
            jobText = `Find candidates for the following position:\n\n${legacyContent}`;
        }
        
        // Final validation of job text
        if (!jobText || jobText.trim().length === 0) {
            throw new Error('Job text cannot be empty after processing');
        }
        
    const sanitizedJobText = this._sanitizeEmbeddingText(jobText);
    console.log(`Job text sanitized length: ${sanitizedJobText.length}`);
        
        console.log(`Generating job embedding for algorithm: ${algorithm}...`);
        
        try {
            // Generate job embedding with proper error handling
            let jobOutput;
            let jobEmbedding;
            
            try {
                jobOutput = await pipeline([sanitizedJobText], { pooling: 'mean', normalize: true });
                
                if (!jobOutput || !jobOutput.data) {
                    throw new Error('Pipeline returned invalid output structure');
                }
                
                if (Array.isArray(jobOutput.data) && jobOutput.data.length > 0) {
                    // If data is an array of embeddings, take the first one
                    jobEmbedding = jobOutput.data[0];
                } else {
                    // If data is a single embedding
                    jobEmbedding = jobOutput.data;
                }
                
                // Ensure it's a Float32Array
                if (!(jobEmbedding instanceof Float32Array)) {
                    jobEmbedding = new Float32Array(jobEmbedding);
                }
                
                // Validate job embedding quality
                const jobEmbeddingArray = Array.from(jobEmbedding);
                
                // Check for all-zero embeddings
                const hasNonZero = jobEmbeddingArray.some(val => val !== 0);
                if (!hasNonZero) {
                    console.warn('⚠️ Warning: All-zero job embedding detected - may affect similarity scores');
                }
                
                // Check for invalid values
                const hasInvalidValues = jobEmbeddingArray.some(val => !isFinite(val));
                if (hasInvalidValues) {
                    throw new Error('Invalid job embedding values (NaN/Infinity) detected');
                }
                
                // Check embedding magnitude
                const magnitude = Math.sqrt(jobEmbeddingArray.reduce((sum, val) => sum + val * val, 0));
                if (magnitude < 0.001) {
                    console.warn(`⚠️ Warning: Very small job embedding magnitude (${magnitude.toFixed(6)})`);
                }
                

            } catch (embeddingError) {
                console.error('Error generating job embedding:', embeddingError);
                // Try with shorter text if the error might be due to text length
                const shorterJobText = this._sanitizeEmbeddingText(sanitizedJobText.slice(0, 5000), 5000);
                console.warn(`Retrying job embedding with truncated text length: ${shorterJobText.length}`);

                jobOutput = await pipeline([shorterJobText], { pooling: 'mean', normalize: true });
                
                if (Array.isArray(jobOutput.data) && jobOutput.data.length > 0) {
                    jobEmbedding = jobOutput.data[0];
                } else {
                    jobEmbedding = jobOutput.data;
                }
                
                if (!(jobEmbedding instanceof Float32Array)) {
                    jobEmbedding = new Float32Array(jobEmbedding);
                }
                
                // Validate job embedding quality (fallback case)
                const jobEmbeddingArray = Array.from(jobEmbedding);
                const hasNonZero = jobEmbeddingArray.some(val => val !== 0);
                if (!hasNonZero) {
                    console.warn('⚠️ Warning: All-zero job embedding detected in fallback processing');
                }
                const hasInvalidValues = jobEmbeddingArray.some(val => !isFinite(val));
                if (hasInvalidValues) {
                    throw new Error('Invalid job embedding values in fallback processing');
                }
            }
            
            // Store job in database with both binary and JSON embeddings
            // Use cleaned values to prevent null entries
            const jobResult = this.insertJobStmt.run(
                cleanJobTitle,
                cleanKeySkills || jobDescription || '',
                `Algorithm: ${algorithm}${algorithm === 'minkowski' ? ` (p=${minkowskiP})` : ''}`,
                Buffer.from(jobEmbedding.buffer),
                JSON.stringify(Array.from(jobEmbedding))
            );
            
            const jobId = jobResult.lastInsertRowid;
            
            // Track model usage for compatibility checking
            modelCompatibilityChecker.trackModelUsage('job', modelName, jobId.toString());
            console.log(`🔍 Tracked job ${jobId} using model: ${modelName}`);
            

            
            // Use sqlite-vec for similarity search if available, otherwise fallback
            if (this.vectorExtensionAvailable) {
                try {
                    // First check if we have any candidates with embeddings
                    const candidateCount = this.db.prepare(`
                        SELECT COUNT(*) as count 
                        FROM Resumes r 
                        JOIN Candidates c ON r.candidate_id = c.id 
                        WHERE r.embedding IS NOT NULL AND LENGTH(r.embedding) > 0
                    `).get();
                    
                    if (candidateCount.count === 0) {
                        console.log('No candidates have embeddings, returning empty result');
                        return { jobId, candidates: [] };
                    }
                    

                    
                    // Use appropriate sqlite-vec function based on selected algorithm
                    // NOTE: sqlite-vec supports (at minimum) cosine and L2. Others will fall back to manual.
                    const sqliteVecFunctions = {
                        cosine: 'vec_distance_cosine',
                        euclidean: 'vec_distance_L2',
                        // Some builds support L1; attempt and fall back if missing
                        manhattan: 'vec_distance_L1'
                    };

                    let vecFunction = sqliteVecFunctions[algorithm];

                    if (!vecFunction) {
                        console.log(`Algorithm ${algorithm} not supported by sqlite-vec, using fallback`);
                        throw new Error(`Unsupported algorithm for vector search: ${algorithm}`);
                    }

                    // Bind job embedding as a BLOB (Float32Array -> Uint8Array) for sqlite-vec
                    const jobEmbeddingBlob = new Uint8Array(jobEmbedding.buffer);
                    const jobEmbeddingByteLength = jobEmbeddingBlob.byteLength;

                    // Restrict to candidates with matching vector byte length to avoid errors
                    let searchQuery = `
                        SELECT r.*, c.name, c.email, c.phone, c.resume_url,
                               ${vecFunction}(r.embedding, ?) as distance
                        FROM Resumes r
                        JOIN Candidates c ON r.candidate_id = c.id
                        WHERE r.embedding IS NOT NULL
                          AND LENGTH(r.embedding) = ?
                        ORDER BY distance ASC
                        LIMIT ?
                    `;

                    let searchResults;
                    try {
                        searchResults = this.db.prepare(searchQuery).all(jobEmbeddingBlob, jobEmbeddingByteLength, limit);
                    } catch (vecError) {
                        console.log(`Vector function ${vecFunction} failed (${vecError?.message || vecError}), trying cosine as fallback...`);

                        // Try cosine as a universal fallback
                        vecFunction = 'vec_distance_cosine';
                        searchQuery = `
                            SELECT r.*, c.name, c.email, c.phone, c.resume_url,
                                   ${vecFunction}(r.embedding, ?) as distance
                            FROM Resumes r
                            JOIN Candidates c ON r.candidate_id = c.id
                            WHERE r.embedding IS NOT NULL
                              AND LENGTH(r.embedding) = ?
                            ORDER BY distance ASC
                            LIMIT ?
                        `;
                        try {
                            searchResults = this.db.prepare(searchQuery).all(jobEmbeddingBlob, jobEmbeddingByteLength, limit);
                        } catch (altError) {
                            throw new Error('No vector distance function available');
                        }
                    }

                    // Check model compatibility between job and candidates
                    const candidateIds = searchResults.map(result => result.candidate_id.toString());
                    modelCompatibilityChecker.checkModelCompatibility(jobId.toString(), candidateIds);
                    
                    // Get detailed candidate information
                    const candidates = [];
                    let rankPosition = 1;
                    
                    searchResults.forEach((result) => {
                        // Convert distance to similarity with metric-aware mapping
                        let d = Number(result.distance) || 0;
                        let similarity;
                        // sqlite-vec returns distances; for cosine it's cosine distance in [0,2] or [0,2)? Typically [0,2] with some impls but often [0,2) -> use 1-d for [0,1]
                        if (vecFunction === 'vec_distance_cosine') {
                            similarity = Math.max(0, 1 - d);
                        } else if (vecFunction === 'vec_distance_L2' || vecFunction === 'vec_distance_L1') {
                            similarity = 1 / (1 + Math.max(0, d));
                        } else {
                            // Fallback to safe mapping
                            similarity = 1 / (1 + Math.max(0, d));
                        }
                        
                        candidates.push({
                            candidate_id: result.candidate_id,
                            name: result.name,
                            email: result.email,
                            phone: result.phone,
                            content: result.content,
                            resume_url: result.resume_url,
                            local_file_path: result.local_file_path,
                            similarity_score: similarity,
                            rank_position: rankPosition
                        });
                        
                        // Store ranking in database
                        this.insertRankingStmt.run(
                            jobId,
                            result.candidate_id,
                            similarity,
                            rankPosition
                        );
                        
                        rankPosition++;
                    });
                    

                    return { jobId, candidates };
                    
                } catch (error) {
                    console.error('Vector search failed, falling back to manual calculation:', error);
                    const result = this.fallbackRanking(jobEmbedding, jobId, limit, algorithm, minkowskiP);
                    return { jobId, candidates: result, usedFallback: true, fallbackReason: 'Vector search failed' };
                }
            } else {
                console.log('Using fallback similarity calculation (vector extension not available)');
                const result = this.fallbackRanking(jobEmbedding, jobId, limit, algorithm, minkowskiP);
                return { jobId, candidates: result, usedFallback: true, fallbackReason: 'Vector extension not available' };
            }
        } catch (error) {
            console.error('Error in analyzeAndRank:', error);
            throw new Error(`Failed to analyze candidates: ${error.message}`);
        }
    }
    
    // Fallback ranking method using manual similarity calculations
    fallbackRanking(jobEmbedding, jobId, limit, algorithm = 'cosine', minkowskiP = 2) {
        console.log(`Using fallback ranking method with ${algorithm} algorithm...`);
        
        const resumeData = this.getResumesStmt.all();
        
        // Check model compatibility between job and candidates
        const candidateIds = resumeData.map(resume => resume.candidate_id.toString());
        modelCompatibilityChecker.checkModelCompatibility(jobId.toString(), candidateIds);
        
        const similarities = [];
        
        resumeData.forEach(resume => {
            let resumeEmbedding = null;
            
            // Try to get embedding from JSON first, then from BLOB
            if (resume.embedding_json) {
                try {
                    resumeEmbedding = JSON.parse(resume.embedding_json);
                } catch (error) {
                    console.log('Error parsing embedding JSON:', error.message);
                }
            }
            
            // Fallback to BLOB if JSON is not available
            if (!resumeEmbedding && resume.embedding) {
                // Correctly construct Float32Array view over Buffer
                try {
                    const buf = resume.embedding; // Buffer
                    const byteOffset = buf.byteOffset || 0;
                    const byteLength = buf.byteLength || buf.length;
                    // Create a view on the underlying ArrayBuffer using proper offsets
                    resumeEmbedding = new Float32Array(buf.buffer, buf.byteOffset || 0, Math.floor(byteLength / 4));
                } catch (_) {
                    // As a last resort, copy via Uint8Array then DataView
                    const b = Buffer.from(resume.embedding);
                    const f32 = new Float32Array(Math.floor(b.length / 4));
                    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
                    for (let i = 0; i < f32.length; i++) f32[i] = view.getFloat32(i * 4, true);
                    resumeEmbedding = f32;
                }
            }
            
            if (resumeEmbedding) {
                // Track candidate model usage for compatibility checking
                if (resume.embedding_model) {
                    modelCompatibilityChecker.trackModelUsage('candidate', resume.embedding_model, resume.candidate_id.toString());
                }
                
                // Ensure both vectors are arrays for comparison
                let jobVec = Array.isArray(jobEmbedding) ? jobEmbedding : Array.from(jobEmbedding);
                let resumeVec = Array.isArray(resumeEmbedding) ? resumeEmbedding : Array.from(resumeEmbedding);
                
                // Check for dimension mismatch - now requires same model for both
                if (jobVec.length !== resumeVec.length) {
                    console.warn(`🚨 DIMENSION MISMATCH: job=${jobVec.length}, resume=${resumeVec.length} for candidate ${resume.candidate_id}`);
                    console.warn(`This indicates different embedding models were used. Use the same model for both jobs and candidates.`);
                    console.log(`Skipping candidate ${resume.candidate_id}: incompatible embedding dimensions`);
                    return; // Skip this candidate
                }
                
                // Validate vectors before similarity calculation
                if (!Array.isArray(jobVec) || !Array.isArray(resumeVec) || jobVec.length === 0 || resumeVec.length === 0) {
                    console.warn(`Invalid vectors for candidate ${resume.candidate_id}, skipping`);
                    return;
                }
                
                // Check for NaN or infinite values in vectors
                const hasInvalidJobValues = jobVec.some(val => !isFinite(val));
                const hasInvalidResumeValues = resumeVec.some(val => !isFinite(val));
                
                if (hasInvalidJobValues || hasInvalidResumeValues) {
                    console.warn(`Invalid vector values detected for candidate ${resume.candidate_id}, skipping`);
                    return;
                }
                
                // Calculate similarity with aligned or matched vectors
                let similarity;
                try {
                    similarity = this.calculateSimilarity(jobVec, resumeVec, algorithm, minkowskiP);
                } catch (simError) {
                    console.error(`Similarity calculation failed for candidate ${resume.candidate_id}:`, simError.message);
                    return;
                }
                
                // Validate similarity score is within expected bounds
                if (!isFinite(similarity) || similarity < 0) {
                    console.warn(`Invalid similarity score ${similarity} for candidate ${resume.candidate_id}, setting to 0`);
                    similarity = 0;
                } else if (similarity > 1) {
                    console.warn(`Similarity score ${similarity} > 1 for candidate ${resume.candidate_id}, capping at 1`);
                    similarity = 1;
                }
                
                // Additional check: if similarity is suspiciously close to 1 (99.9%+), log for review
                if (similarity >= 0.999) {
                    console.log(`⚠️ Very high similarity (${(similarity * 100).toFixed(2)}%) detected for candidate ${resume.candidate_id} with algorithm ${algorithm}`);
                }
                
                similarities.push({
                    candidate_id: resume.candidate_id,
                    name: resume.name,
                    email: resume.email,
                    phone: resume.phone,
                    content: resume.content,
                    resume_url: resume.resume_url,
                    local_file_path: resume.local_file_path,
                    similarity_score: similarity,
                    aligned: jobVec.length !== (Array.isArray(jobEmbedding) ? jobEmbedding : Array.from(jobEmbedding)).length,
                    algorithm_used: algorithm
                });
            }
        });
        
        // Analyze similarity distribution to detect potential issues
        this.analyzeSimilarityDistribution(similarities, algorithm);
        
        // Sort by similarity (descending)
        similarities.sort((a, b) => b.similarity_score - a.similarity_score);
        
        // Detect and log potential outliers before ranking
        this.detectSimilarityOutliers(similarities, algorithm);
        
        // Take top results and add ranking
        const topCandidates = similarities.slice(0, limit).map((candidate, index) => {
            const rankPosition = index + 1;
            
            // Store ranking in database
            this.insertRankingStmt.run(
                jobId,
                candidate.candidate_id,
                candidate.similarity_score,
                rankPosition
            );
            
            return {
                ...candidate,
                rank_position: rankPosition
            };
        });
        
        console.log(`Fallback ranking completed: ${topCandidates.length} candidates ranked using ${algorithm} algorithm`);
        
        // Log final ranking summary
        if (topCandidates.length > 0) {
            const topScore = topCandidates[0].similarity_score;
            const avgScore = topCandidates.reduce((sum, c) => sum + c.similarity_score, 0) / topCandidates.length;
            console.log(`📊 Ranking summary - Top: ${(topScore * 100).toFixed(2)}%, Average: ${(avgScore * 100).toFixed(2)}%`);
        }

        return topCandidates;
    }
    
    // Calculate similarity using the specified algorithm
    // Optimized for resume-to-job matching with semantic embeddings
    calculateSimilarity(vecA, vecB, algorithm = 'cosine', minkowskiP = 2) {
        if (vecA.length !== vecB.length) {
            throw new Error(`Vectors must have the same length: vecA=${vecA.length}, vecB=${vecB.length}`);
        }
        
        // Pre-validation of input vectors
        if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0) {
            throw new Error('Invalid input vectors for similarity calculation');
        }
        
        let similarity;
        
        switch (algorithm) {
            case 'cosine':
                // RECOMMENDED: Best for semantic embeddings, ignores document length
                similarity = this.cosineSimilarity(vecA, vecB);
                break;
            case 'euclidean':
                // Strict matching: More sensitive to exact skill combinations
                similarity = this.euclideanSimilarity(vecA, vecB);
                break;
            case 'pearson':
                // Pattern matching: Finds similar skill development patterns
                similarity = this.pearsonSimilarity(vecA, vecB);
                break;
            case 'manhattan':
                // Outlier resistant: Good for diverse skill sets
                similarity = this.manhattanSimilarity(vecA, vecB);
                break;
            case 'dot_product':
                // Map dot product of (possibly normalized) vectors to [0,1]
                similarity = this.dotProductSimilarity(vecA, vecB);
                break;
            case 'minkowski':
                similarity = this.minkowskiSimilarity(vecA, vecB, minkowskiP);
                break;
            case 'jaccard':
                similarity = this.jaccardSimilarity(vecA, vecB);
                break;
            case 'hamming':
                similarity = this.hammingSimilarity(vecA, vecB);
                break;
            case 'chebyshev':
                similarity = this.chebyshevSimilarity(vecA, vecB);
                break;
            default:
                console.warn(`Unknown algorithm ${algorithm}, falling back to cosine similarity (recommended for resume matching)`);
                similarity = this.cosineSimilarity(vecA, vecB);
        }
        
        // Final validation of similarity score
        return this.validateSimilarityScore(similarity, algorithm);
    }
    
    // Validate and normalize similarity scores to prevent false matches
    validateSimilarityScore(similarity, algorithm) {
        if (!isFinite(similarity)) {
            console.warn(`Non-finite similarity score from ${algorithm} algorithm: ${similarity}`);
            return 0;
        }
        
        if (similarity < 0) {
            console.warn(`Negative similarity score from ${algorithm} algorithm: ${similarity}, setting to 0`);
            return 0;
        }
        
        if (similarity > 1) {
            console.warn(`Similarity score > 1 from ${algorithm} algorithm: ${similarity}, capping at 1`);
            return 1;
        }
        
        return similarity;
    }

    // Calculate cosine similarity between two vectors
    // OPTIMAL FOR RESUME MATCHING: Measures angle between vectors, ignoring magnitude
    // This means resume length doesn't affect similarity - focuses purely on semantic content
    cosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < vecA.length; i++) {
            const a = Number(vecA[i]) || 0;
            const b = Number(vecB[i]) || 0;
            dotProduct += a * b;
            normA += a * a;
            normB += b * b;
        }
        
        // Prevent division by zero and invalid similarity scores
        if (normA === 0 || normB === 0 || !isFinite(normA) || !isFinite(normB)) {
            console.warn('Invalid vector norms detected in cosine similarity');
            return 0;
        }
        
        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        if (denominator === 0 || !isFinite(denominator)) {
            console.warn('Invalid denominator in cosine similarity calculation');
            return 0;
        }
        
        const similarity = dotProduct / denominator;
        
        // Ensure similarity is within valid bounds [-1, 1]
        if (!isFinite(similarity) || similarity > 1 || similarity < -1) {
            console.warn(`Invalid cosine similarity calculated: ${similarity}, returning 0`);
            return 0;
        }
        
        // For resume matching, negative similarity doesn't make practical sense
        // Convert to 0-1 range where 0 is orthogonal and 1 is identical
        return Math.max(0, similarity);
    }

    // Calculate Euclidean similarity (converted from distance)
    euclideanSimilarity(vecA, vecB) {
        let sumSquares = 0;
        for (let i = 0; i < vecA.length; i++) {
            const a = Number(vecA[i]) || 0;
            const b = Number(vecB[i]) || 0;
            const diff = a - b;
            sumSquares += diff * diff;
        }
        
        if (!isFinite(sumSquares) || sumSquares < 0) {
            console.warn('Invalid sum of squares in euclidean similarity');
            return 0;
        }
        
        const distance = Math.sqrt(sumSquares);
        if (!isFinite(distance)) {
            console.warn('Invalid distance in euclidean similarity');
            return 0;
        }
        
        // Convert distance to similarity: 1 / (1 + distance)
        // This ensures similarity is always between 0 and 1
        const similarity = 1 / (1 + distance);
        
        if (!isFinite(similarity) || similarity < 0 || similarity > 1) {
            console.warn(`Invalid euclidean similarity: ${similarity}, returning 0`);
            return 0;
        }
        
        return similarity;
    }

    // Calculate Manhattan similarity (converted from distance)
    manhattanSimilarity(vecA, vecB) {
        let sum = 0;
        for (let i = 0; i < vecA.length; i++) {
            const a = Number(vecA[i]) || 0;
            const b = Number(vecB[i]) || 0;
            sum += Math.abs(a - b);
        }
        
        if (!isFinite(sum) || sum < 0) {
            console.warn('Invalid Manhattan distance calculated');
            return 0;
        }
        
        // Convert distance to similarity: 1 / (1 + distance)
        const similarity = 1 / (1 + sum);
        
        if (!isFinite(similarity) || similarity < 0 || similarity > 1) {
            console.warn(`Invalid Manhattan similarity: ${similarity}, returning 0`);
            return 0;
        }
        
        return similarity;
    }

    // Calculate Jaccard similarity for continuous vectors
    jaccardSimilarity(vecA, vecB) {
        let minSum = 0;
        let maxSum = 0;
        for (let i = 0; i < vecA.length; i++) {
            minSum += Math.min(vecA[i], vecB[i]);
            maxSum += Math.max(vecA[i], vecB[i]);
        }
        return maxSum === 0 ? 0 : minSum / maxSum;
    }

    // Calculate dot product similarity mapped to [0,1]
    dotProductSimilarity(vecA, vecB) {
        // Compute cosine-like value = dot / (||a||*||b||)
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < vecA.length; i++) {
            const a = Number(vecA[i]) || 0;
            const b = Number(vecB[i]) || 0;
            dot += a * b;
            na += a * a;
            nb += b * b;
        }
        if (na === 0 || nb === 0 || !isFinite(na) || !isFinite(nb)) {
            console.warn('Invalid norms in dotProductSimilarity');
            return 0;
        }
        const denom = Math.sqrt(na) * Math.sqrt(nb);
        if (denom === 0 || !isFinite(denom)) return 0;
        let cos = dot / denom;
        if (!isFinite(cos)) cos = 0;
        // Map from [-1,1] to [0,1]
        const sim = (cos + 1) / 2;
        return Math.max(0, Math.min(1, sim));
    }

    // Calculate Pearson correlation coefficient
    pearsonSimilarity(vecA, vecB) {
        const n = vecA.length;
        let sumA = 0, sumB = 0;
        
        for (let i = 0; i < n; i++) {
            const a = Number(vecA[i]) || 0;
            const b = Number(vecB[i]) || 0;
            sumA += a;
            sumB += b;
        }
        
        const meanA = sumA / n;
        const meanB = sumB / n;
        
        if (!isFinite(meanA) || !isFinite(meanB)) {
            console.warn('Invalid means in Pearson correlation');
            return 0;
        }
        
        let numerator = 0, denomA = 0, denomB = 0;
        for (let i = 0; i < n; i++) {
            const a = Number(vecA[i]) || 0;
            const b = Number(vecB[i]) || 0;
            const diffA = a - meanA;
            const diffB = b - meanB;
            numerator += diffA * diffB;
            denomA += diffA * diffA;
            denomB += diffB * diffB;
        }
        
        if (!isFinite(numerator) || !isFinite(denomA) || !isFinite(denomB)) {
            console.warn('Invalid values in Pearson correlation calculation');
            return 0;
        }
        
        if (denomA === 0 || denomB === 0) {
            console.warn('Zero variance detected in Pearson correlation');
            return 0;
        }
        
        const denominator = Math.sqrt(denomA * denomB);
        if (denominator === 0 || !isFinite(denominator)) {
            console.warn('Invalid denominator in Pearson correlation');
            return 0;
        }
        
        const correlation = numerator / denominator;
        
        if (!isFinite(correlation) || correlation > 1 || correlation < -1) {
            console.warn(`Invalid Pearson correlation: ${correlation}, returning 0`);
            return 0;
        }
        
        // Convert correlation (-1..1) to similarity (0..1)
        return Math.max(0, Math.min(1, (correlation + 1) / 2));
    }

    // Calculate Spearman rank correlation
    spearmanSimilarity(vecA, vecB) {
        // Create rank arrays
        const rankA = this.getRanks(vecA);
        const rankB = this.getRanks(vecB);
        // Use Pearson correlation on ranks
        return this.pearsonSimilarity(rankA, rankB);
    }

    // Helper method to calculate ranks
    getRanks(vector) {
        const indexed = vector.map((val, idx) => ({ val, idx }));
        indexed.sort((a, b) => b.val - a.val); // Sort descending
        const ranks = new Array(vector.length);
        for (let i = 0; i < indexed.length; i++) {
            ranks[indexed[i].idx] = i + 1;
        }
        return ranks;
    }

    // Calculate Minkowski similarity (converted from distance)
    minkowskiSimilarity(vecA, vecB, p = 2) {
        let sum = 0;
        for (let i = 0; i < vecA.length; i++) {
            sum += Math.pow(Math.abs(vecA[i] - vecB[i]), p);
        }
        const distance = Math.pow(sum, 1 / p);
        // Convert distance to similarity: 1 / (1 + distance)
        return 1 / (1 + distance);
    }

    // Calculate Hamming similarity (for binary-like vectors)
    hammingSimilarity(vecA, vecB) {
        let matches = 0;
        for (let i = 0; i < vecA.length; i++) {
            // Threshold continuous values to binary for Hamming
            const binA = vecA[i] > 0.5 ? 1 : 0;
            const binB = vecB[i] > 0.5 ? 1 : 0;
            if (binA === binB) matches++;
        }
        return matches / vecA.length;
    }

    // Calculate Chebyshev similarity (converted from distance)
    chebyshevSimilarity(vecA, vecB) {
        let maxDiff = 0;
        for (let i = 0; i < vecA.length; i++) {
            const diff = Math.abs(vecA[i] - vecB[i]);
            if (diff > maxDiff) maxDiff = diff;
        }
        // Convert distance to similarity: 1 / (1 + distance)
        return 1 / (1 + maxDiff);
    }
    
    // Get analysis statistics
    getAnalysisStats(jobId) {
        const stats = this.db.prepare(`
            SELECT 
                COUNT(*) as total_candidates,
                AVG(similarity_score) as avg_similarity,
                MAX(similarity_score) as max_similarity,
                MIN(similarity_score) as min_similarity
            FROM Rankings
            WHERE job_id = ?
        `).get(jobId);
        
        return stats;
    }
    
    // Clean up old data
    cleanupOldAnalyses(daysOld = 30) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysOld);
        
        const deleteOldJobs = this.db.prepare(`
            DELETE FROM Jobs 
            WHERE created_at < ?
        `);
        
        const deleteOldRankings = this.db.prepare(`
            DELETE FROM Rankings 
            WHERE created_at < ?
        `);
        
        const jobsDeleted = deleteOldJobs.run(cutoffDate.toISOString()).changes;
        const rankingsDeleted = deleteOldRankings.run(cutoffDate.toISOString()).changes;
        
        console.log(`Cleaned up ${jobsDeleted} old jobs and ${rankingsDeleted} old rankings`);
        
        return { jobsDeleted, rankingsDeleted };
    }
    
    // Analyze similarity score distribution to detect anomalies
    analyzeSimilarityDistribution(similarities, algorithm) {
        if (similarities.length === 0) return;
        
        const scores = similarities.map(s => s.similarity_score).sort((a, b) => b - a);
        const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
        const median = scores[Math.floor(scores.length / 2)];
        const max = scores[0];
        const min = scores[scores.length - 1];
        
        // Calculate standard deviation
        const variance = scores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) / scores.length;
        const stdDev = Math.sqrt(variance);
        
        console.log(`📈 Similarity distribution (${algorithm}): Mean=${(mean * 100).toFixed(2)}%, Median=${(median * 100).toFixed(2)}%, StdDev=${(stdDev * 100).toFixed(2)}%`);
        console.log(`📊 Score range: ${(min * 100).toFixed(2)}% to ${(max * 100).toFixed(2)}%`);
        
        // Flag suspicious distributions per business rule (>= 98% is a true outlier to be filtered in UI)
        if (max >= UI_OUTLIER_THRESHOLD) {
            console.warn(`⚠️ Suspiciously high max similarity (>= 98%): ${(max * 100).toFixed(2)}% — these are filtered in the UI`);
        }
        
        if (stdDev < 0.01 && similarities.length > 5) {
            console.warn(`⚠️ Very low score variance (${(stdDev * 100).toFixed(2)}%) suggests potential calculation issue`);
        }
        
        // Count matches by landmarks (info only)
        const suspiciousHigh = scores.filter(s => s >= UI_OUTLIER_THRESHOLD).length;
        const veryHigh = scores.filter(s => s >= 0.95 && s < UI_OUTLIER_THRESHOLD).length;
        const high = scores.filter(s => s >= 0.90 && s < 0.95).length;

        if (suspiciousHigh > 0) {
            console.warn(`🚩 ${suspiciousHigh} candidates at or above 98% (will be filtered by UI)`);
        }
        if (veryHigh > 0) {
            console.log(`📈 ${veryHigh} candidates in 95–98% range (kept)`);
        }
        if (high > 0) {
            console.log(`📈 ${high} candidates in 90–95% range (kept)`);
        }
    }
    
    // Detect outlier similarity scores that might indicate calculation errors
    // NOTE: This is diagnostic logging only. Filtering is handled by the UI (>= 98%).
    detectSimilarityOutliers(similarities, algorithm) {
        const thresholds = computeOutlierThresholds(similarities);
        if (!thresholds) return;

        const { upperThreshold, lowerThreshold } = thresholds;
        
        const suspiciousHigh = similarities.filter(s => s.similarity_score >= UI_OUTLIER_THRESHOLD);
        const statHigh = similarities.filter(s => s.similarity_score > upperThreshold && s.similarity_score < UI_OUTLIER_THRESHOLD);
        const statLow = similarities.filter(s => s.similarity_score < lowerThreshold);

        if (suspiciousHigh.length > 0) {
            console.warn(`🚩 Detected ${suspiciousHigh.length} suspicious high outliers (>= 98%) — these are filtered in the UI:`);
            suspiciousHigh.forEach(o => {
                console.warn(`  - Candidate ${o.candidate_id}: ${(o.similarity_score * 100).toFixed(2)}% (will be hidden in UI)`);
            });
        }
        if (statHigh.length > 0 || statLow.length > 0) {
            console.log(`📊 Detected ${statHigh.length + statLow.length} statistical outliers (not filtered; diagnostic only):`);
            statHigh.forEach(o => console.log(`  - Candidate ${o.candidate_id}: ${(o.similarity_score * 100).toFixed(2)}% (statistical high)`));
            statLow.forEach(o => console.log(`  - Candidate ${o.candidate_id}: ${(o.similarity_score * 100).toFixed(2)}% (statistical low)`));
        }
    }
    
    // Close database connection
    close() {
        this.db.close();
    }
}

module.exports = AnalysisEngine;
