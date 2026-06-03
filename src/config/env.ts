import dotenv from 'dotenv';
dotenv.config();

const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN',
  'IMX_API_KEY',
  'IMX_USERNAME',
  'IMX_PASSWORD',
  'TELEGRAM_CHAT_ID'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

export const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN as string,
  IMX_API_KEY: process.env.IMX_API_KEY as string,
  IMX_USERNAME: process.env.IMX_USERNAME as string,
  IMX_PASSWORD: process.env.IMX_PASSWORD as string,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID as string,
  IMX_UPLOAD_URL: 'https://api.imx.to/v1/upload.php',
  PB_API_BASE: 'https://pb.dotrhelvetican.workers.dev'
};
