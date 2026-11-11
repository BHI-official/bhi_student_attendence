import { PortalLinks } from "@/components/PortalLinks";
import { LOGO_URL } from "@/lib/brand";

export const metadata = { title: "Attendance" };

export default function Home() {
  return (
    <main className="wrap home">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={LOGO_URL} alt="" width={96} height={96} className="home-logo" />
      <h1>Bright Horizon Institute attendance</h1>
      <p className="lead">Choose who you are.</p>
      <PortalLinks />
    </main>
  );
}
