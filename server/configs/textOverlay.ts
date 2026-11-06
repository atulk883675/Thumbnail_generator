// Finishes a generated image: crops it to the exact aspect ratio, then draws the
// video title with a real font, so the spelling is always exactly what the user
// typed (image models misspell text). Cropping first means the title can never be cut off.
//
// Font: Anton, SIL Open Font License (assets/fonts/Anton-OFL.txt).
import { createCanvas, GlobalFonts, loadImage, SKRSContext2D } from '@napi-rs/canvas';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FONT_FAMILY = 'Anton';
GlobalFonts.registerFromPath(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts', 'Anton-Regular.ttf'), FONT_FAMILY);

const MAX_LINES = 4;

function wrap(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(test).width > maxWidth) {
            lines.push(line);
            line = word;
        } else {
            line = test;
        }
    }
    if (line) lines.push(line);
    return lines;
}

/** Largest font size at which the text fits in `maxLines` lines, or 0 if it never does. */
function fitSize(ctx: SKRSContext2D, text: string, maxLines: number, maxWidth: number, maxBlockHeight: number, startSize: number, minSize: number): number {
    for (let size = startSize; size >= minSize; size -= 2) {
        ctx.font = `${size}px ${FONT_FAMILY}`;
        const lines = wrap(ctx, text, maxWidth);
        const fits = lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxWidth) && lines.length * size * 1.05 <= maxBlockHeight;
        if (fits) return size;
    }
    return 0;
}

/** Title in the lower part of the image: white, black outline, on a soft dark gradient. */
function drawTitle(ctx: SKRSContext2D, title: string, W: number, H: number) {
    // Darken the bottom so white text reads on bright images
    const gradient = ctx.createLinearGradient(0, H * 0.45, 0, H);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.75)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, H * 0.45, W, H * 0.55);

    const text = title.trim().toUpperCase();
    const maxWidth = W * 0.9;
    const maxBlockHeight = H * 0.36;
    const startSize = Math.round(Math.min(W, H) * 0.24);
    const minSize = Math.max(16, Math.round(H * 0.025));

    // Prefer fewer lines: an extra line must allow a clearly bigger font (25%) to win
    let best = { lines: 1, size: fitSize(ctx, text, 1, maxWidth, maxBlockHeight, startSize, minSize) };
    for (let n = 2; n <= MAX_LINES; n++) {
        const size = fitSize(ctx, text, n, maxWidth, maxBlockHeight, startSize, minSize);
        if (size && (best.size === 0 || size >= best.size * 1.25)) best = { lines: n, size };
    }
    const size = best.size || minSize; // a 100-char title still renders, just smaller
    ctx.font = `${size}px ${FONT_FAMILY}`;
    const lines = wrap(ctx, text, maxWidth); // never drops words

    const lineHeight = size * 1.05;
    let y = H - H * 0.06 - (lines.length - 1) * lineHeight;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    for (const line of lines) {
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = size * 0.18;
        ctx.shadowOffsetY = size * 0.04;
        ctx.lineWidth = size * 0.14;
        ctx.strokeStyle = '#000';
        ctx.strokeText(line, W / 2, y);

        ctx.shadowColor = 'transparent';
        ctx.fillStyle = '#fff';
        ctx.fillText(line, W / 2, y);
        y += lineHeight;
    }
}

export type AspectRatio = '16:9' | '1:1' | '9:16';
const RATIOS: Record<AspectRatio, number> = { '16:9': 16 / 9, '1:1': 1, '9:16': 9 / 16 };

/**
 * Centre-crops the image to the exact aspect ratio and, if a title is given,
 * draws it on. Returns a JPEG.
 */
export async function finishImage(base64: string, opts: { aspectRatio: AspectRatio; title?: string }): Promise<{ base64: string; mime: string; width: number; height: number }> {
    const image = await loadImage(Buffer.from(base64, 'base64'));
    const target = RATIOS[opts.aspectRatio] ?? RATIOS['16:9'];

    let width = image.width;
    let height = image.height;
    if (width / height > target) width = Math.round(height * target);
    else height = Math.round(width / target);
    const sx = Math.round((image.width - width) / 2);
    const sy = Math.round((image.height - height) / 2);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, sx, sy, width, height, 0, 0, width, height);
    if (opts.title?.trim()) drawTitle(ctx, opts.title, width, height);

    const jpeg = await canvas.encode('jpeg', 92);
    return { base64: jpeg.toString('base64'), mime: 'image/jpeg', width, height };
}
