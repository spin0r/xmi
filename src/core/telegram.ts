import axios from 'axios';
import { config } from '../config/env';

export async function sendMessage(chatId: number | string, text: string, replyToMessageId: number | null = null): Promise<any> {
  const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  const payload: any = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
  };
  
  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
  }

  const { data } = await axios.post(url, payload);
  return data.result;
}

export async function editMessage(chatId: number | string, messageId: number, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/editMessageText`;
  
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML',
  };

  try {
    await axios.post(url, payload);
  } catch (error) {
    // Ignore errors if message is the same
  }
}

export async function getFileUrl(fileId: string): Promise<string> {
  const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
  const { data } = await axios.get(url);
  
  if (data.ok) {
    return `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
  }
  
  throw new Error('Failed to get file URL');
}

export async function sendUploadSummaryToChannel(params: {
  galleryName: string | null;
  total: number;
  uploaded: number;
  failed: number;
  extracted: number;
  galleryUrl: string | null;
  pasteUrl: string | null;
}): Promise<void> {
  try {
    const text = `📤 <b>IMX Upload Complete</b>\n\n` +
      `📁 Gallery: ${params.galleryName || 'N/A'}\n` +
      `📊 Total: ${params.total} | Uploaded: ${params.uploaded} | Failed: ${params.failed}\n` +
      `🔗 Extracted: ${params.extracted} direct URLs\n` +
      `🖼 Gallery: ${params.galleryUrl || 'N/A'}\n` +
      `📋 Paste: ${params.pasteUrl || 'N/A'}\n\n` +
      `⏰ ${new Date().toISOString()}`;

    await sendMessage(config.TELEGRAM_CHAT_ID, text);
  } catch (error: any) {
    process.stderr.write(`Failed to send summary to Telegram: ${error.message}\n`);
  }
}
