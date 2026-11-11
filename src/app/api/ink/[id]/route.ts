import { currentStaff, currentStudent } from "@/lib/auth";
import { canSee } from "@/lib/access";
import { cols } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One handwriting image (a signature or a handwritten time). Students see their own; teachers see
 * their students' and staff signatures; students also see the staff signatures on their own sheet; admins see everything. Images never change, so they cache.
 */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const { signatures, students } = await cols();
  const doc = await signatures.findOne({ _id: id });
  if (!doc) return new Response("Not found", { status: 404 });
  const [staff, student] = await Promise.all([currentStaff(), currentStudent()]);
  let ok = false;
  if (staff?.role === "ADMIN") ok = true;
  else if (staff) ok = doc.ownerType === "STAFF" || canSee(staff, (await students.findOne({ _id: doc.ownerId }, { projection: { teacherId: 1 } })) ?? {});
  else if (student) {
    // Their own handwriting, and the teacher's / admin's signatures on their own sheet.
    if (doc.ownerType === "STUDENT") ok = doc.ownerId === student._id;
    else {
      const { entries, approvals } = await cols();
      ok = !!(await entries.findOne({ studentId: student._id, "staffSignature.id": id }, { projection: { _id: 1 } }))
        || !!(await approvals.findOne({ studentId: student._id, signatureId: id }, { projection: { _id: 1 } }));
    }
  }
  if (!ok) return new Response("Not found", { status: 404 });
  const m = /^data:image\/png;base64,(.+)$/.exec(doc.png);
  if (!m) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(Buffer.from(m[1], "base64")), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
  });
}
