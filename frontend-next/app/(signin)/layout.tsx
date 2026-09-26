import { Card, Text } from "@tremor/react";
import { AlertLensMark } from "@/components/AlertLensMark";

export const metadata = {
  title: "AlertLens",
  description:
    "Alert correlation, deduplication and AI-driven incident analysis.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AlertLens",
  },
  icons: {
    apple: "/icons-pwa/icon-192.png",
  },
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport = {
  themeColor: "#f97316",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="bg-tremor-background-subtle">
      <body>
        <div className="min-h-screen flex items-center justify-center bg-tremor-background-subtle p-4">
          <div className="flex flex-col items-center gap-6">
            <div className="flex items-center gap-3">
              <AlertLensMark className="w-12 h-12" />
              <Text className="text-tremor-title font-bold text-tremor-content-strong">
                AlertLens
              </Text>
            </div>
            <Card
              className="w-full max-w-md p-8 min-w-96 flex flex-col gap-6 items-center"
              decoration="top"
              decorationColor="emerald"
            >
              {children}
            </Card>
          </div>
        </div>
      </body>
    </html>
  );
}
