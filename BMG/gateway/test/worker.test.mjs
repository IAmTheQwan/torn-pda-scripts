import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { validateExport } from '../src/worker.mjs';

const env = {
    ALLOWED_ORIGINS: 'https://www.torn.com',
    GITHUB_BRANCH: 'main',
    GITHUB_OWNER: 'IAmTheQwan',
    GITHUB_REPO: 'bmg-capture-inbox',
    GITHUB_TOKEN: 'server-only-test-token',
    UPLOAD_SECRET: 'upload-test-secret'
};

function exportPayload() {
    return {
        schema_version: 'bmg.export.v1',
        generated_at: '2026-08-14T15:00:00Z',
        captures: [{
            schema_version: 'bmg.capture.v1',
            capture_id: '4e7dc3f6-ff11-4e2b-a6f1-4fdc78422926',
            observed_at: '2026-08-14T13:17:16.494Z',
            source: 'torn-visible-bookie-dom',
            page_url: 'https://www.torn.com/page.php?sid=bookie',
            page_hash: '#/football/5147621',
            events: [{ source_event_id: '5147621', markets: [] }],
            bets: []
        }]
    };
}

function uploadRequest(payload = exportPayload(), secret = env.UPLOAD_SECRET) {
    return new Request('https://bmg-capture-inbox.example.workers.dev/upload', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${secret}`,
            'content-type': 'application/json',
            origin: 'https://www.torn.com'
        },
        body: JSON.stringify(payload)
    });
}

test('validates a bounded BMG export', () => {
    const result = validateExport(exportPayload());
    assert.equal(result.captures.length, 1);
    assert.equal(result.eventCount, 1);
    assert.equal(result.betCount, 0);
});

test('rejects credential-like fields', () => {
    const payload = exportPayload();
    payload.api_key = 'must-not-upload';
    assert.throws(() => validateExport(payload), /credential-like/i);
});

test('requires the upload secret before contacting GitHub', async () => {
    const originalFetch = globalThis.fetch;
    let contacted = false;
    globalThis.fetch = async () => {
        contacted = true;
        throw new Error('should not run');
    };
    try {
        const response = await worker.fetch(uploadRequest(exportPayload(), 'wrong'), env);
        assert.equal(response.status, 401);
        assert.equal(contacted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('writes a validated export to the private GitHub inbox', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), options });
        if (options.method === 'GET') return new Response('{}', { status: 404 });
        return new Response(JSON.stringify({
            content: { sha: 'content-sha' },
            commit: { sha: 'commit-sha' }
        }), { status: 201, headers: { 'content-type': 'application/json' } });
    };
    try {
        const response = await worker.fetch(uploadRequest(), env);
        const body = await response.json();
        assert.equal(response.status, 201);
        assert.equal(body.ok, true);
        assert.equal(body.capture_count, 1);
        assert.equal(body.event_count, 1);
        assert.equal(body.commit_sha, 'commit-sha');
        assert.match(body.path, /^incoming\/2026\/08\/14\//);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].options.method, 'GET');
        assert.equal(calls[1].options.method, 'PUT');
        assert.equal(calls[1].options.headers.authorization, `Bearer ${env.GITHUB_TOKEN}`);
        const createBody = JSON.parse(calls[1].options.body);
        assert.equal(createBody.branch, 'main');
        assert.ok(createBody.content.length > 20);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('treats an existing content-addressed upload as idempotent', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
        assert.equal(options.method, 'GET');
        return new Response(JSON.stringify({ sha: 'existing-content-sha' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    };
    try {
        const response = await worker.fetch(uploadRequest(), env);
        const body = await response.json();
        assert.equal(response.status, 200);
        assert.equal(body.already_exists, true);
        assert.equal(body.content_sha, 'existing-content-sha');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
