// Script to inspect jobs in database to find the null job issue
const Database = require('better-sqlite3');
const path = require('path');

function inspectJobs() {
    console.log('🔍 Inspecting Jobs in database...\n');
    
    const dbPath = path.join(__dirname, '..', 'analyzer.db');
    const db = new Database(dbPath);
    
    try {
        // Get all jobs
        const jobs = db.prepare(`
            SELECT id, title, description, requirements, created_at 
            FROM Jobs 
            ORDER BY created_at DESC
        `).all();
        
        console.log(`Found ${jobs.length} jobs in database:\n`);
        
        jobs.forEach((job, i) => {
            console.log(`${i + 1}. Job ID: ${job.id}`);
            console.log(`   Title: ${job.title === null ? 'NULL' : `"${job.title}"`}`);
            console.log(`   Description: ${job.description === null ? 'NULL' : `"${job.description}"`}`);
            console.log(`   Requirements: ${job.requirements === null ? 'NULL' : `"${job.requirements}"`}`);
            console.log(`   Created: ${job.created_at}`);
            console.log('');
        });
        
        // Check rankings for these jobs
        if (jobs.length > 0) {
            console.log('\n🏆 Rankings for these jobs:\n');
            
            const rankings = db.prepare(`
                SELECT r.job_id, j.title, COUNT(*) as ranking_count, 
                       MIN(r.similarity_score) as min_score,
                       MAX(r.similarity_score) as max_score,
                       AVG(r.similarity_score) as avg_score
                FROM Rankings r
                JOIN Jobs j ON r.job_id = j.id
                GROUP BY r.job_id, j.title
                ORDER BY j.created_at DESC
            `).all();
            
            rankings.forEach((ranking, i) => {
                console.log(`${i + 1}. Job ID ${ranking.job_id}: "${ranking.title}"`);
                console.log(`   Rankings: ${ranking.ranking_count} candidates ranked`);
                console.log(`   Score range: ${(ranking.min_score * 100).toFixed(1)}% - ${(ranking.max_score * 100).toFixed(1)}%`);
                console.log(`   Average score: ${(ranking.avg_score * 100).toFixed(1)}%`);
                console.log('');
            });
        }
        
    } catch (error) {
        console.error('❌ Error inspecting jobs:', error.message);
    } finally {
        db.close();
    }
}

// Run the inspection
if (require.main === module) {
    inspectJobs();
}

module.exports = { inspectJobs };