// Script to clean up invalid jobs with null titles
const Database = require('better-sqlite3');
const path = require('path');

function cleanupInvalidJobs() {
    console.log('🧹 Cleaning up invalid jobs with null titles...\n');
    
    const dbPath = path.join(__dirname, '..', 'analyzer.db');
    const db = new Database(dbPath);
    
    try {
        // First, check what invalid jobs exist
        const invalidJobs = db.prepare(`
            SELECT id, title, description, requirements, created_at 
            FROM Jobs 
            WHERE title IS NULL OR title = '' OR TRIM(title) = ''
        `).all();
        
        if (invalidJobs.length === 0) {
            console.log('✅ No invalid jobs found. Database is clean.');
            return;
        }
        
        console.log(`Found ${invalidJobs.length} invalid jobs with null/empty titles:`);
        invalidJobs.forEach((job, i) => {
            console.log(`   ${i + 1}. Job ID ${job.id}: Title="${job.title}", Desc="${job.description}", Reqs="${job.requirements}"`);
        });
        
        // Check how many rankings would be affected
        const affectedRankings = db.prepare(`
            SELECT COUNT(*) as count
            FROM Rankings r
            JOIN Jobs j ON r.job_id = j.id
            WHERE j.title IS NULL OR j.title = '' OR TRIM(j.title) = ''
        `).get();
        
        console.log(`\n⚠️  This will also remove ${affectedRankings.count} associated rankings.`);
        
        // Perform cleanup in a transaction
        const cleanup = db.transaction(() => {
            // Delete rankings first (foreign key constraint)
            const deleteRankingsStmt = db.prepare(`
                DELETE FROM Rankings 
                WHERE job_id IN (
                    SELECT id FROM Jobs 
                    WHERE title IS NULL OR title = '' OR TRIM(title) = ''
                )
            `);
            
            const deletedRankings = deleteRankingsStmt.run();
            console.log(`\n🗑️  Deleted ${deletedRankings.changes} rankings for invalid jobs`);
            
            // Delete invalid jobs
            const deleteJobsStmt = db.prepare(`
                DELETE FROM Jobs 
                WHERE title IS NULL OR title = '' OR TRIM(title) = ''
            `);
            
            const deletedJobs = deleteJobsStmt.run();
            console.log(`🗑️  Deleted ${deletedJobs.changes} invalid jobs`);
            
            return { deletedJobs: deletedJobs.changes, deletedRankings: deletedRankings.changes };
        });
        
        const result = cleanup();
        
        console.log(`\n✅ Cleanup completed:`);
        console.log(`   - Removed ${result.deletedJobs} invalid jobs`);
        console.log(`   - Removed ${result.deletedRankings} associated rankings`);
        console.log(`\n💡 Future jobs will be validated to prevent this issue.`);
        
    } catch (error) {
        console.error('❌ Error during cleanup:', error.message);
    } finally {
        db.close();
    }
}

// Run cleanup if called directly
if (require.main === module) {
    console.log('⚠️  This script will remove invalid jobs and their rankings from the database.');
    console.log('Press Ctrl+C to cancel, or wait 3 seconds to proceed...\n');
    
    setTimeout(() => {
        cleanupInvalidJobs();
    }, 3000);
}

module.exports = { cleanupInvalidJobs };