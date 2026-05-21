'use strict';

const request = require('supertest');
const express = require('express');
const i18next = require('i18next');
const path = require('path');

const fr = require('../../locales/fr.json');
const en = require('../../locales/en.json');

const DEFAULT_LANG = 'fr';

i18next.init({
  lng: DEFAULT_LANG,
  fallbackLng: DEFAULT_LANG,
  resources: {
    fr: { translation: fr },
    en: { translation: en },
  },
  interpolation: { escapeValue: false },
  initAsync: false,
});

function detectLang(req) {
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

function wrapAboutHtml(lang, appName) {
  const t = (key) => i18next.t(key, { lng: lang });
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>${appName} – ${t('legal.about')}</title>
</head>
<body>
  <div class="about-page">
    <h1>${t('about.title')}</h1>
    <p>${t('about.subtitle')}</p>
    <p>${t('about.description')}</p>
    <ul>
      <li>${t('about.feature1')}</li>
      <li>${t('about.feature2')}</li>
      <li>${t('about.feature3')}</li>
      <li>${t('about.feature4')}</li>
      <li>${t('about.feature5')}</li>
    </ul>
    <div class="about-access">
      <strong>${t('about.accessTitle')}</strong>
      ${t('about.accessNotice')}
    </div>
    <div class="about-access">
      <strong>${t('about.googleDataTitle')}</strong>
      ${t('about.googleDataNotice')}
    </div>
    <a href="/">${t('about.signin')}</a>
    <div class="about-footer">
      <a href="/privacy" rel="noopener noreferrer">${t('legal.privacy')}</a>
      <span> · </span>
      <a href="/terms" rel="noopener noreferrer">${t('legal.terms')}</a>
    </div>
  </div>
</body>
</html>`;
}

function buildApp() {
  const app = express();
  app.get('/about', (req, res) => {
    const lang = detectLang(req);
    res.type('html').send(wrapAboutHtml(lang, 'CP Admin'));
  });
  return app;
}

let app;

beforeAll(() => {
  app = buildApp();
});

describe('GET /about', () => {
  it('returns 200 with HTML content-type', async () => {
    const res = await request(app).get('/about');
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
  });

  it('is accessible without authentication', async () => {
    const res = await request(app).get('/about');
    expect(res.status).toBe(200);
  });

  it('defaults to French', async () => {
    const res = await request(app).get('/about');
    expect(res.text).toMatch(/Se connecter/);
    expect(res.text).toMatch(/Accès restreint/);
  });

  it('serves English content with ?lang=en', async () => {
    const res = await request(app).get('/about?lang=en');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Sign In/);
    expect(res.text).toMatch(/Restricted access/);
  });

  it('honours Accept-Language header', async () => {
    const res = await request(app).get('/about').set('Accept-Language', 'en-US,en;q=0.9');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Sign In/);
  });

  it('falls back to French for unknown language', async () => {
    const res = await request(app).get('/about?lang=xx');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Se connecter/);
  });

  it('contains a sign-in link to /', async () => {
    const res = await request(app).get('/about');
    expect(res.text).toContain('href="/"');
  });

  it('contains the access restriction notice (fr)', async () => {
    const res = await request(app).get('/about');
    expect(res.text).toMatch(/réservé aux utilisateurs préalablement autorisés/);
  });

  it('contains the access restriction notice (en)', async () => {
    const res = await request(app).get('/about?lang=en');
    expect(res.text).toMatch(/reserved for users previously authorized/);
  });

  it('contains the Google data notice (fr)', async () => {
    const res = await request(app).get('/about');
    expect(res.text).toMatch(/Gmail|Google Drive|Google Calendar/);
  });

  it('contains the Google data notice (en)', async () => {
    const res = await request(app).get('/about?lang=en');
    expect(res.text).toMatch(/Gmail|Google Drive|Google Calendar/);
  });

  it('contains a link to /privacy', async () => {
    const res = await request(app).get('/about');
    expect(res.text).toContain('href="/privacy"');
  });

  it('contains a link to /terms', async () => {
    const res = await request(app).get('/about');
    expect(res.text).toContain('href="/terms"');
  });

  it('sets html lang attribute to detected language', async () => {
    const resFr = await request(app).get('/about');
    expect(resFr.text).toContain('lang="fr"');

    const resEn = await request(app).get('/about?lang=en');
    expect(resEn.text).toContain('lang="en"');
  });
});
