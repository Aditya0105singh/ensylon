"use client";

import { Title, Button, Subtitle } from "@tremor/react";
import { useRouter } from "next/navigation";
import { AlertLensMark } from "@/components/AlertLensMark";

export default function NotAuthorized({ message }: { message?: string }) {
  const router = useRouter();
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      <Title>403 Not Authorized</Title>
      <Subtitle>
        {message || "You do not have permission to access this page."}
      </Subtitle>
      <AlertLensMark className="w-24 h-24" />
      <Button
        onClick={() => {
          router.back();
        }}
        color="emerald"
        variant="secondary"
      >
        Go back
      </Button>
    </div>
  );
}
