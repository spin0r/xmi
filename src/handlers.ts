import axios from 'axios';
import { Archiver, ZipArchive } from 'archiver';
import { PassThrough } from 'stream';
import { sendMessage, editMessage, getFileUrl, sendUploadSummaryToChannel } from './core/telegram';
import { getImxDirectUrl, uploadToImx, createGalleryWithName } from './core/imx';
import { uploadToPb } from './core/pb';
import { uploadToCatbox } from './core/catbox';
import AdmZip from 'adm-zip';
import path from 'path';

export const cancelRequests = new Set<number>();

async function downloadFile(url: string, retries: number = 3): Promise<Buffer> {
  let attempt = 0;
  while (attempt < retries) {
    try {
      const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
      return Buffer.from(response.data);
    } catch (error: any) {
      attempt++;
      if (attempt >= retries) throw error;
      console.warn(`Retry ${attempt}/${retries} for ${url} due to error: ${error.message}`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error("Unreachable");
}

function getExtFromUrl(url: string): string {
  const match = url.match(/\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i);
  return match ? `.${match[1].toLowerCase()}` : '.jpg';
}

function createZipArchive(): Archiver {
  return new ZipArchive({ zlib: { level: 5 } });
}

async function downloadAndZipImages(
  directUrls: string[],
  zipName: string,
  onProgress?: (done: number, total: number) => void
): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    const archive = createZipArchive();
    const chunks: Buffer[] = [];
    const passThrough = new PassThrough();

    passThrough.on('data', (chunk: Buffer) => chunks.push(chunk));
    passThrough.on('end', () => resolve(Buffer.concat(chunks)));
    passThrough.on('error', reject);
    archive.on('error', reject);

    archive.pipe(passThrough);

    const BATCH_SIZE = 10;
    let totalDownloaded = 0;

    for (let i = 0; i < directUrls.length; i += BATCH_SIZE) {
      const batch = directUrls.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (url, idx) => {
        const absoluteIndex = i + idx;
        try {
          const imgBuffer = await downloadFile(url);
          const ext = getExtFromUrl(url);
          return { absoluteIndex, buffer: imgBuffer, ext, error: null };
        } catch (err: any) {
          console.error(`Failed to download image ${absoluteIndex + 1}: ${err.message}`);
          return { absoluteIndex, buffer: null, ext: '', error: err };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      // Sort by absolute index to strictly preserve the original order
      batchResults.sort((a, b) => a.absoluteIndex - b.absoluteIndex);

      for (const res of batchResults) {
        if (res.buffer) {
          archive.append(res.buffer, { name: `${res.absoluteIndex + 1}${res.ext}` });
        }
        totalDownloaded++;
        if (onProgress) onProgress(totalDownloaded, directUrls.length);
      }
    }

    await archive.finalize();
  });
}

export async function processImxLinks(chatId: number, text: string, messageId: number) {
  let statusMessageId: number = 0;

  try {
    const imxLinks = text.match(/https?:\/\/imx\.to\/i\/[a-zA-Z0-9]+/g);
    if (!imxLinks || imxLinks.length === 0) {
      await sendMessage(chatId, "❌ No valid imx.to links found", messageId);
      return;
    }

    console.log(`[Chat ${chatId}] Extracting direct URLs from ${imxLinks.length} imx.to links...`);

    const statusMsg = await sendMessage(
      chatId,
      `🔄 Extracting direct URLs from ${imxLinks.length} imx.to links...`,
      messageId
    );
    statusMessageId = statusMsg.message_id;

    const directUrls: string[] = [];

    for (let i = 0; i < imxLinks.length; i++) {
      if (cancelRequests.has(chatId)) {
        cancelRequests.delete(chatId);
        throw new Error("Operation cancelled by user.");
      }

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
    finalMessage += `⏰ Expires in 7 days`;

    await editMessage(chatId, statusMessageId, finalMessage);
  } catch (error: any) {
    if (statusMessageId !== 0) {
      await editMessage(chatId, statusMessageId, `❌ Error: ${error.message}`);
    } else {
      await sendMessage(chatId, `❌ Error: ${error.message}`, messageId);
    }
  }
}

export async function processPbUrl(chatId: number, pbUrl: string, galleryName: string, messageId: number, enableCatbox: boolean = false) {
  let statusMessageId: number = 0;
  let results: any[] = [];
  let directUrls: string[] = [];
  console.log(`[Chat ${chatId}] Processing Pastebin URL: ${pbUrl} (Gallery: ${galleryName || 'None'})`);

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
      console.log(`[Chat ${chatId}] No image URLs found in Pastebin.`);
      await editMessage(chatId, statusMessageId, "❌ No image URLs found in the paste");
      return;
    }

    console.log(`[Chat ${chatId}] Found ${imageUrls.length} images from Pastebin. Starting upload...`);

    await editMessage(
      chatId,
      statusMessageId,
      `✅ Found ${imageUrls.length} images. Starting upload...\n📤 Progress: 0/${imageUrls.length}`
    );

    let galleryId: string | null = null;

    if (galleryName) {
      try {
        const sanitizedName = galleryName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        await editMessage(chatId, statusMessageId, `🖼 Creating gallery: ${sanitizedName}...`);
        galleryId = await createGalleryWithName(sanitizedName);
      } catch (err: any) {
        await editMessage(chatId, statusMessageId, `⚠️ Failed to pre-create gallery: ${err.message}. Uploading without name.`);
      }
    }

    results = [];

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
      if (cancelRequests.has(chatId)) {
        cancelRequests.delete(chatId);
        throw new Error("Operation cancelled by user.");
      }

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
      console.log(`[Chat ${chatId}] IMX Upload Progress: ${Math.min(i + BATCH_SIZE, imageUrls.length)}/${imageUrls.length} (Success: ${successCount}, Failed: ${failCount})`);
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

    directUrls = [];
    const EXTRACT_BATCH_SIZE = 15;

    for (let i = 0; i < successResults.length; i += EXTRACT_BATCH_SIZE) {
      if (cancelRequests.has(chatId)) {
        cancelRequests.delete(chatId);
        throw new Error("Operation cancelled by user.");
      }

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

    // --- Download, zip, and upload to catbox.moe (only if requested) ---
    let catboxUrl: string | null = null;
    if (enableCatbox && directUrls.length > 0) {
      try {
        await editMessage(chatId, statusMessageId, `📦 Creating zip... Downloading ${directUrls.length} images...`);

        const zipName = galleryName
          ? galleryName.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').toLowerCase()
          : 'images';

        const zipBuffer = await downloadAndZipImages(
          directUrls,
          zipName,
          async (done, total) => {
            if (done % 10 === 0 || done === total) {
              await editMessage(
                chatId,
                statusMessageId,
                `📦 Creating zip... Downloading ${done}/${total} images...`
              );
            }
          }
        );

        await editMessage(chatId, statusMessageId, `📤 Uploading zip to catbox.moe (${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB)...`);
        catboxUrl = await uploadToCatbox(zipBuffer, `${zipName}.zip`);
        console.log(`[Chat ${chatId}] Catbox upload complete: ${catboxUrl}`);
      } catch (err: any) {
        console.error(`[Chat ${chatId}] Catbox zip/upload failed:`, err.message);
        await editMessage(chatId, statusMessageId, `⚠️ Zip upload to catbox failed: ${err.message}\nContinuing...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    let finalMessage = `✅ <b>Upload Complete!</b>\n\n`;
    finalMessage += `📊 Success: ${successResults.length}/${imageUrls.length}\n`;
    finalMessage += `🔗 Direct URLs extracted: ${directUrls.length}\n`;
    if (galleryUrl) finalMessage += `🖼 Gallery: ${galleryUrl}\n`;
    finalMessage += `🔗 Direct URLs: ${pbResult.url}\n`;
    if (catboxUrl) finalMessage += `📦 Zip Download: ${catboxUrl}\n`;
    finalMessage += `⏰ Expires in 7 days`;

    await editMessage(chatId, statusMessageId, finalMessage);

    await sendUploadSummaryToChannel({
      galleryName: galleryName || null,
      total: imageUrls.length,
      uploaded: successResults.length,
      failed: imageUrls.length - successResults.length,
      extracted: directUrls.length,
      galleryUrl: galleryUrl,
      pasteUrl: pbResult.url,
      catboxUrl: catboxUrl,
    });
  } catch (error: any) {
    if (statusMessageId !== 0) {
      await editMessage(chatId, statusMessageId, `❌ Error: ${error.message}`);
    } else {
      await sendMessage(chatId, `❌ Error: ${error.message}`, messageId);
    }
  } finally {
    results.length = 0;
    directUrls.length = 0;
    console.log(`[Chat ${chatId}] Cleanup complete.`);
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

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

export async function processZipFile(chatId: number, fileId: string, galleryName: string, messageId: number, enableCatbox: boolean = false) {
  let statusMessageId: number = 0;
  let results: any[] = [];
  let directUrls: string[] = [];
  let zipBuffer: Buffer | null = null;
  let zip: AdmZip | null = null;
  let imageEntries: any[] = [];
  console.log(`[Chat ${chatId}] Processing zip file (Gallery: ${galleryName || 'None'})`);

  try {
    const statusMsg = await sendMessage(chatId, "🔄 Downloading zip file...", messageId);
    statusMessageId = statusMsg.message_id;

    // Download zip from Telegram
    const fileUrl = await getFileUrl(fileId);
    zipBuffer = await downloadFile(fileUrl);

    await editMessage(chatId, statusMessageId, "📦 Extracting images from zip...");

    // Extract images from zip
    zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    imageEntries = entries
      .filter(entry => {
        if (entry.isDirectory) return false;
        const ext = path.extname(entry.entryName).toLowerCase();
        return IMAGE_EXTS.has(ext);
      })
      .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true, sensitivity: 'base' }));

    if (imageEntries.length === 0) {
      await editMessage(chatId, statusMessageId, "❌ No images found in the zip file");
      return;
    }

    console.log(`[Chat ${chatId}] Found ${imageEntries.length} images in zip.`);
    await editMessage(
      chatId,
      statusMessageId,
      `✅ Found ${imageEntries.length} images in zip. Starting upload...\n📤 Progress: 0/${imageEntries.length}`
    );

    // Create gallery if name provided
    let galleryId: string | null = null;

    if (galleryName) {
      try {
        const sanitizedName = galleryName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        await editMessage(chatId, statusMessageId, `🖼 Creating gallery: ${sanitizedName}...`);
        galleryId = await createGalleryWithName(sanitizedName);
      } catch (err: any) {
        await editMessage(chatId, statusMessageId, `⚠️ Failed to pre-create gallery: ${err.message}. Uploading without name.`);
      }
    }

    results = [];

    // Upload first image to create/join gallery
    try {
      const firstEntry = imageEntries[0];
      const imageBuffer = firstEntry.getData();
      const filename = `image_1${path.extname(firstEntry.entryName).toLowerCase() || '.jpg'}`;

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

      let progressText = `✅ Found ${imageEntries.length} images\n\n`;
      progressText += `📤 Uploading to IMX...\n`;
      progressText += `Progress: 1/${imageEntries.length}\n`;
      progressText += `✓ Success: 1\n`;
      if (galleryId) progressText += `🖼 Gallery: ${galleryId}`;
      await editMessage(chatId, statusMessageId, progressText);
    } catch (error: any) {
      results.push({ index: 0, error: error.message });
    }

    // Upload remaining images in batches
    const BATCH_SIZE = 15;
    const remainingEntries = imageEntries.slice(1).map((entry, index) => ({
      entry,
      index: index + 1,
    }));

    for (let i = 0; i < remainingEntries.length; i += BATCH_SIZE) {
      if (cancelRequests.has(chatId)) {
        cancelRequests.delete(chatId);
        throw new Error("Operation cancelled by user.");
      }

      const batch = remainingEntries.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async ({ entry, index }) => {
          try {
            const imageBuffer = entry.getData();
            const filename = `image_${index + 1}${path.extname(entry.entryName).toLowerCase() || '.jpg'}`;
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
      console.log(`[Chat ${chatId}] IMX Upload Progress: ${Math.min(i + BATCH_SIZE + 1, imageEntries.length)}/${imageEntries.length} (Success: ${successCount}, Failed: ${failCount})`);
      let progressText = `✅ Found ${imageEntries.length} images\n\n`;
      progressText += `📤 Uploading to IMX...\n`;
      progressText += `Progress: ${Math.min(i + BATCH_SIZE + 1, imageEntries.length)}/${imageEntries.length}\n`;
      progressText += `✓ Success: ${successCount}\n`;
      if (failCount > 0) progressText += `✗ Failed: ${failCount}\n`;
      if (galleryId) progressText += `🖼 Gallery: ${galleryId}`;

      await editMessage(chatId, statusMessageId, progressText);
    }

    results.sort((a, b) => a.index - b.index);
    const successResults = results.filter((r) => r.imx_url);

    // Extract direct URLs
    await editMessage(
      chatId,
      statusMessageId,
      `✅ Upload complete!\n\n🔍 Extracting direct URLs from ${successResults.length} imx.to links...`
    );

    directUrls = [];
    const EXTRACT_BATCH_SIZE = 15;

    for (let i = 0; i < successResults.length; i += EXTRACT_BATCH_SIZE) {
      if (cancelRequests.has(chatId)) {
        cancelRequests.delete(chatId);
        throw new Error("Operation cancelled by user.");
      }

      const batch = successResults.slice(i, i + EXTRACT_BATCH_SIZE);

      const batchUrls = await Promise.all(
        batch.map(async (result) => {
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

    // Upload to pb
    await editMessage(chatId, statusMessageId, "📤 Uploading results to pb...");

    const galleryUrl = galleryId ? `https://imx.to/g/${galleryId}` : null;

    let pbContent = "";
    directUrls.forEach((url) => (pbContent += `${url}\n`));

    const pbResult = await uploadToPb(pbContent);

    // Download, zip with ordered names, upload to catbox (only if requested)
    let catboxUrl: string | null = null;
    if (enableCatbox && directUrls.length > 0) {
      try {
        await editMessage(chatId, statusMessageId, `📦 Creating zip... Downloading ${directUrls.length} images...`);

        const zipName = galleryName
          ? galleryName.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').toLowerCase()
          : 'images';

        const zipBuf = await downloadAndZipImages(
          directUrls,
          zipName,
          async (done, total) => {
            if (done % 10 === 0 || done === total) {
              await editMessage(
                chatId,
                statusMessageId,
                `📦 Creating zip... Downloading ${done}/${total} images...`
              );
            }
          }
        );

        await editMessage(chatId, statusMessageId, `📤 Uploading zip to catbox.moe (${(zipBuf.length / 1024 / 1024).toFixed(1)} MB)...`);
        catboxUrl = await uploadToCatbox(zipBuf, `${zipName}.zip`);
        console.log(`[Chat ${chatId}] Catbox upload complete: ${catboxUrl}`);
      } catch (err: any) {
        console.error(`[Chat ${chatId}] Catbox zip/upload failed:`, err.message);
        await editMessage(chatId, statusMessageId, `⚠️ Zip upload to catbox failed: ${err.message}\nContinuing...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    let finalMessage = `✅ <b>Upload Complete!</b>\n\n`;
    finalMessage += `📊 Success: ${successResults.length}/${imageEntries.length}\n`;
    finalMessage += `🔗 Direct URLs extracted: ${directUrls.length}\n`;
    if (galleryUrl) finalMessage += `🖼 Gallery: ${galleryUrl}\n`;
    finalMessage += `🔗 Direct URLs: ${pbResult.url}\n`;
    if (catboxUrl) finalMessage += `📦 Zip Download: ${catboxUrl}\n`;
    finalMessage += `⏰ Expires in 7 days`;

    await editMessage(chatId, statusMessageId, finalMessage);

    await sendUploadSummaryToChannel({
      galleryName: galleryName || null,
      total: imageEntries.length,
      uploaded: successResults.length,
      failed: imageEntries.length - successResults.length,
      extracted: directUrls.length,
      galleryUrl: galleryUrl,
      pasteUrl: pbResult.url,
      catboxUrl: catboxUrl,
    });
  } catch (error: any) {
    if (statusMessageId !== 0) {
      await editMessage(chatId, statusMessageId, `❌ Error: ${error.message}`);
    } else {
      await sendMessage(chatId, `❌ Error: ${error.message}`, messageId);
    }
  } finally {
    results.length = 0;
    directUrls.length = 0;
    imageEntries.length = 0;
    zipBuffer = null;
    zip = null;
    console.log(`[Chat ${chatId}] Cleanup complete.`);
  }
}

export async function handleUpdate(update: any) {
  if (!update.message) return;

  const chatId = update.message.chat.id;
  const messageId = update.message.message_id;
  const text = update.message.text || "";

  if (text) {
    console.log(`[Chat ${chatId}] Received message: ${text.substring(0, 100).replace(/\n/g, ' ')}`);
  }

  if (text === "/start") {
    const welcome =
      `👋 <b>Welcome to IMX Uploader Bot!</b>\n\n` +
      `📸 Send me:\n` +
      `• A photo to upload to IMX\n` +
      `• A pb.dotrhelvetican.workers.dev URL with image links [Optional Gallery Name]\n` +
      `• A .zip file with images (caption = gallery name)\n` +
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
      `3️⃣ Send a .zip file with images (add caption for gallery name)\n` +
      `4️⃣ Send imx.to links to get direct URLs\n\n` +
      `<b>Example pb URL:</b>\n` +
      `https://pb.dotrhelvetican.workers.dev/yG2A My Cool Gallery\n\n` +
      `<b>Commands:</b>\n` +
      `/cancel - Cancel the current running operation\n\n` +
      `All results are saved to pb with 7d expiry.`;
    await sendMessage(chatId, help, messageId);
    return;
  }

  if (text === "/cancel") {
    cancelRequests.add(chatId);
    await sendMessage(chatId, "🛑 Cancelling operation... Please wait.", messageId);
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
      const remaining = parts.filter((p: string) => p !== pbUrl);
      const enableCatbox = remaining.length > 0 && remaining[remaining.length - 1].toLowerCase() === 'catbox';
      const galleryName = enableCatbox ? remaining.slice(0, -1).join(" ") : remaining.join(" ");
      await processPbUrl(chatId, pbUrl, galleryName, messageId, enableCatbox);
    }
    return;
  }

  if (update.message.photo) {
    const photo = update.message.photo[update.message.photo.length - 1];
    await processPhoto(chatId, photo.file_id, messageId);
    return;
  }

  // Handle zip file uploads
  if (update.message.document && (
    update.message.document.mime_type === 'application/zip' ||
    update.message.document.mime_type === 'application/x-zip-compressed' ||
    update.message.document.file_name?.toLowerCase().endsWith('.zip')
  )) {
    const caption = (update.message.caption || '').trim();
    const captionParts = caption.split(/\s+/).filter(Boolean);
    const enableCatbox = captionParts.length > 0 && captionParts[captionParts.length - 1].toLowerCase() === 'catbox';
    const galleryName = enableCatbox ? captionParts.slice(0, -1).join(' ') : caption;
    await processZipFile(chatId, update.message.document.file_id, galleryName, messageId, enableCatbox);
    return;
  }

  if (update.message.document && update.message.document.mime_type?.startsWith("image/")) {
    await processPhoto(chatId, update.message.document.file_id, messageId);
    return;
  }

  await sendMessage(
    chatId,
    "❓ Send me:\n• A photo\n• A pb URL with image links\n• A .zip file with images\n• imx.to links to extract direct URLs\n\nUse /help for more info.",
    messageId
  );
}
