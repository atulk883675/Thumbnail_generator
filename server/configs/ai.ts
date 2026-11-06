// NVIDIA-hosted FLUX image generation (replaces the Gemini client).
//
// NVIDIA's reference pages (docs.api.nvidia.com/nim/reference/black-forest-labs-*-infer)
// don't always match the live API. Example: the docs say flux.2-klein-4b takes
// cfg_scale 0 and a `mode` field; the live API requires cfg_scale >= 1 and rejects
// `mode`. So the values below are starting points, and generateImage() corrects
// the request from the API's own validation errors (HTTP 422) and remembers the fix.

const BASE = 'https://ai.api.nvidia.com/v1/genai/black-forest-labs';

export type ModelId = 'flux-3-klein' | 'flux-2-klein-4b' | 'flux-1-schnell' | 'flux-1-dev';

interface ModelConfig {
    url: string;
    mode?: string; // omitted from the request when undefined
    maxPromptChars: number;
    cfgScale: number;
    steps: number;
}

export const MODELS: Record<ModelId, ModelConfig> = {
    'flux-3-klein': {
        // Listed in NVIDIA's docs but returned 404 on 25 Oct 2026 (hosted release "TBD").
        url: `${BASE}/flux.3-image-klein`,
        mode: 'Image Generation',
        maxPromptChars: 2000,
        cfgScale: 3.5,
        steps: 50,
    },
    'flux-2-klein-4b': {
        // Confirmed against the live API: no `mode`, cfg_scale must be >= 1.
        url: `${BASE}/flux.2-klein-4b`,
        maxPromptChars: 10000,
        cfgScale: 1,
        steps: 4,
    },
    'flux-1-schnell': {
        url: `${BASE}/flux.1-schnell`,
        mode: 'base',
        maxPromptChars: 10000,
        cfgScale: 0,
        steps: 4,
    },
    'flux-1-dev': {
        // Non-commercial licence: fine for a demo, not for a product.
        url: `${BASE}/flux.1-dev`,
        mode: 'base',
        maxPromptChars: 10000,
        cfgScale: 5,
        steps: 50,
    },
};

// Tried in this order. FLUX.1 schnell is last because it is the oldest, most established endpoint.
export const DEFAULT_MODEL_ORDER: ModelId[] = ['flux-3-klein', 'flux-2-klein-4b', 'flux-1-schnell'];

// Prompts must fit the strictest model in the order above.
export const MAX_PROMPT_CHARS = Math.min(...DEFAULT_MODEL_ORDER.map((m) => MODELS[m].maxPromptChars));

export class ImageGenError extends Error {
    status?: number;
    retryable: boolean;
    model?: ModelId;

    constructor(message: string, opts: { status?: number; retryable?: boolean; model?: ModelId } = {}) {
        super(message);
        this.name = 'ImageGenError';
        this.status = opts.status;
        this.retryable = opts.retryable ?? false;
        this.model = opts.model;
    }
}

export interface GeneratedImage {
    base64: string;
    mime: string;
    seed?: number;
    model: ModelId;
    width: number;
    height: number;
}

interface GenerateOptions {
    prompt: string;
    model?: ModelId;
    seed?: number; // 0 = random
    width?: number;
    height?: number;
    steps?: number;
    timeoutMs?: number;
}

// What we've learned from the live API, per model. Reset when the server restarts.
const squareOnly = new Set<ModelId>(); // rejected non-square sizes
const unavailable = new Set<ModelId>(); // endpoint returned 404
const fixes = new Map<ModelId, { drop: Set<string>; set: Record<string, unknown> }>();

function mimeFromBase64(b64: string): string {
    if (b64.startsWith('/9j/')) return 'image/jpeg';
    if (b64.startsWith('iVBOR')) return 'image/png';
    if (b64.startsWith('UklGR')) return 'image/webp';
    return 'image/jpeg';
}

function buildBody(model: ModelId, prompt: string, width: number, height: number, seed: number, steps?: number): Record<string, unknown> {
    const cfg = MODELS[model];
    const body: Record<string, unknown> = {
        prompt,
        mode: cfg.mode,
        width,
        height,
        cfg_scale: cfg.cfgScale,
        steps: steps ?? cfg.steps,
        seed,
        samples: 1,
    };
    if (cfg.mode === undefined) delete body.mode;
    const fix = fixes.get(model);
    if (fix) {
        for (const key of fix.drop) delete body[key];
        Object.assign(body, fix.set);
    }
    return body;
}

/**
 * Reads a FastAPI/pydantic 422 body ({"detail":[{type, loc, ctx}]}) and records
 * a fix for each error we understand. Returns what changed, or null if nothing could be fixed.
 */
function learnFromValidationError(model: ModelId, text: string, body: Record<string, unknown>): { size: boolean; notes: string[] } | null {
    let detail: any[];
    try {
        detail = JSON.parse(text)?.detail;
    } catch {
        detail = [];
    }

    const fix = fixes.get(model) ?? { drop: new Set<string>(), set: {} };
    const notes: string[] = [];
    let size = false;

    if (Array.isArray(detail)) {
        for (const err of detail) {
            const field = String(err?.loc?.[err.loc.length - 1] ?? '');
            const ctx = err?.ctx ?? {};
            if (field === 'width' || field === 'height') {
                size = true;
            } else if (err?.type === 'extra_forbidden') {
                fix.drop.add(field);
                notes.push(`dropped ${field}`);
            } else if (ctx.ge !== undefined || ctx.gt !== undefined) {
                fix.set[field] = ctx.ge ?? ctx.gt + 1;
                notes.push(`${field} ${body[field]} -> ${fix.set[field]}`);
            } else if (ctx.le !== undefined || ctx.lt !== undefined) {
                fix.set[field] = ctx.le ?? ctx.lt - 1;
                notes.push(`${field} ${body[field]} -> ${fix.set[field]}`);
            } else if (err?.type === 'literal_error' && typeof ctx.expected === 'string') {
                const first = ctx.expected.match(/'([^']+)'/)?.[1];
                if (first) {
                    fix.set[field] = first;
                    notes.push(`${field} -> '${first}'`);
                }
            }
        }
    } else if (/width|height|resolution|size/i.test(text)) {
        size = true; // non-JSON size complaint
    }

    if (size) {
        if (body.width === 1024 && body.height === 1024) size = false; // already square, can't help
        else notes.push('size -> 1024x1024');
    }
    if (!notes.length) return null;
    fixes.set(model, fix);
    return { size, notes };
}

async function post(model: ModelId, body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) throw new ImageGenError('NVIDIA_API_KEY is not set in server/.env', { status: 500 });
    try {
        return await fetch(MODELS[model].url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err: any) {
        throw new ImageGenError(`Request to ${model} failed: ${err.message}`, { status: 502, retryable: true, model });
    }
}

/** Generate one image with one model. */
export async function generateImage({ prompt, model = 'flux-3-klein', seed = 0, width = 1024, height = 1024, steps, timeoutMs = 120_000 }: GenerateOptions): Promise<GeneratedImage> {
    const cfg = MODELS[model];
    if (!prompt?.trim()) throw new ImageGenError('Prompt is empty', { status: 400, model });
    if (prompt.length > cfg.maxPromptChars) {
        throw new ImageGenError(`Prompt is ${prompt.length} chars; ${model} allows ${cfg.maxPromptChars}`, { status: 400, model });
    }
    if (squareOnly.has(model)) width = height = 1024;

    // Up to 2 corrections from 422 validation errors, then give up on this model
    let res!: Response;
    let errorText = '';
    for (let attempt = 0; attempt < 3; attempt++) {
        const body = buildBody(model, prompt, width, height, seed, steps);
        res = await post(model, body, timeoutMs);
        if (res.status !== 422 && res.status !== 400) break;

        errorText = await res.text().catch(() => '');
        const learned = attempt < 2 ? learnFromValidationError(model, errorText, body) : null;
        if (!learned) break;
        if (learned.size) {
            squareOnly.add(model);
            width = height = 1024;
        }
        console.warn(`[ai] ${model} rejected the request, adjusting: ${learned.notes.join(', ')}`);
    }

    if (!res.ok) {
        if (res.status === 404) unavailable.add(model);
        const detail = (errorText || (await res.text().catch(() => ''))).slice(0, 500);
        throw new ImageGenError(`${model} returned HTTP ${res.status}: ${detail}`, {
            // 429 means rate limit / credits; anything else from NVIDIA is our request or their outage.
            status: res.status === 429 ? 429 : 502,
            // A bad key (401/403) fails every model, so stop. Anything else: another model may work.
            retryable: res.status !== 401 && res.status !== 403,
            model,
        });
    }

    const json: any = await res.json();
    const artifact = json?.artifacts?.[0];
    if (!artifact?.base64) {
        throw new ImageGenError(`${model} returned no image: ${JSON.stringify(json).slice(0, 300)}`, { status: 502, retryable: true, model });
    }
    if (artifact.finishReason && artifact.finishReason !== 'SUCCESS') {
        // The safety filter blocked the output. Another model would likely block it too.
        throw new ImageGenError(`${model} finished with ${artifact.finishReason}`, { status: 422, model });
    }

    return {
        base64: artifact.base64,
        mime: mimeFromBase64(artifact.base64),
        seed: artifact.seed,
        model,
        width,
        height,
    };
}

/**
 * Try models in order, skipping ones already known to be unavailable. Moves on for
 * any model-specific failure; stops at once for a bad key, a blocked prompt or a local error.
 */
export async function generateWithFallback(opts: Omit<GenerateOptions, 'model'>, allModels: ModelId[] = DEFAULT_MODEL_ORDER): Promise<GeneratedImage> {
    const live = allModels.filter((m) => !unavailable.has(m));
    const order = live.length ? live : allModels;
    for (let i = 0; i < order.length; i++) {
        try {
            return await generateImage({ ...opts, model: order[i] });
        } catch (err: any) {
            const isLast = i === order.length - 1;
            if (!(err instanceof ImageGenError) || !err.retryable || isLast) throw err;
            console.warn(`[ai] ${err.message} - trying ${order[i + 1]}`);
        }
    }
    throw new ImageGenError('No models configured', { status: 500 });
}
