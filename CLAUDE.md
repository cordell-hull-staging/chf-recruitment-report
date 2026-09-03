# Recruiting Report

Static web app (no build step) for host schools to document their J-1 teacher recruitment process. Runs entirely in the browser using ES modules and pdf-lib. Supports multiple teachers per report.

## Local Development

```bash
python3 -m http.server 8082
# Open http://localhost:8082
```

Must be served over HTTP — `file://` won't work due to ES module imports.

## Versioning

Version is defined in `config/version.js` as the single source of truth. It is displayed in the page footer and included in debug reports.

**When releasing changes**, update both:
1. `APP_VERSION` in `config/version.js`
2. The `?v=` query strings on `<link>` and `<script>` tags in `index.html`

## Key Files

- `index.html` — Main page, 5-step wizard (School, Teachers, Services, Sign, Review)
- `main.js` — Wizard logic, multi-teacher state, table/form view, validation, signature canvas, persistent storage
- `lib/pdf.js` — PDF generation with pdf-lib (summary table + per-teacher sections + signature)
- `config/org.js` — Organization branding, PDF styling constants
- `config/version.js` — App version constant
- `styles.css` — All styles including toggle switches, checkbox groups, teacher table, landing screen, and signature pad

## Data Persistence

All report data is saved to `localStorage` under key `chf-recruitment-data` — on every step transition, teacher save, and every 30 seconds via auto-save. On page load, if saved data exists, a landing screen offers "Continue" or "Start New Report" (with confirmation). Data persists across sessions and PDF downloads — only cleared when user explicitly starts a new report. Signature canvas data is stored as a data URL.

The landing screen also has an "Import from PDF" control, currently **hidden** via inline `display: none` on the label and its divider in `index.html`. The file input, its change handler and `importReportFromPDF()` are all intact — unhide those two elements to bring it back.

## Multi-Teacher Flow

Step 2 (Teachers) uses a table/form toggle pattern:
- **Table view** (default): lists all teachers with Edit/Delete buttons and an "Add Teacher" button
- **Form view**: replaces the table when adding/editing a teacher; includes teacher info, a repeatable list of interviews, the teaching sample question, recruitment/assessment narratives, 2 references, and English assessment
- Pre-populate: when adding teacher #2+, shared fields (citizenship country, reference venues) are copied from the previous teacher

### Interviews

A teacher holds an `interviews[]` array (`DEFAULT_INTERVIEW_ROWS` blank rows, "Add another interview" for more). Each row carries its own interviewer name and title, date, time of day, minutes and venue (`INTERVIEW_VENUE_OPTIONS`: in person / Zoom / telephone / WhatsApp / other), with a conditional place field for in-person and a free-text field for other. Rows are only validated once they contain data, so unused rows can stay blank.

### Teaching Sample

`teachingSampleProvided` is a required yes/no. "Yes" reveals the sample type checkboxes (video / lesson plan / classroom observation) and, for video or observation, a required duration. "No" reveals a required narrative explaining how the school evaluated the teacher's ability instead.

## Validation Rules

The report must document *how* recruitment happened — placeholder answers are rejected:

- Required free-text answers (how the teacher was recruited, how the candidate was evaluated, what each reference said) must be at least `MIN_NARRATIVE_CHARS` (25) characters.
- Answers matching `PLACEHOLDER_ANSWER_RE` ("N/A", "none", "TBD", "-", …) are rejected on every required field. Never offer "N/A" as a choice or mention it in labels or hints — the form simply does not accept it.
- Interviews must total at least `MIN_INTERVIEW_MINUTES` (60), which may be spread over several sessions. Every interview row that has any data must be complete (interviewer, date, minutes, venue).
- The teaching sample question must be answered, including the follow-up (duration, or the explanation of how the teacher was evaluated without one).
- Both prior employer references are mandatory and must include name, position title, email, date, time of day, length in minutes, place, communication venue, and a summary of what was said.
- Step 2 re-validates *every* saved teacher before advancing, so partially completed teachers persisted by auto-save cannot reach the PDF. Incomplete teachers are flagged in the teacher table.

`_collectTeacherIssues()` is the single source of truth for teacher validation and returns a map of error element id to message; both the teacher form and the step-2 guard use it.

## Data Migration

Reports saved by older versions (localStorage or imported PDFs) are upgraded by `_migrateTeacher()`, which parses legacy free-text durations such as `"1 hour 30 minutes"` into minutes via `_parseMinutes()` and backfills newly added fields. It also folds the old single interview (plus any `additionalInterviewers`) into the `interviews[]` array and moves `interviewCountry` to `citizenshipCountry`. Any change to the teacher shape must be handled here, or previously exported PDFs will fail to import.

## PDF Generation Notes

- Uses standard Helvetica font (WinAnsi encoding) — text passed to `drawText()` must not contain control characters.
- Summary table at top with teacher name, email, first interview date, number of interviews and total minutes.
- Per-teacher sections list each interview (date, time, minutes, venue, interviewer) with the total, then the teaching sample, references and English assessment.
- Shared sections (relocation, certification) and signature appear once at end.
- Signature is embedded as a PNG image from canvas `toDataURL()`.
