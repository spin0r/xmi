import express from 'express';
import cors from 'cors';
import multer from 'multer';
import axios from 'axios';
import path from 'path';
import { getImxDirectUrl, uploadToImx, createGalleryWithName } from './core/imx';
import { uploadToPb } from './core/pb';
import { sendUploadSummaryToChannel } from './core/telegram';

export const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/docs', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'docs/index.html'));
});

async function downloadFile(url: string): Promise<Buffer> {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

const MAX_IMAGES = 50;
const BATCH_SIZE = 3;

// 1. Endpoint to process PB URLs
app.post('/api/upload-pb', async (req, res) => {
  const { pbUrl, galleryName } = req.body;
  if (!pbUrl) return res.status(400).json({ error: 'pbUrl is required' });

  try {
    const { data } = await axios.get(pbUrl);
    let imageUrls = typeof data === 'string'
      ? data.split("\n").filter((line: string) => {
          const trimmed = line.trim();
          return trimmed && trimmed.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i);
        })
      : [];

    if (imageUrls.length === 0) return res.status(400).json({ error: 'No valid image URLs found in paste' });
    if (imageUrls.length > MAX_IMAGES) imageUrls = imageUrls.slice(0, MAX_IMAGES);

    let galleryId: string | null = null;
    if (galleryName) {
      try { galleryId = await createGalleryWithName(galleryName); } catch (e: any) {
        console.warn(`Failed to create gallery:`, e.message);
      }
    }

    // Upload sequentially in small batches to avoid memory spike
    const uploadedUrls: Array<{ index: number; imx_url: string }> = [];

    for (let i = 0; i < imageUrls.length; i += BATCH_SIZE) {
      const batch = imageUrls.slice(i, i + BATCH_SIZE);
      for (let j = 0; j < batch.length; j++) {
        const index = i + j;
        try {
          let buf: Buffer | null = await downloadFile(batch[j].trim());
          const imxResult = await uploadToImx(buf, `image_${index + 1}.jpg`, galleryId);
          buf = null; // free immediately
          if (!galleryId && imxResult.gallery_id) galleryId = imxResult.gallery_id;
          uploadedUrls.push({ index, imx_url: imxResult.image_url });
        } catch (err: any) {
          console.error(`Upload failed for index ${index}:`, err.message);
        }
      }
    }

    // Extract direct URLs sequentially
    const directUrls: string[] = new Array(uploadedUrls.length).fill(null);
    for (let i = 0; i < uploadedUrls.length; i += BATCH_SIZE) {
      const batch = uploadedUrls.slice(i, i + BATCH_SIZE);
      for (const { index, imx_url } of batch) {
        try {
          const url = await getImxDirectUrl(imx_url);
          directUrls[index] = url || '';
        } catch (e) {}
      }
    }

    const validUrls = directUrls.filter(Boolean);
    let finalPbUrl = null;
    if (validUrls.length > 0) {
      try {
        const pbResult = await uploadToPb(validUrls.join('\n') + '\n');
        finalPbUrl = pbResult.url;
      } catch (e: any) { console.error('PB upload failed:', e.message); }
    }

    sendUploadSummaryToChannel({
      galleryName: galleryName || null,
      total: imageUrls.length,
      uploaded: uploadedUrls.length,
      failed: imageUrls.length - uploadedUrls.length,
      extracted: validUrls.length,
      galleryUrl: galleryId ? `https://imx.to/g/${galleryId}` : null,
      pasteUrl: finalPbUrl,
    }).catch(console.error);

    res.json({
      success: true,
      total_found: imageUrls.length,
      successful_uploads: uploadedUrls.length,
      direct_urls_extracted: validUrls.length,
      gallery_url: galleryId ? `https://imx.to/g/${galleryId}` : null,
      pb_url: finalPbUrl,
      direct_urls: validUrls,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Endpoint to process imx.to links
app.post('/api/extract-imx', async (req, res) => {
  const { links } = req.body;
  if (!Array.isArray(links)) return res.status(400).json({ error: 'links must be an array of strings' });

  try {
    const directUrls: string[] = [];
    for (const link of links) {
      try {
        const url = await getImxDirectUrl(link);
        if (url) directUrls.push(url);
      } catch (e) {}
    }
    res.json({ success: true, total: links.length, extracted: directUrls.length, direct_urls: directUrls });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Endpoint to upload single file
app.post('/api/upload-file', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'image file is required' });

  try {
    const imxResult = await uploadToImx(req.file.buffer, req.file.originalname);
    res.json({
      success: true,
      image_url: imxResult.image_url,
      thumbnail_url: imxResult.thumbnail_url,
      gallery_id: imxResult.gallery_id,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export function startServer(port: number = 3000) {
  app.listen(port, () => {
    console.log(`🚀 API Server running on http://localhost:${port}`);
  });
}
