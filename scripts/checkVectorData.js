// Script to check if there's data in the database with vectors
// Usage: node scripts/checkVectorData.js

const Database = require('better-sqlite3');
const { load } = require('sqlite-vec');
const path = require('path');

function checkVectorData() {
    console.log('🔍 Checking for vector data in the database...\n');
    
    // Connect to database
    const dbPath = path.join(__dirname, '..', 'analyzer.db');
    
    try {
        const db = new Database(dbPath);
        
        // Check if sqlite-vec extension is available
        let vectorExtensionAvailable = false;
        try {
            load(db);
            vectorExtensionAvailable = true;
            console.log('✅ sqlite-vec extension loaded successfully');
        } catch (error) {
            console.log('⚠️ sqlite-vec extension not available');
        }
        
        console.log('\n📊 DATABASE OVERVIEW:');
        console.log('=' .repeat(50));
        
        // Check Candidates table
        const candidatesCount = db.prepare('SELECT COUNT(*) as count FROM Candidates').get();
        console.log(`👥 Total Candidates: ${candidatesCount.count}`);
        
        // Check Resumes table
        const resumesCount = db.prepare('SELECT COUNT(*) as count FROM Resumes').get();
        console.log(`📄 Total Resumes: ${resumesCount.count}`);
        
        // Check for resumes with embeddings (BLOB format)
        const resumesWithBlobEmbeddings = db.prepare(`
            SELECT COUNT(*) as count 
            FROM Resumes 
            WHERE embedding IS NOT NULL AND LENGTH(embedding) > 0
        `).get();
        console.log(`🔢 Resumes with BLOB embeddings: ${resumesWithBlobEmbeddings.count}`);
        
        // Check for resumes with JSON embeddings
        const resumesWithJsonEmbeddings = db.prepare(`
            SELECT COUNT(*) as count 
            FROM Resumes 
            WHERE embedding_json IS NOT NULL AND embedding_json != ''
        `).get();
        console.log(`📋 Resumes with JSON embeddings: ${resumesWithJsonEmbeddings.count}`);
        
        // Check Jobs table
        const jobsCount = db.prepare('SELECT COUNT(*) as count FROM Jobs').get();
        console.log(`💼 Total Jobs: ${jobsCount.count}`);
        
        // Check for jobs with embeddings
        const jobsWithBlobEmbeddings = db.prepare(`
            SELECT COUNT(*) as count 
            FROM Jobs 
            WHERE embedding IS NOT NULL AND LENGTH(embedding) > 0
        `).get();
        console.log(`🔢 Jobs with BLOB embeddings: ${jobsWithBlobEmbeddings.count}`);
        
        const jobsWithJsonEmbeddings = db.prepare(`
            SELECT COUNT(*) as count 
            FROM Jobs 
            WHERE embedding_json IS NOT NULL AND embedding_json != ''
        `).get();
        console.log(`📋 Jobs with JSON embeddings: ${jobsWithJsonEmbeddings.count}`);
        
        // Check Rankings table
        const rankingsCount = db.prepare('SELECT COUNT(*) as count FROM Rankings').get();
        console.log(`🏆 Total Rankings: ${rankingsCount.count}`);
        
        console.log('\n🔬 DETAILED VECTOR ANALYSIS:');
        console.log('=' .repeat(50));
        
        if (resumesWithJsonEmbeddings.count > 0) {
            // Get sample embedding info
            const sampleResume = db.prepare(`
                SELECT candidate_id, 
                       LENGTH(content) as content_length,
                       LENGTH(embedding_json) as json_length,
                       LENGTH(embedding) as blob_length
                FROM Resumes 
                WHERE embedding_json IS NOT NULL 
                LIMIT 1
            `).get();
            
            if (sampleResume) {
                console.log(`📝 Sample Resume Analysis:`);
                console.log(`   - Candidate ID: ${sampleResume.candidate_id}`);
                console.log(`   - Content Length: ${sampleResume.content_length} characters`);
                console.log(`   - JSON Embedding Length: ${sampleResume.json_length} characters`);
                console.log(`   - BLOB Embedding Length: ${sampleResume.blob_length || 'N/A'} bytes`);
                
                // Try to parse JSON embedding to get vector dimensions
                try {
                    const embeddingJson = db.prepare(`
                        SELECT embedding_json FROM Resumes 
                        WHERE embedding_json IS NOT NULL 
                        LIMIT 1
                    `).get();
                    
                    if (embeddingJson && embeddingJson.embedding_json) {
                        const embedding = JSON.parse(embeddingJson.embedding_json);
                        console.log(`   - Vector Dimensions: ${embedding.length} (gte-base: 768, all-MiniLM-L6-v2: 384)`);
                        console.log(`   - Sample Values: [${embedding.slice(0, 5).map(v => v.toFixed(4)).join(', ')}...]`);
                    }
                } catch (error) {
                    console.log(`   - Error parsing embedding JSON: ${error.message}`);
                }
            }
        }
        
        // Check for recent data
        if (resumesCount.count > 0) {
            const recentResumes = db.prepare(`
                SELECT COUNT(*) as count 
                FROM Resumes 
                WHERE processed_at >= datetime('now', '-7 days')
            `).get();
            console.log(`📅 Resumes processed in last 7 days: ${recentResumes.count}`);
        }
        
        if (rankingsCount.count > 0) {
            const recentRankings = db.prepare(`
                SELECT COUNT(*) as count 
                FROM Rankings 
                WHERE created_at >= datetime('now', '-7 days')
            `).get();
            console.log(`🎯 Rankings created in last 7 days: ${recentRankings.count}`);
            
            // Get latest ranking stats
            const latestRanking = db.prepare(`
                SELECT j.title, r.similarity_score, r.rank_position
                FROM Rankings r
                JOIN Jobs j ON r.job_id = j.id
                ORDER BY r.created_at DESC
                LIMIT 5
            `).all();
            
            if (latestRanking.length > 0) {
                console.log(`\n🏆 Latest Rankings:`);
                latestRanking.forEach((rank, i) => {
                    console.log(`   ${i + 1}. Job: "${rank.title}" - Score: ${(rank.similarity_score * 100).toFixed(1)}% (Rank #${rank.rank_position})`);
                });
            }
        }
        
        console.log('\n� EMBEDDING MODEL USAGE:');
        console.log('=' .repeat(50));

        const modelUsage = db.prepare(`
            SELECT embedding_model, COUNT(*) as count
            FROM Resumes
            WHERE embedding_model IS NOT NULL AND embedding_model != ''
            GROUP BY embedding_model
            ORDER BY count DESC
        `).all();

        if (modelUsage.length > 0) {
            console.log('Models used to generate embeddings:');
            modelUsage.forEach(model => {
                console.log(`   - ${model.embedding_model}: ${model.count} resumes`);
            });
        } else {
            console.log('No embedding model information found in the database.');
        }

        console.log('\n�📊 SYSTEM STATUS:');
        console.log('=' .repeat(50));
        
        const hasVectorData = resumesWithJsonEmbeddings.count > 0 || resumesWithBlobEmbeddings.count > 0;
        const canRank = hasVectorData && vectorExtensionAvailable;
        
        if (hasVectorData) {
            console.log('✅ Vector embeddings found - System has processed resume data');
        } else {
            console.log('❌ No vector embeddings found - No resumes have been processed yet');
        }
        
        if (vectorExtensionAvailable) {
            console.log('✅ Vector extension available - Fast similarity search enabled');
        } else {
            console.log('⚠️ Vector extension not available - Will use fallback similarity calculation');
        }
        
        if (canRank) {
            console.log('🚀 System ready for candidate ranking!');
        } else if (hasVectorData) {
            console.log('⚠️ System can rank candidates using fallback method');
        } else {
            console.log('⏳ System needs resume data to be ingested first');
        }
        
        db.close();
        
    } catch (error) {
        if (error.code === 'SQLITE_CANTOPEN') {
            console.log('❌ Database file not found. Run the application first to create the database.');
        } else {
            console.error('❌ Error checking database:', error.message);
        }
    }
}

// Run the check
if (require.main === module) {
    checkVectorData();
}

module.exports = { checkVectorData };