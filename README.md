# BHI Attendance Sheet

The paper **Individual Student Attendance Sheet**, made digital. Next.js 15 + MongoDB.

- **Students** find their name, enter their own PIN, and type their **start time** when they arrive and their **end time** when class is over, then **sign by hand** on the screen. The server checks every typed time against its own clock before writing it.
- Students can also **fill in an earlier class day they forgot** (inside the 7-day window): start and end time, signature, and an optional note. The row is marked *filled in later* for the teacher.
- **Teachers** sign in on their own page (`/teacher/login`) and see only the courses assigned to them: their enrolled students, each student's attendance sheet, and what is left to review. They **sign the staff signature on every row** (from **Today** for the whole class at once, or on each student's sheet; by hand, or one tap with their signature on file), **add comments**, and download reports as **PDF or Word (DOCX)**. Teachers **never change a student's own entries** (times, status, the student's signature): if something is wrong they comment and an admin corrects it.
- **Admins** (formerly "staff", now at `/admin`, for example Mahek) **sign the "Approved by" section at the bottom of each month** with their name, position, signature and comments. They also add students (one at a time, or hundreds from a spreadsheet), manage PINs, teacher and admin accounts and holidays, correct rows (including locked ones), mark absences and class days off, open each student's **profile**, and see everything.

## How a day works

| Who | What they do | What gets written on the sheet |
|---|---|---|
| Student, arriving | Taps **Enter start time**, types the time (or taps *Use the time now*), confirms | Start time (checked by the server) |
| Student, leaving | Taps **Enter end time**, types the time, confirms, taps the signature box and signs by hand | End time, hours, and their handwritten signature |
| Student, any time that day | **Add a note to today**: typed, handwritten, or both | A comment on the row |
| Student, a later day | **Fill in this day** on a past class day with nothing recorded: types the times, signs, optionally says why | Times, hours, signature, flagged *filled in later* |
| Teacher | On **Today** (the whole class) or a student's sheet, ticks rows (or "Select all ready"), taps **Sign by hand** or **Sign with my signature** | Staff signature (validates the row) |
| Teacher | **+ Comment** on a row | A comment (times and signatures unchanged) |
| Admin, end of month | **Approve with my signature**: staff name, position, comments | "Approved by" block at the bottom |
| Admin, end of day | **Mark not started as absent** | "Absent" on those rows |

## Handwriting

Every handwriting field (student signature, staff signature, approval signature, handwritten approval comments, handwritten notes and comments) works the same way: tap the box and a large writing area covers the screen. Write with a finger, a stylus or the mouse; **Undo**, **Redo** and **Clear** are there until you tap **Use this signature** / **Done**, and what you wrote then shows in the box. Tapping the box again continues the same drawing. When a stylus is used, touches from the hand resting on the screen are ignored, and rotating the tablet keeps the drawing.

Each handwritten signature is stored as its own image and the row points at it. Images are never changed or deleted. The first signature a student writes is also kept "on file", so staff can add it to a day the student forgot to sign (this is recorded as added by staff).

## Seven-day editing window and historical records

- Teachers can comment on a row until **7 days after its class day** (`EDIT_WINDOW_DAYS`). A row for Monday the 1st is open through Monday the 8th and **locked** from the 9th. Students can sign one of their own open days that staff completed, and fill in an open day they forgot.
- Teachers are the only ones who sign rows, so they can sign a row that has **no** staff signature yet at any time. A signature already on a row is never replaced once the row is locked. Month approvals (admins) have no time limit.
- After that, only an **admin** can change it, always with a reason, recorded in the row's history and the audit log as `admin.edit_locked_row`.
- **Signatures on locked rows are never swapped, by anyone**, so historical records keep their signatures (for example Mahek's). Staff can only update *their own* older signature on open rows, never someone else's.
- A month **approval** made by someone else can only be replaced by an admin; the replaced approval is kept in the audit log.

## Student profile

Clicking a student's name (Students, Today, Reports, Monthly sheets) opens their profile: status (Active, Not started, Completed, Inactive), attendance colour (**green** at 90%+, **orange** from 75%, **red** below; `ATTENDANCE_GOOD_PERCENT`, `ATTENDANCE_ATTENTION_PERCENT`), class, start and end dates, contact and social information (admins edit it), the overall summary and month-by-month history with links to each sheet.

Attendance % = days present ÷ (days present + absent + class days with nothing recorded). Holidays and excused days don't count against the student; today counts once something is recorded.

## Teachers and admins

| | Teacher (`/teacher`) | Admin (`/admin`) |
|---|---|---|
| Sign in | `/teacher/login` (teacher accounts only) | `/admin/login` (admin accounts only) |
| Sees | Only the courses ticked for them | Every student |
| Staff signature on each row | **Yes** (any unsigned past row) | No |
| Comments on a row | Yes, while the row is open (7 days) | Yes, any time |
| "Approved by" at the bottom of the month (name, position, signature, comments) | No | **Yes**; approving again replaces the earlier approval, which is kept in the audit log |
| Change a student's times, status or signature; mark absent; class day off | **No** | Yes, with a reason that is recorded |
| Students, PINs, holidays, accounts, roles | No | Yes |

The name on an approval starts as the account's name and can be adjusted (for example to add credentials); the account that approved is always recorded on the approval and in the audit log. Old `/staff` links redirect to `/admin`; a teacher who opens an admin page is sent to the teacher portal. On **Teachers & admins**, an admin can switch any other account between teacher and admin (**Change role**); for example, if Mahek's account was created as a teacher, make it an admin.

## Handwritten signatures only

Every signature is written by hand on the screen in the handwriting canvas (finger, stylus or mouse): students' daily signatures, teachers' row signatures, admins' approvals, and signatures kept on file. There is no photo upload. A student's signature on file is either their first daily signature or one they write on the admin's screen from their profile page. Signatures uploaded as photos before this change stay on the rows they were used on.

## Filling in an earlier day

On their sheet, a student sees **Fill in this day** on past class days that have nothing recorded, are inside the 7-day window, aren't holidays, and are in a month that isn't approved yet. A reminder at the top says how many such days there are (and links to last month if some are there). The student types the start and end time (checked: end after start, between `MIN_CLASS_MINUTES` and `MAX_CLASS_MINUTES`), signs, and can say why. Days an admin already marked (absent, excused, holiday) are left alone: the student asks an admin.

The row is saved with `filledLaterAt`, shown as **filled in later** to teachers and admins, and counted on the teacher's course and student lists until someone signs it. The student's note is a normal comment, so it prints with the sheet.

## PINs

Every active student has a **different PIN**, enforced by a unique database index on a keyed fingerprint of the PIN (the PIN itself is only stored as a bcrypt hash). Easy PINs (1234, 0000, ...) are refused. Only admins give new PINs. Students whose PIN was set before this was added show a note on their profile; give them a new PIN. `npm run setup` reports how many there are.

## Holidays, days off and comments

- **School holidays** (admins) with an optional note, shown on every sheet.
- **A day off for one class** (admins): marks the day Holiday or Excused with a note for everyone in the class who hasn't started that day. Can be planned up to a year ahead, and removed again.
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
4. **Run:** `npm run dev`, then open http://localhost:3000. Admins sign in at `/admin/login`, teachers at `/teacher/login`.

## First steps for the office

1. **Students → Add students from a spreadsheet.** Upload a CSV with the columns `name, courseName, courseCode, courseDuration, caseManager, instructor, startDate, endDate, pin` (`pin` is optional). Download the list of PINs it shows and give each student theirs.
2. **Teachers & admins:** add teacher accounts and tick their courses. Give teachers the `/teacher/login` address.
3. **Holidays:** add the year's holidays.
4. **My account:** each teacher and admin can sign once on the screen to put their signature on file for one-tap signing (or sign by hand each time).

**Upgrading an existing installation:** run `npm run setup` once after deploying (it adds the unique-PIN index; nothing else changes in the data). Existing rows, signatures and approvals are kept as they are. The admin/teacher split needs no data change: existing `ADMIN` accounts sign in at `/admin/login`, existing `TEACHER` accounts at `/teacher/login`.

## Checks

```bash
npm run typecheck   # TypeScript
npm test            # rules for typed times, past-day times, hours, class days, the import, the 7-day lock, attendance %, PINs, handwriting images
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
| Sign-in for both portals; row signatures (teachers only), month approvals (admins only), comments; admin-only corrections (edit a row, absent, class day off), guarded there | `src/actions/staff.ts` |
| Who may do what: `requireAdmin`, `requireTeacher`, `requireStaff` | `src/lib/auth.ts` |
| Teacher portal (courses, students, sheet review) | `src/app/teacher`, `src/lib/teacher.ts` |
| Admin portal | `src/app/admin` |
| Student filling in an earlier day | `studentFillPastDayAction` in `src/actions/student.ts`, `checkPastDayTimes` in `src/lib/sheet.ts` |
| Admin actions (students, import, staff, holidays) | `src/actions/admin.ts` |
| Who can see whom | `src/lib/access.ts` |
| PDF and Word reports | `src/lib/report.ts`, `src/app/api/report/[studentId]/route.ts` |
| The paper sheet on screen | `src/components/PaperSheet.tsx` |
| Putting a handwritten signature on file | `src/components/SignatureCapture.tsx` |
| Handwriting pad and field | `src/components/Ink.tsx` |
| 7-day lock, colour thresholds | `src/lib/policy.ts`, `editWindow` / `attendanceSummary` in `src/lib/sheet.ts` |
| Attendance summaries | `src/lib/summary.ts` |
| Unique PINs | `src/lib/pin.ts`, `src/lib/pins.ts` |
| Student profile | `src/app/admin/(app)/students/[id]/page.tsx` |
| Class monthly report | `src/lib/classreport.ts`, `src/app/admin/(app)/reports/page.tsx`, `src/app/api/reports/class/route.ts` |
