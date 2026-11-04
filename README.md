# FOR YOU — Aslin's reading library

A private, mobile-first PWA with an Express/TypeScript API, MySQL persistence and Capacitor-ready web client. The app shows catalog records only when the source adapter returns a readable full-text format; it links to source-hosted files rather than mirroring books. Search is currently integrated with Project Gutenberg via Gutendex and Wikisource language wikis (English, Tamil, Hindi, Bengali and Malayalam).

## Current scope and rights notes

- **Project Gutenberg / Gutendex**: only records where Gutendex's `copyright` flag is `false` and a readable format exists. The app uses the permanent book landing page and sends the reader to Project Gutenberg; it does not deep-link to its hosted files. Confirm the edition's country restrictions at its source.
- **Wikisource**: search is available on English, Tamil, Hindi, Bengali and Malayalam wikis. These wikis contain both public-domain works and CC BY-SA contributions, and rights can vary by page. The app presents a rights notice and always links to the original page. Treat each page's displayed license as authoritative.
- Internet Archive, Open Library, Standard Ebooks, OpenStax/LibreTexts, DOAB/OAPEN, HathiTrust, LOC, Europeana, DPLA, Google Books, Project Madurai, Tamil Virtual Academy, StoryWeaver, African Storybook and Global Digital Library are not yet integrated. Each needs adapter-specific current terms, access-level filtering and verification before it can be included. There is no blanket “all free books” catalog.
- Search adapter failures are isolated; results are deduplicated on normalized title/author/language. Search currently provides basic language filtering and first-page discovery; advanced subjects/year/format filters and robust pagination are not yet surfaced in the UI.
- HTML and PDF sources render through the browser's embedded reader. EPUB uses epub.js; plain text is fetched into the reader. Reading position persistence is basic (EPUB CFI or source URL), and source-hosted embeds may block framing. In that case use “Open original.” Translation runs only through a configured LibreTranslate server. Browser speech synthesis is used for text currently loaded in the reader; Tamil voice availability depends on the device.
- Account data is stored in MySQL. The included Express default session store is suitable only for local development; configure a persistent session store (for example, connect-mysql2) before production. Set secure cookies, HTTPS, and a specific CORS origin in deployment.

## Requirements

- Node.js 20+
- MySQL 8.0.16+ (or compatible MySQL server with enforced CHECK constraints), with permission to create tables and indexes
- Android Studio and Android SDK only if producing APK

## Install and configure

```sh
cp .env.example .env
npm install
npm run setup:translation
```

Fill in `.env`:

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME=ajiesbooks`; use the same values in `DATABASE_URL` (`mysql://USER:PASSWORD@HOST:PORT/ajiesbooks`). URL-encode special characters in the URL password.
- `SESSION_SECRET`: generate with `openssl rand -base64 48`.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD`; set any `MEMBER1..6_EMAIL` / `MEMBER1..6_PASSWORD` pairs desired (leave a pair empty to skip it). Passwords should be unique and strong.
- Translation works locally without an API URL or key after running `npm run setup:translation`. The first translation downloads the 2.3 GB NLLB model into `apps/api/data/translation-model`; later requests run on this computer and use its Apple GPU when available, otherwise CPU. `LIBRETRANSLATE_URL` and optional `LIBRETRANSLATE_API_KEY` can override the local model with a hosted LibreTranslate service. The bundled NLLB model is licensed CC-BY-NC-4.0 and is intended for research and non-commercial use; use a different model/provider for commercial deployments.
- `GOOGLE_BOOKS_API_KEY` is reserved for a future adapter and currently unused.
- `CORS_ORIGIN`, `COOKIE_SECURE`, `WEB_ORIGIN`, `VITE_API_URL`, and `PORT` for hosting. The Vite config reads this repo-root `.env`; set `VITE_API_URL` to the reachable API base plus `/api`.

Create the database and a restricted app user (use a separate root/admin MySQL session):

```sql
CREATE DATABASE ajiesbooks CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER 'books_app'@'%' IDENTIFIED BY 'replace-with-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES ON ajiesbooks.* TO 'books_app'@'%';
FLUSH PRIVILEGES;
```

Then run:

```sh
npm run db:migrate
npm run db:seed
npm run dev
```

Web: `http://localhost:5173`; API: `http://localhost:4000/api/health`. Admin/member seed accounts are taken only from `.env`. There is one admin plus up to six members (seven accounts total); the admin can add, disable, enable, and reset member passwords in Profile. Public self-registration is absent.

## MySQL and data

Prisma schema is `apps/api/prisma/schema.prisma`. Migrations are under `apps/api/prisma/migrations`. The database enforces seven unique account slots with a MySQL `CHECK (accountSlot BETWEEN 1 AND 7)` plus a unique index; application code also assigns only an unused slot. That makes an eighth row impossible even if a client bypasses the API. Book metadata is upserted when opened from search, and per-user favorites, shelf, progress, bookmarks and settings are held in MySQL.

## Android APK

The Capacitor Android project is included at `apps/web/android`. A debug APK still needs a working JDK (the machine used for this build has no Java runtime) and Android Studio/Android SDK. Install those first, then from the repository root:

```sh
npm install
npm run build
cd apps/web
npx cap add android
npx cap sync android
cd android
./gradlew assembleDebug
```

The debug APK is at `apps/web/android/app/build/outputs/apk/debug/app-debug.apk`. For a release build, create a signing keystore and configure signing in the Android app's Gradle config; then run `./gradlew assembleRelease`. Do not commit the keystore or passwords. Install the Capacitor CLI/platform package before the commands: `npm --workspace apps/web install @capacitor/core @capacitor/cli @capacitor/android`.

Capacitor config uses `VITE_API_URL` at web build time. Set it to the public HTTPS endpoint, for example `https://your-api.example.com/api`, before `npm run build` and `cap sync`. The app on a physical phone cannot reach the development machine through `localhost`.

## Hosting

### Vercel web + Render API

This repository is configured to deploy the Vite frontend as a static Vercel project and the Express API as a Render web service. In Vercel, import the repository with the **repository root** as the Root Directory; `vercel.json` builds `apps/web` and publishes `apps/web/dist`. In Render, create a Blueprint from `render.yaml`. Create a managed MySQL database separately and enter its connection string as `DATABASE_URL` in the Render API service. Use a strong `ADMIN_PASSWORD` and set `CORS_ORIGIN` to the final Vercel site origin (for example `https://your-site.vercel.app`, without a trailing slash).

After Render creates the API, set `VITE_API_URL` in Vercel to `https://<your-api-host>/api`, then redeploy the Vercel site so the address is embedded in the frontend build. Run the API's Prisma migrations before using the app (`cd apps/api && npm run db:migrate` in a one-off shell with the production `DATABASE_URL`). Set `WEB_ORIGIN` to the Vercel origin if using workflows that read it. Production translation needs a hosted LibreTranslate-compatible service; the local 2.3 GB model is not installed in Render. The macOS native voice endpoint is unavailable on Linux hosting.

Deploy `apps/api` with Node 20 and `npm run build` / `npm start`, and provide a reachable managed MySQL database named `ajiesbooks`. Set all DB, session, cookie, CORS and seed environment variables in the host. Run Prisma migrations as a release step (`npm run db:migrate`). Use HTTPS, a durable session store, backups, restricted network access and secrets manager. Deploy the static `apps/web/dist` directory to a static host, set its `VITE_API_URL` to the API URL, build with that value, and allow the web origin in `CORS_ORIGIN`. Never configure phone builds to use localhost.

Share APK through a private Google Drive link, GitHub Release, or Firebase App Distribution. Ensure that only the intended five members receive credentials and the APK link. Installing an APK from outside Play Store may require allowing installs from that source.

## Sources and policy references

- Gutendex API: https://gutendex.com/ and https://github.com/garethbjohnson/gutendex
- Project Gutenberg terms/rights: https://www.gutenberg.org/policy/terms_of_use.html
- Wikimedia API usage and reuse policies: https://www.mediawiki.org/wiki/Wikimedia_APIs/Usage_guidelines and https://www.mediawiki.org/wiki/Wikimedia_APIs/Reusing_free_content
- Individual Wikisource page license footer is required for specific attribution and rights determination.

The application is not legal advice. Copyright status can differ by jurisdiction; check the source and local rules before sharing or downloading.

The API requests identify the app with `ADMIN_EMAIL` as the contact in source User-Agent headers. Set it to a monitored contact address before using the adapters. Project Gutenberg’s terms require linking to each book landing page, prohibit large-scale deep links to individual hosted files, and warn that rights can differ outside the US; this app therefore opens Gutenberg books at their official landing pages. See [Project Gutenberg terms](https://www.gutenberg.org/policy/terms_of_use.html) and [Gutendex API documentation](https://github.com/garethbjohnson/gutendex). Wikimedia requires a descriptive User-Agent and content-specific attribution/licensing; see [Wikimedia API policy](https://www.mediawiki.org/wiki/Wikimedia_APIs/Access_policy) and [MediaWiki API policies](https://www.mediawiki.org/wiki/API:REST_API/Policies).
