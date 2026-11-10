import type { Staff, StudentNote } from "@/lib/types";
import { usDate } from "@/lib/sheet";
import { addStudentNoteAction, deleteStudentNoteAction } from "@/actions/notes";
import { ActionForm, Field, Submit } from "./forms";

const written = (d: Date) =>
  new Date(d).toLocaleString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Dated notes about a student, for admins and the student's teachers. Staff-only: never shown to
 * the student or printed on the attendance sheet. Anyone who can see the student can add a note;
 * the author can delete their own, and admins can delete any.
 */
export function StudentNotes({ studentId, studentName, notes, staff, today }: {
  studentId: string;
  studentName: string;
  notes: StudentNote[];
  staff: Pick<Staff, "_id" | "role">;
  today: string;
}) {
  return (
    <section className="panel notes no-print" aria-labelledby="notes-title">
      <h2 id="notes-title" style={{ marginTop: 0 }}>Notes</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Dated notes about {studentName} for admins and teachers, such as calls, absences or follow-ups. Students don&apos;t see them, and they aren&apos;t printed on the sheet.
      </p>

      <ActionForm action={addStudentNoteAction.bind(null, studentId)} className="notes-form">
        <div className="notes-form-grid">
          <Field name="date" label="Date" type="date" defaultValue={today} />
          <Field name="text" label="Note">
            <textarea id="f-text" name="text" rows={3} maxLength={2000} required placeholder="e.g. Called about missed days. Back on Monday." />
          </Field>
        </div>
        <Submit>Add note</Submit>
      </ActionForm>

      {notes.length === 0 ? (
        <p className="muted" style={{ marginBottom: 0 }}>No notes yet.</p>
      ) : (
        <ol className="notes-list">
          {notes.map((n) => {
            const canDelete = staff.role === "ADMIN" || n.byId === staff._id;
            return (
              <li key={n._id}>
                <div className="notes-date">{usDate(n.date)}</div>
                <div className="notes-body">
                  <p className="notes-text">{n.text}</p>
                  <p className="small muted notes-meta">
                    {n.byName}{n.byRole === "ADMIN" ? " (admin)" : " (teacher)"}, written {written(n.createdAt)}
                  </p>
                </div>
                {canDelete && (
                  <ActionForm action={deleteStudentNoteAction.bind(null, n._id)} confirm="Delete this note? It can't be undone." className="notes-del">
                    <Submit className="linkbtn small">Delete</Submit>
                  </ActionForm>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
