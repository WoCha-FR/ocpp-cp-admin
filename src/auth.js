const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const db = require('./database');
const { getConfig } = require('./config');
const logger = require('./logger').scope('AUTH');

const config = getConfig();

// ── Stratégie locale (useremail + password) ──
passport.use(new LocalStrategy(
  { usernameField: 'useremail', passwordField: 'password' },
  (useremail, password, done) => {
    try {
      const user = db.getUserByEmail(useremail);
      if (!user) {
        return done(null, false, { message: 'ERR_UNKNOWN_USER' });
      }
      if (!bcrypt.compareSync(password, user.password)) {
        return done(null, false, { message: 'ERR_WRONG_PASSWORD' });
      }
      db.updateLastLogin(user.id);
      return done(null, {
        id: user.id,
        useremail: user.useremail,
        shortname: user.shortname,
        role: user.role,
        sites: db.getUserSites(user.id),
      });
    } catch (err) {
      return done(err);
    }
  }
));

// ── Stratégie Google OAuth 2.0 ──
if (config.auth?.google?.enabled) {
  const { client_id, client_secret } = config.auth.google;
  if (!client_id || !client_secret) {
    logger.warn('Google OAuth activé mais client_id ou client_secret manquant — désactivation automatique');
    config.auth.google.enabled = false;
  } else {
  const publicUrl = (config.webui.publicUrl || `http://localhost:${config.webui.httpPort}`).replace(/\/+$/, '');
  passport.use(new GoogleStrategy(
    {
      clientID: config.auth.google.client_id,
      clientSecret: config.auth.google.client_secret,
      callbackURL: `${publicUrl}/api/auth/google/callback`,
      state: true, // Permet de stocker l'état de la session pendant le processus d'authentification
    }, (accessToken, refreshToken, profile, done) => {
    try {
      // Vérifier si un utilisateur existe déjà avec ce Google ID
      const gguser = db.getUserByGoogleId(profile.id);
      if (gguser) {
        db.updateLastLogin(gguser.id);
        return done(null, {
          id: gguser.id,
          useremail: gguser.useremail,
          shortname: gguser.shortname,
          role: gguser.role,
          sites: db.getUserSites(gguser.id),
        });
      }
      // Aucun utilisateur avec ce Google ID, vérifier s'il existe un utilisateur avec le même email
      const email = profile.emails?.[0]?.value;
      if (!email) {
        return done(null, false, { message: 'ERR_GOOGLE_NO_EMAIL' });
      }
      const user = db.getUserByEmail(email);
      if (!user) {
        // Aucun utilisateur avec ce Google ID ni ce mail: Renvoie utilisateur inconnu.
        return done(null, false, { message: 'ERR_UNKNOWN_USER' });
      }
      // Un utilisateur existe avec ce mail, associer le compte Google à cet utilisateur
      db.updateUserGoogleProfile(user.id, profile);
      db.updateLastLogin(user.id);
      return done(null, {
        id: user.id,
        useremail: user.useremail,
        shortname: user.shortname,
        role: user.role,
        sites: db.getUserSites(user.id),
      });
    } catch (err) {
      return done(err);
    }
  }));
  }
}

// ── Sérialisation : stocker uniquement l'id en session ──
passport.serializeUser((user, done) => {
  done(null, user.id);
});

// ── Désérialisation : reconstruire l'objet user depuis la DB ──
passport.deserializeUser((id, done) => {
  try {
    const user = db.getUserById(id);
    if (!user) return done(null, false);
    done(null, {
      id: user.id,
      useremail: user.useremail,
      shortname: user.shortname,
      role: user.role,
      langue: user.langue,
      sites: user.sites || [],
    });
  } catch (err) {
    done(err);
  }
});

module.exports = passport;
