# WhatsApp to Telegram Forwarding Bot

A small Node.js bot that forwards messages from one WhatsApp group to one Telegram group.
It supports text, photos, videos, voice notes, stickers and files.

## How it works

WhatsApp group -> this bot (Node.js) -> Telegram Bot API -> Telegram group

- The bot logs in to WhatsApp as a linked device (QR code).
- It only reads messages. It never sends anything to WhatsApp.
- A queue keeps the message order and respects Telegram rate limits.

## Setup

1. Install Node.js (LTS) and Google Chrome.
2. Install packages:
   ```
   npm install
   ```
3. Create a Telegram bot with @BotFather and copy the token.
4. Copy `.env.example` to `.env` and fill in the values.
5. Start the bot:
   ```
   npm start
   ```
6. Scan the QR code from WhatsApp: Settings > Linked Devices > Link a device.

## Finding the IDs

- Telegram chat ID: add the bot to your group, send a message, then open
  `https://api.telegram.org/bot<TOKEN>/getUpdates` and look for `"chat":{"id":...`.
- WhatsApp group ID: leave `WA_CHAT_ID` empty, start the bot and send a message
  in the group. The bot prints the ID in the terminal.

## Security

- The token and IDs are in `.env`, which is not uploaded to GitHub.
- The WhatsApp login is saved in `.wwebjs_auth`, which is also not uploaded.
- Never share these files.

## Notes

- This project uses `whatsapp-web.js`, an **unofficial** library. It may break the
  WhatsApp terms of service, so I tested it on a secondary number. It is for learning.
- Built with AI assistance. I understand the code and can explain every part.
