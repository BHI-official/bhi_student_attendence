# BHI Attendance

Digital attendance for Bright Horizon Institute. Next.js 15 + MongoDB.

The home page (`/`) has three buttons: **Student? Find your name here**, **Teacher? Sign in here**, **Admin? Sign in here**.

## How it works

**Student** — find your name, enter your PIN, and you see **this week** and **last week** (Monday to Friday).
For any day up to today: tap **Fill in & sign**, write **by hand** your **start time, lunch start, lunch end and end
time** (skip both lunch boxes if there was no lunch break), **sign by hand**, and submit. The Submit button is never
greyed out: if something is missing, it says what. A confirmation shows, and the day goes to your teacher as **Pending**.
Hours are not calculated. Every day needs a new handwritten signature; nothing is reused and nothing is uploaded as an image.
Absent? **Upload excuse** (PDF, JPG or PNG, 4 MB max, optional explanation). Older days and approved days are locked;
the full history stays visible and downloads as a PDF.

**Teacher** — one **roster** of the students assigned to them, in a **Day** or **Week** view (current week, last week,
and older weeks to look at). Each row shows the four handwritten times, the student's signature (or **No signature**),
the status and the teacher's own signature once approved. Teachers can:
- **Check & sign** a day (handwritten), or tick several and **Approve & sign** them all with **one handwritten signature**;
- **Send back** a day with a reason (the student sees it as **Needs correction** and signs again);
- mark **Present** / **Absent** while taking attendance (this week and last week). Marking present is *not* approving:
  the day shows **Present · signature missing** until the student signs;
- **Review excuses**: open the document and approve (the day becomes **Excused**) or reject it.

Filters: Needs action, Missing signature, Pending, Excuses to review, Needs correction, Submitted late, Approved, Absent.

**Who signs what on the sheet**
- **Student signature**: the student, by hand, every day.
- **Teacher signature**: only the student's own (assigned) teacher, by hand. Admins can't sign this column; they can
  send a day back or correct it.
- **Approved by** (bottom of the month): only the admin chosen on **Admin → Staff → “Signs the Approved by section”**
  (Mahek). Her name and position always come from her account and can't be typed in. Sign-offs made by anyone else
  (for example from the old system) show **Needs your signature** on Monthly sign-off so she can sign them again.

**Admin (e.g. Mahek)** — signs the **“Approved by”** section at the bottom of each student's month on
**Monthly sign-off**: optional comments, then one handwritten signature for every ticked student. A month is signed once it is over (or once the student's course has ended); students
with days still waiting for their teacher are skipped. A signed month is locked for students and teachers; an admin can
remove the sign-off (kept in the audit log). The signature shows at the bottom of the student's page and of the PDF/Word sheet.

Admins also see the same roster for every teacher (filter by teacher, or *Not assigned*), plus:
- **Students & teachers**: assign each student to one teacher with a dropdown, or tick many and assign them at once.
  Reassigning changes only who manages the student: records, signatures, hours and approvals are untouched, approved
  days keep their original approver, pending days and new submissions go to the new teacher. Each assignment period is kept
  (student profile → Assignment history).
- **Student profile**: every day of the course month by month; **add or correct any day** (status, times, note, an excuse
  document) with a reason. The original values are kept in the day's history and the audit log. Staff can never add or imitate a
  student's signature. Admins can also reopen an approved day and change excuse decisions.
- Reports (PDF/Word), holidays and class days off, staff accounts, PINs.

### Statuses

| Student sees | Teacher/admin sees | Meaning |
|---|---|---|
| Not signed yet | Missing | Nothing submitted (or marked present without a signature) |
| Pending | Pending | Submitted and signed, waiting for approval |
| Approved | Approved | Checked and signed (by hand) by the teacher; locked |
| Needs correction | Needs correction | Sent back; the student fixes it and signs again |
| Absent | Absent | Marked absent (an uploaded excuse waits for review) |
| Excused | Excused | Excuse approved; doesn't count against attendance |

Attendance % = present ÷ (present + absent + days with nothing recorded). Approved excuses and holidays don't count.

The printed sheet (PDF/Word): Day, Date, Start, Lunch start, Lunch end, End, Student signature, Teacher signature,
then “Approved by” (staff name/position, signature, comments) at the bottom.

### Rules that keep records safe
- One record per student per day (database key `studentId:date`); submitting again updates it and keeps the earlier
  version in the day's history.
- Every signature and handwritten time is stored as its own image and never changed or deleted.
- Excuse files are checked by their contents (real PDF/JPG/PNG), stored in the database, and only the student, their
  current teacher and admins can open them.
- Teachers only ever see and act on their own students, in every page, action, image and file.

## Setup

1. `cp .env.example .env.local` and fill in `MONGODB_URI` and `SESSION_SECRET`.
2. `npm install`
3. `npm run setup` — creates indexes and the first admin. **When upgrading**, it also puts each existing student on the
   roster of the teacher who had their course (when exactly one teacher did) and lists students that still need a teacher.
4. `npm run dev`, or deploy to Vercel with the same environment variables.
5. The person who signs off months (Mahek) must be an **admin** marked **“Signs the Approved by section”** on
   Admin → Staff. `npm run setup` does this automatically when exactly one active admin is named Mahek.

After upgrading: open **Admin → Students & teachers**, filter **Teacher: Not assigned**, tick them and assign.

## Checks

```bash
npm run typecheck
npm test                                                                   # rules: weeks, statuses, times, files, PINs, CSV
MONGODB_URI=mongodb://127.0.0.1:27017/bhi_it npm run test:integration       # real server actions against a test MongoDB (wiped)
npm run build
# Browser walkthrough (student, teacher, admin, phone): seed, start on :3100, then
MONGODB_URI=mongodb://127.0.0.1:27017/bhi_e2e npx tsx tests/e2e/seed.ts && npx next start -p 3100 &
python3 tests/e2e/walkthrough.py
```

## Code map

| What | Where |
|---|---|
| Week window, statuses, time and file checks (pure, tested) | `src/lib/week.ts` |
| Student actions: sign in, submit a day, upload an excuse | `src/actions/student.ts` |
| Approve, send back, present/absent, excuses, admin corrections | `src/actions/staff.ts` |
| Students, teacher assignment, PINs, accounts, holidays | `src/actions/admin.ts` |
| Roster data / screen | `src/lib/roster.ts`, `src/components/RosterPage.tsx`, `src/components/Roster.tsx` |
| Student week screen | `src/app/student/sheet/page.tsx`, `src/components/StudentDays.tsx` |
| Admin student profile and day editor | `src/app/admin/(app)/students/[id]/page.tsx`, `src/components/AdminDayEditor.tsx` |
| Handwriting pad | `src/components/Ink.tsx` |
| Who sees whom | `src/lib/access.ts` |
| Handwriting images, excuse files (access-checked) | `src/app/api/ink/[id]`, `src/app/api/excuse/[key]` |
| PDF / Word reports | `src/lib/report.ts` |
