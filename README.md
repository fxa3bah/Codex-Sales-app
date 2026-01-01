# Codex Sales App

Server-side AI endpoint and lightweight hub UI for analyzing sales data, summarizing trends, predicting pipeline milestones, and drafting communications. The AI key stays on the server; the frontend only calls the backend.

## Setup

```bash
npm install
cp .env.example .env   # add your OPENAI_API_KEY
npm start              # runs on http://localhost:3000
```

### Supabase configuration

- Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in `.env`.
- Create tables (or align existing ones) to power context suggestions and logging:

```sql
-- Sales contexts (readable with anon/publishable key)
create table if not exists public.sales_records (
  id bigserial primary key,
  customer text,
  brand text,
  season text,
  stage text,
  amount numeric,
  notes text,
  inserted_at timestamptz default now()
);

-- Analysis runs (write via service role only)
create table if not exists public.analysis_logs (
  id bigserial primary key,
  created_at timestamptz default now(),
  analysis_type text,
  filters jsonb,
  result_preview text,
  succeeded boolean default true,
  error_message text
);
```

## Usage

1. Load the hub UI at `http://localhost:3000`.
2. Paste sales data (JSON/CSV-like text) or click **Load sample data**.
3. Pick an analysis type and optional filters (customer, brand, season). Context inputs pull suggestions from Supabase when configured.
4. Run the analysis. Results show trend highlights, pipeline outlook, and draft communications.

## Implementation notes

- `server/index.js`: Express server, rate limited, calls OpenAI (or returns a local summary if not configured). Serves the frontend.
- `client/index.html`: Frontend hub to trigger analyses, display insights, select context filters, and load Supabase-powered context suggestions.
- Supabase:
  - Reads contexts from `sales_records` (anon key is sufficient).
  - Logs analysis executions to `analysis_logs` (service role key, server-only).
- API keys are read only from environment variables server-side; they are never exposed to the client.
