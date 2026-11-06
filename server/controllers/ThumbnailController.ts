import { Request, Response } from 'express';
import Thumbnail from '../models/Thumbnail.js';
import { generateWithFallback, ImageGenError, MAX_PROMPT_CHARS } from '../configs/ai.js';
import { v2 as cloudinary } from 'cloudinary';
import { deleteLocalImage, IMAGE_ROUTE, saveImageLocally } from '../configs/storage.js';
import { finishImage } from '../configs/textOverlay.js';
import { writeScene } from '../configs/promptWriter.js';

// Style only: no faces forced in, no colour words (the colour scheme covers colour),
// and no "thumbnail" / "typography" wording, which makes image models draw lettering.
const stylePrompts = {
    'Bold & Graphic': 'bold graphic look, one strong focal subject, dramatic lighting, high contrast, punchy click-worthy composition',
    'Tech/Futuristic': 'futuristic look, sleek modern design, glowing accents, holographic light effects, cyber-tech atmosphere, sharp lighting',
    'Minimalist': 'minimalist look, clean layout, simple shapes, limited palette, plenty of negative space, modern flat design, one clear focal point',
    'Photorealistic': 'photorealistic, ultra-realistic lighting, DSLR photography, natural detail, shallow depth of field',
    'Illustrated': 'custom digital illustration, stylized shapes and characters, bold outlines, cartoon or vector art style',
};

const colorSchemeDescriptions = {
    vibrant: 'vibrant and energetic colors, high saturation, bold contrasts, eye-catching palette',
    sunset: 'warm sunset tones, orange pink and purple hues, soft gradients, cinematic glow',
    forest: 'natural green tones, earthy colors, calm and organic palette, fresh atmosphere',
    neon: 'neon glow effects, electric blues and pinks, cyberpunk lighting, high contrast glow',
    purple: 'purple-dominant color palette, magenta and violet tones, modern and stylish mood',
    monochrome: 'black and white color scheme, high contrast, dramatic lighting, timeless aesthetic',
    ocean: 'cool blue and teal tones, aquatic color palette, fresh and clean atmosphere',
    pastel: 'soft pastel colors, low saturation, gentle tones, calm and friendly aesthetic',
};

type AspectRatio = '16:9' | '1:1' | '9:16';

// Sizes from the FLUX endpoints' allowed list. If NVIDIA only accepts
// 1024x1024, configs/ai.ts falls back to that and Cloudinary crops below.
const SIZES: Record<AspectRatio, { width: number; height: number }> = {
    '16:9': { width: 1344, height: 768 },
    '1:1': { width: 1024, height: 1024 },
    '9:16': { width: 768, height: 1344 },
};

const FRAMING: Record<AspectRatio, string> = {
    '16:9': 'Wide landscape composition',
    '1:1': 'Square composition',
    '9:16': 'Tall vertical composition',
};

export function buildPrompt(opts: { title: string; style: string; color_scheme?: string; user_prompt?: string; aspect_ratio: AspectRatio; text_overlay?: boolean; scene?: string }): string {
    const { title, style, color_scheme, user_prompt, aspect_ratio, text_overlay, scene } = opts;

    // The model never writes text: image models misspell it. When text_overlay is on,
    // the title is drawn on afterwards (configs/textOverlay.ts).
    const styleText = stylePrompts[style as keyof typeof stylePrompts] ?? stylePrompts['Bold & Graphic'];

    // With a scene from the LLM (configs/promptWriter.ts) the title isn't in the prompt at all,
    // which keeps FLUX from treating the image as a poster and drawing letters.
    const parts = [scene ?? `A scene that represents ${title}.`, `Style: ${styleText}.`];

    const colorText = colorSchemeDescriptions[color_scheme as keyof typeof colorSchemeDescriptions];
    if (colorText) parts.push(`Color scheme: ${colorText}.`);

    if (user_prompt?.trim()) parts.push(`Additional details: ${user_prompt.trim()}.`);

    const placement = text_overlay
        ? 'main subject in the upper two-thirds of the frame, lower third kept simple and uncluttered'
        : 'main subject near the centre of the frame';
    parts.push(`${FRAMING[aspect_ratio]}, ${placement}, visually stunning, high impact.`);

    parts.push('No text, letters, words, numbers, logos or watermarks anywhere in the image.');

    return parts.join(' ');
}

// Messages for errors from the image API. NVIDIA's raw error text stays in the server log.
const imageErrorMessages: Record<number, string> = {
    400: 'Prompt was rejected. Try shortening the additional prompt.',
    422: "That prompt was blocked by the image model's safety filter. Try rephrasing it.",
    429: 'Image generation limit reached. Please try again later.',
};

export const generateThumbnail = async (req: Request, res: Response) => {
    let thumbnailId: string | undefined;
    try {
        const { userId } = req.session;
        const { title, prompt: user_prompt, style, aspect_ratio, color_scheme, text_overlay } = req.body;

        if (typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ message: 'Title is required' });
        }

        const ratio: AspectRatio = aspect_ratio in SIZES ? aspect_ratio : '16:9';
        const promptOpts = { title: title.trim(), style, color_scheme, user_prompt, aspect_ratio: ratio, text_overlay };
        const templatePrompt = buildPrompt(promptOpts);

        if (templatePrompt.length > MAX_PROMPT_CHARS) {
            return res.status(400).json({ message: `Additional prompt is too long. Please shorten it by about ${templatePrompt.length - MAX_PROMPT_CHARS} characters.` });
        }

        const thumbnail = await Thumbnail.create({
            userId,
            title,
            prompt_used: user_prompt,
            user_prompt,
            style,
            aspect_ratio: ratio,
            color_scheme,
            text_overlay,
            isGenerating: true,
        });
        thumbnailId = String(thumbnail._id);

        // Ask an LLM for a concrete, topic-specific scene so images don't all look alike.
        // Falls back to the plain template if the LLM is unavailable or the result is too long.
        const written = await writeScene({
            title: title.trim(),
            style: stylePrompts[style as keyof typeof stylePrompts] ?? stylePrompts['Bold & Graphic'],
            colors: colorSchemeDescriptions[color_scheme as keyof typeof colorSchemeDescriptions],
            details: user_prompt?.trim() || undefined,
            frame: FRAMING[ratio],
        });
        const scenePrompt = written ? buildPrompt({ ...promptOpts, scene: written.scene }) : null;
        const prompt = scenePrompt && scenePrompt.length <= MAX_PROMPT_CHARS ? scenePrompt : templatePrompt;
        console.log(written ? `[prompt] scene by ${written.model}: ${written.scene}` : '[prompt] LLM unavailable, using the plain template');

        // Generate the image with NVIDIA FLUX (FLUX.3 Klein, falls back to FLUX.2 Klein 4B)
        const image = await generateWithFallback({ prompt, ...SIZES[ratio] });
        console.log(`[thumbnail] generated with ${image.model} at ${image.width}x${image.height}`);

        // Crop to the exact aspect ratio, then draw the title with a real font so it's spelled exactly right
        const { base64, mime } = await finishImage(image.base64, { aspectRatio: ratio, title: text_overlay ? title.trim() : undefined });

        if (process.env.IMAGE_STORAGE === 'cloudinary') {
            const uploadResult = await cloudinary.uploader.upload(`data:${mime};base64,${base64}`, {
                resource_type: 'image',
            });
            // Already cropped and titled above, so store it as is
            thumbnail.image_url = uploadResult.secure_url;
        } else {
            // Save to server/uploads and serve it from this server
            const file = await saveImageLocally(thumbnailId, base64, mime);
            thumbnail.image_url = `${req.protocol}://${req.get('host')}${IMAGE_ROUTE}/${file}`;
        }
        thumbnail.isGenerating = false;
        await thumbnail.save();

        res.json({ message: 'Thumbnail Generated', thumbnail });
    } catch (error: any) {
        console.log(error);

        // Don't leave a record stuck on "generating" forever
        if (thumbnailId) await Thumbnail.findByIdAndDelete(thumbnailId).catch(() => {});

        if (error instanceof ImageGenError) {
            const status = error.status && imageErrorMessages[error.status] ? error.status : 502;
            return res.status(status).json({ message: imageErrorMessages[status] ?? 'Image generation failed. Please try again.' });
        }
        res.status(500).json({ message: error.message });
    }
};

// Controllers For Thumbnail Deletion
export const deleteThumbnail = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { userId } = req.session;

        // findOneAndDelete so the userId check actually applies (findByIdAndDelete ignored it)
        const deleted = await Thumbnail.findOneAndDelete({ _id: id, userId });
        if (!deleted) return res.status(404).json({ message: 'Thumbnail not found' });
        await deleteLocalImage(deleted.image_url);

        res.json({ message: 'Thumbnail deleted successfully' });
    } catch (error: any) {
        console.log(error);
        res.status(500).json({ message: error.message });
    }
};
