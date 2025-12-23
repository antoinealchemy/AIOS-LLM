# AIOS Chat Backend

Backend API Node.js pour interface chat AIOS avec Gemini.

## Installation

```bash
npm install
```

## Configuration

Créer fichier `.env` :
```env
GEMINI_API_KEY=AIzaSyBIyQGiphhlnmNjuL1jPFDCQSqMOGB848I
PORT=3000
```

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
