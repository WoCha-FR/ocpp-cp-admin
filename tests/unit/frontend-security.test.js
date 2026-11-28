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
      /scriptSrc:\s*\[[\s\S]*?"'self'"[\s\S]*?\(req,\s*res\)\s*=>\s*`'nonce-\$\{res\.locals\.cspNonce\}'`[\s\S]*?\]/
    );
    expect(server).not.toMatch(/scriptSrc[\s\S]*?cdn\.jsdelivr\.net/);
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

  it('adds rel noopener noreferrer to target blank about link', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    expect(html).toMatch(/<a href="\/about"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it('does not dynamically load flatpickr locale scripts from CDN', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    expect(html).not.toMatch(/flatpickr@4\.6\.13\/dist\/l10n\//);
    // Le chargement dynamique est autorisé uniquement depuis /vendor/ (self)
    expect(html).not.toMatch(/createElement\('script'\)[\s\S]{0,300}cdn\./);
    expect(html).not.toMatch(/createElement\('script'\)[\s\S]{0,300}jsdelivr\.net/);
    if (/document\.createElement\('script'\)/.test(html)) {
      expect(html).toMatch(/vendor\/flatpickr\/l10n\//);
    }
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

// ── Lot G : arguments texte des attributs data-on* et valeurs venant des bornes ──
describe('Frontend — arguments data-on* (jsArg) et valeurs venant des bornes', () => {
  const vm = require('vm');
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');

  // escapeAttr, jsArg et le mini-interpréteur runDataHandler, extraits tels quels de index.html
  const start = html.indexOf('function escapeAttr(');
  const end = html.indexOf('function bindDelegatedDataHandlers(');
  const code = html.slice(start, end);

  // Le navigateur décode les entités de l'attribut avant que getAttribute ne le renvoie
  const decodeAttr = (s) =>
    s
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');

  function sandbox() {
    const calls = [];
    const win = {
      mgrStopCharge: (...args) => calls.push(['mgrStopCharge', ...args]),
      showEditConfigModal: (...args) => calls.push(['showEditConfigModal', ...args]),
      deleteSite: (...args) => calls.push(['deleteSite', ...args]),
    };
    const ctx = {
      window: win,
      document: { getElementById: () => null },
      withBtn: (_el, fn) => fn(),
    };
    vm.createContext(ctx);
    vm.runInContext(`${code}; this.jsArg = jsArg; this.escapeAttr = escapeAttr; this.runDataHandler = runDataHandler;`, ctx);
    return { ctx, calls };
  }

  const PAYLOADS = [
    "TX-1'); deleteSite(1); ('",
    "a\\'); deleteSite(2); ('",
    'x\\',
    'O\'Brien "quoted" <b>',
    "'",
  ];

  it.each(PAYLOADS)('jsArg : %p reste un seul argument, aucun autre appel', (payload) => {
    const { ctx, calls } = sandbox();
    const attr = `withBtn(this, () => mgrStopCharge(1, ${ctx.jsArg(payload)}, ${ctx.jsArg('Borne')}, 2))`;
    // rien ne peut sortir de l'attribut HTML
    expect(ctx.jsArg(payload)).not.toMatch(/["<>]/);
    ctx.runDataHandler(decodeAttr(attr), {}, {});
    expect(calls).toEqual([['mgrStopCharge', 1, payload, 'Borne', 2]]);
  });

  it('témoin : l’ancien motif \'${escapeAttr(x)}\' permettait d’enchaîner un autre appel', () => {
    const { ctx, calls } = sandbox();
    const payload = "k'); deleteSite(9); ('";
    const attr = `showEditConfigModal(1, '${ctx.escapeAttr(payload)}', 'v')`;
    // L'instruction résiduelle « ('', 'v') » lève une erreur, mais APRÈS l'appel injecté
    expect(() => ctx.runDataHandler(decodeAttr(attr), {}, {})).toThrow();
    expect(calls.map((c) => c[0])).toContain('deleteSite');
  });

  it('plus aucun argument texte data-on* construit avec \'${escapeAttr(…)}\'', () => {
    expect(html).not.toMatch(/'\$\{escapeAttr\(/);
    expect(html).toMatch(/mgrStopCharge\(\$\{c\.chargepoint_id\}, \$\{jsArg\(c\.active_transaction_id\)\}/);
    expect(html).toMatch(/userStopCharge\(\$\{c\.chargepoint_id\}, \$\{jsArg\(c\.active_transaction_id\)\}/);
  });

  it('valeurs venant des bornes échappées dans le HTML', () => {
    // transactionId 2.0.1 (généré par la borne)
    expect(html).not.toMatch(/<span class="mono-id">\$\{tx\.transaction_id\}<\/span>/);
    expect(html).toMatch(/<span class="mono-id">\$\{escapeHtml\(tx\.transaction_id\)\}<\/span>/);
    // action OCPP des journaux, statut d'un profil de charge
    expect(html).toMatch(/\$\{escapeHtml\(m\.action \|\| '-'\)\}/);
    expect(html).not.toMatch(/'badge-yellow'\}">\$\{p\.status\}/);
    // résultats des cascades (raison = description d'un CALLERROR renvoyée par la borne)
    expect(html).not.toMatch(/\$\{e\.reason\}/);
    expect(html).not.toMatch(/<code>\$\{e\.key\}<\/code>/);
  });
});

// Relecture 1.1.0 : i18next est initialisé avec escapeValue: false, une valeur interpolée puis
// insérée en innerHTML doit être échappée (transaction_id 2.0.1 choisi par la borne, e-mail)
describe('Frontend XSS hardening — interpolations échappées (relecture 1.1.0)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  it('titre de la correction de badge et titre de la suppression de compte', () => {
    expect(html).toContain("t('corrections.correctBadgeTitle', { id: escapeHtml(");
    expect(html).toContain("t('users.uDeleteTitle', { name: escapeHtml(name) })");
  });
});
