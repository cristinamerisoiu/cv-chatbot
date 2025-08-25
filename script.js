// Frontend with simple Markdown-like rendering for bullets, numbers, links.
// No backend change needed.

const GPT_BACKEND_URL = 'https://cv-chatbot-f0ej.onrender.com/chat';
 // keep your port if different

const chatBox = document.getElementById("chat-box");
const form = document.getElementById("chat-form");
const input = document.getElementById("user-input");

// --- Utils: safe HTML ---
function escapeHtml(s = '') {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Tiny Markdown-ish to HTML converter ---
// Supports: bullet lists (-, *, •), numbered lists (1.), paragraphs, **bold**, _italic_, links, code blocks.
function toHtml(md = '') {
  // 1) escape first
  let text = escapeHtml(md);

  // 2) code blocks ```...```
  text = text.replace(/```([\s\S]*?)```/g, (_m, code) => {
    return `<pre><code>${code}</code></pre>`;
  });

  // 3) inline bold / italic (keep it simple)
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/_(.+?)_/g, '<em>$1</em>');

  // 4) linkify
  text = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

  // 5) lists + paragraphs
  const lines = text.split(/\r?\n/);
  const out = [];
  let inUl = false, inOl = false;

  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };

  for (let raw of lines) {
    const line = raw.trim();

    // blank line → close any open list, insert small spacing
    if (!line) {
      closeLists();
      out.push('<p style="margin:6px 0;"></p>');
      continue;
    }

    // bullet list: -, *, •
    let m = line.match(/^[-*•]\s+(.*)$/);
    if (m) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${m[1]}</li>`);
      continue;
    }

    // numbered list: 1. 2. ...
    m = line.match(/^\d+\.\s+(.*)$/);
    if (m) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${m[1]}</li>`);
      continue;
    }

    // normal text line
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
  bubble.innerHTML = `<span class="sender">${sender}</span>${toHtml(msg)}`;

  wrap.appendChild(bubble);
  chatBox.appendChild(wrap);
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function askBackend(question) {
  const res = await fetch(GPT_BACKEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: question })
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

  addMessage("You", userMsg, 'you');
  input.value = "";

  try {
    const reply = await askBackend(userMsg);
    addMessage("CristinaBot", reply, 'bot');
  } catch (err) {
    addMessage("CristinaBot", "Oops — couldn’t reach the server. Is it running?", 'bot');
    console.error(err);
  }
});

// Optional: greet message
addMessage("Work, skills, challenges, growth — let’s keep it real and to the point."
'
);


