// One-off check of the Cloudinary credentials in .env. Delete this file when done.
// Run from the server folder:  npx tsx check-cloudinary.ts
import 'dotenv/config';
import crypto from 'node:crypto';

const raw = process.env.CLOUDINARY_URL ?? '';
const m = raw.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
if (!m) {
    console.log('CLOUDINARY_URL is missing or not in the form cloudinary://API_KEY:API_SECRET@CLOUD_NAME');
    process.exit(1);
}
const [, apiKey, apiSecret, cloudName] = m;
console.log(`cloud name : "${cloudName}"`);
console.log(`api key    : ${apiKey.slice(0, 4)}... (${apiKey.length} chars)`);
console.log(`api secret : ${apiSecret.length} chars (not shown)`);

const sign = (params: string) => crypto.createHash('sha1').update(params + apiSecret).digest('hex');

// 1. Admin API ping: checks cloud name + key + secret together
const auth = 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
let r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/ping`, { headers: { Authorization: auth } });
console.log(`\n1) ping   -> HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`);

// 2. Signed upload of a 1x1 PNG, the same kind of request the app makes
const timestamp = Math.floor(Date.now() / 1000).toString();
const form = new FormData();
form.append('file', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
form.append('api_key', apiKey);
form.append('timestamp', timestamp);
form.append('signature', sign(`timestamp=${timestamp}`));
r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: 'POST', body: form });
const text = await r.text();
console.log(`2) upload -> HTTP ${r.status}: ${text.slice(0, 400)}`);

// Clean up the test image if the upload worked
if (r.ok) {
    const { public_id } = JSON.parse(text);
    const ts = Math.floor(Date.now() / 1000).toString();
    const del = new FormData();
    del.append('public_id', public_id);
    del.append('api_key', apiKey);
    del.append('timestamp', ts);
    del.append('signature', sign(`public_id=${public_id}&timestamp=${ts}`));
    r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, { method: 'POST', body: del });
    console.log(`   (test image removed: HTTP ${r.status})`);
}
