'use strict';

// Garde-fous sur les fichiers de déploiement Docker (relecture route 1.1.0) : valeurs par défaut
// sûres, clés privées jamais lisibles par tous, cohérence FTP / diagnostics.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const dockerDir = path.join(root, 'docker');
const composeFiles = fs.readdirSync(dockerDir).filter((f) => /^docker-compose.*\.yml$/.test(f));
const read = (f) => fs.readFileSync(path.join(dockerDir, f), 'utf8');

describe('Docker — Dockerfile et .dockerignore', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

  it('utilisateur app avec UID/GID fixes (10001), utilisés par les conteneurs de certificats', () => {
    expect(dockerfile).toMatch(/addgroup -S -g 10001 app && adduser -S -u 10001 -G app app/);
  });

  it('version de l’image = version du package (surchargeable au build)', () => {
    const { version } = require(path.join(root, 'package.json'));
    expect(dockerfile).toMatch(new RegExp(`ARG APP_VERSION=${version.replace(/\./g, '\\.')}`));
    expect(dockerfile).toMatch(/org\.opencontainers\.image\.version="\$\{APP_VERSION\}"/);
  });

  it('.dockerignore exclut les sauvegardes et les pages légales personnalisées', () => {
    const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
    expect(ignore).toMatch(/^config\/backups\/$/m);
    expect(ignore).toMatch(/^config\/legal\/\*\.md$/m);
    expect(ignore).toMatch(/^!config\/legal\/\*\.sample\.md$/m);
  });
});

describe('Docker — fichiers compose', () => {
  it('six fichiers compose', () => {
    expect(composeFiles).toHaveLength(6);
  });

  it.each(composeFiles)('%s : bornes inconnues mises en attente, jamais ajoutées automatiquement', (f) => {
    const s = read(f);
    expect(s).toMatch(/- CPADMIN_OCPP_AUTO_ADD=false/);
    expect(s).toMatch(/- CPADMIN_OCPP_PENDING_UNKNOWN=true/);
  });

  it.each(composeFiles)('%s : aucune clé privée rendue lisible par tous (chmod 644 sur un .key)', (f) => {
    const s = read(f);
    for (const line of s.split(/\r?\n/)) {
      if (/chmod\s+6[0-7][4-7]/.test(line)) expect(line).not.toMatch(/\.key\b/);
    }
    expect(s).not.toMatch(/install -m 644[^\n]*KEY/);
  });

  it.each(composeFiles)('%s : l’URL de diagnostics porte les identifiants du service FTP', (f) => {
    const s = read(f);
    const users = /^\s*- USERS=([^|\s]+)\|(\S+)/m.exec(s);
    const url = /CPADMIN_DIAGNOSTICS_URL=ftp:\/\/([^:@\s]+):([^@\s]+)@/.exec(s);
    expect(users).not.toBeNull();
    expect(url).not.toBeNull();
    expect(url[1]).toBe(users[1]);
    expect(url[2]).toBe(users[2]);
  });

  it.each(['docker-compose.yml', 'docker-compose.traefik-ext.yml'])(
    '%s (TLS terminé par Traefik) : TRUST_PROXY_PROTO activé',
    (f) => {
      expect(read(f)).toMatch(/- CPADMIN_OCPP_TRUST_PROXY_PROTO=true/);
    }
  );

  it.each(['docker-compose.tls.yml', 'docker-compose.tls-ext.yml'])(
    '%s : domaine des cert-dumpers en une seule variable, échec visible',
    (f) => {
      const s = read(f);
      expect(s.match(/- CERT_DOMAIN=/g)).toHaveLength(2);
      expect(s).not.toMatch(/\/dump\/certs\/cpadmin\.local\.crt/);
      expect(s.match(/ERREUR : certificat introuvable pour CERT_DOMAIN/g)).toHaveLength(2);
    }
  );

  it('https.yml : plus de ca.pem (chaîne intermédiaire jamais utilisée)', () => {
    expect(read('docker-compose.https.yml')).not.toMatch(/ca\.pem/);
  });

  it.each(composeFiles)('%s : images épinglées (sauf l’app et le FTP sans tag versionné)', (f) => {
    for (const m of read(f).matchAll(/image:\s*(\S+)/g)) {
      const image = m[1];
      if (image.startsWith('ghcr.io/wocha-fr/ocpp-cp-admin') || image === 'delfer/alpine-ftp-server') continue;
      expect(image).toMatch(/:[vV]?\d/);
    }
  });
});
