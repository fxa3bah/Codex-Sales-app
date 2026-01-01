import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenAI } from 'openai';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const openaiApiKey = process.env.OPENAI_API_KEY;
const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const openaiClient = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const supabaseServiceClient = supabaseUrl && supabaseServiceKey ? createClient(supabaseUrl, supabaseServiceKey) : null;
const supabaseReadClient = supabaseUrl && (supabaseAnonKey || supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseAnonKey || supabaseServiceKey)
  : null;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please try again later.' }
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/api/', limiter);

const clientPath = path.join(__dirname, '../client');
app.use(express.static(clientPath));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

function normalizeRecords(data) {
  if (!data) return { raw: '', records: [] };
  let raw = '';
  let parsed = [];

  if (typeof data === 'string') {
    raw = data;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      parsed = [];
    }
  } else if (Array.isArray(data)) {
    parsed = data;
    raw = JSON.stringify(data, null, 2);
  } else if (typeof data === 'object') {
    parsed = [data];
    raw = JSON.stringify(data, null, 2);
  }

  const records = Array.isArray(parsed)
    ? parsed
        .map((item) => ({
          customer: item.customer || item.account || 'Unknown Customer',
          brand: item.brand || item.category || 'Unknown Brand',
          season: item.season || item.quarter || item.period || 'Unspecified',
          stage: item.stage || item.pipelineStage || 'unspecified',
          amount: Number(item.amount || item.value || item.revenue || item.total || 0),
          notes: item.notes || item.comment || ''
        }))
        .filter((r) => !Number.isNaN(r.amount))
    : [];

  return { raw, records };
}

function summarizeLocally(records, filters) {
  if (!records.length) {
    return 'No structured sales records were provided to summarize.';
  }

  const total = records.reduce((sum, r) => sum + (r.amount || 0), 0);

  const groupBy = (key) => {
    return records.reduce((acc, r) => {
      const k = r[key] || 'Unspecified';
      acc[k] = (acc[k] || 0) + (r.amount || 0);
      return acc;
    }, {});
  };

  const byCustomer = groupBy('customer');
  const byBrand = groupBy('brand');
  const bySeason = groupBy('season');

  const top = (obj) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, value]) => `${name}: $${value.toLocaleString()}`)
      .join('; ');

  const filterSummary = Object.entries(filters || {})
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');

  return [
    'AI provider is not configured. Showing a quick local summary instead.',
    filterSummary ? `Applied filters -> ${filterSummary}.` : 'No filters applied.',
    `Total pipeline value: $${total.toLocaleString()}.`,
    byCustomer && Object.keys(byCustomer).length ? `Top customers: ${top(byCustomer)}.` : '',
    byBrand && Object.keys(byBrand).length ? `Top brands: ${top(byBrand)}.` : '',
    bySeason && Object.keys(bySeason).length ? `Top seasons/periods: ${top(bySeason)}.` : ''
  ]
    .filter(Boolean)
    .join(' ');
}

function buildPrompt({ rawSalesText, analysisType, filters }) {
  const focus = {
    trends: 'Identify demand trends, seasonality, and drivers across customers and brands.',
    pipeline: 'Predict pipeline milestones, risks, and likely close timelines with confidence levels.',
    communications: 'Draft succinct client-ready communication bullets and recommendations based on the data.'
  };

  const filterSummary = Object.entries(filters || {})
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ');

  return `You are a senior sales operations analyst. Use the sales data below to summarize insights.

Context filters: ${filterSummary || 'none provided'}
Required focuses: ${focus[analysisType] || 'General sales insights.'}

Deliver three sections:
1) Trend Highlights (bullets)
2) Pipeline Outlook (probable milestones, risks, next best actions)
3) Draft Communications (short, actionable notes for stakeholders)

Use concise bullets and include numeric references when available. If data is sparse, state assumptions.`;
}

async function runOpenAIAnalysis({ rawSalesText, analysisType, filters }) {
  const prompt = buildPrompt({ rawSalesText, analysisType, filters });

  const completion = await openaiClient.chat.completions.create({
    model: openaiModel,
    temperature: 0.4,
    max_tokens: 500,
    messages: [
      {
        role: 'system',
        content: 'You are an expert AI sales analyst who is factual, concise, and action oriented.'
      },
      {
        role: 'user',
        content: `${prompt}\n\nSales data:\n${rawSalesText}`
      }
    ]
  });

  return completion.choices[0]?.message?.content?.trim();
}

async function logAnalysis({ analysisType, filters, resultPreview, succeeded, errorMessage }) {
  if (!supabaseServiceClient) return;

  try {
    await supabaseServiceClient.from('analysis_logs').insert({
      analysis_type: analysisType,
      filters,
      result_preview: resultPreview?.slice(0, 500) || '',
      succeeded,
      error_message: errorMessage || null
    });
  } catch (error) {
    console.warn('Unable to log analysis to Supabase', error);
  }
}

function formatContexts(records = []) {
  const unique = (list) => Array.from(new Set(list.filter(Boolean)));
  const customers = unique(records.map((r) => r.customer));
  const brands = unique(records.map((r) => r.brand));
  const seasons = unique(records.map((r) => r.season));

  return { customers, brands, seasons };
}

async function fetchContextsFromSupabase() {
  if (!supabaseReadClient) return null;

  try {
    const { data, error } = await supabaseReadClient
      .from('sales_records')
      .select('customer, brand, season')
      .limit(500);

    if (error) throw error;
    return formatContexts(data || []);
  } catch (error) {
    console.warn('Unable to fetch contexts from Supabase', error.message || error);
    return null;
  }
}

const sampleRecords = [
  { customer: 'Northwind Outfitters', brand: 'ActiveLife', season: 'Spring', stage: 'Proposal', amount: 185000, notes: 'Bundle with accessories' },
  { customer: 'Summit Stores', brand: 'ActiveLife', season: 'Summer', stage: 'Negotiation', amount: 220000, notes: 'Close date likely this month' },
  { customer: 'Harbor Co-op', brand: 'UrbanFlex', season: 'Holiday', stage: 'Committed', amount: 310000 },
  { customer: 'Northwind Outfitters', brand: 'UrbanFlex', season: 'Holiday', stage: 'Discovery', amount: 95000 },
  { customer: 'Metro Sports', brand: 'TrailWorks', season: 'Spring', stage: 'Proposal', amount: 140000 }
];

app.get('/api/contexts', async (_req, res) => {
  const supabaseContexts = await fetchContextsFromSupabase();
  if (supabaseContexts) {
    return res.json({ source: 'supabase', ...supabaseContexts });
  }

  const fallback = formatContexts(sampleRecords);
  res.json({ source: 'sample', ...fallback });
});

app.post('/api/analyze', async (req, res) => {
  const { salesData, analysisType = 'trends', filters = {} } = req.body || {};

  if (!salesData) {
    return res.status(400).json({ error: 'Missing salesData payload.' });
  }

  const { raw, records } = normalizeRecords(salesData);
  const rawSalesText = raw || JSON.stringify(salesData, null, 2);

  if (!openaiClient) {
    const summary = summarizeLocally(records, filters);
    await logAnalysis({
      analysisType,
      filters,
      resultPreview: summary,
      succeeded: true
    });

    return res.status(503).json({
      error: 'AI provider is not configured. Add OPENAI_API_KEY to enable insights.',
      data: summary
    });
  }

  try {
    const result = await runOpenAIAnalysis({ rawSalesText, analysisType, filters });
    res.json({ result });

    await logAnalysis({
      analysisType,
      filters,
      resultPreview: result,
      succeeded: true
    });
  } catch (error) {
    console.error('AI analysis failed', error);
    await logAnalysis({
      analysisType,
      filters,
      resultPreview: '',
      succeeded: false,
      errorMessage: error.message || 'Failed to analyze data'
    });

    res.status(500).json({ error: 'Failed to analyze data. Please try again later.' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(clientPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
