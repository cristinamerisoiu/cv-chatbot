// server.js — strict scope, third-person only, full lists for skills/tools/languages
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

// NEW: Serve static files (HTML/JS/CSS) from root
app.use(express.static(__dirname));

// ---------- Load embeddings ----------
let KB = [];
try {
  const p = path.join(__dirname, 'embeddings.json');
  KB = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log(`Loaded KB with ${KB.length} chunks`);
} catch (e) {
  console.warn('No embeddings.json found. Running without CV memory.');
}
// ---------- Load multilingual interview ----------
let INTERVIEW = { clusters: [] };
try {
  const p = path.resolve(process.cwd(), 'interview.i18n.json');
  INTERVIEW = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log(`Loaded interview bank (${INTERVIEW.clusters.length} clusters)`);
} catch {
  console.warn('No interview.i18n.json found.');
}
// ---------- Normalization helpers (diacritic-insensitive, lowercase) ----------
function normalize(s = '') {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents (ä→a, ș→s)
    .replace(/\s+/g, ' ')
    .trim();
}
// ---------- Better language guess (no API; robust to missing diacritics) ----------
function guessLang(text = '') {
  const t = normalize(text);
  if (/[äöüß]/i.test(text)) return 'de';
  if (/[ăâîșşţțșț]/i.test(text)) return 'ro';
  if (/\b(der|die|das|und|mit|wie|was|sind|ihre|starken|schwachen|warum|arbeitsumfeld|lebenslauf|rollen|faehigkeiten|werkzeuge)\b/.test(t)) return 'de';
  if (/\b(este|sunt|care|ce|cum|ea|si|intr|din|de|la|in|puncte|tari|slabe|angajam|mediu|munca|abilitati|fluxuri)\b/.test(t)) return 'ro';
  return 'en';
}
// ---------- Interview answer (i18n, diacritic-insensitive) ----------
function interviewAnswer(question) {
  if (!INTERVIEW.clusters?.length) return null;
  const qNorm = normalize(question);
  const lang = guessLang(qNorm);
  const trigKey = lang === 'de' ? 'triggers_de' : lang === 'ro' ? 'triggers_ro' : 'triggers_en';
  const ansKey = lang === 'de' ? 'answers_de' : lang === 'ro' ? 'answers_ro' : 'answers_en';
  for (const c of INTERVIEW.clusters) {
    const triggers = (c[trigKey] || []).map(normalize);
    if (triggers.some(t => t && qNorm.includes(t))) {
      const pool = c[ansKey] || c.answers_en || [];
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    }
  }
  for (const c of INTERVIEW.clusters) {
    const enTriggers = (c.triggers_en || []).map(normalize);
    if (enTriggers.some(t => t && qNorm.includes(t))) {
      const pool = (c[ansKey] && c[ansKey].length ? c[ansKey] : c.answers_en) || [];
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    }
  }
  return null;
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
// ---------- Tag detection ----------
const COMPANY_TAGS = ['gannaca', 'ingram', 'cancom', 'covestro'];
const SECTION_TAGS = ['education','skills','tools','languages','certifications','early'];
const ALL_TAGS = [...COMPANY_TAGS, ...SECTION_TAGS];
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
// ---------- Smart boundaries + interview (rotating) - MULTILINGUAL ----------
function smartBoundaryAndInterview(question) {
  const qNorm = normalize(question); // Normalized for pattern matching
  
  // ----- Personal boundaries: AGE (English, German, Romanian) -----
  if (
    /\bhow\s+old\b/.test(qNorm) || 
    /\b(age|years\s+old)\b/.test(qNorm) ||
    /\b(wie\s+alt|alter)\b/.test(qNorm) ||
    /\b(cati\s+ani|varsta|ani\s+are)\b/.test(qNorm)
  ) {
    const opts = [
      "Age isn't the useful signal here. Focus on capability, outcomes, and fit.",
      "Let's optimize for signal: skills, outcomes, and alignment matter more than age.",
      "What's relevant is impact and fit. Age doesn't predict either."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  // ----- Personal boundaries: KIDS/CHILDREN (English, German, Romanian) -----
  if (
    /\b(kids|children|child)\b/.test(qNorm) ||
    /\b(kinder|kind)\b/.test(qNorm) ||
    /\b(copii|copil)\b/.test(qNorm)
  ) {
    const opts = [
      "Personal details aren't relevant. Happy to discuss mentoring and team development instead.",
      "Let's keep it professional. Ask about enablement, leadership, or outcomes.",
      "That's outside scope. You shouldn't ask that."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  // ----- Personal boundaries: MARITAL STATUS (English, German, Romanian) -----
  if (
    /\b(single|married|relationship|partner|family)\b/.test(qNorm) ||
    /\b(verheiratet|ledig|beziehung|familie)\b/.test(qNorm) ||
    /\b(casatorita|casatorit|relatie|partener|familie)\b/.test(qNorm)
  ) {
    const opts = [
      "Let's keep the focus on experience, decision-making, and outcomes.",
      "Professional scope only: strengths, track record, and fit.",
      "Happy to cover roles, skills, and results - personal details aren't part of this profile."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  // ----- STRENGTHS (English, German, Romanian) -----
  if (
    /\bstrengths?\b/.test(qNorm) ||
    /\b(starken|starke)\b/.test(qNorm) ||
    /\b(puncte\s+tari|forte)\b/.test(qNorm)
  ) {
    const opts = [
      "Strengths: fast pattern recognition, crisp communication, and reliable delivery in complex environments.",
      "She connects strategy to execution quickly, communicates with precision, and delivers predictably.",
      "Core strengths: systems thinking, concise articulation, and making complex work legible for teams."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  // ----- WEAKNESSES (English, German, Romanian) -----
  if (
    /\b(weakness|weaknesses|flaw|flaws)\b/.test(qNorm) ||
    /\b(schwache|schwachen|mangel)\b/.test(qNorm) ||
    /\b(punct\s+slab|puncte\s+slabe|slabiciune)\b/.test(qNorm)
  ) {
    const opts = [
      "She tends to over-polish; mitigated by time-boxing and clear 'good-enough' criteria.",
      "Perfectionist streak — managed with deadlines, peer review, and incremental releases.",
      "Bias toward optimizing details; balanced by prioritizing impact and shipping cadence."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  // ----- CHALLENGES (English, German, Romanian) -----
  if (
    /\b(challenge|hard\s*time|difficult|hardest)\b/.test(qNorm) ||
    /\b(herausforderung|schwierig)\b/.test(qNorm) ||
    /\b(provocare|dificil|greu)\b/.test(qNorm)
  ) {
    const opts = [
      "Marketplace onboarding amid shifting systems - she aligned stakeholders and stabilized operations.",
      "Conflicting integrations and timelines - she mapped risks, reset scope, and restored predictability.",
      "Multiple moving dependencies - she clarified ownership and rebuilt a reliable flow."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  // ----- Should we hire her? (English, German, Romanian) -----
  if (
    /\b(should\s+we\s+hire|hire\s+her)\b/.test(qNorm) ||
    /\b(sollen\s+wir\s+sie\s+einstellen|einstellen)\b/.test(qNorm) ||
    /\b(sa\s+o\s+angajam|angajam)\b/.test(qNorm)
  ) {
    const opts = [
      "Of course. Hiring her means gaining someone who cuts noise, creates clarity, and executes reliably.",
      "If the goal is precision, adaptability, and structured delivery - the hire is self-evident.",
      "Her track record shows: she builds systems, translates vision into execution, and sustains outcomes."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  // ----- SALARY (English, German, Romanian) -----
  if (
    /\b(salary|compensation|pay)\b/.test(qNorm) ||
    /\b(gehalt|bezahlung|vergutung)\b/.test(qNorm) ||
    /\b(salariu|compensare|remuneratie)\b/.test(qNorm)
  ) {
    const opts = [
      "Salary expectations depend on role scope and market benchmarks - best aligned during formal discussions.",
      "Compensation is context-driven. Alignment with responsibilities and market standards is the right frame.",
      "That's a structured conversation for the hiring stage - tied to scope, value, and benchmarks."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  // ----- CONTACT DETAILS (English, German, Romanian) -----
  if (
    /\b(contact|email|phone)\b/.test(qNorm) ||
    /\b(kontakt|telefon)\b/.test(qNorm) ||
    /\b(contact|telefon|adresa)\b/.test(qNorm)
  ) {
    return "Her contact details are provided in the original CV PDF you received.";
  }
  
  // ----- HOW SHE THINKS (English, German, Romanian) -----
  if (
    /\b(how\s+does\s+she\s+think|thinking\s+style|how\s+she\s+thinks|thought\s+process)\b/.test(qNorm) ||
    /\b(wie\s+denkt\s+sie|denkweise)\b/.test(qNorm) ||
    /\b(cum\s+gandeste|stil\s+de\s+gandire)\b/.test(qNorm)
  ) {
    const opts = [
      "She thinks in systems: spot patterns fast, frame the problem cleanly, decide with evidence, and communicate the path forward in plain language.",
      "She thinks fast, connects the unexpected, and solves with sharp clarity. Original, intuitive, and allergic to fluff, she cuts to the core and builds what's missing - better than before.",
      "She connects dots faster than most realize, brings clarity where others stall, and navigates pressure with sharp wit and quiet precision."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  // ----- WORK STYLE (English, German, Romanian) -----
  if (
    /\b(work\s+style|how\s+does\s+she\s+work|how\s+she\s+works|way\s+of\s+working|operating\s+style)\b/.test(qNorm) ||
    /\b(arbeitsstil|wie\s+arbeitet\s+sie)\b/.test(qNorm) ||
    /\b(stil\s+de\s+lucru|cum\s+lucreaza)\b/.test(qNorm)
  ) {
    const opts = [
      "She absorbs context fast, spots what actually matters, and moves from ambiguity to action before the room agrees what the problem is.",
      "She mixes strategic focus with creative improvisation - balancing precision when it counts and speed when it's needed."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  // ----- COMMUNICATION STYLE (English, German, Romanian) -----
  if (
    /\b(communication\s+style|how\s+she\s+communicates|communicator)\b/.test(qNorm) ||
    /\b(kommunikationsstil|wie\s+kommuniziert\s+sie)\b/.test(qNorm) ||
    /\b(stil\s+de\s+comunicare|cum\s+comunica)\b/.test(qNorm)
  ) {
    const opts = [
      "She communicates with intent: every word serves a purpose. Whether she's crafting strategy or giving feedback, her style is direct, smart, and tuned to the audience - always clear, never performative.",
      "Her communication cuts through noise. She doesn't over-explain or sugarcoat. Instead, she brings structure, nuance, and the kind of clarity that turns complexity into alignment."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  // ----- DECISION MAKING (English, German, Romanian) -----
  if (
    /\b(decision\s+making|decision\-making|how\s+she\s+decides|decision\s+style)\b/.test(qNorm) ||
    /\b(entscheidungsfindung|wie\s+entscheidet\s+sie)\b/.test(qNorm) ||
    /\b(luarea\s+deciziilor|cum\s+decide)\b/.test(qNorm)
  ) {
    const opts = [
      "She makes fast, informed decisions when speed matters - and slows down when precision is required. She combines instinct with analysis, never defaulting to autopilot.",
      "She's not afraid to take responsibility. Her decisions are driven by relevance, not trends, and by asking the right questions."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  // ----- WHO IS SHE (English, German, Romanian) -----
  if (
    /\b(what\s+is\s+she\s+like|who\s+is\s+she|describe\s+her|her\s+essence)\b/.test(qNorm) ||
    /\b(wie\s+ist\s+sie|wer\s+ist\s+sie)\b/.test(qNorm) ||
    /\b(cum\s+este\s+ea|cine\s+este\s+ea)\b/.test(qNorm)
  ) {
    const opts = [
      "She's the person who asks the question no one else thought to. Who finishes what others start- or starts what others wouldn't dare to. Wit like flint, focus when it counts, and a restlessness that doesn't settle for 'fine'. She turns systems into stories, stories into action, and action into results.",
      "Think strategic operator meets pattern disruptor. She thrives in ambiguity, doesn't wait for permission, and doesn't waste time. High-context, high-output, and with an amazing sense of humor."
    ];
    return opts[Math.floor(Math.random()*opts.length)];
  }
  
  return null;
}
// ---------- Variants (BULLETS REMOVED - ONLY PARAGRAPHS) ----------
const VARIANTS = [
  { id: 'twoSentences', instructions: 'Answer in 2 compact sentences, max 40 words total. No list formatting.' },
  { id: 'shortPara', instructions: 'One short paragraph, 2–3 sentences with strong verbs; avoid filler.' }
];
const rrMap = new Map();
function pickVariant(question, preferBullets) {
  // Note: preferBullets parameter is now ignored since we only have paragraph variants
  const pool = VARIANTS;
  const key = (question || '').trim().toLowerCase();
  const n = (rrMap.get(key) || 0) + 1;
  rrMap.set(key, n);
  return pool[(n - 1) % pool.length];
}
// Hard cap with a bit more room for section lists
function enforceShort(text, maxWords = 90) {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(' ') + '…';
}
// Belt-and-suspenders: strip first-person if it ever slips
function enforceThirdPerson(text) {
  return text
    .replace(/\bI am\b/gi, 'She is')
    .replace(/\bI was\b/gi, 'She was')
    .replace(/\bI have\b/gi, 'She has')
    .replace(/\bI've\b/gi, 'She has')
    .replace(/\bI\b/gi, 'She')
    .replace(/\bmy\b/gi, 'her')
    .replace(/\bme\b/gi, 'her');
}
// ---------- Health ----------
app.get('/', (req, res) => {
  // UPDATED: Serve index.html on root for chatbot UI
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/ping', (_, res) => res.json({ ok: true, chunks: KB.length }));
// ---------- Chat ----------
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
    const isSection = SECTION_TAGS.includes(desiredTag || '');
    // 1) Overrides (your existing custom replies - NOW MULTILINGUAL)
    const override = smartBoundaryAndInterview(message); // Pass original message, not qLower
    if (override) return res.json({ answer: override });
    // 1.5) Interview clusters (your long-form Q&A from interview.json)
    const canned = interviewAnswer(message);
    if (canned) return res.json({ answer: canned });
    // 2) Embed
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: message,
    });
    const qemb = emb.data[0].embedding;
    // 3) Score
    const allScored = KB.map(it => ({
      id: it.id,
      tag: it.tag,
      text: it.text,
      score: cosineSim(qemb, it.embedding),
    }));
    // 4) Strict scope
    let pool = allScored;
    if (desiredTag) {
      pool = allScored.filter(s => s.tag === desiredTag);
      if (!pool.length) {
        const polite = "Not in scope for the CV context.";
        return res.json(debug ? { answer: polite, used_chunks: [] } : { answer: polite });
      }
    }
    // 5) Top-3
    const topK = pool.sort((a, b) => b.score - a.score).slice(0, 3);
    const contextBlocks = topK.map((s, i) => `[${i + 1} :: ${s.tag}] ${s.text}`);
    // 6) Variant
    const variant = pickVariant(message, isCompany);
    // 7) Persona prompt
    const personaSystem =
      "You are presenting Cristina Merisoiu's professional CV as a chatbot for recruiters.\n" +
      "Never use first person ('I', 'me', 'my'). Always refer to Cristina in third person ('Cristina', 'she', 'her').\n" +
      "Tone: professional, succinct, sharp; confident without hype; zero fluff; high verbal precision.\n" +
      "Always reformulate—do not copy CV sentences verbatim. Use ONLY the provided context.\n" +
      "Avoid buzzwords and filler. Never use the word 'chaos'.\n" +
      "Global length guideline: ~90 words max unless asked otherwise.";
    const scopeRules = isCompany
      ? "For company questions: FIRST line must clearly state role title and timeframe from context. Example: 'Strategic Operator & Systems Architect (Jun 2023–Present)'. Do NOT mention other companies."
      : "For section questions (skills/tools/languages/education/certifications/early): Enumerate ALL relevant items from that section; do NOT omit items or summarize them away. Do NOT mention companies or tasks.";
    const sectionHint = isSection
      ? "Format lists cleanly (bullets or compact lines). Keep every item present in context verbatim or lightly paraphrased."
      : "";
    const styleHint = isSection
      ? "Style: structured list preferred; prioritize completeness over brevity for this answer."
      : `Style variant: ${variant.instructions}`;
    const maxWords = isSection ? 140 : 90;
    const userContent =
      (contextBlocks.length
        ? `CONTEXT (top matches):\n${contextBlocks.join('\n\n')}\n\n`
        : 'CONTEXT:\n(none)\n\n') +
      `QUESTION: ${message}\n\n${scopeRules}\n${sectionHint}\n${styleHint}`;
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: personaSystem },
        { role: 'user', content: userContent },
      ],
      temperature: isCompany ? 0.5 : 0.6,
      max_tokens: 260
    });
    let reply = completion.choices?.[0]?.message?.content || 'No reply.';
    reply = reply.replace(/Cristina Merisoiu/gi, 'Cristina');
    reply = enforceShort(enforceThirdPerson(reply), maxWords);
    if (debug) {
      return res.json({
        answer: reply,
        tag: desiredTag || '(auto)',
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
