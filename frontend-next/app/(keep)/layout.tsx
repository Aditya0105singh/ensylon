import { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { NextAuthProvider } from "../auth-provider";
import { Mulish } from "next/font/google";
import { ToastContainer } from "react-toastify";
import Navbar from "components/navbar/Navbar";
import { Topbar } from "components/navbar/Topbar";
import { TopologyPollingContextProvider } from "@/app/(keep)/topology/model/TopologyPollingContext";
import { getConfig } from "@/shared/lib/server/getConfig";
import { ConfigProvider } from "../config-provider";
import { PHProvider } from "../posthog-provider";
import ReadOnlyBanner from "@/components/banners/read-only-banner";
import { IncidentPanelProvider } from "@/entities/alertlens/ui/IncidentPanelProvider";
import { auth } from "@/auth";
import { ThemeScript, WatchUpdateTheme, PwaRegister } from "@/shared/ui";
import "@/app/globals.css";
import "react-toastify/dist/ReactToastify.css";
import { PostHogPageView } from "@/shared/ui/PostHogPageView";

// If loading a variable font, you don't need to specify the font weight
const mulish = Mulish({
  subsets: ["latin"],
  display: "swap",
});

type RootLayoutProps = {
  children: ReactNode;
};

// Installable on any phone via "Add to Home Screen" - no app store, no
// native build. manifest+icons cover Android/Chrome; apple-* covers iOS
// Safari, which ignores the manifest and reads its own meta tags instead.
export const metadata: Metadata = {
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Nexus AIOps",
  },
  icons: {
    apple: "/icons-pwa/icon-192.png",
  },
  // Next only emits the modern unprefixed "mobile-web-app-capable" tag from
  // appleWebApp.capable. Older iOS Safari versions still key off the
  // original Apple-prefixed name to drop browser chrome on launch, so it's
  // added explicitly rather than trusting the modern tag alone.
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  themeColor: "#f97316",
};

export default async function RootLayout({ children }: RootLayoutProps) {
  const config = getConfig();
  const session = await auth();

  return (
    // ThemeScript mutates this class before hydration to avoid a dark-mode
    // flash, so the class attribute React sees on hydration deliberately
    // differs from what it rendered server-side.
    <html
      lang="en"
      className={`bg-gray-50 ${mulish.className}`}
      suppressHydrationWarning
    >
      <body className="h-screen flex flex-col lg:grid lg:grid-cols-[192px_30px_auto] xl:grid-cols-[220px_30px_auto] 2xl:grid-cols-[250px_30px_auto] lg:grid-rows-1 lg:has-[aside[data-minimized='true']]:grid-cols-[0px_30px_auto]">
        {/* ThemeScript must be the first thing to avoid flickering */}
        <ThemeScript />
        <PwaRegister />
        <ConfigProvider config={config}>
          <PHProvider>
            <NextAuthProvider session={session}>
              <TopologyPollingContextProvider>
                <IncidentPanelProvider>
                {/* @ts-ignore-error Server Component */}
                <PostHogPageView />
                <Navbar />
                {/* https://discord.com/channels/752553802359505017/1068089513253019688/1117731746922893333 */}
                <main className="page-container flex flex-col col-start-3 overflow-auto">
                  <Topbar session={session} />
                  {/* Add the banner here, before the navbar */}
                  {config.READ_ONLY && <ReadOnlyBanner />}
                  <div className="flex-1">{children}</div>
                  {/** footer */}
                  {process.env.GIT_COMMIT_HASH &&
                    process.env.SHOW_BUILD_INFO !== "false" && (
                      <div className="pointer-events-none opacity-80 w-full p-2 text-slate-400 text-xs">
                        <div className="w-full text-right">
                          Version: {process.env.KEEP_VERSION} | Build:{" "}
                          {process.env.GIT_COMMIT_HASH.slice(0, 6)}
                        </div>
                      </div>
                    )}
                  <ToastContainer />
                </main>
                {/* Real OS-level notifications for new high-risk incidents -
                    watches the same pipeline state every page reads, so it
                    fires regardless of which page is open. */}
                </IncidentPanelProvider>
              </TopologyPollingContextProvider>
            </NextAuthProvider>
          </PHProvider>
        </ConfigProvider>
        <WatchUpdateTheme />
      </body>
    </html>
  );
}
