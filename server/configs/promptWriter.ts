// Turns a short video title into one specific scene for the image model, using an
// NVIDIA-hosted LLM (same NVIDIA_API_KEY as the images).
//
// Why: a title like "Switzerland" gives FLUX almost nothing to work with, so it
// follows the style words instead and every image looks the same. Black Forest Labs
// recommends this kind of "prompt upsampling" for its Klein models.
// If the LLM is unavailable, writeScene() returns null and the caller uses its plain template.

const CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

// Tried in order. Override with PROMPT_MODEL in .env (any NVIDIA-hosted chat model).
// NVIDIA retires models without removing them from the docs (all Llama models returned
// 410 Gone from 26 Aug 2026), so keep several and let dead ones drop out at runtime.
const DEFAULT_MODELS = ['google/gemma-4-31b-it', 'google/gemma-3-27b-it', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'openai/gpt-oss-20b'];

// Extra request fields per model. Gemma 4's "thinking" is off: slower, and not needed here.
const EXTRA_BODY: Record<string, object> = {
    'google/gemma-4-31b-it': { chat_template_kwargs: { enable_thinking: false } },
};

const unavailable = new Set<string>(); // returned 404 or 410 (retired); skipped until the server restarts

export interface SceneRequest {
    title: string;
    style: string;
    colors?: string;
    details?: string;
    frame: string;
}

export const MAX_SCENE_CHARS = 700;

function instructions(r: SceneRequest): string {
    return [
        'You write prompts for an image generation model. The image is the background of a video thumbnail; the title is added on top later by other software.',
        '',
        `Video title: ${r.title}`,
        `Visual style: ${r.style}`,
        r.colors ? `Colour scheme: ${r.colors}` : null,
        r.details ? `Creator's extra requests (follow these): ${r.details}` : null,
        `Frame: ${r.frame}`,
        '',
        'Describe ONE specific, concrete scene that makes the topic obvious at a glance: the main subject, what is happening, the setting, the camera angle and shot type, and the lighting.',
        'Be specific to this topic: for a place, its recognisable landmarks or landscape; for an activity, people or objects actually doing it; for a product, the product itself.',
        'Include a person only if the topic is about people or an activity, and vary their age, gender and appearance. Never default to a close-up of a shouting or shocked face.',
        'Never name or describe real, identifiable people (celebrities, politicians, public figures); show generic characters instead.',
        'Keep the bottom third of the frame simple and uncluttered, because the title goes there.',
        'Do not mention text, words, letters, signs, captions, logos or the title itself.',
        'Reply with the scene description only: one paragraph, at most 80 words, no quotes, no preamble.',
    ]
        .filter((line) => line !== null) // drop optional lines that weren't given
        .join('\n');
}

/** Strips reasoning blocks, preambles and quotes; trims to whole sentences. */
export function cleanScene(raw: string): string | null {
    let s = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^\s*(here'?s|here is|sure|scene|prompt|description)[^:\n]{0,40}:\s*/i, '')
        .replace(/["“”]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (s.length < 20) return null;
    if (s.length > MAX_SCENE_CHARS) {
        const cut = s.slice(0, MAX_SCENE_CHARS);
        const lastStop = cut.lastIndexOf('.');
        s = lastStop > 100 ? cut.slice(0, lastStop + 1) : cut;
    }
    return s;
}

export async function writeScene(r: SceneRequest, timeoutMs = 12_000): Promise<{ scene: string; model: string } | null> {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) return null;

    const models = (process.env.PROMPT_MODEL ? [process.env.PROMPT_MODEL] : DEFAULT_MODELS).filter((m) => !unavailable.has(m));
    for (const model of models) {
        try {
            const res = await fetch(CHAT_URL, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: instructions(r) }],
                    temperature: 0.9, // different scene each time, even for the same title
                    top_p: 0.95,
                    max_tokens: 1024, // room for reasoning models; the scene itself is trimmed to 700 chars
                    ...EXTRA_BODY[model],
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (res.status === 404 || res.status === 410) {
                unavailable.add(model);
                console.warn(`[prompt] ${model} is ${res.status === 410 ? 'retired' : 'not available'}, trying the next model`);
                continue;
            }
            if (!res.ok) {
                console.warn(`[prompt] ${model} returned HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
                continue;
            }
            const json: any = await res.json();
            const scene = cleanScene(String(json?.choices?.[0]?.message?.content ?? ''));
            if (scene) return { scene, model };
            console.warn(`[prompt] ${model} returned an unusable reply`);
        } catch (err: any) {
            console.warn(`[prompt] ${model} failed: ${err.message}`);
        }
    }
    return null;
}
