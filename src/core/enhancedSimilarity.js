// Skill-Based Similarity Enhancement
// Adds explicit skill matching to complement semantic embeddings

/**
 * Enhanced similarity calculation that combines semantic similarity 
 * with explicit skill matching for better resume ranking
 */

class EnhancedSimilarityCalculator {
    constructor() {
        // Common technical skills database - expand based on your domain
        this.skillCategories = {
            programming: [
                'python', 'javascript', 'java', 'typescript', 'go', 'rust', 'c++', 'c#', 
                'php', 'ruby', 'swift', 'kotlin', 'scala', 'r', 'matlab'
            ],
            webFrameworks: [
                'react', 'angular', 'vue', 'django', 'flask', 'fastapi', 'express', 
                'spring', 'laravel', 'rails', 'asp.net', 'nextjs', 'nuxt'
            ],
            databases: [
                'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'sqlite', 
                'oracle', 'cassandra', 'neo4j', 'dynamodb', 'bigquery'
            ],
            cloud: [
                'aws', 'gcp', 'azure', 'heroku', 'digitalocean', 'linode', 
                'cloudflare', 'vercel', 'netlify'
            ],
            devops: [
                'docker', 'kubernetes', 'jenkins', 'terraform', 'ansible', 'chef', 
                'puppet', 'gitlab-ci', 'github-actions', 'circleci', 'travis-ci'
            ],
            tools: [
                'git', 'linux', 'apache', 'nginx', 'graphql', 'rest', 'api', 
                'microservices', 'websockets', 'grpc'
            ]
        };
        
        // Flatten all skills for easier searching
        this.allSkills = Object.values(this.skillCategories).flat();
    }
    
    /**
     * Enhanced similarity that combines semantic and skill-based matching
     * Following the article's approach of skill overlap weighting
     */
    calculateEnhancedSimilarity(semanticSimilarity, resumeSkills, jobSkills, options = {}) {
        const {
            skillWeight = 0.3,          // Weight for skill matching (0.3 = 30%)
            semanticWeight = 0.7,       // Weight for semantic similarity (0.7 = 70%)
            skillBoostFactor = 0.05,    // Boost per matching skill
            maxSkillBoost = 0.2         // Maximum boost from skills
        } = options;
        
        // Calculate skill overlap
        const skillOverlap = this.calculateSkillOverlap(resumeSkills, jobSkills);
        const skillBoost = Math.min(skillOverlap.matchCount * skillBoostFactor, maxSkillBoost);
        
        // Combine semantic and skill-based similarities
        const baseSimilarity = Math.max(0, Math.min(1, semanticSimilarity));
        const enhancedSimilarity = Math.min(1, baseSimilarity + skillBoost);
        
        return {
            similarity: enhancedSimilarity,
            breakdown: {
                semantic: baseSimilarity,
                skillBoost,
                skillOverlap,
                finalScore: enhancedSimilarity
            }
        };
    }
    
    /**
     * Calculate skill overlap between resume and job requirements
     */
    calculateSkillOverlap(resumeSkills, jobSkills) {
        const resumeSkillsLower = (resumeSkills || []).map(s => s.toLowerCase());
        const jobSkillsLower = (jobSkills || []).map(s => s.toLowerCase());
        
        // Direct matches
        const directMatches = resumeSkillsLower.filter(skill => 
            jobSkillsLower.includes(skill)
        );
        
        // Semantic matches (similar technologies)
        const semanticMatches = this.findSemanticSkillMatches(resumeSkillsLower, jobSkillsLower);
        
        // Category matches (e.g., different databases still count as database experience)
        const categoryMatches = this.findCategoryMatches(resumeSkillsLower, jobSkillsLower);
        
        return {
            matchCount: directMatches.length + semanticMatches.length + categoryMatches.length,
            directMatches,
            semanticMatches,
            categoryMatches,
            totalJobSkills: jobSkillsLower.length,
            matchPercentage: jobSkillsLower.length > 0 
                ? (directMatches.length / jobSkillsLower.length) * 100 
                : 0
        };
    }
    
    /**
     * Find semantically similar skills (e.g., 'nodejs' matches 'node.js')
     */
    findSemanticSkillMatches(resumeSkills, jobSkills) {
        const matches = [];
        const similarityMap = {
            'nodejs': ['node.js', 'node', 'expressjs'],
            'reactjs': ['react.js', 'react'],
            'postgresql': ['postgres', 'psql'],
            'kubernetes': ['k8s'],
            'javascript': ['js', 'ecmascript'],
            'typescript': ['ts'],
            'artificial intelligence': ['ai', 'machine learning', 'ml'],
            'continuous integration': ['ci/cd', 'devops'],
        };
        
        for (const jobSkill of jobSkills) {
            for (const [canonical, variants] of Object.entries(similarityMap)) {
                if (variants.includes(jobSkill) || jobSkill === canonical) {
                    const hasCanonical = resumeSkills.includes(canonical);
                    const hasVariant = variants.some(v => resumeSkills.includes(v));
                    
                    if (hasCanonical || hasVariant) {
                        matches.push({ jobSkill, matched: canonical });
                    }
                }
            }
        }
        
        return matches;
    }
    
    /**
     * Find matches within the same skill category
     */
    findCategoryMatches(resumeSkills, jobSkills) {
        const matches = [];
        
        for (const [category, skills] of Object.entries(this.skillCategories)) {
            const resumeHasCategory = skills.some(skill => resumeSkills.includes(skill));
            const jobWantsCategory = skills.some(skill => jobSkills.includes(skill));
            
            if (resumeHasCategory && jobWantsCategory) {
                const resumeCategorySkills = skills.filter(skill => resumeSkills.includes(skill));
                const jobCategorySkills = skills.filter(skill => jobSkills.includes(skill));
                
                matches.push({
                    category,
                    resumeSkills: resumeCategorySkills,
                    jobSkills: jobCategorySkills
                });
            }
        }
        
        return matches;
    }
    
    /**
     * Extract skills from text content
     */
    extractSkillsFromText(text) {
        const content = text.toLowerCase();
        const foundSkills = this.allSkills.filter(skill => {
            // Use word boundaries to avoid false positives
            const regex = new RegExp(`\\b${skill}\\b`, 'i');
            return regex.test(content);
        });
        
        return [...new Set(foundSkills)]; // Remove duplicates
    }
    
    /**
     * Prioritize skills based on importance
     */
    prioritizeSkills(skills, jobTitle = '') {
        const jobTitleLower = jobTitle.toLowerCase();
        const weights = {
            high: 1.0,
            medium: 0.7,
            low: 0.4
        };
        
        // Define skill priorities based on job type
        const priorityMap = {
            backend: {
                high: ['python', 'java', 'javascript', 'nodejs', 'postgresql', 'mysql'],
                medium: ['redis', 'mongodb', 'docker', 'kubernetes'],
                low: ['html', 'css']
            },
            frontend: {
                high: ['javascript', 'react', 'angular', 'vue', 'typescript'],
                medium: ['css', 'html', 'webpack', 'sass'],
                low: ['python', 'java']
            },
            devops: {
                high: ['docker', 'kubernetes', 'jenkins', 'terraform', 'aws'],
                medium: ['python', 'bash', 'linux', 'git'],
                low: ['react', 'angular']
            },
            fullstack: {
                high: ['javascript', 'python', 'react', 'nodejs'],
                medium: ['postgresql', 'docker', 'git'],
                low: []
            }
        };
        
        // Determine job type
        let jobType = 'fullstack'; // default
        if (jobTitleLower.includes('backend') || jobTitleLower.includes('server')) {
            jobType = 'backend';
        } else if (jobTitleLower.includes('frontend') || jobTitleLower.includes('ui')) {
            jobType = 'frontend';
        } else if (jobTitleLower.includes('devops') || jobTitleLower.includes('infrastructure')) {
            jobType = 'devops';
        }
        
        const priorities = priorityMap[jobType];
        
        return skills.map(skill => ({
            skill,
            weight: priorities.high.includes(skill) ? weights.high :
                   priorities.medium.includes(skill) ? weights.medium :
                   weights.low,
            priority: priorities.high.includes(skill) ? 'high' :
                     priorities.medium.includes(skill) ? 'medium' : 'low'
        }));
    }
}

module.exports = EnhancedSimilarityCalculator;