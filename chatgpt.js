#!/usr/bin/env node
// chatgpt.js - Interact with ChatGPT via Chrome DevTools Protocol
// Requires: Chrome running with --remote-debugging-port=9222
//
// Usage:
//   Send a question and get the response:
//     node chatgpt.js send "Your question here"
//     node chatgpt.js send "Your question here" --raw
//
//   Send in a new chat:
//     node chatgpt.js send "Your question here" --new-chat
//
//   Read the last N responses (default 1):
//     node chatgpt.js read
//     node chatgpt.js read 3
//     node chatgpt.js read --all

const puppeteer = require('puppeteer-core');

const CDP_URL = 'http://localhost:9222';

// Parse command and flags
const argv = process.argv.slice(2);
const command = argv[0];
const flags = argv.filter(a => a.startsWith('--'));
const positional = argv.filter(a => !a.startsWith('--')).slice(1);

const rawOutput = flags.includes('--raw');
const newChat = flags.includes('--new-chat');
const readAll = flags.includes('--all');
const noPrompt = flags.includes('--no-prompt');

const FORMAT_PROMPT = '[Format: clean markdown. Headings MUST use # for h1, ## for h2, ### for h3. ' +
  'Inline math: $...$. Display math: $$...$$ on its own line. ' +
  'Code: fenced blocks with language tags. Never use plain text as headings.] ';

function log(msg) {
  if (!rawOutput) console.error(msg);
}

function usage() {
  console.error(`Usage:
  node chatgpt.js send "Your question"              Send and get response
  node chatgpt.js send "Your question" --raw         Response only, no status
  node chatgpt.js send "Your question" --new-chat    Start a new chat first
  node chatgpt.js read                               Read last response
  node chatgpt.js read N                             Read last N responses
  node chatgpt.js read --all                         Read all responses`);
  process.exit(1);
}

if (!command || !['send', 'read'].includes(command)) {
  usage();
}

// This function runs inside page.evaluate — must be self-contained
function extractMessages(count) {
  function extractNode(node) {
    const parts = [];

    if (node.tagName === 'PRE') {
      const code = node.querySelector('code');
      let lang = code?.className?.match(/language-(\w+)/)?.[1] || '';
      let codeText = (code || node).innerText.trim();
      const lines = codeText.split('\n');
      if (!lang && lines.length > 1 && /^[A-Za-z+#]+$/.test(lines[0].trim())) {
        lang = lines[0].trim().toLowerCase();
        codeText = lines.slice(1).join('\n').trim();
      }
      parts.push('\n```' + lang + '\n' + codeText + '\n```\n');
      return parts;
    }

    if (node.tagName === 'CODE' && node.closest('pre') === null) {
      parts.push('`' + node.textContent + '`');
      return parts;
    }

    if (node.tagName === 'MATH' || node.classList?.contains('katex') || node.classList?.contains('MathJax')) {
      const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation) {
        const isBlock = node.closest('.katex-display') || node.closest('[display="block"]') || node.getAttribute('display') === 'block';
        if (isBlock) {
          parts.push('\n$$\n' + annotation.textContent.trim() + '\n$$\n');
        } else {
          parts.push('$' + annotation.textContent.trim() + '$');
        }
        return parts;
      }
    }

    if (node.classList?.contains('katex-html') || node.classList?.contains('MathJax_Display')) {
      return parts;
    }

    // Headings -> markdown # syntax
    const headingLevel = { H1: '#', H2: '##', H3: '###', H4: '####', H5: '#####', H6: '######' };
    if (headingLevel[node.tagName]) {
      const prefix = headingLevel[node.tagName];
      const children = [];
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) children.push(child.textContent);
        else if (child.nodeType === Node.ELEMENT_NODE) children.push(...extractNode(child));
      }
      parts.push('\n' + prefix + ' ' + children.join('').trim() + '\n');
      return parts;
    }

    // Strong/bold -> **text**
    if (node.tagName === 'STRONG' || node.tagName === 'B') {
      const children = [];
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) children.push(child.textContent);
        else if (child.nodeType === Node.ELEMENT_NODE) children.push(...extractNode(child));
      }
      parts.push('**' + children.join('') + '**');
      return parts;
    }

    // Emphasis -> *text*
    if (node.tagName === 'EM' || node.tagName === 'I') {
      const children = [];
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) children.push(child.textContent);
        else if (child.nodeType === Node.ELEMENT_NODE) children.push(...extractNode(child));
      }
      parts.push('*' + children.join('') + '*');
      return parts;
    }

    // List items -> "- " prefix
    if (node.tagName === 'LI') {
      const children = [];
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) children.push(child.textContent);
        else if (child.nodeType === Node.ELEMENT_NODE) children.push(...extractNode(child));
      }
      parts.push('- ' + children.join('').trim() + '\n');
      return parts;
    }

    // Generic recursion for other elements
    if (node.childNodes && node.childNodes.length > 0) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          parts.push(child.textContent);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          parts.push(...extractNode(child));
        }
      }
      const blockTags = ['P', 'DIV', 'OL', 'UL', 'BR', 'HR'];
      if (blockTags.includes(node.tagName)) {
        parts.push('\n');
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent);
    }

    return parts;
  }

  const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
  const arr = Array.from(msgs);
  const selected = count === 0 ? arr : arr.slice(-count);

  return selected.map(msg => {
    const parts = extractNode(msg);
    return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
  });
}

(async () => {
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL });
  } catch (e) {
    console.error('Error: Cannot connect to Chrome.');
    console.error('Launch Chrome with: ./launch_browser.sh');
    process.exit(1);
  }

  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('chatgpt.com'));

  if (!page) {
    console.error('Error: No ChatGPT tab found. Open https://chatgpt.com in Chrome.');
    browser.disconnect();
    process.exit(1);
  }

  log('Connected to ChatGPT tab.');

  // ---- READ MODE ----
  if (command === 'read') {
    const count = readAll ? 0 : parseInt(positional[0] || '1', 10);

    const responses = await page.evaluate(extractMessages, count);

    if (responses.length === 0) {
      console.error('No assistant responses found in the current chat.');
    } else {
      responses.forEach((r, i) => {
        if (responses.length > 1 && !rawOutput) {
          console.log(`\n--- Response ${i + 1} ---`);
        } else if (responses.length > 1 && rawOutput) {
          if (i > 0) console.log('\n---\n');
        }
        console.log(r);
      });
    }

    browser.disconnect();
    return;
  }

  // ---- SEND MODE ----
  let text = positional[0];
  if (!text) {
    console.error('Error: No question provided.');
    usage();
  }

  // Prepend formatting instructions unless --no-prompt is set
  if (!noPrompt) {
    text = FORMAT_PROMPT + text;
  }

  // Start a new chat if requested
  if (newChat) {
    log('Starting new chat...');
    await page.goto('https://chatgpt.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
  }

  // Count existing assistant messages before sending
  const beforeCount = await page.evaluate(() => {
    return document.querySelectorAll('[data-message-author-role="assistant"]').length;
  });

  // Click the textarea and type the message
  const textarea = await page.$('#prompt-textarea');
  if (!textarea) {
    console.error('Error: Could not find the ChatGPT input box.');
    browser.disconnect();
    process.exit(1);
  }

  await textarea.click();
  await page.keyboard.type(text, { delay: 30 });
  log(`Typed: ${text}`);

  // Press Enter to send
  await page.keyboard.press('Enter');
  log('Message sent. Waiting for response...');

  // Wait for a new assistant message to appear
  await page.waitForFunction(
    (prevCount) => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      return msgs.length > prevCount;
    },
    { timeout: 60000 },
    beforeCount
  );

  // Wait for the response to finish streaming
  await page.waitForFunction(
    () => {
      const stopBtn = document.querySelector('[data-testid="stop-button"]');
      return !stopBtn;
    },
    { timeout: 120000, polling: 500 }
  );

  await new Promise(r => setTimeout(r, 500));

  // Read the last assistant message
  const responses = await page.evaluate(extractMessages, 1);
  const response = responses[0];

  if (response) {
    if (!rawOutput) console.log('\n--- ChatGPT Response ---');
    console.log(response);
  } else {
    console.error('Could not read the response.');
  }

  browser.disconnect();
})();
