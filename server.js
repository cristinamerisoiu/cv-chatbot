// server.js — full, with style/personality + rotating variants (no structure change)

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const port = 3000;

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

// ---------- Utility: tag detection ----------
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
  if (/\bcertifications?\b|\btraining\b|\bcourses?\b/.test(qLower)) return 'certifications';
  if (/early experience|voluntary roles|2008|2016/.test(qLower)) return 'early';
  return null;
}

// ---------- Personality / style helpers ----------
const VARIANTS = [
  { id: 'bullets3',     instructions: 'Answer in 3 crisp bullet points, 10–16 words each. No preamble or closing.' },
  { id: 'impactBullets',instructions: 'Give 2 task bullets and 1 impact bullet. Keep each under 16 words.' },
  { id: 'twoSentences', instructions: 'Answer in 2 compact sentences, maximum 40 words total. No list formatting.' },
  { id: 'verbParagraph',instructions: 'One short paragraph using strong verbs; 3 sentences max, ~12–16 words each.' }
];

const rrMap = new Map(); // round-robin per normalized question
function pickVariant(question, isCompany) {
  // for company questions, prefer bullet formats; still rotate for variety
  const pool = isCompany ? VARIANTS.filter(v => v.id === 'bullets3' || v.id === 'impactBullets') : VARIANTS;
  const key = (question || '').trim().toLowerCase();
  const n = (rrMap.get(key) || 0) + 1;
  rrMap.set(key, n);
  return pool[(n - 1) % pool.length];
}

function cheekyOrInterviewOverride(qLower) {
  // normalize a bit
  const q = qLower.replace(/[?.!]/g, ' ').trim();

  // --- Personal / cheeky ---
  if (q.includes('how old') || q.includes('age')) {
    return "Cristina prefers to let results do the talking — age is just metadata.";
  }
  if (q.includes('kids') || q.includes('children') || q.includes('child')) {
    return "No family details here. Professionally, she mentors teams and grows systems.";
  }
  if (q.includes('single') || q.includes('married') || q.includes('relationship') || q.includes('partner') || q.includes('family')) {
    return "That’s personal territory. Professionally, she’s committed to strategy and delivery.";
  }

  // --- Interview-style ---
  if (q.includes('strength') || q.includes('strengths')) {
    const options = [
      "Strengths: connecting strategy to execution, staying calm under pressure, aligning cross-functional teams.",
      "She excels at translating business goals into workable systems and keeping teams synced under pressure.",
      "Her edge: strategic clarity, execution discipline, and diplomacy across business, ops, and engineering."
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  if (q.includes('weakness') || q.includes('flaw') || q.includes('flaws')) {
    const options = [
      "She can over-polish details — managed by time-boxing and clear ‘good-enough’ criteria.",
      "Perfectionism shows up — she mitigates it with deadlines and peer reviews.",
      "Tendency to over-optimize; she counters it by prioritizing impact and shipping earlier."
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  if (q.includes('challenge') || q.includes('hard time') || q.includes('difficult') || q.includes('hardest')) {
    const options = [
      "Tough case: onboarding partners amid shifting systems at CANCOM — she aligned teams and stabilized flows.",
      "A challenge: conflicting APIs and timelines in marketplace onboarding; she mapped risks and unblocked delivery.",
      "Hard moment: parallel tech changes during partner onboarding; she coordinated cross-teams to restore predictability."
    ];
    return options[Math.floor(Math.random() * options.length)];
  }

  return null;
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
      return res.json({ answer: "I don't have Cristina's CV context loaded yet." });
    }

    const qLower = message.toLowerCase();
    const desiredTag = detectTag(qLower);
    const isCompany = COMPANY_TAGS.includes(desiredTag || '');

    // Cheeky/interview overrides first
    const override = cheekyOrInterviewOverride(qLower);
    if (override) {
      return res.json({ answer: override });
    }

    // Embed the question
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: message,
    });
    const qemb = emb.data[0].embedding;

    // Score KB
    const allScored = KB.map(it => ({
      id: it.id,
      tag: it.tag,
      text: it.text,
      score: cosineSim(qemb, it.embedding),
    }));

    // Strict tag filter if a tag is detected
    let pool = allScored;
    if (desiredTag) {
      pool = allScored.filter(s => s.tag === desiredTag);
      if (!pool.length) {
        const polite = "I don’t have that in the CV context.";
        return res.json(debug ? { answer: polite, used_chunks: [] } : { answer: polite });
      }
    }
    if (!pool.length) pool = allScored;

    // Top-3 chunks
    const topK = pool.sort((a, b) => b.score - a.score).slice(0, 3);
    const contextBlocks = topK.map((s, i) => `[${i + 1} :: ${s.tag}] ${s.text}`);

    // Rotate styles so repeats don't look the same
    const variant = pickVariant(message, isCompany);

    // System prompt: concise + paraphrase + no mixing
    const system =
      "You are Cristina Merisoiu’s CV assistant.\n" +
      "Use ONLY the provided CV context. Reformulate in fresh wording; avoid copying lines verbatim.\n" +
      "Stay factual, match the user's language, and be concise by default.\n" +
      "If a specific company/section is implied, answer ONLY about it — no mixing.\n" +
      "Do not invent facts not present in the context.\n" +
      "Global length rule: keep it under ~90 words unless asked otherwise.";

    const companyHint = desiredTag
      ? `\nInstruction: The user asked about '${desiredTag}'. Answer ONLY about this tag.`
      : '';

    const styleHint = `\nStyle variant: ${variant.instructions}`;

    const userContent =
      (contextBlocks.length
        ? `CONTEXT (top matches):\n${contextBlocks.join('\n\n')}\n\n`
        : 'CONTEXT:\n(none)\n\n') +
      `QUESTION: ${message}${companyHint}${styleHint}`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      temperature: isCompany ? 0.5 : 0.7, // a touch of variety without drifting
      max_tokens: 220
    });

    let reply = completion.choices?.[0]?.message?.content || 'No reply.';
    reply = reply.replace(/Cristina Merisoiu/gi, 'Cristina'); // small de-formalizer
    reply = enforceShort(reply, 90); // extra safety on length

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
