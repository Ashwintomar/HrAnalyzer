// Routes for Script Generator Module

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const scriptGeneratorController = require('./scriptGeneratorController');
const { getResumesDir } = require('../../core/runtimePaths');

// Configure multer for file uploads to disk for temporary storage
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = getResumesDir();
            try {
                fs.mkdirSync(dir, { recursive: true });
            } catch (err) {
                return cb(err);
            }
            cb(null, dir); // Use existing resumes folder for temp storage
        },
        filename: (req, file, cb) => {
            cb(null, `temp-${Date.now()}-${file.originalname}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit for resumes
});

module.exports = () => {
    const router = express.Router();
    const controller = scriptGeneratorController();

    router.post('/generate', upload.single('resumeFile'), controller.generateScript);
    router.post('/export-pdf', controller.exportToPdf);

    return router;
};
