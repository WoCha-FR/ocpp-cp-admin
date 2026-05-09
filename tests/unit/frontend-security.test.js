'use strict';

const fs = require('fs');
const path = require('path');

describe('Frontend XSS hardening', () => {
  const indexHtmlPath = path.join(__dirname, '../../public/index.html');
  const serverPath = path.join(__dirname, '../../src/server.js');

  it('does not use inline event handlers in templates', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    expect(html).not.toMatch(/\sonclick\s*=/i);
    expect(html).not.toMatch(/\sonchange\s*=/i);
    expect(html).not.toMatch(/\soninput\s*=/i);
    expect(html).not.toMatch(/\sonsubmit\s*=/i);
  });

  it('uses delegated data handlers for migrated events', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    expect(html).toMatch(/data-onclick=/);
    expect(html).toMatch(/bindDelegatedDataHandlers\(\)/);
  });

  it('does not allow script unsafe-inline in CSP', () => {
    const server = fs.readFileSync(serverPath, 'utf8');
    expect(server).toMatch(
      /scriptSrc:\s*\[[\s\S]*?"'self'"[\s\S]*?'https:\/\/cdn\.jsdelivr\.net'[\s\S]*?\(req,\s*res\)\s*=>\s*`'nonce-\$\{res\.locals\.cspNonce\}'`[\s\S]*?\]/
    );
    expect(server).not.toMatch(/scriptSrc:\s*\[[^\]]*'unsafe-inline'/);
    expect(server).not.toMatch(/scriptSrc:\s*\[[^\]]*'unsafe-eval'/);
    expect(server).not.toMatch(/scriptSrcAttr:\s*\[\s*"'unsafe-inline'"\s*]/);
  });

  it('injects nonce placeholder into served html template', () => {
    const server = fs.readFileSync(serverPath, 'utf8');
    expect(server).toMatch(/__CSP_NONCE__/);
    expect(server).toMatch(/replaceAll\('__CSP_NONCE__',\s*res\.locals\.cspNonce\)/);
  });

  it('does not use dynamic code execution in delegated handlers', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    expect(html).not.toMatch(/new Function\s*\(/);
    expect(html).not.toMatch(/\beval\s*\(/);
  });

  it('enforces password strength check on score in reset flow', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    expect(html).toMatch(/checkPasswordStrength\(newPwd\)\.score\s*<\s*4/);
    expect(html).not.toMatch(/checkPasswordStrength\(newPwd\)\s*<\s*4/);
  });

  it('adds rel noopener noreferrer to target blank legal links', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    expect(html).toMatch(/<a href="\/privacy"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    expect(html).toMatch(/<a href="\/terms"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it('does not dynamically load flatpickr locale scripts from CDN', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    expect(html).not.toMatch(/flatpickr@4\.6\.13\/dist\/l10n\//);
    expect(html).not.toMatch(/document\.createElement\('script'\)/);
  });

  it('restricts service worker openWindow to validated same-origin URL', () => {
    const swPath = path.join(__dirname, '../../public/sw.js');
    const sw = fs.readFileSync(swPath, 'utf8');
    expect(sw).toMatch(/new URL\(rawUrl,\s*self\.location\.origin\)/);
    expect(sw).toMatch(/parsed\.origin === self\.location\.origin/);
    expect(sw).toMatch(/clients\.openWindow\(safeUrl\)/);
    expect(sw).not.toMatch(/clients\.openWindow\(url\)/);
  });
});
