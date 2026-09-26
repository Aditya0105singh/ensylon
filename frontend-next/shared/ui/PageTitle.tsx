import { Title } from "@tremor/react";
import clsx from "clsx";
export const PageTitle = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  return (
    <Title className={clsx("text-2xl line-clamp-2 font-extrabold tracking-tight text-gray-900", className)}>
      {children}
    </Title>
  );
};
