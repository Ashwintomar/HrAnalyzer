// Worker Thread for Resume Processing
// Handles individual resume processing tasks

const { parentPort, workerData } = require('worker_threads');
const { loadPipeline } = require('../core/pipelineManager');
const { setEmbeddingConfig } = require('../core/embeddingConfig');
const contactParser = require('../core/contactParser');
const axios = require('axios');
const { Downloader } = require('nodejs-file-downloader');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const { getResumesDir } = require('../core/runtimePaths');



// Worker function for processing a single resume
async function processResume(data) {
    const { resumeUrl, candidateId, taskId, localFilePath: providedLocalPath, embeddingConfig } = data;

    try {
        // ** CRITICAL FIX **: Set the worker's config to match the main thread's config for this task
        if (embeddingConfig) {
            setEmbeddingConfig(embeddingConfig);
        }

        parentPort.postMessage({ type: 'progress', taskId, message: `Processing resume for candidate ${candidateId}...` });

        let resumeText = '';
        let localFilePath = '';
        const resumesDir = getResumesDir();
        if (!fs.existsSync(resumesDir)) fs.mkdirSync(resumesDir, { recursive: true });

    let fileBuffer;
    if (resumeUrl.startsWith('local:')) {
            // Local PDF provided by bulk ingest
            localFilePath = providedLocalPath || path.join(resumesDir, resumeUrl.slice('local:'.length));
            if (!localFilePath || !fs.existsSync(localFilePath)) {
                throw new Error(`Local file not found for candidate ${candidateId}`);
            }
            fileBuffer = fs.readFileSync(localFilePath);
            // Early HTML detection: if local file actually contains HTML, skip candidate
            try {
                const head = fileBuffer.toString('utf8', 0, Math.min(fileBuffer.length, 2048));
                if (/<\s*!DOCTYPE\s+html|<\s*html/i.test(head)) {
                    parentPort.postMessage({ type: 'progress', taskId, message: `HTML content detected in local file for candidate ${candidateId}. Skipping.` });
                    parentPort.postMessage({ type: 'skip', taskId, candidateId, reason: 'HTML content detected' });
                    return;
                }
            } catch (e) {
                // If decoding fails, continue; PDF parser will handle
            }
            // Guard: file too large -> skip or truncate to first N MB to avoid OOM
            const maxFileMB = parseInt(process.env.WORKER_MAX_FILE_MB || '25', 10); // 25MB default
            if (fileBuffer.length > maxFileMB * 1024 * 1024) {
                parentPort.postMessage({ type: 'progress', taskId, message: `File oversized (${(fileBuffer.length/1024/1024).toFixed(1)}MB) truncating to ${maxFileMB}MB` });
                fileBuffer = fileBuffer.slice(0, maxFileMB * 1024 * 1024);
            }
        } else {
            // --- Remote download branch ---
            const strategy = getDownloadStrategy(resumeUrl);
            
            switch (strategy) {
                case 'google_drive':
                    // Enhanced Google Drive download logic using direct download URL and nodejs-file-downloader
                    const fileId = extractGoogleDriveFileId(resumeUrl);
                    const directDownloadUrl = convertGoogleDriveToDirectUrl(resumeUrl);
                    const gdriveFileName = `candidate_${candidateId}_${fileId}.pdf`;
                    
                    parentPort.postMessage({ type: 'progress', taskId, message: `Downloading Google Drive file for candidate ${candidateId}...` });
                    
                    try {
                        const downloadResult = await downloadFileWithNodeDownloader(directDownloadUrl, resumesDir, gdriveFileName, taskId);
                        localFilePath = downloadResult.filePath;
                        fileBuffer = fs.readFileSync(localFilePath);
                    } catch (downloadError) {
                        // If direct download fails, the file might be too large or require confirmation
                        // For now, throw the error as Google Drive direct downloads should work for public files
                        parentPort.postMessage({ type: 'progress', taskId, message: `Google Drive download failed for candidate ${candidateId}: ${downloadError.message}` });
                        throw downloadError;
                    }
                    break;
                    
                case 'github_raw':
                    // Convert GitHub blob URL to raw URL for direct download
                    const rawUrl = convertToGitHubRawUrl(resumeUrl);
                    parentPort.postMessage({ type: 'progress', taskId, message: `Converting GitHub URL to raw format for candidate ${candidateId}: ${rawUrl}` });
                    
                    const rawUrlPath = new URL(rawUrl).pathname;
                    const rawFileExt = path.extname(rawUrlPath) || '.pdf';
                    const githubRawFileName = `candidate_${candidateId}_github${rawFileExt}`;
                    
                    try {
                        const downloadResult = await downloadFileWithNodeDownloader(rawUrl, resumesDir, githubRawFileName, taskId);
                        localFilePath = downloadResult.filePath;
                        fileBuffer = fs.readFileSync(localFilePath);
                        
                        // Check if we got HTML instead of PDF by reading first part of file
                        const fileStart = fileBuffer.toString('utf8', 0, 1000);
                        if (fileStart.includes('<!DOCTYPE html') || fileStart.includes('<html')) {
                            // Treat as skip per requirement (do not embed or insert)
                            parentPort.postMessage({ type: 'progress', taskId, message: `GitHub returned HTML page for candidate ${candidateId}. Skipping.` });
                            parentPort.postMessage({ type: 'skip', taskId, candidateId, reason: 'HTML content detected from GitHub' });
                            return;
                        }
                    } catch (downloadError) {
                        parentPort.postMessage({ type: 'progress', taskId, message: `GitHub raw download failed for candidate ${candidateId}: ${downloadError.message}` });
                        throw downloadError;
                    }
                    break;
                    
                case 'github_raw_direct':
                    // Direct download for already raw GitHub URLs using nodejs-file-downloader
                    const githubUrlPath = new URL(resumeUrl).pathname;
                    const githubFileExt = path.extname(githubUrlPath) || '.pdf';
                    const githubDirectFileName = `candidate_${candidateId}_resume${githubFileExt}`;
                    
                    try {
                        const downloadResult = await downloadFileWithNodeDownloader(resumeUrl, resumesDir, githubDirectFileName, taskId);
                        localFilePath = downloadResult.filePath;
                        fileBuffer = fs.readFileSync(localFilePath);
                        // Early HTML detection for direct raw GitHub URLs
                        const head = fileBuffer.toString('utf8', 0, Math.min(fileBuffer.length, 2048));
                        if (/<\s*!DOCTYPE\s+html|<\s*html/i.test(head)) {
                            parentPort.postMessage({ type: 'progress', taskId, message: `HTML content detected (GitHub raw) for candidate ${candidateId}. Skipping.` });
                            parentPort.postMessage({ type: 'skip', taskId, candidateId, reason: 'HTML content detected from GitHub raw' });
                            return;
                        }
                    } catch (downloadError) {
                        parentPort.postMessage({ type: 'progress', taskId, message: `GitHub direct download failed for candidate ${candidateId}: ${downloadError.message}` });
                        throw downloadError;
                    }
                    break;
                    
                case 'direct':
                default:
                    // Use nodejs-file-downloader for all other direct URLs
                    const originalUrlPath = new URL(resumeUrl).pathname;
                    const originalFileExt = path.extname(originalUrlPath) || '.pdf';
                    const directFileName = `candidate_${candidateId}_resume${originalFileExt}`;
                    
                    parentPort.postMessage({ type: 'progress', taskId, message: `Downloading file for candidate ${candidateId}...` });
                    
                    try {
                        const downloadResult = await downloadFileWithNodeDownloader(resumeUrl, resumesDir, directFileName, taskId);
                        localFilePath = downloadResult.filePath;
                        fileBuffer = fs.readFileSync(localFilePath);
                        // Early HTML detection for generic direct URLs
                        const head = fileBuffer.toString('utf8', 0, Math.min(fileBuffer.length, 2048));
                        if (/<\s*!DOCTYPE\s+html|<\s*html/i.test(head)) {
                            parentPort.postMessage({ type: 'progress', taskId, message: `HTML content detected (direct URL) for candidate ${candidateId}. Skipping.` });
                            parentPort.postMessage({ type: 'skip', taskId, candidateId, reason: 'HTML content detected from direct URL' });
                            return;
                        }
                    } catch (downloadError) {
                        // If nodejs-file-downloader fails, throw the error
                        parentPort.postMessage({ type: 'progress', taskId, message: `Download failed for candidate ${candidateId}: ${downloadError.message}` });
                        throw downloadError;
                    }
                    break;
            }
            
            // Ensure we have fileBuffer from downloaded file
            if (!fileBuffer) {
                fileBuffer = fs.readFileSync(localFilePath);
            }
            
            // Check file size and truncate if necessary
            const maxFileMB = parseInt(process.env.WORKER_MAX_FILE_MB || '25', 10);
            if (fileBuffer.length > maxFileMB * 1024 * 1024) {
                parentPort.postMessage({ type: 'progress', taskId, message: `Downloaded file oversized (${(fileBuffer.length/1024/1024).toFixed(1)}MB) truncating to ${maxFileMB}MB` });
                fileBuffer = fileBuffer.slice(0, maxFileMB * 1024 * 1024);
            }
        }

        // Robust content parsing: Try PDF first, then fall back to text.
        // This gracefully handles invalid PDFs and HTML pages served instead of PDFs.
        try {
            const pdfData = await pdf(fileBuffer);
            resumeText = pdfData.text || '';
            
            // For local files, attempt to extract candidate info from PDF text
            if (resumeUrl.startsWith('local:') && resumeText) {
                const extractedInfo = extractCandidateInfoFromText(resumeText);
                if (extractedInfo) {
                    parentPort.postMessage({ 
                        type: 'extracted_info', 
                        taskId, 
                        candidateId,
                        extractedInfo 
                    });
                }
            }
        } catch (parseErr) {
            parentPort.postMessage({ type: 'progress', taskId, message: `PDF parsing failed for candidate ${candidateId}. Falling back to raw text extraction.` });
            resumeText = fileBuffer.toString('utf8');
            // If it looks like HTML, clean it up
            if (/<!DOCTYPE html|<html/i.test(resumeText)) {
                // Per requirement: skip candidates with HTML content (no entry or embedding)
                parentPort.postMessage({ type: 'progress', taskId, message: `HTML content detected for candidate ${candidateId}. Skipping.` });
                parentPort.postMessage({ type: 'skip', taskId, candidateId, reason: 'HTML content detected' });
                return;
            }
        }

        resumeText = cleanText(resumeText);

            if (!resumeText || resumeText.length < 5) {
                parentPort.postMessage({ type: 'progress', taskId, message: `Warning: minimal content for candidate ${candidateId}, using placeholder.` });
                resumeText = 'Empty resume content placeholder';
            }
    parentPort.postMessage({ type: 'progress', taskId, message: `Waiting for embedding slot for candidate ${candidateId}...` });
    // Request an embedding permit from the main thread to increase parallelism while respecting shared limits
    const permit = await waitForEmbedPermit(taskId);
    parentPort.postMessage({ type: 'progress', taskId, message: `Generating embedding for candidate ${candidateId}...` });

    // Use the unified pipeline loader which respects the config
    const pipeline = await loadPipeline();
    // Use a unique workerId for rate limit scopes across workers
    const output = await pipeline([resumeText], { workerId: `worker-${process.pid}`, role: 'candidate', inputType: 'passage' });
        const embeddings = output.data; // The unified pipeline returns an object with a 'data' property
        const embedding = embeddings[0];

        // Validate embedding quality
        if (!embedding || !Array.isArray(embedding) && !(embedding instanceof Float32Array)) {
            throw new Error(`Invalid embedding format for candidate ${candidateId}`);
        }
        
        const embeddingArray = Array.from(embedding);
        
        // Check for all-zero embeddings (indicates API or processing issues)
        const hasNonZero = embeddingArray.some(val => val !== 0);
        if (!hasNonZero) {
            parentPort.postMessage({ 
                type: 'progress', 
                taskId, 
                message: `⚠️ Warning: All-zero embedding detected for candidate ${candidateId} - may affect similarity scores` 
            });
        }
        
        // Check for invalid values (NaN, Infinity)
        const hasInvalidValues = embeddingArray.some(val => !isFinite(val));
        if (hasInvalidValues) {
            throw new Error(`Invalid embedding values (NaN/Infinity) for candidate ${candidateId}`);
        }
        
        // Check embedding magnitude (very small magnitude might indicate issues)
        const magnitude = Math.sqrt(embeddingArray.reduce((sum, val) => sum + val * val, 0));
        if (magnitude < 0.001) {
            parentPort.postMessage({ 
                type: 'progress', 
                taskId, 
                message: `⚠️ Warning: Very small embedding magnitude (${magnitude.toFixed(6)}) for candidate ${candidateId}` 
            });
        }

        // Release big buffers early
        fileBuffer = null;

        parentPort.postMessage({
            type: 'success',
            taskId,
            result: {
                candidateId,
                content: resumeText,
                embedding: embeddingArray,
                localFilePath,
                originalUrl: resumeUrl,
                processedAt: new Date().toISOString()
            }
        });
        if (process.env.WORKER_MEMORY_LOG === '1') {
            const mu = process.memoryUsage();
            parentPort.postMessage({ type: 'progress', taskId, message: `Worker memory rss ${(mu.rss/1024/1024).toFixed(1)}MB heapUsed ${(mu.heapUsed/1024/1024).toFixed(1)}MB` });
        }
    } catch (error) {
        parentPort.postMessage({ type: 'error', taskId, error: error.message, candidateId });
    }
}

// Helper function to extract candidate information from resume text
function extractCandidateInfoFromText(text) {
    const info = {};
    const cleaned = contactParser.cleanObfuscations(text);

    // Extract emails
    const emails = contactParser.extractEmails(cleaned);
    const bestEmail = contactParser.pickBestEmail(emails);
    if (bestEmail) info.email = bestEmail;

    // Extract phones
    const phones = contactParser.extractPhones(text);
    const bestPhone = contactParser.pickBestPhone(phones);
    if (bestPhone) info.phone = bestPhone;

    // Extract name (heuristic: appears early; avoid all-caps blocks)
    const firstLines = cleaned.split('\n').slice(0, 8).join(' ');
    const beforeEmail = bestEmail ? cleaned.substring(0, cleaned.indexOf(bestEmail)) : firstLines;
    const nameMatch = beforeEmail.match(/^(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/m);
    if (nameMatch) {
        const candidateName = String(nameMatch[0]).trim();
        if (candidateName && candidateName.length >= 2 && candidateName.length <= 80) {
            info.name = candidateName;
        }
    }

    return Object.keys(info).length > 0 ? info : null;
}

// Helper function to extract Google Drive file ID
function extractGoogleDriveFileId(url) {
    const patterns = [
        /\/d\/([a-zA-Z0-9-_]+)/,
        /id=([a-zA-Z0-9-_]+)/,
        /file\/d\/([a-zA-Z0-9-_]+)/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
            return match[1];
        }
    }
    
    throw new Error('Could not extract Google Drive file ID from URL');
}

// Helper function to convert Google Drive shareable link to direct download URL
function convertGoogleDriveToDirectUrl(url) {
    if (!url.includes('drive.google.com')) {
        throw new Error('Not a Google Drive URL');
    }
    
    const fileId = extractGoogleDriveFileId(url);
    return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// Helper function to download file using nodejs-file-downloader with redirect-aware retries
async function downloadFileWithNodeDownloader(url, destDir, fileName, taskId) {
    const maxAttempts = 3;
    let currentUrl = url;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            currentUrl = await resolveDownloadUrl(currentUrl, taskId) || currentUrl;

            const downloader = new Downloader({
                url: currentUrl,
                directory: destDir,
                fileName: fileName,
                timeout: 90000,
                maxAttempts: 1,
                cloneFiles: false
            });

            const { filePath, downloadStatus } = await downloader.download();
            parentPort.postMessage({ type: 'progress', taskId, message: `Download status: ${downloadStatus}` });

            const redirectTarget = await extractRedirectFromHtml(filePath);
            if (redirectTarget && redirectTarget !== currentUrl) {
                currentUrl = redirectTarget;
                parentPort.postMessage({ type: 'progress', taskId, message: `Following redirect to ${currentUrl}` });
                await wait(500 * attempt);
                continue;
            }

            const nonEmpty = await ensureFileHasContent(filePath);
            if (!nonEmpty) {
                if (attempt === maxAttempts) {
                    throw new Error('Downloaded file was empty after multiple attempts');
                }
                parentPort.postMessage({ type: 'progress', taskId, message: 'Empty response detected, retrying...' });
                await wait(700 * attempt);
                continue;
            }

            return { filePath, success: true };
        } catch (error) {
            if (attempt === maxAttempts) {
                parentPort.postMessage({ type: 'progress', taskId, message: `Download failed: ${error.message}` });
                throw error;
            }
            parentPort.postMessage({ type: 'progress', taskId, message: `Download attempt ${attempt} failed (${error.message}). Retrying...` });
            await wait(1000 * attempt);
        }
    }
}

// Helper function to convert GitHub blob URL to raw URL
function convertToGitHubRawUrl(url) {
    // Convert GitHub blob URLs to raw URLs for direct file download
    // From: https://github.com/user/repo/blob/branch/path/file.pdf
    // To: https://raw.githubusercontent.com/user/repo/branch/path/file.pdf
    
    const githubBlobPattern = /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/(.+)$/;
    const match = url.match(githubBlobPattern);
    
    if (match) {
        const [, username, repo, branchAndPath] = match;
        return `https://raw.githubusercontent.com/${username}/${repo}/${branchAndPath}`;
    }
    
    return url; // Return original URL if not a GitHub blob URL
}

// Helper function to detect URL type and get appropriate download method
function getDownloadStrategy(url) {
    if (url.includes('drive.google.com')) {
        return 'google_drive';
    } else if (url.includes('github.com') && url.includes('/blob/')) {
        return 'github_raw';
    } else if (url.includes('raw.githubusercontent.com')) {
        return 'github_raw_direct';
    }
    return 'direct';
}

// Helper function to clean text content and remove graphics/image artifacts
function cleanText(text) {
    if (!text || typeof text !== 'string') {
        return '';
    }
    
    // Remove common image/graphic artifacts that appear in PDFs
    let cleaned = text
        // Remove image placeholders and graphic artifacts
        .replace(/\b(image|img|figure|fig|photo|picture|graphic|chart|logo|icon)\s*\d*\b/gi, ' ')
        // Remove bracketed placeholders like [image], [figure: 1], [diagram]
        .replace(/\[(?:image|img|graphic|figure|diagram|chart|screenshot)[^\]]*\]/gi, ' ')
        // Remove common image file references (inline or on separate lines)
        .replace(/(?:[A-Za-z]:)?[\\\/]?[\w .-]+?\.(?:png|jpe?g|gif|svg|bmp|tiff?)(?:\?[\w=&.-]+)?/gi, ' ')
        .replace(/\b[\w.-]+\.(?:png|jpe?g|gif|svg|bmp|tiff?)\b/gi, ' ')
        // Remove base64 encoded content that might leak from images
        .replace(/data:image\/[a-zA-Z]*;base64,[a-zA-Z0-9+/=]+/g, ' ')
        // Remove font encoding artifacts
        .replace(/\/[A-Z]+\+[A-Za-z0-9]+/g, ' ')
        // Remove PDF metadata artifacts
        .replace(/\/Type\s*\/\w+|\/Subtype\s*\/\w+|\/Filter\s*\/\w+/g, ' ')
        // Remove color codes and formatting artifacts
        .replace(/rgb\(\d+,\s*\d+,\s*\d+\)|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}/g, ' ')
        // Remove resolution/dimension patterns
        .replace(/\b\d{2,5}\s?[x×]\s?\d{2,5}\b/g, ' ')
        .replace(/\b(width|height)\s*[:=]\s*\d{2,5}\b/gi, ' ')
        .replace(/\b\d{2,5}\s?(px|dpi)\b/gi, ' ')
        // Remove coordinate/positioning data
        .replace(/\b\d+(\.\d+)?\s+\d+(\.\d+)?\s+(m|l|c|h|v)\b/g, ' ')
        // Remove excessive punctuation that might come from graphics
        .replace(/[•▪▫▲►◆♦▼◀◆♠♣♥♦★☆✓✗✓×]+/g, ' ')
        // Remove repeated special characters that often come from table borders/graphics
        .replace(/[-_=+|\\\/]{4,}/g, ' ')
        // Remove "Figure 1:", "Diagram:", "Chart #2" labels
        .replace(/\b(figure|fig\.?|chart|diagram|table|graph|screenshot)\s*[:#]?\s*\w*/gi, ' ')
        // Remove font names and styling artifacts
        .replace(/\b(Arial|Times|Helvetica|Calibri|Verdana|Tahoma|Georgia|Impact|Comic Sans|Courier New)[-\w]*\b/gi, ' ')
        // Remove HTML entities that might have been decoded
        .replace(/&[a-zA-Z]+;|&#\d+;/g, ' ')
        // Replace multiple whitespace with single space
        .replace(/\s+/g, ' ')
        // Remove special characters except basic punctuation
        .replace(/[^\w\s.,;:!?()@#$%&*+-]/g, ' ')
        // Remove standalone numbers that might be from graphics positioning
        .replace(/\b\d{4,}\b/g, ' ')
        // Clean up any remaining multiple spaces
        .replace(/\s+/g, ' ')
        .trim();
    
    // Additional filtering for content that's likely from graphics/images
    const lines = cleaned.split(/\n|\.|\?|!/).filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        // Filter out lines that are likely graphic artifacts
        if (trimmed.length < 3) return false;
        if (/^\d+(\.\d+)?$/.test(trimmed)) return false; // Pure numbers
        if (/^[A-Z]{2,}$/.test(trimmed) && trimmed.length < 6) return false; // All caps short strings
        if (trimmed.split(' ').length < 2 && !/\w{4,}/.test(trimmed)) return false; // Very short non-words
        if (/(?:^|\s)(fig(?:\.|ure)?|diagram|chart|graph|screenshot)\b/i.test(trimmed)) return false; // figure-like labels
        if (/\b(?:png|jpe?g|gif|svg|bmp|tiff?)\b/i.test(trimmed)) return false; // image extensions in line
        if (/\b\d{2,5}\s?[x×]\s?\d{2,5}\b/.test(trimmed)) return false; // resolution specs
        // High non-word symbol ratio (e.g., table borders, ascii art)
        const nonWord = (trimmed.match(/[^A-Za-z0-9\s]/g) || []).length;
        if (nonWord / Math.max(1, trimmed.length) > 0.6 && !/[A-Za-z]{4,}/.test(trimmed)) return false;
        return true;
    });
    
    cleaned = lines.join('. ').trim();
    
    // Final length check - if content is suspiciously short after cleaning, it might be mostly graphics
    if (cleaned.length < 50) {
        console.warn('Resume content very short after cleaning - may contain mostly graphics');
    }
    
    return cleaned;
}

async function resolveDownloadUrl(url, taskId) {
    try {
        const response = await axios.head(url, {
            maxRedirects: 5,
            timeout: 10000,
            validateStatus: (status) => status >= 200 && status < 400
        });
        const finalUrl = response?.request?.res?.responseUrl;
        if (finalUrl && finalUrl !== url) {
            parentPort.postMessage({ type: 'progress', taskId, message: `Resolved redirect to ${finalUrl}` });
            return finalUrl;
        }
    } catch (err) {
        // Some sources do not support HEAD; fall back silently
    }
    return url;
}

async function extractRedirectFromHtml(filePath) {
    try {
        const buffer = await fs.promises.readFile(filePath);
        const head = buffer.toString('utf8', 0, Math.min(buffer.length, 8192));
        const metaMatch = head.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>]+)["']/i);
        if (metaMatch && metaMatch[1]) {
            return decodeHTML(metaMatch[1].trim());
        }
        const scriptMatch = head.match(/window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i);
        if (scriptMatch && scriptMatch[1]) {
            return scriptMatch[1].trim();
        }
    } catch (err) {
        // Ignore read errors
    }
    return null;
}

async function ensureFileHasContent(filePath) {
    try {
        const stats = await fs.promises.stat(filePath);
        return stats.size > 0;
    } catch (err) {
        return false;
    }
}

function decodeHTML(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Listen for messages from main thread
parentPort.on('message', (data) => {
    if (data.type === 'process') {
        processResume(data);
    } else if (data.type === 'embed-permit') {
        // Resolve any waiter for this taskId
        resolvePermit(data.taskId);
    }
});

// Signal that worker is ready
parentPort.postMessage({ type: 'ready' });

// --- Embedding permit utilities ---
const pendingPermitResolvers = new Map();
function waitForEmbedPermit(taskId) {
    // Ask parent for a permit and return a promise resolved when received
    parentPort.postMessage({ type: 'ready_to_embed', taskId });
    return new Promise((resolve) => {
        pendingPermitResolvers.set(taskId, resolve);
    });
}

function resolvePermit(taskId) {
    const resolver = pendingPermitResolvers.get(taskId);
    if (resolver) {
        pendingPermitResolvers.delete(taskId);
        resolver(true);
    }
}
