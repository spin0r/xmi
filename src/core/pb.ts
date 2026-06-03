import axios from 'axios';
import FormData from 'form-data';
import { config } from '../config/env';

export async function uploadToPb(content: string): Promise<any> {
  const form = new FormData();
  form.append('c', content);
  form.append('e', '24h');

  const response = await axios.post(config.PB_API_BASE, form, {
    headers: {
      ...form.getHeaders(),
    },
  });

  return response.data;
}
