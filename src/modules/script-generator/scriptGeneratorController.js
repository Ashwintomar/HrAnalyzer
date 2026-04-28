// Controller for Script Generator Module

const pdf = require('pdf-parse');
const fs = require('fs').promises;
const path = require('path');
const GeminiService = require('../../core/geminiService');
const CohereService = require('../../core/cohereService');
const PDFDocument = require('pdfkit');

// Beautiful PDF Rendering Helpers (no trailing blank pages, section styling similar to UI)
function renderStructuredPDF(doc, data) {
    const palette = {
        primary: '#1f2937', // gray-800
        secondary: '#374151', // gray-700
        accent: '#6366f1', // indigo-500
        text: '#111827', // gray-900
        muted: '#6b7280', // gray-500
        border: '#e5e7eb', // gray-200
        bgSoft: '#f9fafb', // gray-50
        success: '#10b981',
        warning: '#f59e0b',
        danger: '#ef4444'
    };

    const margin = 56; // ~0.78in
    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - margin * 2;
    const lineGap = 4;

    // Track page number explicitly to avoid relying on internal page fields
    let pageNum = 1;
    const footer = () => {
        // Draw footer inside the content area to avoid triggering a new page
        const y = doc.page.height - margin - 12;
        const x = margin;
        const w = contentWidth;
        const pgText = `Page ${pageNum}`;
        // Preserve current cursor position so footer does not affect layout flow
        const prevX = doc.x, prevY = doc.y;
        doc.save();
        doc.font('Helvetica').fontSize(8).fillColor(palette.muted)
           .text(pgText, x, y, { width: w, align: 'center', lineBreak: false });
        doc.restore();
        doc.x = prevX; doc.y = prevY;
    };

    // Draw footer for first page immediately, and for subsequent pages via event
    footer();
    doc.on('pageAdded', () => {
        pageNum += 1;
        footer();
    });

    // Utilities
    const ensureSpace = (needed) => {
        const bottom = doc.page.height - margin;
        if (doc.y + needed > bottom) doc.addPage();
    };
    const divider = (space = 10) => {
        ensureSpace(space + 6);
        doc.moveDown(0.35);
        doc.save().lineWidth(0.5).strokeColor(palette.border)
           .moveTo(margin, doc.y).lineTo(margin + contentWidth, doc.y).stroke().restore();
        doc.moveDown(0.35);
    };
    const sectionHeader = (emoji, title) => {
        const h = 22;
        ensureSpace(h + 10);
        doc.font('Helvetica-Bold').fontSize(16).fillColor(palette.accent)
           .text(`${emoji} ${title}`, margin, doc.y, { width: contentWidth });
        doc.moveDown(0.25);
    };
    const paragraph = (text) => {
        if (!text) return;
        const h = doc.heightOfString(text, { width: contentWidth, align: 'justify', lineGap });
        ensureSpace(h + 6);
        doc.font('Helvetica').fontSize(11).fillColor(palette.text)
           .text(text, { width: contentWidth, align: 'justify', lineGap });
        // Slightly larger paragraph spacing for readability
        doc.moveDown(0.65);
    };
    const badge = (label, color) => {
        const padX = 6, padY = 3;
        const textWidth = doc.widthOfString(label, { font: 'Helvetica-Bold', size: 8 });
        const bw = textWidth + padX * 2;
        const bh = 14;
        const x = margin + contentWidth - bw;
        const y = doc.y - 2;
        // Preserve cursor so drawing the badge doesn't affect layout position
        const prevX = doc.x, prevY = doc.y;
        doc.save().roundedRect(x, y, bw, bh, 3).fill(color).restore();
        doc.save().font('Helvetica-Bold').fontSize(8).fillColor('#ffffff')
           .text(label, x, y + padY - 1, { width: bw, align: 'center', lineBreak: false }).restore();
        doc.x = prevX; doc.y = prevY;
    };
    const codeBlock = (code, opts = {}) => {
        const pad = 8;
        const spaceBefore = typeof opts.spaceBefore === 'number' ? opts.spaceBefore : 0.3; // lines
        const spaceAfter = typeof opts.spaceAfter === 'number' ? opts.spaceAfter : 1.0;   // lines
        // Top breathing room before code blocks
        doc.moveDown(spaceBefore);
        const h = doc.heightOfString(code || '', { width: contentWidth - pad * 2, font: 'Courier', lineGap: 2 });
        ensureSpace(h + pad * 2 + 8);
        const x = margin, y = doc.y;
        doc.save()
           .rect(x, y, contentWidth, h + pad * 2)
           .fill(palette.bgSoft)
           .restore();
        doc.save()
           .font('Courier').fontSize(9).fillColor(palette.secondary)
           .text(code || '', x + pad, y + pad, { width: contentWidth - pad * 2, lineGap: 2 })
           .restore();
        // Bottom breathing room after code blocks
        doc.moveDown(spaceAfter);
    };
    const kv = (label, value) => {
        if (!value) return;
        const lh = doc.heightOfString(value, { width: contentWidth, lineGap });
        ensureSpace(lh + 10);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(palette.secondary)
           .text(`${label}:`, { continued: true });
        doc.font('Helvetica').fontSize(10).fillColor(palette.text)
           .text(` ${value}`);
    };

    // Title
    const title = (data.interviewTitle || 'Interview Script');
    doc.font('Helvetica-Bold').fontSize(22).fillColor(palette.primary)
       .text(title, margin, doc.y, { width: contentWidth });
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(10).fillColor(palette.muted)
       .text(`Generated on ${new Date().toLocaleDateString()}`);
    divider(8);

    // Introduction
    sectionHeader('👋', 'Introduction');
    paragraph(data.introduction);
    divider();

    // Candidate Summary
    sectionHeader('📋', 'Candidate Summary');
    paragraph(data.candidateSummary);
    divider();

    // Theoretical Questions
    const tq = Array.isArray(data.theoreticalQuestions) ? data.theoreticalQuestions : [];
    if (tq.length) {
        sectionHeader('💭', 'Theoretical & Experience Validation');
        tq.forEach((q) => {
            const text = `${q.number}. ${q.question}`;
            const h = doc.heightOfString(text, { width: contentWidth, lineGap });
            ensureSpace(h + 6);
            doc.circle(margin + 2, doc.y + 6, 2).fill(palette.accent).strokeColor(palette.accent).stroke();
            doc.font('Helvetica').fontSize(11).fillColor(palette.text)
               .text(text, margin + 12, doc.y, { width: contentWidth - 12, lineGap });
            doc.moveDown(0.5);
        });
        divider();
    }

    // DSA Problems
    const problems = Array.isArray(data.dsaProblems) ? data.dsaProblems : [];
    if (problems.length) {
        sectionHeader('🧮', `Data Structures & Algorithms (${problems.length} Problems)`);
        problems.forEach((p) => {
            // Header line with difficulty badge
            const header = `Problem ${p.number}: ${p.title}`;
            const hdrH = doc.heightOfString(header, { width: contentWidth });
            ensureSpace(hdrH + 18);
            doc.font('Helvetica-Bold').fontSize(13).fillColor(palette.primary)
               .text(header, margin, doc.y, { width: contentWidth });
            const color = (p.difficulty === 'Easy') ? palette.success : (p.difficulty === 'Medium') ? palette.warning : palette.danger;
            badge(p.difficulty?.toUpperCase() || 'N/A', color);
            doc.moveDown(0.4);

            paragraph(p.statement);
            kv('Input Format', p.inputFormat);
            kv('Output Format', p.outputFormat);
            kv('Constraints', p.constraints);
            // Slightly more space after metadata block
            doc.moveDown(0.6);

            if (Array.isArray(p.examples) && p.examples.length) {
                ensureSpace(16);
                doc.font('Helvetica-Bold').fontSize(11).fillColor(palette.secondary)
                   .text('Examples');
                doc.moveDown(0.25);
                p.examples.forEach((ex, idx) => {
                    const block = `Input: ${ex.input}\nOutput: ${ex.output}\nExplanation: ${ex.explanation}`;
                    doc.font('Helvetica-Bold').fontSize(10).fillColor(palette.secondary)
                       .text(`Example ${idx + 1}`);
                    codeBlock(block, { spaceBefore: 0.15, spaceAfter: 0.8 });
                });
                // Space after the examples block before continuing
                doc.moveDown(0.4);
            }

            ensureSpace(20);
            doc.font('Helvetica-Bold').fontSize(11).fillColor(palette.secondary)
               .text('Optimal Solution');
            // Tiny space before the code block so the heading breathes
            doc.moveDown(0.2);
            codeBlock(p.solution || '', { spaceBefore: 0.2, spaceAfter: 1.0 });

            kv('Time Complexity', p.timeComplexity);
            kv('Space Complexity', p.spaceComplexity);
            if (p.approach) kv('Approach', p.approach);
            doc.moveDown(0.75);
            divider();
        });
    }

    // Conclusion
    sectionHeader('🎯', 'Conclusion');
    paragraph(data.conclusion);
}

function renderMarkdownPDF(doc, markdown, title) {
    const palette = {
        text: '#111827',
        secondary: '#374151',
        border: '#e5e7eb',
        bgSoft: '#f9fafb'
    };
    const margin = 56;
    const contentWidth = doc.page.width - margin * 2;

    const ensureSpace = (needed) => {
        if (doc.y + needed > doc.page.height - margin) doc.addPage();
    };

    // Header
    doc.font('Helvetica-Bold').fontSize(18).fillColor(palette.text)
       .text(title || 'Interview Script', margin, doc.y, { width: contentWidth, align: 'center' });
    doc.moveDown(1);

    const lines = (markdown || '').split('\n');
    let inCode = false;
    let codeBuf = [];

    const flushCode = () => {
        if (!codeBuf.length) return;
        const code = codeBuf.join('\n');
        const pad = 8;
        const h = doc.heightOfString(code, { width: contentWidth - pad * 2, font: 'Courier' });
        ensureSpace(h + pad * 2 + 8);
        const x = margin, y = doc.y;
        doc.save().rect(x, y, contentWidth, h + pad * 2).fill(palette.bgSoft).restore();
        doc.save().font('Courier').fontSize(9).fillColor(palette.secondary)
           .text(code, x + pad, y + pad, { width: contentWidth - pad * 2 }).restore();
        doc.moveDown(0.75);
        codeBuf = [];
    };

    for (const line of lines) {
        if (line.trim().startsWith('```')) {
            inCode = !inCode;
            if (!inCode) flushCode();
            continue;
        }
        if (inCode) {
            codeBuf.push(line);
            continue;
        }
        if (line.startsWith('### ')) {
            flushCode();
            ensureSpace(24);
            doc.font('Helvetica-Bold').fontSize(14).fillColor(palette.text).text(line.slice(4), { width: contentWidth });
            doc.moveDown(0.25);
            continue;
        }
        if (line.startsWith('## ')) {
            flushCode();
            ensureSpace(28);
            doc.font('Helvetica-Bold').fontSize(16).fillColor(palette.text).text(line.slice(3), { width: contentWidth });
            doc.moveDown(0.25);
            continue;
        }
        if (line.trim() === '') {
            flushCode();
            doc.moveDown(0.35);
            continue;
        }
        const h = doc.heightOfString(line, { width: contentWidth });
        ensureSpace(h + 6);
        doc.font('Helvetica').fontSize(11).fillColor(palette.text).text(line, { width: contentWidth });
    }
    flushCode();
}

module.exports = () => {
    return {
        generateScript: async (req, res) => {
            const { jobDescription, apiKeys, selectedModel, llmProvider } = req.body;
            const resumeFile = req.file;

            if (!resumeFile) {
                return res.status(400).json({ success: false, error: 'No resume file uploaded.' });
            }
            if (!jobDescription) {
                return res.status(400).json({ success: false, error: 'Job description is required.' });
            }
            
            let parsedApiKeys;
            try {
                parsedApiKeys = JSON.parse(apiKeys);
                if (!Array.isArray(parsedApiKeys) || parsedApiKeys.length === 0) {
                    throw new Error();
                }
            } catch (e) {
                return res.status(400).json({ success: false, error: 'Valid API keys are required.' });
            }

            try {
                // 1. Extract text from resume PDF
                const fileBuffer = resumeFile.buffer ? resumeFile.buffer : await fs.readFile(resumeFile.path);
                const pdfData = await pdf(fileBuffer);
                const resumeText = pdfData.text;

                // 2. Initialize LLM Service and generate script
                const provider = (llmProvider || 'gemini').toLowerCase();
                let scriptData;
                if (provider === 'cohere') {
                    const cohereService = new CohereService(parsedApiKeys, selectedModel || 'command-a-reasoning-08-2025');
                    scriptData = await cohereService.generateScript(jobDescription, resumeText);
                } else {
                    const geminiService = new GeminiService(parsedApiKeys, selectedModel || 'gemini-flash-latest');
                    scriptData = await geminiService.generateScript(jobDescription, resumeText);
                }

                res.json({
                    success: true,
                    ...scriptData
                });

            } catch (error) {
                console.error('Script generation controller error:', error);
                res.status(500).json({ success: false, error: error.message });
            } finally {
                // 3. Clean up the uploaded file
                if (resumeFile && resumeFile.path) {
                    try {
                        await fs.unlink(resumeFile.path);
                    } catch (cleanupError) {
                        console.error('Failed to clean up uploaded resume file:', cleanupError);
                    }
                }
            }
        },

        exportToPdf: async (req, res) => {
            const { markdown, title, structuredData } = req.body;
            
            if (!markdown && !structuredData) {
                return res.status(400).json({ success: false, error: 'No content provided for PDF export.' });
            }

            try {
                const doc = new PDFDocument({ 
                    margin: 56,
                    size: 'A4'
                });
                
                const filename = (title || 'Interview-Script').replace(/[^a-zA-Z0-9-_]/g, '_');

                // Buffer PDF in-memory to avoid partial writes on error
                const chunks = [];
                let streamFailed = false;
                doc.on('data', (chunk) => chunks.push(chunk));
                doc.on('error', (err) => {
                    streamFailed = true;
                    console.error('PDF stream error:', err);
                    try {
                        if (!res.headersSent) {
                            res.status(500).json({ success: false, error: 'Failed to generate PDF: ' + err.message });
                        }
                    } catch {}
                });
                doc.on('end', () => {
                    if (streamFailed) return;
                    const pdfBuffer = Buffer.concat(chunks);
                    res.setHeader('Content-Type', 'application/pdf');
                    res.setHeader('Content-Disposition', `attachment; filename=\"${filename}.pdf\"`);
                    res.setHeader('Content-Length', String(pdfBuffer.length));
                    res.status(200).send(pdfBuffer);
                });

                // Use structured data if available, otherwise fall back to markdown
                if (structuredData && typeof structuredData === 'object') {
                    renderStructuredPDF(doc, structuredData);
                } else {
                    renderMarkdownPDF(doc, markdown, title);
                }

                // End the document
                doc.end();

            } catch (error) {
                console.error('PDF export error:', error);
                if (!res.headersSent) {
                    res.status(500).json({ success: false, error: 'Failed to generate PDF: ' + error.message });
                }
            }
        }
    };
};