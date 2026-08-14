const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_CAPTURES = 30;
const GITHUB_API_VERSION = '2022-11-28';
const FORBIDDEN_KEYS = new Set([
    'api_key',
    'apikey',
    'authorization',
    'cookie',
    'cookies',
    'password',
    'secret',
    'token',
    'torn_key'
]);

function cleanText(value) {
    return String(value || '').trim();
}

function jsonResponse(body, status = 200, origin = '') {
    const headers = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
    };
    if (origin) {
        headers['access-control-allow-origin'] = origin;
        headers.vary = 'Origin';
    }
    return new Response(JSON.stringify(body), { status, headers });
}

function allowedOrigin(request, env) {
    const origin = cleanText(request.headers.get('origin'));
    if (!origin) return '';
    const allowed = cleanText(env.ALLOWED_ORIGINS || 'https://www.torn.com')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    return allowed.includes(origin) ? origin : null;
}

function containsForbiddenKey(value, seen = new Set()) {
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(item => containsForbiddenKey(item, seen));
    return Object.entries(value).some(([key, child]) => {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        return FORBIDDEN_KEYS.has(normalized) || containsForbiddenKey(child, seen);
    });
}

function isIsoTimestamp(value) {
    const text = cleanText(value);
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text)
        && Number.isFinite(Date.parse(text));
}

function isCaptureId(value) {
    return /^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(cleanText(value));
}

export function validateExport(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('The upload body must be a JSON object.');
    }
    if (payload.schema_version !== 'bmg.export.v1') {
        throw new Error('Unsupported export schema.');
    }
    if (containsForbiddenKey(payload)) {
        throw new Error('The export contains a credential-like field and was rejected.');
    }
    const captures = Array.isArray(payload.captures) ? payload.captures : [];
    if (!captures.length || captures.length > MAX_CAPTURES) {
        throw new Error(`An upload must contain between 1 and ${MAX_CAPTURES} captures.`);
    }

    const captureIds = new Set();
    let eventCount = 0;
    let betCount = 0;
    captures.forEach((capture, index) => {
        if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
            throw new Error(`Capture ${index + 1} is not an object.`);
        }
        if (capture.schema_version !== 'bmg.capture.v1') {
            throw new Error(`Capture ${index + 1} has an unsupported schema.`);
        }
        if (!isCaptureId(capture.capture_id) || captureIds.has(capture.capture_id)) {
            throw new Error(`Capture ${index + 1} has an invalid or duplicate ID.`);
        }
        if (!isIsoTimestamp(capture.observed_at)) {
            throw new Error(`Capture ${index + 1} has an invalid observation time.`);
        }
        if (!/^torn-visible-/i.test(cleanText(capture.source))) {
            throw new Error(`Capture ${index + 1} has an unexpected source.`);
        }
        const events = Array.isArray(capture.events) ? capture.events : [];
        const bets = Array.isArray(capture.bets) ? capture.bets : [];
        if (!events.length && !bets.length) {
            throw new Error(`Capture ${index + 1} contains no events or bets.`);
        }
        captureIds.add(capture.capture_id);
        eventCount += events.length;
        betCount += bets.length;
    });
    return { captures, eventCount, betCount };
}

function bytesToBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

async function sha256Hex(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function githubHeaders(env) {
    return {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': 'bmg-capture-inbox-gateway',
        'x-github-api-version': GITHUB_API_VERSION
    };
}

function contentUrl(env, path) {
    const owner = encodeURIComponent(cleanText(env.GITHUB_OWNER));
    const repo = encodeURIComponent(cleanText(env.GITHUB_REPO));
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
}

async function storeExport(env, payloadText, validation) {
    for (const required of ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'UPLOAD_SECRET']) {
        if (!cleanText(env[required])) throw new Error(`Gateway configuration is missing ${required}.`);
    }
    const first = validation.captures[0];
    const observedAt = new Date(first.observed_at);
    const year = String(observedAt.getUTCFullYear()).padStart(4, '0');
    const month = String(observedAt.getUTCMonth() + 1).padStart(2, '0');
    const day = String(observedAt.getUTCDate()).padStart(2, '0');
    const stamp = first.observed_at.replace(/\.\d+Z$/, 'Z').replace(/[:]/g, '-');
    const digest = (await sha256Hex(payloadText)).slice(0, 16);
    const captureId = cleanText(first.capture_id).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 48);
    const path = `incoming/${year}/${month}/${day}/${stamp}_${captureId}_${digest}.json`;
    const url = contentUrl(env, path);
    const branch = cleanText(env.GITHUB_BRANCH || 'main');
    const existing = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
        method: 'GET',
        headers: githubHeaders(env)
    });
    if (existing.ok) {
        const record = await existing.json();
        return { path, alreadyExists: true, contentSha: cleanText(record.sha), commitSha: '' };
    }
    if (existing.status !== 404) {
        throw new Error(`GitHub inbox lookup failed with status ${existing.status}.`);
    }

    const created = await fetch(url, {
        method: 'PUT',
        headers: githubHeaders(env),
        body: JSON.stringify({
            message: `Ingest ${validation.captures.length} BMG capture(s)`,
            content: bytesToBase64(new TextEncoder().encode(payloadText)),
            branch
        })
    });
    if (!created.ok) {
        throw new Error(`GitHub inbox write failed with status ${created.status}.`);
    }
    const result = await created.json();
    return {
        path,
        alreadyExists: false,
        contentSha: cleanText(result.content?.sha),
        commitSha: cleanText(result.commit?.sha)
    };
}

export default {
    async fetch(request, env) {
        const origin = allowedOrigin(request, env);
        if (origin === null) return jsonResponse({ ok: false, error: 'Origin not allowed.' }, 403);
        if (request.method === 'OPTIONS') {
            const headers = {
                'access-control-allow-methods': 'POST, OPTIONS',
                'access-control-allow-headers': 'authorization, content-type',
                'access-control-max-age': '600'
            };
            if (origin) {
                headers['access-control-allow-origin'] = origin;
                headers.vary = 'Origin';
            }
            return new Response(null, { status: 204, headers });
        }
        if (request.method !== 'POST') {
            return jsonResponse({ ok: false, error: 'Use POST.' }, 405, origin);
        }
        if (request.headers.get('authorization') !== `Bearer ${cleanText(env.UPLOAD_SECRET)}`) {
            return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401, origin);
        }
        const declaredLength = Number(request.headers.get('content-length') || 0);
        if (declaredLength > MAX_UPLOAD_BYTES) {
            return jsonResponse({ ok: false, error: 'Upload is too large.' }, 413, origin);
        }

        try {
            const payloadText = await request.text();
            if (new TextEncoder().encode(payloadText).length > MAX_UPLOAD_BYTES) {
                return jsonResponse({ ok: false, error: 'Upload is too large.' }, 413, origin);
            }
            const payload = JSON.parse(payloadText);
            const validation = validateExport(payload);
            const stored = await storeExport(env, payloadText, validation);
            return jsonResponse({
                ok: true,
                capture_count: validation.captures.length,
                event_count: validation.eventCount,
                bet_count: validation.betCount,
                path: stored.path,
                commit_sha: stored.commitSha,
                content_sha: stored.contentSha,
                already_exists: stored.alreadyExists
            }, stored.alreadyExists ? 200 : 201, origin);
        } catch (error) {
            const message = error instanceof SyntaxError
                ? 'The upload body is not valid JSON.'
                : cleanText(error?.message) || 'Upload failed.';
            const status = /schema|capture|credential|events or bets|JSON object|observation time|source/i.test(message)
                ? 400
                : 502;
            return jsonResponse({ ok: false, error: message }, status, origin);
        }
    }
};
