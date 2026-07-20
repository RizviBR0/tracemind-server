# TraceMind Server

TraceMind Server is the TypeScript/Express API behind the TraceMind decision-intelligence workspace. It provides MongoDB persistence, authentication and authorization, public case discovery, document processing, AI decision sessions, analytics, and admin moderation endpoints.

## Links

- GitHub repository: [tracemind-server](https://github.com/RizviBR0/tracemind-server)
- Frontend repository: [tracemind-client](https://github.com/RizviBR0/tracemind-client)
- Live API: deployment URL is not configured in this repository yet

The server is structured for Vercel deployment through [`vercel.json`](vercel.json), but a deployed API URL must be added after deployment.

## Main technologies

- Node.js and Express 5
- TypeScript with native ES modules
- MongoDB with Mongoose
- JWT authentication with HTTP-only cookies
- Google OAuth 2.0 integration
- Google Gemini for decision and document intelligence
- Zod request validation
- Multer file uploads
- Helmet, CORS, and express-rate-limit security middleware
- Vercel serverless adapter

## Core features

- Registration, password login, logout, current-user sessions, demo-account provisioning, and Google OAuth callback handling.
- Role-based authorization for protected user routes and admin routes.
- Case CRUD with owner checks, private/public visibility, moderation states, saved cases, reviews, ratings, related-case selection, reporting, and view counts.
- Upload and process PDF, DOCX, TXT, PNG, and JPG evidence with summaries, key points, risks, action items, generated tags, and downloadable text reports.
- Context-aware Gemini decision agent that retrieves case knowledge, related document context, conflict signals, decision alternatives, assumptions, risks, action items, and conversation memory.
- AI decision-session continuation, regeneration, saving, and owner-reviewed public insight publishing.
- User, public, and admin analytics endpoints.
- Centralized validation and error handling, request security headers, CORS controls, and rate limiting.

## Dependencies

Runtime dependencies are declared in [`package.json`](package.json). The main dependencies are:

`express`, `mongoose`, `jsonwebtoken`, `bcryptjs`, `dotenv`, `zod`, `multer`, `mammoth`, `pdf-parse`, `cookie-parser`, `cors`, `helmet`, and `express-rate-limit`.

Development dependencies include TypeScript, `tsx`, Vercel's Node types, and the relevant type packages.

## Run locally

### Prerequisites

- Node.js 20 or newer
- A MongoDB database
- A Gemini API key for live AI processing
- Google OAuth credentials if Google sign-in is enabled

### Setup

1. Clone the repository and enter the server directory:

   ```bash
   git clone https://github.com/RizviBR0/tracemind-server.git
   cd tracemind-server
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create `.env` from `.env.example` and configure the values below:

   ```env
   MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>/<database>
   JWT_SECRET=replace-with-a-random-secret-at-least-32-characters
   GEMINI_API_KEY=your-gemini-api-key
   GEMINI_MODEL=gemini-2.5-flash
   GOOGLE_CLIENT_ID=your-google-oauth-client-id
   GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
   CLIENT_URL=http://localhost:3000
   PORT=5000
   DEMO_EMAIL=demo@tracemind.app
   DEMO_PASSWORD=TraceMindDemo2026!
   ```

   `AI_KEY_ENCRYPTION_SECRET` is also required if users store their own AI provider key. Keep all provider credentials server-side.

4. Optionally provision the configured demo account:

   ```bash
   npm run demo:ensure
   ```

5. Start the development API:

   ```bash
   npm run dev
   ```

   The API listens on [http://localhost:5000](http://localhost:5000).

6. Start the client separately and point its `NEXT_PUBLIC_SERVER_URL` to `http://localhost:5000`.

### Production checks

```bash
npm run build
npm run start
```

## API areas

- `/api/auth/*` — authentication and Google OAuth
- `/api/v1/cases/*` — cases, discovery, saved cases, reviews, and reports
- `/api/v1/documents/*` — evidence upload, processing, and reports
- `/api/v1/ai/*` — decision sessions and AI recommendations
- `/api/v1/analytics/*` — public, user, and admin analytics
- `/api/v1/admin/*` — moderation and user administration

## Related resources

- [Express documentation](https://expressjs.com/)
- [Mongoose documentation](https://mongoosejs.com/docs/)
- [Google Gemini API documentation](https://ai.google.dev/gemini-api/docs)
- [TraceMind client README](https://github.com/RizviBR0/tracemind-client#readme)
