import type { ActionState } from "@/lib/action";
import { ActionForm, Field, Submit } from "./forms";
import { BrandMark } from "./Brand";
import { PortalLinks } from "./PortalLinks";

/** The sign-in page of one portal (admin or teacher), with a link to the other one. */
export function StaffLogin({ title, lead, action, who }: {
  title: string; lead: string;
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  who: "teacher" | "admin";
}) {
  return (
    <>
      <header className="bar"><BrandMark href="/" subtitle="Attendance" /></header>
      <main className="wrap narrow">
        <h1>{title}</h1>
        <p className="lead">{lead}</p>
        <ActionForm action={action} className="panel">
          <Field name="email" label="Email" type="email" required />
          <Field name="password" label="Password" type="password" required />
          <Submit>Sign in</Submit>
        </ActionForm>
        <PortalLinks except={who} compact />
      </main>
    </>
  );
}
