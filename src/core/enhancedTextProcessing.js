// Enhanced Resume Text Formatting for Better Semantic Matching
// Based on the article's approach for robust embedding generation

/**
 * Enhanced text preprocessing that enriches resume content before embedding
 * This follows the pattern from the article to improve semantic matching
 */

function enhanceResumeForEmbedding(resumeContent, candidateInfo = {}) {
    const { name, email, phone } = candidateInfo;
    
    // Extract key information from resume content
    const skills = extractSkills(resumeContent);
    const experience = extractExperience(resumeContent);
    const industry = extractIndustry(resumeContent);
    const seniority = determineSeniority(resumeContent, experience);
    
    // Structure the resume following the article's pattern
    const enhancedResume = `
Candidate Profile: ${name || 'Candidate'}
Experience Level: ${seniority}
Core Skills: ${skills.slice(0, 10).join(", ")}
Industry Experience: ${industry}
Years of Experience: ${experience.years || 'Not specified'}

Technical Expertise:
${formatTechnicalSkills(skills)}

Professional Summary:
${extractSummary(resumeContent)}

Detailed Experience:
${resumeContent}
    `.trim();
    
    return enhancedResume;
}

function enhanceJobForEmbedding(jobTitle, keySkills, requirements = '', industry = 'Technology') {
    // Select primary skills (following article's approach)
    const skillsArray = typeof keySkills === 'string' ? keySkills.split(',').map(s => s.trim()) : keySkills;
    const primarySkills = skillsArray.slice(0, 3); // Top 3 most important
    
    const enhancedJob = `
JOB LISTING: ${jobTitle}
Industry: ${industry}
Priority Skills: ${primarySkills.join(", ")}

Required Skills: ${skillsArray.join(", ")}
Job Requirements:
${requirements}
    `.trim();
    
    return enhancedJob;
}

// Utility functions for extraction (implement based on your needs)
function extractSkills(resumeContent) {
    // Common technical skills - expand this based on your domain
    const commonSkills = [
        // Programming Languages
        'python', 'javascript', 'java', 'typescript', 'go', 'rust', 'c++', 'c#',
        // Frameworks
        'react', 'angular', 'vue', 'django', 'flask', 'fastapi', 'express', 'spring',
        // Databases  
        'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch',
        // Cloud & DevOps
        'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'jenkins', 'terraform',
        // Tools & Technologies
        'git', 'linux', 'apache', 'nginx', 'graphql', 'rest', 'api'
    ];
    
    const content = resumeContent.toLowerCase();
    const foundSkills = commonSkills.filter(skill => 
        content.includes(skill.toLowerCase())
    );
    
    return foundSkills;
}

function extractExperience(resumeContent) {
    // Look for experience indicators
    const yearPatterns = [
        /(\d+)\+?\s*years?\s*(?:of\s*)?experience/gi,
        /experience\s*:?\s*(\d+)\+?\s*years?/gi,
        /(\d+)\+?\s*yrs?\s*(?:of\s*)?experience/gi
    ];
    
    for (const pattern of yearPatterns) {
        const match = resumeContent.match(pattern);
        if (match) {
            const years = parseInt(match[1]) || 0;
            return { years, raw: match[0] };
        }
    }
    
    // Fallback: count job positions or graduation year
    const jobCount = (resumeContent.match(/\b(position|role|job|work|employment)\b/gi) || []).length;
    return { years: Math.min(jobCount * 2, 10), raw: 'estimated' };
}

function determineSeniority(resumeContent, experience) {
    const content = resumeContent.toLowerCase();
    const years = experience.years || 0;
    
    // Check for explicit seniority indicators
    if (content.includes('senior') || content.includes('lead') || content.includes('principal')) {
        return 'Senior';
    }
    if (content.includes('junior') || content.includes('entry') || content.includes('intern')) {
        return 'Junior';
    }
    
    // Determine by experience
    if (years >= 5) return 'Senior';
    if (years >= 2) return 'Mid-level';
    return 'Junior';
}

function extractIndustry(resumeContent) {
    const content = resumeContent.toLowerCase();
    const industries = {
        'Technology': ['software', 'tech', 'programming', 'developer', 'engineer'],
        'Finance': ['finance', 'banking', 'fintech', 'trading', 'investment'],
        'Healthcare': ['health', 'medical', 'hospital', 'pharma', 'biotech'],
        'E-commerce': ['ecommerce', 'retail', 'shopping', 'marketplace'],
        'Education': ['education', 'teaching', 'academic', 'university'],
        'Gaming': ['gaming', 'game', 'unity', 'unreal']
    };
    
    for (const [industry, keywords] of Object.entries(industries)) {
        if (keywords.some(keyword => content.includes(keyword))) {
            return industry;
        }
    }
    
    return 'Technology'; // Default
}

function extractSummary(resumeContent) {
    // Try to find a summary section
    const summaryPatterns = [
        /(?:professional\s+)?summary\s*:?\s*([^]*?)(?:\n\s*\n|\n[A-Z])/i,
        /(?:career\s+)?objective\s*:?\s*([^]*?)(?:\n\s*\n|\n[A-Z])/i,
        /about\s*:?\s*([^]*?)(?:\n\s*\n|\n[A-Z])/i
    ];
    
    for (const pattern of summaryPatterns) {
        const match = resumeContent.match(pattern);
        if (match && match[1]) {
            return match[1].trim();
        }
    }
    
    // Fallback: take first few sentences
    const sentences = resumeContent.split(/[.!?]+/).filter(s => s.trim().length > 20);
    return sentences.slice(0, 2).join('. ') + '.';
}

function formatTechnicalSkills(skills) {
    // Group skills by category for better semantic understanding
    const categories = {
        'Programming Languages': skills.filter(s => 
            ['python', 'javascript', 'java', 'typescript', 'go', 'rust', 'c++', 'c#'].includes(s)
        ),
        'Web Frameworks': skills.filter(s => 
            ['react', 'angular', 'vue', 'django', 'flask', 'fastapi', 'express', 'spring'].includes(s)
        ),
        'Databases': skills.filter(s => 
            ['postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch'].includes(s)
        ),
        'Cloud & DevOps': skills.filter(s => 
            ['aws', 'gcp', 'azure', 'docker', 'kubernetes', 'jenkins', 'terraform'].includes(s)
        )
    };
    
    let formatted = '';
    for (const [category, categorySkills] of Object.entries(categories)) {
        if (categorySkills.length > 0) {
            formatted += `${category}: ${categorySkills.join(', ')}\n`;
        }
    }
    
    return formatted;
}

module.exports = {
    enhanceResumeForEmbedding,
    enhanceJobForEmbedding,
    extractSkills,
    extractExperience,
    determineSeniority
};