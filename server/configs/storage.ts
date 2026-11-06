// Local image storage: generated thumbnails are saved to server/uploads and
// served at /images/<file>. Used when IMAGE_STORAGE is not "cloudinary".
//
// Fine on your own machine. Not for Vercel: its filesystem is temporary,
// so saved files disappear between requests.
import express, { NextFunction, Request, Response } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
export const IMAGE_ROUTE = '/images';

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Writes the image to server/uploads and returns its file name. */
export async function saveImageLocally(id: string, base64: string, mime: string): Promise<string> {
    await fs.mkdir(IMAGE_DIR, { recursive: true });
    const file = `${id}.${EXTENSIONS[mime] ?? 'jpg'}`;
    await fs.writeFile(path.join(IMAGE_DIR, file), Buffer.from(base64, 'base64'));
    return file;
}

/** Deletes the file behind a local image URL. Ignores Cloudinary URLs and missing files. */
export async function deleteLocalImage(imageUrl?: string): Promise<void> {
    if (!imageUrl) return;
    const match = imageUrl.match(new RegExp(`${IMAGE_ROUTE}/([\\w-]+\\.(?:jpg|png|webp))$`));
    if (!match) return;
    await fs.unlink(path.join(IMAGE_DIR, match[1])).catch(() => {});
}

/** `?download` makes the browser save the file instead of opening it. */
function downloadHeader(req: Request, res: Response, next: NextFunction) {
    if ('download' in req.query) res.attachment();
    next();
}

export const serveImages = [downloadHeader, express.static(IMAGE_DIR, { maxAge: '7d' })];
