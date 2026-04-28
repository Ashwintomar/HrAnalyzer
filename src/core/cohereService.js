// Cohere Service - LLM Interaction Manager for Cohere Reasoning models

let keyIndex = 0;

class CohereService {
    constructor(apiKeys, selectedModel = 'command-a-reasoning-08-2025') {
        if (!apiKeys || apiKeys.length === 0) {
            throw new Error('No API keys provided for CohereService.');
        }
        this.apiKeys = apiKeys.filter(Boolean);
        if (!this.apiKeys.length) throw new Error('Only empty API keys supplied.');
        this.selectedModel = selectedModel || 'command-a-reasoning-08-2025';
    }

    _nextKey() {
        const key = this.apiKeys[keyIndex];
        keyIndex = (keyIndex + 1) % this.apiKeys.length;
        return key;
    }

    _buildPrompt(jobDescription, resumeText) {
        return `You are an expert technical interviewer. Generate a comprehensive L1 technical screening interview script with structured sections.

IMPORTANT: The response MUST be valid JSON and adhere EXACTLY to the provided JSON schema. Do not include any additional commentary.

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
`;
    }

    _jsonSchema() {
        // Standard JSON Schema for Cohere's responseFormat
        return {
            type: 'object',
            properties: {
                interviewTitle: { type: 'string', description: 'Concise, role-aligned interview title' },
                introduction: { type: 'string', description: '3-4 professional sentences for interview opening' },
                candidateSummary: { type: 'string', description: '2-3 neutral sentences summarizing candidate alignment' },
                theoreticalQuestions: {
                    type: 'array',
                    description: 'Exactly 6 scenario-based technical questions',
                    items: {
                        type: 'object',
                        required: ['number', 'question'],
                        properties: {
                            number: { type: 'integer', description: 'Question number (1-6)' },
                            question: { type: 'string', description: 'The technical question focusing on JD/resume overlap' }
                        }
                    }
                },
                dsaProblems: {
                    type: 'array',
                    description: 'Exactly 5 original algorithm problems',
                    items: {
                        type: 'object',
                        required: ['number', 'title', 'difficulty', 'statement', 'inputFormat', 'outputFormat', 'constraints', 'examples', 'solution', 'timeComplexity', 'spaceComplexity'],
                        properties: {
                            number: { type: 'integer', description: 'Problem number (1-5)' },
                            title: { type: 'string' },
                            difficulty: { type: 'string', enum: ['Easy', 'Medium', 'Hard'] },
                            statement: { type: 'string' },
                            inputFormat: { type: 'string' },
                            outputFormat: { type: 'string' },
                            constraints: { type: 'string' },
                            examples: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    required: ['input', 'output', 'explanation'],
                                    properties: {
                                        input: { type: 'string' },
                                        output: { type: 'string' },
                                        explanation: { type: 'string' }
                                    }
                                }
                            },
                            solution: { type: 'string', description: 'Complete Python solution code' },
                            approach: { type: 'string' },
                            timeComplexity: { type: 'string' },
                            spaceComplexity: { type: 'string' }
                        }
                    }
                },
                conclusion: { type: 'string', description: '1-2 sentences with closing and next steps' }
            },
            required: ['interviewTitle', 'introduction', 'candidateSummary', 'theoreticalQuestions', 'dsaProblems', 'conclusion']
        };
    }

    async generateScript(jobDescription, resumeText) {
        const key = this._nextKey();
        const { CohereClientV2 } = await import('cohere-ai');
        const cohere = new CohereClientV2({ token: key });

        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: this._buildPrompt(jobDescription, resumeText) }
                ]
            }
        ];

        try {
            const response = await cohere.chat({
                messages,
                thinking: { type: 'enabled' },
                temperature: 0.35,
                model: this.selectedModel,
                responseFormat: {
                    type: 'json_object',
                    jsonSchema: this._jsonSchema()
                }
            });

            // Attempt to extract the JSON payload
            const tryParse = (raw) => {
                if (typeof raw !== 'string' || !raw.trim()) return null;
                try { return JSON.parse(raw); } catch { return null; }
            };

            // Common shapes: response.message?.content array with text
            let parsed = null;
            const content = response?.message?.content;
            if (Array.isArray(content)) {
                const textAggregate = content.map(p => p?.text || '').join('');
                parsed = tryParse(textAggregate);
                if (parsed) return parsed;
            }
            // Some SDKs expose output_text directly
            if (typeof response?.output_text === 'string') {
                parsed = tryParse(response.output_text);
                if (parsed) return parsed;
            }
            // Fallback: stringify and look for the first JSON object
            const s = JSON.stringify(response);
            const match = s.match(/\{[\s\S]*\}$/);
            if (match) {
                parsed = tryParse(match[0]);
                if (parsed) return parsed;
            }

            throw new Error('Unexpected Cohere response format');
        } catch (err) {
            // Rotate to next key and retry once
            if (this.apiKeys.length > 1) {
                try {
                    const backup = this._nextKey();
                    const { CohereClientV2 } = await import('cohere-ai');
                    const cohere2 = new CohereClientV2({ token: backup });
                    const response2 = await cohere2.chat({
                        messages,
                        thinking: { type: 'enabled' },
                        temperature: 0.35,
                        model: this.selectedModel,
                        responseFormat: {
                            type: 'json_object',
                            jsonSchema: this._jsonSchema()
                        }
                    });
                    const content2 = response2?.message?.content;
                    if (Array.isArray(content2)) {
                        const textAggregate = content2.map(p => p?.text || '').join('');
                        const parsed = JSON.parse(textAggregate);
                        return parsed;
                    }
                    if (typeof response2?.output_text === 'string') {
                        return JSON.parse(response2.output_text);
                    }
                } catch (retryErr) {
                    throw new Error(`Cohere retry failed: ${retryErr.message}`);
                }
            }
            throw new Error(`Cohere generation failed: ${err.message}`);
        }
    }
}

module.exports = CohereService;