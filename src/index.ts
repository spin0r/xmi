import axios from 'axios';
import { config } from './config/env';
import { handleUpdate } from './handlers';
import { startServer } from './api';

let offset = 0;

async function pollUpdates() {
  try {
    const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`;
    const { data } = await axios.get(url);

    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        await handleUpdate(update);
        offset = update.update_id + 1;
      }
    }
  } catch (error: any) {
    console.error("Poll error:", error.message);
  }

  setTimeout(pollUpdates, 100);
}

console.log("🤖 Telegram IMX Uploader Bot Starting...");
console.log("📡 Polling for updates...\n");

startServer(process.env.PORT ? parseInt(process.env.PORT) : 3000);

pollUpdates();
