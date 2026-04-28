const contactParser = require('./contactParser');

/**
 * Centralized Resume Parsing Utilities
 * Handles text cleaning, metadata extraction, and sanitization.
 */
class ResumeParser {
    /**
     * Clean text content and remove graphics/image artifacts
     * @param {string} text - Raw text from PDF/File
     * @returns {string} Cleaned text
     */
    static cleanText(text) {
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
        
        return cleaned;
    }

    /**
     * Extract candidate information from resume text
     * @param {string} text - Cleaned resume text
     * @returns {Object|null} Extracted info {name, email, phone} or null
     */
    static extractCandidateInfo(text) {
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

    /**
     * Sanitize name string
     * @param {string} name 
     * @returns {string|null}
     */
    static sanitizeName(name) {
        let n = String(name || '').trim();
        if (!n) return null;
        // Remove extra whitespace and non-letter noise
        n = n.replace(/\s+/g, ' ').replace(/[^A-Za-z\s.'-]/g, '').trim();
        if (n.length < 2 || n.length > 80) return null;
        // Capitalize words
        n = n.split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        return n;
    }

    /**
     * Check if name is generic/placeholder
     * @param {string} name 
     * @returns {boolean}
     */
    static isGenericName(name) {
        if (!name) return true;
        const n = String(name).trim();
        if (/^candidate\b/i.test(n)) return true;
        if (/^unknown$/i.test(n)) return true;
        if (n.length < 3) return true;
        return false;
    }

    /**
     * Sanitize text for embedding generation
     * @param {string} text 
     * @param {number} maxLength 
     * @returns {string}
     */
    static sanitizeEmbeddingText(text, maxLength = 12000) {
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
}

module.exports = ResumeParser;
