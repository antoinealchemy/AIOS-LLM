// server.js - Backend API pour AIOS Chat
// npm install express cors dotenv @google/generative-ai mammoth xlsx multer @pinecone-database/pinecone @supabase/supabase-js

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pinecone } = require('@pinecone-database/pinecone');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;


// ========== CHAT MEMORY CONFIG ==========
const CHAT_CONFIG = {
    // RAM (Gemini context)
    MAX_HISTORY_GEMINI: 20,        // Sliding window
    
    // DB (Supabase limits)
    MAX_MESSAGES_PER_CHAT: 200,    // Hard limit DB
    SUGGEST_NEW_CHAT_AT: 100,      // Warning soft
    WARN_LONG_CHAT_AT: 50,         // Info
};

// Middleware
app.use(cors());
app.use(express.json());
if (process.env.NODE_ENV !== 'production') {
    app.use(express.static('.'));
}

// Configure multer for file uploads
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB max
});

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// Initialize Pinecone
const pc = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY
});

// Connect to index
const indexName = 'testt';
const index = pc.index(indexName, process.env.PINECONE_INDEX_HOST);

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// Store conversation histories
const conversations = new Map();

// Function to generate embeddings using Gemini
async function generateEmbedding(text) {
    const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
    const result = await embeddingModel.embedContent(text);
    return result.embedding.values;
}

// ========== FILE PARSERS (GEMINI NATIVE PDF) ==========

// Prepare file for Gemini based on type
async function prepareGeminiFileContent(file) {
    const { mimetype, buffer, originalname } = file;
    
    console.log(`📎 Preparing file: ${originalname} (${mimetype})`);
    
    // IMAGES - Inline base64
    if (mimetype.startsWith('image/')) {
        return {
            inlineData: {
                mimeType: mimetype,
                data: buffer.toString('base64')
            }
        };
    }
    
    // PDF - NATIVE GEMINI SUPPORT
    if (mimetype === 'application/pdf') {
        console.log('📄 PDF - Using Gemini native support');
        return {
            inlineData: {
                mimeType: 'application/pdf',
                data: buffer.toString('base64')
            }
        };
    }
    
    // DOCX
    if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const docxText = await parseDOCX(buffer);
        return { text: docxText };
    }
    
    // XLSX
    if (mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
        mimetype === 'application/vnd.ms-excel') {
        const xlsxText = await parseXLSX(buffer);
        return { text: xlsxText };
    }
    
    // JSON
    if (mimetype === 'application/json') {
        const jsonText = buffer.toString('utf-8');
        try {
            const parsed = JSON.parse(jsonText);
            return { text: JSON.stringify(parsed, null, 2) };
        } catch (e) {
            return { text: jsonText };
        }
    }
    
    // Text files
    if (mimetype.startsWith('text/') || 
        mimetype === 'application/xml' ||
        mimetype === 'text/xml' ||
        mimetype === 'text/markdown') {
        return { text: buffer.toString('utf-8') };
    }
    
    throw new Error(`Type de fichier non supporté: ${mimetype}`);
}

// Parse DOCX file
async function parseDOCX(buffer) {
    try {
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
    } catch (error) {
        console.error('DOCX parse error:', error);
        throw new Error('Impossible de lire le DOCX');
    }
}

// Parse XLSX/XLS file
async function parseXLSX(buffer) {
    try {
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        let text = '';
        
        workbook.SheetNames.forEach(sheetName => {
            const sheet = workbook.Sheets[sheetName];
            const csv = XLSX.utils.sheet_to_csv(sheet);
            text += `\n=== ${sheetName} ===\n${csv}\n`;
        });
        
        return text.trim();
    } catch (error) {
        console.error('XLSX parse error:', error);
        throw new Error('Impossible de lire le fichier Excel');
    }
}

// Parse file based on extension (for /api/upload-file endpoint)
async function parseFile(buffer, filename) {
    const ext = filename.toLowerCase().split('.').pop();
    
    switch(ext) {
        case 'pdf':
            const pdfBase64 = buffer.toString('base64');
            const result = await model.generateContent([
                {
                    inlineData: {
                        mimeType: 'application/pdf',
                        data: pdfBase64
                    }
                },
                { text: 'Extrais tout le texte de ce PDF. Donne uniquement le texte brut, sans commentaire.' }
            ]);
            const response = await result.response;
            return response.text();
        
        case 'docx':
        case 'doc':
            return await parseDOCX(buffer);
        
        case 'xlsx':
        case 'xls':
            return await parseXLSX(buffer);
        
        case 'txt':
        case 'md':
        case 'xml':
        case 'json':
        case 'csv':
            return buffer.toString('utf-8');
        
        default:
            throw new Error(`Format non supporté: .${ext}`);
    }
}

// Function to retrieve relevant context from Pinecone
async function getRelevantContext(query, topK = 3) {
    try {
        const queryEmbedding = await generateEmbedding(query);
        const queryResponse = await index.namespace('').query({
            vector: queryEmbedding,
            topK: topK,
            includeMetadata: true
        });
        
        const contexts = queryResponse.matches.map(match => {
            return `[Source: ${match.metadata?.source || 'Unknown'}]\n${match.metadata?.text || ''}`;
        });
        
        return contexts.join('\n\n---\n\n');
    } catch (error) {
        console.error('Pinecone query error:', error);
        return '';
    }
}

// Simple detection: check if message contains specific entity names from documents
function containsSpecificEntityNames(message) {
    const lowerMessage = message.toLowerCase();
    
    const entityNames = [
        'pétrin', 'petrin', 'pétrin d\'or', 'petrin d\'or',
        'rousseau', 'antoine rousseau',
        'jean moreau', 'moreau',
        'nathalie girard', 'nathalie',
        'julie martin', 'julie',
        'thomas durand', 'thomas',
        'expertise rousseau',
        'bella vita', 'tech solutions',
    ];
    
    const cabinetPhrases = [
        'notre cabinet', 'notre équipe', 'notre ca', 'notre chiffre',
        'nos clients', 'nos projets', 'nos honoraires',
        'mon cabinet', 'mon client', 'mon équipe'
    ];
    
    const hasEntity = entityNames.some(name => lowerMessage.includes(name));
    const hasCabinetPhrase = cabinetPhrases.some(phrase => lowerMessage.includes(phrase));
    
    return hasEntity || hasCabinetPhrase;
}

// ========== AUTHENTICATION MIDDLEWARE ==========
async function authenticateUser(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Token manquant' });
        }
        
        const token = authHeader.substring(7);
        
        // Verify token with Supabase
        const { data: { user }, error } = await supabase.auth.getUser(token);
        
        if (error || !user) {
            return res.status(401).json({ error: 'Token invalide' });
        }
        
        // Attach user to request
        req.user = user;
        next();
        
    } catch (error) {
        console.error('Auth middleware error:', error);
        res.status(401).json({ error: 'Authentification échouée' });
    }
}

// Middleware to check specific permission
function checkPermission(permissionName) {
    return async (req, res, next) => {
        try {
            const userId = req.user.id;
            
            // Get user with org
            const { data: user, error: userError } = await supabase
                .from('users')
                .select('*, organizations(*)')
                .eq('id', userId)
                .single();
            
            if (userError || !user) {
                return res.status(403).json({ error: 'Utilisateur non trouvé' });
            }
            
            // Admin → always allowed
            if (user.role === 'admin') {
                return next();
            }
            
            // Employee → check effective permission
            const org = user.organizations;
            const effectiveValue = user[permissionName] ?? org[`default_${permissionName}`];
            
            if (!effectiveValue) {
                return res.status(403).json({ 
                    error: 'Permission refusée',
                    permission: permissionName
                });
            }
            
            next();
            
        } catch (error) {
            console.error('Check permission error:', error);
            res.status(500).json({ error: 'Erreur vérification permission' });
        }
    };
}

// ========== QUOTA MANAGEMENT ==========

// Check if user has reached daily quota
async function checkDailyQuota(req, res, next) {
    try {
        const userId = req.user.id;
        
        // Get user permissions to know limit
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('*, organizations(*)')
            .eq('id', userId)
            .single();
        
        if (userError || !user) {
            return res.status(403).json({ error: 'Utilisateur non trouvé' });
        }
        
        // Admin → unlimited
        if (user.role === 'admin') {
            return next();
        }
        
        // Get effective limit
        const org = user.organizations;
        const limit = user.daily_prompt_limit ?? org.default_daily_prompt_limit;
        
        // If null → unlimited
        if (limit === null) {
            return next();
        }
        
        // Check today's usage
        const today = new Date().toISOString().split('T')[0];
        
        const { data: usage, error: usageError } = await supabase
            .from('daily_usage')
            .select('prompts_count')
            .eq('user_id', user.id)
            .eq('date', today)
            .single();
        
        const currentCount = usage?.prompts_count || 0;
        
        if (currentCount >= limit) {
            return res.status(429).json({ 
                error: 'Quota journalier atteint',
                limit: limit,
                used: currentCount
            });
        }
        
        // Attach current usage to request for incrementing later
        req.userDbId = user.id;
        req.currentUsage = currentCount;
        req.usageDate = today;
        
        next();
        
    } catch (error) {
        console.error('Check quota error:', error);
        // Don't block on quota check errors
        next();
    }
}

// Increment daily usage after successful prompt
async function incrementDailyUsage(userDbId, date) {
    try {
        // Try to update existing record
        const { data: existing } = await supabase
            .from('daily_usage')
            .select('*')
            .eq('user_id', userDbId)
            .eq('date', date)
            .single();
        
        if (existing) {
            // Update
            await supabase
                .from('daily_usage')
                .update({ prompts_count: existing.prompts_count + 1 })
                .eq('user_id', userDbId)
                .eq('date', date);
        } else {
            // Insert
            await supabase
                .from('daily_usage')
                .insert([{
                    user_id: userDbId,
                    date: date,
                    prompts_count: 1
                }]);
        }
        
    } catch (error) {
        console.error('Increment usage error:', error);
        // Don't throw - usage tracking shouldn't break the app
    }
}

// ========== PERMISSIONS API ==========

// GET /api/users/me/permissions - Get effective permissions for current user
app.get('/api/users/me/permissions', authenticateUser, async (req, res) => {
    try {
        if (!req.user?.id) {
            return res.status(401).json({ error: 'Non authentifié' });
        }

        const userId = req.user.id;
        
        // Get user with org
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('*, organizations(*)')
            .eq('id', userId)
            .single();
        
        if (userError) {
            console.error('User fetch error:', userError);
            return res.status(500).json({ error: 'Erreur récupération utilisateur', details: userError.message });
        }
        
        if (!user) {
            return res.status(404).json({ error: 'Utilisateur non trouvé en base' });
        }
        
        // If admin → all permissions
        if (user.role === 'admin') {
            return res.json({
                role: 'admin',
                can_upload_docs: true,
                can_edit_docs: true,
                can_delete_docs: true,
                can_use_rag: true,
                daily_prompt_limit: null,
                can_view_analytics: true,
                can_invite_users: true
            });
        }
        
        // Employee → effective permissions
        // Handle both object and array responses from Supabase
        const org = Array.isArray(user.organizations) ? user.organizations[0] : user.organizations;
        
        if (!org) {
            console.error('No organization found for user:', userId);
            return res.status(404).json({ error: 'Organisation non trouvée' });
        }
        
        const effective = {
            can_upload_docs: user.can_upload_docs ?? org.default_can_upload_docs ?? false,
            can_edit_docs: user.can_edit_docs ?? org.default_can_edit_docs ?? false,
            can_delete_docs: user.can_delete_docs ?? org.default_can_delete_docs ?? false,
            can_use_rag: user.can_use_rag ?? org.default_can_use_rag ?? false,
            daily_prompt_limit: user.daily_prompt_limit ?? org.default_daily_prompt_limit ?? 50,
            can_view_analytics: user.can_view_analytics ?? org.default_can_view_analytics ?? false,
            can_invite_users: user.can_invite_users ?? org.default_can_invite_users ?? false
        };
        
        res.json({
            role: 'employee',
            ...effective
        });
        
    } catch (error) {
        console.error('Get permissions error:', error);
        res.status(500).json({ error: 'Erreur serveur', details: error.message });
    }
});

// POST /api/chat
app.post('/api/chat', authenticateUser, checkDailyQuota, async (req, res) => {
    try {
        const { 
            message, 
            conversationId = 'default', 
            forceRAG = false,
            chatId = null
        } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message requis' });
        }

        let uiMessage = null;
        
        if (chatId) {
            const { count: messageCount } = await supabase
                .from('messages')
                .select('*', { count: 'exact' })
                .eq('chat_id', chatId);
            
            if (messageCount >= CHAT_CONFIG.MAX_MESSAGES_PER_CHAT) {
                return res.status(400).json({ 
                    error: 'chat_limit_reached',
                    message: 'Ce chat a atteint la limite de 200 messages. Créez un nouveau chat pour continuer.',
                    messageCount: messageCount
                });
            }
            
            if (messageCount >= CHAT_CONFIG.SUGGEST_NEW_CHAT_AT && messageCount < CHAT_CONFIG.SUGGEST_NEW_CHAT_AT + 2) {
                uiMessage = {
                    type: 'warning',
                    text: `💡 Ce chat a ${messageCount} messages. Pour un nouveau sujet, créez un nouveau chat.`,
                    count: messageCount
                };
            }
            else if (messageCount >= CHAT_CONFIG.WARN_LONG_CHAT_AT && messageCount < CHAT_CONFIG.WARN_LONG_CHAT_AT + 2) {
                uiMessage = {
                    type: 'info',
                    text: `ℹ️ Chat long (${messageCount} messages). Les messages les plus anciens ne sont plus dans le contexte.`,
                    count: messageCount
                };
            }
        }

        let history = conversations.get(conversationId) || [];

        if (history.length > CHAT_CONFIG.MAX_HISTORY_GEMINI) {
            const removed = history.length - CHAT_CONFIG.MAX_HISTORY_GEMINI;
            history = history.slice(-CHAT_CONFIG.MAX_HISTORY_GEMINI);
            console.log(`📦 Sliding window: gardé ${CHAT_CONFIG.MAX_HISTORY_GEMINI} messages (archivé: ${removed})`);
        }

        let needsContext = false;
        
        if (forceRAG) {
            needsContext = true;
            console.log('🔍 RAG FORCÉ par user');
        } else {
            needsContext = containsSpecificEntityNames(message);
            if (needsContext) {
                console.log('🔍 RAG AUTO détecté');
            } else {
                console.log('💡 Question générale (pas RAG)');
            }
        }
        
        let context = '';
        if (needsContext) {
            context = await getRelevantContext(message);
            console.log('📄 Context retrieved:', context ? 'Yes' : 'No');
        }

        let enhancedMessage = message;
        if (context) {
            enhancedMessage = `CONTEXTE DOCUMENTAIRE :\n${context}\n\n---\n\nQUESTION : ${message}\n\nUtilise le contexte ci-dessus pour répondre avec précision.`;
        }

        const chat = model.startChat({
            history: history,
            generationConfig: {
                temperature: 0.7,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 2048,
            },
            systemInstruction: `Tu es un assistant IA professionnel pour un cabinet d'expertise comptable.

Tu as accès à une base documentaire contenant :
- Informations clients (CA, résultats, projets, etc.)
- Données internes du cabinet

RÈGLES :
1. Si CONTEXTE DOCUMENTAIRE fourni → utilise-le pour faits/chiffres précis
2. Pour questions générales (moyennes secteur, conseils) → utilise tes connaissances
3. COMBINE les deux quand pertinent : données clients + expertise comptable

FORMATAGE Markdown systématique :
- **Gras** pour chiffres importants
- Tables pour comparaisons
- Listes pour énumérations

Sois précis, professionnel et pédagogique.`
        });

        const result = await chat.sendMessage(enhancedMessage);
        const response = await result.response;
        const aiResponse = response.text();

        history.push(
            { role: 'user', parts: [{ text: message }] },
            { role: 'model', parts: [{ text: aiResponse }] }
        );
        conversations.set(conversationId, history);

        // ⭐ Increment daily usage after successful prompt
        if (req.userDbId && req.usageDate) {
            incrementDailyUsage(req.userDbId, req.usageDate);
        }

        res.json({
            response: aiResponse,
            conversationId: conversationId,
            hasContext: !!context,
            uiMessage: uiMessage
        });

    } catch (error) {
        console.error('Gemini API Error:', error);
        res.status(500).json({ 
            error: 'Erreur serveur', 
            details: error.message 
        });
    }
});

// POST /api/chat-with-file
app.post('/api/chat-with-file', upload.single('file'), async (req, res) => {
    try {
        const { message, conversationId = 'default', chatId = null } = req.body;
        const file = req.file;

        if (!message || !file) {
            return res.status(400).json({ error: 'Message et fichier requis' });
        }

        console.log(`💬 Chat with file: ${file.originalname}`);

        let uiMessage = null;
        
        if (chatId) {
            const { count: messageCount } = await supabase
                .from('messages')
                .select('*', { count: 'exact' })
                .eq('chat_id', chatId);
            
            if (messageCount >= CHAT_CONFIG.MAX_MESSAGES_PER_CHAT) {
                return res.status(400).json({ 
                    error: 'chat_limit_reached',
                    message: 'Ce chat a atteint la limite de 200 messages.',
                    messageCount: messageCount
                });
            }
        }

        let history = conversations.get(conversationId) || [];

        if (history.length > CHAT_CONFIG.MAX_HISTORY_GEMINI) {
            const removed = history.length - CHAT_CONFIG.MAX_HISTORY_GEMINI;
            history = history.slice(-CHAT_CONFIG.MAX_HISTORY_GEMINI);
            console.log(`📦 Sliding window: gardé ${CHAT_CONFIG.MAX_HISTORY_GEMINI} messages`);
        }

        const fileContent = await prepareGeminiFileContent(file);
        const messageParts = [fileContent];
        
        if (message && message.trim()) {
            messageParts.push({ text: message });
        }

        const chat = model.startChat({
            history: history,
            generationConfig: {
                temperature: 0.7,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 2048,
            },
            systemInstruction: `Tu es un assistant IA professionnel pour un cabinet d'expertise comptable.

Quand on te fournit un fichier (image, audio, vidéo, PDF) :
- ANALYSE le contenu avec précision
- EXTRAIS les informations clés
- STRUCTURE ta réponse clairement
- Pour audio/vidéo : TRANSCRIS puis RÉSUME les points importants

Formatage Markdown :
- **Gras** pour infos critiques
- Listes pour énumérations
- Tables si pertinent

Sois précis et professionnel.`
        });

        const result = await chat.sendMessage(messageParts);
        const response = await result.response;
        const aiResponse = response.text();

        history.push(
            { 
                role: 'user', 
                parts: [{ text: `[Fichier: ${file.originalname}] ${message}` }] 
            },
            { role: 'model', parts: [{ text: aiResponse }] }
        );
        conversations.set(conversationId, history);

        res.json({
            response: aiResponse,
            conversationId: conversationId,
            fileName: file.originalname,
            uiMessage: uiMessage
        });

    } catch (error) {
        console.error('Chat with file error:', error);
        res.status(500).json({ 
            error: 'Erreur traitement fichier', 
            details: error.message 
        });
    }
});

// DELETE /api/chat/:id
app.delete('/api/chat/:id', (req, res) => {
    const { id } = req.params;
    conversations.delete(id);
    res.json({ message: 'Historique supprimé' });
});

// POST /api/upload-file
app.post('/api/upload-file', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Aucun fichier uploadé' });
        }

        const { originalname, buffer } = req.file;
        const docId = `file-${Date.now()}-${originalname.replace(/[^a-z0-9.]/gi, '-')}`;
        
        console.log(`📄 Parsing file: ${originalname}`);

        const text = await parseFile(buffer, originalname);
        
        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: 'Fichier vide ou illisible' });
        }

        console.log(`✅ Extracted ${text.length} characters from ${originalname}`);

        const MAX_CHUNK_SIZE = 8000;
        const chunks = [];
        
        if (text.length > MAX_CHUNK_SIZE) {
            for (let i = 0; i < text.length; i += MAX_CHUNK_SIZE) {
                chunks.push(text.slice(i, i + MAX_CHUNK_SIZE));
            }
            console.log(`📦 Document split into ${chunks.length} chunks`);
        } else {
            chunks.push(text);
        }

        const uploadPromises = chunks.map(async (chunk, chunkIndex) => {
            const chunkId = chunks.length > 1 ? `${docId}-chunk-${chunkIndex + 1}` : docId;
            
            const embedding = await generateEmbedding(chunk);
            
            await index.namespace('').upsert([
                {
                    id: chunkId,
                    values: embedding,
                    metadata: {
                        text: chunk,
                        source: originalname,
                        uploadedAt: new Date().toISOString(),
                        chunkIndex: chunkIndex,
                        totalChunks: chunks.length
                    }
                }
            ]);
            
            return chunkId;
        });

        const uploadedIds = await Promise.all(uploadPromises);
        
        console.log(`✅ File uploaded: ${uploadedIds.join(', ')}`);

        res.json({
            success: true,
            ids: uploadedIds,
            chunks: chunks.length,
            message: `Fichier "${originalname}" ajouté (${chunks.length} chunks, ${text.length} caractères)`
        });

    } catch (error) {
        console.error('File upload error:', error);
        res.status(500).json({ 
            error: 'Erreur upload fichier', 
            details: error.message 
        });
    }
});

// POST /api/upload-document
app.post('/api/upload-document', authenticateUser, checkPermission('can_upload_docs'), async (req, res) => {
    try {
        const { id, text, source = 'manual' } = req.body;

        if (!id || !text) {
            return res.status(400).json({ error: 'id et text requis' });
        }

        console.log(`📄 Uploading document: ${id}`);

        const MAX_CHUNK_SIZE = 8000;
        const chunks = [];
        
        if (text.length > MAX_CHUNK_SIZE) {
            for (let i = 0; i < text.length; i += MAX_CHUNK_SIZE) {
                chunks.push(text.slice(i, i + MAX_CHUNK_SIZE));
            }
            console.log(`📦 Document split into ${chunks.length} chunks`);
        } else {
            chunks.push(text);
        }

        const uploadPromises = chunks.map(async (chunk, chunkIndex) => {
            const chunkId = chunks.length > 1 ? `${id}-chunk-${chunkIndex + 1}` : id;
            
            const embedding = await generateEmbedding(chunk);
            
            await index.namespace('').upsert([
                {
                    id: chunkId,
                    values: embedding,
                    metadata: {
                        text: chunk,
                        source: source,
                        uploadedAt: new Date().toISOString(),
                        chunkIndex: chunkIndex,
                        totalChunks: chunks.length
                    }
                }
            ]);
            
            return chunkId;
        });

        const uploadedIds = await Promise.all(uploadPromises);
        
        console.log(`✅ Document uploaded: ${uploadedIds.join(', ')}`);

        res.json({
            success: true,
            ids: uploadedIds,
            chunks: chunks.length,
            message: chunks.length > 1 
                ? `Document divisé en ${chunks.length} morceaux et ajouté à Pinecone`
                : 'Document ajouté à Pinecone'
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ 
            error: 'Erreur upload', 
            details: error.message 
        });
    }
});

// GET /api/documents
app.get('/api/documents', async (req, res) => {
    try {
        const queryResponse = await index.namespace('').query({
            vector: new Array(768).fill(0),
            topK: 10000,
            includeMetadata: true
        });
        
        const documentsMap = new Map();
        
        queryResponse.matches.forEach(match => {
            const baseId = match.id.replace(/-chunk-\d+$/, '');
            
            if (!documentsMap.has(baseId)) {
                documentsMap.set(baseId, {
                    id: baseId,
                    source: match.metadata?.source || 'Unknown',
                    uploadedAt: match.metadata?.uploadedAt || new Date().toISOString(),
                    chunks: []
                });
            }
            
            documentsMap.get(baseId).chunks.push({
                id: match.id,
                chunkIndex: match.metadata?.chunkIndex || 0
            });
        });
        
        const documents = Array.from(documentsMap.values()).map(doc => ({
            ...doc,
            chunkCount: doc.chunks.length
        }));
        
        console.log(`📋 Listed ${documents.length} documents`);
        
        res.json({ documents });
        
    } catch (error) {
        console.error('List documents error:', error);
        res.status(500).json({ 
            error: 'Erreur liste documents', 
            details: error.message 
        });
    }
});

// GET /api/documents/:id
app.get('/api/documents/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        console.log(`📖 Getting document: ${id}`);
        
        const queryResponse = await index.namespace('').query({
            vector: new Array(768).fill(0),
            topK: 10000,
            includeMetadata: true
        });
        
        const chunks = queryResponse.matches
            .filter(match => match.id === id || match.id.startsWith(`${id}-chunk-`))
            .sort((a, b) => (a.metadata?.chunkIndex || 0) - (b.metadata?.chunkIndex || 0));
        
        if (chunks.length === 0) {
            return res.status(404).json({ error: 'Document non trouvé' });
        }
        
        const fullText = chunks.map(chunk => chunk.metadata?.text || '').join('');
        const source = chunks[0].metadata?.source || 'Unknown';
        const uploadedAt = chunks[0].metadata?.uploadedAt || new Date().toISOString();
        
        console.log(`✅ Retrieved document: ${id} (${chunks.length} chunks)`);
        
        res.json({ 
            id,
            source,
            uploadedAt,
            text: fullText,
            chunkCount: chunks.length
        });
        
    } catch (error) {
        console.error('Get document error:', error);
        res.status(500).json({ 
            error: 'Erreur récupération document', 
            details: error.message 
        });
    }
});

// DELETE /api/documents/:id
app.delete('/api/documents/:id', authenticateUser, checkPermission('can_delete_docs'), async (req, res) => {
    try {
        const { id } = req.params;
        
        console.log(`🗑️ Deleting document: ${id}`);
        
        const queryResponse = await index.namespace('').query({
            vector: new Array(768).fill(0),
            topK: 10000,
            includeMetadata: true
        });
        
        const chunkIds = queryResponse.matches
            .filter(match => match.id === id || match.id.startsWith(`${id}-chunk-`))
            .map(match => match.id);
        
        if (chunkIds.length === 0) {
            return res.status(404).json({ error: 'Document non trouvé' });
        }
        
        await index.namespace('').deleteMany(chunkIds);
        
        console.log(`✅ Deleted ${chunkIds.length} chunks for document: ${id}`);
        
        res.json({ 
            success: true, 
            deletedChunks: chunkIds.length,
            message: `Document supprimé (${chunkIds.length} morceaux)` 
        });
        
    } catch (error) {
        console.error('Delete document error:', error);
        res.status(500).json({ 
            error: 'Erreur suppression document', 
            details: error.message 
        });
    }
});

// GET /api/pinecone-stats
app.get('/api/pinecone-stats', async (req, res) => {
    try {
        const stats = await index.describeIndexStats();
        res.json(stats);
    } catch (error) {
        console.error('Stats error:', error);
        res.json({ error: 'Erreur stats' });
    }
});

// ========== CHATS ENDPOINTS ==========

// GET /api/chats
app.get('/api/chats', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ error: 'Non autorisé' });
        }

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
            return res.status(401).json({ error: 'Non autorisé' });
        }

        const { data, error } = await supabase
            .from('chats')
            .select('*')
            .eq('user_id', user.id)
            .order('updated_at', { ascending: false });

        if (error) throw error;

        res.json({ chats: data });
    } catch (error) {
        console.error('List chats error:', error);
        res.status(500).json({ error: 'Erreur chargement chats' });
    }
});

// POST /api/chats
app.post('/api/chats', async (req, res) => {
    try {
        const { title = 'Nouvelle conversation' } = req.body;

        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ error: 'Non autorisé' });
        }

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: authError } = await supabase.auth.getUser(token);

        if (authError || !user) {
            return res.status(401).json({ error: 'Non autorisé' });
        }

        const { data, error } = await supabase
            .from('chats')
            .insert([{ title, user_id: user.id }])
            .select()
            .single();

        if (error) throw error;

        res.json({ chat: data });
    } catch (error) {
        console.error('Create chat error:', error);
        res.status(500).json({ error: 'Erreur création chat' });
    }
});

// GET /api/chats/:id
app.get('/api/chats/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const { data: chat, error: chatError } = await supabase
            .from('chats')
            .select('*')
            .eq('id', id)
            .single();

        if (chatError) throw chatError;

        const { data: messages, error: messagesError } = await supabase
            .from('messages')
            .select('*')
            .eq('chat_id', id)
            .order('created_at', { ascending: true });

        if (messagesError) throw messagesError;

        res.json({ chat, messages });
    } catch (error) {
        console.error('Get chat error:', error);
        res.status(500).json({ error: 'Erreur chargement chat' });
    }
});

// PUT /api/chats/:id
app.put('/api/chats/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { title } = req.body;

        const { data, error } = await supabase
            .from('chats')
            .update({ title })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        res.json({ chat: data });
    } catch (error) {
        console.error('Update chat error:', error);
        res.status(500).json({ error: 'Erreur mise à jour chat' });
    }
});

// DELETE /api/chats/:id
app.delete('/api/chats/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabase
            .from('chats')
            .delete()
            .eq('id', id);

        if (error) throw error;

        res.json({ success: true, message: 'Chat supprimé' });
    } catch (error) {
        console.error('Delete chat error:', error);
        res.status(500).json({ error: 'Erreur suppression chat' });
    }
});

// POST /api/chats/:id/messages
app.post('/api/chats/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const { role, content } = req.body;

        if (!role || !content) {
            return res.status(400).json({ error: 'role et content requis' });
        }

        const { data, error } = await supabase
            .from('messages')
            .insert([{ chat_id: id, role, content }])
            .select()
            .single();

        if (error) throw error;

        await supabase
            .from('chats')
            .update({ updated_at: new Date().toISOString() })
            .eq('id', id);

        res.json({ message: data });
    } catch (error) {
        console.error('Add message error:', error);
        res.status(500).json({ error: 'Erreur ajout message' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        model: 'gemini-2.0-flash-lite-001',
        pdfSupport: 'native',
        ragToggle: 'enabled'
    });
});

// ========== USER MANAGEMENT ==========

// Function to generate org code
function generateOrgCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'ORG-';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// POST /api/validate-admin-code
app.post('/api/validate-admin-code', async (req, res) => {
    try {
        const { admin_code } = req.body;
        const ADMIN_SECRET = process.env.ADMIN_SECRET_CODE || 'AIOS-ADMIN-2025';
        
        res.json({ valid: admin_code === ADMIN_SECRET });
    } catch (error) {
        res.status(500).json({ valid: false });
    }
});

// POST /api/organizations/validate
app.post('/api/organizations/validate', async (req, res) => {
    try {
        const { org_code } = req.body;
        
        const { data, error } = await supabase
            .from('organizations')
            .select('id, name')
            .eq('org_code', org_code.trim().toUpperCase())
            .single();
        
        if (error || !data) {
            return res.json({ valid: false });
        }
        
        res.json({ 
            valid: true,
            org_id: data.id,
            org_name: data.name
        });
    } catch (error) {
        res.json({ valid: false });
    }
});

// POST /api/users/signup
app.post('/api/users/signup', async (req, res) => {
    try {
        const { email, password, first_name, role, company_name, admin_code, org_code } = req.body;

        if (!email || !first_name || !role) {
            return res.status(400).json({ 
                success: false,
                error: 'Données manquantes (email, first_name, role requis)' 
            });
        }

        const ADMIN_SECRET = process.env.ADMIN_SECRET_CODE || 'AIOS-ADMIN-2025';
        let organizationId = null;
        let generatedOrgCode = null;

        if (role === 'admin') {
            if (!company_name || !admin_code) {
                return res.status(400).json({ 
                    success: false,
                    error: 'Nom entreprise et code admin requis pour administrateur' 
                });
            }

            if (admin_code !== ADMIN_SECRET) {
                return res.status(403).json({ 
                    success: false,
                    error: 'Code administrateur incorrect' 
                });
            }

            generatedOrgCode = generateOrgCode();
            
            let isUnique = false;
            let attempts = 0;
            while (!isUnique && attempts < 10) {
                const { data: existing } = await supabase
                    .from('organizations')
                    .select('id')
                    .eq('org_code', generatedOrgCode)
                    .single();
                
                if (!existing) {
                    isUnique = true;
                } else {
                    generatedOrgCode = generateOrgCode();
                    attempts++;
                }
            }

            const { data: org, error: orgError } = await supabase
                .from('organizations')
                .insert([{ 
                    name: company_name,
                    org_code: generatedOrgCode
                }])
                .select()
                .single();

            if (orgError) {
                console.error('Organization creation error:', orgError);
                throw new Error('Erreur création organisation');
            }

            organizationId = org.id;
            console.log(`✅ Organization created: ${company_name} (${generatedOrgCode})`);
        }

        if (role === 'employee') {
            if (!org_code) {
                return res.status(400).json({ 
                    success: false,
                    error: 'Code organisation requis pour employé' 
                });
            }

            const { data: org, error: orgError } = await supabase
                .from('organizations')
                .select('id')
                .eq('org_code', org_code.trim().toUpperCase())
                .single();

            if (orgError || !org) {
                return res.status(404).json({ 
                    success: false,
                    error: 'Organisation introuvable (code invalide)' 
                });
            }

            organizationId = org.id;
            console.log(`Employee joining org: ${org_code}`);
        }

        const tempUserData = {
            email: email,
            first_name: first_name,
            role: role,
            organization_id: organizationId
        };

        const response = {
            success: true,
            role: role,
            temp_user_data: tempUserData
        };

        if (role === 'admin') {
            response.org_code = generatedOrgCode;
        }

        res.json(response);

    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ 
            success: false,
            error: error.message || 'Erreur création compte' 
        });
    }
});

// POST /api/users/link-auth
app.post('/api/users/link-auth', async (req, res) => {
    try {
        const { user_id, email, first_name, role, organization_id } = req.body;

        if (!user_id || !email) {
            return res.status(400).json({
                success: false,
                error: 'user_id et email requis'
            });
        }

        const { data: user, error: userError } = await supabase
            .from('users')
            .insert([{ 
                id: user_id,
                email: email,
                first_name: first_name,
                role: role,
                organization_id: organization_id
            }])
            .select()
            .single();

        if (userError) {
            console.error('User profile creation error:', userError);
            throw new Error('Erreur création profil utilisateur');
        }

        console.log(`✅ User profile linked: ${email} (${role})`);

        res.json({
            success: true,
            user: user
        });

    } catch (error) {
        console.error('Link auth error:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Erreur liaison compte'
        });
    }
});

// Export pour Vercel Serverless
if (typeof module !== 'undefined' && module.exports) {
    module.exports = app;
}

// Listen
const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME;

if (!isServerless) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📄 PDF support: Gemini native (no pdf-parse)`);
        console.log(`🤖 Model: gemini-2.0-flash-lite-001`);
        console.log(`🔍 RAG Toggle: Manual + Auto detection`);
        console.log(`💾 Chat limits: ${CHAT_CONFIG.MAX_MESSAGES_PER_CHAT} messages/chat, ${CHAT_CONFIG.MAX_HISTORY_GEMINI} context window`);
    });
}