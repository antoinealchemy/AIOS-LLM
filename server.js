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
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite-001' });

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
        // Pretty print JSON for better readability
        try {
            const parsed = JSON.parse(jsonText);
            return { text: JSON.stringify(parsed, null, 2) };
        } catch (e) {
            // Si parsing fail, retourne brut
            return { text: jsonText };
        }
    }
    
    // Text files (txt, md, xml, csv, etc)
    if (mimetype.startsWith('text/') || 
        mimetype === 'application/xml' ||
        mimetype === 'text/xml' ||
        mimetype === 'text/markdown') {
        return { text: buffer.toString('utf-8') };
    }
    
    // AUDIO/VIDEO - Not supported
    if (mimetype.startsWith('audio/') || mimetype.startsWith('video/')) {
        throw new Error('Les fichiers audio/vidéo ne sont pas encore supportés. Utilisez uniquement images, PDF ou texte pour le moment.');
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
            // For upload-file, we need text extraction
            // Use Gemini to extract text from PDF
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
        // Generate embedding for query
        const queryEmbedding = await generateEmbedding(query);
        
        // Query Pinecone
        const queryResponse = await index.namespace('').query({
            vector: queryEmbedding,
            topK: topK,
            includeMetadata: true
        });
        
        // Extract and format context
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
    
    // Liste des noms propres SPÉCIFIQUES dans tes documents
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
    
    // Expressions possessives du cabinet
    const cabinetPhrases = [
        'notre cabinet', 'notre équipe', 'notre ca', 'notre chiffre',
        'nos clients', 'nos projets', 'nos honoraires',
        'mon cabinet', 'mon client', 'mon équipe'
    ];
    
    // Check si message contient entité spécifique
    const hasEntity = entityNames.some(name => lowerMessage.includes(name));
    const hasCabinetPhrase = cabinetPhrases.some(phrase => lowerMessage.includes(phrase));
    
    return hasEntity || hasCabinetPhrase;
}

// POST /api/chat - Send message and get AI response with intelligent RAG
app.post('/api/chat', async (req, res) => {
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

        // ========== CHECK DB LIMIT FIRST ==========
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
            
            // UI warnings basés sur count DB
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
        // ========== END DB CHECK ==========

        // Get or create conversation history (RAM)
        let history = conversations.get(conversationId) || [];

        // ========== RAM MEMORY MANAGEMENT ==========
        
        // Sliding window (garde contexte récent)
        if (history.length > CHAT_CONFIG.MAX_HISTORY_GEMINI) {
            const removed = history.length - CHAT_CONFIG.MAX_HISTORY_GEMINI;
            history = history.slice(-CHAT_CONFIG.MAX_HISTORY_GEMINI);
            console.log(`📦 Sliding window: gardé ${CHAT_CONFIG.MAX_HISTORY_GEMINI} messages (archivé: ${removed})`);
        }
        
        // ========== END MEMORY MANAGEMENT ==========

        // ========== RAG DETECTION ==========
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

        // Build enhanced prompt
        let enhancedMessage = message;
        if (context) {
            enhancedMessage = `CONTEXTE DOCUMENTAIRE :\n${context}\n\n---\n\nQUESTION : ${message}\n\nUtilise le contexte ci-dessus pour répondre avec précision.`;
        }

        // Start chat with history and system instruction
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

        // Send message
        const result = await chat.sendMessage(enhancedMessage);
        const response = await result.response;
        const aiResponse = response.text();

        // Update history (store original message, not enhanced one)
        history.push(
            { role: 'user', parts: [{ text: message }] },
            { role: 'model', parts: [{ text: aiResponse }] }
        );
        conversations.set(conversationId, history);

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

// POST /api/chat-with-file - Send message with file attachment (image/audio/video/pdf)
app.post('/api/chat-with-file', upload.single('file'), async (req, res) => {
    try {
        const { message, conversationId = 'default', chatId = null } = req.body;
        const file = req.file;

        if (!message || !file) {
            return res.status(400).json({ error: 'Message et fichier requis' });
        }

        console.log(`💬 Chat with file: ${file.originalname}`);

        // ========== CHECK DB LIMIT ==========
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
        // ========== END DB CHECK ==========

        // Get or create conversation history
        let history = conversations.get(conversationId) || [];

        // ========== RAM SLIDING WINDOW ==========
        if (history.length > CHAT_CONFIG.MAX_HISTORY_GEMINI) {
            const removed = history.length - CHAT_CONFIG.MAX_HISTORY_GEMINI;
            history = history.slice(-CHAT_CONFIG.MAX_HISTORY_GEMINI);
            console.log(`📦 Sliding window: gardé ${CHAT_CONFIG.MAX_HISTORY_GEMINI} messages`);
        }

        // Prepare file content for Gemini
        const fileContent = await prepareGeminiFileContent(file);

        // Build message parts
        const messageParts = [fileContent];
        
        // Add text message if provided
        if (message && message.trim()) {
            messageParts.push({ text: message });
        }

        // Start chat with history
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

        // Send message with file
        const result = await chat.sendMessage(messageParts);
        const response = await result.response;
        const aiResponse = response.text();

        // Update history with text representation
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

// DELETE /api/chat/:id - Clear conversation history
app.delete('/api/chat/:id', (req, res) => {
    const { id } = req.params;
    conversations.delete(id);
    res.json({ message: 'Historique supprimé' });
});

// POST /api/upload-file - Upload file (binary) to Pinecone
app.post('/api/upload-file', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Aucun fichier uploadé' });
        }

        const { originalname, buffer } = req.file;
        const docId = `file-${Date.now()}-${originalname.replace(/[^a-z0-9.]/gi, '-')}`;
        
        console.log(`📄 Parsing file: ${originalname}`);

        // Parse file based on type
        const text = await parseFile(buffer, originalname);
        
        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: 'Fichier vide ou illisible' });
        }

        console.log(`✅ Extracted ${text.length} characters from ${originalname}`);

        // Chunk text if too large
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

        // Upload each chunk
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

// POST /api/upload-document - Upload document to Pinecone
app.post('/api/upload-document', async (req, res) => {
    try {
        const { id, text, source = 'manual' } = req.body;

        if (!id || !text) {
            return res.status(400).json({ error: 'id et text requis' });
        }

        console.log(`📄 Uploading document: ${id}`);

        // Chunk text if too large (Pinecone metadata limit = 40KB)
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

        // Upload each chunk
        const uploadPromises = chunks.map(async (chunk, chunkIndex) => {
            const chunkId = chunks.length > 1 ? `${id}-chunk-${chunkIndex + 1}` : id;
            
            // Generate embedding
            const embedding = await generateEmbedding(chunk);
            
            // Upsert to Pinecone
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

// GET /api/documents - List all documents in Pinecone
app.get('/api/documents', async (req, res) => {
    try {
        // Query all vectors from Pinecone (get metadata)
        const queryResponse = await index.namespace('').query({
            vector: new Array(768).fill(0), // Dummy vector
            topK: 10000,
            includeMetadata: true
        });
        
        // Group chunks by base document ID
        const documentsMap = new Map();
        
        queryResponse.matches.forEach(match => {
            // Extract base ID (remove -chunk-X suffix if present)
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
        
        // Convert map to array and add chunk count
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

// GET /api/documents/:id - Get document text
app.get('/api/documents/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        console.log(`📖 Getting document: ${id}`);
        
        // Find all chunks for this document
        const queryResponse = await index.namespace('').query({
            vector: new Array(768).fill(0),
            topK: 10000,
            includeMetadata: true
        });
        
        // Filter and sort chunks
        const chunks = queryResponse.matches
            .filter(match => match.id === id || match.id.startsWith(`${id}-chunk-`))
            .sort((a, b) => (a.metadata?.chunkIndex || 0) - (b.metadata?.chunkIndex || 0));
        
        if (chunks.length === 0) {
            return res.status(404).json({ error: 'Document non trouvé' });
        }
        
        // Reconstruct text from chunks
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

// DELETE /api/documents/:id - Delete document from Pinecone
app.delete('/api/documents/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        console.log(`🗑️ Deleting document: ${id}`);
        
        // Find all chunks for this document
        const queryResponse = await index.namespace('').query({
            vector: new Array(768).fill(0),
            topK: 10000,
            includeMetadata: true
        });
        
        // Filter chunks belonging to this document
        const chunkIds = queryResponse.matches
            .filter(match => match.id === id || match.id.startsWith(`${id}-chunk-`))
            .map(match => match.id);
        
        if (chunkIds.length === 0) {
            return res.status(404).json({ error: 'Document non trouvé' });
        }
        
        // Delete all chunks
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

// GET /api/pinecone-stats - Get index statistics
app.get('/api/pinecone-stats', async (req, res) => {
    try {
        const stats = await index.describeIndexStats();
        res.json(stats);
    } catch (error) {
        console.error('Stats error:', error);
        res.json({ error: 'Erreur stats' });
    }
});

// ========== CHATS ENDPOINTS (Supabase) ==========

// GET /api/chats - List all chats
app.get('/api/chats', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('chats')
            .select('*')
            .order('updated_at', { ascending: false });

        if (error) throw error;

        res.json({ chats: data });
    } catch (error) {
        console.error('List chats error:', error);
        res.status(500).json({ error: 'Erreur chargement chats' });
    }
});

// POST /api/chats - Create new chat
app.post('/api/chats', async (req, res) => {
    try {
        const { title = 'Nouvelle conversation' } = req.body;

        const { data, error } = await supabase
            .from('chats')
            .insert([{ title, user_id: '00000000-0000-0000-0000-000000000000' }])
            .select()
            .single();

        if (error) throw error;

        res.json({ chat: data });
    } catch (error) {
        console.error('Create chat error:', error);
        res.status(500).json({ error: 'Erreur création chat' });
    }
});

// GET /api/chats/:id - Get chat with messages
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

// PUT /api/chats/:id - Update chat title
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

// DELETE /api/chats/:id - Delete chat
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

// POST /api/chats/:id/messages - Add message to chat
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

// POST /api/users/signup - Complete signup with organizations
app.post('/api/users/signup', async (req, res) => {
    try {
        const { user_id, email, first_name, role, company_name, admin_code, org_code } = req.body;

        if (!user_id || !email || !first_name || !role) {
            return res.status(400).json({ 
                success: false,
                error: 'Données manquantes (user_id, email, first_name, role requis)' 
            });
        }

        const ADMIN_SECRET = process.env.ADMIN_SECRET_CODE || 'AIOS-ADMIN-2025';
        let organizationId = null;
        let generatedOrgCode = null;

        // ===== ADMIN: Create organization =====
        if (role === 'admin') {
            if (!company_name || !admin_code) {
                return res.status(400).json({ 
                    success: false,
                    error: 'Nom entreprise et code admin requis pour administrateur' 
                });
            }

            // Verify admin code
            if (admin_code !== ADMIN_SECRET) {
                return res.status(403).json({ 
                    success: false,
                    error: 'Code administrateur incorrect' 
                });
            }

            // Generate unique org code
            generatedOrgCode = generateOrgCode();
            
            // Check uniqueness
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

            // Create organization
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

        // ===== EMPLOYEE: Join existing organization =====
        if (role === 'employee') {
            if (!org_code) {
                return res.status(400).json({ 
                    success: false,
                    error: 'Code organisation requis pour employé' 
                });
            }

            // Find organization
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

        // ===== Create user profile =====
        const { data: user, error: userError } = await supabase
            .from('users')
            .insert([{ 
                id: user_id,
                email: email,
                first_name: first_name,
                role: role,
                organization_id: organizationId
            }])
            .select()
            .single();

        if (userError) {
            console.error('User creation error:', userError);
            throw new Error('Erreur création utilisateur');
        }

        console.log(`✅ User created: ${email} (${role})`);

        // Response
        const response = {
            success: true,
            role: role,
            user: user
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

// Function to generate org code
function generateOrgCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No O, I, 0, 1
    let code = 'ORG-';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// POST /api/users - DEPRECATED (keep for backward compatibility)
app.post('/api/users', async (req, res) => {
    try {
        const { user_id, email, admin_code } = req.body;

        if (!user_id || !email) {
            return res.status(400).json({ 
                success: false,
                error: 'user_id et email requis' 
            });
        }

        // Check admin code
        const ADMIN_SECRET = process.env.ADMIN_SECRET_CODE || 'AIOS-ADMIN-2025';
        const role = (admin_code === ADMIN_SECRET) ? 'admin' : 'employee';

        console.log(`Creating user: ${email} as ${role}`);

        const { data, error } = await supabase
            .from('users')
            .insert([{ 
                id: user_id, 
                email: email, 
                role: role 
            }])
            .select()
            .single();

        if (error) {
            console.error('Supabase insert error:', error);
            throw error;
        }

        console.log(`✅ User created: ${email} (${role})`);

        res.json({ 
            success: true, 
            role: role,
            user: data 
        });
    } catch (error) {
        console.error('Create user error:', error);
        res.status(500).json({ 
            success: false,
            error: error.message || 'Erreur création utilisateur' 
        });
    }
});

// Export pour Vercel Serverless (si besoin futur)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = app;
}

// Listen pour développement local ET production (Render/Heroku)
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