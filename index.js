// Load secrets from the .env file (token and chat IDs)
require('dotenv').config();

const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// Do not let small browser errors kill the whole bot.
// We print them instead, so we can still see what went wrong.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught exception:', err.message);
});

// Values from the .env file
// TG_TOKEN      = Telegram bot token
// TG_CHAT_ID    = Telegram group where messages go
// WA_CHAT_ID    = WhatsApp group we listen to
const { TG_TOKEN, TG_CHAT_ID, WA_CHAT_ID } = process.env;

if (!TG_TOKEN) {
  console.error('❌ TG_TOKEN is missing. Add it to the .env file.');
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

// Find Google Chrome on this computer.
// You can also set CHROME_PATH in .env to use a custom path.
const chromePaths = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].filter(Boolean);

const executablePath = chromePaths.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('❌ Google Chrome not found. Install it and restart.');
  process.exit(1);
}

// Small helper: wait for some milliseconds
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Queue ----------
// We send messages one by one, in the same order as WhatsApp.
// This also keeps us under the Telegram rate limit.
let queue = Promise.resolve();

function enqueue(task) {
  queue = queue
    .then(task)
    .catch((err) => console.error('❌ Forwarding error:', err.stack || err.message))
    .then(() => sleep(400)); // short pause between messages
}

// ---------- Telegram ----------
// Send one request to Telegram.
// If Telegram says "too many requests" (429), wait and try again.
async function tgRequest(method, makeBody, headers) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${TG_API}/${method}`, {
        method: 'POST',
        headers,
        body: makeBody(),
      });

      if (res.ok) {
        console.log(`✅ Telegram ${method} OK`);
        return true;
      }

      const data = await res.json().catch(() => ({}));

      // 429 = we are sending too fast. Telegram tells us how long to wait.
      if (res.status === 429) {
        const wait = (data.parameters?.retry_after || 5) + 1;
        console.log(`⏳ Telegram rate limit, waiting ${wait}s...`);
        await sleep(wait * 1000);
        continue;
      }

      console.error(`❌ Telegram ${method} error:`, JSON.stringify(data));
      return false;
    } catch (err) {
      // Network problem. Wait a bit and try again.
      console.error(`❌ Telegram ${method} request failed:`, err.message);
      await sleep(2000);
    }
  }
  return false;
}

// Send a plain text message
function sendText(text) {
  return tgRequest(
    'sendMessage',
    () => JSON.stringify({ chat_id: TG_CHAT_ID, text }),
    { 'Content-Type': 'application/json' }
  );
}

// Send a file (photo, video, voice, sticker, document...)
function sendFile(method, field, media, caption, fileName) {
  // WhatsApp gives the file as base64 text, so we turn it back into bytes
  const buffer = Buffer.from(media.data, 'base64');

  return tgRequest(method, () => {
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    // Telegram captions can be 1024 characters at most
    if (caption) form.append('caption', caption.slice(0, 1024));
    form.append(field, new Blob([buffer], { type: media.mimetype }), fileName);
    return form;
  });
}

// WhatsApp message type -> [Telegram method, form field name]
const routes = {
  image:    ['sendPhoto',    'photo'],
  video:    ['sendVideo',    'video'],
  ptt:      ['sendVoice',    'voice'],   // "ptt" = voice note
  audio:    ['sendAudio',    'audio'],
  sticker:  ['sendSticker',  'sticker'],
  document: ['sendDocument', 'document'],
};

// Get a file extension from a mimetype, like "image/jpeg" -> "jpeg"
function getExt(mimetype) {
  return (mimetype || 'application/octet-stream').split('/')[1].split(';')[0] || 'bin';
}

// Download the media from WhatsApp. Try up to 3 times,
// because the first try sometimes fails.
async function downloadWithRetry(msg) {
  for (let i = 1; i <= 3; i++) {
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) return media;
      console.log(`⚠️ downloadMedia returned empty (attempt ${i}/3)`);
    } catch (err) {
      console.log(`⚠️ downloadMedia threw (attempt ${i}/3):`, err.message);
    }
    await sleep(2000);
  }
  return null;
}

// Download a media message and send it to Telegram
async function forwardMedia(msg) {
  const media = await downloadWithRetry(msg);
  if (!media) {
    console.error(`❌ Could not download media (type: ${msg.type})`);
    return;
  }

  // Base64 text is about 33% bigger than the real file, so multiply by 0.75
  const sizeMB = (media.data.length * 0.75) / 1024 / 1024;
  console.log(`📦 Downloaded ${msg.type}, mimetype=${media.mimetype}, ~${sizeMB.toFixed(2)} MB`);

  const caption = msg.body || '';
  const fileName = media.filename || `${msg.type}.${getExt(media.mimetype)}`;

  // Pick the right Telegram method. Unknown types go as a normal document.
  const [method, field] = routes[msg.type] || ['sendDocument', 'document'];

  const ok = await sendFile(method, field, media, caption, fileName);

  // If Telegram refused it, send it again as a normal file
  if (!ok && method !== 'sendDocument') {
    console.log('↩️ Retrying as a regular document...');
    await sendFile('sendDocument', 'document', media, caption, fileName);
  }
}

// ---------- WhatsApp ----------
// LocalAuth saves the login in the .wwebjs_auth folder,
// so we do not need to scan the QR code every time.
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath,
    headless: true, // set to false if you want to see the browser window
    args: [
      '--no-sandbox',                    // needed on some systems and servers
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',         // avoids crashes when shared memory is small
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',                   // we do not need graphics
      '--disable-extensions',
    ],
  },
});

// Show the QR code in the terminal. Scan it with the WhatsApp app:
// Settings > Linked Devices > Link a device
client.on('qr', (qr) => {
  console.log('📱 Scan this QR code with WhatsApp (Linked Devices):');
  qrcode.generate(qr, { small: true });
});

// Status messages, useful for finding problems
client.on('authenticated', () => console.log('🔐 Authenticated'));
client.on('auth_failure', (m) => console.error('❌ Auth failure:', m));
client.on('disconnected', (r) => console.error('⚠️ Disconnected:', r));

// The bot is connected and ready
client.on('ready', () => {
  console.log('✅ WhatsApp ready');
  if (!WA_CHAT_ID) console.log('Send a message in your group to print its ID');
});

// This runs for every message, including the ones we send ourselves
client.on('message_create', (msg) => {
  // If the message is ours, the chat is in "msg.to". Otherwise it is in "msg.from".
  const chatId = msg.fromMe ? msg.to : msg.from;

  // ID mode: if WA_CHAT_ID is empty, only print the chat ID
  // so we can copy it into the .env file.
  if (!WA_CHAT_ID) {
    console.log(chatId.endsWith('@g.us') ? 'GROUP =>' : 'PRIVATE =>', chatId);
    return;
  }

  // Ignore every chat except our group
  if (chatId !== WA_CHAT_ID) return;

  console.log(`📨 New message: type=${msg.type}, hasMedia=${msg.hasMedia}`);

  // Put the message in the queue. Files and text are handled differently.
  enqueue(async () => {
    if (msg.hasMedia) await forwardMedia(msg);
    else if (msg.body) await sendText(msg.body);
  });
});

// Start the bot
client.initialize();