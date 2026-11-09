# BHI Attendance Sheet

The paper **Individual Student Attendance Sheet**, made digital. Next.js 15 + MongoDB.

- **Students** find their name, enter their own PIN, and type their **start time** when they arrive and their **end time** when class is over, then **sign by hand** on the screen. The server checks every typed time against its own clock before writing it.
- **Teachers** see their own courses, validate students' rows with their signature (by hand, or one tap with their signature on file), add comments and class days off, approve each month, open each student's **profile**, and download reports as **PDF or Word (DOCX)**.
- **Admins** add students (one at a time, or hundreds from a spreadsheet), manage PINs, staff and holidays, can change locked rows, and see everything.

## How a day works

| Who | What they do | What gets written on the sheet |
|---|---|---|
| Student, arriving | Taps **Enter start time**, types the time (or taps *Use the time now*), confirms | Start time (checked by the server) |
| Student, leaving | Taps **Enter end time**, types the time, confirms, taps the signature box and signs by hand | End time, hours, and their handwritten signature |
| Student, any time that day | **Add a note to today**: typed, handwritten, or both | A comment on the row |
| Teacher | Ticks rows (or "Select all ready"), taps **Sign by hand** or **Sign with my signature** | Staff signature (validates the row) |
| Teacher, end of day | **Mark not started as absent** | "Absent" on those rows |
| Teacher, end of month | **Approve with my signature** (+ comments) | "Approved by" block |

## Handwriting

Every handwriting field (student signature, staff signature, approval signature, handwritten approval comments, handwritten notes and comments) works the same way: tap the box and a large writing area covers the screen. Write with a finger, a stylus or the mouse; **Undo**, **Redo** and **Clear** are there until you tap **Use this signature** / **Done**, and what you wrote then shows in the box. Tapping the box again continues the same drawing. When a stylus is used, touches from the hand resting on the screen are ignored, and rotating the tablet keeps the drawing.

Each handwritten signature is stored as its own image and the row points at it. Images are never changed or deleted. The first signature a student writes is also kept "on file", so staff can add it to a day the student forgot to sign (this is recorded as added by staff).

## Seven-day editing window and historical records

- Teachers can change a row (edit, sign, add the student's signature, mark absent, comment) until **7 days after its class day** (`EDIT_WINDOW_DAYS`). A row for Monday the 1st is open through Monday the 8th and **locked** from the 9th. Students can sign one of their own open days that staff completed.
- After that, only an **admin** can change it, always with a reason, recorded in the row's history and the audit log as `admin.edit_locked_row`.
- **Signatures on locked rows are never swapped, by anyone**, so historical records keep their signatures (for example Mahek's). Staff can only update *their own* older signature on open rows, never someone else's.
- A month **approval** made by someone else can only be replaced by an admin; the replaced approval is kept in the audit log.

## Student profile

Clicking a student's name (Students, Today, Reports, Monthly sheets) opens their profile: status (Active, Not started, Completed, Inactive), attendance colour (**green** at 90%+, **orange** from 75%, **red** below; `ATTENDANCE_GOOD_PERCENT`, `ATTENDANCE_ATTENTION_PERCENT`), class, start and end dates, contact and social information (admins edit it), the overall summary and month-by-month history with links to each sheet.

Attendance % = days present ÷ (days present + absent + class days with nothing recorded). Holidays and excused days don't count against the student; today counts once something is recorded.

## PINs

Every active student has a **different PIN**, enforced by a unique database index on a keyed fingerprint of the PIN (the PIN itself is only stored as a bcrypt hash). Easy PINs (1234, 0000, ...) are refused. Only admins give new PINs. Students whose PIN was set before this was added show a note on their profile; give them a new PIN. `npm run setup` reports how many there are.

## Holidays, days off and comments

- **School holidays** (admins) with an optional note, shown on every sheet.
- **A day off for one class** (teachers for their own classes, admins for any): marks the day Holiday or Excused with a note for everyone in the class who hasn't started that day. Can be planned up to a year ahead, and removed again.
- **Comments** on any recorded day, typed and/or handwritten. They don't change times or signatures, so they don't undo a staff signature or a month approval. They are printed on a comments page after the sheet.

## Reports

- One student: any month, or the whole course, as PDF or Word.
- **Reports** page: a class (or all your classes) for a month, with attendance colour, present/absent/excused, hours and approval for each student. Download it as a PDF, or every student's sheet for the month in one PDF.

## Built to be hard to get wrong

- **Students type their own times, but the server decides what's believable**, using its own clock in the school's time zone (never the tablet's). A typed time is refused if it:
  - hasn't happened yet;
  - is older than `TIME_ENTRY_WINDOW_MINUTES` (default 15). Older times are a staff correction;
  - is an end time that isn't after the start, or is earlier than the moment the start was entered (the student was demonstrably still there);
  - makes a day shorter than `MIN_CLASS_MINUTES` (default 5) or longer than `MAX_CLASS_MINUTES` (default 720).
- **AM/PM mix-ups are caught** ("That's 1:05 am. Did you mean 1:05 pm?"), and every time is confirmed on a second screen before it's saved.
- **Nothing is hidden:** the exact moment each time was saved is kept next to it. Times typed 5+ minutes after the fact are flagged on the staff board and sheet so they're checked before signing. Staff corrections clear the flag.
- **Students can't change a saved time.** Only staff can, with a reason, as before.
- **Each row can only be started once and filled once**, enforced in the database, so double taps can't record twice.
- **Signed rows are locked.** Staff corrections need a reason, are kept in the row's history and the audit log, and remove the staff signature so the row is signed again.
- **A month approval goes out of date** if any row changes afterwards, and says so on screen and in the reports.
- **Signatures are stored once and referenced**, so replacing a signature never changes rows already signed.
- **Teachers only see their own courses**, in every page, action and download.
- **PIN guessing is limited** (5 tries per 15 minutes); staff logins are limited too; a password change signs out other devices.
- **The app refuses to start** without `MONGODB_URI` and a strong `SESSION_SECRET`. There are no default secrets.
- **Secrets are never committed:** `.env` and `.env.*` are ignored by git.

## Settings for typed times (optional)

| Setting | Default | Meaning |
|---|---|---|
| `TIME_ENTRY_WINDOW_MINUTES` | `15` | How far back a student may enter a time. `0` = only the current minute. |
| `MIN_CLASS_MINUTES` | `5` | Shortest day a student can record. |
| `MAX_CLASS_MINUTES` | `720` | Longest day a student can record (12 hours). |

## Setup

1. **MongoDB Atlas:** create a database user and copy the connection string, with a database name after the host (e.g. `.../bhi_attendance?retryWrites=true`).
2. **Settings:** copy `.env.example` to `.env.local` and fill in `MONGODB_URI` and `SESSION_SECRET` (the other settings are optional). On Vercel, add the same two under Settings → Environment Variables.
3. **Install and set up the database** (creates the indexes and the first admin):
   ```bash
   npm install
   npm run setup
   ```
4. **Run:** `npm run dev`, then open http://localhost:3000. Staff sign in at `/staff/login`.

## First steps for the office

1. **Students → Add students from a spreadsheet.** Upload a CSV with the columns `name, courseName, courseCode, courseDuration, caseManager, instructor, startDate, endDate, pin` (`pin` is optional). Download the list of PINs it shows and give each student theirs.
2. **Staff accounts:** add teachers and tick their courses.
3. **Holidays:** add the year's holidays.
4. **My account:** each staff member can put their signature on file for one-tap signing (or sign by hand each time).

**Upgrading an existing installation:** run `npm run setup` once after deploying (it adds the unique-PIN index; nothing else changes in the data). Existing rows, signatures and approvals are kept as they are.

## Checks

```bash
npm run typecheck   # TypeScript
npm test            # rules for typed times, hours, class days, the import, the 7-day lock, attendance %, PINs, handwriting images
MONGODB_URI=mongodb://127.0.0.1:27017/bhi_it npm run test:integration   # the real server actions against a throwaway MongoDB database (it is wiped)
npm run build       # production build
```

## Code map

| What | Where |
|---|---|
| Sheet rules (dates, times, hours, import) | `src/lib/sheet.ts` |
| Data model | `src/lib/types.ts` |
| Rules for typed times (shared by browser and server) | `checkTypedTime` in `src/lib/sheet.ts` |
| Student actions (PIN, Start, End, signature) | `src/actions/student.ts` |
| Typing a time (dialog) | `src/components/TimeEntry.tsx` |
| Staff actions (sign rows, edit a row, absent, approve) | `src/actions/staff.ts` |
| Admin actions (students, import, staff, holidays) | `src/actions/admin.ts` |
| Who can see whom | `src/lib/access.ts` |
| PDF and Word reports | `src/lib/report.ts`, `src/app/api/report/[studentId]/route.ts` |
| The paper sheet on screen | `src/components/PaperSheet.tsx` |
| Signature photo clean-up | `src/components/SignatureCapture.tsx` |
| Handwriting pad and field | `src/components/Ink.tsx` |
| 7-day lock, colour thresholds | `src/lib/policy.ts`, `editWindow` / `attendanceSummary` in `src/lib/sheet.ts` |
| Attendance summaries | `src/lib/summary.ts` |
| Unique PINs | `src/lib/pin.ts`, `src/lib/pins.ts` |
| Student profile | `src/app/staff/(app)/students/[id]/page.tsx` |
| Class monthly report | `src/lib/classreport.ts`, `src/app/staff/(app)/reports/page.tsx`, `src/app/api/reports/class/route.ts` |
