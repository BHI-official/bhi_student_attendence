import Link from "next/link";
import type { ActionState } from "@/lib/action";
import { ActionForm, Field, Submit } from "./forms";
import { BrandMark } from "./Brand";

/** The sign-in page of one portal (admin or teacher), with a link to the other one. */
export function StaffLogin({ title, lead, action, other }: {
  title: string; lead: string;
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  other: { href: string; text: string };
}) {
  return (
    <>
      <header className="bar"><BrandMark href="/student" subtitle="Attendance sheet" /></header>
      <main className="wrap narrow">
        <h1>{title}</h1>
        <p className="lead">{lead}</p>
        <ActionForm action={action} className="panel">
          <Field name="email" label="Email" type="email" required />
          <Field name="password" label="Password" type="password" required />
          <Submit>Sign in</Submit>
        </ActionForm>
        <p className="row"><Link href={other.href}>{other.text}</Link><Link href="/student">Student? Find your name here</Link></p>
      </main>
    </>
  );
}
