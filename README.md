# AIOS Chat Backend

Backend API Node.js pour interface chat AIOS avec Gemini.

## Installation

```bash
npm install
```

## Configuration

1. Copier le fichier `.env.example` vers `.env` :
```bash
cp .env.example .env
```

2. Remplir les variables d'environnement dans `.env` avec vos clés :
```env
# Google Gemini API
GEMINI_API_KEY=votre_cle_gemini_ici

# Pinecone Vector Database
PINECONE_API_KEY=votre_cle_pinecone_ici
PINECONE_INDEX_HOST=votre_host_pinecone_ici

# Supabase
SUPABASE_URL=https://oxjocjucvlifcogphttm.supabase.co
SUPABASE_SERVICE_KEY=votre_cle_service_supabase_ici

# Admin Secret Code
ADMIN_SECRET_CODE=AIOS-ADMIN-2025

# Server Port
PORT=3000
```

**IMPORTANT**: Ne commitez JAMAIS votre fichier `.env` avec vos vraies clés API !

## Démarrage

### Production
```bash
npm start
```

### Développement (auto-reload)
```bash
npm run dev
```

## Endpoints

### POST /api/chat
Envoyer message et recevoir réponse IA

**Request:**
```json
{
  "message": "Résume mon dernier appel",
  "conversationId": "session-123" // optionnel
}
```

**Response:**
```json
{
  "response": "Voici le résumé...",
  "conversationId": "session-123"
}
```

### DELETE /api/chat/:id
Supprimer historique conversation

### GET /health
Health check

## Frontend

Ouvrir `chat-interface.html` dans navigateur.
Backend doit tourner sur `http://localhost:3000`

## Prochaines étapes

- [ ] Intégrer Pinecone pour RAG
- [ ] Ajouter authentification
- [ ] Déployer sur Vercel/Railway
- [ ] Base de données pour historique
