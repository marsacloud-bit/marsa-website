/* ==========================================================================
   مرسى | MARSA — runtime configuration TEMPLATE
   --------------------------------------------------------------------------
   Copy this file to assets/js/config.js and fill it for the environment you
   deploy. This file itself is never loaded by any page.

   Environments (see docs/online/ENVIRONMENTS_AR.md):
     demo        supabaseUrl + supabaseAnonKey EMPTY → localStorage only,
                 demo banner, no network requests besides Google Fonts.
     staging     the staging Supabase project (test data only).
     production  does not exist yet; needs owner approval first.

   config.js may contain ONLY public values. The anon / "publishable" key is
   public by design (RLS protects the data). NEVER put the service_role /
   "secret" key (sb_secret_…), the database password or a connection string
   here or anywhere in the frontend — assets/js/supa.js refuses to start if
   it detects a secret key.

   Load order on every page:
     config.js → i18n.js → main.js → supa.js → [assets/i18n/<page>.js] → <page>.js
   ========================================================================== */
window.MARSA_CONFIG = {
  // Project Settings → API → Project URL, e.g. 'https://<project-ref>.supabase.co'.
  // Empty string = demo mode.
  supabaseUrl: '',

  // Project Settings → API → "anon" / "publishable" key (sb_publishable_… or
  // the legacy anon JWT). Empty string = demo mode.
  supabaseAnonKey: '',

  // Slug of the tenant (organizations.slug) that the public forms
  // (request.html, contact.html, tracking.html) submit to.
  orgSlug: 'blue-sea',

  // Shown in the environment banner: 'staging' | 'production'.
  // Informational only; the server decides (organizations.environment).
  environment: 'staging',

  // Optional. Initial UI language when the visitor has not chosen one
  // (localStorage 'marsa_lang' wins): 'ar' (default, RTL) | 'en'.
  defaultLocale: 'ar',

  // Optional. Session cap in whole hours (the old system's 12-hour sessions): a session older than this is signed out on
  // this device and app pages go to login.html?expired=1. Absent / invalid → 12; 0 → no cap. Production: written by
  // scripts/build-release.sh from PROD_SESSION_MAX_HOURS (default 12).
  sessionMaxHours: 12,

  // Optional (legacy step 8). Platform switch of the e-mail code login on login.html: true shows «الدخول برمز يُرسل إلى
  // البريد» to staff. OFF (false) by default. Each organization must ALSO enable it (the org admin, «قواعد المتابعة»
  // #attention_rules, with a reason) and the Supabase project must send the 6-digit code (Auth → Email OTP expiry 600 s,
  // the «Magic Link» template shows {{ .Token }}). Runbook: docs/online/EMAIL_CODE_LOGIN_AR.md. Production: written by
  // scripts/build-release.sh (PROD_EMAIL_OTP_LOGIN=1 → true; default false).
  emailOtpLogin: false
};
