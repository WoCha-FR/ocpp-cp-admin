'use strict';

const fs = require('fs');
const path = require('path');

describe('Frontend filter reset on navigation', () => {
  let html;
  beforeAll(() => {
    html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  });

  // --- Signatures des fonctions render ---
  it('renderChargepoints accepte un paramètre keepState', () => {
    expect(html).toMatch(/async function renderChargepoints\s*\(\s*keepState\s*=\s*false\s*\)/);
  });
  it('renderIdTags accepte un second paramètre keepState', () => {
    expect(html).toMatch(/async function renderIdTags\s*\(\s*tab\s*,\s*keepState\s*=\s*false\s*\)/);
  });
  it('renderSiteUsers accepte un troisième paramètre keepState', () => {
    expect(html).toMatch(/async function renderSiteUsers\s*\(\s*siteId\s*,\s*siteName\s*,\s*keepState\s*=\s*false\s*\)/);
  });

  // --- Réinitialisation des filtres dans chaque render ---
  it('renderChargepoints réinitialise cpListFilters si !keepState', () => {
    expect(html).toMatch(/if\s*\(!keepState\)\s*cpListFilters\s*=/);
  });
  it('renderIdTags réinitialise idTagsFilters si !keepState', () => {
    expect(html).toMatch(/if\s*\(!keepState\)\s*\{[\s\S]{0,200}idTagsFilters\s*=/);
  });
  it('renderIdTags réinitialise idTagsEventsFilters si !keepState', () => {
    expect(html).toMatch(/if\s*\(!keepState\)\s*\{[\s\S]{0,200}idTagsEventsFilters\s*=/);
  });
  it('renderSiteUsers réinitialise siteUsersFilters si !keepState', () => {
    expect(html).toMatch(/if\s*\(!keepState\)\s*siteUsersFilters\s*=\s*\{\}/);
  });

  // --- Cache et helper WS ---
  it('cpListCache est déclaré', () => {
    expect(html).toMatch(/let cpListCache\s*=\s*\[\]/);
  });
  it('cpEventMatchesFilters est défini', () => {
    expect(html).toMatch(/function cpEventMatchesFilters\s*\(/);
  });

  // --- refreshCurrentPage appelle renderChargepoints(true) ---
  it('refreshCurrentPage utilise renderChargepoints(true) pour la page chargepoints', () => {
    expect(html).toMatch(/currentPage\s*===\s*['"]chargepoints['"]\s*\)[\s\S]{0,100}renderChargepoints\s*\(\s*true\s*\)/);
  });

  // --- switchIdTagsTab préserve les filtres ---
  it('switchIdTagsTab appelle renderIdTags avec keepState=true', () => {
    expect(html).toMatch(/function switchIdTagsTab[\s\S]{0,100}renderIdTags\s*\(\s*tab\s*,\s*true\s*\)/);
  });
});
