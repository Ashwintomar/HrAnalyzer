// Routes for Candidate Analyzer Module

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const analyzerController = require('./analyzerController');
const { ensureRuntimeDirectories, getTempUploadsDir } = require('../../core/runtimePaths');

// Create temporary upload directory
ensureRuntimeDirectories();
const uploadDir = getTempUploadsDir();

// Configure multer for file uploads with disk storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Generate unique filename with timestamp and random suffix
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, uniqueSuffix + '-' + sanitizedName);
    }
});

// Single file upload (for Excel ingestion)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { 
        fileSize: 10 * 1024 * 1024 // 10MB limit per file
    }
});

// Bulk upload configuration (for PDF and mixed uploads) - stores to disk
const bulkUpload = multer({
    storage: storage,
    limits: { 
        fileSize: 10 * 1024 * 1024, // 10MB limit per file (not total)
        files: 5000 // Maximum 5000 files
    },
    fileFilter: function (req, file, cb) {
        // Accept PDF, Excel, and CSV files
        const allowedExtensions = /\.(pdf|xlsx|xls|csv)$/i;
        if (allowedExtensions.test(file.originalname)) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF, Excel (.xlsx, .xls), and CSV files are allowed'));
        }
    }
});

module.exports = (io) => {
    const router = express.Router();
    const controller = analyzerController(io); // Initialize controller with io

    // Note: The routes are now relative to /api/analyzer
    router.post('/analyze', upload.single('resumeFile'), controller.analyzeAndRank);
    router.post('/ingest-candidates', upload.single('resumeFile'), controller.ingestCandidates);
    router.post('/rank-existing', controller.rankExisting);
    router.post('/recycle-vectors', controller.recycleVectors);
    router.post('/export-results', controller.exportResults);
    router.post('/bulk-ingest', bulkUpload.array('files', 5000), controller.bulkIngest);
    router.post('/bulk-excel-ingest', bulkUpload.array('excelFiles', 5000), controller.bulkExcelIngest);
    router.get('/view-resume', controller.viewResume);

    // Jobs history
    router.get('/jobs', controller.listJobs);
    router.get('/jobs/:id', controller.getJobDetails);
    router.delete('/jobs', controller.dropAllJobs);

    // Module management
    router.post('/shutdown', controller.shutdownModule);

    return router;
};
