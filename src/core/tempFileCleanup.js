// Temporary File Cleanup Utility
// Automatically cleans old files from temp_uploads directory

const fs = require('fs');
const { getTempUploadsDir } = require('./runtimePaths');

/**
 * Clean up old temporary files from the upload directory
 * @param {number} maxAgeHours - Maximum age of files to keep (in hours)
 * @param {string} uploadDir - Directory to clean
 */
function cleanupOldTempFiles(maxAgeHours = 1, uploadDir = null) {
    const targetDir = uploadDir || getTempUploadsDir();
    
    if (!fs.existsSync(targetDir)) {
        console.log(`[TempFileCleanup] Directory does not exist: ${targetDir}`);
        return { success: true, filesRemoved: 0 };
    }

    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    let filesRemoved = 0;
    let errors = 0;

    try {
        const files = fs.readdirSync(targetDir);
        
        for (const file of files) {
            const filePath = path.join(targetDir, file);
            
            try {
                const stats = fs.statSync(filePath);
                
                // Skip directories
                if (stats.isDirectory()) continue;
                
                // Check file age
                const fileAge = now - stats.mtimeMs;
                
                if (fileAge > maxAgeMs) {
                    fs.unlinkSync(filePath);
                    filesRemoved++;
                    console.log(`[TempFileCleanup] Removed old file: ${file} (age: ${Math.round(fileAge / (60 * 60 * 1000))}h)`);
                }
            } catch (fileError) {
                errors++;
                console.warn(`[TempFileCleanup] Error processing file ${file}:`, fileError.message);
            }
        }
        
        console.log(`[TempFileCleanup] Cleanup complete. Files removed: ${filesRemoved}, Errors: ${errors}`);
        return { success: true, filesRemoved, errors };
        
    } catch (error) {
        console.error('[TempFileCleanup] Error during cleanup:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Start periodic cleanup task
 * @param {number} intervalHours - How often to run cleanup (in hours)
 * @param {number} maxAgeHours - Maximum age of files to keep (in hours)
 */
function startPeriodicCleanup(intervalHours = 6, maxAgeHours = 24) {
    console.log(`[TempFileCleanup] Starting periodic cleanup (every ${intervalHours}h, removing files older than ${maxAgeHours}h)`);
    
    // Run cleanup immediately on startup
    cleanupOldTempFiles(maxAgeHours);
    
    // Schedule periodic cleanup
    const intervalMs = intervalHours * 60 * 60 * 1000;
    const cleanupInterval = setInterval(() => {
        cleanupOldTempFiles(maxAgeHours);
    }, intervalMs);
    
    // Return cleanup function to stop the interval
    return () => {
        clearInterval(cleanupInterval);
        console.log('[TempFileCleanup] Periodic cleanup stopped');
    };
}

module.exports = {
    cleanupOldTempFiles,
    startPeriodicCleanup
};
