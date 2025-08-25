// server.js — CV chatbot with sharp, professional personality layer (no structure changes)

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// ---------- Load embeddings ----------
let KB = [];
try {
  const p = path.join(__dirname, 'embeddings.json');
  KB = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log(`Loaded KB with ${KB.length} chunks`);
} catch (e) {
  console.warn('No embeddings.json found. Running without CV memory.');
}

// ---------- Cosine similarity ----------
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1e-9;
  return dot / denom;
}

// ---------- Tag detection (unchanged structure) ----------
const COMPANY_TAGS = ['gannaca', 'ingram', 'cancom', 'covestro'];
const ALL_TAGS = [...COMPANY_TAGS, 'education', 'skills', 'tools', 'languages', 'certifications', 'early'];

function detectTag(qLower) {
  if (/\bgannaca\b/.test(qLower)) return 'gannaca';
  if (/\bingram\b/.test(qLower)) return 'ingram';
  if (/\bcancom\b/.test(qLower)) return 'cancom';
  if (/\bcovestro\b/.test(qLower)) return 'covestro';
  if (/\beducation\b|\buniversity\b|\bbachelor\b/.test(qLower)) return 'education';
  if (/\bskills?\b/.test(qLower)) return 'skills';
  if (/\btools?\b|\bsystems?\b|\bstack\b/.test(qLower)) return 'tools';
  if (/\blanguages?\b|\bromanian\b|\bgerman\b|\benglish\b/.test(qLower)) return 'languages';
  if (/(early experience|voluntary roles|2008|2016)/.test(qLower)) return 'early';
  if (/\bcertifications?\b|\btraining\b|\bcourses?\b/.test(qLower)) return 'certifications';
  return null;
}

// ---------- Smart boundaries + Interview shortcuts (sharp, professional) ----------
function smartBoundaryAndInterview(qLower) {
  const q = qLower.replace(/[?.!]/g, ' ').trim();

  // Personal boundaries
  if (q.includes('how old') || q.includes('age')) {
    return "Age isn’t the useful signal here. Focus on capability, outcomes, and fit.";
  }
  if (q.includes('kids') || q.includes('children') || q.includes('child')) {
    return "Personal details aren’t relevant. If you’d like, ask about mentoring or team enablement.";
  }
  if (q.includes('single') || q.includes('married') || q.includes('relationship') || q.includes('partner') || q.includes('family')) {
    return "Let’s keep it professional. Happy to talk experience, strengths, and decision-making.";
  }

  // Interview themes (rotate wording for variety)
  if (q.includes('strength') || q.includes('strengths')) {
    const options = [
      "Strengths: fast pattern recognition, crisp communication, and reliable delivery in complex environments.",
      "She connects strategy to execution quickly, communicates with precision, and delivers predictably.",
      "Core strengths: systems thinking, concise articulation, and making complex work legible for teams."
    ];
    return options[Math.floor(Math.random()*options.length)];
  }

  if (q.includes('weakness') || q.includes('flaw') || q.includes('flaws')) {
    const options = [
      "She tends to over-polish; mitigated by time-boxing and clear ‘good-enough’ criteria.",
      "Perfectionist streak—managed with deadlines, peer review, and shipping iteratively.",
      "Bias toward optimizing details; balanced by prioritizing impact and release cadence."
    ];
    return options[Math.floor(Math.random()*options.length)];
  }

  if (q.includes('challenge') || q.includes('hard time') || q.includes('difficult') || q.includes('hardest')) {
    const options = [
      "Significant challenge: marketplace onboarding amid shifting systems—she aligned stakeholders and stabilized operations.",
      "Tough case: conflicting integrations and timelines—she mapped risks, reset scope, and restored predictability.",
      "High-ambiguity scenario: multiple dependencies moving at once—she clarified ownership and rebuilt a reliable flow."
    ];
    return options[Math.floor(Math.random()*options.length)];
  }

  return null;
}

// ---------- Rotating style variants (concise, professional) ----------
const VARIANTS = [
  { id: 'bullets3',      instructions: 'Answer in 3 tight bullets (10–16 words each). No intro/outro.' },
  { id: 'impactBullets', instructions: 'Provide 2 action bullets + 1 outcome bullet. Max 16 words each.' },
  { id: 'twoSentences',  instructions: 'Answer in 2 compact sentences, max 40 words total. No list formatting.' },
  { id: 'shortPara',     instructions: 'One short paragraph, 2–3 sentences with strong verbs; avoid filler.' }
];

const rrMap = new Map();
function pickVariant(question, preferBullets) {
  const pool = preferBullets
    ? VARIANTS.filter(v => v.id === 'bullets3' || v.id === 'impactBullets')
    : VARIANTS;
  const key = (question || '').trim().toLowerCase();
  const n = (rrMap.get(key) || 0) + 1;
  rrMap.set(key, n);
  return pool[(n - 1) % pool.length];
}

function enforceShort(text, maxWords = 90) {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(' ') + '…';
}

// ---------- Health checks ----------
app.get('/', (_, res) => res.send('OK: server up'));
app.get('/ping', (_, res) => res.json({ ok: true, chunks: KB.length }));

// ---------- Chat endpoint ----------
app.post('/chat', async (req, res) => {
  const { message } = req.body || {};
  const debug = req.query.debug === 'true';

  try {
    if (!message || !message.trim()) {
      return res.json({ answer: "Please ask a question." });
    }
    if (!KB.length) {
      return res.json({ answer: "I don't have Cristina’s CV context loaded yet." });
    }

    const qLower = message.toLowerCase();
    const desiredTag = detectTag(qLower);
    const preferBullets = COMPANY_TAGS.includes(desiredTag || '');

    // 1) Smart boundary / interview overrides (immediate)
    const override = smartBoundaryAndInterview(qLower);
    if (override) {
      return res.json({ answer: override });
    }

    // 2) Embed the question
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: message,
    });
    const qemb = emb.data[0].embedding;

    // 3) Score KB
    const allScored = KB.map(it => ({
      id: it.id,
      tag: it.tag,
      text: it.text,
      score: cosineSim(qemb, it.embedding),
    }));

    // 4) Strict tag filter if detected
    let pool = allScored;
    if (desiredTag) {
      pool = allScored.filter(s => s.tag === desiredTag);
      if (!pool.length) {
        const polite = "Not in scope for the CV context.";
        return res.json(debug ? { answer: polite, used_chunks: [] } : { answer: polite });
      }
    }
    if (!pool.length) pool = allScored;

    // 5) Top-3 chunks -> context
    const topK = pool.sort((a, b) => b.score - a.score).slice(0, 3);
    const contextBlocks = topK.map((s, i) => `[${i + 1} :: ${s.tag}] ${s.text}`);

    // 6) Rotating style variant
    const variant = pickVariant(message, preferBullets);

    // 7) Persona-aware rewriting (sharp, professional; avoid verbatim CV; avoid banned words)
    const personaSystem =
      "You are writing on behalf of Cristina Merisoiu for recruiters.\n" +
      "Tone: professional, succinct, sharp; confident without hype; zero fluff; high verbal precision.\n" +
      "Never use the word 'chaos'. Prefer: clarity, reliability, structure, predictable delivery, high-ambiguity environments.\n" +
      "Always reformulate—do not copy CV sentences verbatim. Keep facts grounded in the provided context only.\n" +
      "If a company/section is implied, answer only about that scope. No mixing across roles.\n" +
      "Global length rule: ~90 words max unless asked otherwise.";

    const phrasingHints =
      "Preferred phrasing examples:\n" +
      "- Built clarity in complex environments; translated ambiguity into reliable workflows.\n" +
      "- Connected strategy to execution; aligned stakeholders; delivered predictably.\n" +
      "- Structured integrations and onboarding with measurable outcomes.\n" +
      "- Communicated with precision; made decisions legible for teams.\n" +
      "Avoid filler like: passion, synergy, wheelhouse, chaos.";

    const companyHint = desiredTag
      ? `\nScope: The user asked about '${desiredTag}'. Restrict the answer to this tag only.`
      : '';

    const styleHint = `\nStyle variant: ${variant.instructions}`;

    const userContent =
      (contextBlocks.length
        ? `CONTEXT (top matches):\n${contextBlocks.join('\n\n')}\n\n`
        : 'CONTEXT:\n(none)\n\n') +
      `QUESTION: ${message}\n\n${phrasingHints}${companyHint}${styleHint}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: personaSystem },
        { role: 'user', content: userContent },
      ],
      temperature: preferBullets ? 0.5 : 0.7,
      max_tokens: 220
    });

    let reply = completion.choices?.[0]?.message?.content || 'No reply.';
    reply = reply.replace(/Cristina Merisoiu/gi, 'Cristina');
    reply = enforceShort(reply, 90);

    if (debug) {
      return res.json({
        answer: reply,
        style_variant: variant.id,
        used_chunks: topK.map(s => ({
          tag: s.tag,
          score: Number(s.score.toFixed(3)),
          preview: s.text.slice(0, 160) + (s.text.length > 160 ? '…' : '')
        })),
      });
    }
    return res.json({ answer: reply });
  } catch (err) {
    const status = err?.status || err?.response?.status || 500;
    const detail = err?.response?.data || err.message;
    console.error('OpenAI error:', status, detail);
    res.status(status === 429 ? 429 : 500).json({
      error: status === 429 ? 'quota_exceeded' : 'chat_failed',
      detail,
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
