import axios from 'axios';
import FormData from 'form-data';

const CATBOX_API_URL = 'https://catbox.moe/user/api.php';

export async function uploadToCatbox(fileBuffer: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', fileBuffer, { filename });

  const response = await axios.post(CATBOX_API_URL, form, {
    headers: {
      ...form.getHeaders(),
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  // catbox.moe returns the direct URL as plain text
  const url = typeof response.data === 'string' ? response.data.trim() : String(response.data).trim();
  
  if (!url.startsWith('https://')) {
    throw new Error(`Catbox upload failed: ${url}`);
  }

  return url;
}
