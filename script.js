// Frontend with design improvements: typing indicator, sample questions, avatar
const GPT_BACKEND_URL = 'https://cv-chatbot-f0ej.onrender.com/chat';
const chatBox = document.getElementById("chat-box");
const form = document.getElementById("chat-form");
const input = document.getElementById("user-input");

// --- Generate or get session ID for conversation memory ---
let sessionId = localStorage.getItem('chatSessionId');
if (!sessionId) {
  sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  localStorage.setItem('chatSessionId', sessionId);
}

// --- Detect browser language ---
function detectBrowserLanguage() {
  const browserLang = navigator.language || navigator.userLanguage;
  if (browserLang.startsWith('de')) return 'de';
  if (browserLang.startsWith('ro')) return 'ro';
  return 'en';
}

// --- Multilingual greetings ---
const GREETINGS = {
  en: "Hi there. I'm Cristina's CV, but interactive. I speak English, German, and Romanian. Ask me anything about her work. I won't bite.",
  de: "Hallo. Ich bin Cristinas Lebenslauf, nur interaktiv. Frag mich was du willst. Ich beiße nicht.",
  ro: "Salut. Sunt CV-ul Cristinei, dar interactiv. Întreabă-mă orice despre munca ei. Nu mușc."
};

// --- Sample questions (multilingual) ---
const SAMPLE_QUESTIONS = {
  en: [
    "What are her strengths?",
    "Tell me about her role at gannaca",
    "What challenges has she solved?",
    "Which languages does she speak?"
  ],
  de: [
    "Was sind ihre Stärken?",
    "Erzähl mir von ihrer Rolle bei gannaca",
    "Welche Herausforderungen hat sie gelöst?",
    "Welche Sprachen spricht sie?"
  ],
  ro: [
    "Care sunt punctele ei tari?",
    "Spune-mi despre rolul ei la gannaca",
    "Ce provocări a rezolvat?",
    "Ce limbi vorbește?"
  ]
};

// --- Utils: safe HTML ---
function escapeHtml(s = '') {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Tiny Markdown-ish to HTML converter ---
function toHtml(md = '') {
  let text = escapeHtml(md);
  
  text = text.replace(/```([\s\S]*?)```/g, (_m, code) => {
    return `<pre><code>${code}</code></pre>`;
  });
  
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/_(.+?)_/g, '<em>$1</em>');
  text = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  
  const lines = text.split(/\r?\n/);
  const out = [];
  let inUl = false, inOl = false;
  
  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };
  
  for (let raw of lines) {
    const line = raw.trim();
    
    if (!line) {
      closeLists();
      out.push('<p style="margin:6px 0;"></p>');
      continue;
    }
    
    let m = line.match(/^[-*•]\s+(.*)$/);
    if (m) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${m[1]}</li>`);
      continue;
    }
    
    m = line.match(/^\d+\.\s+(.*)$/);
    if (m) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${m[1]}</li>`);
      continue;
    }
    
    closeLists();
    out.push(`<p>${line}</p>`);
  }
  
  closeLists();
  return out.join('\n');
}

// --- Chat UI helpers ---
function addMessage(sender, msg, who = 'bot') {
  const wrap = document.createElement('div');
  wrap.className = `msg ${who === 'you' ? 'you' : 'bot'}`;
  
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  
  // Add avatar for bot messages
  if (who === 'bot') {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = 'C';
    wrap.appendChild(avatar);
  }
  
  bubble.innerHTML = `<span class="sender">${sender}</span>${toHtml(msg)}`;
  
  wrap.appendChild(bubble);
  chatBox.appendChild(wrap);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// --- Typing indicator ---
function showTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg bot typing-indicator';
  wrap.id = 'typing-indicator';
  
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = 'C';
  
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  
  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  chatBox.appendChild(wrap);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function hideTyping() {
  const typing = document.getElementById('typing-indicator');
  if (typing) typing.remove();
}

// --- Backend communication (NOW WITH SESSION ID) ---
async function askBackend(question) {
  const res = await fetch(GPT_BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      message: question,
      sessionId: sessionId  // ← Added this for memory!
    })
  });
  
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.answer || 'No reply.';
}

// --- Form submit ---
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const userMsg = input.value.trim();
  if (!userMsg) return;
  
  // Remove sample questions after first interaction
  const samples = document.querySelector('.sample-questions');
  if (samples) samples.remove();
  
  addMessage("You", userMsg, 'you');
  input.value = "";
  
  // Show typing indicator
  showTyping();
  
  try {
    const reply = await askBackend(userMsg);
    hideTyping();
    addMessage("Cristina, Distilled", reply, 'bot');
  } catch (err) {
    hideTyping();
    addMessage("Cristina, Distilled", "Oops — couldn't reach the server. Is it running?", 'bot');
    console.error(err);
  }
});

// --- Initial greeting ---
const userLang = detectBrowserLanguage();

// Help Modal functionality
const helpBtn = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const closeHelp = document.getElementById('close-help');

helpBtn.addEventListener('click', () => {
  helpModal.classList.remove('hidden');
});

closeHelp.addEventListener('click', () => {
  helpModal.classList.add('hidden');
});

// Close modal when clicking outside
helpModal.addEventListener('click', (e) => {
  if (e.target === helpModal) {
    helpModal.classList.add('hidden');
  }
});

// Handle sample question clicks in modal
document.querySelectorAll('.sample-question').forEach(btn => {
  btn.addEventListener('click', () => {
    const question = btn.getAttribute('data-question');
    document.getElementById('user-input').value = question;
    helpModal.classList.add('hidden');
    document.getElementById('chat-form').dispatchEvent(new Event('submit'));
  });
});

const greeting = GREETINGS[userLang] || GREETINGS.en;
addMessage("Cristina, Distilled", greeting);
// Removed showSampleQuestions(userLang) - no longer needed since they're in the help modal
