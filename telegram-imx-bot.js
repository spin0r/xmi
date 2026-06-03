const https = require("https");
const http = require("http");
const { URL } = require("url");

// Configuration
const TELEGRAM_BOT_TOKEN = "8727605066:AAGKAohLywrLYALNj9QxnHZ-zZmK59Sw49I"; // Get from @BotFather
const IMX_API_KEY =
  "5d4e0cea681e63c7b46c4d09dfcdbea1eaf4342daa151d7a2605a1826005dfce";
const IMX_UPLOAD_URL = "https://api.imx.to/v1/upload.php";
const PB_API_BASE = "https://pb.dotrhelvetican.workers.dev";

let offset = 0;

// Helper: Make HTTPS request
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === "https:" ? https : http;

    const req = protocol.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () =>
        resolve({ data, statusCode: res.statusCode, headers: res.headers }),
      );
    });

    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Helper: Extract direct URL from imx.to
async function getImxDirectUrl(imxUrl) {
  try {
    // Step 1: Fetch the page
    const { data } = await httpsRequest(imxUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    // Step 2: Try to find direct image
    // Method 1: Look for img#iimg (main image)
    let match = data.match(
      /<img[^>]+id=["']iimg["'][^>]+src=["']([^"']+)["']/i,
    );
    if (match) return match[1];

    // Method 2: Look for img.centred (alternative)
    match = data.match(
      /<img[^>]+class=["'][^"']*centred[^"']*["'][^>]+src=["']([^"']+)["']/i,
    );
    if (match) return match[1];

    // Step 3: Handle age gate form (if present)
    const continueMatch = data.match(
      /<input[^>]+name=["']imgContinue["'][^>]*>/i,
    );
    if (continueMatch) {
      // Find form action
      const formMatch = data.match(
        /<form[^>]+action=["']([^"']+)["'][^>]*>[\s\S]*?imgContinue[\s\S]*?<\/form>/i,
      );
      let formUrl = imxUrl;
      if (formMatch && formMatch[1]) {
        formUrl = formMatch[1].startsWith("http")
          ? formMatch[1]
          : `https://imx.to${formMatch[1]}`;
      }

      // Collect all form inputs
      const formData = [];
      const inputRegex =
        /<input[^>]+name=["']([^"']+)["'][^>]*(?:value=["']([^"']*)["'])?[^>]*>/gi;
      let inputMatch;
      while ((inputMatch = inputRegex.exec(data)) !== null) {
        const name = inputMatch[1];
        const value = inputMatch[2] || "";
        formData.push(
          `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
        );
      }

      // Submit the form
      const formBody = formData.join("&");
      const urlObj = new URL(formUrl);

      const formResponse = await new Promise((resolve, reject) => {
        const options = {
          method: "POST",
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(formBody),
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Referer: imxUrl,
          },
        };

        const req = https.request(options, (res) => {
          let responseData = "";
          res.on("data", (chunk) => (responseData += chunk));
          res.on("end", () => resolve(responseData));
        });

        req.on("error", reject);
        req.write(formBody);
        req.end();
      });

      // Parse the response after form submission
      match = formResponse.match(
        /<img[^>]+id=["']iimg["'][^>]+src=["']([^"']+)["']/i,
      );
      if (match) return match[1];

      match = formResponse.match(
        /<img[^>]+class=["'][^"']*centred[^"']*["'][^>]+src=["']([^"']+)["']/i,
      );
      if (match) return match[1];
    }

    // Step 4: Fallback methods
    // Try img#image
    match = data.match(/<img[^>]+id=["']image["'][^>]+src=["']([^"']+)["']/i);
    if (match) return match[1];

    // Try og:image meta tag
    match = data.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    );
    if (match) return match[1];

    return null;
  } catch (error) {
    console.error(
      `Failed to extract direct URL from ${imxUrl}:`,
      error.message,
    );
    return null;
  }
}

// Helper: Download file
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === "https:" ? https : http;

    protocol
      .get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          return downloadFile(res.headers.location).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

// Helper: Upload to imx.to
async function uploadToImx(imageBuffer, filename, galleryId = null) {
  return new Promise((resolve, reject) => {
    const boundary =
      "----WebKitFormBoundary" + Math.random().toString(36).substring(2);

    let formData = [];

    // Image field
    formData.push(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    );

    const header = Buffer.from(formData.join(""));

    // Add gallery_id or create_gallery
    let footer = "\r\n";
    if (galleryId) {
      footer += `--${boundary}\r\n`;
      footer += `Content-Disposition: form-data; name="gallery_id"\r\n\r\n`;
      footer += `${galleryId}\r\n`;
    } else {
      footer += `--${boundary}\r\n`;
      footer += `Content-Disposition: form-data; name="create_gallery"\r\n\r\n`;
      footer += `true\r\n`;
    }
    footer += `--${boundary}--\r\n`;

    const footerBuffer = Buffer.from(footer);
    const body = Buffer.concat([header, imageBuffer, footerBuffer]);

    const urlObj = new URL(IMX_UPLOAD_URL);
    const options = {
      method: "POST",
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      headers: {
        "X-API-Key": IMX_API_KEY,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (result.status === "success") resolve(result.data);
          else reject(new Error(result.message || data));
        } catch (e) {
          reject(new Error(`Parse error: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Helper: Upload to pb
async function uploadToPb(content) {
  return new Promise((resolve, reject) => {
    const boundary =
      "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="c"\r\n\r\n${content}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="e"\r\n\r\n24h\r\n` +
      `--${boundary}--\r\n`;

    const urlObj = new URL(PB_API_BASE);
    const options = {
      method: "POST",
      hostname: urlObj.hostname,
      path: "/",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Parse error: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Telegram API: Send message
async function sendMessage(chatId, text, replyToMessageId = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
    reply_to_message_id: replyToMessageId,
  });

  const { data } = await httpsRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body: body,
  });

  return JSON.parse(data).result;
}

// Telegram API: Edit message
async function editMessage(chatId, messageId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body = JSON.stringify({
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: "HTML",
  });

  try {
    await httpsRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      body: body,
    });
  } catch (error) {
    // Ignore errors if message is the same
  }
}

// Telegram API: Get file URL
async function getFileUrl(fileId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
  const { data } = await httpsRequest(url);
  const result = JSON.parse(data);
  if (result.ok) {
    return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${result.result.file_path}`;
  }
  throw new Error("Failed to get file URL");
}

// Process imx.to links to extract direct URLs
async function processImxLinks(chatId, text, messageId) {
  let statusMessageId = null;

  try {
    // Extract all imx.to links
    const imxLinks = text.match(/https?:\/\/imx\.to\/i\/[a-zA-Z0-9]+/g);
    if (!imxLinks || imxLinks.length === 0) {
      await sendMessage(chatId, "❌ No valid imx.to links found", messageId);
      return;
    }

    const statusMsg = await sendMessage(
      chatId,
      `🔄 Extracting direct URLs from ${imxLinks.length} imx.to links...`,
      messageId,
    );
    statusMessageId = statusMsg.message_id;

    const directUrls = [];

    for (let i = 0; i < imxLinks.length; i++) {
      const imxUrl = imxLinks[i];

      try {
        const directUrl = await getImxDirectUrl(imxUrl);
        if (directUrl) {
          directUrls.push(directUrl);
        }

        // Update progress
        let progressText = `🔍 Extracting direct URLs...\n\n`;
        progressText += `Progress: ${i + 1}/${imxLinks.length}\n`;
        progressText += `✓ Found: ${directUrls.length}`;

        await editMessage(chatId, statusMessageId, progressText);

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (error) {
        console.error(`Failed to process ${imxUrl}:`, error.message);
      }
    }

    if (directUrls.length === 0) {
      await editMessage(
        chatId,
        statusMessageId,
        "❌ Could not extract any direct URLs",
      );
      return;
    }

    // Upload to pb
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
  } catch (error) {
    if (statusMessageId) {
      await editMessage(chatId, statusMessageId, `❌ Error: ${error.message}`);
    } else {
      await sendMessage(chatId, `❌ Error: ${error.message}`, messageId);
    }
  }
}

// Process pb URL
async function processPbUrl(chatId, pbUrl, messageId) {
  let statusMessageId = null;

  try {
    const statusMsg = await sendMessage(
      chatId,
      "🔄 Fetching image URLs...",
      messageId,
    );
    statusMessageId = statusMsg.message_id;

    const { data } = await httpsRequest(pbUrl);
    const imageUrls = data.split("\n").filter((line) => {
      const trimmed = line.trim();
      return trimmed && trimmed.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i);
    });

    if (imageUrls.length === 0) {
      await editMessage(
        chatId,
        statusMessageId,
        "❌ No image URLs found in the paste",
      );
      return;
    }

    await editMessage(
      chatId,
      statusMessageId,
      `✅ Found ${imageUrls.length} images. Starting upload...\n📤 Progress: 0/${imageUrls.length}`,
    );

    const results = [];
    let galleryId = null;

    // Upload first image separately to create gallery
    if (imageUrls.length > 0) {
      try {
        const firstUrl = imageUrls[0].trim();
        const imageBuffer = await downloadFile(firstUrl);
        const filename = `image_1.jpg`;

        const imxResult = await uploadToImx(imageBuffer, filename, null);
        galleryId = imxResult.gallery_id;

        results.push({
          index: 0,
          imx_url: imxResult.image_url,
          thumbnail: imxResult.thumbnail_url,
          gallery_id: imxResult.gallery_id,
        });

        // Update progress
        let progressText = `✅ Found ${imageUrls.length} images\n\n`;
        progressText += `📤 Uploading to IMX...\n`;
        progressText += `Progress: 1/${imageUrls.length}\n`;
        progressText += `✓ Success: 1\n`;
        if (galleryId) progressText += `🖼 Gallery: ${galleryId}`;
        await editMessage(chatId, statusMessageId, progressText);
      } catch (error) {
        results.push({ index: 0, error: error.message });
      }
    }

    // Process remaining images in batches of 5 concurrently
    const BATCH_SIZE = 5;
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

            // All images join the same gallery
            const imxResult = await uploadToImx(
              imageBuffer,
              filename,
              galleryId,
            );

            return {
              index,
              imx_url: imxResult.image_url,
              thumbnail: imxResult.thumbnail_url,
              gallery_id: imxResult.gallery_id,
            };
          } catch (error) {
            return { index, error: error.message };
          }
        }),
      );

      // Add batch results in order
      results.push(...batchResults);

      // Update progress
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

    // Sort results by index to preserve order
    results.sort((a, b) => a.index - b.index);

    const successResults = results.filter((r) => r.imx_url);

    // Extract direct URLs from imx.to links
    await editMessage(
      chatId,
      statusMessageId,
      `✅ Upload complete!\n\n🔍 Extracting direct URLs from ${successResults.length} imx.to links...`,
    );

    const directUrls = [];
    const EXTRACT_BATCH_SIZE = 10;

    for (let i = 0; i < successResults.length; i += EXTRACT_BATCH_SIZE) {
      const batch = successResults.slice(i, i + EXTRACT_BATCH_SIZE);

      const batchUrls = await Promise.all(
        batch.map(async (result, batchIndex) => {
          try {
            const directUrl = await getImxDirectUrl(result.imx_url);
            return { index: i + batchIndex, url: directUrl };
          } catch (error) {
            console.error(
              `Failed to extract direct URL from ${result.imx_url}:`,
              error.message,
            );
            return { index: i + batchIndex, url: null };
          }
        }),
      );

      // Add results in order
      batchUrls.sort((a, b) => a.index - b.index);
      batchUrls.forEach((r) => {
        if (r.url) directUrls.push(r.url);
      });

      // Update extraction progress
      let progressText = `? Upload complete!\n\n`;
      progressText += `?? Extracting direct URLs...\n`;
      progressText += `Progress: ${Math.min(i + EXTRACT_BATCH_SIZE, successResults.length)}/${successResults.length}\n`;
      progressText += `? Extracted: ${directUrls.length}`;
      await editMessage(chatId, statusMessageId, progressText);
    }

    // Upload to pb
    await editMessage(chatId, statusMessageId, "?? Uploading results to pb...");

    const galleryUrl = galleryId ? `https://imx.to/g/${galleryId}` : null;

    let pbContent = "";
    directUrls.forEach((url) => (pbContent += `${url}\n`));

    const pbResult = await uploadToPb(pbContent);

    let finalMessage = `? <b>Upload Complete!</b>\n\n`;
    finalMessage += `?? Success: ${successResults.length}/${imageUrls.length}\n`;
    finalMessage += `?? Direct URLs extracted: ${directUrls.length}\n`;
    if (galleryUrl) finalMessage += `?? Gallery: ${galleryUrl}\n`;
    finalMessage += `?? Direct URLs: ${pbResult.url}\n`;
    finalMessage += `? Expires in 24 hours`;

    await editMessage(chatId, statusMessageId, finalMessage);
  } catch (error) {
    if (statusMessageId) {
      await editMessage(chatId, statusMessageId, `? Error: ${error.message}`);
    } else {
      await sendMessage(chatId, `? Error: ${error.message}`, messageId);
    }
  }
}

// Process photo upload
async function processPhoto(chatId, fileId, messageId) {
  let statusMessageId = null;

  try {
    const statusMsg = await sendMessage(
      chatId,
      "🔄 Uploading to IMX...",
      messageId,
    );
    statusMessageId = statusMsg.message_id;

    const fileUrl = await getFileUrl(fileId);
    const imageBuffer = await downloadFile(fileUrl);
    const filename = `telegram_${Date.now()}.jpg`;

    const imxResult = await uploadToImx(imageBuffer, filename);

    let finalMessage = `✅ <b>Upload Successful!</b>\n\n`;
    finalMessage += `🔗 Direct Link:\n<code>${imxResult.image_url}</code>\n\n`;
    finalMessage += `🖼 Thumbnail:\n<code>${imxResult.thumbnail_url}</code>`;

    await editMessage(chatId, statusMessageId, finalMessage);
  } catch (error) {
    if (statusMessageId) {
      await editMessage(chatId, statusMessageId, `❌ Error: ${error.message}`);
    } else {
      await sendMessage(chatId, `❌ Error: ${error.message}`, messageId);
    }
  }
}

// Handle incoming updates
async function handleUpdate(update) {
  if (!update.message) return;

  const chatId = update.message.chat.id;
  const messageId = update.message.message_id;
  const text = update.message.text || "";

  // Handle commands
  if (text === "/start") {
    const welcome =
      `👋 <b>Welcome to IMX Uploader Bot!</b>\n\n` +
      `📸 Send me:\n` +
      `• A photo to upload to IMX\n` +
      `• A pb.dotrhelvetican.workers.dev URL with image links\n` +
      `• imx.to links to extract direct URLs\n\n` +
      `🔑 API Key: Active\n` +
      `⚡️ Ready to upload!`;
    await sendMessage(chatId, welcome, messageId);
    return;
  }

  if (text === "/help") {
    const help =
      `<b>How to use:</b>\n\n` +
      `1️⃣ Send a photo directly\n` +
      `2️⃣ Send a pb URL with image links\n` +
      `3️⃣ Send imx.to links to get direct URLs\n\n` +
      `<b>Example pb URL:</b>\n` +
      `https://pb.dotrhelvetican.workers.dev/yG2A\n\n` +
      `<b>Example imx.to links:</b>\n` +
      `https://imx.to/i/6p99b5\n` +
      `https://imx.to/i/6p99b6\n\n` +
      `All results are saved to pb with 24h expiry.`;
    await sendMessage(chatId, help, messageId);
    return;
  }

  // Handle imx.to links
  if (text.includes("imx.to/i/")) {
    await processImxLinks(chatId, text, messageId);
    return;
  }

  // Handle pb URL
  if (text.includes("pb.dotrhelvetican.workers.dev")) {
    await processPbUrl(chatId, text.trim(), messageId);
    return;
  }

  // Handle photo
  if (update.message.photo) {
    const photo = update.message.photo[update.message.photo.length - 1];
    await processPhoto(chatId, photo.file_id, messageId);
    return;
  }

  // Handle document (image file)
  if (
    update.message.document &&
    update.message.document.mime_type?.startsWith("image/")
  ) {
    await processPhoto(chatId, update.message.document.file_id, messageId);
    return;
  }

  // Unknown message
  await sendMessage(
    chatId,
    "❓ Send me:\n• A photo\n• A pb URL with image links\n• imx.to links to extract direct URLs\n\nUse /help for more info.",
    messageId,
  );
}

// Poll for updates
async function pollUpdates() {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`;
    const { data } = await httpsRequest(url);
    const result = JSON.parse(data);

    if (result.ok && result.result.length > 0) {
      for (const update of result.result) {
        await handleUpdate(update);
        offset = update.update_id + 1;
      }
    }
  } catch (error) {
    console.error("Poll error:", error.message);
  }

  setTimeout(pollUpdates, 100);
}

// Start bot
console.log("🤖 Telegram IMX Uploader Bot Starting...");
console.log("📡 Polling for updates...\n");

if (TELEGRAM_BOT_TOKEN === "YOUR_TELEGRAM_BOT_TOKEN") {
  console.error("❌ Please set your TELEGRAM_BOT_TOKEN in the code");
  console.log("Get it from @BotFather on Telegram");
  process.exit(1);
}

pollUpdates();
