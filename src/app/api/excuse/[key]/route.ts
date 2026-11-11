import { currentStaff, currentStudent } from "@/lib/auth";
import { canSee } from "@/lib/access";
import { audit, cols } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The excuse document on one day (studentId:date). Only the student, their assigned teacher and
 * admins can open it. ?file=<id> opens an earlier upload kept in the history.
 */
export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const raw = decodeURIComponent(key);
  if (!/^[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/.test(raw)) return new Response("Not found", { status: 404 });
  const studentId = raw.slice(0, 36);
  const { entries, students, excuseFiles } = await cols();
  const [staff, student] = await Promise.all([currentStaff(), currentStudent()]);
  const owner = await students.findOne({ _id: studentId }, { projection: { teacherId: 1 } });
  const allowed = !!owner && ((staff && canSee(staff, owner)) || (!staff && student?._id === studentId));
  if (!allowed) return new Response("Not found", { status: 404 });
  const entry = await entries.findOne({ _id: raw }, { projection: { excuse: 1 } });
  const asked = new URL(req.url).searchParams.get("file");
  const fileId = asked && /^[0-9a-f-]{36}$/.test(asked) ? asked : entry?.excuse?.fileId;
  if (!fileId) return new Response("Not found", { status: 404 });
  const file = await excuseFiles.findOne({ _id: fileId, studentId });
  if (!file) return new Response("Not found", { status: 404 });
  await audit(staff?._id ?? studentId, "excuse.view", raw, { fileId });
  return new Response(new Uint8Array(file.data.buffer), {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `inline; filename="${file.name}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
