import { Subtitle, Title } from "@tremor/react";
import clsx from "clsx";
import { AlertLensMark } from "@/components/AlertLensMark";

export function KeepLoader({
  includeMinHeight = true,
  slowLoading = false,
  loadingText = "Just a second, getting your data 🚨",
  className,
  ...props
}: {
  includeMinHeight?: boolean;
  slowLoading?: boolean;
  loadingText?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <main
      className={clsx(
        "flex flex-col items-center justify-center",
        includeMinHeight ? "min-h-screen-minus-200" : "",
        className
      )}
      {...props}
    >
      <AlertLensMark className="w-32 h-32 animate-bounce" />
      <Title>{loadingText}</Title>
      {slowLoading && (
        <Subtitle>
          This is taking a bit longer then usual, please wait...
        </Subtitle>
      )}
    </main>
  );
}
