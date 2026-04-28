// Core Service - Gemini LLM Interaction Manager (updated for new @google/genai usage pattern)

const { GoogleGenAI, HarmCategory, HarmBlockThreshold, Type } = require('@google/genai');

let keyIndex = 0;

class GeminiService {
    constructor(apiKeys, selectedModel = 'gemini-flash-latest') {
        if (!apiKeys || apiKeys.length === 0) {
            throw new Error('No API keys provided for GeminiService.');
        }
        this.apiKeys = apiKeys.filter(Boolean);
        if (!this.apiKeys.length) throw new Error('Only empty API keys supplied.');
        this.selectedModel = selectedModel;
    }

    _nextKey() {
        const key = this.apiKeys[keyIndex];
        keyIndex = (keyIndex + 1) % this.apiKeys.length;
        return key;
    }

    _buildPrompt(jobDescription, resumeText) {
    return `You are an expert technical interviewer. Generate a comprehensive L1 technical screening interview script with structured sections.

IMPORTANT: Each section must be returned as properly structured data, not as markdown text. Follow the exact JSON schema provided.

SECTIONS TO GENERATE:
1. Interview Title: Concise, role-aligned title (no word "Title")
2. Introduction: 3-4 complete professional sentences with no placeholders
3. Candidate Summary: 2-3 neutral sentences summarizing strengths/experience alignment
4. Theoretical Questions: Exactly 6 numbered scenario-based questions
5. DSA Problems: Exactly 5 algorithm problems (1 Easy, 2 Medium, 2 Hard)
6. Conclusion: 1-2 sentences with closing and next steps

REQUIREMENTS:
- NO placeholder tokens (no brackets [], <>, {}, ALL CAPS markers)
- Questions must focus on technologies overlapping BOTH job description and resume
- DSA problems must be ORIGINAL (not LeetCode classics like Two Sum, etc.)
- Each DSA problem needs: statement, input/output format, constraints, examples, Python solution with complexity analysis
- Problems should reflect domain/technologies from JD/resume when reasonable
- All content must be immediately usable without editing

JOB DESCRIPTION:
"""${jobDescription}"""

RESUME:
"""${resumeText}"""

Return structured JSON following the exact schema provided.`;
    }

    _config() {
        return {
            thinkingConfig: { thinkingBudget: 20000 },
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
            ],
            responseMimeType: 'application/json',
            responseSchema: {
                type: Type.OBJECT,
                required: ['interviewTitle', 'introduction', 'candidateSummary', 'theoreticalQuestions', 'dsaProblems', 'conclusion'],
                properties: {
                    interviewTitle: { 
                        type: Type.STRING,
                        description: 'Concise, role-aligned interview title'
                    },
                    introduction: {
                        type: Type.STRING,
                        description: '3-4 professional sentences for interview opening'
                    },
                    candidateSummary: {
                        type: Type.STRING,
                        description: '2-3 neutral sentences summarizing candidate alignment'
                    },
                    theoreticalQuestions: {
                        type: Type.ARRAY,
                        description: 'Exactly 6 scenario-based technical questions',
                        minItems: 6,
                        maxItems: 6,
                        items: {
                            type: Type.OBJECT,
                            required: ['number', 'question'],
                            properties: {
                                number: { type: Type.INTEGER, description: 'Question number (1-6)' },
                                question: { type: Type.STRING, description: 'The technical question focusing on JD/resume overlap' }
                            }
                        }
                    },
                    dsaProblems: {
                        type: Type.ARRAY,
                        description: 'Exactly 5 original algorithm problems',
                        minItems: 5,
                        maxItems: 5,
                        items: {
                            type: Type.OBJECT,
                            required: ['number', 'title', 'difficulty', 'statement', 'inputFormat', 'outputFormat', 'constraints', 'examples', 'solution', 'timeComplexity', 'spaceComplexity'],
                            properties: {
                                number: { type: Type.INTEGER, description: 'Problem number (1-5)' },
                                title: { type: Type.STRING, description: 'Descriptive problem title' },
                                difficulty: { type: Type.STRING, enum: ['Easy', 'Medium', 'Hard'], description: 'Problem difficulty level' },
                                statement: { type: Type.STRING, description: 'Clear problem statement' },
                                inputFormat: { type: Type.STRING, description: 'Input format description' },
                                outputFormat: { type: Type.STRING, description: 'Output format description' },
                                constraints: { type: Type.STRING, description: 'Problem constraints' },
                                examples: {
                                    type: Type.ARRAY,
                                    description: '1-2 example test cases',
                                    items: {
                                        type: Type.OBJECT,
                                        required: ['input', 'output', 'explanation'],
                                        properties: {
                                            input: { type: Type.STRING, description: 'Example input' },
                                            output: { type: Type.STRING, description: 'Expected output' },
                                            explanation: { type: Type.STRING, description: 'Brief explanation' }
                                        }
                                    }
                                },
                                solution: { type: Type.STRING, description: 'Complete Python solution code' },
                                approach: { type: Type.STRING, description: 'Brief solution approach explanation' },
                                timeComplexity: { type: Type.STRING, description: 'Time complexity analysis' },
                                spaceComplexity: { type: Type.STRING, description: 'Space complexity analysis' }
                            }
                        }
                    },
                    conclusion: {
                        type: Type.STRING,
                        description: '1-2 sentences with closing and next steps'
                    }
                },
                propertyOrdering: ['interviewTitle', 'introduction', 'candidateSummary', 'theoreticalQuestions', 'dsaProblems', 'conclusion']
            }
        };
    }

    async generateScript(jobDescription, resumeText) {
        const apiKey = this._nextKey();
        const ai = new GoogleGenAI({ apiKey });
        const contents = [{
            role: 'user',
            parts: [{ text: this._buildPrompt(jobDescription, resumeText) }]
        }];
        const model = this.selectedModel;
        const config = this._config();

        try {
            const response = await ai.models.generateContent({ model, config, contents });

            const debug = process.env.GEMINI_DEBUG === '1';
            if (debug) {
                console.log('[GeminiService] Raw response keys:', Object.keys(response || {}));
                if (response && response.response) {
                    console.log('[GeminiService] Nested response keys:', Object.keys(response.response));
                }
            }

            // Helper to safely parse JSON text
            const tryParse = (raw) => {
                if (typeof raw !== 'string' || !raw.trim()) return null;
                try {
                    return JSON.parse(raw);
                } catch (e) {
                    if (debug) console.warn('[GeminiService] JSON parse failed for candidate text length', raw.length);
                    return null;
                }
            };

            // 1. Direct helper text()
            if (response?.response && typeof response.response.text === 'function') {
                const raw = response.response.text();
                const parsed = tryParse(raw);
                if (parsed) return parsed;
            }

            // 2. response.response.candidates parts
            if (response?.response?.candidates) {
                const textAggregate = response.response.candidates
                    .flatMap(c => (c.content?.parts || []).map(p => p.text || ''))
                    .join('');
                const parsed = tryParse(textAggregate);
                if (parsed) return parsed;
            }

            // 3. Top-level candidates (if shape differs)
            if (Array.isArray(response?.candidates)) {
                const textAggregate = response.candidates
                    .flatMap(c => (c.content?.parts || []).map(p => p.text || ''))
                    .join('');
                const parsed = tryParse(textAggregate);
                if (parsed) return parsed;
            }

            // 4. Fallback: raw string somewhere (output_text or similar)
            if (typeof response?.output_text === 'string') {
                const parsed = tryParse(response.output_text);
                if (parsed) return parsed;
            }

            // 5. As a last resort, if we have a markdown-looking string, wrap it in legacy format
            if (response?.response && typeof response.response.text === 'function') {
                const raw = response.response.text();
                if (raw && /#|##|```|Problem/i.test(raw)) {
                    return {
                        interviewTitle: 'Interview Script',
                        introduction: 'Welcome to this technical interview. We will be discussing your background and testing your technical knowledge.',
                        candidateSummary: 'Based on the provided information, the candidate has relevant experience.',
                        theoreticalQuestions: [
                            { number: 1, question: 'Please describe your experience with the technologies mentioned in the job description.' }
                        ],
                        dsaProblems: [
                            { 
                                number: 1, 
                                title: 'Basic Algorithm Problem',
                                difficulty: 'Easy',
                                statement: 'Solve a basic problem',
                                inputFormat: 'Standard input',
                                outputFormat: 'Standard output',
                                constraints: 'None specified',
                                examples: [{ input: 'example', output: 'result', explanation: 'Basic example' }],
                                solution: 'def solve(): pass',
                                approach: 'Direct approach',
                                timeComplexity: 'O(1)',
                                spaceComplexity: 'O(1)'
                            }
                        ],
                        conclusion: 'Thank you for your time. We will be in touch with next steps.',
                        fullInterviewScriptMarkdown: raw // Keep legacy format for compatibility
                    };
                }
            }

            throw new Error('Unexpected Gemini response format');
        } catch (err) {
            if (this.apiKeys.length > 1) {
                try {
                    const backupKey = this._nextKey();
                    const ai2 = new GoogleGenAI({ apiKey: backupKey });
                    const response2 = await ai2.models.generateContent({ model, config, contents });
                    if (response2?.response && typeof response2.response.text === 'function') {
                        const raw = response2.response.text();
                        try { 
                            return JSON.parse(raw); 
                        } catch (_) {
                            // Return structured fallback format
                            return {
                                interviewTitle: 'Interview Script',
                                introduction: 'Welcome to this technical interview. We will be discussing your background and testing your technical knowledge.',
                                candidateSummary: 'Based on the provided information, the candidate has relevant experience.',
                                theoreticalQuestions: [
                                    { number: 1, question: 'Please describe your experience with the technologies mentioned in the job description.' }
                                ],
                                dsaProblems: [
                                    { 
                                        number: 1, 
                                        title: 'Basic Algorithm Problem',
                                        difficulty: 'Easy',
                                        statement: 'Solve a basic problem',
                                        inputFormat: 'Standard input',
                                        outputFormat: 'Standard output',
                                        constraints: 'None specified',
                                        examples: [{ input: 'example', output: 'result', explanation: 'Basic example' }],
                                        solution: 'def solve(): pass',
                                        approach: 'Direct approach',
                                        timeComplexity: 'O(1)',
                                        spaceComplexity: 'O(1)'
                                    }
                                ],
                                conclusion: 'Thank you for your time. We will be in touch with next steps.',
                                fullInterviewScriptMarkdown: raw
                            };
                        }
                    }
                } catch (retryErr) {
                    throw new Error(`Gemini retry failed: ${retryErr.message}`);
                }
            }
            throw new Error(`Gemini generation failed: ${err.message}`);
        }
    }
}

module.exports = GeminiService;