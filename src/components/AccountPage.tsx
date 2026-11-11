import type { Staff } from "@/lib/types";
import { changePasswordAction } from "@/actions/staff";
import { ActionForm, Field, Submit } from "./forms";

/** "My account" for admins and teachers: the password. Signatures are written by hand each time. */
export function AccountPage({ staff }: { staff: Staff }) {
  return (
    <main className="wrap narrow">
      <h1>My account</h1>
      <p className="lead">{staff.name}, {staff.email}, {staff.role === "ADMIN" ? "admin" : "teacher"}</p>
      <section className="panel">
        <p style={{ marginTop: 0 }}>There is no saved signature. You sign by hand on the screen each time you approve attendance, so every approval carries a real signature.</p>
      </section>
      <h2>Password</h2>
      <ActionForm action={changePasswordAction} className="panel">
        <Field name="current" label="Current password" type="password" required />
        <Field name="next" label="New password (10+ characters)" type="password" required />
        <Submit>Change password</Submit>
      </ActionForm>
    </main>
  );
}
