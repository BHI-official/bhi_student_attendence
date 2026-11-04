import { cols } from "@/db";
import { audit } from "@/lib/audit";
import { getFile } from "@/lib/storage";
import { apiUser, deny, fileResponse, isUuid } from "@/lib/http";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser();
  if (!user) return deny(401);
  const { id } = await params;
  if (!isUuid(id)) return deny();
  const app = await (await cols()).applications.findOne({ "documents._id": id }, { projection: { studentId: 1, documents: 1 } });
  const doc = app?.documents.find((d) => d._id === id);
  if (!app || !doc) return deny();
  // Admins see every file; a student only their own.
  if (user.role !== "ADMIN" && !(user.role === "STUDENT" && app.studentId === user._id)) return deny();
  if (user.role === "ADMIN") await audit(user._id, "document.download", "application", app._id, { documentId: doc._id });
  let bytes: Buffer;
  try {
    bytes = await getFile(doc.storageKey);
  } catch (e) {
    // The record exists but the stored file doesn't (e.g. uploaded to a server's local disk before
    // file storage moved to the database): "not found" rather than a crash.
    console.error("[files] stored file missing", { documentId: doc._id }, e);
    return deny();
  }
  const inline = doc.mimeType === "application/pdf" || doc.mimeType.startsWith("image/");
  return fileResponse(bytes, doc.mimeType, doc.fileName, inline);
}
