// Routes for Gmail Workspace Module

const express = require('express');
const gmailWorkspaceController = require('./gmailWorkspaceController');

module.exports = (io) => {
    const router = express.Router();
    const controller = gmailWorkspaceController(io);

    // OAuth routes
    router.post('/init-auth', controller.initAuth);
    router.get('/oauth2callback', controller.oauth2Callback);
    
    // Connection test
    router.post('/test-connection', controller.testConnection);
    
    // Main resume fetching and processing
    router.post('/fetch-resumes', controller.fetchAndProcessResumes);

    return router;
};
