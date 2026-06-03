import axios from 'axios';
import { sendMessage, editMessage, getFileUrl, sendUploadSummaryToChannel } from './core/telegram';
import { getImxDirectUrl, uploadToImx, createGalleryWithName } from './core/imx';
import { uploadToPb } from './core/pb';

async function downloadFile(url: string): Promise<Buffer> {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

export async function processImxLinks(chatId: number, text: string, messageId: number) {
  let statusMessageId: number = 0;

  try {
    const imxLinks = text.match(/https?:\/\/imx\.to\/i\/[a-zA-Z0-9]+/g);
    if (!imxLinks || imxLinks.length === 0) {
      await sendMessage(chatId, "❌ No valid imx.to links found", messageId);
      return;
    }

    const statusMsg = await sendMessage(
      chatId,
      `🔄 Extracting direct URLs from ${imxLinks.length} imx.to links...`,
      messageId
    );
    statusMessageId = statusMsg.message_id;

    const directUrls: string[] = [];

    for (let i = 0; i < imxLinks.length; i++) {
      const imxUrl = imxLinks[i];
      try {
        const directUrl = await getImxDirectUrl(imxUrl);
        if (directUrl) {
          directUrls.push(directUrl);
        }

        let progressText = `🔍 Extracting direct URLs...\n\n`;
        progressText += `Progress: ${i + 1}/${imxLinks.length}\n`;
        progressText += `✓ Found: ${directUrls.length}`;
        await editMessage(chatId, statusMessageId, progressText);

        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (error: any) {
        console.error(`Failed to process ${imxUrl}:`, error.message);
      }
    }

    if (directUrls.length === 0) {
      await editMessage(chatId, statusMessageId, "❌ Could not extract any direct URLs");
      return;
    }

    await editMessage(chatId, statusMessageId, "📤 Uploading to pb...");

    let pbContent = "=== IMX Direct URLs ===\n\n";
    pbContent += `Extracted: ${new Date().toISOString()}\n`;
    pbContent += `Total URLs: ${directUrls.length}\n\n`;
    pbContent += "--- Direct Image Links (One per line) ---\n";
    directUrls.forEach((url) => (pbContent += `${url}\n`));

    const pbResult = await uploadToPb(pbContent);

    let finalMessage = `✅ <b>Extraction Complete!</b>\n\n`;
    finalMessage += `📊 Extracted: ${directUrls.length}/${imxLinks.length}\n`;
    finalMessage += `🔗 Direct URLs: ${pbResult.url}\n`;
    finalMessage += `⏰ Expires in 24 hours`;

    await editMessage(chatId, statusMessageId, finalMessage);
  } catch (error: any) {
    if (statusMessageId !== 0) {
      await editMessage(chatId, statusMessageId, `❌ Error: ${error.message}`);
    } else {
      await sendMessage(chatId, `❌ Error: ${error.message}`, messageId);
    }
  }
}

export async function processPbUrl(chatId: number, pbUrl: string, galleryName: string, messageId: number) {
  let statusMessageId: number = 0;

  try {
    const statusMsg = await sendMessage(chatId, "🔄 Fetching image URLs...", messageId);
    statusMessageId = statusMsg.message_id;

    const { data } = await axios.get(pbUrl);
    const imageUrls = typeof data === 'string' 
      ? data.split("\n").filter((line) => {
          const trimmed = line.trim();
          return trimmed && trimmed.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i);
        })
      : [];

    if (imageUrls.length === 0) {
      await editMessage(chatId, statusMessageId, "❌ No image URLs found in the paste");
      return;
    }

    await editMessage(
      chatId,
      statusMessageId,
      `✅ Found ${imageUrls.length} images. Starting upload...\n📤 Progress: 0/${imageUrls.length}`
    );

    let galleryId: string | null = null;

    if (galleryName) {
      try {
        await editMessage(chatId, statusMessageId, `🖼 Creating gallery: ${galleryName}...`);
        galleryId = await createGalleryWithName(galleryName);
      } catch (err: any) {
        await editMessage(chatId, statusMessageId, `⚠️ Failed to pre-create gallery: ${err.message}. Uploading without name.`);
      }
    }

    const results: any[] = [];

    // First image
    if (imageUrls.length > 0) {
      try {
        const firstUrl = imageUrls[0].trim();
        const imageBuffer = await downloadFile(firstUrl);
        const filename = `image_1.jpg`;

        const imxResult = await uploadToImx(imageBuffer, filename, galleryId);
        if (!galleryId && imxResult.gallery_id) {
          galleryId = imxResult.gallery_id;
        }

        results.push({
          index: 0,
          imx_url: imxResult.image_url,
          thumbnail: imxResult.thumbnail_url,
          gallery_id: imxResult.gallery_id,
        });

        let progressText = `✅ Found ${imageUrls.length} images\n\n`;
        progressText += `📤 Uploading to IMX...\n`;
        progressText += `Progress: 1/${imageUrls.length}\n`;
        progressText += `✓ Success: 1\n`;
        if (galleryId) progressText += `🖼 Gallery: ${galleryId}`;
        await editMessage(chatId, statusMessageId, progressText);
      } catch (error: any) {
        results.push({ index: 0, error: error.message });
      }
    }

    // Remaining images in batches of 15
    const BATCH_SIZE = 15;
    const remainingUrls = imageUrls.slice(1).map((url, index) => ({
      url: url.trim(),
      index: index + 1,
    }));

    for (let i = 0; i < remainingUrls.length; i += BATCH_SIZE) {
      const batch = remainingUrls.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async ({ url, index }) => {
          try {
            const imageBuffer = await downloadFile(url);
            const filename = `image_${index + 1}.jpg`;
            const imxResult = await uploadToImx(imageBuffer, filename, galleryId);
            return {
              index,
              imx_url: imxResult.image_url,
              thumbnail: imxResult.thumbnail_url,
              gallery_id: imxResult.gallery_id,
            };
          } catch (error: any) {
            return { index, error: error.message };
          }
        })
      );

      results.push(...batchResults);

      const successCount = results.filter((r) => r.imx_url).length;
      const failCount = results.filter((r) => r.error).length;
      let progressText = `✅ Found ${imageUrls.length} images\n\n`;
      progressText += `📤 Uploading to IMX...\n`;
      progressText += `Progress: ${Math.min(i + BATCH_SIZE + 1, imageUrls.length)}/${imageUrls.length}\n`;
      progressText += `✓ Success: ${successCount}\n`;
      if (failCount > 0) progressText += `✗ Failed: ${failCount}\n`;
      if (galleryId) progressText += `🖼 Gallery: ${galleryId}`;

      await editMessage(chatId, statusMessageId, progressText);
    }

    results.sort((a, b) => a.index - b.index);
    const successResults = results.filter((r) => r.imx_url);

    await editMessage(
      chatId,
      statusMessageId,
      `✅ Upload complete!\n\n🔍 Extracting direct URLs from ${successResults.length} imx.to links...`
    );

    const directUrls: string[] = [];
    const EXTRACT_BATCH_SIZE = 15;

    for (let i = 0; i < successResults.length; i += EXTRACT_BATCH_SIZE) {
      const batch = successResults.slice(i, i + EXTRACT_BATCH_SIZE);

      const batchUrls = await Promise.all(
        batch.map(async (result, batchIndex) => {
          try {
            const directUrl = await getImxDirectUrl(result.imx_url);
            return { index: result.index, url: directUrl };
          } catch (error: any) {
            return { index: result.index, url: null };
          }
        })
      );

      batchUrls.sort((a, b) => a.index - b.index);
      batchUrls.forEach((r) => {
        if (r.url) directUrls.push(r.url);
      });

      let progressText = `✅ Upload complete!\n\n`;
      progressText += `🔍 Extracting direct URLs...\n`;
      progressText += `Progress: ${Math.min(i + EXTRACT_BATCH_SIZE, successResults.length)}/${successResults.length}\n`;
      progressText += `✓ Extracted: ${directUrls.length}`;
      await editMessage(chatId, statusMessageId, progressText);
    }

    await editMessage(chatId, statusMessageId, "📤 Uploading results to pb...");

    const galleryUrl = galleryId ? `https://imx.to/g/${galleryId}` : null;

    let pbContent = "";
    directUrls.forEach((url) => (pbContent += `${url}\n`));

    const pbResult = await uploadToPb(pbContent);

    let finalMessage = `✅ <b>Upload Complete!</b>\n\n`;
    finalMessage += `📊 Success: ${successResults.length}/${imageUrls.length}\n`;
    finalMessage += `🔗 Direct URLs extracted: ${directUrls.length}\n`;
    if (galleryUrl) finalMessage += `🖼 Gallery: ${galleryUrl}\n`;
    finalMessage += `🔗 Direct URLs: ${pbResult.url}\n`;
    finalMessage += `⏰ Expires in 24 hours`;

    await editMessage(chatId, statusMessageId, finalMessage);

    await sendUploadSummaryToChannel({
      galleryName: galleryName || null,
      total: imageUrls.length,
      uploaded: successResults.length,
      failed: imageUrls.length - successResults.length,
      extracted: directUrls.length,
      galleryUrl: galleryUrl,
      pasteUrl: pbResult.url,
    });
  } catch (error: any) {
    if (statusMessageId !== 0) {
      await editMessage(chatId, statusMessageId, `❌ Error: ${error.message}`);
    } else {
      await sendMessage(chatId, `❌ Error: ${error.message}`, messageId);
    }
  }
}

export async function processPhoto(chatId: number, fileId: string, messageId: number) {
  let statusMessageId: number = 0;

  try {
    const statusMsg = await sendMessage(chatId, "🔄 Uploading to IMX...", messageId);
    statusMessageId = statusMsg.message_id;

    const fileUrl = await getFileUrl(fileId);
    const imageBuffer = await downloadFile(fileUrl);
    const filename = `telegram_${Date.now()}.jpg`;

    const imxResult = await uploadToImx(imageBuffer, filename);

    let finalMessage = `✅ <b>Upload Successful!</b>\n\n`;
    finalMessage += `🔗 Direct Link:\n<code>${imxResult.image_url}</code>\n\n`;
    finalMessage += `🖼 Thumbnail:\n<code>${imxResult.thumbnail_url}</code>`;

    await editMessage(chatId, statusMessageId, finalMessage);
  } catch (error: any) {
    if (statusMessageId !== 0) {
      await editMessage(chatId, statusMessageId, `❌ Error: ${error.message}`);
    } else {
      await sendMessage(chatId, `❌ Error: ${error.message}`, messageId);
    }
  }
}

export async function handleUpdate(update: any) {
  if (!update.message) return;

  const chatId = update.message.chat.id;
  const messageId = update.message.message_id;
  const text = update.message.text || "";

  if (text === "/start") {
    const welcome =
      `👋 <b>Welcome to IMX Uploader Bot!</b>\n\n` +
      `📸 Send me:\n` +
      `• A photo to upload to IMX\n` +
      `• A pb.dotrhelvetican.workers.dev URL with image links [Optional Gallery Name]\n` +
      `• imx.to links to extract direct URLs\n\n` +
      `⚡️ Ready to upload!`;
    await sendMessage(chatId, welcome, messageId);
    return;
  }

  if (text === "/help") {
    const help =
      `<b>How to use:</b>\n\n` +
      `1️⃣ Send a photo directly\n` +
      `2️⃣ Send a pb URL with image links (optionally followed by gallery name)\n` +
      `3️⃣ Send imx.to links to get direct URLs\n\n` +
      `<b>Example pb URL:</b>\n` +
      `https://pb.dotrhelvetican.workers.dev/yG2A My Cool Gallery\n\n` +
      `<b>Example imx.to links:</b>\n` +
      `https://imx.to/i/6p99b5\n` +
      `https://imx.to/i/6p99b6\n\n` +
      `All results are saved to pb with 24h expiry.`;
    await sendMessage(chatId, help, messageId);
    return;
  }

  if (text.includes("imx.to/i/")) {
    await processImxLinks(chatId, text, messageId);
    return;
  }

  if (text.includes("pb.dotrhelvetican.workers.dev")) {
    const parts = text.trim().split(/\s+/);
    const pbUrl = parts.find((p: string) => p.includes("pb.dotrhelvetican.workers.dev"));
    if (pbUrl) {
      const galleryName = parts.filter((p: string) => p !== pbUrl).join(" ");
      await processPbUrl(chatId, pbUrl, galleryName, messageId);
    }
    return;
  }

  if (update.message.photo) {
    const photo = update.message.photo[update.message.photo.length - 1];
    await processPhoto(chatId, photo.file_id, messageId);
    return;
  }

  if (update.message.document && update.message.document.mime_type?.startsWith("image/")) {
    await processPhoto(chatId, update.message.document.file_id, messageId);
    return;
  }

  await sendMessage(
    chatId,
    "❓ Send me:\n• A photo\n• A pb URL with image links\n• imx.to links to extract direct URLs\n\nUse /help for more info.",
    messageId
  );
}
