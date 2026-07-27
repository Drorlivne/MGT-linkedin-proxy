/**
 * LinkedIn Analytics Proxy — starter server
 * ------------------------------------------------------------------
 * PURPOSE
 * This is the missing piece that lets the MGT dashboard's "Live Sync"
 * panel poll real LinkedIn data. It runs on a server YOU control
 * (Render, Railway, a VPS, AWS Lambda, etc.) and does three things:
 *
 *   1. Holds your LinkedIn app's Client ID / Client Secret / refresh
 *      token as environment variables — NEVER in client-side code.
 *   2. Calls LinkedIn's Community Management API (organization posts
 *      + post statistics) using your approved app's credentials.
 *   3. Returns a small, normalized JSON array that the dashboard
 *      already knows how to read.
 *
 * WHY POLLING, NOT PUSH
 * LinkedIn's API does not offer a webhook/subscription for new organic
 * company-page posts. Every third-party tool (including this one)
 * works by periodically asking the API "what's new / what changed."
 * The dashboard's Live Sync panel calls THIS server on a timer
 * (e.g. every 15 min) — this server is what actually talks to LinkedIn.
 *
 * SETUP
 *   1. npm init -y && npm install express node-fetch cors dotenv
 *   2. Create a .env file (DO NOT commit it) with:
 *        LINKEDIN_CLIENT_ID=xxxxx
 *        LINKEDIN_CLIENT_SECRET=xxxxx
 *        LINKEDIN_REFRESH_TOKEN=xxxxx        (from your OAuth flow)
 *        LINKEDIN_ORG_URN=urn:li:organization:XXXXXXX
 *        ALLOWED_ORIGIN=https://your-dashboard-host.example.com
 *        LINKEDIN_POST_LIMIT=25               (optional, default 25 — batching means this is cheap)
 *        LINKEDIN_STATS_DELAY_MS=300           (optional, default 300 — delay between stats calls)
 *   3. node linkedin-proxy-server.js
 *   4. Deploy it somewhere with HTTPS (Render/Railway/Fly.io/Lambda),
 *      then paste that public URL + /api/linkedin-posts into the
 *      dashboard's "Proxy endpoint URL" field.
 *
 * NOTE ON THE OAUTH FLOW
 * Getting the initial LINKEDIN_REFRESH_TOKEN requires a one-time
 * interactive OAuth consent (3-legged OAuth) as an admin of the
 * organization page, using the scopes your approved app was granted
 * (e.g. r_organization_social, rw_organization_admin). That consent
 * step is NOT something a script can do unattended — you do it once
 * in a browser, then store the resulting refresh token as a secret.
 * LinkedIn access tokens expire in 60 days; refresh tokens ~365 days,
 * so build a reminder to redo consent before then.
 *
 * This file is a STARTER — the exact LinkedIn endpoint paths/fields
 * you need depend on which Community Management API products your
 * app was approved for. Check your app's approved products in the
 * LinkedIn Developer Portal and adjust the fetch calls below to match.
 * ------------------------------------------------------------------
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const LINKEDIN_VERSION = '202601'; // LinkedIn requires a LinkedIn-Version header (YYYYMM)

// Bump this string every time you deploy a meaningfully different version of
// this file. Visiting the root URL (e.g. https://your-app.onrender.com/) or
// checking the startup logs will always show exactly which version is live —
// this makes it possible to confirm a deploy actually took effect, instead of
// guessing from log message patterns.
const CODE_VERSION = 'v10-preserve-on-quota-fail-2026-07-27';

// IMPORTANT: Render (and most hosting platforms) sit behind a reverse proxy
// that terminates HTTPS and forwards requests to your app as plain HTTP.
// Without this line, req.protocol reports "http" even though the real
// request was "https" — which silently breaks the redirect_uri LinkedIn
// checks against, causing "redirect_uri does not match the registered value"
// even when you copied the URL correctly.
app.set('trust proxy', 1);

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

app.get('/', (req, res) => {
    res.send(`LinkedIn proxy is running. Version: ${CODE_VERSION}. Visit /auth/debug to see your exact redirect URI, /auth/login to set up, /debug/stats-test?postUrn=... to isolate a single stats request, then use /api/linkedin-posts.`);
});

// ---- In-memory access token cache (swap for Redis/DB in production) ----
let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

async function getAccessToken() {
    if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry - 60000) {
        return cachedAccessToken;
    }

    const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: process.env.LINKEDIN_REFRESH_TOKEN,
            client_id: process.env.LINKEDIN_CLIENT_ID,
            client_secret: process.env.LINKEDIN_CLIENT_SECRET
        })
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Token refresh failed (${res.status}): ${body}`);
    }

    const data = await res.json();
    cachedAccessToken = data.access_token;
    cachedAccessTokenExpiry = Date.now() + (data.expires_in * 1000);
    return cachedAccessToken;
}

function li(path, token) {
    return fetch(`https://api.linkedin.com/rest${path}`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'LinkedIn-Version': LINKEDIN_VERSION,
            'X-Restli-Protocol-Version': '2.0.0'
        }
    });
}

/**
 * ------------------------------------------------------------------
 * ONE-TIME SETUP HELPER — get your refresh token with just a browser
 * ------------------------------------------------------------------
 * You only need this ONCE (and again if you ever redo consent).
 * No coding tools, no Postman, no terminal commands — just click a link.
 *
 *   1. Open: https://YOUR-SERVER-URL/auth/login   in your browser
 *   2. Log in to LinkedIn as a page admin and click "Allow"
 *   3. You'll land on a page showing your Refresh Token
 *   4. Copy it into your hosting provider's environment variables
 *      as LINKEDIN_REFRESH_TOKEN, then you're done — you can ignore
 *      these two routes after that.
 * ------------------------------------------------------------------
 */
const REDIRECT_PATH = '/auth/callback';

function computeRedirectUri(req) {
    return `${req.protocol}://${req.get('host')}${REDIRECT_PATH}`;
}

/**
 * GET /auth/debug
 * Shows the EXACT redirect_uri this server will send to LinkedIn.
 * Copy this value character-for-character into LinkedIn Developer Portal
 * → your app → Auth tab → "Authorized redirect URLs for your app".
 * This avoids any typo/http-vs-https mismatch when setting it up by hand.
 */
app.get('/auth/debug', (req, res) => {
    const redirectUri = computeRedirectUri(req);
    res.send(`
        <html><body style="font-family: sans-serif; max-width: 640px; margin: 60px auto; line-height:1.6;">
            <h2>Copy this exact value into LinkedIn</h2>
            <p>Go to LinkedIn Developer Portal → your app → <strong>Auth</strong> tab →
               <strong>Authorized redirect URLs for your app</strong>, and paste this value exactly
               (select all, copy, don't retype it):</p>
            <textarea readonly style="width:100%; height:50px; font-family:monospace; font-size:14px; padding:10px;">${redirectUri}</textarea>
            <p style="color:#b45309;">If this shows <code>http://</code> instead of <code>https://</code>, the server isn't
            detecting HTTPS correctly — double check the deployed code includes <code>app.set('trust proxy', 1)</code>.</p>
        </body></html>
    `);
});

app.get('/auth/login', (req, res) => {
    const redirectUri = computeRedirectUri(req);
    const scope = process.env.LINKEDIN_SCOPES || 'r_organization_social rw_organization_admin';
    const authUrl = 'https://www.linkedin.com/oauth/v2/authorization?' + new URLSearchParams({
        response_type: 'code',
        client_id: process.env.LINKEDIN_CLIENT_ID,
        redirect_uri: redirectUri,
        scope
    });
    res.redirect(authUrl);
});

app.get(REDIRECT_PATH, async (req, res) => {
    const code = req.query.code;
    const error = req.query.error_description;
    if (error) {
        return res.status(400).send(`<h2>LinkedIn returned an error</h2><p>${error}</p>`);
    }
    if (!code) {
        return res.status(400).send('<h2>Missing authorization code</h2>');
    }

    const redirectUri = computeRedirectUri(req);

    try {
        const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                client_id: process.env.LINKEDIN_CLIENT_ID,
                client_secret: process.env.LINKEDIN_CLIENT_SECRET
            })
        });

        if (!tokenRes.ok) {
            const body = await tokenRes.text();
            return res.status(500).send(`<h2>Token exchange failed</h2><pre>${body}</pre>`);
        }

        const tokenData = await tokenRes.json();

        res.send(`
            <html><body style="font-family: sans-serif; max-width: 640px; margin: 60px auto; line-height:1.6;">
                <h2>✅ Success — copy your Refresh Token</h2>
                <p>Copy the value below into your hosting provider's environment variables as
                   <code>LINKEDIN_REFRESH_TOKEN</code>, then redeploy/restart the server.</p>
                <textarea readonly style="width:100%; height:80px; font-family:monospace; padding:10px;">${tokenData.refresh_token || '(no refresh_token returned — check your app has offline access enabled)'}</textarea>
                <p style="color:#b45309;">This token is a secret — treat it like a password. Do not share it or paste it anywhere public.</p>
                <p>Access token also issued (expires in ${tokenData.expires_in || '?'} seconds) — you don't need to save this one, the server renews it automatically using the refresh token.</p>
            </body></html>
        `);
    } catch (err) {
        res.status(500).send(`<h2>Unexpected error</h2><pre>${err.message}</pre>`);
    }
});

/**
 * GET /debug/stats-test?postUrn=urn:li:ugcPost:XXXXXXXXXX
 *
 * Isolated diagnostic tool: makes exactly ONE request to
 * organizationalEntityShareStatistics for exactly ONE post, and returns
 * the full raw response — status code, all response headers (including
 * any rate-limit / throttle headers LinkedIn sends back), and the raw
 * body. This exists because the sync logs alone can't distinguish
 * between "daily quota exhausted" and "this app isn't permitted to use
 * this parameter/endpoint at all" — both can show up as errors that
 * look similar in a noisy loop of 10 requests. One clean, isolated call
 * makes the actual cause visible.
 *
 * Usage: open this URL in your browser (or ask whoever is helping you
 * debug to open it), copy a real post URN from your Render logs (the
 * "Fetching stats..." lines, or from /api/linkedin-posts output), and
 * paste it into the postUrn query parameter.
 */
app.get('/debug/stats-test', async (req, res) => {
    // Accept one or more postUrn params: ?postUrn=A or ?postUrn=A&postUrn=B&postUrn=C
    let postUrns = req.query.postUrn;
    if (!postUrns) {
        return res.status(400).send(`
            <html><body style="font-family: sans-serif; max-width: 640px; margin: 60px auto; line-height:1.6;">
                <h2>Missing postUrn</h2>
                <p>Add <code>?postUrn=urn:li:ugcPost:XXXXXXXXXX</code> to this URL, using a real post URN from your Render logs. You can repeat it to test batching: <code>?postUrn=A&postUrn=B</code>.</p>
                <p>Example: <code>${req.protocol}://${req.get('host')}/debug/stats-test?postUrn=urn:li:ugcPost:1234567890</code></p>
            </body></html>
        `);
    }
    if (!Array.isArray(postUrns)) postUrns = [postUrns];

    try {
        const token = await getAccessToken();
        const orgUrn = process.env.LINKEDIN_ORG_URN;

        // FIX: we send "X-Restli-Protocol-Version: 2.0.0" in the headers, but the
        // previous code encoded the array parameter using Rest.li PROTOCOL 1.0
        // syntax (ugcPosts[0]=X&ugcPosts[1]=Y — indexed brackets). Protocol 2.0
        // uses a different array syntax entirely: ugcPosts=List(X,Y). Sending 1.0
        // syntax while declaring 2.0 in the header is almost certainly why every
        // request was rejected with QUERY_PARAM_NOT_ALLOWED regardless of count.
        const listValue = 'List(' + postUrns.map(u => encodeURIComponent(u)).join(',') + ')';
        const url = `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}&ugcPosts=${listValue}`;

        const statsRes = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'LinkedIn-Version': LINKEDIN_VERSION,
                'X-Restli-Protocol-Version': '2.0.0'
            }
        });

        const bodyText = await statsRes.text();
        const headersObj = {};
        statsRes.headers.forEach((value, key) => { headersObj[key] = value; });

        let bodyFormatted = bodyText;
        try { bodyFormatted = JSON.stringify(JSON.parse(bodyText), null, 2); } catch (e) { /* leave as raw text */ }

        res.set('Content-Type', 'text/plain');
        res.send(
`TESTING ${postUrns.length} POST(S) WITH REST.LI 2.0 "List(...)" SYNTAX

REQUEST URL:
${url}

REQUEST HEADERS:
LinkedIn-Version: ${LINKEDIN_VERSION}
X-Restli-Protocol-Version: 2.0.0

RESPONSE STATUS: ${statsRes.status} ${statsRes.statusText}

RESPONSE HEADERS:
${JSON.stringify(headersObj, null, 2)}

RESPONSE BODY:
${bodyFormatted}
`
        );
    } catch (err) {
        res.status(500).send(`Unexpected error: ${err.message}`);
    }
});

/**
 * GET /api/linkedin-posts
 * Returns: [{ externalId, date, topic, format, impressions, clicks,
 *              reactions, comments, shares, url }, ...]
 *
 * This handler fetches recent organic posts for the configured
 * organization, then pulls per-post statistics and normalizes the
 * shape the dashboard expects. Adjust field paths to match the exact
 * response shape of the Community Management API products your app
 * has been approved for (Posts API + Post Statistics / Social Actions).
 */
app.get('/api/linkedin-posts', async (req, res) => {
    try {
        const token = await getAccessToken();
        const orgUrn = process.env.LINKEDIN_ORG_URN;

        // How many recent posts to pull stats for on each sync. Since stats are now
        // fetched in a single batched call regardless of count, this can safely be
        // higher than before — raised back to 25. Override via env var if needed.
        const POST_LIMIT = parseInt(process.env.LINKEDIN_POST_LIMIT, 10) || 25;

        // 1) List recent posts authored by the organization.
        const postsRes = await li(
            `/posts?author=${encodeURIComponent(orgUrn)}&q=author&count=${POST_LIMIT}&sortBy=LAST_MODIFIED`,
            token
        );
        if (!postsRes.ok) throw new Error(`Posts fetch failed (${postsRes.status}): ${await postsRes.text()}`);
        const postsData = await postsRes.json();
        const rawPosts = postsData.elements || [];

        // 2) Fetch statistics for ALL posts in ONE batched request.
        //
        // ROOT CAUSE WAS CONFIRMED AND FIXED (isolated /debug/stats-test came back
        // 200 OK with real data): the earlier QUERY_PARAM_NOT_ALLOWED errors were
        // caused by mixing Rest.li protocol versions — sending the "2.0.0" header
        // while encoding the array parameter with 1.0-style indexed brackets
        // (ugcPosts[0]=X). The correct 2.0 syntax is ugcPosts=List(X,Y,Z), and a
        // live test confirmed it returns real impression/like/comment/share data.
        // This was never a quota or permissions problem.
        //
        // Batching all posts into one call (instead of one call per post) is what
        // actually solves the earlier 429 TOO_MANY_REQUESTS issue — it turns a
        // 10-call sync into a single call.
        const ugcPostUrns = rawPosts.map(p => p.id).filter(id => id && id.startsWith('urn:li:ugcPost:'));
        const shareUrns = rawPosts.map(p => p.id).filter(id => id && id.startsWith('urn:li:share:'));

        const statsMap = {}; // postUrn -> { impressionCount, clickCount, likeCount, commentCount, shareCount }
        let ugcBatchFailed = false;
        let shareBatchFailed = false;

        if (ugcPostUrns.length) {
            const listValue = 'List(' + ugcPostUrns.map(u => encodeURIComponent(u)).join(',') + ')';
            console.log(`Fetching batched stats for ${ugcPostUrns.length} UGC Post(s) in a single request.`);
            const statsRes = await li(
                `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}&ugcPosts=${listValue}`,
                token
            );
            if (statsRes.ok) {
                const statsJson = await statsRes.json();
                const elements = statsJson.elements || [];
                elements.forEach(el => {
                    if (el.ugcPost) statsMap[el.ugcPost] = el.totalShareStatistics || {};
                });
                console.log(`Batched UGC Post stats returned data for ${elements.length} of ${ugcPostUrns.length} requested post(s). Posts with no actions/impressions are expected to be omitted (LinkedIn treats them as all-zero).`);
            } else {
                ugcBatchFailed = true;
                const body = await statsRes.text();
                console.warn(`Batched UGC Post stats request failed: HTTP ${statsRes.status} — ${body}`);
                if (statsRes.status === 429) {
                    console.warn('Daily quota for this resource is exhausted — this will resolve automatically once LinkedIn resets the quota (typically within 24h). Avoid clicking "Sync Now" repeatedly in the meantime. Affected posts will report statsUnavailable so the dashboard keeps their previous numbers instead of zeroing them out.');
                }
            }
        }

        if (shareUrns.length) {
            // Same fix as ugcPosts above: the "shares" parameter takes the same
            // Rest.li 2.0 List(...) syntax, not indexed brackets. The very first
            // error ever seen in this project was QUERY_PARAM_NOT_ALLOWED on
            // "shares[0]" — the same root cause as the ugcPosts issue, just never
            // retested with the corrected syntax until now.
            const shareListValue = 'List(' + shareUrns.map(u => encodeURIComponent(u)).join(',') + ')';
            console.log(`Fetching batched stats for ${shareUrns.length} Share URN post(s) in a single request.`);
            const shareStatsRes = await li(
                `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}&shares=${shareListValue}`,
                token
            );
            if (shareStatsRes.ok) {
                const shareStatsJson = await shareStatsRes.json();
                const shareElements = shareStatsJson.elements || [];
                shareElements.forEach(el => {
                    if (el.share) statsMap[el.share] = el.totalShareStatistics || {};
                });
                console.log(`Batched Share URN stats returned data for ${shareElements.length} of ${shareUrns.length} requested post(s).`);
            } else {
                shareBatchFailed = true;
                const body = await shareStatsRes.text();
                console.warn(`Batched Share URN stats request failed: HTTP ${shareStatsRes.status} — ${body}. Affected posts will report statsUnavailable so the dashboard keeps their previous numbers instead of zeroing them out.`);
            }
        }

        // 3) Normalize each post using the batched stats lookup.
        //
        // IMPORTANT: if a post's batch request failed (e.g. 429 quota exhausted),
        // we do NOT send 0 for its stats fields — sending 0 would tell the
        // dashboard "this post genuinely has zero engagement," and the dashboard
        // would overwrite whatever good data it already saved from a previous
        // successful sync with zeros. Instead we send `null` and a `statsUnavailable`
        // flag, and the dashboard is coded to keep its existing numbers when it
        // sees that flag rather than blindly overwriting them.
        const normalized = rawPosts.map(post => {
            const postUrn = post.id;
            const isUgc = postUrn && postUrn.startsWith('urn:li:ugcPost:');
            const isShare = postUrn && postUrn.startsWith('urn:li:share:');
            const batchFailedForThisPost = (isUgc && ugcBatchFailed) || (isShare && shareBatchFailed);

            const ts = statsMap[postUrn] || null;
            const statsUnavailable = batchFailedForThisPost && !ts;

            const stats = ts || { impressionCount: 0, clickCount: 0, likeCount: 0, commentCount: 0, shareCount: 0 };

            return {
                externalId: postUrn,
                date: (post.createdAt ? new Date(post.createdAt).toISOString().slice(0, 10) : ''),
                topic: guessTopic(post),           // see note below
                format: guessFormat(post),         // see note below
                impressions: statsUnavailable ? null : stats.impressionCount,
                clicks: statsUnavailable ? null : stats.clickCount,
                reactions: statsUnavailable ? null : stats.likeCount,
                comments: statsUnavailable ? null : stats.commentCount,
                shares: statsUnavailable ? null : stats.shareCount,
                statsUnavailable: statsUnavailable,
                url: postUrn ? `https://www.linkedin.com/feed/update/${postUrn}` : ''
            };
        });

        res.json(normalized);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * LinkedIn's API doesn't know your internal content topics
 * (Mixing Systems, Storage Tanks, etc.) — that's your own taxonomy.
 * Two practical options:
 *   a) Tag it yourself: keep a small lookup table (postUrn -> topic)
 *      that you update when you publish, or
 *   b) Auto-guess from the post text with simple keyword matching,
 *      as a rough starting point (edit the keyword lists below).
 */
function guessTopic(post) {
    const text = ((post.commentary || '') + '').toLowerCase();
    const rules = [
        ['Mixing Systems', ['mixing', 'mixer', 'agitat']],
        ['Storage Tanks', ['tank', 'storage vessel']],
        ['Biotech/Pharma', ['biotech', 'pharma', 'bioreactor']],
        ['Food & Beverage', ['food', 'beverage', 'brewery', 'dairy']]
    ];
    for (const [topic, keywords] of rules) {
        if (keywords.some(k => text.includes(k))) return topic;
    }
    return 'Company News';
}

function guessFormat(post) {
    if (post.content && post.content.media) {
        const mediaType = post.content.media.mediaType || '';
        if (mediaType.includes('VIDEO')) return 'Video';
        if (mediaType.includes('DOCUMENT')) return 'Document/PDF';
        if (mediaType.includes('IMAGE')) return 'Single Image';
    }
    if (post.content && post.content.multiImage) return 'Carousel';
    if (post.content && post.content.poll) return 'Poll';
    return 'Text-only';
}

app.listen(PORT, () => {
    console.log(`LinkedIn proxy listening on port ${PORT}`);
    console.log(`>>> Running CODE_VERSION: ${CODE_VERSION} <<<`);
});
