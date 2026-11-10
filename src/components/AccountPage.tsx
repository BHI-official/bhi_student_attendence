import type { Staff } from "@/lib/types";
import { signatureImages } from "@/lib/signatures";
import { changePasswordAction, saveMySignatureAction } from "@/actions/staff";
import { ActionForm, Field, Submit } from "./forms";
import { SignatureOnFile } from "./SignatureCapture";

/** "My account" for admins and teachers: the signature on file and the password. */
export async function AccountPage({ staff }: { staff: Staff }) {
  const sig = (await signatureImages([staff.signatureId]))[staff.signatureId ?? ""];
  return (
    <main className="wrap narrow">
      <h1>My account</h1>
      <p className="lead">{staff.name} · {staff.email} · {staff.role === "ADMIN" ? "Admin" : `Teacher${staff.courses.length ? `: ${staff.courses.join(", ")}` : ""}`}</p>
      <h2>My signature</h2>
      <section className="panel">
        {sig
          ? <><div style={{ border: "1.5px solid var(--line)", borderRadius: 10, padding: 14, display: "inline-block" }}><img src={sig} alt="My signature" style={{ maxHeight: 90 }} /></div>
              <p className="small muted">{staff.role === "ADMIN" ? "Used when you sign the “Approved by” section of a month." : "Used when you sign students’ rows."} A new one is used from now on; what you already signed keeps the old one.</p></>
          : <p>Sign once on the screen to put your signature on file. Then you {staff.role === "ADMIN" ? "approve months" : "sign students’ rows"} with one tap (you can still sign by hand each time).</p>}
        <SignatureOnFile action={saveMySignatureAction} title="Sign your name" drawLabel={sig ? "Sign again to replace it" : "Sign on the screen"} />
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
