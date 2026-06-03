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

const upload = multer({ storage: multer.memoryStorage() });

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.use('/docs', express.static(path.join(process.cwd(), 'docs/out')));

// Handle trailing slash redirects for Next.js static export
app.get('/docs', (req, res) => {
  if (!req.originalUrl.endsWith('/')) {
    return res.redirect(301, '/docs/');
  }
  res.sendFile(path.join(process.cwd(), 'docs/out/index.html'));
});

async function downloadFile(url: string): Promise<Buffer> {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

// 1. Endpoint to process PB URLs
app.post('/api/upload-pb', async (req, res) => {
  const { pbUrl, galleryName } = req.body;
  if (!pbUrl) return res.status(400).json({ error: 'pbUrl is required' });

  try {
    const { data } = await axios.get(pbUrl);
    const imageUrls = typeof data === 'string'
      ? data.split("\n").filter((line: string) => {
          const trimmed = line.trim();
          return trimmed && trimmed.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i);
        })
      : [];

    if (imageUrls.length === 0) {
      return res.status(400).json({ error: 'No valid image URLs found in paste' });
    }

    let galleryId: string | null = null;
    if (galleryName) {
      try {
        galleryId = await createGalleryWithName(galleryName);
      } catch (e: any) {
        console.warn(`Failed to create gallery ${galleryName}:`, e.message);
      }
    }

    const results: any[] = [];
    if (imageUrls.length > 0) {
      try {
        const firstUrl = imageUrls[0].trim();
        const imageBuffer = await downloadFile(firstUrl);
        const imxResult = await uploadToImx(imageBuffer, 'image_1.jpg', galleryId);
        
        if (!galleryId && imxResult.gallery_id) {
          galleryId = imxResult.gallery_id;
        }

        results.push({
          index: 0,
          imx_url: imxResult.image_url,
          thumbnail: imxResult.thumbnail_url,
          gallery_id: imxResult.gallery_id,
        });
      } catch (err: any) {
        results.push({ index: 0, error: err.message });
      }
    }

    const BATCH_SIZE = 15;
    const remainingUrls = imageUrls.slice(1).map((url: string, index: number) => ({
      url: url.trim(),
      index: index + 1,
    }));

    for (let i = 0; i < remainingUrls.length; i += BATCH_SIZE) {
      const batch = remainingUrls.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async ({ url, index }: any) => {
          try {
            const imageBuffer = await downloadFile(url);
            const imxResult = await uploadToImx(imageBuffer, `image_${index + 1}.jpg`, galleryId);
            return {
              index,
              imx_url: imxResult.image_url,
              thumbnail: imxResult.thumbnail_url,
              gallery_id: imxResult.gallery_id,
            };
          } catch (err: any) {
            return { index, error: err.message };
          }
        })
      );
      results.push(...batchResults);
    }

    results.sort((a, b) => a.index - b.index);
    const successResults = results.filter(r => r.imx_url);

    const directUrls: string[] = [];
    const EXTRACT_BATCH_SIZE = 15;
    
    for (let i = 0; i < successResults.length; i += EXTRACT_BATCH_SIZE) {
      const batch = successResults.slice(i, i + EXTRACT_BATCH_SIZE);
      const batchUrls = await Promise.all(
        batch.map(async (r: any) => {
          try {
            const url = await getImxDirectUrl(r.imx_url);
            return { index: r.index, url };
          } catch (e) {
            return { index: r.index, url: null };
          }
        })
      );
      batchUrls.sort((a, b) => a.index - b.index);
      batchUrls.forEach(r => {
        if (r.url) directUrls.push(r.url);
      });
    }

    let pbContent = "";
    directUrls.forEach(url => (pbContent += `${url}\n`));
    let finalPbUrl = null;
    
    if (pbContent) {
      const pbResult = await uploadToPb(pbContent);
      finalPbUrl = pbResult.url;
    }

    sendUploadSummaryToChannel({
      galleryName: galleryName || null,
      total: imageUrls.length,
      uploaded: successResults.length,
      failed: imageUrls.length - successResults.length,
      extracted: directUrls.length,
      galleryUrl: galleryId ? `https://imx.to/g/${galleryId}` : null,
      pasteUrl: finalPbUrl,
    }).catch(console.error);

    res.json({
      success: true,
      total_found: imageUrls.length,
      successful_uploads: successResults.length,
      direct_urls_extracted: directUrls.length,
      gallery_url: galleryId ? `https://imx.to/g/${galleryId}` : null,
      pb_url: finalPbUrl,
      direct_urls: directUrls,
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
