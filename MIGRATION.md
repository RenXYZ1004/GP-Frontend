# Apps Script → Appwrite

This repo is the **Vercel frontend**. The backend is the **GP-Backend**
project, on Appwrite.

Apps Script was slow for structural reasons, not tuning ones: every request
paid a cold boot, and each read pulled a whole sheet into memory and scanned
it linearly.

---

## What changed

| Layer | Before | Now |
|---|---|---|
| Frontend | Vercel (static PWA) | **unchanged** |
| Data | Apps Script + Google Sheets | Appwrite tables, read and written directly from the browser |
| Auth | users sheet, hashes compared in the browser | Appwrite Auth; roles enforced by table permissions |
| Server code | one Apps Script router | **two** Appwrite functions |
| Parent email | Vercel `api/send-email.js` | `send-email` function |
| Photo storage | Vercel Blob | **unchanged** |
| Photo upload | Vercel `api/upload-photo.js` | **unchanged** |

There is no API layer of our own any more. `ApiService.js` talks to Appwrite,
and Appwrite's table permissions decide what each role may do — checked by the
server against team membership, not by the code in this repo.

Only two things run as functions, because only two cannot be trusted to a
browser: allocating a Pass ID on the public application form, and holding the
Gmail credentials.

### Files

| | |
|---|---|
| **Added** | `js/lib/appwrite.js` — vendored Web SDK v27 |
| | `js/services/appwrite.js` — the shared client |
| **Rewritten** | `js/services/ApiService.js`, `AuthService.js`, `EmailService.js` |
| **Removed** | `SheetsService.js`, `DataService.js`, and the whole `Code.gs` / PHP mail stack |

The SDK is vendored rather than loaded from a CDN, matching how jsQR and
face-api are already carried here: the app has no bundler and installs as an
offline PWA, and a CDN import would break both. It loads as a plain `<script>`
before `js/main.js` and exposes `window.Appwrite`.

---

## Before it runs

**`js/config.js`** needs one value: `APPWRITE_PROJECT_ID`. Endpoint, database
id and function ids are already correct.

**In GP-Backend**, per its README: create the project, `npm run setup`,
`npm run seed`, push the two functions, and set `ALLOWED_ORIGINS` on both to
this Vercel domain. Miss that last one and every request fails CORS — the API
is a different origin now, which it never was under Apps Script.

---

## Sign-in

Staff keep typing their bare username. `AuthService` maps a username without
an `@` onto `southville.edu.ph`; the backend's seed uses the same rule, so the
two must stay in step if that domain ever changes.

Passwords do not carry over — SHA-256 to Appwrite's own hashing, with no
plaintext in between. The seed prints one temporary password per account,
once.

The cached `pgp_session` payload now only decides what the UI draws. On load
the app revalidates with Appwrite, so someone demoted or deactivated loses
access on their next load. That check is deliberately not awaited: the UI
renders from cache immediately, and if the server cannot be reached at all the
session stands — a gate terminal that loses wifi has to keep scanning.

---

## Two bugs this surfaced

Both were live in the sheet-backed version.

**The gate scanner accepted any QR token.** The sheet had no `QRtoken` column,
so `mapStudentToSheet`'s `QRtoken` key was dropped on every write and
`student.qrToken` was always empty. That made the check in `AppController.js`
— `student.qrToken && token !== student.qrToken` — never fire: any token
scanned against a known Pass ID was accepted. There is a real `QRtoken` column
now, so the check has something to compare.

**Grade and section never persisted.** `mapStudentToSheet` wrote `Grade` and
`Section` as separate keys and `mapStudentFromSheet` read them back. Neither
column has ever existed — the sheet has one `GradeAndSection` — so both were
discarded on write and came back empty on read. Both mappers now use the
column that exists.

Of 110 existing records, 108 have a grade and only one has a section, so
expect sections to be blank until they are entered again.

---

## Rolling back

`git revert` on this change set. The Apps Script deployment and its sheet were
never written to, so the old backend still holds its data intact.
