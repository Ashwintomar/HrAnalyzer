// Database Setup for Hr Analyzer
// This script initializes SQLite database with sqlite-vec extension

const Database = require('better-sqlite3');
const { load } = require('sqlite-vec');
const { ensureRuntimeDirectories, getDatabasePath } = require('./core/runtimePaths');

async function setupDatabase() {
    console.log('Setting up database...');
    ensureRuntimeDirectories();
    
    // Create database file
    const dbPath = getDatabasePath();
    const db = new Database(dbPath);
    
    let vectorExtensionLoaded = false;
    
    try {
        // Load sqlite-vec extension using proper API
        console.log('Loading sqlite-vec extension...');
        load(db);
        vectorExtensionLoaded = true;
        console.log('✅ sqlite-vec extension loaded successfully');
    } catch (error) {
        console.log('⚠️ sqlite-vec extension not available, will use fallback similarity calculation');
        console.log('Error:', error.message);
    }
    
    try {
        // Create Candidates table
        console.log('Creating Candidates table...');
        db.exec(`
            CREATE TABLE IF NOT EXISTS Candidates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                email TEXT,
                phone TEXT,
                resume_url TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Create Resumes table with vector embeddings
        console.log('Creating Resumes table...');
        db.exec(`
            CREATE TABLE IF NOT EXISTS Resumes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                candidate_id INTEGER,
                content TEXT,
                embedding BLOB,
                embedding_json TEXT,
                embedding_model TEXT,
                local_file_path TEXT,
                processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (candidate_id) REFERENCES Candidates(id)
            )
        `);
        
        // Add embedding_json column if it doesn't exist (migration)
        try {
            db.exec(`ALTER TABLE Resumes ADD COLUMN embedding_json TEXT`);
            console.log('Added embedding_json column to existing Resumes table');
        } catch (error) {
            // Column already exists or other error - this is OK
            if (!error.message.includes('duplicate column name')) {
                console.log('embedding_json column already exists or other issue:', error.message);
            }
        }
        
        // Add embedding_model column if it doesn't exist (migration)
        try {
            db.exec(`ALTER TABLE Resumes ADD COLUMN embedding_model TEXT`);
            console.log('Added embedding_model column to existing Resumes table');
        } catch (error) {
            if (!error.message.includes('duplicate column name')) {
                console.log('embedding_model column already exists or other issue:', error.message);
            }
        }

        // Add local_file_path column if it doesn't exist (migration)
        try {
            db.exec(`ALTER TABLE Resumes ADD COLUMN local_file_path TEXT`);
            console.log('Added local_file_path column to existing Resumes table');
        } catch (error) {
            // Column already exists or other error - this is OK
            if (!error.message.includes('duplicate column name')) {
                console.log('local_file_path column already exists or other issue:', error.message);
            }
        }
        
        // Create Jobs table
        console.log('Creating Jobs table...');
        db.exec(`
            CREATE TABLE IF NOT EXISTS Jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                description TEXT,
                requirements TEXT,
                embedding BLOB,
                embedding_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Add embedding_json column to Jobs if it doesn't exist (migration)
        try {
            db.exec(`ALTER TABLE Jobs ADD COLUMN embedding_json TEXT`);
            console.log('Added embedding_json column to existing Jobs table');
        } catch (error) {
            // Column already exists or other error - this is OK
            if (!error.message.includes('duplicate column name')) {
                console.log('embedding_json column already exists in Jobs or other issue:', error.message);
            }
        }
        
        // Create Rankings table
        console.log('Creating Rankings table...');
        db.exec(`
            CREATE TABLE IF NOT EXISTS Rankings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER,
                candidate_id INTEGER,
                similarity_score REAL,
                rank_position INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (job_id) REFERENCES Jobs(id),
                FOREIGN KEY (candidate_id) REFERENCES Candidates(id)
            )
        `);

        // Create ResumeSources table for canonical URL duplicate detection
        console.log('Creating ResumeSources table (for duplicate detection)...');
        db.exec(`
            CREATE TABLE IF NOT EXISTS ResumeSources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                candidate_id INTEGER,
                original_url TEXT,
                canonical_key TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (candidate_id) REFERENCES Candidates(id)
            )
        `);
        try {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_resume_sources_canonical ON ResumeSources(canonical_key)`);
        } catch (e) {
            console.log('Index creation issue (ResumeSources):', e.message);
        }

        // Create JobRuns table for persisting long-running task state
        console.log('Creating JobRuns table (for progress persistence)...');
        db.exec(`
            CREATE TABLE IF NOT EXISTS JobRuns (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                label TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                stage TEXT,
                message TEXT,
                progress REAL DEFAULT 0,
                stats_json TEXT,
                metadata_json TEXT,
                logs_json TEXT,
                socket_id TEXT,
                error_message TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME,
                deleted_at DATETIME
            )
        `);
        try {
            db.exec(`CREATE INDEX IF NOT EXISTS idx_jobruns_type_status ON JobRuns(type, status)`);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_jobruns_created_at ON JobRuns(created_at DESC)`);
        } catch (e) {
            console.log('Index creation issue (JobRuns):', e.message);
        }
        
        console.log('✅ Database setup completed successfully!');
        console.log(`Database created at: ${dbPath}`);
        console.log(`Vector search enabled: ${vectorExtensionLoaded}`);
        
        return { success: true, vectorExtensionLoaded };
        
    } catch (error) {
        console.error('Error setting up database:', error);
        throw error;
    } finally {
        db.close();
    }
}

// Run setup if called directly
if (require.main === module) {
    setupDatabase().catch(console.error);
}

module.exports = { setupDatabase };
