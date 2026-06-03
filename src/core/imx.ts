import axios from 'axios';
import FormData from 'form-data';
import { config } from '../config/env';

let cachedCookies: string | null = null;

export async function loginToImx(): Promise<void> {
  if (!config.IMX_USERNAME || !config.IMX_PASSWORD) {
    throw new Error('IMX_USERNAME and IMX_PASSWORD must be set in .env');
  }

  // 1. Get initial PHPSESSID
  const initialRes = await axios.get('https://imx.to/login.php');
  const initialCookies = initialRes.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ');

  // 2. Perform Login
  const formData = new URLSearchParams();
  formData.append('usr_email', config.IMX_USERNAME);
  formData.append('pwd', config.IMX_PASSWORD);
  formData.append('remember', '1');
  formData.append('doLogin', 'Login');

  const response = await axios.post('https://imx.to/login.php', formData, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': initialCookies || '',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    maxRedirects: 0,
    validateStatus: (status) => status === 302 || status === 200,
  });

  if (response.status === 302 && response.headers['set-cookie']) {
    const cookieMap = new Map<string, string>();
    
    // Combine initial cookies with login cookies
    [...(initialRes.headers['set-cookie'] || []), ...(response.headers['set-cookie'] || [])].forEach(cookieStr => {
      const parts = cookieStr.split(';');
      const [keyVal] = parts;
      if (keyVal) {
        const [key, val] = keyVal.split('=');
        if (val && val !== 'deleted') {
            cookieMap.set(key, val);
        }
      }
    });
    
    cachedCookies = Array.from(cookieMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  } else {
    throw new Error('Failed to login to imx.to (did not receive 302 redirect with cookies).');
  }
}

export async function getImxCookies(): Promise<string> {
  if (!cachedCookies) {
    await loginToImx();
  }
  return cachedCookies as string;
}

export async function createGalleryWithName(galleryName: string): Promise<string> {
  if (!cachedCookies) {
    await loginToImx();
  }

  // imx.to rejects special characters like ! / -, so we strip everything except alphanumeric and spaces
  const sanitizedName = galleryName.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

  const formData = new URLSearchParams();
  formData.append('gallery_name', sanitizedName);
  formData.append('submit_new_gallery', 'Add');

  const response = await axios.post('https://imx.to/user/gallery/add', formData, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cachedCookies,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    maxRedirects: 0,
    validateStatus: (status) => status === 302 || status === 200,
  });

  const location = response.headers['location'];
  if (location && location.includes('login')) {
    cachedCookies = null; // Invalidate cache
    throw new Error('Session expired, redirected to login');
  }

  if (location) {
    const match = location.match(/id=([^&]+)/);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  throw new Error('Failed to create gallery or extract gallery ID from response');
}

export async function uploadToImx(imageBuffer: Buffer, filename: string, galleryId: string | null = null): Promise<any> {
  const form = new FormData();
  form.append('image', imageBuffer, { filename });
  
  if (galleryId) {
    form.append('gallery_id', galleryId);
  } else {
    form.append('create_gallery', 'true');
  }

  const response = await axios.post(config.IMX_UPLOAD_URL, form, {
    headers: {
      'X-API-Key': config.IMX_API_KEY,
      ...form.getHeaders(),
    },
  });

  if (response.data.status === 'success') {
    return response.data.data;
  } else {
    throw new Error(response.data.message || JSON.stringify(response.data));
  }
}

export async function getImxDirectUrl(imxUrl: string): Promise<string | null> {
  try {
    const { data } = await axios.get(imxUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    // Method 1: Look for img#iimg (main image)
    let match = data.match(/<img[^>]+id=["']iimg["'][^>]+src=["']([^"']+)["']/i);
    if (match) return match[1];

    // Method 2: Look for img.centred (alternative)
    match = data.match(/<img[^>]+class=["'][^"']*centred[^"']*["'][^>]+src=["']([^"']+)["']/i);
    if (match) return match[1];

    // Step 3: Handle age gate form (if present)
    const continueMatch = data.match(/<input[^>]+name=["']imgContinue["'][^>]*>/i);
    if (continueMatch) {
      const formMatch = data.match(/<form[^>]+action=["']([^"']+)["'][^>]*>[\s\S]*?imgContinue[\s\S]*?<\/form>/i);
      let formUrl = imxUrl;
      if (formMatch && formMatch[1]) {
        formUrl = formMatch[1].startsWith('http') ? formMatch[1] : `https://imx.to${formMatch[1]}`;
      }

      const formData = new URLSearchParams();
      const inputRegex = /<input[^>]+name=["']([^"']+)["'][^>]*(?:value=["']([^"']*)["'])?[^>]*>/gi;
      let inputMatch;
      while ((inputMatch = inputRegex.exec(data)) !== null) {
        const name = inputMatch[1];
        const value = inputMatch[2] || '';
        formData.append(name, value);
      }

      const formResponse = await axios.post(formUrl, formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': imxUrl,
        },
      });

      const responseData = formResponse.data;
      match = responseData.match(/<img[^>]+id=["']iimg["'][^>]+src=["']([^"']+)["']/i);
      if (match) return match[1];

      match = responseData.match(/<img[^>]+class=["'][^"']*centred[^"']*["'][^>]+src=["']([^"']+)["']/i);
      if (match) return match[1];
    }

    // Step 4: Fallback methods
    match = data.match(/<img[^>]+id=["']image["'][^>]+src=["']([^"']+)["']/i);
    if (match) return match[1];

    match = data.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (match) return match[1];

    return null;
  } catch (error: any) {
    console.error(`Failed to extract direct URL from ${imxUrl}:`, error.message);
    return null;
  }
}
