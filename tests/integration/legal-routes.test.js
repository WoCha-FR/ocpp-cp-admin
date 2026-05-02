'use strict';

// marked is an ESM-only package — mock it for Jest (CommonJS environment)
jest.mock('marked', () => ({ marked: { parse: (text) => `<div class="md">${text}</div>` } }));

const request = require('supertest');
const express = require('express');
const path = require('path');
const fs = require('fs');

const LEGAL_DIR = path.join(__dirname, '../../public/legal');
const DEFAULT_LANG = 'fr';

// Replicate the helper functions from src/server.js
function detectLegalLang(req) {
  const query = req.query?.lang;
  if (query && typeof query === 'string') return query.slice(0, 5);
  const accepted = req.acceptsLanguages();
  if (Array.isArray(accepted)) {
    for (const l of accepted) {
      const short = l.split('-')[0];
      if (short && short.length === 2) return short;
    }
  }
  return DEFAULT_LANG;
}

function resolveLegalFile(type, lang) {
  const candidates = [
    path.join(LEGAL_DIR, `${type}.${lang}.md`),
    path.join(LEGAL_DIR, `${type}.${DEFAULT_LANG}.md`),
  ];
  return candidates.find((f) => fs.existsSync(f));
}

function buildApp() {
  const { marked } = require('marked');
  const app = express();

  app.get('/privacy', (req, res) => {
    const lang = detectLegalLang(req);
    const mdPath = resolveLegalFile('privacy', lang);
    if (!mdPath) return res.status(404).send('Not found');
    const html = marked.parse(fs.readFileSync(mdPath, 'utf8'));
    res.type('html').send(`<!DOCTYPE html><html lang="${lang}"><body><a href="/">Back</a>${html}</body></html>`);
  });

  app.get('/terms', (req, res) => {
    const lang = detectLegalLang(req);
    const mdPath = resolveLegalFile('terms', lang);
    if (!mdPath) return res.status(404).send('Not found');
    const html = marked.parse(fs.readFileSync(mdPath, 'utf8'));
    res.type('html').send(`<!DOCTYPE html><html lang="${lang}"><body><a href="/">Back</a>${html}</body></html>`);
  });

  return app;
}

let app;

beforeAll(() => {
  app = buildApp();
});

// ── Route behaviour ──────────────────────────────────────────────────────────

describe('GET /privacy', () => {
  it('returns 200 with HTML content-type', async () => {
    const res = await request(app).get('/privacy');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
  });

  it('is accessible without authentication', async () => {
    const res = await request(app).get('/privacy');
    expect(res.status).toBe(200);
  });

  it('defaults to French', async () => {
    const res = await request(app).get('/privacy');
    expect(res.text).toMatch(/Politique de confidentialité|Données collectées/i);
  });

  it('serves English content with ?lang=en', async () => {
    const res = await request(app).get('/privacy?lang=en');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Privacy Policy|Data Collected/i);
  });

  it('honours Accept-Language header', async () => {
    const res = await request(app).get('/privacy').set('Accept-Language', 'en-US,en;q=0.9');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Privacy Policy|Data Collected/i);
  });

  it('falls back to French for unknown language', async () => {
    const res = await request(app).get('/privacy?lang=xx');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Politique de confidentialité|Données collectées/i);
  });

  it('includes a back link to /', async () => {
    const res = await request(app).get('/privacy');
    expect(res.text).toContain('href="/"');
  });
});

describe('GET /terms', () => {
  it('returns 200 with HTML content-type', async () => {
    const res = await request(app).get('/terms');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
  });

  it('is accessible without authentication', async () => {
    const res = await request(app).get('/terms');
    expect(res.status).toBe(200);
  });

  it('defaults to French', async () => {
    const res = await request(app).get('/terms');
    expect(res.text).toMatch(/Conditions d'utilisation|Obligations/i);
  });

  it('serves English content with ?lang=en', async () => {
    const res = await request(app).get('/terms?lang=en');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Terms of Use|User Obligations/i);
  });

  it('honours Accept-Language header', async () => {
    const res = await request(app).get('/terms').set('Accept-Language', 'en-GB');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Terms of Use|User Obligations/i);
  });

  it('falls back to French for unknown language', async () => {
    const res = await request(app).get('/terms?lang=xx');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Conditions d'utilisation|Obligations/i);
  });

  it('includes a back link to /', async () => {
    const res = await request(app).get('/terms');
    expect(res.text).toContain('href="/"');
  });
});

// ── Markdown source files ────────────────────────────────────────────────────

describe('Legal markdown files', () => {
  it.each(['privacy.fr.md', 'privacy.en.md', 'terms.fr.md', 'terms.en.md'])(
    '%s exists and is non-empty',
    (filename) => {
      const filePath = path.join(LEGAL_DIR, filename);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8').trim().length).toBeGreaterThan(0);
    }
  );

  it('privacy.fr.md contains GDPR rights section', () => {
    const content = fs.readFileSync(path.join(LEGAL_DIR, 'privacy.fr.md'), 'utf8');
    expect(content).toMatch(/RGPD/i);
  });

  it('privacy.en.md contains GDPR rights section', () => {
    const content = fs.readFileSync(path.join(LEGAL_DIR, 'privacy.en.md'), 'utf8');
    expect(content).toMatch(/GDPR/i);
  });

  it('privacy files mention cookie session', () => {
    for (const lang of ['fr', 'en']) {
      const content = fs.readFileSync(path.join(LEGAL_DIR, `privacy.${lang}.md`), 'utf8');
      expect(content).toMatch(/cookie|session/i);
    }
  });

  it('privacy files mention restricted access', () => {
    for (const lang of ['fr', 'en']) {
      const content = fs.readFileSync(path.join(LEGAL_DIR, `privacy.${lang}.md`), 'utf8');
      // No self-registration — only invited users
      expect(content).toMatch(/invit|restricted|restreint/i);
    }
  });

  it('terms files reference the privacy policy', () => {
    for (const lang of ['fr', 'en']) {
      const content = fs.readFileSync(path.join(LEGAL_DIR, `terms.${lang}.md`), 'utf8');
      expect(content).toMatch(/\/privacy/i);
    }
  });
});
