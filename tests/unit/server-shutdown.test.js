'use strict';

const fs = require('fs');
const path = require('path');

// Un redémarrage du serveur (mise à jour d'image…) ne doit pas arrêter les charges en cours :
// seule la borne termine une transaction ; elle continue hors ligne et renvoie son arrêt réel.
describe('server.js — arrêt du serveur sans arrêt des charges', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
  const shutdown = src.slice(
    src.indexOf('async function gracefulShutdown'),
    src.indexOf("process.on('SIGINT'")
  );

  it('gracefulShutdown est bien trouvé', () => {
    expect(shutdown.length).toBeGreaterThan(100);
  });

  it("n'envoie aucune commande d'arrêt aux bornes", () => {
    expect(shutdown).not.toMatch(/remoteStopTransaction|RemoteStopTransaction\(|callClient/);
  });

  it('ne clôt pas les transactions en base à l’arrêt', () => {
    expect(shutdown).not.toMatch(/db\.resetStateOnStartup\(\)/);
    expect(shutdown).not.toMatch(/db\.stopTransaction\(/);
  });
});
