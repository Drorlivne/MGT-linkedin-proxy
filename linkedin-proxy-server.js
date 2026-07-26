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

// IMPORTANT: Render (and most hosting platforms) sit behind a reverse proxy
// that terminates HTTPS and forwards requests to your app as plain HTTP.
// Without this line, req.protocol reports "http" even though the real
// request was "https" — which silently breaks the redirect_uri LinkedIn
// checks against, causing "redirect_uri does not match the registered value"
// even when you copied the URL correctly.
app.set('trust proxy', 1);

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

app.get('/', (req, res) => {
    res.send('LinkedIn proxy is running. Visit /auth/debug to see your exact redirect URI, /auth/login to set up, then use /api/linkedin-posts.');
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

        // 1) List recent posts authored by the organization.
        const postsRes = await li(
            `/posts?author=${encodeURIComponent(orgUrn)}&q=author&count=25&sortBy=LAST_MODIFIED`,
            token
        );
        if (!postsRes.ok) throw new Error(`Posts fetch failed (${postsRes.status}): ${await postsRes.text()}`);
        const postsData = await postsRes.json();
        const rawPosts = postsData.elements || [];

        // 2) For each post, fetch its statistics and normalize.
        const normalized = [];
        for (const post of rawPosts) {
            const postUrn = post.id;
            console.log(`Fetching stats for post URN: ${postUrn}`);
            let stats = { impressionCount: 0, clickCount: 0, likeCount: 0, commentCount: 0, shareCount: 0 };

            try {
                // FIX: LinkedIn's current versioned REST API rejects the older "shares[0]"
                // parameter name with QUERY_PARAM_NOT_ALLOWED (confirmed from live logs).
                // The current correct parameter is "ugcPosts[0]", and per LinkedIn's docs
                // it specifically expects a UGC Post URN (urn:li:ugcPost:...), not a Share
                // URN (urn:li:share:...). If postUrn is in the share format, this call may
                // still fail — that'll show up clearly in the logs below as a different,
                // more specific error than QUERY_PARAM_NOT_ALLOWED.
                if (postUrn && postUrn.startsWith('urn:li:share:')) {
                    console.warn(`Post ${postUrn} is a Share URN, not a UGC Post URN — organizationalEntityShareStatistics may reject it. If stats fail below, this URN format is likely why.`);
                }
                const statsRes = await li(
                    `/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}&ugcPosts[0]=${encodeURIComponent(postUrn)}`,
                    token
                );
                if (statsRes.ok) {
                    const statsJson = await statsRes.json();
                    const el = (statsJson.elements && statsJson.elements[0]) || null;
                    if (!el) {
                        // LinkedIn's own docs: "Shares with no actions or impressions are not
                        // included in the list of elements... can be assumed to have counts of 0."
                        // Most likely cause now that the parameter name is fixed: the post is
                        // genuinely brand new and LinkedIn hasn't finished indexing its stats yet.
                        console.warn(`No stats element returned for post ${postUrn} — likely not yet indexed by LinkedIn (recently published). Raw response:`, JSON.stringify(statsJson));
                    }
                    const ts = (el && el.totalShareStatistics) || {};
                    stats = {
                        impressionCount: ts.impressionCount || 0,
                        clickCount: ts.clickCount || 0,
                        likeCount: ts.likeCount || 0,
                        commentCount: ts.commentCount || 0,
                        shareCount: ts.shareCount || 0
                    };
                } else {
                    console.warn(`Stats request failed for ${postUrn}: HTTP ${statsRes.status} — ${await statsRes.text()}`);
                }
            } catch (e) {
                console.warn('Stats fetch failed for', postUrn, e.message);
            }

            normalized.push({
                externalId: postUrn,
                date: (post.createdAt ? new Date(post.createdAt).toISOString().slice(0, 10) : ''),
                topic: guessTopic(post),           // see note below
                format: guessFormat(post),         // see note below
                impressions: stats.impressionCount,
                clicks: stats.clickCount,
                reactions: stats.likeCount,
                comments: stats.commentCount,
                shares: stats.shareCount,
                url: postUrn ? `https://www.linkedin.com/feed/update/${postUrn}` : ''
            });
        }

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
});
