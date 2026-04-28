// Gmail Workspace Service - Gmail API Integration
// Handles OAuth, email fetching, and PDF extraction

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class GmailService {
    constructor() {
        this.oauth2Client = null;
        this.gmail = null;
    }

    /**
     * Initialize OAuth2 client with credentials
     * @param {Object} credentials - { clientId, clientSecret, redirectUri }
     * @param {string} tokens - Optional access/refresh tokens
     */
    initializeAuth(credentials, tokens = null) {
        const { clientId, clientSecret, redirectUri } = credentials;
        
        this.oauth2Client = new google.auth.OAuth2(
            clientId,
            clientSecret,
            redirectUri || 'http://localhost:3000/api/gmail-workspace/oauth2callback'
        );

        if (tokens) {
            this.oauth2Client.setCredentials(tokens);
        }

        this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    }

    /**
     * Get authorization URL for user to grant access
     */
    getAuthUrl() {
        if (!this.oauth2Client) {
            throw new Error('OAuth2 client not initialized');
        }

        const scopes = [
            'https://www.googleapis.com/auth/gmail.readonly'
        ];

        return this.oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent' // Force consent to get refresh token
        });
    }

    /**
     * Exchange authorization code for tokens
     * @param {string} code - Authorization code from OAuth callback
     */
    async getTokensFromCode(code) {
        if (!this.oauth2Client) {
            throw new Error('OAuth2 client not initialized');
        }

        const { tokens } = await this.oauth2Client.getToken(code);
        this.oauth2Client.setCredentials(tokens);
        
        return tokens;
    }

    /**
     * Refresh access token if expired
     */
    async refreshAccessToken() {
        if (!this.oauth2Client) {
            throw new Error('OAuth2 client not initialized');
        }

        const { credentials } = await this.oauth2Client.refreshAccessToken();
        this.oauth2Client.setCredentials(credentials);
        return credentials;
    }

    /**
     * Build Gmail search query from filters
     * @param {Object} filters - { days, textFilter }
     */
    buildSearchQuery(filters) {
        const { days, textFilter } = filters;
        let query = 'has:attachment filename:pdf';

        if (days && days > 0) {
            const daysAgo = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
            query += ` after:${daysAgo}`;
        }

        if (textFilter && textFilter.trim()) {
            // Escape special characters and add to query
            const sanitized = textFilter.trim().replace(/["\\]/g, '\\$&');
            query += ` (subject:"${sanitized}" OR "${sanitized}")`;
        }

        return query;
    }

    /**
     * Fetch emails matching filters
     * @param {Object} filters - { days, textFilter }
     * @param {Function} progressCallback - Called with progress updates
     */
    async fetchEmails(filters, progressCallback = null) {
        if (!this.gmail) {
            throw new Error('Gmail API not initialized');
        }

        const query = this.buildSearchQuery(filters);
        const emails = [];
        let pageToken = null;
        let totalFetched = 0;

        try {
            do {
                const response = await this.gmail.users.messages.list({
                    userId: 'me',
                    q: query,
                    maxResults: 100,
                    pageToken: pageToken
                });

                const messages = response.data.messages || [];
                
                for (const message of messages) {
                    totalFetched++;
                    
                    if (progressCallback) {
                        progressCallback({
                            type: 'email_scanned',
                            count: totalFetched,
                            messageId: message.id
                        });
                    }

                    emails.push(message.id);
                }

                pageToken = response.data.nextPageToken;
            } while (pageToken);

            return emails;
        } catch (error) {
            console.error('Error fetching emails:', error);
            throw new Error(`Failed to fetch emails: ${error.message}`);
        }
    }

    /**
     * Get email details and extract PDF attachments
     * @param {string} messageId - Gmail message ID
     * @param {string} downloadPath - Path to save attachments
     */
    async getEmailWithAttachments(messageId, downloadPath) {
        if (!this.gmail) {
            throw new Error('Gmail API not initialized');
        }

        try {
            // Get message details
            const message = await this.gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'full'
            });

            const pdfAttachments = [];
            const parts = message.data.payload.parts || [];

            // Extract subject for context
            const headers = message.data.payload.headers || [];
            const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
            const subject = subjectHeader ? subjectHeader.value : 'No Subject';

            // Find PDF attachments
            for (const part of parts) {
                if (part.filename && part.filename.toLowerCase().endsWith('.pdf')) {
                    const attachment = await this.gmail.users.messages.attachments.get({
                        userId: 'me',
                        messageId: messageId,
                        id: part.body.attachmentId
                    });

                    // Decode base64 data
                    const data = Buffer.from(attachment.data.data, 'base64');
                    
                    // Sanitize filename
                    const sanitizedFilename = part.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
                    const filepath = path.join(downloadPath, `gmail_${Date.now()}_${sanitizedFilename}`);
                    
                    // Save to disk
                    fs.writeFileSync(filepath, data);

                    pdfAttachments.push({
                        filename: part.filename,
                        filepath: filepath,
                        size: part.body.size,
                        messageId: messageId,
                        subject: subject
                    });
                }
            }

            return pdfAttachments;
        } catch (error) {
            console.error(`Error getting email ${messageId}:`, error);
            throw new Error(`Failed to get email attachments: ${error.message}`);
        }
    }

    /**
     * Test connection to Gmail API
     */
    async testConnection() {
        if (!this.gmail) {
            throw new Error('Gmail API not initialized');
        }

        try {
            const response = await this.gmail.users.getProfile({
                userId: 'me'
            });

            return {
                success: true,
                email: response.data.emailAddress,
                messagesTotal: response.data.messagesTotal
            };
        } catch (error) {
            console.error('Error testing Gmail connection:', error);
            throw new Error(`Connection test failed: ${error.message}`);
        }
    }
}

module.exports = new GmailService();
