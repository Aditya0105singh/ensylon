import { auth } from "@/auth";
import { AlertLensLinks } from "@/components/navbar/AlertLensLinks";
import { SidebarHeader } from "@/components/navbar/SidebarHeader";
import { Menu } from "@/components/navbar/Menu";
import { MinimizeMenuButton } from "@/components/navbar/MinimizeMenuButton";
import "./Navbar.css";

// Search and the user menu now live in Topbar (rendered inside <main> by
// layout.tsx, so it spans only the content column) - the sidebar itself is
// just the logo and the nav list, matching the new design's split between a
// nav-only rail and a horizontal top bar.
export default async function NavbarInner() {
  const session = await auth();

  return (
    <>
      <Menu session={session}>
        <SidebarHeader />
        <div className="pt-2 space-y-4 flex-1 overflow-auto scrollable-menu-shadow">
          <AlertLensLinks />
        </div>
      </Menu>
      <MinimizeMenuButton />
    </>
  );
}
