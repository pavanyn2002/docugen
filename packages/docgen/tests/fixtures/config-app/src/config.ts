export const port = process.env.PORT ?? 3000;
export const dbUrl = process.env['DATABASE_URL'];
export const apiKey = process.env.STRIPE_SECRET_KEY;
export const region = process.env.AWS_REGION || 'ap-south-1';
const notEnv = process.env.lowercase_ignored;
