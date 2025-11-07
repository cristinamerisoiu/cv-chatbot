// server.js — OpenAI handles ALL language detection and boundaries
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
// ---------- OpenAI Language Detection ----------
async function detectLanguage(text = '') {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a language detector. Respond with ONLY one word: "en" for English, "de" for German, or "ro" for Romanian. No explanation, no punctuation, just the two-letter code.'
        },
        {
          role: 'user',
          content: text
        }
      ],
      temperature: 0,
      max_tokens: 5
    });
    
    const detected = response.choices[0].message.content.trim().toLowerCase();
    
    // Validate response
    if (detected === 'en' || detected === 'de' || detected === 'ro') {
      return detected;
    }
    
    return 'en'; // Default to English if unclear
  } catch (error) {
    console.error('Language detection error:', error);
    return 'en'; // Fallback to English on error
  }
}
// ---------- Interview answer (i18n, diacritic-insensitive) ----------
function interviewAnswer(question, lang) {
  if (!INTERVIEW.clusters?.length) return null;
  const qNorm = normalize(question);
  const trigKey = lang === 'de' ? 'triggers_de' : lang === 'ro' ? 'triggers_ro' : 'triggers_en';
  const ansKey = lang === 'de' ? 'answers_de' : lang === 'ro' ? 'answers_ro' : 'answers_en';
  
  for (const c of INTERVIEW.clusters) {
    const triggers = (c[trigKey] || []).map(normalize);
    if (triggers.some(t => t && qNorm.includes(t))) {
      const pool = c[ansKey] || c.answers_en || [];
      if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
    }
  }
  
  return null;  // If no match, return null (don't fall back to English)
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
// ---------- Variants (BULLETS REMOVED - ONLY PARAGRAPHS) ----------
const VARIANTS = [
  { id: 'twoSentences', instructions: 'Answer in 2 compact sentences, max 40 words total. No list formatting.' },
  { id: 'shortPara', instructions: 'One short paragraph, 2–3 sentences with strong verbs; avoid filler.' }
];
const rrMap = new Map();
function pickVariant(question, preferBullets) {
  const pool = VARIANTS;
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
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/ping', (_, res) => res.json({ ok: true, chunks: KB.length }));

// ---------- Store conversation history per session ----------
const conversations = new Map(); // sessionId -> message history

// ---------- Chat ----------
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body || {};
  const debug = req.query.debug === 'true';
  try {
    if (!message || !message.trim()) {
      return res.json({ answer: "Please ask a question." });
    }
    if (!KB.length) {
      return res.json({ answer: "I don't have Cristina's CV context loaded yet." });
    }
    
    // Get or create conversation history for this session
    const sid = sessionId || 'default';
    if (!conversations.has(sid)) {
      conversations.set(sid, []);
    }
    const history = conversations.get(sid);
    
    // Detect language using OpenAI
    const detectedLang = await detectLanguage(message);
    console.log('Detected language:', detectedLang, 'for question:', message);
    
    const qLower = message.toLowerCase();
    const desiredTag = detectTag(qLower);
    const isCompany = COMPANY_TAGS.includes(desiredTag || '');
    const isSection = SECTION_TAGS.includes(desiredTag || '');
    
    // 1) Check interview clusters first (handles common questions in all languages)
    const canned = interviewAnswer(message, detectedLang);
    if (canned) {
      // Add to history
      history.push({ role: 'user', content: message });
      history.push({ role: 'assistant', content: canned });
      if (history.length > 20) history.splice(0, history.length - 20);
      
      return res.json({ answer: canned });
    }
    
    // 2) Embed the question
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: message,
    });
    const qemb = emb.data[0].embedding;
    
    // 3) Score all chunks
    const allScored = KB.map(it => ({
      id: it.id,
      tag: it.tag,
      text: it.text,
      score: cosineSim(qemb, it.embedding),
    }));
    // Check if question seems nonsensical (very low relevance scores across all chunks)
const maxScore = Math.max(...allScored.map(s => s.score));
if (maxScore < 0.3 && message.length < 15) {
  const clarify = detectedLang === 'de' 
    ? 'Ich habe das nicht ganz verstanden. Könnten Sie die Frage umformulieren?'
    : detectedLang === 'ro'
    ? 'Nu am înțeles întrebarea. Poți reformula?'
    : "I didn't quite catch that. Could you rephrase your question?";
  return res.json({ answer: clarify });
}
    
    // 4) Strict scope
    let pool = allScored;
    if (desiredTag) {
      pool = allScored.filter(s => s.tag === desiredTag);
      if (!pool.length) {
        const polite = "Not in scope for the CV context.";
        return res.json(debug ? { answer: polite, used_chunks: [] } : { answer: polite });
      }
    }
    
    // 5) Top-3 chunks
    const topK = pool.sort((a, b) => b.score - a.score).slice(0, 3);
    const contextBlocks = topK.map((s, i) => `[${i + 1} :: ${s.tag}] ${s.text}`);
    
    // 6) Variant
    const variant = pickVariant(message, isCompany);
    
    // 7) Build comprehensive system prompt with boundary rules
    const languageInstruction = detectedLang === 'de' 
      ? 'CRITICAL: Respond in German (Deutsch). All answers must be in German.'
      : detectedLang === 'ro'
      ? 'CRITICAL: Respond in Romanian (Română). All answers must be in Romanian.'
      : 'CRITICAL: Respond in English. All answers must be in English.';

    const boundaryRules = `
BOUNDARY RULES - Apply these BEFORE answering from CV context:

1. PERSONAL BOUNDARIES (Refuse politely):
   - Age questions → "Age isn't the useful signal here. Focus on capability, outcomes, and fit."
   - Kids/children questions → "Personal details aren't relevant. Happy to discuss anything else."
   - Marital status/relationship → "Let's keep the focus on experience, decision-making, and outcomes."
   - Contact details → "Her contact details are provided in the original CV PDF you received."

2. SALARY/COMPENSATION:
   → "Salary expectations depend on role scope and market benchmarks - best aligned during formal discussions."

3. STRENGTHS:
   → "Strengths: fast pattern recognition, crisp communication, and reliable delivery in complex environments."

4. WEAKNESSES:
   → "She tends to over-polish; mitigated by time-boxing and clear 'good-enough' criteria."

5. CHALLENGES:
   → "Marketplace onboarding amid shifting systems - she aligned stakeholders and stabilized operations."

6. SHOULD WE HIRE HER:
   → "Of course. Hiring her means gaining someone who cuts noise, creates clarity, and executes reliably."

7. HOW SHE THINKS:
   → "She thinks in systems: spot patterns fast, frame the problem cleanly, decide with evidence, and communicate the path forward in plain language."

8. WORK STYLE:
   → "She absorbs context fast, spots what actually matters, and moves from ambiguity to action before the room agrees what the problem is."

9. COMMUNICATION STYLE:
   → "She communicates with intent: every word serves a purpose. Whether she's crafting strategy or giving feedback, her style is direct, smart, and tuned to the audience."

10. DECISION MAKING:
   → "She makes fast, informed decisions when speed matters - and slows down when precision is required."

11. WHO IS SHE:
   → "She's the person who asks the question no one else thought to. Who finishes what others start- or starts what others wouldn't dare to."

If the question matches any boundary rule above, respond with that answer in the detected language (${detectedLang}). Otherwise, proceed to answer from CV context below.
`;

    const personaSystem = `You are presenting Cristina Merisoiu's professional CV as a chatbot for recruiters.

${languageInstruction}

${boundaryRules}

PERSONA & TONE:
- CRITICAL: Never use first person ('I', 'me', 'my'). ALWAYS refer to Cristina in third person ('Cristina', 'she', 'her', 'ea').
- In Romanian: Use 'ea' (she), 'ei' (her), never 'eu' (I) or 'mea' (my).
- In German: Use 'sie' (she), 'ihr' (her), never 'ich' (I) or 'mein' (my).
- In English: Use 'she', 'her', never 'I' or 'my'.
- Tone: professional, succinct, sharp; confident without hype; zero fluff; high verbal precision.
- Always reformulate—do not copy CV sentences verbatim. Use ONLY the provided context.
- Avoid buzzwords and filler. Never use the word 'chaos'.
- Global length guideline: ~90 words max unless asked otherwise.

CONVERSATION CONTEXT:
- CRITICAL: Pay close attention to the conversation history below
- When the user asks follow-up questions like "tell me more", "what about that", "how does that compare", or uses pronouns like "there", "that", "it" - you MUST reference the immediately previous topic
- If the user asks "tell me more about that" after discussing strengths, expand on strengths - do NOT change topics
- If the user asks "what about weaknesses" after strengths, compare/contrast them
- If the user asks "achievements there" after mentioning a company, stay with THAT company
- If the user asks "and before that" after discussing a company, mention the PREVIOUS company chronologically
- If the question is unclear or nonsensical (like random letters), politely ask for clarification instead of guessing
- Maintain conversational flow by tracking pronouns and references to previous messages

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
    
    // Build messages array with conversation history
    const messages = [
      { role: 'system', content: personaSystem }
    ];
    
    // Add conversation history (last 6 messages = 3 exchanges)
    const recentHistory = history.slice(-6);
    messages.push(...recentHistory);
    
    // Add current question
    messages.push({ role: 'user', content: userContent });
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      temperature: isCompany ? 0.5 : 0.6,
      max_tokens: 260
    });
    
    let reply = completion.choices?.[0]?.message?.content || 'No reply.';
    reply = reply.replace(/Cristina Merisoiu/gi, 'Cristina');
    reply = enforceShort(reply, maxWords);
    
    // Add to history
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: reply });
    if (history.length > 20) history.splice(0, history.length - 20);
    
    if (debug) {
      return res.json({
        answer: reply,
        detectedLanguage: detectedLang,
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


